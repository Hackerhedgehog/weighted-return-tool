import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { DockNode, DockLayout, DropTarget, PanelId } from '../lib/layout'
import { movePanel, panelsShareRow, resizePanels } from '../lib/layout'

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
/** Fraction of a leaf's own edge, on the axis the pointer is nearer to, that means "stack" rather than "beside". */
const EDGE_FRACTION = 0.25

interface LeafRect {
  id: PanelId
  left: number
  right: number
  top: number
  bottom: number
}

/** Which leaf a point falls over, and the drop it means relative to that leaf's own quadrant. */
function targetAt(x: number, y: number, leaves: LeafRect[]): DropTarget | null {
  let hit: LeafRect | null = null
  for (const l of leaves) {
    if (x >= l.left && x <= l.right && y >= l.top && y <= l.bottom) {
      hit = l
      break
    }
  }
  if (hit === null) return null
  const h = Math.max(1, hit.bottom - hit.top)
  const w = Math.max(1, hit.right - hit.left)
  if (y < hit.top + h * EDGE_FRACTION) return { relativeTo: hit.id, axis: 'col', side: 'before' }
  if (y > hit.bottom - h * EDGE_FRACTION) return { relativeTo: hit.id, axis: 'col', side: 'after' }
  return x < hit.left + w / 2
    ? { relativeTo: hit.id, axis: 'row', side: 'before' }
    : { relativeTo: hit.id, axis: 'row', side: 'after' }
}

/** Drop-indicator geometry, dock-root-relative pixels, drawn along the edge of the target leaf the drop would split. */
function indicatorFor(t: DropTarget, leaves: LeafRect[], rootTop: number, rootLeft: number) {
  const l = leaves.find((r) => r.id === t.relativeTo)
  if (l === undefined) return null
  if (t.axis === 'col') {
    const y = (t.side === 'before' ? l.top : l.bottom) - rootTop
    return { left: l.left - rootLeft, width: l.right - l.left, top: y - 2, height: 4 }
  }
  const x = (t.side === 'before' ? l.left : l.right) - rootLeft
  return { left: x - 2, width: 4, top: l.top - rootTop, height: l.bottom - l.top }
}

interface DockPanelProps {
  def: DockPanelDef
  id: PanelId
  dragging: boolean
  sticky: boolean
  onHeadDown: (e: React.PointerEvent, id: PanelId) => void
  onHeadMove: (e: React.PointerEvent) => void
  onHeadUp: () => void
}

function DockPanel({ def, id, dragging, sticky, onHeadDown, onHeadMove, onHeadUp }: DockPanelProps) {
  return (
    <section
      className={`panel dock-panel dock-leaf ${id === 'groupDist' ? 'group-dist' : id} ${sticky ? 'dock-sticky' : ''} ${dragging ? 'dragging' : ''}`}
      data-panel-id={id}
    >
      <div
        className="panel-head dock-head"
        title="Drag to move this panel"
        onPointerDown={(e) => onHeadDown(e, id)}
        onPointerMove={onHeadMove}
        onPointerUp={onHeadUp}
        onPointerCancel={onHeadUp}
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
        <h2
          title={def.hint}
          className={def.onCollapsed !== undefined ? 'collapse-toggle' : undefined}
          onClick={def.onCollapsed !== undefined ? () => def.onCollapsed?.(!def.collapsed) : undefined}
        >
          {def.title}
        </h2>
        {def.headExtra}
      </div>
      {!def.collapsed && def.children}
    </section>
  )
}

/**
 * The dock: a tree of draggable, resizable panels (see lib/layout.ts).
 *
 * Dragging a panel's head moves it — the drop target is read off whichever
 * leaf panel the pointer sits over: its outer top/bottom quarters stack the
 * dragged panel above/below it, its left/right halves put it beside. Because
 * that quadrant test is per-leaf rather than per-row, nesting falls out for
 * free — dropping above one panel in a row gives that one panel a stacked
 * neighbor while the rest of the row is untouched. Only 'row' splits get a
 * divider between siblings; 'col' splits stack at natural height, as the top
 * level always has. All geometry is measured at gesture start, so a reflow
 * mid-drag cannot make targets jump under the pointer.
 */
export function PanelDock({ layout, onLayout, panels }: PanelDockProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [dragId, setDragId] = useState<PanelId | null>(null)
  const [indicator, setIndicator] = useState<ReturnType<typeof indicatorFor>>(null)
  const targetRef = useRef<DropTarget | null>(null)
  const drag = useRef<{
    id: PanelId
    startX: number
    startY: number
    live: boolean
    leaves: LeafRect[]
    rootTop: number
    rootLeft: number
  } | null>(null)
  const resize = useRef<{
    path: number[]
    index: number
    startX: number
    rowWidth: number
    base: DockLayout
  } | null>(null)

  const measureLeaves = (): LeafRect[] => {
    const root = rootRef.current
    if (root === null) return []
    return [...root.querySelectorAll<HTMLElement>('.dock-leaf')].map((el) => {
      const r = el.getBoundingClientRect()
      return { id: el.dataset.panelId as PanelId, left: r.left, right: r.right, top: r.top, bottom: r.bottom }
    })
  }

  const onHeadPointerDown = (e: React.PointerEvent, id: PanelId) => {
    if (e.button !== 0) return
    // Buttons, inputs, menus and the collapsible heading in the head keep
    // their own clicks — the heading toggles the fold, it must not also
    // start a panel-move drag.
    if ((e.target as HTMLElement).closest('button, input, select, label, a, h2')) return
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    const root = rootRef.current
    const rootRect = root?.getBoundingClientRect()
    drag.current = {
      id,
      startX: e.clientX,
      startY: e.clientY,
      live: false,
      leaves: measureLeaves(),
      rootTop: rootRect?.top ?? 0,
      rootLeft: rootRect?.left ?? 0,
    }
  }

  const onHeadPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (d === null) return
    if (!d.live) {
      if (Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) < DRAG_THRESHOLD) return
      d.live = true
      setDragId(d.id)
    }
    // A drop target must be a different leaf — dragging over the panel's own
    // rect (still present in the measured leaves) is not a valid drop.
    const others = d.leaves.filter((l) => l.id !== d.id)
    const t = targetAt(e.clientX, e.clientY, others)
    targetRef.current = t
    setIndicator(t === null ? null : indicatorFor(t, others, d.rootTop, d.rootLeft))
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

  const onDividerDown = (e: React.PointerEvent, path: number[], index: number, rowEl: HTMLElement | null) => {
    if (e.button !== 0) return
    e.preventDefault()
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    const width = rowEl?.getBoundingClientRect().width ?? 1
    resize.current = { path, index, startX: e.clientX, rowWidth: Math.max(1, width), base: layout }
  }

  const onDividerMove = (e: React.PointerEvent) => {
    const s = resize.current
    if (s === null) return
    onLayout(resizePanels(s.base, s.path, s.index, (e.clientX - s.startX) / s.rowWidth))
  }

  const onDividerUp = () => {
    resize.current = null
  }

  /** True while `id` (or an ancestor split containing it) is the panel being dragged. */
  const containsDragging = (n: DockNode): boolean =>
    n.type === 'leaf' ? n.id === dragId : n.children.some(containsDragging)

  // Sticky is only useful (and safe) beside the tall buckets table.
  const chartSticky = panelsShareRow(layout, 'chart', 'buckets')

  const renderNode = (n: DockNode, path: number[]): ReactNode => {
    if (n.type === 'leaf') {
      const def = panels[n.id]
      const sticky = n.id === 'chart' && chartSticky
      return (
        <DockPanel
          key={n.id}
          def={def}
          id={n.id}
          dragging={dragId === n.id}
          sticky={sticky}
          onHeadDown={onHeadPointerDown}
          onHeadMove={onHeadPointerMove}
          onHeadUp={onHeadPointerUp}
        />
      )
    }
    const rowElRef = { current: null as HTMLDivElement | null }
    return (
      <div
        className={n.dir === 'row' ? 'dock-row' : 'dock-col'}
        key={path.join('-') || 'root'}
        ref={
          n.dir === 'row'
            ? (el) => {
                rowElRef.current = el
              }
            : undefined
        }
      >
        {n.children.map((c, i) => (
          <div
            className={`dock-cell ${containsDragging(c) ? 'dragging' : ''}`}
            key={c.type === 'leaf' ? c.id : `${path.join('-')}.${i}`}
            style={n.dir === 'row' ? { flexGrow: c.size, flexBasis: 0 } : undefined}
          >
            {i > 0 && n.dir === 'row' && (
              <div
                className="dock-divider"
                role="separator"
                aria-orientation="vertical"
                title="Drag to resize"
                onPointerDown={(e) => onDividerDown(e, path, i - 1, rowElRef.current)}
                onPointerMove={onDividerMove}
                onPointerUp={onDividerUp}
                onPointerCancel={onDividerUp}
              />
            )}
            {renderNode(c, [...path, i])}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="dock" ref={rootRef}>
      {renderNode(layout.root, [])}
      {dragId !== null && indicator !== null && (
        <div
          className="dock-drop-beside"
          style={{ left: indicator.left, top: indicator.top, width: indicator.width, height: indicator.height }}
        />
      )}
    </div>
  )
}
