import { useCallback, useMemo, useRef } from 'react'
import type { BucketRow, ColumnKey, RowPatch, SortKey, SortState, WeightStep } from '../lib/types'
import type { Grouping } from '../lib/groups'
import { COLUMNS, sortRows, type Column } from '../lib/columns'
import { fmtDecimal, fmtPayout, fmtWeight } from '../lib/format'
import { weightForChance, weightForValue } from '../lib/distribute'
import { GridCell, LockCell } from './cells'
import { useGridNavigation, type CellPos } from './useGridNavigation'

const MIN_WIDTH = 40
const MAX_AUTOFIT = 480

interface BucketTableProps {
  rows: BucketRow[]
  totalWeight: number
  sort: SortState
  columnWidths: Record<string, number>
  /** Colors each row by its bucket group and drives the group sort. */
  grouping: Grouping
  weightStep: WeightStep
  onSort: (key: SortKey) => void
  onPatch: (uid: string, patch: RowPatch) => void
  onWidths: (widths: Record<string, number>) => void
  onTotalWeight: (n: number) => void
  onTotalRtp: (n: number) => void
}

/** Reused canvas context for double-click auto-fit. */
let measureCtx: CanvasRenderingContext2D | null = null

function textWidth(text: string, font: string): number {
  if (measureCtx === null) measureCtx = document.createElement('canvas').getContext('2d')
  if (measureCtx === null) return text.length * 8
  measureCtx.font = font
  return measureCtx.measureText(text).width
}

export function BucketTable({
  rows,
  totalWeight,
  sort,
  columnWidths,
  grouping,
  weightStep,
  onSort,
  onPatch,
  onWidths,
  onTotalWeight,
  onTotalRtp,
}: BucketTableProps) {
  const sorted = useMemo(
    () => sortRows(rows, sort, totalWeight, grouping.rank),
    [rows, sort, totalWeight, grouping],
  )
  const tableRef = useRef<HTMLTableElement>(null)

  const totalsRowIndex = sorted.length
  const rtp =
    totalWeight > 0 ? sorted.reduce((a, r) => a + (r.payout * r.weight) / totalWeight, 0) : 0

  const chanceOf = (r: BucketRow) => (totalWeight > 0 ? r.weight / totalWeight : 0)
  const valueOf = (r: BucketRow) => (totalWeight > 0 ? (r.payout * r.weight) / totalWeight : 0)

  const displayFor = useCallback(
    (r: BucketRow, key: ColumnKey): string => {
      const total = totalWeight
      switch (key) {
        case 'id':
          return String(r.bucketId)
        case 'payout':
          return fmtPayout(r.payout)
        case 'label':
          return r.label
        case 'weight':
          return fmtWeight(r.weight)
        case 'weightedValue':
          return fmtDecimal(total > 0 ? (r.payout * r.weight) / total : 0)
        case 'chance':
          return fmtDecimal(total > 0 ? r.weight / total : 0)
        default:
          return ''
      }
    },
    [totalWeight],
  )

  const toggleLock = useCallback(
    (rowIdx: number) => {
      const row = sorted[rowIdx]
      if (row) onPatch(row.uid, { locked: !row.locked })
    },
    [sorted, onPatch],
  )

  const clearCell = useCallback(
    (pos: CellPos) => {
      const row = sorted[pos.row]
      if (!row) return
      const key = COLUMNS[pos.col].key
      if (key === 'label') onPatch(row.uid, { label: '' })
      else if (key === 'id') onPatch(row.uid, { bucketId: 0 })
      else if (key === 'payout') onPatch(row.uid, { payout: 0 })
      else if (key === 'weight' || key === 'weightedValue' || key === 'chance') {
        onPatch(row.uid, { weight: 0 })
      }
    },
    [sorted, onPatch],
  )

  const isEditable = useCallback(
    (pos: CellPos) => {
      const key = COLUMNS[pos.col]?.key
      if (key === undefined || key === 'lock') return false
      if (pos.row === sorted.length) return key === 'weight' || key === 'weightedValue'
      if (key === 'weightedValue') return (sorted[pos.row]?.payout ?? 0) > 0
      return true
    },
    [sorted],
  )

  const nav = useGridNavigation({
    rowCount: sorted.length + 1,
    colCount: COLUMNS.length,
    isNumericCol: (c) => COLUMNS[c].numeric,
    isLockCol: (c) => COLUMNS[c].key === 'lock',
    isEditable,
    onDelete: clearCell,
    onToggleLock: toggleLock,
  })

  // ---- column resizing ----

  const drag = useRef<{ key: ColumnKey; startX: number; startW: number } | null>(null)
  const widthOf = (key: ColumnKey) => columnWidths[key] ?? 100

  const beginResize = (e: React.PointerEvent, key: ColumnKey) => {
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { key, startX: e.clientX, startW: widthOf(key) }
  }

  const moveResize = (e: React.PointerEvent) => {
    const d = drag.current
    if (d === null) return
    onWidths({ ...columnWidths, [d.key]: Math.max(MIN_WIDTH, d.startW + (e.clientX - d.startX)) })
  }

  const endResize = (e: React.PointerEvent) => {
    if (drag.current === null) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    drag.current = null
  }

  const autoFit = (col: Column) => {
    if (col.key === 'lock') return
    const font = tableRef.current
      ? getComputedStyle(tableRef.current).font || '13px monospace'
      : '13px monospace'

    let widest = textWidth(col.label, font)
    for (const r of sorted) widest = Math.max(widest, textWidth(displayFor(r, col.key), font))
    if (col.key === 'weight') widest = Math.max(widest, textWidth(fmtWeight(totalWeight), font))
    if (col.key === 'weightedValue') widest = Math.max(widest, textWidth(fmtDecimal(rtp), font))

    onWidths({
      ...columnWidths,
      [col.key]: Math.min(MAX_AUTOFIT, Math.max(MIN_WIDTH, Math.ceil(widest) + 32)),
    })
  }

  // ---- cell wiring ----

  const cellProps = (rowIdx: number, colIdx: number) => ({
    selected: nav.sel.row === rowIdx && nav.sel.col === colIdx,
    editing: nav.editing && nav.sel.row === rowIdx && nav.sel.col === colIdx,
    seed: nav.seed,
    onSelect: () => nav.select({ row: rowIdx, col: colIdx }),
    onStartEdit: nav.startEdit,
    onStopEdit: nav.stopEdit,
    onNavigate: nav.navigate,
    onKeyDown: nav.handleKeyDown,
  })

  return (
    <div className="grid-wrap">
      <table className="grid-table" ref={tableRef} role="grid">
        <colgroup>
          {COLUMNS.map((c) => (
            <col key={c.key} style={{ width: widthOf(c.key) }} />
          ))}
        </colgroup>

        <thead>
          <tr>
            {COLUMNS.map((c) => (
              <th key={c.key} className={`col-${c.key}`}>
                {c.sortable ? (
                  <button
                    type="button"
                    className={`th-btn ${sort.key === c.key ? 'active' : ''}`}
                    onClick={() => onSort(c.key as SortKey)}
                    title={`Sort by ${c.label}`}
                  >
                    <span>{c.label}</span>
                    <span className="sort-arrow" aria-hidden="true">
                      {sort.key === c.key ? (sort.dir === 1 ? '▲' : '▼') : ''}
                    </span>
                  </button>
                ) : (
                  <span className="th-static">{c.label}</span>
                )}
                <span
                  className="col-resizer"
                  role="separator"
                  aria-orientation="vertical"
                  title="Drag to resize · double-click to fit"
                  onPointerDown={(e) => beginResize(e, c.key)}
                  onPointerMove={moveResize}
                  onPointerUp={endResize}
                  onPointerCancel={endResize}
                  onDoubleClick={() => autoFit(c)}
                />
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {sorted.map((row, rowIdx) => (
            <tr
              key={row.uid}
              className={`grid-row ${row.locked ? 'locked' : ''}`}
              // group tint only — spacing must stay identical across groups,
              // and the locked highlight (a class style) must stay visible
              style={row.locked ? undefined : { background: grouping.byUid.get(row.uid)?.tint }}
            >
              <td className="col-lock">
                <LockCell
                  locked={row.locked}
                  selected={nav.sel.row === rowIdx && nav.sel.col === 0}
                  onToggle={() => toggleLock(rowIdx)}
                  onSelect={() => nav.select({ row: rowIdx, col: 0 })}
                  onKeyDown={nav.handleKeyDown}
                />
              </td>

              <td className="col-id">
                <GridCell
                  {...cellProps(rowIdx, 1)}
                  display={String(row.bucketId)}
                  raw={String(row.bucketId)}
                  numeric
                  editable
                  validate={(n) => Number.isInteger(n) && n >= 0}
                  onCommitValue={(n) => onPatch(row.uid, { bucketId: Math.round(n) })}
                />
              </td>

              <td className="col-payout">
                <GridCell
                  {...cellProps(rowIdx, 2)}
                  display={fmtPayout(row.payout)}
                  raw={fmtPayout(row.payout)}
                  numeric
                  editable
                  validate={(n) => n >= 0}
                  onCommitValue={(n) => onPatch(row.uid, { payout: n })}
                />
              </td>

              <td className="col-label">
                <GridCell
                  {...cellProps(rowIdx, 3)}
                  display={row.label}
                  raw={row.label}
                  numeric={false}
                  editable
                  onCommitText={(s) => onPatch(row.uid, { label: s })}
                />
              </td>

              <td className="col-weight">
                <GridCell
                  {...cellProps(rowIdx, 4)}
                  display={fmtWeight(row.weight)}
                  raw={String(row.weight)}
                  numeric
                  editable
                  validate={(n) => n >= 0}
                  onCommitValue={(n) => onPatch(row.uid, { weight: Math.round(n) })}
                />
              </td>

              <td className="col-weightedValue">
                <GridCell
                  {...cellProps(rowIdx, 5)}
                  display={fmtDecimal(valueOf(row))}
                  raw={fmtDecimal(valueOf(row))}
                  numeric
                  editable={row.payout > 0}
                  validate={(n) => n >= 0}
                  title={
                    row.payout > 0
                      ? 'Editing solves for the weight that yields this return'
                      : 'A zero-payout bucket always returns 0'
                  }
                  onCommitValue={(n) => {
                    const w = weightForValue(row.weight, totalWeight, row.payout, n, weightStep)
                    if (w !== null) onPatch(row.uid, { weight: w })
                  }}
                />
              </td>

              <td className="col-chance">
                <GridCell
                  {...cellProps(rowIdx, 6)}
                  display={fmtDecimal(chanceOf(row))}
                  raw={fmtDecimal(chanceOf(row))}
                  numeric
                  editable
                  validate={(n) => n >= 0 && n < 1}
                  title="Fraction of total weight — the same value the export writes"
                  onCommitValue={(n) => {
                    const w = weightForChance(row.weight, totalWeight, n, weightStep)
                    if (w !== null) onPatch(row.uid, { weight: w })
                  }}
                />
              </td>
            </tr>
          ))}
        </tbody>

        <tfoot>
          <tr className="totals-row">
            {/* Rendered as cells rather than blanks so arrowing along the
                totals row cannot strand keyboard focus. */}
            <td className="col-lock">
              <GridCell
                {...cellProps(totalsRowIndex, 0)}
                display=""
                raw=""
                numeric={false}
                editable={false}
              />
            </td>
            <td className="col-id">
              <GridCell {...cellProps(totalsRowIndex, 1)} display="" raw="" numeric editable={false} />
            </td>
            <td className="col-payout">
              <GridCell {...cellProps(totalsRowIndex, 2)} display="" raw="" numeric editable={false} />
            </td>
            <td className="col-label">
              <GridCell
                {...cellProps(totalsRowIndex, 3)}
                display="Total"
                raw="Total"
                numeric={false}
                editable={false}
                className="totals-label"
              />
            </td>

            <td className="col-weight">
              <GridCell
                {...cellProps(totalsRowIndex, 4)}
                display={fmtWeight(totalWeight)}
                raw={String(Math.round(totalWeight))}
                numeric
                editable
                validate={(n) => n > 0}
                title="Total weight — editing rescales every unlocked row"
                onCommitValue={(n) => onTotalWeight(Math.round(n))}
              />
            </td>

            <td className="col-weightedValue">
              <GridCell
                {...cellProps(totalsRowIndex, 5)}
                display={fmtDecimal(rtp)}
                raw={fmtDecimal(rtp)}
                numeric
                editable
                validate={(n) => n >= 0}
                title="Total weighted return (RTP) — editing reshapes unlocked weights to reach it, leaving hit and win chance alone"
                onCommitValue={onTotalRtp}
              />
            </td>

            <td className="col-chance">
              <GridCell
                {...cellProps(totalsRowIndex, 6)}
                display={rows.length > 0 ? '1' : '0'}
                raw="1"
                numeric
                editable={false}
                title="Chances always sum to 1"
              />
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
