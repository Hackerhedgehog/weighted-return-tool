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
import { fmtDecimal, fmtPayout, fmtPct, fmtWeight } from '../lib/format'
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
  /** Column keys switched off in the ⚙ menu. The lock column never hides. */
  hidden: string[]
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

/** "One in" display: 1/X with X to two decimals; a dash when nothing can hit. */
function fmtOneIn(chance: number): string {
  return chance > 0 ? `1/${fmtDecimal(1 / chance, 2)}` : '—'
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
  hidden,
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

  /** The columns actually rendered, in COLUMNS order. Every cell index below is relative to this. */
  const visible = useMemo(
    () => COLUMNS.filter((c) => c.key === 'lock' || !hidden.includes(c.key)),
    [hidden],
  )

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
          case 'oneIn':
            return fmtOneIn(u.agg.chance)
          case 'rtpShare':
            return rtp > 0 ? fmtPct(u.agg.value / rtp, 2) : '—'
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
        case 'oneIn':
          return fmtOneIn(total > 0 ? r.weight / total : 0)
        case 'rtpShare':
          return rtp > 0 && total > 0 ? fmtPct((r.payout * r.weight) / total / rtp, 2) : '—'
        default:
          return ''
      }
    },
    [totalWeight, rtp],
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
      const key = visible[pos.col].key
      if (key === 'label') onPatch(u.row.uid, { label: '' })
      else if (key === 'id') onPatch(u.row.uid, { bucketId: 0 })
      else if (key === 'payout') onPatch(u.row.uid, { payout: 0 })
      else if (key === 'weight' || key === 'weightedValue' || key === 'chance') {
        onPatch(u.row.uid, { weight: 0 })
      }
    },
    [display, onPatch, visible],
  )

  const isEditable = useCallback(
    (pos: CellPos) => {
      const key = visible[pos.col]?.key
      // Group is a dropdown, not a text cell — it has its own edit affordance.
      // The derived columns are computed and have nothing to write back to.
      if (
        key === undefined ||
        key === 'lock' ||
        key === 'group' ||
        key === 'oneIn' ||
        key === 'rtpShare'
      ) {
        return false
      }
      if (pos.row === display.length) return key === 'weight' || key === 'weightedValue'
      const u = display[pos.row]
      // A collapsed group's cells are aggregates: there is no single row to
      // write back to.
      if (u === undefined || u.kind === 'group') return false
      if (key === 'weightedValue') return u.row.payout > 0
      return true
    },
    [display, visible],
  )

  const nav = useGridNavigation({
    rowCount: display.length + 1,
    colCount: visible.length,
    isNumericCol: (c) => visible[c]?.numeric ?? false,
    isLockCol: (c) => visible[c]?.key === 'lock',
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

  const renderBucketCell = (
    unit: Extract<TableRow, { kind: 'bucket' }>,
    rowIdx: number,
    c: Column,
    ci: number,
  ) => {
    const r = unit.row
    switch (c.key) {
      case 'lock':
        return (
          <td key={c.key} className="col-lock">
            <LockCell
              state={r.locked ? 'all' : 'none'}
              selected={nav.sel.row === rowIdx && nav.sel.col === ci}
              onToggle={() => toggleLock(rowIdx)}
              onSelect={() => nav.select({ row: rowIdx, col: ci })}
              onKeyDown={nav.handleKeyDown}
            />
          </td>
        )
      case 'group':
        return (
          <td key={c.key} className="col-group">
            <select
              className="group-select"
              aria-label={`Group of ${r.label}`}
              value={r.groupId}
              style={{ color: grouping.byUid.get(r.uid)?.color }}
              onChange={(e) => {
                if (multiSel.has(r.uid) && multiSel.size > 1) {
                  onGroupMany([...multiSel], e.target.value)
                } else {
                  onPatch(r.uid, { groupId: e.target.value })
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
        )
      case 'id':
        return (
          <td key={c.key} className="col-id">
            <GridCell
              {...cellProps(rowIdx, ci)}
              display={String(r.bucketId)}
              raw={String(r.bucketId)}
              numeric
              editable
              validate={(n) => Number.isInteger(n) && n >= 0}
              onCommitValue={(n) => onPatch(r.uid, { bucketId: Math.round(n) })}
            />
          </td>
        )
      case 'weightId':
        return (
          <td key={c.key} className="col-weightId">
            <GridCell
              {...cellProps(rowIdx, ci)}
              display={r.weightId}
              raw={r.weightId}
              numeric={false}
              editable
              onCommitText={(s) => onPatch(r.uid, { weightId: s })}
            />
          </td>
        )
      case 'payout':
        return (
          <td key={c.key} className="col-payout">
            <GridCell
              {...cellProps(rowIdx, ci)}
              display={fmtPayout(r.payout)}
              raw={fmtPayout(r.payout)}
              numeric
              editable
              validate={(n) => n >= 0}
              onCommitValue={(n) => onPatch(r.uid, { payout: n })}
            />
          </td>
        )
      case 'label':
        return (
          <td key={c.key} className="col-label">
            <GridCell
              {...cellProps(rowIdx, ci)}
              display={r.label}
              raw={r.label}
              numeric={false}
              editable
              onCommitText={(s) => onPatch(r.uid, { label: s })}
            />
          </td>
        )
      case 'weight':
        return (
          <td key={c.key} className="col-weight">
            <GridCell
              {...cellProps(rowIdx, ci)}
              display={fmtWeight(r.weight)}
              raw={String(r.weight)}
              numeric
              editable
              validate={(n) => n >= 0}
              onCommitValue={(n) => onPatch(r.uid, { weight: Math.round(n) })}
            />
          </td>
        )
      case 'weightedValue':
        return (
          <td key={c.key} className="col-weightedValue">
            <GridCell
              {...cellProps(rowIdx, ci)}
              display={fmtDecimal(valueOf(r))}
              raw={fmtDecimal(valueOf(r))}
              numeric
              editable={r.payout > 0}
              validate={(n) => n >= 0}
              title={
                r.payout > 0
                  ? 'Editing solves for the weight that yields this return'
                  : 'A zero-payout bucket always returns 0'
              }
              onCommitValue={(n) => {
                const w = weightForValue(r.weight, totalWeight, r.payout, n, weightStep)
                if (w !== null) onPatch(r.uid, { weight: w })
              }}
            />
          </td>
        )
      case 'chance':
        return (
          <td key={c.key} className="col-chance">
            <GridCell
              {...cellProps(rowIdx, ci)}
              display={fmtDecimal(chanceOf(r))}
              raw={fmtDecimal(chanceOf(r))}
              numeric
              editable
              validate={(n) => n >= 0 && n < 1}
              title="Fraction of total weight — the same value the export writes"
              onCommitValue={(n) => {
                const w = weightForChance(r.weight, totalWeight, n, weightStep)
                if (w !== null) onPatch(r.uid, { weight: w })
              }}
            />
          </td>
        )
      case 'oneIn':
        return (
          <td key={c.key} className="col-oneIn">
            <GridCell
              {...cellProps(rowIdx, ci)}
              display={fmtOneIn(chanceOf(r))}
              raw=""
              numeric
              editable={false}
              title="1 / chance — one hit of this bucket per this many spins"
            />
          </td>
        )
      case 'rtpShare':
        return (
          <td key={c.key} className="col-rtpShare">
            <GridCell
              {...cellProps(rowIdx, ci)}
              display={rtp > 0 ? fmtPct(valueOf(r) / rtp, 2) : '—'}
              raw=""
              numeric
              editable={false}
              title="This bucket's share of the table's total RTP"
            />
          </td>
        )
      default:
        return null
    }
  }

  const renderTotalsCell = (c: Column, ci: number) => {
    switch (c.key) {
      case 'label':
        return (
          <td key={c.key} className="col-label">
            <GridCell
              {...cellProps(totalsRowIndex, ci)}
              display="Total"
              raw="Total"
              numeric={false}
              editable={false}
              className="totals-label"
            />
          </td>
        )
      case 'weight':
        return (
          <td key={c.key} className="col-weight">
            <GridCell
              {...cellProps(totalsRowIndex, ci)}
              display={fmtWeight(totalWeight)}
              raw={String(Math.round(totalWeight))}
              numeric
              editable
              validate={(n) => n > 0}
              title="Total weight — editing rescales every unlocked row"
              onCommitValue={(n) => onTotalWeight(Math.round(n))}
            />
          </td>
        )
      case 'weightedValue':
        return (
          <td key={c.key} className="col-weightedValue">
            <GridCell
              {...cellProps(totalsRowIndex, ci)}
              display={fmtDecimal(rtp)}
              raw={fmtDecimal(rtp)}
              numeric
              editable
              validate={(n) => n >= 0}
              title="Total weighted return (RTP) — editing reshapes unlocked weights to reach it, leaving hit and win chance alone"
              onCommitValue={onTotalRtp}
            />
          </td>
        )
      case 'chance':
        return (
          <td key={c.key} className="col-chance">
            <GridCell
              {...cellProps(totalsRowIndex, ci)}
              display={rows.length > 0 ? '1' : '0'}
              raw="1"
              numeric
              editable={false}
              title="Chances always sum to 1"
            />
          </td>
        )
      case 'oneIn':
        return (
          <td key={c.key} className="col-oneIn">
            <GridCell
              {...cellProps(totalsRowIndex, ci)}
              display={rows.length > 0 ? '1/1' : ''}
              raw=""
              numeric
              editable={false}
              title="Every spin lands in some bucket"
            />
          </td>
        )
      case 'rtpShare':
        return (
          <td key={c.key} className="col-rtpShare">
            <GridCell
              {...cellProps(totalsRowIndex, ci)}
              display={rtp > 0 ? '100%' : ''}
              raw=""
              numeric
              editable={false}
            />
          </td>
        )
      default:
        // Rendered as cells rather than blanks so arrowing along the totals
        // row cannot strand keyboard focus.
        return (
          <td key={c.key} className={`col-${c.key}`}>
            <GridCell
              {...cellProps(totalsRowIndex, ci)}
              display=""
              raw=""
              numeric={c.numeric}
              editable={false}
            />
          </td>
        )
    }
  }

  return (
    <div className="grid-wrap" ref={wrapRef}>
      <table className="grid-table" ref={tableRef} role="grid">
        <colgroup>
          {visible.map((c) => (
            <col key={c.key} style={{ width: widthOf(c.key) }} />
          ))}
        </colgroup>

        <thead>
          <tr>
            {visible.map((c) => (
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
                visible={visible}
                rtp={rtp}
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
                {visible.map((c, ci) => renderBucketCell(unit, rowIdx, c, ci))}
              </tr>
            ),
          )}
        </tbody>

        <tfoot>
          <tr className="totals-row">{visible.map((c, ci) => renderTotalsCell(c, ci))}</tr>
        </tfoot>
      </table>
    </div>
  )
}
