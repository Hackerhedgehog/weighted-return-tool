import type { BucketRow, SortState } from './types'
import { groupLockState, type GroupInfo, type Grouping, type LockState } from './groups'

/**
 * What the buckets table draws, worked out away from the table itself.
 *
 * Deliberately the same shape as `bars.ts`: collapse the groups the user has
 * asked for, then deal with whatever is left. Collapsing first is what keeps
 * the two composable — a bucket inside a collapsed group is gone before the
 * loose pass runs, so it can never appear twice.
 *
 * Sorting then happens over the *display units* rather than over buckets, so a
 * collapsed group is ranked by its own aggregate. That makes collapse work
 * under every sort, not only under Group sort.
 */

export interface GroupAggregate {
  /** Weight-weighted mean; the plain mean when the group holds no weight. */
  payout: number
  weight: number
  /** Share of the grand total's RTP, not of the group's own. */
  value: number
  chance: number
  count: number
  lock: LockState
}

export type TableRow =
  | { kind: 'bucket'; uid: string; row: BucketRow }
  | { kind: 'group'; uid: string; group: GroupInfo; members: BucketRow[]; agg: GroupAggregate }

function aggregate(
  rows: BucketRow[],
  members: BucketRow[],
  groupId: string,
  totalWeight: number,
): GroupAggregate {
  const weight = members.reduce((a, r) => a + r.weight, 0)
  const value = members.reduce((a, r) => a + r.payout * r.weight, 0)
  return {
    // The same rule the chart's collapsed bar uses, so the two views place a
    // group at the same payout. With no weight there is nothing to weight by.
    payout: weight > 0 ? value / weight : members.reduce((a, r) => a + r.payout, 0) / members.length,
    weight,
    value: totalWeight > 0 ? value / totalWeight : 0,
    chance: totalWeight > 0 ? weight / totalWeight : 0,
    count: members.length,
    lock: groupLockState(rows, groupId),
  }
}

function sortUnits(
  units: TableRow[],
  sort: SortState,
  grouping: Grouping,
  totalWeight: number,
): TableRow[] {
  const dir = sort.dir
  const payout = (u: TableRow) => (u.kind === 'group' ? u.agg.payout : u.row.payout)
  const weight = (u: TableRow) => (u.kind === 'group' ? u.agg.weight : u.row.weight)
  const value = (u: TableRow) =>
    u.kind === 'group'
      ? u.agg.value
      : totalWeight > 0
        ? (u.row.payout * u.row.weight) / totalWeight
        : 0
  // A group has no id of its own; its lowest member's is the one a reader
  // would look for it under.
  const id = (u: TableRow) =>
    u.kind === 'group' ? Math.min(...u.members.map((r) => r.bucketId)) : u.row.bucketId
  const text = (u: TableRow, key: 'label' | 'weightId') =>
    u.kind === 'group' ? u.group.name : u.row[key]
  const rank = (u: TableRow) =>
    u.kind === 'group'
      ? grouping.groups.findIndex((g) => g.id === u.group.id)
      : (grouping.rank.get(u.row.uid) ?? 0)
  const compare = (a: string, b: string) =>
    a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })

  return [...units].sort((a, b) => {
    switch (sort.key) {
      case 'group':
        return dir * (rank(a) - rank(b)) || payout(a) - payout(b) || id(a) - id(b)
      case 'label':
        return dir * compare(text(a, 'label'), text(b, 'label'))
      case 'weightId':
        return dir * compare(text(a, 'weightId'), text(b, 'weightId'))
      case 'payout':
        return dir * (payout(a) - payout(b))
      // One in is 1/chance and RTP Share is weighted value over a
      // row-independent constant — each sorts identically to its source.
      case 'weight':
      case 'chance':
      case 'oneIn':
        return dir * (weight(a) - weight(b))
      case 'weightedValue':
      case 'rtpShare':
        return dir * (value(a) - value(b))
      case 'id':
      default:
        return dir * (id(a) - id(b))
    }
  })
}

export function buildTableRows(
  rows: BucketRow[],
  grouping: Grouping,
  collapsed: string[],
  sort: SortState,
  totalWeight: number,
): TableRow[] {
  const hidden = new Set(collapsed)
  const byUid = new Map(rows.map((r) => [r.uid, r]))
  const units: TableRow[] = []

  for (const g of grouping.groups) {
    if (!hidden.has(g.id)) continue
    const members = g.uids.map((u) => byUid.get(u)).filter((r): r is BucketRow => r !== undefined)
    if (members.length === 0) continue
    units.push({
      kind: 'group',
      uid: `group:${g.id}`,
      group: g,
      members,
      agg: aggregate(rows, members, g.id, totalWeight),
    })
  }

  for (const r of rows) {
    const id = grouping.byUid.get(r.uid)?.id
    if (id !== undefined && hidden.has(id)) continue
    units.push({ kind: 'bucket', uid: r.uid, row: r })
  }

  return sortUnits(units, sort, grouping, totalWeight)
}
