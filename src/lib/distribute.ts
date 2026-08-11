import type { BucketRow, Targets, WeightStep } from './types'

/**
 * Weight distribution solver.
 *
 * The three targets and the volatility setting are over-constrained, so they
 * are resolved by rank:
 *
 *  1. Locked weights are absolute — never touched.
 *  2. Hit and win chance are satisfied *structurally*, by deciding how much
 *     total weight each payout group receives. They are preferences with a
 *     relative tolerance band; the band is spent only when the RTP target is
 *     otherwise unreachable, and then only as far as needed.
 *  3. RTP is hit exactly (to integer-weight granularity) by solving the slope
 *     of the weight curve.
 *  4. Volatility shapes whatever freedom is left, as curvature of that curve.
 *
 * Steps 3 and 4 do not collide because slope and curvature are different basis
 * functions: `share ∝ exp(−γ·u − c·u²)` with `u = ln(payout) − ln(pMin)`.
 * Solving γ for RTP leaves c — and therefore the volatility setting — intact.
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

/** Move weight between one pair until RTP stops improving. */
function transfer(
  ctx: Ctx,
  w: number[],
  target: number,
  pair: [number, number] | null,
  step: number,
): void {
  if (pair === null) return
  const [lo, hi] = pair
  const span = ctx.payouts[hi] - ctx.payouts[lo]
  if (!(span > 0)) return

  const minLo = w[lo] >= step ? step : 0
  const minHi = w[hi] >= step ? step : 0
  const err = () => (target - rtpOf(ctx, w)) * ctx.total

  const d = clamp(Math.round(err() / span / step) * step, -(w[hi] - minHi), w[lo] - minLo)
  if (d !== 0) {
    w[lo] -= d
    w[hi] += d
  }

  for (let k = 0; k < 200; k++) {
    const before = Math.abs(err())
    if (before === 0) return
    const dir = err() > 0 ? 1 : -1
    if (dir === 1 && w[lo] - step < minLo) return
    if (dir === -1 && w[hi] - step < minHi) return
    w[lo] -= dir * step
    w[hi] += dir * step
    if (Math.abs(err()) >= before) {
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
 */
function repairRtp(ctx: Ctx, w: number[], target: number, step: number): void {
  const idx = ctx.freeIdx[2]
  if (idx.length < 2) return

  const err = () => Math.abs(target - rtpOf(ctx, w)) * ctx.total
  for (const pair of payoutPairs(ctx, idx)) {
    if (err() < 1e-9) return
    transfer(ctx, w, target, pair, step)
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

  // The ranking decides what gives when the target is out of ordered reach:
  // volatility ranks below ordering, so the curve flattens first; only when
  // even a straight line cannot reach the target does the ladder itself yield,
  // and then the user's curvature comes back, since flattening it bought
  // nothing.
  let solveCtx = ctx
  let chosen = chooseBand(ctx)
  let curveUsed = ctx.curve
  let orderYielded = false

  if (!chosen.reachable) {
    const flat = fitCurve(ctx, chosen.budgets, targets.rtp, pooled)
    const flattened = flat === null ? null : chooseBand({ ...ctx, curve: flat })
    if (flat !== null && flattened !== null && flattened.reachable) {
      solveCtx = { ...ctx, curve: flat }
      chosen = flattened
      curveUsed = flat
    } else {
      solveCtx = { ...ctx, ordered: false }
      chosen = chooseBand(solveCtx)
      orderYielded = true
    }
  }

  const gamma = solveGamma(solveCtx, chosen.budgets, targets.rtp, pooled)
  const weights = allocate(
    solveCtx,
    continuousWeights(solveCtx, chosen.budgets, gamma, pooled),
    step,
  )
  repairRtp(solveCtx, weights, targets.rtp, step)

  const achieved = statsOf(
    rows.map((r, i) => ({ ...r, weight: weights[i] })),
    totalWeight,
  )

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

  // Reachability is a property of the continuous solve. Integer rounding
  // leaves a residue whose size depends on the closest pair of payouts on the
  // ladder, so it is not evidence that the target was unreachable.
  const [min, max] = reachRange(solveCtx, chosen.budgets, pooled)
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
  // Nothing to report against when the chances are not being steered.
  if (targets.useChances) {
    outOfBand('hit chance', achieved.hitChance, targets.hitChance)
    outOfBand('win chance', achieved.winChance, targets.winChance)
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

  repairRtp(ctx, result, targetRtp, step)
  return result
}
