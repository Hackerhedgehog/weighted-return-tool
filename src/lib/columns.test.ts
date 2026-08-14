import { describe, it, expect } from 'vitest'
import { COLUMNS, DEFAULT_WIDTHS, sortRows } from './columns'
import type { BucketRow, SortState } from './types'

describe('default column widths', () => {
  it('stay narrow enough to sit beside the chart on a wide screen', () => {
    // The table decides when the chart wraps below it. The budget grew with
    // One in and RTP Share — both hideable from the ⚙ column menu, and the
    // dock cells scroll horizontally rather than clipping when squeezed.
    const total = COLUMNS.reduce((a, c) => a + c.width, 0)
    expect(total).toBeLessThanOrEqual(1100)
  })

  it('still leaves the chance column wide enough to read', () => {
    expect(DEFAULT_WIDTHS.chance).toBeGreaterThanOrEqual(130)
  })

  it('mirrors every column into DEFAULT_WIDTHS', () => {
    expect(Object.keys(DEFAULT_WIDTHS)).toHaveLength(COLUMNS.length)
    for (const c of COLUMNS) expect(DEFAULT_WIDTHS[c.key]).toBe(c.width)
  })
})

describe('derived column sorting', () => {
  const row = (uid: string, payout: number, weight: number): BucketRow => ({
    uid,
    bucketId: Number(uid.slice(1)),
    payout,
    label: uid,
    weight,
    locked: false,
    groupId: 'g',
    weightId: '',
  })
  const rows = [row('r1', 10, 500), row('r2', 2, 100), row('r3', 5, 300)]
  const sorted = (key: SortState['key']) => sortRows(rows, { key, dir: 1 }, 900).map((r) => r.uid)

  it('One in sorts like chance (by weight)', () => {
    expect(sorted('oneIn')).toEqual(sorted('chance'))
  })

  it('RTP Share sorts like weighted value', () => {
    expect(sorted('rtpShare')).toEqual(sorted('weightedValue'))
  })
})
