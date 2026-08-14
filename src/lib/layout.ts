/**
 * The dock: a tree of splits. Each split is 'row' (children side by side,
 * fractional flex-grow, user-resizable) or 'col' (children stacked, each at
 * its natural height — the top-level layout has always worked this way, and
 * nesting a 'col' split inside a 'row' cell is what gives two panels stacked
 * beside a third full-height one). Pure data + operations; PanelDock.tsx
 * turns pointer gestures into these calls.
 */
export type PanelId = 'groupDist' | 'buckets' | 'chart'
export type Dir = 'row' | 'col'

export interface DockLeaf {
  type: 'leaf'
  id: PanelId
  /** Share of the parent row's width; ignored by a 'col' parent. */
  size: number
}

export interface DockSplit {
  type: 'split'
  dir: Dir
  /** Share of the parent row's width; ignored by a 'col' parent (and by the root). */
  size: number
  children: DockNode[]
}

export type DockNode = DockLeaf | DockSplit

export interface DockLayout {
  root: DockNode
}

export const PANEL_IDS: PanelId[] = ['groupDist', 'buckets', 'chart']
export const MIN_SIZE = 0.15

export const DEFAULT_LAYOUT: DockLayout = {
  root: {
    type: 'split',
    dir: 'col',
    size: 1,
    children: [
      { type: 'leaf', id: 'groupDist', size: 1 },
      {
        type: 'split',
        dir: 'row',
        size: 1,
        children: [
          { type: 'leaf', id: 'buckets', size: 0.5 },
          { type: 'leaf', id: 'chart', size: 0.5 },
        ],
      },
    ],
  },
}

/** Drop a dragged panel before/after `relativeTo`, splitting along `axis` at that point. */
export type DropTarget = { relativeTo: PanelId; axis: Dir; side: 'before' | 'after' }

function isDockNode(v: unknown): v is DockNode {
  if (typeof v !== 'object' || v === null) return false
  const n = v as { type?: unknown; size?: unknown }
  if (typeof n.size !== 'number' || !Number.isFinite(n.size) || n.size <= 0) return false
  if (n.type === 'leaf') return (PANEL_IDS as string[]).includes((n as { id?: unknown }).id as string)
  if (n.type === 'split') {
    const sp = n as { dir?: unknown; children?: unknown }
    if (sp.dir !== 'row' && sp.dir !== 'col') return false
    return Array.isArray(sp.children) && sp.children.length > 0 && sp.children.every(isDockNode)
  }
  return false
}

function collectLeafIds(n: DockNode, out: PanelId[]): void {
  if (n.type === 'leaf') out.push(n.id)
  else n.children.forEach((c) => collectLeafIds(c, out))
}

export function isDockLayout(v: unknown): v is DockLayout {
  if (typeof v !== 'object' || v === null) return false
  const root = (v as { root?: unknown }).root
  if (!isDockNode(root)) return false
  const ids: PanelId[] = []
  collectLeafIds(root, ids)
  return ids.length === PANEL_IDS.length && new Set(ids).size === PANEL_IDS.length
}

function normalizeNode(n: DockNode): DockNode {
  if (n.type === 'leaf') return n
  const children = n.children.map(normalizeNode)
  // A split left with one child (by removal elsewhere) is a no-op wrapper —
  // collapse it into that child, keeping the child's own size private.
  if (children.length === 1) return children[0]
  const sum = children.reduce((a, c) => a + Math.max(MIN_SIZE, c.size), 0)
  return { ...n, children: children.map((c) => ({ ...c, size: Math.max(MIN_SIZE, c.size) / sum })) }
}

export function normalizeLayout(l: DockLayout): DockLayout {
  return { root: { ...normalizeNode(l.root), size: 1 } }
}

/** Remove a leaf by id, pruning any split it leaves empty. */
function removeLeaf(n: DockNode, id: PanelId): { node: DockNode | null; removed: boolean } {
  if (n.type === 'leaf') return n.id === id ? { node: null, removed: true } : { node: n, removed: false }
  let removed = false
  const children: DockNode[] = []
  for (const c of n.children) {
    if (removed) {
      children.push(c)
      continue
    }
    const r = removeLeaf(c, id)
    if (r.removed) removed = true
    if (r.node !== null) children.push(r.node)
  }
  if (!removed) return { node: n, removed: false }
  if (children.length === 0) return { node: null, removed: true }
  return { node: { ...n, children }, removed: true }
}

/**
 * Insert `newId` before/after the `target` leaf. When target's immediate
 * parent already splits along `axis`, the new leaf becomes a sibling there;
 * otherwise the target leaf is wrapped in a fresh split along `axis` — this
 * is what lets any leaf gain a stacked (or side-by-side) neighbor regardless
 * of how the rest of the tree is arranged.
 */
function insertBeside(
  n: DockNode,
  target: PanelId,
  axis: Dir,
  side: 'before' | 'after',
  newId: PanelId,
): { node: DockNode; inserted: boolean } {
  if (n.type === 'leaf') {
    if (n.id !== target) return { node: n, inserted: false }
    const newLeaf: DockLeaf = { type: 'leaf', id: newId, size: n.size }
    const children = side === 'before' ? [newLeaf, { ...n }] : [{ ...n }, newLeaf]
    return { node: { type: 'split', dir: axis, size: n.size, children }, inserted: true }
  }
  const idx = n.children.findIndex((c) => c.type === 'leaf' && c.id === target)
  if (idx !== -1 && n.dir === axis) {
    const at = side === 'before' ? idx : idx + 1
    const children = [...n.children]
    children.splice(at, 0, { type: 'leaf', id: newId, size: 1 / (children.length + 1) })
    return { node: { ...n, children }, inserted: true }
  }
  let inserted = false
  const children = n.children.map((c) => {
    if (inserted) return c
    const r = insertBeside(c, target, axis, side, newId)
    if (r.inserted) inserted = true
    return r.node
  })
  return { node: { ...n, children }, inserted }
}

/**
 * Move a panel to a drop target. Coordinates are resolved by the caller
 * against the layout as it stands (a target leaf id + side), so removal
 * never needs index adjustment the way a flat model would.
 */
export function movePanel(l: DockLayout, id: PanelId, target: DropTarget): DockLayout {
  if (target.relativeTo === id) return normalizeLayout(l)
  const removal = removeLeaf(l.root, id)
  if (!removal.removed || removal.node === null) return normalizeLayout(l)
  const ins = insertBeside(removal.node, target.relativeTo, target.axis, target.side, id)
  if (!ins.inserted) return normalizeLayout(l)
  return normalizeLayout({ root: ins.node })
}

/**
 * Shift the boundary between two adjacent children of the row split found by
 * walking `path` (child indices from the root). Only 'row' splits are
 * resizable — 'col' splits stack at natural height, as they always have.
 */
export function resizePanels(l: DockLayout, path: number[], index: number, delta: number): DockLayout {
  function go(n: DockNode, rest: number[]): DockNode {
    if (rest.length === 0) {
      if (n.type !== 'split' || n.children[index] === undefined || n.children[index + 1] === undefined) {
        return n
      }
      const a = n.children[index].size
      const b = n.children[index + 1].size
      const d = Math.max(MIN_SIZE - a, Math.min(delta, b - MIN_SIZE))
      const children = n.children.map((c, j) =>
        j === index ? { ...c, size: a + d } : j === index + 1 ? { ...c, size: b - d } : c,
      )
      return { ...n, children }
    }
    if (n.type === 'leaf') return n
    const [head, ...tail] = rest
    if (n.children[head] === undefined) return n
    return { ...n, children: n.children.map((c, j) => (j === head ? go(c, tail) : c)) }
  }
  return { root: go(l.root, path) }
}

/**
 * Whether `a` and `b` sit in the same 'row' split — the nearest 'row'
 * ancestor of `a` contains `b` somewhere in its subtree. Used for the
 * distribution chart's auto-fit height, which only makes sense while the
 * chart's flex height is actually coupled to the buckets table's.
 */
export function panelsShareRow(l: DockLayout, a: PanelId, b: PanelId): boolean {
  function findPath(n: DockNode, path: DockSplit[]): DockSplit[] | null {
    if (n.type === 'leaf') return n.id === a ? path : null
    for (const c of n.children) {
      const r = findPath(c, [...path, n])
      if (r !== null) return r
    }
    return null
  }
  const ancestors = findPath(l.root, [])
  if (ancestors === null) return false
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (ancestors[i].dir !== 'row') continue
    const ids: PanelId[] = []
    collectLeafIds(ancestors[i], ids)
    return ids.includes(b)
  }
  return false
}

/** A workspace saved before the dock existed derives its layout from the old chart flags. */
export function migrateLayout(chart?: { swapped?: boolean; forceStack?: boolean }): DockLayout {
  if (chart?.forceStack === true) {
    return {
      root: {
        type: 'split',
        dir: 'col',
        size: 1,
        children: [
          { type: 'leaf', id: 'groupDist', size: 1 },
          { type: 'leaf', id: 'buckets', size: 1 },
          { type: 'leaf', id: 'chart', size: 1 },
        ],
      },
    }
  }
  if (chart?.swapped === true) {
    return {
      root: {
        type: 'split',
        dir: 'col',
        size: 1,
        children: [
          { type: 'leaf', id: 'groupDist', size: 1 },
          {
            type: 'split',
            dir: 'row',
            size: 1,
            children: [
              { type: 'leaf', id: 'chart', size: 0.5 },
              { type: 'leaf', id: 'buckets', size: 0.5 },
            ],
          },
        ],
      },
    }
  }
  return DEFAULT_LAYOUT
}

/** A workspace saved by the pre-tree dock (flat rows of panels) — used by storage.ts to migrate old saves. */
export interface LegacyDockLayout {
  rows: { panels: { id: PanelId; size: number }[] }[]
}

export function isLegacyDockLayout(v: unknown): v is LegacyDockLayout {
  if (typeof v !== 'object' || v === null || !Array.isArray((v as LegacyDockLayout).rows)) return false
  const seen = new Set<string>()
  for (const row of (v as LegacyDockLayout).rows) {
    if (typeof row !== 'object' || row === null || !Array.isArray(row.panels) || row.panels.length === 0) {
      return false
    }
    for (const p of row.panels) {
      if (typeof p !== 'object' || p === null) return false
      if (!(PANEL_IDS as string[]).includes(p.id) || seen.has(p.id)) return false
      if (typeof p.size !== 'number' || !Number.isFinite(p.size) || p.size <= 0) return false
      seen.add(p.id)
    }
  }
  return seen.size === PANEL_IDS.length
}

export function migrateLegacyLayout(l: LegacyDockLayout): DockLayout {
  const rows = l.rows.filter((r) => r.panels.length > 0)
  const children: DockNode[] = rows.map((r) =>
    r.panels.length === 1
      ? { type: 'leaf', id: r.panels[0].id, size: 1 }
      : { type: 'split', dir: 'row', size: 1, children: r.panels.map((p) => ({ type: 'leaf', ...p })) },
  )
  if (children.length === 1) return normalizeLayout({ root: children[0] })
  return normalizeLayout({ root: { type: 'split', dir: 'col', size: 1, children } })
}
