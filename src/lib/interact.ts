import type { BucketRow, WeightStep } from './types'
import { largestRemainder } from './distribute'

/**
 * Direct-manipulation weight operations, shared by the chart's draggable bars
 * and the group handles. Both return a full weights array in row order —
 * always integers, locked rows always untouched.
 *
 * `scaleSubset` is the relative form: the subset is scaled to a new total and
 * every other unlocked row absorbs the difference, so the grand total is
 * invariant. Chance is weight / total, which makes Σchance == 1 hold for free.
 * With a step > 1, drags snap to step-sized parcels, and returns null when the
 * table's free weight cannot be partitioned on the step.
 *
 * `poolUids` confines the whole exchange: rows outside the pool are treated
 * exactly like locked rows, so the difference lands only on the pool's other
 * unlocked members and the pool's own total — not just the grand total — is
 * invariant. This is what a soft-locked group's bar drags go through.
 *
 * `setSubsetTotal` is the absolute form (weights mode with relativity off):
 * the subset is scaled and the rest of the table never moves, so the grand
 * total drifts by exactly the requested change. With a step, the subset snaps.
 */

interface Split {
  current: number[]
  inside: number[]
  outside: number[]
  lockedIn: number
  lockedOut: number
  grand: number
}

function splitRows(
  rows: BucketRow[],
  subsetUids: Iterable<string>,
  poolUids?: Iterable<string>,
): Split {
  const subset = new Set(subsetUids)
  const pool = poolUids === undefined ? null : new Set(poolUids)
  const current = rows.map((r) => Math.max(0, Math.round(r.weight)))
  const inside: number[] = []
  const outside: number[] = []
  let lockedIn = 0
  let lockedOut = 0

  rows.forEach((r, i) => {
    // Outside the pool is outside the exchange — indistinguishable from a
    // lock. Subset members are always part of the pool by construction, but
    // an errant caller's stray uid is safer frozen than moved.
    const frozen = r.locked || (pool !== null && !pool.has(r.uid))
    if (subset.has(r.uid)) {
      if (frozen) lockedIn += current[i]
      else inside.push(i)
    } else if (frozen) {
      lockedOut += current[i]
    } else {
      outside.push(i)
    }
  })

  const grand = current.reduce((a, b) => a + b, 0)
  return { current, inside, outside, lockedIn, lockedOut, grand }
}

/** Proportional integer split of `budget` over `idx`, equal when all-zero. */
function allocate(current: number[], idx: number[], budget: number, step: number): number[] {
  const base = idx.map((i) => current[i])
  const anyPositive = base.some((b) => b > 0)
  return largestRemainder(anyPositive ? base : base.map(() => 1), budget, false, step)
}

export function scaleSubset(
  rows: BucketRow[],
  subsetUids: Iterable<string>,
  newSubsetTotal: number,
  step: WeightStep = 1,
  poolUids?: Iterable<string>,
): number[] | null {
  const s = splitRows(rows, subsetUids, poolUids)
  const out = s.current.slice()

  // With no unlocked rows on one side, the grand-total invariant pins the
  // subset total exactly where it is — the drag has nowhere to move.
  if (s.inside.length === 0 || s.outside.length === 0) return out

  // The grand total is invariant, so both sides must land on the step at
  // once — impossible unless the table's free weight is itself on the step.
  if ((s.grand - s.lockedIn - s.lockedOut) % step !== 0) return null

  const lo = s.lockedIn
  const hi = s.grand - s.lockedOut
  const snapped = s.lockedIn + Math.round((newSubsetTotal - s.lockedIn) / step) * step
  const target = Math.min(Math.max(snapped, lo), hi)
  if (!Number.isFinite(target)) return out

  const insideAlloc = allocate(s.current, s.inside, target - s.lockedIn, step)
  const outsideAlloc = allocate(s.current, s.outside, s.grand - target - s.lockedOut, step)

  s.inside.forEach((i, k) => {
    out[i] = insideAlloc[k]
  })
  s.outside.forEach((i, k) => {
    out[i] = outsideAlloc[k]
  })
  return out
}

export function setSubsetTotal(
  rows: BucketRow[],
  subsetUids: Iterable<string>,
  newSubsetTotal: number,
  step: WeightStep = 1,
): number[] {
  const s = splitRows(rows, subsetUids)
  const out = s.current.slice()
  if (s.inside.length === 0) return out

  const snapped = s.lockedIn + Math.round((newSubsetTotal - s.lockedIn) / step) * step
  const target = Math.max(snapped, s.lockedIn)
  if (!Number.isFinite(target)) return out

  const insideAlloc = allocate(s.current, s.inside, target - s.lockedIn, step)
  s.inside.forEach((i, k) => {
    out[i] = insideAlloc[k]
  })
  return out
}
