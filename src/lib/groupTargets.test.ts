import { describe, it, expect } from 'vitest'
import type { BucketRow, GroupDef } from './types'
import { hasGroupDemands, planGroupTargets, rebalanceWithinGroup } from './groupTargets'

let uidCounter = 0
function row(partial: Partial<BucketRow> & Pick<BucketRow, 'payout' | 'weight' | 'groupId'>): BucketRow {
  uidCounter += 1
  return {
    uid: `t${uidCounter}`,
    bucketId: uidCounter,
    label: partial.label ?? `bucket-${uidCounter}`,
    locked: false,
    weightId: '',
    ...partial,
  }
}

const group = (id: string, extra: Partial<GroupDef> = {}): GroupDef => ({
  id,
  name: id,
  color: '#aabbcc',
  ...extra,
})

describe('hasGroupDemands', () => {
  it('is false for a plain group and true for each demand', () => {
    expect(hasGroupDemands(group('g'))).toBe(false)
    expect(hasGroupDemands(group('g', { totalLocked: true }))).toBe(true)
    expect(hasGroupDemands(group('g', { prefChance: 0.1 }))).toBe(true)
    expect(hasGroupDemands(group('g', { prefRtp: 0.1 }))).toBe(true)
  })
})

describe('planGroupTargets', () => {
  it('pins a totalLocked group at its current mass, preserving its shape', () => {
    const rows = [
      row({ payout: 0, weight: 700_000, groupId: 'zero' }),
      row({ payout: 10, weight: 200_000, groupId: 'bonus' }),
      row({ payout: 50, weight: 100_000, groupId: 'bonus' }),
    ]
    const plan = planGroupTargets(rows, [group('zero'), group('bonus', { totalLocked: true })], 1_000_000)
    expect(plan.notes).toEqual([])
    expect(plan.pinned.get(1)).toBe(200_000)
    expect(plan.pinned.get(2)).toBe(100_000)
    expect(plan.pinned.has(0)).toBe(false)
  })

  it('sets a prefChance group to that share of the total', () => {
    const rows = [
      row({ payout: 0, weight: 900_000, groupId: 'zero' }),
      row({ payout: 10, weight: 60_000, groupId: 'bonus' }),
      row({ payout: 50, weight: 40_000, groupId: 'bonus' }),
    ]
    const plan = planGroupTargets(rows, [group('zero'), group('bonus', { prefChance: 0.2 })], 1_000_000)
    const mass = (plan.pinned.get(1) ?? 0) + (plan.pinned.get(2) ?? 0)
    expect(mass).toBe(200_000)
    // Internal 60/40 shape survives the rescale.
    expect(plan.pinned.get(1)).toBe(120_000)
    expect(plan.pinned.get(2)).toBe(80_000)
  })

  it('keeps individually locked members out of the pin and their weight in the mass', () => {
    const rows = [
      row({ payout: 10, weight: 50_000, groupId: 'bonus', locked: true }),
      row({ payout: 50, weight: 50_000, groupId: 'bonus' }),
    ]
    const plan = planGroupTargets(rows, [group('bonus', { prefChance: 0.2 })], 1_000_000)
    expect(plan.pinned.has(0)).toBe(false)
    // 200k mass minus the 50k lock leaves 150k for the one free member.
    expect(plan.pinned.get(1)).toBe(150_000)
  })

  it('tilts a prefRtp group to the requested contribution at fixed mass', () => {
    const rows = [
      row({ payout: 2, weight: 50_000, groupId: 'wins' }),
      row({ payout: 100, weight: 50_000, groupId: 'wins' }),
    ]
    const total = 1_000_000
    // Current contribution: (2·50k + 100·50k)/1M = 5.1. Ask for far less.
    const plan = planGroupTargets(rows, [group('wins', { prefRtp: 1.0 })], total)
    const w2 = plan.pinned.get(0) ?? 0
    const w100 = plan.pinned.get(1) ?? 0
    expect(w2 + w100).toBe(100_000)
    const achieved = (2 * w2 + 100 * w100) / total
    expect(Math.abs(achieved - 1.0)).toBeLessThan(0.001)
  })

  it('notes an out-of-reach prefRtp instead of pretending', () => {
    const rows = [
      row({ payout: 2, weight: 50_000, groupId: 'wins' }),
      row({ payout: 3, weight: 50_000, groupId: 'wins' }),
    ]
    // Max contribution at this mass is 3·100k/1M = 0.3 — 2.0 is impossible.
    const plan = planGroupTargets(rows, [group('wins', { prefRtp: 2.0 })], 1_000_000)
    expect(plan.notes.some((n) => n.includes('out of reach'))).toBe(true)
  })

  it('raises a starved prefChance to one step per member and says so', () => {
    const rows = [
      row({ payout: 10, weight: 500, groupId: 'bonus' }),
      row({ payout: 50, weight: 500, groupId: 'bonus' }),
    ]
    const plan = planGroupTargets(rows, [group('bonus', { prefChance: 0.0000001 })], 1_000_000, 100)
    expect(plan.notes.some((n) => n.includes('cannot go below'))).toBe(true)
    const mass = (plan.pinned.get(0) ?? 0) + (plan.pinned.get(1) ?? 0)
    expect(mass).toBe(200)
  })

  it('keeps pinned masses on the weight step', () => {
    const rows = [
      row({ payout: 0, weight: 900_000, groupId: 'zero' }),
      row({ payout: 10, weight: 66_666, groupId: 'bonus' }),
      row({ payout: 50, weight: 33_334, groupId: 'bonus' }),
    ]
    const plan = planGroupTargets(rows, [group('bonus', { prefChance: 0.123456 })], 1_000_000, 100)
    for (const w of plan.pinned.values()) expect(w % 100).toBe(0)
  })

  it('ignores empty groups and groups without demands', () => {
    const rows = [row({ payout: 10, weight: 1000, groupId: 'a' })]
    const plan = planGroupTargets(rows, [group('a'), group('ghost', { prefChance: 0.5 })], 10_000)
    expect(plan.pinned.size).toBe(0)
    expect(plan.notes).toEqual([])
  })
})

describe('rebalanceWithinGroup', () => {
  const table = () => [
    row({ payout: 0, weight: 700, groupId: 'zero' }),
    row({ payout: 10, weight: 200, groupId: 'bonus' }),
    row({ payout: 50, weight: 100, groupId: 'bonus' }),
  ]

  it('moves the difference onto the other unlocked members', () => {
    const rows = table()
    const out = rebalanceWithinGroup(rows, rows[1].uid, 250)
    expect(out).not.toBeNull()
    expect(out![1]).toBe(250)
    expect(out![2]).toBe(50)
    expect(out![0]).toBe(700)
  })

  it('refuses when the edited member is the only unlocked one', () => {
    const rows = table()
    rows[2] = { ...rows[2], locked: true }
    expect(rebalanceWithinGroup(rows, rows[1].uid, 250)).toBeNull()
  })

  it('refuses a weight the group total cannot fund', () => {
    const rows = table()
    expect(rebalanceWithinGroup(rows, rows[1].uid, 301)).toBeNull()
  })

  it('lets one member take the whole free total, zeroing the rest', () => {
    const rows = table()
    const out = rebalanceWithinGroup(rows, rows[1].uid, 300)
    expect(out![1]).toBe(300)
    expect(out![2]).toBe(0)
  })

  it('refuses negatives and unknown rows', () => {
    const rows = table()
    expect(rebalanceWithinGroup(rows, rows[1].uid, -5)).toBeNull()
    expect(rebalanceWithinGroup(rows, 'nope', 100)).toBeNull()
  })
})
