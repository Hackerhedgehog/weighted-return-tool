import { describe, it, expect } from 'vitest'
import type { BucketRow } from './types'
import { groupRows } from './groups'

let n = 0
const row = (payout: number, label: string): BucketRow => ({
  uid: `u${(n += 1)}`,
  bucketId: n,
  payout,
  label,
  weight: 100,
  locked: false,
})

/** Group id of a single row inside a table. */
const idOf = (rows: BucketRow[], target: BucketRow): string => {
  const g = groupRows(rows).byUid.get(target.uid)
  if (!g) throw new Error(`row ${target.label} was not grouped`)
  return g.id
}

describe('groupRows', () => {
  it('puts zero-payout buckets in the 0x group ahead of any name rule', () => {
    const tease = row(0, 'joker2-tease')
    const j3 = row(20, 'joker3-stacks')
    const j4 = row(200, 'joker4-stacks')
    const bonusTease = row(0, 'bonus1-tease')
    const rows = [tease, j3, j4, bonusTease]

    expect(idOf(rows, tease)).toBe('zero')
    expect(idOf(rows, bonusTease)).toBe('zero')
    expect(idOf(rows, j3)).toBe(idOf(rows, j4))
    expect(idOf(rows, j3)).not.toBe('zero')
  })

  it('groups labels containing "bonus", case-insensitively', () => {
    const a = row(50.16, 'bonus5')
    const b = row(2, 'bonuspaid-1-2x')
    const c = row(10, 'Mega BONUS round')
    const rows = [a, b, c]

    expect(idOf(rows, a)).toBe('bonus')
    expect(idOf(rows, b)).toBe('bonus')
    expect(idOf(rows, c)).toBe('bonus')
  })

  it('groups pure win-range labels together', () => {
    const a = row(0.6, '0-1x')
    const b = row(11.93, '8-16x')
    const c = row(650.75, '512-1024x')
    const d = row(1.2, '0.5-1.5x')
    const rows = [a, b, c, d]

    for (const r of rows) expect(idOf(rows, r)).toBe('wins')
  })

  it('groups labels sharing an alpha+digits stem, needing at least two members', () => {
    const j5 = row(1000, 'joker5-maxwin')
    const j4 = row(200, 'joker4-stacks')
    const j3 = row(20, 'JOKER3-stacks')
    const d3 = row(30, 'diamond3')
    const d4 = row(60, 'diamond4')
    const lone = row(40, 'crown7')
    const rows = [j5, j4, j3, d3, d4, lone]

    expect(idOf(rows, j5)).toBe('stem:joker')
    expect(idOf(rows, j4)).toBe('stem:joker')
    expect(idOf(rows, j3)).toBe('stem:joker')
    expect(idOf(rows, d3)).toBe('stem:diamond')
    expect(idOf(rows, d4)).toBe('stem:diamond')
    // a stem with a single member is no group at all
    expect(idOf(rows, lone)).toBe('other')
  })

  it('sends everything unmatched to the other group', () => {
    const a = row(200, 'hp-fullscreen')
    const b = row(0.33, 'green-two-only')
    const rows = [a, b]

    expect(idOf(rows, a)).toBe('other')
    expect(idOf(rows, b)).toBe('other')
  })

  it('orders groups wins, bonus, stems A→Z, zero, other', () => {
    const rows = [
      row(200, 'hp-fullscreen'),
      row(0, '0x'),
      row(30, 'zebra1'),
      row(40, 'zebra2'),
      row(1000, 'joker5-maxwin'),
      row(200, 'joker4-stacks'),
      row(50.16, 'bonus5'),
      row(0.6, '0-1x'),
    ]

    const ids = groupRows(rows).groups.map((g) => g.id)
    expect(ids).toEqual(['wins', 'bonus', 'stem:joker', 'stem:zebra', 'zero', 'other'])
  })

  it('omits empty groups', () => {
    const rows = [row(0.6, '0-1x'), row(11.93, '8-16x')]
    expect(groupRows(rows).groups.map((g) => g.id)).toEqual(['wins'])
  })

  it('gives every group a distinct color and a consistent rank map', () => {
    const rows = [
      row(0, '0x'),
      row(0.6, '0-1x'),
      row(50.16, 'bonus5'),
      row(1000, 'joker5-maxwin'),
      row(200, 'joker4-stacks'),
      row(200, 'hp-fullscreen'),
    ]
    const { groups, byUid, rank } = groupRows(rows)

    const colors = groups.map((g) => g.color)
    expect(new Set(colors).size).toBe(groups.length)
    for (const c of colors) expect(c).toBeTruthy()

    for (const r of rows) {
      const g = byUid.get(r.uid)!
      expect(groups[rank.get(r.uid)!]).toBe(g)
      expect(g.uids).toContain(r.uid)
    }
  })

  it('handles the full real engine table the way the brief describes', () => {
    const table = [
      row(1000, 'joker5-maxwin'),
      row(200, 'joker4-stacks'),
      row(20, 'joker3-stacks'),
      row(0, 'joker2-tease'),
      row(200, 'hp-fullscreen'),
      row(50.16, 'bonus5'),
      row(10.13, 'bonus4'),
      row(2.12, 'bonus3'),
      row(2, 'bonuspaid-1-2x'),
      row(0, 'bonus-silent-tease'),
      row(0, '0x'),
      row(0.33, 'green-two-only'),
      row(0.6, '0-1x'),
      row(41.38, '32-64x'),
    ]
    const { byUid } = groupRows(table)
    const got = table.map((r) => byUid.get(r.uid)!.id)

    expect(got).toEqual([
      'stem:joker',
      'stem:joker',
      'stem:joker',
      'zero',
      'other',
      'bonus',
      'bonus',
      'bonus',
      'bonus',
      'zero',
      'zero',
      'other',
      'wins',
      'wins',
    ])
  })
})
