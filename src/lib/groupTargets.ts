import type { BucketRow, GroupDef, WeightStep } from './types'
import { largestRemainder } from './distribute'

/**
 * Group-level constraints for Auto-Distribute, and the in-group rebalance a
 * total-locked group's member edits go through.
 *
 * A group can carry three optional demands: `totalLocked` (its mass stays
 * where it is), `prefChance` (its mass becomes that share of the total) and
 * `prefRtp` (its members are tilted so the group contributes that much RTP).
 * All three reduce to the same move — decide the group's weights *before* the
 * main solve and hand them to it as locked rows. Locks are the solver's rank-1
 * constraint and its RTP accounting already includes them, so the solver
 * steers the rest of the table around the pinned groups without learning
 * anything about groups at all.
 */

const TILT_LIMIT = 40
const BISECTION_STEPS = 200

export interface GroupPlan {
  /** Row index → weight to pin (as a locked row) for the main solve. */
  pinned: Map<number, number>
  notes: string[]
}

/** True when Auto-Distribute must decide this group's weights up front. */
export function hasGroupDemands(g: GroupDef): boolean {
  return g.totalLocked === true || g.prefChance !== undefined || g.prefRtp !== undefined
}

function roundTo(v: number, step: number): number {
  return Math.round(v / step) * step
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

  const contribution = (w: number[]): number =>
    (fixedContribution + idx.reduce((a, i) => a + payouts[i] * w[i], 0)) / totalWeight

  // Contribution rises with θ — positive θ shifts mass toward high payouts.
  let lo = -TILT_LIMIT
  let hi = TILT_LIMIT
  const goal = Math.min(Math.max(target, contribution(tilted(lo))), contribution(tilted(hi)))
  for (let k = 0; k < BISECTION_STEPS; k++) {
    const mid = (lo + hi) / 2
    if (contribution(tilted(mid)) < goal) lo = mid
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
 * otherwise — in proportion to their current weights, so hand-tuning inside
 * the group survives a re-solve. `prefRtp` then tilts that shape. Free mass is
 * kept on the weight step, one step per free member guaranteed, so the main
 * solve never inherits an off-step or starved group.
 */
export function planGroupTargets(
  rows: BucketRow[],
  groups: GroupDef[],
  totalWeight: number,
  step: WeightStep = 1,
): GroupPlan {
  const pinned = new Map<number, number>()
  const notes: string[] = []
  if (!(totalWeight > 0)) return { pinned, notes }

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

    const base = free.map((i) => Math.max(0, Math.round(rows[i].weight)))
    let shares = largestRemainder(
      base.some((b) => b > 0) ? base : base.map(() => 1),
      freeMass,
      true,
      step,
    )

    if (g.prefRtp !== undefined) {
      const payouts = free.map((i) => rows[i].payout)
      const lockedContribution = members
        .filter((i) => rows[i].locked)
        .reduce((a, i) => a + rows[i].payout * Math.max(0, Math.round(rows[i].weight)), 0)
      const cont = tiltGroupRtp(payouts, shares, g.prefRtp, totalWeight, lockedContribution)
      shares = largestRemainder(cont, freeMass, true, step)

      const achieved =
        (lockedContribution + free.reduce((a, i, k) => a + rows[i].payout * shares[k], 0)) /
        totalWeight
      if (Math.abs(achieved - g.prefRtp) > Math.max(1e-6, g.prefRtp * 0.005)) {
        notes.push(
          `Group "${g.name}": preferred RTP share ${g.prefRtp} is out of reach at its ${g.prefChance !== undefined ? 'preferred' : 'current'} mass — achieved ${achieved.toFixed(6)}. Change the group's chance (or its payout mix) to move further.`,
        )
      }
    }

    free.forEach((i, k) => pinned.set(i, shares[k]))
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
