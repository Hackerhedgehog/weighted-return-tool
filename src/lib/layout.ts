/**
 * The dock: ordered rows of 1–3 panels. Sizes are fractions of the row, so a
 * layout survives any window width. Pure data + operations; PanelDock.tsx
 * turns pointer gestures into these calls.
 */
export type PanelId = 'groupDist' | 'buckets' | 'chart'

export interface DockPanel {
  id: PanelId
  size: number
}

export interface DockLayout {
  rows: { panels: DockPanel[] }[]
}

export const PANEL_IDS: PanelId[] = ['groupDist', 'buckets', 'chart']
export const MIN_SIZE = 0.15

export const DEFAULT_LAYOUT: DockLayout = {
  rows: [
    { panels: [{ id: 'groupDist', size: 1 }] },
    {
      panels: [
        { id: 'buckets', size: 0.5 },
        { id: 'chart', size: 0.5 },
      ],
    },
  ],
}

export type DropTarget =
  | { kind: 'beside'; row: number; index: number }
  | { kind: 'row'; index: number }

export function isDockLayout(v: unknown): v is DockLayout {
  if (typeof v !== 'object' || v === null || !Array.isArray((v as DockLayout).rows)) return false
  const seen = new Set<string>()
  for (const row of (v as DockLayout).rows) {
    if (typeof row !== 'object' || row === null || !Array.isArray(row.panels)) return false
    if (row.panels.length === 0) return false
    for (const p of row.panels) {
      if (typeof p !== 'object' || p === null) return false
      if (!(PANEL_IDS as string[]).includes(p.id) || seen.has(p.id)) return false
      if (typeof p.size !== 'number' || !Number.isFinite(p.size) || p.size <= 0) return false
      seen.add(p.id)
    }
  }
  return seen.size === PANEL_IDS.length
}

export function normalizeLayout(l: DockLayout): DockLayout {
  const rows = l.rows
    .filter((r) => r.panels.length > 0)
    .map((r) => {
      const sum = r.panels.reduce((a, p) => a + Math.max(MIN_SIZE, p.size), 0)
      return { panels: r.panels.map((p) => ({ ...p, size: Math.max(MIN_SIZE, p.size) / sum })) }
    })
  return { rows }
}

/**
 * Move a panel to a drop target. The target's coordinates are computed by the
 * caller against the layout as it stands — removal shifts row and panel
 * indices, so they are adjusted here rather than pushed onto every caller.
 */
export function movePanel(l: DockLayout, id: PanelId, target: DropTarget): DockLayout {
  const srcRow = l.rows.findIndex((r) => r.panels.some((p) => p.id === id))
  if (srcRow === -1) return l
  const srcIndex = l.rows[srcRow].panels.findIndex((p) => p.id === id)
  const rows = l.rows.map((r) => ({ panels: r.panels.filter((p) => p.id !== id) }))
  const emptied = rows[srcRow].panels.length === 0

  if (target.kind === 'beside') {
    let { row, index } = target
    // Dropping a lone panel beside itself in its own row is a no-op.
    if (emptied && row === srcRow) return normalizeLayout(l)
    if (row === srcRow && index > srcIndex) index -= 1
    if (emptied && row > srcRow) row -= 1
    const kept = rows.filter((_, i) => !(emptied && i === srcRow))
    const dest = kept[row]
    if (dest === undefined) return normalizeLayout(l)
    dest.panels.splice(Math.min(index, dest.panels.length), 0, {
      id,
      size: 1 / (dest.panels.length + 1),
    })
    return normalizeLayout({ rows: kept })
  }

  let at = target.index
  // A lone panel dropped into the gap directly above or below its own row
  // would land exactly where it already is.
  if (emptied && (at === srcRow || at === srcRow + 1)) return normalizeLayout(l)
  if (emptied && at > srcRow) at -= 1
  const kept = rows.filter((_, i) => !(emptied && i === srcRow))
  kept.splice(Math.min(at, kept.length), 0, { panels: [{ id, size: 1 }] })
  return normalizeLayout({ rows: kept })
}

/** Shift the boundary between panels[index] and panels[index+1] by a fraction of the row. */
export function resizePanels(
  l: DockLayout,
  row: number,
  index: number,
  delta: number,
): DockLayout {
  const r = l.rows[row]
  if (r === undefined || r.panels[index] === undefined || r.panels[index + 1] === undefined) {
    return l
  }
  const a = r.panels[index].size
  const b = r.panels[index + 1].size
  const d = Math.max(MIN_SIZE - a, Math.min(delta, b - MIN_SIZE))
  const rows = l.rows.map((rr, i) =>
    i !== row
      ? rr
      : {
          panels: rr.panels.map((p, j) =>
            j === index ? { ...p, size: a + d } : j === index + 1 ? { ...p, size: b - d } : p,
          ),
        },
  )
  return { rows }
}

/** A workspace saved before the dock existed derives its layout from the old chart flags. */
export function migrateLayout(chart?: { swapped?: boolean; forceStack?: boolean }): DockLayout {
  if (chart?.forceStack === true) {
    return {
      rows: [
        { panels: [{ id: 'groupDist', size: 1 }] },
        { panels: [{ id: 'buckets', size: 1 }] },
        { panels: [{ id: 'chart', size: 1 }] },
      ],
    }
  }
  if (chart?.swapped === true) {
    return {
      rows: [
        { panels: [{ id: 'groupDist', size: 1 }] },
        {
          panels: [
            { id: 'chart', size: 0.5 },
            { id: 'buckets', size: 0.5 },
          ],
        },
      ],
    }
  }
  return DEFAULT_LAYOUT
}
