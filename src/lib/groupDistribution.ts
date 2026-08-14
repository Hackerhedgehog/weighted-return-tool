import type { BucketRow } from './types'
import type { Grouping } from './groups'

/**
 * The Group Distribution table's rows: per-group chance, payout, RTP share
 * and spread, computed away from the component so they can be tested directly.
 */
export interface GroupDistRow {
  id: string
  name: string
  color: string
  count: number
  /** Fraction of total weight; 0 when the total is not positive. */
  chance: number
  /** 1 / chance; null when the group holds no weight. */
  oneIn: number | null
  /** Weight-weighted mean payout; the plain mean when the group is weightless. */
  payout: number
  /** Σ(p·w) / totalWeight — the group's slice of RTP in absolute terms. */
  weightedValue: number
  /** weightedValue / table RTP; null when the table returns nothing. */
  rtpShare: number | null
  /** Within-group weighted payout STD — the group's own spread, given a hit in it. */
  std: number
}

export const GROUP_DIST_COLUMNS = [
  { key: 'chance', label: 'Chance %' },
  { key: 'oneIn', label: 'One in' },
  { key: 'payout', label: 'Payout' },
  { key: 'weightedValue', label: 'Weighted Value' },
  { key: 'rtpShare', label: 'RTP Share' },
  { key: 'std', label: 'STD' },
] as const

export function groupDistribution(
  rows: BucketRow[],
  grouping: Grouping,
  totalWeight: number,
): GroupDistRow[] {
  const byUid = new Map(rows.map((r) => [r.uid, r]))
  const tableRtp =
    totalWeight > 0 ? rows.reduce((a, r) => a + (r.payout * r.weight) / totalWeight, 0) : 0

  return grouping.groups.map((g) => {
    const members = g.uids.map((u) => byUid.get(u)).filter((r): r is BucketRow => r !== undefined)
    const w = members.reduce((a, r) => a + r.weight, 0)
    const pw = members.reduce((a, r) => a + r.payout * r.weight, 0)
    const p2w = members.reduce((a, r) => a + r.payout * r.payout * r.weight, 0)
    const chance = totalWeight > 0 ? w / totalWeight : 0
    // Same placement rule as tableRows.ts aggregates and the chart's group bars.
    const payout =
      w > 0 ? pw / w : members.reduce((a, r) => a + r.payout, 0) / Math.max(1, members.length)
    const mean = w > 0 ? pw / w : 0
    const weightedValue = totalWeight > 0 ? pw / totalWeight : 0
    return {
      id: g.id,
      name: g.name,
      color: g.color,
      count: members.length,
      chance,
      oneIn: chance > 0 ? 1 / chance : null,
      payout,
      weightedValue,
      rtpShare: tableRtp > 0 ? weightedValue / tableRtp : null,
      std: w > 0 ? Math.sqrt(Math.max(0, p2w / w - mean * mean)) : 0,
    }
  })
}
