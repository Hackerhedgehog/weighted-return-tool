import { describe, it, expect } from 'vitest'
import { buildBars } from './bars'
import { groupRows } from './groups'
import type { BucketRow } from './types'

/**
 * Four buckets in three detected groups: '0-1x' is a pure range → wins,
 * 'bonus3'/'bonus4' → bonus, '0x' pays nothing → the 0x group.
 */
const rows = (): BucketRow[] => [
  { uid: 'a', bucketId: 0, payout: 0, label: '0x', weight: 500_000, locked: false, groupId: 'zero', weightId: '' },
  { uid: 'b', bucketId: 1, payout: 0.6, label: '0-1x', weight: 300_000, locked: false, groupId: 'wins', weightId: '' },
  { uid: 'c', bucketId: 2, payout: 8, label: 'bonus3', weight: 150_000, locked: false, groupId: 'bonus', weightId: '' },
  { uid: 'd', bucketId: 3, payout: 100, label: 'bonus4', weight: 50_000, locked: false, groupId: 'bonus', weightId: '' },
]

const TOTAL = 1_000_000

const build = (rs: BucketRow[], opts: Partial<Parameters<typeof buildBars>[3]> = {}) =>
  buildBars(rs, groupRows(rs), rs.reduce((a, r) => a + r.weight, 0), {
    aggregate: false,
    groupBars: [],
    logX: false,
    ...opts,
  })

describe('buildBars — bucket bars', () => {
  it('makes one bar per bucket, ascending by payout', () => {
    const { bars, droppedZero } = build(rows())
    expect(bars.map((b) => b.payout)).toEqual([0, 0.6, 8, 100])
    expect(bars.every((b) => b.kind === 'buckets')).toBe(true)
    expect(droppedZero).toBe(0)
  })

  it("reports each bar's weight and its chance of the grand total", () => {
    const { bars } = build(rows())
    expect(bars.map((b) => b.weight)).toEqual([500_000, 300_000, 150_000, 50_000])
    expect(bars[3].chance).toBeCloseTo(0.05, 12)
  })

  it('merges equal payouts into one bar when aggregating', () => {
    const rs = rows()
    rs.push({ uid: 'e', bucketId: 4, payout: 8, label: 'bonus7', weight: 100_000, locked: false, groupId: 'bonus', weightId: '' })
    const { bars } = build(rs, { aggregate: true })
    const at8 = bars.find((b) => b.payout === 8)!
    expect(at8.uids).toEqual(['c', 'e'])
    expect(at8.weight).toBe(250_000)
  })

  it('splits an aggregated bar into one segment per group, in rank order', () => {
    const rs: BucketRow[] = [
      { uid: 'x', bucketId: 0, payout: 5, label: 'hp-fullscreen', weight: 100, locked: false, groupId: 'other', weightId: '' },
      { uid: 'y', bucketId: 1, payout: 5, label: 'bonus9', weight: 300, locked: false, groupId: 'bonus', weightId: '' },
    ]
    const { bars } = build(rs, { aggregate: true })
    expect(bars).toHaveLength(1)
    expect(bars[0].segments.map((s) => s.weight)).toEqual([300, 100])
  })

  it('marks a bar locked only when every bucket in it is locked', () => {
    const rs = rows().map((r) => (r.uid === 'a' ? { ...r, locked: true } : r))
    const { bars } = build(rs)
    expect(bars[0].allLocked).toBe(true)
    expect(bars[1].allLocked).toBe(false)
  })

  it('drops zero-payout bars under a log payout axis and counts them', () => {
    const { bars, droppedZero } = build(rows(), { logX: true })
    expect(bars.map((b) => b.payout)).toEqual([0.6, 8, 100])
    expect(droppedZero).toBe(1)
  })
})

describe('buildBars — collapsed groups', () => {
  it("replaces a group's buckets with a single bar", () => {
    const { bars } = build(rows(), { groupBars: ['bonus'] })
    expect(bars).toHaveLength(3)
    const bonus = bars.find((b) => b.kind === 'group')!
    expect(bonus.name).toBe('bonus')
    expect(bonus.uids).toEqual(['c', 'd'])
    expect(bonus.weight).toBe(200_000)
    // one solid group-colored segment, never a stack
    expect(bonus.segments).toHaveLength(1)
  })

  it("places a group bar at its weight-weighted mean payout", () => {
    const { bars } = build(rows(), { groupBars: ['bonus'] })
    const bonus = bars.find((b) => b.kind === 'group')!
    // (8 × 150,000 + 100 × 50,000) / 200,000 = 31
    expect(bonus.payout).toBeCloseTo(31, 9)
    expect(bonus.payoutRange).toEqual([8, 100])
  })

  it("falls back to the plain mean payout when the group has no weight", () => {
    const rs = rows().map((r) => (r.groupId === 'bonus' ? { ...r, weight: 0 } : r))
    const { bars } = build(rs, { groupBars: ['bonus'] })
    const bonus = bars.find((b) => b.kind === 'group')!
    expect(bonus.payout).toBeCloseTo(54, 9) // (8 + 100) / 2
  })

  it("sorts a group bar among the loose bars by its placement", () => {
    const { bars } = build(rows(), { groupBars: ['bonus'] })
    expect(bars.map((b) => b.payout)).toEqual([0, 0.6, 31])
  })

  it('leaves other groups untouched and still aggregates them by payout', () => {
    const rs = rows()
    rs.push({ uid: 'e', bucketId: 4, payout: 0.6, label: '0-1x', weight: 100_000, locked: false, groupId: 'wins', weightId: '' })
    const { bars } = build(rs, { aggregate: true, groupBars: ['bonus'] })
    expect(bars.filter((b) => b.kind === 'group')).toHaveLength(1)
    const wins = bars.find((b) => b.payout === 0.6)!
    expect(wins.kind).toBe('buckets')
    expect(wins.weight).toBe(400_000)
  })

  it('drops an all-zero collapsed group under a log axis', () => {
    const { bars, droppedZero } = build(rows(), { groupBars: ['zero'], logX: true })
    expect(bars.every((b) => b.payout > 0)).toBe(true)
    expect(droppedZero).toBe(1)
  })

  it("marks a collapsed group locked only when every member is locked", () => {
    const all = rows().map((r) => (r.groupId === 'bonus' ? { ...r, locked: true } : r))
    expect(build(all, { groupBars: ['bonus'] }).bars.find((b) => b.kind === 'group')!.allLocked).toBe(true)
    const some = rows().map((r) => (r.uid === 'c' ? { ...r, locked: true } : r))
    expect(build(some, { groupBars: ['bonus'] }).bars.find((b) => b.kind === 'group')!.allLocked).toBe(false)
  })

  it('collapses two groups at once, leaving the rest untouched', () => {
    const { bars } = build(rows(), { groupBars: ['bonus', 'zero'] })
    // the wins bucket stays loose; bonus and zero each become one bar
    expect(bars).toHaveLength(3)
    expect(bars.filter((b) => b.kind === 'group')).toHaveLength(2)
    const loose = bars.find((b) => b.kind === 'buckets')!
    expect(loose.payout).toBe(0.6)
    expect(loose.uids).toEqual(['b'])
  })

  it('keeps a group bar ahead of a loose bar tied on payout, by push order', () => {
    // Group bars are pushed before the loose pass runs, and the final sort is
    // stable — so a tie is decided by that order, not by an explicit tiebreak.
    const rs: BucketRow[] = [
      { uid: 'x', bucketId: 0, payout: 5, label: 'other-item', weight: 100, locked: false, groupId: 'other', weightId: '' },
      { uid: 'y', bucketId: 1, payout: 5, label: 'bonus9', weight: 100, locked: false, groupId: 'bonus', weightId: '' },
      { uid: 'z', bucketId: 2, payout: 5, label: 'bonus10', weight: 300, locked: false, groupId: 'bonus', weightId: '' },
    ]
    const { bars } = build(rs, { groupBars: ['bonus'] })
    expect(bars.map((b) => b.payout)).toEqual([5, 5])
    expect(bars.map((b) => b.kind)).toEqual(['group', 'buckets'])
    expect(bars[1].uids).toEqual(['x'])
  })

  it('ignores a group id that no longer exists', () => {
    const { bars } = build(rows(), { groupBars: ['gone'] })
    expect(bars).toHaveLength(4)
    expect(bars.every((b) => b.kind === 'buckets')).toBe(true)
  })

  it('reports chances against the grand total, not the group', () => {
    const { bars } = build(rows(), { groupBars: ['bonus'] })
    const bonus = bars.find((b) => b.kind === 'group')!
    expect(bonus.chance).toBeCloseTo(200_000 / TOTAL, 12)
  })
})
