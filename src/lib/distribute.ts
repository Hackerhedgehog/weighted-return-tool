import type { BucketRow, PriorityKey, Targets, WeightStep } from './types'
import { normalizePriority } from './types'

/**
 * Weight distribution solver.
 *
 * The targets are over-constrained, so they are resolved by rank. Ranks 2-6
 * below are the DEFAULT ranking (`DEFAULT_PRIORITY`); the user may reorder
 * them via `targets.priority`, and each conflict below then reads that
 * ranking to decide which side yields. Locks are not reorderable — rank 1 is
 * absolute:
 *
 *  1. Locked weights are absolute — never touched and never reordered. A lock
 *     that breaks the payout ladder is reported rather than moved, though only
 *     while the ladder is being kept at all (see 3).
 *  2. RTP is hit exactly (to integer-weight granularity) by solving the slope
 *     of the weight curve.
 *  3. Ordering: every unlocked bucket holds at least one weight step, and
 *     weight never rises as payout rises. Equal payouts are unconstrained
 *     against each other, which is what keeps the tease buckets free to sit
 *     below the ladder — and is also why the residual `0x` bucket is held above
 *     every unlocked *paying* bucket rather than above the whole table: its
 *     zero-payout siblings are not ordered against it. Locks outrank all of
 *     this, so a lock heavy enough to outweigh the residual stays where it is.
 *  4. Volatility shapes whatever freedom is left, as curvature of that curve.
 *  5. Hit chance, then 6. win chance, are satisfied *structurally*, by deciding
 *     how much total weight each payout group receives. They are preferences
 *     with a relative tolerance band; the band is spent when the RTP target is
 *     otherwise unreachable, and the masses themselves are overridden when
 *     ordering demands it.
 *
 * Steps 2 and 4 do not collide: slope and curvature are different basis
 * functions in `share ∝ exp(−γ·u − c·u²)`, `u = ln(payout) − ln(pMin)`, so
 * solving γ for RTP leaves c — and therefore the volatility setting — intact.
 *
 * Steps 3 and 4 do collide, and the rank decides it. Ordering constrains γ from
 * below, band by band, at `−c·(u_i + u_j)` over the band's *lowest* consecutive
 * pair — the one that binds hardest (see `bandFloor`). Past a certain curvature
 * that floor and the thinned tail together put the RTP target out of ordered
 * reach, so `fitCurve` flattens the curvature until the target is back inside
 * it, and the solve says so. Only when even a straight line falls short does
 * ordering itself yield — and then only if abandoning it actually brings the
 * target into reach, since giving up the ladder for a target that is missed
 * either way buys nothing.
 *
 * The integer stage carries the same invariants the continuous one does.
 * `allocate`'s rounding is blind to the ladder, so `enforceOrder` re-sorts it
 * and `restoreResidual` gives the residual back what the zero group's own
 * weight floor took off it. `repairRtp` then recovers the RTP that costs, under
 * a guard that refuses any transfer which would put the ladder back out of
 * order.
 *
 * All three are switched off together once ordering has yielded: the two
 * repairs would be meaningless, and the guard would read the solve's deliberate
 * inversions as damage and veto every move that could reach the target.
 */

export interface SolveResult {
  weights: number[]
  achieved: Stats
  /** Band position actually used, in [-1, 1]. 0 means chances landed on target. */
  bandUsed: number
  gamma: number
  /** Curvature actually solved with — below the input `curve` when volatility flattened to keep the ladder in order. */
  curveUsed: number
  warnings: string[]
}

export interface Stats {
  rtp: number
  hitChance: number
  winChance: number
}

const GAMMA_HI = 40
/** Only reached when the RTP target is out of reach with the ladder in order. */
const GAMMA_UNORDERED = -40
const BISECTION_STEPS = 200
/** Band resolution: 100 steps per side is far finer than a ±3.5% band needs. */
const BAND_STEPS = 100
const GROUP_NAMES = ['zero-payout', 'small-win', 'win'] as const

/** Blocked-operation message naming the nearest totals that would divide. */
export function stepBlockWarning(free: number, lockedSum: number, step: number): string {
  const fmt = (n: number) => n.toLocaleString('en-US')
  const lo = lockedSum + Math.floor(free / step) * step
  return `Free weight ${fmt(free)} is not divisible by ${step} — set the total weight to ${fmt(lo)} or ${fmt(lo + step)}.`
}

/** Smallest total that holds the locks and still floors every unlocked row. */
export function minTotalWeight(rows: BucketRow[], step: WeightStep = 1): number {
  let locked = 0
  let free = 0
  for (const r of rows) {
    if (r.locked) locked += Math.max(0, Math.round(r.weight))
    else free += 1
  }
  return locked + free * step
}

/** Refusal naming the total that would fund one step per unlocked bucket. */
export function floorBlockWarning(rows: BucketRow[], step: WeightStep, total: number): string {
  const fmt = (n: number) => n.toLocaleString('en-US')
  const free = rows.filter((r) => !r.locked).length
  return `Total weight ${fmt(total)} cannot give all ${fmt(free)} unlocked buckets a weight of at least ${fmt(step)} — raise the total to at least ${fmt(minTotalWeight(rows, step))}, or lower the weight step.`
}

/**
 * Which unlocked bucket absorbs an indivisible remainder.
 *
 * The cheapest one: a bucket contributes `payout · weight / total` to RTP, so
 * parking the leftover on the lowest payout disturbs the solved RTP least —
 * and not at all when a 0x bucket exists, which these tables normally have.
 * Ties go to the largest weight, then to bucket id, so the pick is stable
 * across runs rather than dependent on row order.
 */
/** Says where an indivisible leftover ended up. Informational, not a refusal. */
export function stepRemainderNote(
  free: number,
  remainder: number,
  step: number,
  label: string,
): string {
  const fmt = (n: number) => n.toLocaleString('en-US')
  return `Free weight ${fmt(free)} is not a multiple of ${step} — distributed ${fmt(free - remainder)} on step and added the remaining ${fmt(remainder)} to "${label}".`
}

function remainderCarrier(rows: BucketRow[], weights: number[]): number {
  let best = -1
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].locked) continue
    if (best === -1) {
      best = i
      continue
    }
    const a = rows[i]
    const b = rows[best]
    const better =
      a.payout !== b.payout
        ? a.payout < b.payout
        : weights[i] !== weights[best]
          ? weights[i] > weights[best]
          : a.bucketId < b.bucketId
    if (better) best = i
  }
  return best
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}

/** 0 = no payout, 1 = payout up to and including 1x, 2 = a win above 1x. */
export function groupOf(payout: number): 0 | 1 | 2 {
  if (!(payout > 0)) return 0
  return payout <= 1 ? 1 : 2
}

/**
 * The residual loss bucket: the zero-payout row a table uses as its catch-all.
 *
 * Matched by label rather than by weight, because the whole point is to seed a
 * table that has no weights yet. An exact `0x` wins outright; failing that a
 * label carrying `0x` as a whole token — so `100x` and `1000x`, which contain
 * the characters but name a payout, never match.
 *
 * Returns -1 when no zero-payout row names itself, in which case the group has
 * no residual and splits evenly, exactly as it always has.
 */
const RESIDUAL_TOKEN_RE = /(^|[^0-9a-z])0x([^0-9a-z]|$)/i

export function residualIndex(rows: BucketRow[]): number {
  let token = -1
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].payout > 0) continue
    if (rows[i].label.trim().toLowerCase() === '0x') return i
    if (token === -1 && RESIDUAL_TOKEN_RE.test(rows[i].label)) token = i
  }
  return token
}

/**
 * How a zero-payout group with no weights of its own divides its mass.
 *
 * An even split leaves the residual tied with the teases — the table's most
 * common outcome indistinguishable from its rarest. The residual takes the
 * bulk instead; a locked residual is not in `idx` at all, so its weight stands.
 */
const ZERO_RESIDUAL_SHARE = 0.8

function zeroShares(idx: number[], residual: number): number[] {
  const at = idx.indexOf(residual)
  if (at === -1 || idx.length === 1) return idx.map(() => 1 / idx.length)
  const rest = (1 - ZERO_RESIDUAL_SHARE) / (idx.length - 1)
  return idx.map((_, k) => (k === at ? ZERO_RESIDUAL_SHARE : rest))
}

export function statsOf(rows: BucketRow[], totalWeight: number): Stats {
  if (!(totalWeight > 0)) return { rtp: NaN, hitChance: NaN, winChance: NaN }
  let rtp = 0
  let hit = 0
  let win = 0
  for (const r of rows) {
    rtp += (r.payout * r.weight) / totalWeight
    if (r.payout > 0) hit += r.weight / totalWeight
    if (r.payout > 1) win += r.weight / totalWeight
  }
  return { rtp, hitChance: hit, winChance: win }
}

/**
 * Split `total` integer units across `weights` in proportion, exactly.
 * With `minOne`, every entry gets at least 1 — but only when the budget is
 * large enough to go round; otherwise zeros are allowed rather than
 * over-spending. With `step > 1` the split happens in units of `step`, so
 * every share is a multiple of it and `minOne` means "at least one step";
 * callers pass totals divisible by `step`. Exported for the
 * direct-manipulation ops in interact.ts.
 */
export function largestRemainder(
  weights: number[],
  total: number,
  minOne: boolean,
  step = 1,
): number[] {
  if (step > 1) {
    return largestRemainder(weights, Math.round(total / step), minOne, 1).map((v) => v * step)
  }

  const n = weights.length
  if (n === 0) return []

  const t = Math.max(0, Math.round(total))
  if (t === 0) return new Array<number>(n).fill(0)

  const useMin = minOne && t >= n
  const budget = useMin ? t - n : t

  const positive = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0))
  const sum = positive.reduce((a, b) => a + b, 0)
  const props = sum > 0 ? positive.map((w) => w / sum) : positive.map(() => 1 / n)

  const raw = props.map((p) => p * budget)
  const base = raw.map((v) => Math.floor(v))
  let assigned = base.reduce((a, b) => a + b, 0)

  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i)

  for (let k = 0; assigned < budget && k < n * 2; k++) {
    base[order[k % n].i] += 1
    assigned += 1
  }
  // Floating point can only ever push us over by a hair, but never ship a
  // group whose parts outrun its budget.
  for (let k = 0; assigned > budget && k < n * 2; k++) {
    const idx = order[n - 1 - (k % n)].i
    if (base[idx] > 0) {
      base[idx] -= 1
      assigned -= 1
    }
  }

  return useMin ? base.map((b) => b + 1) : base
}

interface Ctx {
  n: number
  payouts: number[]
  locked: boolean[]
  current: number[]
  /** log-ladder position; 0 for zero-payout buckets, which never use the curve */
  u: number[]
  /** unlocked row indices, per group */
  freeIdx: number[][]
  lockedSum: number[]
  totalLocked: number
  total: number
  curve: number
  residual: number
  ordered: boolean
}

function buildCtx(rows: BucketRow[], total: number, curve: number): Ctx {
  const n = rows.length
  const payouts = rows.map((r) => r.payout)
  const locked = rows.map((r) => r.locked)
  const current = rows.map((r) => Math.max(0, Math.round(r.weight)))

  const positives = payouts.filter((p) => p > 0)
  const pMin = positives.length > 0 ? Math.min(...positives) : 1
  const u = payouts.map((p) => (p > 0 ? Math.log(p) - Math.log(pMin) : 0))

  const freeIdx: number[][] = [[], [], []]
  const lockedSum = [0, 0, 0]
  let totalLocked = 0

  rows.forEach((r, i) => {
    const g = groupOf(r.payout)
    if (r.locked) {
      lockedSum[g] += current[i]
      totalLocked += current[i]
    } else {
      freeIdx[g].push(i)
    }
  })

  return {
    n, payouts, locked, current, u, freeIdx, lockedSum, totalLocked, total, curve,
    residual: residualIndex(rows),
    ordered: true,
  }
}

function massesFor(targets: Targets, s: number, total: number): number[] {
  const tau = targets.tolerance / 100
  const hit = clamp(targets.hitChance * (1 + s * tau), 0, 1)
  let win = clamp(targets.winChance * (1 + s * tau), 0, 1)
  if (win > hit) win = hit
  return [(1 - hit) * total, (hit - win) * total, win * total]
}

/**
 * Turn group masses into budgets for the unlocked buckets.
 *
 * Locked weight is subtracted first; a group whose locks already overrun its
 * mass is clamped to zero and flagged. Every unlocked bucket is then owed one
 * step, so a group the chance targets leave empty still cannot starve its
 * members — the floor has to be applied *to* the split rather than inside it,
 * because a group with no mass gets no split to apply it in.
 *
 * The floor is a minimum, not a tax. A group already clearing one step per
 * bucket keeps its mass share untouched, which is the normal case and what
 * keeps the chance targets landing exactly; only a group that cannot fund its
 * own floor takes anything, and it comes from the slack of the groups that
 * can. Reserving a flat `count x step` off the top instead would shift mass
 * toward whichever group has the most buckets per unit of mass — on the
 * reference table at step 100 that is the 23-bucket win group, and it drags
 * hit chance from 0.300 to 0.301 for no reason at all.
 */
function freeBudgets(
  ctx: Ctx,
  masses: number[],
  step: number,
): { budgets: number[]; conflict: boolean } {
  const free = Math.max(0, ctx.total - ctx.totalLocked)
  const raw = [0, 1, 2].map((g) => masses[g] - ctx.lockedSum[g])
  const conflict = raw.some((v) => v < -0.5)

  const counts = [0, 1, 2].map((g) => ctx.freeIdx[g].length)
  const totalCount = counts.reduce((a, b) => a + b, 0)
  if (totalCount === 0) return { budgets: [0, 0, 0], conflict }

  const shares = raw.map((v, g) => (counts[g] === 0 ? 0 : Math.max(0, v)))
  const sum = shares.reduce((a, b) => a + b, 0)
  // No group can take weight by mass. Spread by unlocked bucket count so the
  // total still balances.
  const base =
    sum > 0 ? shares.map((v) => (v / sum) * free) : counts.map((c) => (free * c) / totalCount)

  const reserve = counts.map((c) => c * step)
  const need = base.map((b, g) => Math.max(0, reserve[g] - b))
  const shortfall = need.reduce((a, b) => a + b, 0)
  if (shortfall <= 0) return { budgets: base, conflict }

  const slack = base.map((b, g) => Math.max(0, b - reserve[g]))
  const totalSlack = slack.reduce((a, b) => a + b, 0)
  // `solveWeights` refuses before reaching here when the free weight cannot
  // cover every reserve, which is exactly the condition that guarantees
  // `totalSlack >= shortfall`.
  if (!(totalSlack > 0)) return { budgets: reserve, conflict }
  return {
    budgets: base.map((b, g) => b + need[g] - (slack[g] / totalSlack) * shortfall),
    conflict,
  }
}

/**
 * The index lists the curve is fitted over, and their budgets.
 *
 * Normally one per payout group, because the chance targets fix how much mass
 * each group gets. With the chance targets switched off there is no such
 * constraint, so the two paying groups are pooled and the curve is free to
 * move mass across the whole positive ladder — which is the entire point of
 * turning them off.
 */
function curveBands(ctx: Ctx, budgets: number[], pooled: boolean): [number[], number][] {
  if (!pooled) {
    return ([1, 2] as const).map((g) => [ctx.freeIdx[g], budgets[g]] as [number[], number])
  }
  return [[[...ctx.freeIdx[1], ...ctx.freeIdx[2]], budgets[1] + budgets[2]]]
}

/**
 * Smallest slope that keeps a band non-increasing, given the curvature.
 *
 * Ordering is a condition between *consecutive* buckets, not on the curve's
 * derivative: for u_i < u_j the shape needs
 *
 *   -γ·u_i - c·u_i²  ≥  -γ·u_j - c·u_j²   ⟺   γ ≥ -c·(u_i + u_j)
 *
 * Every consecutive pair has to hold, so the binding bound is the largest of
 * them — and `-c·(u_i + u_j)` is least negative where the pair sits lowest.
 * The bottom rung of a band constrains it; the rest follow.
 *
 * A band that starts well up the ladder therefore tolerates a far flatter
 * slope than one starting at u = 0: band 2's lowest pair is 1.8x and 2x, five
 * times further up than band 1's. That gap is why a blanket floor of 0 — which
 * would put RTP 0.95 out of reach at the two lowest presets — is stricter than
 * ordering actually needs.
 */
function bandFloor(ctx: Ctx, idx: number[]): number {
  const order = [...idx].sort((a, b) => ctx.u[a] - ctx.u[b])
  let lowestPair = Infinity
  for (let k = 1; k < order.length; k++) {
    const a = ctx.u[order[k - 1]]
    const b = ctx.u[order[k]]
    if (b > a) lowestPair = Math.min(lowestPair, a + b)
  }
  return Number.isFinite(lowestPair) ? -ctx.curve * lowestPair : 0
}

/**
 * The steepest curvature no greater than the user's that still reaches the RTP
 * target with the ladder in order, or null when even a straight line cannot.
 *
 * The slope floor is proportional to the curvature, so a heavy curve works
 * against itself twice: it bends the tail down *and* pins the slope further
 * from flat. Past a point the two together put the target out of ordered
 * reach. Volatility ranks below ordering, so it is what gives — on the
 * reference table only `very low` needs it, flattening 0.32 to 0.265.
 */
function fitCurve(ctx: Ctx, budgets: number[], target: number, pooled: boolean): number | null {
  const reaches = (c: number) => {
    const [min, max] = reachRange({ ...ctx, curve: c }, budgets, pooled)
    return target >= min - 1e-12 && target <= max + 1e-12
  }
  if (reaches(ctx.curve)) return ctx.curve
  if (!reaches(0)) return null

  let lo = 0
  let hi = ctx.curve
  for (let k = 0; k < BISECTION_STEPS; k++) {
    const mid = (lo + hi) / 2
    if (reaches(mid)) lo = mid
    else hi = mid
  }
  return lo
}

/** Continuous (pre-rounding) weights for a given band position and slope. */
function continuousWeights(
  ctx: Ctx,
  budgets: number[],
  gamma: number,
  pooled = false,
): number[] {
  const w = new Array<number>(ctx.n).fill(0)
  for (let i = 0; i < ctx.n; i++) if (ctx.locked[i]) w[i] = ctx.current[i]

  {
    const g = 0 as const
    const idx = ctx.freeIdx[g]
    const budget = budgets[g]
    if (idx.length > 0 && budget > 0) {
      // Zero-payout buckets contribute nothing to RTP and there is no
      // principled curve for them, so keep whatever balance the user has.
      const base = idx.map((i) => ctx.current[i])
      const sum = base.reduce((a, b) => a + b, 0)
      const props = sum > 0 ? base.map((b) => b / sum) : zeroShares(idx, ctx.residual)
      idx.forEach((i, k) => {
        w[i] = props[k] * budget
      })
    }
  }

  for (const [idx, budget] of curveBands(ctx, budgets, pooled)) {
    if (idx.length === 0 || !(budget > 0)) continue
    const g = ctx.ordered ? Math.max(gamma, bandFloor(ctx, idx)) : gamma
    const logs = idx.map((i) => -g * ctx.u[i] - ctx.curve * ctx.u[i] * ctx.u[i])
    const maxLog = Math.max(...logs)
    const raw = logs.map((l) => Math.exp(l - maxLog))
    const sum = raw.reduce((a, b) => a + b, 0)
    idx.forEach((i, k) => {
      w[i] = (raw[k] / sum) * budget
    })
  }

  return w
}

function rtpOf(ctx: Ctx, w: number[]): number {
  if (!(ctx.total > 0)) return NaN
  let acc = 0
  for (let i = 0; i < ctx.n; i++) acc += ctx.payouts[i] * w[i]
  return acc / ctx.total
}

/** RTP is monotonically decreasing in gamma, so the range is [at HI, at LO]. */
function reachRange(ctx: Ctx, budgets: number[], pooled = false): [number, number] {
  return [
    rtpOf(ctx, continuousWeights(ctx, budgets, GAMMA_HI, pooled)),
    rtpOf(ctx, continuousWeights(ctx, budgets, GAMMA_UNORDERED, pooled)),
  ]
}

function solveGamma(ctx: Ctx, budgets: number[], target: number, pooled = false): number {
  let lo = GAMMA_UNORDERED
  let hi = GAMMA_HI
  const [min, max] = reachRange(ctx, budgets, pooled)
  const goal = clamp(target, min, max)
  for (let k = 0; k < BISECTION_STEPS; k++) {
    const mid = (lo + hi) / 2
    if (rtpOf(ctx, continuousWeights(ctx, budgets, mid, pooled)) > goal) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/**
 * Group masses taken from the table as it stands, for when the chance targets
 * are switched off. The zero-payout share is what hit chance *is*, so holding
 * it where the user already has it keeps the reported chances honest while
 * leaving RTP as the only thing being solved for.
 */
function currentMasses(ctx: Ctx, targets: Targets): number[] {
  const sums = [0, 1, 2].map(
    (g) => ctx.lockedSum[g] + ctx.freeIdx[g].reduce((a, i) => a + ctx.current[i], 0),
  )
  const tot = sums.reduce((a, b) => a + b, 0)
  // Nothing to preserve. Sizing by member count would hand the zero group a
  // share with no relation to mass, so fall back to the chance targets' own
  // split even though they are switched off.
  if (!(tot > 0)) return massesFor(targets, 0, ctx.total)
  return sums.map((s) => (s / tot) * ctx.total)
}

/** Band positions ordered by how much slack they spend. */
function bandCandidates(): number[] {
  const out = [0]
  for (let k = 1; k <= BAND_STEPS; k++) {
    out.push(k / BAND_STEPS, -k / BAND_STEPS)
  }
  return out
}

/** Round the continuous solution to integers, exact per group and overall. */
function allocate(ctx: Ctx, cont: number[], step: number): number[] {
  const out = new Array<number>(ctx.n).fill(0)
  for (let i = 0; i < ctx.n; i++) if (ctx.locked[i]) out[i] = ctx.current[i]

  const free = Math.max(0, ctx.total - ctx.totalLocked)
  const active = ([0, 1, 2] as const).filter((g) => ctx.freeIdx[g].length > 0)
  if (active.length === 0) return out

  const groupSums = active.map((g) => ctx.freeIdx[g].reduce((a, i) => a + cont[i], 0))
  const groupBudgets = largestRemainder(groupSums, free, false, step)

  // Rounding to the step can shave a group below the reserve it was budgeted
  // for. Top it back up from whichever group still has slack — `freeBudgets`
  // guarantees the free weight covers every reserve, so one does.
  const need = active.map((g) => ctx.freeIdx[g].length * step)
  for (let k = 0; k < active.length; k++) {
    for (let j = 0; j < active.length && groupBudgets[k] < need[k]; j++) {
      if (j === k) continue
      const take = Math.min(need[k] - groupBudgets[k], Math.max(0, groupBudgets[j] - need[j]))
      groupBudgets[j] -= take
      groupBudgets[k] += take
    }
  }

  active.forEach((g, k) => {
    const idx = ctx.freeIdx[g]
    const alloc = largestRemainder(
      idx.map((i) => cont[i]),
      groupBudgets[k],
      true,
      step,
    )
    idx.forEach((i, j) => {
      out[i] = alloc[j]
    })
  })

  return out
}

/**
 * Every usable pair of unlocked win buckets, widest payout span first.
 *
 * The span is the step size: moving one unit between a pair changes RTP by
 * `span / total`. A wide pair covers distance but lands coarsely; a close pair
 * is precise but has nowhere near the capacity to cover distance — the closest
 * pair here spans 0.05, so closing a 3e-4 RTP gap with it alone would need
 * ~7000 units moved out of buckets holding a few hundred.
 *
 * Walking the whole ladder fixes both problems: each step shrinks the residue
 * to its own granularity, and consecutive spans are close enough that the next
 * step never needs more capacity than it has. Pairs with equal payouts are
 * skipped — moving weight between them does nothing (the real data has two
 * separate 200x buckets).
 */
function payoutPairs(ctx: Ctx, idx: number[]): [number, number][] {
  const pairs: { pair: [number, number]; span: number }[] = []

  for (let a = 0; a < idx.length; a++) {
    for (let b = a + 1; b < idx.length; b++) {
      const i = idx[a]
      const j = idx[b]
      const span = Math.abs(ctx.payouts[i] - ctx.payouts[j])
      if (!(span > 0)) continue
      pairs.push({ pair: ctx.payouts[i] < ctx.payouts[j] ? [i, j] : [j, i], span })
    }
  }

  pairs.sort((a, b) => b.span - a.span)
  return pairs.map((p) => p.pair)
}

/** Unlocked positive-payout rows, lowest payout first. */
function ladderIdx(ctx: Ctx): number[] {
  return [...ctx.freeIdx[1], ...ctx.freeIdx[2]].sort(
    (a, b) => ctx.payouts[a] - ctx.payouts[b] || a - b,
  )
}

/** True when no higher payout carries more weight than a lower one. */
function inOrder(ctx: Ctx, w: number[], ladder: number[]): boolean {
  for (let k = 1; k < ladder.length; k++) {
    const lo = ladder[k - 1]
    const hi = ladder[k]
    if (ctx.payouts[hi] > ctx.payouts[lo] && w[hi] > w[lo]) return false
  }
  return true
}

/**
 * Integer sweep that puts the ladder back in order.
 *
 * Every fix is a transfer, so the total never moves, and weight only ever
 * travels *down* the ladder — the pairs being repaired are adjacent in payout,
 * so RTP falls by at most step × the payout gap over the total (4e-6 at step
 * 100 on the reference table).
 *
 * It terminates: each transfer moves at least one step from a higher-payout
 * bucket to the one below it, so the position-weighted sum `Σ k·w[ladder[k]]`
 * strictly falls by at least `step` every time, and it is bounded below by
 * zero. The pass cap is a runaway guard, not the thing that stops the sweep.
 *
 * It needs more passes than the ladder is long. Lifting a bucket can break the
 * pair below it, and because each fix *halves* the excess rather than swapping,
 * the resulting cascade converges geometrically rather than one rung per pass —
 * a four-bucket band can need seven.
 */
function enforceOrder(ctx: Ctx, w: number[], step: number, ladder: number[]): void {
  for (let pass = 0; pass < ladder.length * 50 + 100; pass++) {
    let moved = false
    for (let k = 1; k < ladder.length; k++) {
      const lo = ladder[k - 1]
      const hi = ladder[k]
      if (ctx.payouts[hi] <= ctx.payouts[lo]) continue
      const excess = w[hi] - w[lo]
      if (excess <= 0) continue
      const give = Math.min(Math.ceil(excess / 2 / step) * step, Math.max(0, w[hi] - step))
      if (give <= 0) continue
      w[hi] -= give
      w[lo] += give
      moved = true
    }
    if (!moved) return
  }
}

/**
 * Locks are rank 1 and sit wherever the user put them, so a locked weight that
 * breaks the ladder is reported rather than moved.
 */
function lockedOrderNote(ctx: Ctx, rows: BucketRow[], w: number[]): string | null {
  const all = rows
    .map((_, i) => i)
    .filter((i) => ctx.payouts[i] > 0)
    .sort((a, b) => ctx.payouts[a] - ctx.payouts[b] || a - b)
  for (let k = 1; k < all.length; k++) {
    const lo = all[k - 1]
    const hi = all[k]
    if (ctx.payouts[hi] <= ctx.payouts[lo] || w[hi] <= w[lo]) continue
    const culprit = ctx.locked[hi] ? hi : ctx.locked[lo] ? lo : -1
    if (culprit === -1) continue
    const other = culprit === hi ? lo : hi
    return `"${rows[culprit].label}" is locked at ${w[culprit].toLocaleString('en-US')}, out of payout order with "${rows[other].label}" — locked weights are never reordered.`
  }
  return null
}

/** Move weight between one pair until RTP stops improving. */
function transfer(
  ctx: Ctx,
  w: number[],
  target: number,
  pair: [number, number] | null,
  step: number,
  ladder: number[],
): void {
  if (pair === null) return
  const [lo, hi] = pair
  const span = ctx.payouts[hi] - ctx.payouts[lo]
  if (!(span > 0)) return

  // Keep the existing conditional floors. Replacing them with a bare `step`
  // inverts the clamp's range whenever a bucket already sits below one step —
  // `largestRemainder` drops its floor when a group's budget cannot go round —
  // and `clamp` then returns its upper bound unconditionally, emitting a
  // negative weight straight into the document.
  const minLo = w[lo] >= step ? step : 0
  const minHi = w[hi] >= step ? step : 0
  const err = () => (target - rtpOf(ctx, w)) * ctx.total

  const d = clamp(Math.round(err() / span / step) * step, -(w[hi] - minHi), w[lo] - minLo)
  if (d !== 0) {
    w[lo] -= d
    w[hi] += d
    if (!inOrder(ctx, w, ladder)) {
      w[lo] += d
      w[hi] -= d
    }
  }

  for (let k = 0; k < 200; k++) {
    const before = Math.abs(err())
    if (before === 0) return
    const dir = err() > 0 ? 1 : -1
    if (dir === 1 && w[lo] - step < minLo) return
    if (dir === -1 && w[hi] - step < minHi) return
    w[lo] -= dir * step
    w[hi] += dir * step
    if (Math.abs(err()) >= before || !inOrder(ctx, w, ladder)) {
      w[lo] += dir * step
      w[hi] -= dir * step
      return
    }
  }
}

/**
 * Integer rounding drifts RTP off target. Shuffle units between unlocked win
 * buckets, which leaves every group sum — and therefore hit and win chance —
 * untouched. Accuracy bottoms out at step × half the finest payout gap divided
 * by the total: about 2e-8 on the reference ladder (or step × 2e-8 when step > 1).
 * The ladder guard can leave a residue when every RTP-improving move is blocked
 * by ordering — a transfer that would close the gap but invert the ladder is
 * refused rather than taken.
 */
function repairRtp(ctx: Ctx, w: number[], target: number, step: number, ladder: number[]): void {
  const idx = ctx.freeIdx[2]
  if (idx.length < 2) return

  const err = () => Math.abs(target - rtpOf(ctx, w)) * ctx.total
  for (const pair of payoutPairs(ctx, idx)) {
    if (err() < 1e-9) return
    transfer(ctx, w, target, pair, step, ladder)
  }
}

/** How many mass shifts a solve will attempt before giving up and saying so. */
const ORDER_ROUNDS = 12

/** How far the residual falls short of being the table's largest weight. */
function dominanceGap(ctx: Ctx, w: number[]): number {
  const r = ctx.residual
  if (r === -1 || ctx.locked[r]) return 0
  const ladder = [...ctx.freeIdx[1], ...ctx.freeIdx[2]]
  if (ladder.length === 0) return 0
  return Math.max(...ladder.map((i) => w[i])) - w[r]
}

/**
 * Move the smallest mass from the win band to the small-win band that turns an
 * upward step at 1x into a downward one.
 *
 * A downward step there is legitimate — it is what lets the win band be rare
 * without crushing the tail — so only a rising boundary is repaired. Solved
 * against the current shapes and overshot by one step, so the integer stage
 * cannot round the fix back out; the caller re-solves γ and comes back, which
 * is what makes the approximation converge.
 */
function levelBoundary(ctx: Ctx, budgets: number[], w: number[], step: number): number {
  const a = ctx.freeIdx[1]
  const b = ctx.freeIdx[2]
  if (a.length === 0 || b.length === 0 || !(budgets[1] > 0) || !(budgets[2] > 0)) return 0
  const lowest = Math.min(...a.map((i) => w[i]))
  const highest = Math.max(...b.map((i) => w[i]))
  if (highest <= lowest) return 0

  const room = Math.max(0, budgets[2] - b.length * step)
  const rate = highest / budgets[2] + lowest / budgets[1]
  const d = Math.min((highest - lowest + step) / Math.max(rate, 1e-9), room)
  if (!(d > 0)) return 0
  budgets[1] += d
  budgets[2] -= d
  return d
}

/**
 * Move the smallest mass from the paying bands to the zero band that makes the
 * residual the table's largest weight. The zero band's mass is hit chance, so
 * this is hit chance yielding to ordering.
 */
function raiseResidual(ctx: Ctx, budgets: number[], w: number[], step: number): number {
  const gap = dominanceGap(ctx, w)
  // Clear the ladder by a full step rather than merely tie it. The caller
  // re-solves gamma after every shift, so a margin sized against the
  // pre-re-solve shapes can collapse back to nothing — and `allocate` then
  // rounds the repair away, leaving the residual a unit or two short of a
  // bucket it is supposed to dominate. Nothing downstream catches that:
  // Task 6's `enforceOrder` walks the positive ladder only, and the residual
  // pays 0.
  if (gap <= -step) return 0
  const paying = budgets[1] + budgets[2]
  if (!(paying > 0) || !(budgets[0] > 0)) return 0

  const share = w[ctx.residual] / budgets[0]
  const top = w[ctx.residual] + gap
  const members = ctx.freeIdx[1].length + ctx.freeIdx[2].length
  const room = Math.max(0, paying - members * step)
  const d = Math.min((gap + 2 * step) / Math.max(share + top / paying, 1e-9), room)
  if (!(d > 0)) return 0

  const keep = (paying - d) / paying
  budgets[0] += d
  budgets[1] *= keep
  budgets[2] *= keep
  return d
}

/**
 * Give the residual back whatever the integer split took off it.
 *
 * The continuous solve leaves it clear of the ladder, but `allocate` divides
 * the zero-payout group with a one-step-per-bucket floor, which costs the
 * residual roughly its share of that floor — about three units on the
 * reference table's five-bucket group. Sizing the continuous cushion to absorb
 * that would spend hit chance the table does not need, and the size of the
 * loss depends on the group's bucket count, so a fixed cushion is the wrong
 * shape. Moving the units back afterwards is exact.
 *
 * The weight comes off the top of the ladder, which is the lowest-paying
 * bucket there is, so this is the cheapest repair available in RTP terms — and
 * `repairRtp` runs afterwards to take back what little it costs.
 */
function restoreResidual(ctx: Ctx, w: number[], step: number): void {
  const r = ctx.residual
  if (r === -1 || ctx.locked[r]) return
  const ladder = [...ctx.freeIdx[1], ...ctx.freeIdx[2]]
  if (ladder.length === 0) return

  // Closing the gap against one bucket can leave another on top; each pass
  // fixes the current highest, so the ladder's length bounds the work.
  for (let pass = 0; pass < ladder.length; pass++) {
    let top = ladder[0]
    for (const i of ladder) if (w[i] > w[top]) top = i
    if (w[top] <= w[r]) return
    const give = Math.min(
      Math.ceil((w[top] - w[r]) / 2 / step) * step,
      Math.max(0, w[top] - step),
    )
    if (give <= 0) return
    w[top] -= give
    w[r] += give
  }
}

export function solveWeights(
  rows: BucketRow[],
  totalWeight: number,
  targets: Targets,
  curve: number,
  step: WeightStep = 1,
  /** Internal: false on the inner call, so the remainder split cannot recurse. */
  absorbRemainder = true,
): SolveResult {
  const empty: SolveResult = {
    weights: rows.map((r) => Math.max(0, Math.round(r.weight))),
    achieved: statsOf(rows, totalWeight),
    bandUsed: 0,
    gamma: 0,
    curveUsed: targets.useVolatility ? curve : 0,
    warnings: [],
  }
  if (rows.length === 0 || !(totalWeight > 0)) return empty

  // Volatility off means no curvature term at all — a pure power law, with
  // gamma alone left to solve RTP.
  const ctx = buildCtx(rows, totalWeight, targets.useVolatility ? curve : 0)
  const pooled = !targets.useChances
  const warnings: string[] = []

  // The user's conflict ranking. `above(a, b)` answers "does a outrank b" —
  // when the two collide, the one that does not gets sacrificed.
  const priority = normalizePriority(targets.priority)
  const above = (a: PriorityKey, b: PriorityKey) => priority.indexOf(a) < priority.indexOf(b)

  if (ctx.freeIdx.every((g) => g.length === 0)) {
    return { ...empty, warnings: ['Every row is locked — nothing left to distribute.'] }
  }

  const freeWeight = Math.round(ctx.total - ctx.totalLocked)
  const freeCount = ctx.freeIdx.reduce((a, g) => a + g.length, 0)
  // An indivisible remainder is parked on one bucket *on top of* its floor, so
  // it is the divisible part that has to fund them all.
  if (freeWeight - (freeWeight % step) < freeCount * step) {
    return { ...empty, warnings: [floorBlockWarning(rows, step, Math.round(totalWeight))] }
  }

  const remainder = freeWeight % step
  if (remainder !== 0) {
    // Solve the divisible part and park the leftover on one bucket, so the
    // grand total stays exact and every other weight stays on the step.
    // `freeWeight - remainder` divides by construction, so the inner call
    // takes the normal path; the flag makes that guarantee explicit.
    const base = absorbRemainder
      ? solveWeights(rows, totalWeight - remainder, targets, curve, step, false)
      : null
    const weights = base === null ? null : [...base.weights]
    const carrier = weights === null ? -1 : remainderCarrier(rows, weights)
    if (base === null || weights === null || carrier === -1) {
      return { ...empty, warnings: [stepBlockWarning(freeWeight, ctx.totalLocked, step)] }
    }

    weights[carrier] += remainder
    return {
      ...base,
      weights,
      achieved: statsOf(
        rows.map((r, i) => ({ ...r, weight: weights[i] })),
        totalWeight,
      ),
      warnings: [
        ...base.warnings,
        stepRemainderNote(freeWeight, remainder, step, rows[carrier].label),
      ],
    }
  }

  // Spend as little of the tolerance band as the targets allow.
  interface Candidate {
    s: number
    budgets: number[]
    conflict: boolean
    reachable: boolean
  }

  /**
   * The band position to solve at: the least tolerance spent that puts the RTP
   * target in reach, or — when nothing does — the first lock-clean position.
   *
   * Ordering outranks the chance preferences, so the ordered pass gets first
   * refusal on the band; only when no position reaches the target in order
   * does the caller run this again unordered, which is the pre-ordering search
   * exactly.
   */
  const chooseBand = (c: Ctx): Candidate => {
    const reaches = (budgets: number[]) => {
      const [min, max] = reachRange(c, budgets, pooled)
      return targets.rtp >= min - 1e-12 && targets.rtp <= max + 1e-12
    }

    if (pooled) {
      // Nothing to search: with no chance targets there is no band to spend.
      const { budgets, conflict } = freeBudgets(c, currentMasses(c, targets), step)
      return { s: 0, budgets, conflict, reachable: reaches(budgets) }
    }

    let fallback: Candidate | null = null
    for (const s of bandCandidates()) {
      const { budgets, conflict } = freeBudgets(c, massesFor(targets, s, totalWeight), step)
      const candidate: Candidate = { s, budgets, conflict, reachable: reaches(budgets) }
      if (!conflict && candidate.reachable) return candidate
      // Locks are hard, so a lock-clean position beats an RTP-reachable one.
      if (!conflict && fallback === null) fallback = candidate
    }
    if (fallback !== null) return fallback

    const { budgets, conflict } = freeBudgets(c, massesFor(targets, 0, totalWeight), step)
    return { s: 0, budgets, conflict, reachable: reaches(budgets) }
  }

  // The ranking decides what gives when the target is out of ordered reach.
  // The three dimensions that trade against each other here — RTP, ordering,
  // volatility — are sacrificed lowest-ranked first: flattening the curve
  // spends volatility, going unordered spends the ladder, and reaching "rtp"
  // in the sacrifice order means accepting the miss (the RTP warning below
  // reports it). A sacrifice is only kept when it actually brings the target
  // into reach — giving something up for a target that is missed either way
  // buys nothing.
  let solveCtx = ctx
  let chosen = chooseBand(ctx)
  let curveUsed = ctx.curve
  let orderYielded = false

  if (!chosen.reachable) {
    const sacrifices = (['volatility', 'ordering', 'rtp'] as const)
      .slice()
      .sort((a, b) => priority.indexOf(b) - priority.indexOf(a))

    for (const dim of sacrifices) {
      if (dim === 'rtp') break

      if (dim === 'volatility') {
        const flat = fitCurve(solveCtx, chosen.budgets, targets.rtp, pooled)
        const flattened = flat === null ? null : chooseBand({ ...solveCtx, curve: flat })
        if (flat !== null && flattened !== null && flattened.reachable) {
          solveCtx = { ...solveCtx, curve: flat }
          chosen = flattened
          curveUsed = flat
          break
        }
        continue
      }

      // Ordering yields with the user's own curvature, not a flattened one —
      // if flattening ran before this and did not reach, it bought nothing.
      const unordered = { ...ctx, ordered: false }
      const relaxed = chooseBand(unordered)
      if (relaxed.reachable) {
        solveCtx = unordered
        chosen = relaxed
        curveUsed = ctx.curve
        orderYielded = true
        break
      }
    }
  }

  const budgets = chosen.budgets.slice()
  let gamma = 0
  let cont: number[] = []
  let yieldedWin = false
  let yieldedHit = false
  let settled = false

  // The two mass repairs spend a chance to keep the ladder in shape, so each
  // runs only while ordering outranks the chance it would spend. A chance
  // ranked above ordering keeps its mass, and the shape damage is reported
  // instead of repaired.
  const orderAboveHit = above('ordering', 'hit')
  const orderAboveWin = above('ordering', 'win')

  for (let round = 0; round < ORDER_ROUNDS; round++) {
    gamma = solveGamma(solveCtx, budgets, targets.rtp, pooled)
    cont = continuousWeights(solveCtx, budgets, gamma, pooled)
    if (!solveCtx.ordered) {
      settled = true
      break
    }
    if (orderAboveHit && raiseResidual(solveCtx, budgets, cont, step) > 0) {
      yieldedHit = true
      continue
    }
    if (orderAboveWin && levelBoundary(solveCtx, budgets, cont, step) > 0) {
      yieldedWin = true
      continue
    }
    settled = true
    break
  }

  // An unordered solve carries deliberate inversions, so `inOrder` would read
  // them as breakage and veto every RTP-improving transfer `repairRtp` tries —
  // silently disabling the repair in the one regime that most needs it.
  // Handing it an empty ladder switches the guard off along with the regime.
  const ladder = solveCtx.ordered ? ladderIdx(solveCtx) : []
  const weights = allocate(solveCtx, cont, step)
  if (solveCtx.ordered) {
    if (orderAboveWin) {
      enforceOrder(solveCtx, weights, step, ladder)
    } else {
      // A transfer across the 1x boundary moves mass between the small-win
      // and win bands — that is win chance, which outranks ordering here, so
      // each band is put in order on its own and the boundary stands.
      for (const g of [1, 2] as const) {
        enforceOrder(solveCtx, weights, step, ladder.filter((i) => groupOf(solveCtx.payouts[i]) === g))
      }
    }
    // The residual's integer top-up takes its weight from the paying ladder —
    // hit chance again — so it is gated exactly like raiseResidual above.
    if (orderAboveHit) restoreResidual(solveCtx, weights, step)
  }
  // repairRtp only ever moves weight inside the win band, but its guard reads
  // whatever ladder it is handed. With the 1x boundary allowed to stand
  // inverted (win chance outranks ordering), a full-ladder guard would read
  // that standing inversion as breakage and veto every transfer — so the
  // guard shrinks to the band the repair actually touches.
  const guardLadder = orderAboveWin
    ? ladder
    : ladder.filter((i) => groupOf(solveCtx.payouts[i]) === 2)
  repairRtp(solveCtx, weights, targets.rtp, step, guardLadder)

  const achieved = statsOf(
    rows.map((r, i) => ({ ...r, weight: weights[i] })),
    totalWeight,
  )

  // Only in the ordered regime. Once ordering has yielded the ladder is
  // inverted everywhere on purpose, and any lock that happens to sit beside one
  // of those inversions would be blamed for a mess it did not make — unlocking
  // it would change nothing.
  if (solveCtx.ordered) {
    const lockNote = lockedOrderNote(solveCtx, rows, weights)
    if (lockNote !== null) warnings.push(lockNote)
  }

  if (chosen.conflict && targets.useChances) {
    const over = [0, 1, 2].filter(
      (g) => ctx.lockedSum[g] - massesFor(targets, chosen!.s, totalWeight)[g] > 0.5,
    )
    for (const g of over) {
      warnings.push(
        `Locked weight in the ${GROUP_NAMES[g]} buckets exceeds that group's share of the total, so its chance target could not be met.`,
      )
    }
  }

  if (curveUsed < ctx.curve - 1e-9) {
    warnings.push(
      `Volatility flattened (curve ${ctx.curve} → ${curveUsed.toFixed(3)}) to keep weights ordered by payout while hitting RTP ${targets.rtp}.`,
    )
  }
  if (orderYielded) {
    warnings.push(
      `Weights could not be kept in payout order at RTP ${targets.rtp} — ordering yielded to the RTP target.`,
    )
  }

  // Shape damage a higher-ranked chance forbade repairing is reported, since
  // the repair that would normally hide it was deliberately skipped.
  if (solveCtx.ordered && targets.useChances) {
    if (!orderAboveHit && dominanceGap(solveCtx, weights) > 0) {
      warnings.push(
        'The residual 0x bucket is not the largest weight — hit chance outranks ordering, so no mass was spent raising it.',
      )
    }
    if (!orderAboveWin) {
      const a = solveCtx.freeIdx[1].map((i) => weights[i])
      const b = solveCtx.freeIdx[2].map((i) => weights[i])
      if (a.length > 0 && b.length > 0 && Math.max(...b) > Math.min(...a)) {
        warnings.push(
          'A win bucket outweighs a small-win bucket at the 1x boundary — win chance outranks ordering, so the boundary was left as the masses demand.',
        )
      }
    }
  }

  // Reachability is a property of the continuous solve. Integer rounding
  // leaves a residue whose size depends on the closest pair of payouts on the
  // ladder, so it is not evidence that the target was unreachable.
  const [min, max] = reachRange(solveCtx, budgets, pooled)
  if (!(targets.rtp >= min - 1e-12 && targets.rtp <= max + 1e-12)) {
    warnings.push(
      `Target RTP ${targets.rtp} is out of reach at these chances — achieved ${achieved.rtp.toFixed(6)}.`,
    )
  }

  const tau = targets.tolerance / 100
  const outOfBand = (label: string, got: number, want: number) => {
    if (want <= 0) return
    if (got < want * (1 - tau) - 1e-9 || got > want * (1 + tau) + 1e-9) {
      warnings.push(
        `Achieved ${label} ${got.toFixed(3)} is outside the ±${targets.tolerance}% band around ${want}.`,
      )
    }
  }
  if (!settled) {
    warnings.push('Weights could not be brought into payout order within the solver’s iteration limit.')
  }

  // Nothing to report against when the chances are not being steered.
  if (targets.useChances) {
    if (yieldedHit) {
      warnings.push(
        `Hit chance yielded to payout ordering — achieved ${achieved.hitChance.toFixed(3)} against a target of ${targets.hitChance}.`,
      )
    } else {
      outOfBand('hit chance', achieved.hitChance, targets.hitChance)
    }
    if (yieldedWin) {
      warnings.push(
        `Win chance yielded to payout ordering — achieved ${achieved.winChance.toFixed(3)} against a target of ${targets.winChance}.`,
      )
    } else {
      outOfBand('win chance', achieved.winChance, targets.winChance)
    }
  }

  return { weights, achieved, bandUsed: chosen.s, gamma, curveUsed, warnings }
}

/**
 * Total weight is the sum of the weight column, so changing one bucket's
 * weight also moves the total. Typing a chance of 0.25 and scaling by the
 * stale total would therefore land somewhere else; these solve for the weight
 * that makes the typed figure true *after* the total shifts.
 *
 *   chance c:  w = c·other / (1 − c)        where other = total − w_current
 *   value  v:  w = v·other / (payout − v)
 *
 * Solved weights land on the nearest multiple of `step`, so the typed figure is met as closely as the step allows.
 *
 * Null means the request is unsatisfiable: no finite weight reaches a chance
 * of 1 alongside other buckets, and no weight makes a bucket return more than
 * its own payout.
 */
export function weightForChance(
  currentWeight: number,
  totalWeight: number,
  chance: number,
  step: WeightStep = 1,
): number | null {
  const other = totalWeight - currentWeight
  if (!(other > 0) || !(chance >= 0) || chance >= 1) return null
  return Math.round((chance * other) / (1 - chance) / step) * step
}

export function weightForValue(
  currentWeight: number,
  totalWeight: number,
  payout: number,
  value: number,
  step: WeightStep = 1,
): number | null {
  const other = totalWeight - currentWeight
  if (!(other > 0) || !(value >= 0) || !(payout > value)) return null
  return Math.round((value * other) / (payout - value) / step) * step
}

/**
 * Scale to a new total, preserving locks and the current shape.
 * Returns null when the new total cannot hold the locked weight,
 * or when the free budget is not divisible by the step.
 */
export function rescaleToTotal(
  rows: BucketRow[],
  newTotal: number,
  step: WeightStep = 1,
): number[] | null {
  if (!Number.isFinite(newTotal) || newTotal < 0) return null

  const out = rows.map((r) => Math.max(0, Math.round(r.weight)))
  const lockedSum = rows.reduce((a, r, i) => (r.locked ? a + out[i] : a), 0)
  if (newTotal < lockedSum) return null

  const budget = Math.round(newTotal) - lockedSum
  if (budget % step !== 0) return null

  const freeIdx = rows.map((_, i) => i).filter((i) => !rows[i].locked)
  if (freeIdx.length === 0) return budget === 0 ? out : null

  // Scaling down must not silently delete a bucket, so refuse rather than
  // return a table with holes in it.
  if (budget < freeIdx.length * step) return null

  const base = freeIdx.map((i) => out[i])
  const anyPositive = base.some((b) => b > 0)
  const alloc = largestRemainder(anyPositive ? base : base.map(() => 1), budget, true, step)
  freeIdx.forEach((i, k) => {
    out[i] = alloc[k]
  })

  return out
}

/**
 * Move RTP to a new value by reshaping the payout ladder only.
 *
 * Each group's unlocked weight is preserved exactly, so hit chance and win
 * chance do not budge — the common workflow is nudging RTP while the chances
 * stay where they were put. Implemented as a minimal exponential tilt of the
 * current weights, so the existing curve's character survives.
 *
 * Returns null when a group's unlocked sum is not divisible by the step,
 * since no on-step redistribution can preserve an off-step sum.
 */
export function retargetRtp(
  rows: BucketRow[],
  totalWeight: number,
  targetRtp: number,
  step: WeightStep = 1,
): number[] | null {
  const out = rows.map((r) => Math.max(0, Math.round(r.weight)))
  if (rows.length === 0 || !(totalWeight > 0)) return out

  const ctx = buildCtx(rows, totalWeight, 0)
  const groups = [1, 2] as const
  const groupTotals = groups.map((g) => ctx.freeIdx[g].reduce((a, i) => a + out[i], 0))
  // Each group's unlocked sum is preserved exactly, so each must already sit
  // on the step — otherwise no on-step redistribution can reproduce it.
  if (groupTotals.some((t) => t % step !== 0)) return null

  const tilted = (theta: number): number[] => {
    const w = out.slice()
    groups.forEach((g, gi) => {
      const idx = ctx.freeIdx[g]
      const groupTotal = groupTotals[gi]
      if (idx.length === 0 || groupTotal <= 0) return
      const logs = idx.map((i) => Math.log(Math.max(out[i], 1e-9)) + theta * ctx.u[i])
      const maxLog = Math.max(...logs)
      const raw = logs.map((l) => Math.exp(l - maxLog))
      const sum = raw.reduce((a, b) => a + b, 0)
      idx.forEach((i, k) => {
        w[i] = (raw[k] / sum) * groupTotal
      })
    })
    return w
  }

  // RTP increases with theta: positive theta shifts mass up the ladder.
  let lo = -40
  let hi = 40
  const goal = clamp(targetRtp, rtpOf(ctx, tilted(lo)), rtpOf(ctx, tilted(hi)))
  for (let k = 0; k < BISECTION_STEPS; k++) {
    const mid = (lo + hi) / 2
    if (rtpOf(ctx, tilted(mid)) < goal) lo = mid
    else hi = mid
  }

  const cont = tilted((lo + hi) / 2)
  const result = out.slice()
  groups.forEach((g, gi) => {
    const idx = ctx.freeIdx[g]
    if (idx.length === 0) return
    const alloc = largestRemainder(
      idx.map((i) => cont[i]),
      groupTotals[gi],
      true,
      step,
    )
    idx.forEach((i, k) => {
      result[i] = alloc[k]
    })
  })

  // Each band on its own: the tilt above preserves every group's unlocked sum,
  // and a cross-band transfer here would undo that.
  const ladder = ladderIdx(ctx)
  for (const g of [1, 2] as const) {
    enforceOrder(ctx, result, step, ladder.filter((i) => groupOf(ctx.payouts[i]) === g))
  }
  // Unguarded, deliberately. This is the RTP cell: reaching the typed figure is
  // the whole point of it, RTP outranks ordering, and `retargetRtp` returns a
  // bare `number[] | null` with nowhere to report a yield. Guarding it here
  // silently trades away RTP accuracy — measured worst case, a target of 1.4
  // landing on 0.82 — with nothing on screen to explain why. Ordering is
  // improved on this path but guaranteed only through Auto-Distribute.
  repairRtp(ctx, result, targetRtp, step, [])
  return result
}
