import { memo, useCallback } from 'react'
import type { BucketRow, SortKey, SortState } from '../lib/types'
import { fmtWeight, fmtPct, fmtDecimal } from '../lib/format'
import { NumCell, TextCell } from './cells'

export type RowPatch = Partial<Pick<BucketRow, 'bucketId' | 'label' | 'payout' | 'weight' | 'locked'>>

interface BucketTableProps {
  rows: BucketRow[]
  totalWeight: number
  sort: SortState
  onSort: (key: SortKey) => void
  onPatch: (uid: string, patch: RowPatch) => void
}

const COLUMNS: { key: SortKey; label: string; sortable: boolean }[] = [
  { key: 'id', label: 'ID', sortable: true },
  { key: 'payout', label: 'Avg Payout', sortable: true },
  { key: 'label', label: 'Label', sortable: true },
  { key: 'weight', label: 'Weights', sortable: true },
  { key: 'weightedValue', label: 'Weighted Value', sortable: true },
  { key: 'chance', label: 'Chance', sortable: true },
]

function sortRows(rows: BucketRow[], sort: SortState, totalWeight: number): BucketRow[] {
  const dir = sort.dir
  const sorted = [...rows]
  sorted.sort((a, b) => {
    switch (sort.key) {
      case 'label':
        return dir * a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true })
      case 'payout':
        return dir * (a.payout - b.payout)
      case 'weight':
      case 'chance':
        return dir * (a.weight - b.weight)
      case 'weightedValue':
        return dir * ((a.payout * a.weight) / totalWeight - (b.payout * b.weight) / totalWeight)
      case 'id':
      default:
        return dir * (a.bucketId - b.bucketId)
    }
  })
  return sorted
}

export function BucketTable({ rows, totalWeight, sort, onSort, onPatch }: BucketTableProps) {
  const sorted = sortRows(rows, sort, totalWeight)

  return (
    <div className="table-scroll">
      <table className="bucket-table">
        <thead>
          <tr>
            {COLUMNS.map((col) => (
              <th key={col.key}>
                {col.sortable ? (
                  <button
                    type="button"
                    className={`th-btn ${sort.key === col.key ? 'active' : ''}`}
                    onClick={() => onSort(col.key as SortKey)}
                  >
                    <span>{col.label}</span>
                    <span className="sort-arrow" aria-hidden="true">
                      {sort.key === col.key ? (sort.dir === 1 ? '▲' : '▼') : '⇅'}
                    </span>
                  </button>
                ) : (
                  <span className="th-static">{col.label}</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <Row key={row.uid} row={row} totalWeight={totalWeight} onPatch={onPatch} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

interface RowProps {
  row: BucketRow
  totalWeight: number
  onPatch: (uid: string, patch: RowPatch) => void
}

const Row = memo(function Row({ row, totalWeight, onPatch }: RowProps) {
  const chance = totalWeight > 0 ? row.weight / totalWeight : NaN
  const weightedReturn = totalWeight > 0 ? (row.payout * row.weight) / totalWeight : NaN

  const patch = useCallback((p: RowPatch) => onPatch(row.uid, p), [onPatch, row.uid])

  return (
    <tr>
      <td className="col-id">
        <NumCell
          value={row.bucketId}
          display={String(row.bucketId)}
          validate={(n) => Number.isInteger(n) && n >= 0}
          onCommit={(n) => patch({ bucketId: Math.round(n) })}
        />
      </td>
      <td className="col-label">
        <TextCell value={row.label} onCommit={(s) => patch({ label: s })} />
      </td>
      <td className="col-payout">
        <NumCell
          value={row.payout}
          display={fmtWeight(row.payout)}
          validate={(n) => Number.isInteger(n) && n >= 0}
          onCommit={(n) => patch({ payout: Math.round(n) })}
        />
      </td>
      <td className="col-weight">
        <NumCell
          value={row.weight}
          display={fmtWeight(row.weight)}
          validate={(n) => Number.isInteger(n) && n >= 0}
          onCommit={(n) => patch({ weight: Math.round(n) })}
        />
      </td>
      <td className="col-wr">
        <NumCell
          value={weightedReturn}
          display={fmtDecimal(weightedReturn)}
          editValue={Number.isFinite(weightedReturn) ? String(weightedReturn) : ''}
          validate={(n) => n >= 0 && row.payout > 0}
          onCommit={(n) => {
            if (row.payout > 0) patch({ weight: Math.round((n * totalWeight) / row.payout) })
          }}
        />
      </td>
      <td className="col-chance">
        <NumCell
          value={chance * 100}
          display={fmtPct(chance)}
          editValue={Number.isFinite(chance) ? String(chance * 100) : ''}
          validate={(n) => n >= 0 && n <= 100}
          onCommit={(n) => patch({ weight: Math.round((n / 100) * totalWeight) })}
        />
      </td>
    </tr>
  )
})
