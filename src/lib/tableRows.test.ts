import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseTsv } from './parse'
import { buildGrouping, seedGroups } from './groups'
import { buildTableRows } from './tableRows'
import type { SortState } from './types'

const parsed = parseTsv(readFileSync('example-output-data.tsv', 'utf8')).rows
const seeded = seedGroups(parsed)
const rows = seeded.rows
const grouping = buildGrouping(rows, seeded.groups)
const T = rows.reduce((a, r) => a + r.weight, 0)
const byId: SortState = { key: 'id', dir: 1 }

const groupIdOf = (name: string) => grouping.groups.find((g) => g.name === name)!.id

describe('buildTableRows', () => {
  it('leaves every bucket loose when nothing is collapsed', () => {
    const out = buildTableRows(rows, grouping, [], byId, T)
    expect(out).toHaveLength(rows.length)
    expect(out.every((u) => u.kind === 'bucket')).toBe(true)
  })

  it('replaces a collapsed group with one row carrying its member sums', () => {
    const id = groupIdOf('bonus')
    const members = rows.filter((r) => r.groupId === id)
    const out = buildTableRows(rows, grouping, [id], byId, T)

    expect(out).toHaveLength(rows.length - members.length + 1)
    const unit = out.find((u) => u.kind === 'group')!
    if (unit.kind !== 'group') throw new Error('expected a group row')

    expect(unit.agg.count).toBe(members.length)
    expect(unit.agg.weight).toBe(members.reduce((a, r) => a + r.weight, 0))
    expect(unit.agg.chance).toBeCloseTo(unit.agg.weight / T, 12)
    expect(unit.agg.value).toBeCloseTo(
      members.reduce((a, r) => a + r.payout * r.weight, 0) / T,
      12,
    )
    expect(unit.agg.payout).toBeCloseTo(
      members.reduce((a, r) => a + r.payout * r.weight, 0) / unit.agg.weight,
      9,
    )
  })

  it('falls back to the plain mean payout when a group holds no weight', () => {
    const id = groupIdOf('bonus')
    const zeroed = rows.map((r) => (r.groupId === id ? { ...r, weight: 0 } : r))
    const members = zeroed.filter((r) => r.groupId === id)
    const out = buildTableRows(zeroed, buildGrouping(zeroed, seeded.groups), [id], byId, T)
    const unit = out.find((u) => u.kind === 'group')!
    if (unit.kind !== 'group') throw new Error('expected a group row')
    expect(unit.agg.payout).toBeCloseTo(
      members.reduce((a, r) => a + r.payout, 0) / members.length,
      9,
    )
  })

  it('sorts a collapsed group by its aggregate, alongside the loose rows', () => {
    const id = groupIdOf('bonus')
    const out = buildTableRows(rows, grouping, [id], { key: 'weight', dir: -1 }, T)
    const weights = out.map((u) => (u.kind === 'group' ? u.agg.weight : u.row.weight))
    expect(weights).toEqual([...weights].sort((a, b) => b - a))
  })

  it('leaves the uncollapsed remainder in the order it would have had', () => {
    const id = groupIdOf('bonus')
    const loose = buildTableRows(rows, grouping, [id], byId, T)
      .filter((u) => u.kind === 'bucket')
      .map((u) => (u.kind === 'bucket' ? u.row.uid : ''))
    const all = buildTableRows(rows, grouping, [], byId, T).map((u) =>
      u.kind === 'bucket' ? u.row.uid : '',
    )
    expect(loose).toEqual(all.filter((uid) => loose.includes(uid)))
  })

  it('reports the group lock state', () => {
    const id = groupIdOf('bonus')
    const none = buildTableRows(rows, grouping, [id], byId, T).find((u) => u.kind === 'group')!
    if (none.kind !== 'group') throw new Error('expected a group row')
    expect(none.agg.lock).toBe('none')

    const some = rows.map((r) => (r.groupId === id && r.bucketId === 5 ? { ...r, locked: true } : r))
    const partial = buildTableRows(some, buildGrouping(some, seeded.groups), [id], byId, T).find(
      (u) => u.kind === 'group',
    )!
    if (partial.kind !== 'group') throw new Error('expected a group row')
    expect(partial.agg.lock).toBe('some')

    const every = rows.map((r) => (r.groupId === id ? { ...r, locked: true } : r))
    const all = buildTableRows(every, buildGrouping(every, seeded.groups), [id], byId, T).find(
      (u) => u.kind === 'group',
    )!
    if (all.kind !== 'group') throw new Error('expected a group row')
    expect(all.agg.lock).toBe('all')
  })

  it('ignores a collapsed id no group answers to', () => {
    const out = buildTableRows(rows, grouping, ['nonesuch'], byId, T)
    expect(out).toHaveLength(rows.length)
  })
})
