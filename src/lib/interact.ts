import type { BucketRow } from './types'
import { largestRemainder } from './distribute'

/**
 * Direct-manipulation weight operations, shared by the chart's draggable bars
 * and the group handles. Both return a full weights array in row order —
 * always integers, locked rows always untouched.
 *
 * `scaleSubset` is the relative form: the subset is scaled to a new total and
 * every other unlocked row absorbs the difference, so the grand total is
 * invariant. Chance is weight / total, which makes Σchance == 1 hold for free.
 *
 * `setSubsetTotal` is the absolute form (weights mode with relativity off):
 * the subset is scaled and the rest of the table never moves, so the grand
 * total drifts by exactly the requested change.
 */

interface Split {
  current: number[]
  inside: number[]
  outside: number[]
  lockedIn: number
  lockedOut: number
  grand: number
}

function splitRows(rows: BucketRow[], subsetUids: Iterable<string>): Split {
  const subset = new Set(subsetUids)
  const current = rows.map((r) => Math.max(0, Math.round(r.weight)))
  const inside: number[] = []
  const outside: number[] = []
  let lockedIn = 0
  let lockedOut = 0

  rows.forEach((r, i) => {
    if (subset.has(r.uid)) {
      if (r.locked) lockedIn += current[i]
      else inside.push(i)
    } else if (r.locked) {
      lockedOut += current[i]
    } else {
      outside.push(i)
    }
  })

  const grand = current.reduce((a, b) => a + b, 0)
  return { current, inside, outside, lockedIn, lockedOut, grand }
}

/** Proportional integer split of `budget` over `idx`, equal when all-zero. */
function allocate(current: number[], idx: number[], budget: number): number[] {
  const base = idx.map((i) => current[i])
  const anyPositive = base.some((b) => b > 0)
  return largestRemainder(anyPositive ? base : base.map(() => 1), budget, false)
}

export function scaleSubset(
  rows: BucketRow[],
  subsetUids: Iterable<string>,
  newSubsetTotal: number,
): number[] {
  const s = splitRows(rows, subsetUids)
  const out = s.current.slice()

  // With no unlocked rows on one side, the grand-total invariant pins the
  // subset total exactly where it is — the drag has nowhere to move.
  if (s.inside.length === 0 || s.outside.length === 0) return out

  const lo = s.lockedIn
  const hi = s.grand - s.lockedOut
  const target = Math.min(Math.max(Math.round(newSubsetTotal), lo), hi)
  if (!Number.isFinite(target)) return out

  const insideAlloc = allocate(s.current, s.inside, target - s.lockedIn)
  const outsideAlloc = allocate(s.current, s.outside, s.grand - target - s.lockedOut)

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
): number[] {
  const s = splitRows(rows, subsetUids)
  const out = s.current.slice()
  if (s.inside.length === 0) return out

  const target = Math.max(Math.round(newSubsetTotal), s.lockedIn)
  if (!Number.isFinite(target)) return out

  const insideAlloc = allocate(s.current, s.inside, target - s.lockedIn)
  s.inside.forEach((i, k) => {
    out[i] = insideAlloc[k]
  })
  return out
}
