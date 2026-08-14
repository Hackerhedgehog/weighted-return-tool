import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LAYOUT,
  isDockLayout,
  isLegacyDockLayout,
  migrateLayout,
  migrateLegacyLayout,
  movePanel,
  normalizeLayout,
  panelsShareRow,
  resizePanels,
  type DockLayout,
  type DockNode,
  type LegacyDockLayout,
} from './layout'

/** A compact, order-preserving shape for assertions: leaves as ids, splits as [dir, ...children]. */
type Shape = string | [string, ...Shape[]]
const shape = (n: DockNode): Shape => (n.type === 'leaf' ? n.id : [n.dir, ...n.children.map(shape)])
const s = (l: DockLayout) => shape(l.root)

describe('layout', () => {
  it('default is groupDist above a buckets+chart row', () => {
    expect(s(DEFAULT_LAYOUT)).toEqual(['col', 'groupDist', ['row', 'buckets', 'chart']])
  })

  it('validates: every panel exactly once', () => {
    expect(isDockLayout(DEFAULT_LAYOUT)).toBe(true)
    expect(isDockLayout({ root: { type: 'leaf', id: 'buckets', size: 1 } })).toBe(false)
    expect(
      isDockLayout({
        root: {
          type: 'split',
          dir: 'row',
          size: 1,
          children: [
            { type: 'leaf', id: 'buckets', size: 1 },
            { type: 'leaf', id: 'buckets', size: 1 },
            { type: 'leaf', id: 'chart', size: 1 },
          ],
        },
      }),
    ).toBe(false)
    expect(isDockLayout({ root: { type: 'split', dir: 'row', size: 1, children: [] } })).toBe(false)
    expect(isDockLayout(null)).toBe(false)
  })

  it('moves a panel beside another, within the same split', () => {
    const next = movePanel(DEFAULT_LAYOUT, 'groupDist', { relativeTo: 'chart', axis: 'row', side: 'after' })
    expect(s(next)).toEqual(['row', 'buckets', 'chart', 'groupDist'])
    const row = next.root as { type: 'split'; children: DockNode[] }
    expect(row.children.reduce((a, c) => a + c.size, 0)).toBeCloseTo(1, 9)
  })

  it('wraps the target leaf in a new split when dropped on a different axis', () => {
    // groupDist dropped above chart (col axis) inside the buckets+chart row
    // nests a column split in chart's place: 2 stacked on the right, buckets alone on the left.
    const next = movePanel(DEFAULT_LAYOUT, 'groupDist', { relativeTo: 'chart', axis: 'col', side: 'before' })
    expect(s(next)).toEqual(['row', 'buckets', ['col', 'groupDist', 'chart']])
  })

  it('a move onto its own position is identity', () => {
    const next = movePanel(DEFAULT_LAYOUT, 'buckets', { relativeTo: 'chart', axis: 'row', side: 'before' })
    expect(s(next)).toEqual(s(DEFAULT_LAYOUT))
  })

  it('dropping a panel beside itself is a no-op', () => {
    expect(
      s(movePanel(DEFAULT_LAYOUT, 'groupDist', { relativeTo: 'groupDist', axis: 'col', side: 'before' })),
    ).toEqual(s(DEFAULT_LAYOUT))
  })

  it('removing a panel collapses a now-singleton split', () => {
    // Move buckets out of its row entirely (above groupDist) — the row it
    // leaves behind has only chart in it, so the row wrapper collapses away.
    const next = movePanel(DEFAULT_LAYOUT, 'buckets', { relativeTo: 'groupDist', axis: 'col', side: 'before' })
    expect(s(next)).toEqual(['col', 'buckets', 'groupDist', 'chart'])
  })

  it('resize shifts the shared boundary of a row split and respects MIN_SIZE', () => {
    const rowAt = (l: DockLayout) =>
      ((l.root as { type: 'split'; children: DockNode[] }).children[1] as { children: DockNode[] }).children
    const next = resizePanels(DEFAULT_LAYOUT, [1], 0, 0.2)
    expect(rowAt(next)[0].size).toBeCloseTo(0.7, 9)
    expect(rowAt(next)[1].size).toBeCloseTo(0.3, 9)
    const clamped = resizePanels(DEFAULT_LAYOUT, [1], 0, -10)
    expect(rowAt(clamped)[0].size).toBeCloseTo(0.15, 9)
  })

  it('normalize collapses singleton splits and renormalizes sizes', () => {
    const messy: DockLayout = {
      root: {
        type: 'split',
        dir: 'col',
        size: 1,
        children: [
          {
            type: 'split',
            dir: 'row',
            size: 1,
            children: [
              { type: 'leaf', id: 'groupDist', size: 2 },
              { type: 'leaf', id: 'buckets', size: 2 },
            ],
          },
          {
            type: 'split',
            dir: 'row',
            size: 1,
            children: [{ type: 'leaf', id: 'chart', size: 0.4 }],
          },
        ],
      },
    }
    const next = normalizeLayout(messy)
    expect(s(next)).toEqual(['col', ['row', 'groupDist', 'buckets'], 'chart'])
    const top = next.root as { type: 'split'; children: DockNode[] }
    const firstRow = top.children[0] as { type: 'split'; children: DockNode[] }
    expect(firstRow.children.map((c) => c.size)).toEqual([0.5, 0.5])
  })

  it('migrates a pre-tree flat layout (old rows-of-panels save)', () => {
    const legacy: LegacyDockLayout = {
      rows: [
        { panels: [{ id: 'groupDist', size: 1 }] },
        {
          panels: [
            { id: 'chart', size: 0.4 },
            { id: 'buckets', size: 0.6 },
          ],
        },
      ],
    }
    expect(isLegacyDockLayout(legacy)).toBe(true)
    expect(isLegacyDockLayout(DEFAULT_LAYOUT)).toBe(false)
    expect(s(migrateLegacyLayout(legacy))).toEqual(['col', 'groupDist', ['row', 'chart', 'buckets']])
  })

  it('supports 2 stacked beside 1 full-height, on either side', () => {
    // groupDist dropped above buckets (col axis, within the row): buckets
    // gains a stacked neighbor while chart stays full-height beside them.
    const leftPair = movePanel(DEFAULT_LAYOUT, 'groupDist', {
      relativeTo: 'buckets',
      axis: 'col',
      side: 'before',
    })
    expect(s(leftPair)).toEqual(['row', ['col', 'groupDist', 'buckets'], 'chart'])

    // Mirror: groupDist dropped below chart puts the tall panel on the left.
    const rightPair = movePanel(DEFAULT_LAYOUT, 'groupDist', {
      relativeTo: 'chart',
      axis: 'col',
      side: 'after',
    })
    expect(s(rightPair)).toEqual(['row', 'buckets', ['col', 'chart', 'groupDist']])
  })

  it('panelsShareRow is true only for leaves under the same row split', () => {
    expect(panelsShareRow(DEFAULT_LAYOUT, 'chart', 'buckets')).toBe(true)
    expect(panelsShareRow(DEFAULT_LAYOUT, 'chart', 'groupDist')).toBe(false)
    const stacked = movePanel(DEFAULT_LAYOUT, 'buckets', { relativeTo: 'chart', axis: 'col', side: 'before' })
    // buckets now stacked above chart, inside a col split nested in the row —
    // chart no longer shares a row split with buckets.
    expect(panelsShareRow(stacked, 'chart', 'buckets')).toBe(false)
  })

  it('migrates legacy chart flags', () => {
    expect(s(migrateLayout({ swapped: true }))).toEqual(['col', 'groupDist', ['row', 'chart', 'buckets']])
    expect(s(migrateLayout({ forceStack: true }))).toEqual(['col', 'groupDist', 'buckets', 'chart'])
    expect(s(migrateLayout(undefined))).toEqual(s(DEFAULT_LAYOUT))
  })
})
