import { memo, useCallback } from 'react'
import type { BucketRow, SortKey, SortState } from '../lib/types'
import { fmtInt, fmtPct, fmtReturn } from '../lib/format'
import { NumCell, TextCell } from './cells'

export type RowPatch = Partial<Pick<BucketRow, 'bucketId' | 'label' | 'payout' | 'weight' | 'optionalId'>>

interface BucketTableProps {
  rows: BucketRow[]
  totalWeight: number
  sort: SortState
  onSort: (key: SortKey) => void
  onPatch: (uid: string, patch: RowPatch) => void
}

const COLUMNS: { key: SortKey | 'optionalId'; label: string; sortable: boolean }[] = [
  { key: 'bucketId', label: 'Bucket ID', sortable: true },
  { key: 'label', label: 'Bucket Label', sortable: true },
  { key: 'payout', label: 'Payout ×Bet', sortable: true },
  { key: 'weight', label: 'Weight', sortable: true },
  { key: 'weightedReturn', label: 'Weighted Return', sortable: true },
  { key: 'chance', label: 'Chance', sortable: true },
  { key: 'optionalId', label: 'Optional ID', sortable: false },
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
      case 'weightedReturn':
        return dir * ((a.payout * a.weight) / totalWeight - (b.payout * b.weight) / totalWeight)
      case 'bucketId':
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
          display={fmtInt(row.payout)}
          validate={(n) => Number.isInteger(n) && n >= 0}
          onCommit={(n) => patch({ payout: Math.round(n) })}
        />
      </td>
      <td className="col-weight">
        <NumCell
          value={row.weight}
          display={fmtInt(row.weight)}
          validate={(n) => Number.isInteger(n) && n >= 0}
          onCommit={(n) => patch({ weight: Math.round(n) })}
        />
      </td>
      <td className="col-wr">
        <NumCell
          value={weightedReturn}
          display={fmtReturn(weightedReturn)}
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
      <td className="col-opt">
        <TextCell value={row.optionalId} placeholder="—" onCommit={(s) => patch({ optionalId: s })} />
      </td>
    </tr>
  )
})
