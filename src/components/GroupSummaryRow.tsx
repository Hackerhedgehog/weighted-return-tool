import type { TableRow } from '../lib/tableRows'
import { fmtDecimal, fmtPayout, fmtWeight } from '../lib/format'
import { rowTint } from '../lib/palette'
import { GridCell, LockCell, type CellNavProps } from './cells'

interface GroupSummaryRowProps {
  unit: Extract<TableRow, { kind: 'group' }>
  rowIdx: number
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
  cellProps,
  lockSelected,
  onExpand,
  onToggleLock,
  onSelectLock,
  onKeyDown,
}: GroupSummaryRowProps) {
  const { group, agg } = unit

  return (
    <tr
      className="grid-row group-summary"
      style={{ background: rowTint(group.color, agg.lock === 'all') }}
    >
      <td className="col-lock">
        <LockCell
          state={agg.lock}
          selected={lockSelected}
          onToggle={onToggleLock}
          onSelect={onSelectLock}
          onKeyDown={onKeyDown}
        />
      </td>

      <td className="col-group">
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

      <td className="col-id">
        <GridCell {...cellProps(rowIdx, 2)} display="—" raw="" numeric editable={false} />
      </td>
      <td className="col-weightId">
        <GridCell {...cellProps(rowIdx, 3)} display="—" raw="" numeric={false} editable={false} />
      </td>
      <td className="col-payout">
        <GridCell
          {...cellProps(rowIdx, 4)}
          display={fmtPayout(agg.payout)}
          raw=""
          numeric
          editable={false}
          title="Weight-weighted mean payout across the group"
        />
      </td>
      <td className="col-label">
        <GridCell
          {...cellProps(rowIdx, 5)}
          display={`${agg.count} bucket${agg.count === 1 ? '' : 's'}`}
          raw=""
          numeric={false}
          editable={false}
        />
      </td>
      <td className="col-weight">
        <GridCell
          {...cellProps(rowIdx, 6)}
          display={fmtWeight(agg.weight)}
          raw=""
          numeric
          editable={false}
        />
      </td>
      <td className="col-weightedValue">
        <GridCell
          {...cellProps(rowIdx, 7)}
          display={fmtDecimal(agg.value)}
          raw=""
          numeric
          editable={false}
        />
      </td>
      <td className="col-chance">
        <GridCell
          {...cellProps(rowIdx, 8)}
          display={fmtDecimal(agg.chance)}
          raw=""
          numeric
          editable={false}
        />
      </td>
    </tr>
  )
}
