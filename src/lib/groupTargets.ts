import type { BucketRow, GroupDef, Targets, WeightStep } from './types'
import { normalizePriority } from './types'
import { largestRemainder } from './distribute'

/**
 * Group-level constraints for Auto-Distribute, and the in-group rebalance a
 * total-locked group's member edits go through.
 *
 * A group can carry three optional demands: a pinned total (`totalLocked` /
 * `prefChance` — one concept: specifying a chance *is* soft-locking the group,
 * at that chance) and `prefRtp` (its members are tilted so the group
 * contributes that weighted value). All demands reduce to the same move —
 * decide the group's weights *before* the main solve and hand them to it as
 * locked rows. Locks are the solver's rank-1 constraint and its RTP accounting
 * already includes them, so the solver steers the rest of the table around the
 * pinned groups without learning anything about groups at all.
 *
 * The chance is a hard rule, met to 0.0001% (1e-6 of total weight) — only the
 * weight step's granularity can move it, and that is reported. The weighted
 * value is a soft rule: the solve does its best and warns when it cannot land
 * within 0.001.
 *
 * Within each pinned group the free members are not merely rescaled: they are
 * tilted toward the table's RTP target (or the group's own `prefRtp`) and kept
 * in payout order, honoring the priority ranking — when ordering and RTP
 * cannot both hold inside the group, the lower-ranked one yields. This is what
 * lets Auto-Distribute do useful work even when every unlocked bucket sits in
 * a pinned group and the main solver has nothing left to move.
 */

const TILT_LIMIT = 40
const BISECTION_STEPS = 200
/** A weighted-value miss beyond this is reported; the user's stated precision. */
const VALUE_EPS = 1e-3
/** The chance is hard: 0.0001% of total weight. */
const CHANCE_EPS = 1e-6

export interface GroupPlan {
  /** Row index → weight to pin (as a locked row) for the main solve. */
  pinned: Map<number, number>
  notes: string[]
}

/** True when Auto-Distribute must decide this group's weights up front. */
export function hasGroupDemands(g: GroupDef): boolean {
  return g.totalLocked === true || g.prefChance !== undefined || g.prefRtp !== undefined
}

/**
 * Whether the group's total weight is pinned. `totalLocked` and `prefChance`
 * are two spellings of the same state — the Σ toggle records the chance it
 * pinned, and typing a chance sets the toggle — but workspaces saved before
 * they were unified can carry either alone, so both are read.
 */
export function isSoftLocked(g: GroupDef): boolean {
  return g.totalLocked === true || g.prefChance !== undefined
}

function roundTo(v: number, step: number): number {
  return Math.round(v / step) * step
}

function contribution(payouts: number[], w: number[]): number {
  let acc = 0
  for (let i = 0; i < w.length; i++) acc += payouts[i] * w[i]
  return acc
}

/** Positive-payout indices, lowest payout first — the group's own ladder. */
function ladderOf(payouts: number[]): number[] {
  return payouts
    .map((_, i) => i)
    .filter((i) => payouts[i] > 0)
    .sort((a, b) => payouts[a] - payouts[b])
}

/** True when no higher payout carries more weight than a lower one. */
function inOrderWithin(payouts: number[], w: number[], ladder: number[]): boolean {
  for (let k = 1; k < ladder.length; k++) {
    const lo = ladder[k - 1]
    const hi = ladder[k]
    if (payouts[hi] > payouts[lo] && w[hi] > w[lo]) return false
  }
  return true
}

/**
 * Put the group's ladder back in payout order by mass-preserving transfers —
 * the same halving sweep distribute.ts uses, scoped to one group's members.
 */
function enforceOrderWithin(payouts: number[], w: number[], step: number): void {
  const ladder = ladderOf(payouts)
  for (let pass = 0; pass < ladder.length * 50 + 100; pass++) {
    let moved = false
    for (let k = 1; k < ladder.length; k++) {
      const lo = ladder[k - 1]
      const hi = ladder[k]
      if (payouts[hi] <= payouts[lo]) continue
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

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

/**
 * Nudge the group's contribution toward `targetAbs` (in Σ payout·weight
 * units) by transfers inside the group, widest payout span first. With
 * `guarded`, any move that would break the group's own payout order is
 * refused — that is ordering outranking RTP.
 */
function repairWithin(
  payouts: number[],
  w: number[],
  targetAbs: number,
  step: number,
  guarded: boolean,
): void {
  const ladder = ladderOf(payouts)
  if (ladder.length < 2) return

  const pairs: { pair: [number, number]; span: number }[] = []
  for (let a = 0; a < ladder.length; a++) {
    for (let b = a + 1; b < ladder.length; b++) {
      const i = ladder[a]
      const j = ladder[b]
      const span = payouts[j] - payouts[i]
      if (span > 0) pairs.push({ pair: [i, j], span })
    }
  }
  pairs.sort((a, b) => b.span - a.span)

  const ok = () => !guarded || inOrderWithin(payouts, w, ladder)
  const err = () => targetAbs - contribution(payouts, w)

  for (const { pair, span } of pairs) {
    if (Math.abs(err()) < 1e-9) return
    const [lo, hi] = pair
    // Same conditional floors as distribute.ts's transfer: a bucket already
    // below one step must not force the clamp's range to invert.
    const minLo = w[lo] >= step ? step : 0
    const minHi = w[hi] >= step ? step : 0

    const d = clamp(Math.round(err() / span / step) * step, -(w[hi] - minHi), w[lo] - minLo)
    if (d !== 0) {
      w[lo] -= d
      w[hi] += d
      if (!ok()) {
        w[lo] += d
        w[hi] -= d
      }
    }

    for (let k = 0; k < 200; k++) {
      const before = Math.abs(err())
      if (before === 0) break
      const dir = err() > 0 ? 1 : -1
      if (dir === 1 && w[lo] - step < minLo) break
      if (dir === -1 && w[hi] - step < minHi) break
      w[lo] -= dir * step
      w[hi] += dir * step
      if (Math.abs(err()) >= before || !ok()) {
        w[lo] += dir * step
        w[hi] -= dir * step
        break
      }
    }
  }
}

/**
 * Ordering and RTP inside one group, ranked. Ordering is restored first and
 * the contribution repaired under an ordering guard; only when RTP outranks
 * ordering *and* the guarded repair left a real gap is the guard dropped —
 * spending the group's ladder is then the ranking's own instruction.
 */
function shapeWithinGroup(
  payouts: number[],
  w: number[],
  targetAbs: number,
  step: number,
  orderAboveRtp: boolean,
  totalWeight: number,
): void {
  enforceOrderWithin(payouts, w, step)
  repairWithin(payouts, w, targetAbs, step, true)
  if (!orderAboveRtp && Math.abs(targetAbs - contribution(payouts, w)) > VALUE_EPS * totalWeight) {
    repairWithin(payouts, w, targetAbs, step, false)
  }
}

/**
 * Tilt the free positive-payout members so the whole group's RTP contribution
 * lands on `target`, holding their combined mass fixed. Zero-payout members
 * cannot move the contribution, so they keep their share untouched — tilting
 * them would spend mass for nothing.
 *
 * Same construction as distribute.ts's retargetRtp: weights are re-shared as
 * softmax(log(current) + θ·ln(payout)), so θ = 0 reproduces the current shape
 * and the group's character survives small corrections.
 */
function tiltGroupRtp(
  payouts: number[],
  weights: number[],
  target: number,
  totalWeight: number,
  fixedContribution: number,
): number[] {
  const idx = payouts.map((_, i) => i).filter((i) => payouts[i] > 0)
  if (idx.length === 0) return weights

  const mass = idx.reduce((a, i) => a + weights[i], 0)
  if (!(mass > 0)) return weights

  const tilted = (theta: number): number[] => {
    const logs = idx.map((i) => Math.log(Math.max(weights[i], 1e-9)) + theta * Math.log(payouts[i]))
    const maxLog = Math.max(...logs)
    const raw = logs.map((l) => Math.exp(l - maxLog))
    const sum = raw.reduce((a, b) => a + b, 0)
    const out = weights.slice()
    idx.forEach((i, k) => {
      out[i] = (raw[k] / sum) * mass
    })
    return out
  }

  const contributionOf = (w: number[]): number =>
    (fixedContribution + idx.reduce((a, i) => a + payouts[i] * w[i], 0)) / totalWeight

  // Contribution rises with θ — positive θ shifts mass toward high payouts.
  let lo = -TILT_LIMIT
  let hi = TILT_LIMIT
  const goal = Math.min(Math.max(target, contributionOf(tilted(lo))), contributionOf(tilted(hi)))
  for (let k = 0; k < BISECTION_STEPS; k++) {
    const mid = (lo + hi) / 2
    if (contributionOf(tilted(mid)) < goal) lo = mid
    else hi = mid
  }
  return tilted((lo + hi) / 2)
}

/** One pinned-chance group awaiting the shared tilt toward the table's RTP. */
interface JointGroup {
  g: GroupDef
  free: number[]
  payouts: number[]
  shares: number[]
  freeMass: number
}

/**
 * One tilt, shared by every pinned group that carries no weighted-value
 * demand of its own, solved so their combined contribution lands the whole
 * table on the RTP target. Each group's mass is its own — only the shape
 * inside each group moves. Sharing θ is what makes the groups complement
 * each other instead of each chasing the global number alone.
 */
function jointTiltShares(groupsData: JointGroup[], targetAbs: number): number[][] {
  const pos = groupsData.map((g) => g.payouts.map((_, i) => i).filter((i) => g.payouts[i] > 0))
  const masses = groupsData.map((g, gi) => pos[gi].reduce((a, i) => a + g.shares[i], 0))

  const tilted = (theta: number): number[][] =>
    groupsData.map((g, gi) => {
      const idx = pos[gi]
      const mass = masses[gi]
      if (idx.length === 0 || !(mass > 0)) return g.shares.slice()
      const logs = idx.map((i) => Math.log(Math.max(g.shares[i], 1e-9)) + theta * Math.log(g.payouts[i]))
      const maxLog = Math.max(...logs)
      const raw = logs.map((l) => Math.exp(l - maxLog))
      const sum = raw.reduce((a, b) => a + b, 0)
      const out = g.shares.slice()
      idx.forEach((i, k) => {
        out[i] = (raw[k] / sum) * mass
      })
      return out
    })

  const contrib = (ws: number[][]) =>
    ws.reduce((a, w, gi) => a + contribution(groupsData[gi].payouts, w), 0)

  let lo = -TILT_LIMIT
  let hi = TILT_LIMIT
  const goal = clamp(targetAbs, contrib(tilted(lo)), contrib(tilted(hi)))
  for (let k = 0; k < BISECTION_STEPS; k++) {
    const mid = (lo + hi) / 2
    if (contrib(tilted(mid)) < goal) lo = mid
    else hi = mid
  }
  return tilted((lo + hi) / 2)
}

/**
 * Decide every demanding group's weights, to be pinned through the main solve.
 *
 * Per group: individually locked members stand as they are (row locks outrank
 * group demands, as they outrank everything). The free members share the
 * group's mass — `prefChance`'s share of the total when set, the current mass
 * otherwise. `prefRtp` tilts that shape toward the group's own weighted-value
 * demand; groups without one share a single tilt toward the table's RTP
 * target when `targets` is supplied. Both shapes are then put in payout order
 * and repaired per the priority ranking. Free mass is kept on the weight
 * step, one step per free member guaranteed, so the main solve never inherits
 * an off-step or starved group.
 */
export function planGroupTargets(
  rows: BucketRow[],
  groups: GroupDef[],
  totalWeight: number,
  step: WeightStep = 1,
  /** The solve's targets. Absent (older callers), shapes stay proportional to current weights. */
  targets?: Targets,
): GroupPlan {
  const pinned = new Map<number, number>()
  const notes: string[] = []
  if (!(totalWeight > 0)) return { pinned, notes }

  const priority = normalizePriority(targets?.priority)
  const orderAboveRtp = priority.indexOf('ordering') < priority.indexOf('rtp')
  const joint: JointGroup[] = []

  for (const g of groups) {
    if (!hasGroupDemands(g)) continue

    const members = rows.map((_, i) => i).filter((i) => rows[i].groupId === g.id)
    if (members.length === 0) continue

    const free = members.filter((i) => !rows[i].locked)
    const lockedSum = members
      .filter((i) => rows[i].locked)
      .reduce((a, i) => a + Math.max(0, Math.round(rows[i].weight)), 0)
    const currentSum =
      lockedSum + free.reduce((a, i) => a + Math.max(0, Math.round(rows[i].weight)), 0)

    if (free.length === 0) {
      if (g.prefChance !== undefined && Math.abs(currentSum / totalWeight - g.prefChance) > 1e-9) {
        notes.push(
          `Group "${g.name}": every member is locked, so its chance stays at ${(currentSum / totalWeight).toFixed(4)} instead of the preferred ${g.prefChance}.`,
        )
      }
      continue
    }

    let mass = g.prefChance !== undefined ? roundTo(g.prefChance * totalWeight, step) : currentSum
    const floor = lockedSum + free.length * step
    if (mass < floor) {
      notes.push(
        `Group "${g.name}": its share cannot go below one weight step per member plus its locked weight — raised to ${floor.toLocaleString('en-US')}.`,
      )
      mass = floor
    }
    // Free mass must sit on the step or no on-step split can reproduce it.
    const freeMass = roundTo(mass - lockedSum, step)

    // The chance is a hard rule: only the step's granularity may move it, and
    // even that is reported once it exceeds 0.0001%.
    if (g.prefChance !== undefined && mass >= floor) {
      const landed = (lockedSum + freeMass) / totalWeight
      if (Math.abs(landed - g.prefChance) > CHANCE_EPS + 1e-12) {
        notes.push(
          `Group "${g.name}": the weight step ×${step} cannot represent its chance ${g.prefChance} exactly — landed on ${landed.toFixed(8)}. Lower the weight step or adjust the total weight.`,
        )
      }
    }

    const base = free.map((i) => Math.max(0, Math.round(rows[i].weight)))
    let shares = largestRemainder(
      base.some((b) => b > 0) ? base : base.map(() => 1),
      freeMass,
      true,
      step,
    )
    const payouts = free.map((i) => rows[i].payout)
    const lockedContribution = members
      .filter((i) => rows[i].locked)
      .reduce((a, i) => a + rows[i].payout * Math.max(0, Math.round(rows[i].weight)), 0)

    if (g.prefRtp !== undefined) {
      const cont = tiltGroupRtp(payouts, shares, g.prefRtp, totalWeight, lockedContribution)
      shares = largestRemainder(cont, freeMass, true, step)
      shapeWithinGroup(
        payouts,
        shares,
        g.prefRtp * totalWeight - lockedContribution,
        step,
        orderAboveRtp,
        totalWeight,
      )

      const achieved = (lockedContribution + contribution(payouts, shares)) / totalWeight
      if (Math.abs(achieved - g.prefRtp) > VALUE_EPS) {
        notes.push(
          `Group "${g.name}": preferred weighted value ${g.prefRtp} is out of reach within 0.001 at its ${g.prefChance !== undefined ? 'preferred' : 'current'} mass — achieved ${achieved.toFixed(6)}. Change the group's chance (or its payout mix) to move further.`,
        )
      }
      free.forEach((i, k) => pinned.set(i, shares[k]))
    } else if (targets !== undefined) {
      joint.push({ g, free, payouts, shares, freeMass })
    } else {
      free.forEach((i, k) => pinned.set(i, shares[k]))
    }
  }

  if (joint.length > 0 && targets !== undefined) {
    // What these groups must contribute for the whole table to land on the
    // RTP target: everything else — locked rows, prefRtp-pinned rows, free
    // rows outside any pinned group — valued as it stands. Free rows are the
    // main solve's to steer afterwards; when none exist this is exact.
    const jointFree = new Set(joint.flatMap((p) => p.free))
    let cRest = 0
    rows.forEach((r, i) => {
      if (jointFree.has(i)) return
      const w = pinned.get(i) ?? Math.max(0, Math.round(r.weight))
      cRest += r.payout * w
    })
    const targetAbs = targets.rtp * totalWeight - cRest

    const tiltedShares = jointTiltShares(joint, targetAbs)
    joint.forEach((p, gi) => {
      const shares = largestRemainder(tiltedShares[gi], p.freeMass, true, step)
      // Each group's integer goal is its own slice of the joint solution.
      shapeWithinGroup(
        p.payouts,
        shares,
        contribution(p.payouts, tiltedShares[gi]),
        step,
        orderAboveRtp,
        totalWeight,
      )
      p.free.forEach((i, k) => pinned.set(i, shares[k]))
    })
  }

  // When the pins leave the main solve nothing to move, this plan carries the
  // whole distribution — so it also carries the report the solver would have
  // given, instead of the misleading "every row is locked".
  if (targets !== undefined && pinned.size > 0) {
    const anyFreeLeft = rows.some((r, i) => !r.locked && !pinned.has(i))
    if (!anyFreeLeft) {
      const achieved =
        rows.reduce(
          (a, r, i) => a + r.payout * (pinned.get(i) ?? Math.max(0, Math.round(r.weight))),
          0,
        ) / totalWeight
      if (Math.abs(achieved - targets.rtp) > 1e-6) {
        notes.push(
          `Every unlocked bucket sits in a locked or chance-pinned group — weights were distributed inside the groups, landing RTP at ${achieved.toFixed(6)} against the ${targets.rtp} target.`,
        )
      }
    }
  }

  return { pinned, notes }
}

/**
 * A member edit inside a total-locked group: the typed weight stands and the
 * group's other unlocked members absorb the difference, so the group total —
 * the thing the lock protects — never moves. Null when there is no other
 * unlocked member to absorb it, or the group cannot fund the request.
 *
 * The ripple is deliberately not snapped to the weight step: typed weights are
 * never snapped, and an on-step complement to an off-step edit cannot exist.
 */
export function rebalanceWithinGroup(
  rows: BucketRow[],
  uid: string,
  newWeight: number,
): number[] | null {
  const edited = rows.findIndex((r) => r.uid === uid)
  if (edited === -1 || !Number.isFinite(newWeight) || newWeight < 0) return null

  const groupId = rows[edited].groupId
  const out = rows.map((r) => Math.max(0, Math.round(r.weight)))
  const others = rows
    .map((_, i) => i)
    .filter((i) => i !== edited && rows[i].groupId === groupId && !rows[i].locked)
  if (others.length === 0) return null

  const groupTotal = rows.reduce(
    (a, r, i) => (r.groupId === groupId ? a + out[i] : a),
    0,
  )
  // Locked members stand; only the edited row and the unlocked rest share
  // what remains of the group total.
  const fixed = rows.reduce(
    (a, r, i) => (r.groupId === groupId && r.locked && i !== edited ? a + out[i] : a),
    0,
  )

  const wanted = Math.round(newWeight)
  const budget = groupTotal - fixed - wanted
  if (budget < 0) return null

  const alloc = largestRemainder(
    others.map((i) => out[i]).some((b) => b > 0) ? others.map((i) => out[i]) : others.map(() => 1),
    budget,
    false,
  )
  out[edited] = wanted
  others.forEach((i, k) => {
    out[i] = alloc[k]
  })
  return out
}
