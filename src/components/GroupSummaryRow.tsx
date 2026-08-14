import type { TableRow } from '../lib/tableRows'
import type { Column } from '../lib/columns'
import { fmtDecimal, fmtPayout, fmtPct, fmtWeight } from '../lib/format'
import { rowTint } from '../lib/palette'
import { GridCell, LockCell, type CellNavProps } from './cells'

interface GroupSummaryRowProps {
  unit: Extract<TableRow, { kind: 'group' }>
  rowIdx: number
  /** The columns the table is rendering, in order — cell indices are relative to this. */
  visible: Column[]
  /** Table RTP, for the group's RTP Share cell. */
  rtp: number
  cellProps: (rowIdx: number, colIdx: number) => CellNavProps
  lockSelected: boolean
  onExpand: () => void
  onToggleLock: () => void
  onSelectLock: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
}

/**
 * One collapsed bucket group, as a single grid row.
 *
 * Weights, weighted value and chance are sums, so the columns still foot to
 * the totals row; payout is the weight-weighted mean, which is the same figure
 * the distribution chart puts a collapsed group bar at. Every cell is
 * read-only — an aggregate has no single row to write back to — except the
 * lock, which sets every member at once.
 */
export function GroupSummaryRow({
  unit,
  rowIdx,
  visible,
  rtp,
  cellProps,
  lockSelected,
  onExpand,
  onToggleLock,
  onSelectLock,
  onKeyDown,
}: GroupSummaryRowProps) {
  const { group, agg } = unit

  const cell = (c: Column, ci: number) => {
    switch (c.key) {
      case 'lock':
        return (
          <td key={c.key} className="col-lock">
            <LockCell
              state={agg.lock}
              selected={lockSelected}
              onToggle={onToggleLock}
              onSelect={onSelectLock}
              onKeyDown={onKeyDown}
            />
          </td>
        )
      case 'group':
        return (
          <td key={c.key} className="col-group">
            {/* The visible text is just the group name, which collides with the
                chip of the same name; the label disambiguates them and still
                carries the visible text, as WCAG's label-in-name rule wants. */}
            <button
              type="button"
              className="group-expander"
              style={{ color: group.color }}
              aria-label={`Show ${group.name}'s buckets`}
              title={`Show ${group.name}'s buckets`}
              onClick={onExpand}
            >
              <span aria-hidden="true">▸</span>
              {group.name}
            </button>
          </td>
        )
      case 'id':
        return (
          <td key={c.key} className="col-id">
            <GridCell {...cellProps(rowIdx, ci)} display="—" raw="" numeric editable={false} />
          </td>
        )
      case 'weightId':
        return (
          <td key={c.key} className="col-weightId">
            <GridCell
              {...cellProps(rowIdx, ci)}
              display="—"
              raw=""
              numeric={false}
              editable={false}
            />
          </td>
        )
      case 'payout':
        return (
          <td key={c.key} className="col-payout">
            <GridCell
              {...cellProps(rowIdx, ci)}
              display={fmtPayout(agg.payout)}
              raw=""
              numeric
              editable={false}
              title="Weight-weighted mean payout across the group"
            />
          </td>
        )
      case 'label':
        return (
          <td key={c.key} className="col-label">
            <GridCell
              {...cellProps(rowIdx, ci)}
              display={`${agg.count} bucket${agg.count === 1 ? '' : 's'}`}
              raw=""
              numeric={false}
              editable={false}
            />
          </td>
        )
      case 'weight':
        return (
          <td key={c.key} className="col-weight">
            <GridCell
              {...cellProps(rowIdx, ci)}
              display={fmtWeight(agg.weight)}
              raw=""
              numeric
              editable={false}
            />
          </td>
        )
      case 'weightedValue':
        return (
          <td key={c.key} className="col-weightedValue">
            <GridCell
              {...cellProps(rowIdx, ci)}
              display={fmtDecimal(agg.value)}
              raw=""
              numeric
              editable={false}
            />
          </td>
        )
      case 'chance':
        return (
          <td key={c.key} className="col-chance">
            <GridCell
              {...cellProps(rowIdx, ci)}
              display={fmtDecimal(agg.chance)}
              raw=""
              numeric
              editable={false}
            />
          </td>
        )
      case 'oneIn':
        return (
          <td key={c.key} className="col-oneIn">
            <GridCell
              {...cellProps(rowIdx, ci)}
              display={agg.chance > 0 ? `1/${fmtDecimal(1 / agg.chance, 2)}` : '—'}
              raw=""
              numeric
              editable={false}
            />
          </td>
        )
      case 'rtpShare':
        return (
          <td key={c.key} className="col-rtpShare">
            <GridCell
              {...cellProps(rowIdx, ci)}
              display={rtp > 0 ? fmtPct(agg.value / rtp, 2) : '—'}
              raw=""
              numeric
              editable={false}
            />
          </td>
        )
      default:
        return null
    }
  }

  return (
    <tr
      className="grid-row group-summary"
      style={{ background: rowTint(group.color, agg.lock === 'all') }}
    >
      {visible.map((c, ci) => cell(c, ci))}
    </tr>
  )
}
