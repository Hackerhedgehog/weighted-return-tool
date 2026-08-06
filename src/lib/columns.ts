import type { BucketRow, ColumnKey, SortState } from './types'

export interface Column {
  key: ColumnKey
  label: string
  sortable: boolean
  numeric: boolean
  width: number
}

/**
 * Column order matches the export file exactly — ID, Avg Payout, Label,
 * Weights, Weighted Value, Chance — with the lock toggle prepended. The lock
 * column is UI only and is never written to TSV.
 */
export const COLUMNS: Column[] = [
  { key: 'lock', label: '', sortable: false, numeric: false, width: 34 },
  { key: 'id', label: 'ID', sortable: true, numeric: true, width: 62 },
  { key: 'payout', label: 'Avg Payout', sortable: true, numeric: true, width: 110 },
  { key: 'label', label: 'Label', sortable: true, numeric: false, width: 190 },
  { key: 'weight', label: 'Weights', sortable: true, numeric: true, width: 118 },
  { key: 'weightedValue', label: 'Weighted Value', sortable: true, numeric: true, width: 152 },
  // wide enough for a 15-decimal chance without wrapping
  { key: 'chance', label: 'Chance', sortable: true, numeric: true, width: 200 },
]

export const DEFAULT_WIDTHS: Record<string, number> = Object.fromEntries(
  COLUMNS.map((c) => [c.key, c.width]),
)

/** Shared so the export writes rows in the same order the table shows them. */
export function sortRows(rows: BucketRow[], sort: SortState, totalWeight: number): BucketRow[] {
  const dir = sort.dir
  const value = (r: BucketRow) => (totalWeight > 0 ? (r.payout * r.weight) / totalWeight : 0)

  return [...rows].sort((a, b) => {
    switch (sort.key) {
      case 'label':
        return (
          dir * a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true })
        )
      case 'payout':
        return dir * (a.payout - b.payout)
      case 'weight':
      case 'chance':
        return dir * (a.weight - b.weight)
      case 'weightedValue':
        return dir * (value(a) - value(b))
      case 'id':
      default:
        return dir * (a.bucketId - b.bucketId)
    }
  })
}
