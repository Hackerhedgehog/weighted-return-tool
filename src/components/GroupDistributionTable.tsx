import { useMemo } from 'react'
import type { BucketRow } from '../lib/types'
import type { Grouping } from '../lib/groups'
import { GROUP_DIST_COLUMNS, groupDistribution, type GroupDistRow } from '../lib/groupDistribution'
import { fmtDecimal, fmtPayout, fmtPct } from '../lib/format'

interface GroupDistributionTableProps {
  rows: BucketRow[]
  grouping: Grouping
  totalWeight: number
  /** Column keys the gear menu has switched off. */
  hidden: string[]
}

/**
 * One read-only row per bucket group — the table equivalent of collapsing
 * every group, with the derived columns (One in, RTP Share, STD) the bucket
 * grid has no room for. All the arithmetic lives in groupDistribution.ts.
 */
export function GroupDistributionTable({
  rows,
  grouping,
  totalWeight,
  hidden,
}: GroupDistributionTableProps) {
  const dist = useMemo(
    () => groupDistribution(rows, grouping, totalWeight),
    [rows, grouping, totalWeight],
  )
  const off = new Set(hidden)
  const cols = GROUP_DIST_COLUMNS.filter((c) => !off.has(c.key))

  const cell = (g: GroupDistRow, key: string) => {
    switch (key) {
      case 'chance':
        return (
          <td key={key} className="num" title={fmtPct(g.chance, 10)}>
            {fmtPct(g.chance, 2)}
          </td>
        )
      case 'oneIn':
        return (
          <td key={key} className="num">
            {g.oneIn === null ? '—' : `1/${fmtDecimal(g.oneIn, 2)}`}
          </td>
        )
      case 'payout':
        return (
          <td key={key} className="num">
            ×{fmtPayout(Math.round(g.payout * 100) / 100)}
          </td>
        )
      case 'weightedValue':
        return (
          <td key={key} className="num">
            {fmtDecimal(g.weightedValue, 6)}
          </td>
        )
      case 'rtpShare':
        return (
          <td key={key} className="num">
            {g.rtpShare === null ? '—' : fmtPct(g.rtpShare, 2)}
          </td>
        )
      case 'std':
        return (
          <td key={key} className="num">
            {fmtDecimal(g.std, 2)}
          </td>
        )
      default:
        return null
    }
  }

  return (
    <table className="gdist-table">
      <thead>
        <tr>
          <th>Group</th>
          {cols.map((c) => (
            <th key={c.key} className="num">
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {dist.map((g) => (
          <tr key={g.id}>
            <td>
              <span className="gdist-dot" style={{ background: g.color }} aria-hidden="true" />
              <span style={{ color: g.color }}>{g.name}</span>
              <span className="gdist-count"> · {g.count}</span>
            </td>
            {cols.map((c) => cell(g, c.key))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
