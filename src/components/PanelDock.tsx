import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { DockLayout, DropTarget, PanelId } from '../lib/layout'
import { movePanel, resizePanels } from '../lib/layout'

export interface DockPanelDef {
  title: string
  /** Usage hint shown as the title tooltip on the heading. */
  hint: string
  /** Right-aligned head content: gear menus, extra buttons. */
  headExtra?: ReactNode
  collapsed?: boolean
  onCollapsed?: (c: boolean) => void
  children: ReactNode
}

interface PanelDockProps {
  layout: DockLayout
  onLayout: (l: DockLayout) => void
  panels: Record<PanelId, DockPanelDef>
}

const DRAG_THRESHOLD = 6

interface RowRect {
  top: number
  bottom: number
  left: number
  right: number
}

interface PanelRect {
  row: number
  index: number
  left: number
  right: number
}

/** Drop-indicator geometry, in dock-root-relative pixels. */
type Indicator =
  | { kind: 'row'; y: number }
  | { kind: 'beside'; x: number; top: number; height: number }

/** Where the drop indicator draws for a target, from the drag-start rects. */
function indicatorFor(
  t: DropTarget,
  rows: RowRect[],
  prects: PanelRect[],
  rootTop: number,
  rootLeft: number,
): Indicator | null {
  if (rows.length === 0) return null
  if (t.kind === 'row') {
    const y = t.index >= rows.length ? rows[rows.length - 1].bottom : rows[t.index].top
    return { kind: 'row', y: y - rootTop - 2 }
  }
  const row = rows[t.row]
  if (row === undefined) return null
  const inRow = prects.filter((p) => p.row === t.row)
  const x = t.index >= inRow.length ? row.right : inRow[t.index].left
  return {
    kind: 'beside',
    x: x - rootLeft - 2,
    top: row.top - rootTop,
    height: row.bottom - row.top,
  }
}

/**
 * The dock: rows of draggable, resizable panels.
 *
 * Dragging a panel's head moves the panel — drop zones are the left/right
 * halves of each panel (insert beside it) and the outer fifths of each row
 * (a new row above/below). The divider between two panels in a row drags
 * their shared boundary. All geometry is measured at gesture start, so a
 * reflow mid-drag cannot make targets jump under the pointer.
 */
export function PanelDock({ layout, onLayout, panels }: PanelDockProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [dragId, setDragId] = useState<PanelId | null>(null)
  const [indicator, setIndicator] = useState<Indicator | null>(null)
  const targetRef = useRef<DropTarget | null>(null)
  const drag = useRef<{
    id: PanelId
    startX: number
    startY: number
    live: boolean
    rows: RowRect[]
    panels: PanelRect[]
    rootTop: number
    rootLeft: number
  } | null>(null)
  const resize = useRef<{
    row: number
    index: number
    startX: number
    rowWidth: number
    base: DockLayout
  } | null>(null)

  const measure = () => {
    const root = rootRef.current
    const rows: RowRect[] = []
    const prects: PanelRect[] = []
    if (root === null) return { rows, panels: prects, rootTop: 0, rootLeft: 0 }
    const rootRect = root.getBoundingClientRect()
    root.querySelectorAll<HTMLElement>('.dock-row').forEach((rowEl, r) => {
      const rect = rowEl.getBoundingClientRect()
      rows.push({ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right })
      let i = 0
      rowEl.querySelectorAll<HTMLElement>(':scope > .dock-cell > .dock-panel').forEach((pEl) => {
        const pr = pEl.getBoundingClientRect()
        prects.push({ row: r, index: i, left: pr.left, right: pr.right })
        i += 1
      })
    })
    return { rows, panels: prects, rootTop: rootRect.top, rootLeft: rootRect.left }
  }

  /** The drop this pointer position means: a new row in a row's outer fifths, beside a panel elsewhere. */
  const targetAt = (
    x: number,
    y: number,
    rows: RowRect[],
    prects: PanelRect[],
  ): DropTarget | null => {
    if (rows.length === 0) return null
    if (y < rows[0].top) return { kind: 'row', index: 0 }
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r]
      if (y > row.bottom) continue
      const h = Math.max(1, row.bottom - row.top)
      if (y < row.top + h * 0.2) return { kind: 'row', index: r }
      if (y > row.bottom - h * 0.2) return { kind: 'row', index: r + 1 }
      const inRow = prects.filter((p) => p.row === r)
      for (const p of inRow) {
        if (x <= (p.left + p.right) / 2) return { kind: 'beside', row: r, index: p.index }
      }
      return { kind: 'beside', row: r, index: inRow.length }
    }
    return { kind: 'row', index: rows.length }
  }

  const onHeadPointerDown = (e: React.PointerEvent, id: PanelId) => {
    if (e.button !== 0) return
    // Buttons, inputs and menus in the head keep their own clicks.
    if ((e.target as HTMLElement).closest('button, input, select, label, a')) return
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    drag.current = { id, startX: e.clientX, startY: e.clientY, live: false, ...measure() }
  }

  const onHeadPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (d === null) return
    if (!d.live) {
      if (Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) < DRAG_THRESHOLD) return
      d.live = true
      setDragId(d.id)
    }
    const t = targetAt(e.clientX, e.clientY, d.rows, d.panels)
    targetRef.current = t
    setIndicator(t === null ? null : indicatorFor(t, d.rows, d.panels, d.rootTop, d.rootLeft))
  }

  const onHeadPointerUp = () => {
    const d = drag.current
    drag.current = null
    setDragId(null)
    const t = targetRef.current
    targetRef.current = null
    setIndicator(null)
    if (d === null || !d.live || t === null) return
    onLayout(movePanel(layout, d.id, t))
  }

  const onDividerDown = (e: React.PointerEvent, row: number, index: number) => {
    if (e.button !== 0) return
    e.preventDefault()
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    const rowEl = rootRef.current?.querySelectorAll<HTMLElement>('.dock-row')[row]
    const width = rowEl?.getBoundingClientRect().width ?? 1
    resize.current = { row, index, startX: e.clientX, rowWidth: Math.max(1, width), base: layout }
  }

  const onDividerMove = (e: React.PointerEvent) => {
    const s = resize.current
    if (s === null) return
    onLayout(resizePanels(s.base, s.row, s.index, (e.clientX - s.startX) / s.rowWidth))
  }

  const onDividerUp = () => {
    resize.current = null
  }

  return (
    <div className="dock" ref={rootRef}>
      {layout.rows.map((row, r) => {
        const hasBuckets = row.panels.some((p) => p.id === 'buckets')
        return (
          <div className="dock-row" key={row.panels.map((p) => p.id).join('+')}>
            {row.panels.map((p, i) => {
              const def = panels[p.id]
              // Sticky is only useful (and safe) beside the tall buckets table.
              const sticky = p.id === 'chart' && hasBuckets && row.panels.length > 1
              return (
                <div
                  key={p.id}
                  className={`dock-cell ${dragId === p.id ? 'dragging' : ''}`}
                  style={{ flexGrow: p.size, flexBasis: 0 }}
                >
                  {i > 0 && (
                    <div
                      className="dock-divider"
                      role="separator"
                      aria-orientation="vertical"
                      title="Drag to resize"
                      onPointerDown={(e) => onDividerDown(e, r, i - 1)}
                      onPointerMove={onDividerMove}
                      onPointerUp={onDividerUp}
                      onPointerCancel={onDividerUp}
                    />
                  )}
                  <section
                    className={`panel dock-panel ${p.id === 'groupDist' ? 'group-dist' : p.id} ${sticky ? 'dock-sticky' : ''}`}
                  >
                    <div
                      className="panel-head dock-head"
                      title="Drag to move this panel"
                      onPointerDown={(e) => onHeadPointerDown(e, p.id)}
                      onPointerMove={onHeadPointerMove}
                      onPointerUp={onHeadPointerUp}
                      onPointerCancel={onHeadPointerUp}
                    >
                      {def.onCollapsed !== undefined && (
                        <button
                          type="button"
                          className="panel-collapse"
                          aria-expanded={!def.collapsed}
                          onClick={() => def.onCollapsed?.(!def.collapsed)}
                          title={def.collapsed ? `Show ${def.title}` : `Hide ${def.title}`}
                        >
                          <span className="chev" aria-hidden="true">
                            {def.collapsed ? '▸' : '▾'}
                          </span>
                        </button>
                      )}
                      <h2 title={def.hint}>{def.title}</h2>
                      {def.headExtra}
                    </div>
                    {!def.collapsed && def.children}
                  </section>
                </div>
              )
            })}
          </div>
        )
      })}
      {dragId !== null &&
        indicator !== null &&
        (indicator.kind === 'row' ? (
          <div className="dock-drop-row" style={{ top: indicator.y }} />
        ) : (
          <div
            className="dock-drop-beside"
            style={{ left: indicator.x, top: indicator.top, height: indicator.height }}
          />
        ))}
    </div>
  )
}
