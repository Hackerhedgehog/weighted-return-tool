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
  { key: 'payout', label: 'Avg Payout', sortable: true, numeric: true, width: 92 },
  { key: 'label', label: 'Label', sortable: true, numeric: false, width: 150 },
  { key: 'weight', label: 'Weights', sortable: true, numeric: true, width: 118 },
  { key: 'weightedValue', label: 'Weighted Value', sortable: true, numeric: true, width: 124 },
  // Sized so the whole table fits beside the chart. Chances run to 15
  // decimals — double-click the header edge to fit the column to them.
  { key: 'chance', label: 'Chance', sortable: true, numeric: true, width: 132 },
]

export const DEFAULT_WIDTHS: Record<string, number> = Object.fromEntries(
  COLUMNS.map((c) => [c.key, c.width]),
)

/**
 * Shared so the export writes rows in the same order the table shows them.
 * `groupRank` (uid → group index) drives the 'group' sort; without it that
 * sort falls back to bucket id.
 */
export function sortRows(
  rows: BucketRow[],
  sort: SortState,
  totalWeight: number,
  groupRank?: Map<string, number>,
): BucketRow[] {
  const dir = sort.dir
  const value = (r: BucketRow) => (totalWeight > 0 ? (r.payout * r.weight) / totalWeight : 0)

  return [...rows].sort((a, b) => {
    switch (sort.key) {
      case 'group': {
        const ra = groupRank?.get(a.uid) ?? 0
        const rb = groupRank?.get(b.uid) ?? 0
        return dir * (ra - rb) || a.payout - b.payout || a.bucketId - b.bucketId
      }
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
