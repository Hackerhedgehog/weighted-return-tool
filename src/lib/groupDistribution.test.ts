import { describe, expect, it } from 'vitest'
import { groupDistribution } from './groupDistribution'
import { buildGrouping } from './groups'
import type { BucketRow, GroupDef } from './types'

const row = (uid: string, payout: number, weight: number, groupId: string): BucketRow => ({
  uid,
  bucketId: 0,
  payout,
  label: uid,
  weight,
  locked: false,
  groupId,
  weightId: '',
})

const groups: GroupDef[] = [
  { id: 'a', name: 'A', color: '#aabbcc' },
  { id: 'z', name: '0x', color: '#ccddee' },
]

describe('groupDistribution', () => {
  const rows = [row('r1', 10, 100, 'a'), row('r2', 2, 300, 'a'), row('r3', 0, 600, 'z')]
  const grouping = buildGrouping(rows, groups)
  const out = groupDistribution(rows, grouping, 1000)
  const a = out.find((g) => g.id === 'a')!
  const z = out.find((g) => g.id === 'z')!

  it('computes chance and oneIn', () => {
    expect(a.chance).toBeCloseTo(0.4, 12)
    expect(a.oneIn).toBeCloseTo(2.5, 12)
  })

  it('computes weight-weighted payout', () => {
    // (10·100 + 2·300) / 400 = 4
    expect(a.payout).toBeCloseTo(4, 12)
  })

  it('computes weighted value and rtp share', () => {
    // Σp·w/total = 1600/1000 = 1.6; table RTP is also 1.6 → share 1
    expect(a.weightedValue).toBeCloseTo(1.6, 12)
    expect(a.rtpShare).toBeCloseTo(1, 12)
    expect(z.rtpShare).toBeCloseTo(0, 12)
  })

  it('computes within-group weighted payout STD', () => {
    // E[p²] = (100·100 + 4·300)/400 = 28; mean 4 → var 12
    expect(a.std).toBeCloseTo(Math.sqrt(12), 12)
    expect(z.std).toBe(0)
  })

  it('handles zero total weight', () => {
    const empty = groupDistribution(
      rows.map((r) => ({ ...r, weight: 0 })),
      grouping,
      0,
    )
    const ga = empty.find((g) => g.id === 'a')!
    expect(ga.chance).toBe(0)
    expect(ga.oneIn).toBeNull()
    expect(ga.rtpShare).toBeNull()
    expect(ga.payout).toBeCloseTo(6, 12) // plain mean of 10 and 2
  })
})
