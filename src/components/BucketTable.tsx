import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BucketRow,
  ColumnKey,
  GroupDef,
  RowPatch,
  SortKey,
  SortState,
  WeightStep,
} from '../lib/types'
import type { Grouping } from '../lib/groups'
import { COLUMNS, type Column } from '../lib/columns'
import { fmtDecimal, fmtPayout, fmtWeight } from '../lib/format'
import { rowTint } from '../lib/palette'
import { weightForChance, weightForValue } from '../lib/distribute'
import { buildTableRows, type TableRow } from '../lib/tableRows'
import { GridCell, LockCell, type CellNavProps } from './cells'
import { GroupSummaryRow } from './GroupSummaryRow'
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
  /** Every group that exists, for the per-row group dropdown. */
  groups: GroupDef[]
  weightStep: WeightStep
  /** Group ids drawn as one aggregate row instead of their buckets. */
  collapsed: string[]
  onSort: (key: SortKey) => void
  onPatch: (uid: string, patch: RowPatch) => void
  /** A group change applied to every shift-selected row at once, as one undo step. */
  onGroupMany: (uids: string[], groupId: string) => void
  onWidths: (widths: Record<string, number>) => void
  onTotalWeight: (n: number) => void
  onTotalRtp: (n: number) => void
  onExpand: (groupId: string) => void
  onGroupLock: (groupId: string, locked: boolean) => void
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
  groups,
  weightStep,
  collapsed,
  onSort,
  onPatch,
  onGroupMany,
  onWidths,
  onTotalWeight,
  onTotalRtp,
  onExpand,
  onGroupLock,
}: BucketTableProps) {
  const display = useMemo(
    () => buildTableRows(rows, grouping, collapsed, sort, totalWeight),
    [rows, grouping, collapsed, sort, totalWeight],
  )
  const tableRef = useRef<HTMLTableElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  /**
   * Rows toggled on with shift+click — the same selection idiom the chart's
   * bars use. Changing the group dropdown on any selected row then moves every
   * selected row; a plain click on an unselected row, or anywhere outside the
   * table, drops the selection.
   */
  const [multiSel, setMultiSel] = useState<Set<string>>(() => new Set())
  const clearMulti = useCallback(
    () => setMultiSel((prev) => (prev.size === 0 ? prev : new Set())),
    [],
  )
  const toggleMulti = useCallback((uid: string) => {
    setMultiSel((prev) => {
      const next = new Set(prev)
      if (next.has(uid)) next.delete(uid)
      else next.add(uid)
      return next
    })
  }, [])

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || e.shiftKey) return
      const el = wrapRef.current
      if (el !== null && !el.contains(e.target as Node)) clearMulti()
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [clearMulti])

  const totalsRowIndex = display.length
  const rtp =
    totalWeight > 0 ? rows.reduce((a, r) => a + (r.payout * r.weight) / totalWeight, 0) : 0

  const chanceOf = (r: BucketRow) => (totalWeight > 0 ? r.weight / totalWeight : 0)
  const valueOf = (r: BucketRow) => (totalWeight > 0 ? (r.payout * r.weight) / totalWeight : 0)

  const displayFor = useCallback(
    (u: TableRow, key: ColumnKey): string => {
      const total = totalWeight
      if (u.kind === 'group') {
        switch (key) {
          case 'payout':
            return fmtPayout(u.agg.payout)
          case 'label':
            return `${u.agg.count} bucket${u.agg.count === 1 ? '' : 's'}`
          case 'weight':
            return fmtWeight(u.agg.weight)
          case 'weightedValue':
            return fmtDecimal(u.agg.value)
          case 'chance':
            return fmtDecimal(u.agg.chance)
          default:
            return ''
        }
      }
      const r = u.row
      switch (key) {
        case 'id':
          return String(r.bucketId)
        case 'weightId':
          return r.weightId
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
      const u = display[rowIdx]
      if (u === undefined) return
      if (u.kind === 'group') onGroupLock(u.group.id, u.agg.lock !== 'all')
      else onPatch(u.row.uid, { locked: !u.row.locked })
    },
    [display, onPatch, onGroupLock],
  )

  const clearCell = useCallback(
    (pos: CellPos) => {
      const u = display[pos.row]
      if (u === undefined || u.kind === 'group') return
      const key = COLUMNS[pos.col].key
      if (key === 'label') onPatch(u.row.uid, { label: '' })
      else if (key === 'id') onPatch(u.row.uid, { bucketId: 0 })
      else if (key === 'payout') onPatch(u.row.uid, { payout: 0 })
      else if (key === 'weight' || key === 'weightedValue' || key === 'chance') {
        onPatch(u.row.uid, { weight: 0 })
      }
    },
    [display, onPatch],
  )

  const isEditable = useCallback(
    (pos: CellPos) => {
      const key = COLUMNS[pos.col]?.key
      // Group is a dropdown, not a text cell — it has its own edit affordance.
      if (key === undefined || key === 'lock' || key === 'group') return false
      if (pos.row === display.length) return key === 'weight' || key === 'weightedValue'
      const u = display[pos.row]
      // A collapsed group's cells are aggregates: there is no single row to
      // write back to.
      if (u === undefined || u.kind === 'group') return false
      if (key === 'weightedValue') return u.row.payout > 0
      return true
    },
    [display],
  )

  const nav = useGridNavigation({
    rowCount: display.length + 1,
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
    for (const u of display) widest = Math.max(widest, textWidth(displayFor(u, col.key), font))
    if (col.key === 'weight') widest = Math.max(widest, textWidth(fmtWeight(totalWeight), font))
    if (col.key === 'weightedValue') widest = Math.max(widest, textWidth(fmtDecimal(rtp), font))

    onWidths({
      ...columnWidths,
      [col.key]: Math.min(MAX_AUTOFIT, Math.max(MIN_WIDTH, Math.ceil(widest) + 32)),
    })
  }

  // ---- cell wiring ----

  const cellProps = (rowIdx: number, colIdx: number): CellNavProps => ({
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
    <div className="grid-wrap" ref={wrapRef}>
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
          {display.map((unit, rowIdx) =>
            unit.kind === 'group' ? (
              <GroupSummaryRow
                key={unit.uid}
                unit={unit}
                rowIdx={rowIdx}
                cellProps={cellProps}
                lockSelected={nav.sel.row === rowIdx && nav.sel.col === 0}
                onExpand={() => onExpand(unit.group.id)}
                onToggleLock={() => toggleLock(rowIdx)}
                onSelectLock={() => nav.select({ row: rowIdx, col: 0 })}
                onKeyDown={nav.handleKeyDown}
              />
            ) : (
              <tr
                key={unit.uid}
                className={`grid-row ${unit.row.locked ? 'locked' : ''} ${multiSel.has(unit.row.uid) ? 'multi-selected' : ''}`}
                // color only — spacing must stay identical across groups, and a
                // locked row keeps its group hue, just deepened, so grouping
                // stays readable while rows are pinned
                style={{
                  background: rowTint(grouping.byUid.get(unit.row.uid)?.color, unit.row.locked),
                }}
                // Capture phase, so a shift+click toggles the selection instead
                // of also landing in a cell (or starting a text selection). A
                // plain click on an *unselected* row drops the selection; on a
                // selected row it must not, or the group dropdown could never
                // be reached to apply the multi-change.
                onMouseDownCapture={(e) => {
                  if (e.button !== 0) return
                  if (e.shiftKey) {
                    e.preventDefault()
                    e.stopPropagation()
                    toggleMulti(unit.row.uid)
                  } else if (!multiSel.has(unit.row.uid)) {
                    clearMulti()
                  }
                }}
              >
                <td className="col-lock">
                  <LockCell
                    state={unit.row.locked ? 'all' : 'none'}
                    selected={nav.sel.row === rowIdx && nav.sel.col === 0}
                    onToggle={() => toggleLock(rowIdx)}
                    onSelect={() => nav.select({ row: rowIdx, col: 0 })}
                    onKeyDown={nav.handleKeyDown}
                  />
                </td>

                <td className="col-group">
                  <select
                    className="group-select"
                    aria-label={`Group of ${unit.row.label}`}
                    value={unit.row.groupId}
                    style={{ color: grouping.byUid.get(unit.row.uid)?.color }}
                    onChange={(e) => {
                      if (multiSel.has(unit.row.uid) && multiSel.size > 1) {
                        onGroupMany([...multiSel], e.target.value)
                      } else {
                        onPatch(unit.row.uid, { groupId: e.target.value })
                      }
                    }}
                  >
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </td>

                <td className="col-id">
                  <GridCell
                    {...cellProps(rowIdx, 2)}
                    display={String(unit.row.bucketId)}
                    raw={String(unit.row.bucketId)}
                    numeric
                    editable
                    validate={(n) => Number.isInteger(n) && n >= 0}
                    onCommitValue={(n) => onPatch(unit.row.uid, { bucketId: Math.round(n) })}
                  />
                </td>

                <td className="col-weightId">
                  <GridCell
                    {...cellProps(rowIdx, 3)}
                    display={unit.row.weightId}
                    raw={unit.row.weightId}
                    numeric={false}
                    editable
                    onCommitText={(s) => onPatch(unit.row.uid, { weightId: s })}
                  />
                </td>

                <td className="col-payout">
                  <GridCell
                    {...cellProps(rowIdx, 4)}
                    display={fmtPayout(unit.row.payout)}
                    raw={fmtPayout(unit.row.payout)}
                    numeric
                    editable
                    validate={(n) => n >= 0}
                    onCommitValue={(n) => onPatch(unit.row.uid, { payout: n })}
                  />
                </td>

                <td className="col-label">
                  <GridCell
                    {...cellProps(rowIdx, 5)}
                    display={unit.row.label}
                    raw={unit.row.label}
                    numeric={false}
                    editable
                    onCommitText={(s) => onPatch(unit.row.uid, { label: s })}
                  />
                </td>

                <td className="col-weight">
                  <GridCell
                    {...cellProps(rowIdx, 6)}
                    display={fmtWeight(unit.row.weight)}
                    raw={String(unit.row.weight)}
                    numeric
                    editable
                    validate={(n) => n >= 0}
                    onCommitValue={(n) => onPatch(unit.row.uid, { weight: Math.round(n) })}
                  />
                </td>

                <td className="col-weightedValue">
                  <GridCell
                    {...cellProps(rowIdx, 7)}
                    display={fmtDecimal(valueOf(unit.row))}
                    raw={fmtDecimal(valueOf(unit.row))}
                    numeric
                    editable={unit.row.payout > 0}
                    validate={(n) => n >= 0}
                    title={
                      unit.row.payout > 0
                        ? 'Editing solves for the weight that yields this return'
                        : 'A zero-payout bucket always returns 0'
                    }
                    onCommitValue={(n) => {
                      const w = weightForValue(
                        unit.row.weight,
                        totalWeight,
                        unit.row.payout,
                        n,
                        weightStep,
                      )
                      if (w !== null) onPatch(unit.row.uid, { weight: w })
                    }}
                  />
                </td>

                <td className="col-chance">
                  <GridCell
                    {...cellProps(rowIdx, 8)}
                    display={fmtDecimal(chanceOf(unit.row))}
                    raw={fmtDecimal(chanceOf(unit.row))}
                    numeric
                    editable
                    validate={(n) => n >= 0 && n < 1}
                    title="Fraction of total weight — the same value the export writes"
                    onCommitValue={(n) => {
                      const w = weightForChance(unit.row.weight, totalWeight, n, weightStep)
                      if (w !== null) onPatch(unit.row.uid, { weight: w })
                    }}
                  />
                </td>
              </tr>
            ),
          )}
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
            <td className="col-group">
              <GridCell
                {...cellProps(totalsRowIndex, 1)}
                display=""
                raw=""
                numeric={false}
                editable={false}
              />
            </td>
            <td className="col-id">
              <GridCell {...cellProps(totalsRowIndex, 2)} display="" raw="" numeric editable={false} />
            </td>
            <td className="col-weightId">
              <GridCell
                {...cellProps(totalsRowIndex, 3)}
                display=""
                raw=""
                numeric={false}
                editable={false}
              />
            </td>
            <td className="col-payout">
              <GridCell {...cellProps(totalsRowIndex, 4)} display="" raw="" numeric editable={false} />
            </td>
            <td className="col-label">
              <GridCell
                {...cellProps(totalsRowIndex, 5)}
                display="Total"
                raw="Total"
                numeric={false}
                editable={false}
                className="totals-label"
              />
            </td>

            <td className="col-weight">
              <GridCell
                {...cellProps(totalsRowIndex, 6)}
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
                {...cellProps(totalsRowIndex, 7)}
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
                {...cellProps(totalsRowIndex, 8)}
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
