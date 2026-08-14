import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LAYOUT,
  isDockLayout,
  migrateLayout,
  movePanel,
  normalizeLayout,
  resizePanels,
  type DockLayout,
} from './layout'

const ids = (l: DockLayout) => l.rows.map((r) => r.panels.map((p) => p.id))

describe('layout', () => {
  it('default is groupDist above buckets+chart', () => {
    expect(ids(DEFAULT_LAYOUT)).toEqual([['groupDist'], ['buckets', 'chart']])
  })

  it('validates: every panel exactly once', () => {
    expect(isDockLayout(DEFAULT_LAYOUT)).toBe(true)
    expect(isDockLayout({ rows: [{ panels: [{ id: 'buckets', size: 1 }] }] })).toBe(false)
    expect(
      isDockLayout({
        rows: [
          {
            panels: [
              { id: 'buckets', size: 1 },
              { id: 'buckets', size: 1 },
              { id: 'chart', size: 1 },
            ],
          },
        ],
      }),
    ).toBe(false)
    expect(isDockLayout({ rows: [] })).toBe(false)
    expect(isDockLayout(null)).toBe(false)
  })

  it('moves a panel beside another', () => {
    const next = movePanel(DEFAULT_LAYOUT, 'groupDist', { kind: 'beside', row: 1, index: 2 })
    expect(ids(next)).toEqual([['buckets', 'chart', 'groupDist']])
    expect(next.rows[0].panels.reduce((a, p) => a + p.size, 0)).toBeCloseTo(1, 9)
  })

  it('moves a panel into its own new row, dropping its empty source row', () => {
    const one = movePanel(DEFAULT_LAYOUT, 'groupDist', { kind: 'beside', row: 1, index: 0 })
    expect(ids(one)).toEqual([['groupDist', 'buckets', 'chart']])
    const next = movePanel(one, 'chart', { kind: 'row', index: 1 })
    expect(ids(next)).toEqual([['groupDist', 'buckets'], ['chart']])
  })

  it('a move onto its own position is identity', () => {
    const next = movePanel(DEFAULT_LAYOUT, 'buckets', { kind: 'beside', row: 1, index: 0 })
    expect(ids(next)).toEqual(ids(DEFAULT_LAYOUT))
  })

  it('a lone panel dropped back around its own row is identity', () => {
    expect(ids(movePanel(DEFAULT_LAYOUT, 'groupDist', { kind: 'row', index: 0 }))).toEqual(
      ids(DEFAULT_LAYOUT),
    )
    expect(ids(movePanel(DEFAULT_LAYOUT, 'groupDist', { kind: 'beside', row: 0, index: 1 }))).toEqual(
      ids(DEFAULT_LAYOUT),
    )
  })

  it('moving a lone panel below a later row adjusts for its removed row', () => {
    const next = movePanel(DEFAULT_LAYOUT, 'groupDist', { kind: 'row', index: 2 })
    expect(ids(next)).toEqual([['buckets', 'chart'], ['groupDist']])
  })

  it('resize shifts the shared boundary and respects MIN_SIZE', () => {
    const next = resizePanels(DEFAULT_LAYOUT, 1, 0, 0.2)
    expect(next.rows[1].panels[0].size).toBeCloseTo(0.7, 9)
    expect(next.rows[1].panels[1].size).toBeCloseTo(0.3, 9)
    const clamped = resizePanels(DEFAULT_LAYOUT, 1, 0, -10)
    expect(clamped.rows[1].panels[0].size).toBeCloseTo(0.15, 9)
  })

  it('normalize drops empty rows and renormalizes sizes', () => {
    const messy: DockLayout = {
      rows: [
        { panels: [] },
        {
          panels: [
            { id: 'groupDist', size: 2 },
            { id: 'buckets', size: 2 },
          ],
        },
        { panels: [{ id: 'chart', size: 0.4 }] },
      ],
    }
    const next = normalizeLayout(messy)
    expect(ids(next)).toEqual([['groupDist', 'buckets'], ['chart']])
    expect(next.rows[0].panels.map((p) => p.size)).toEqual([0.5, 0.5])
    expect(next.rows[1].panels[0].size).toBe(1)
  })

  it('migrates legacy chart flags', () => {
    expect(ids(migrateLayout({ swapped: true }))).toEqual([['groupDist'], ['chart', 'buckets']])
    expect(ids(migrateLayout({ forceStack: true }))).toEqual([
      ['groupDist'],
      ['buckets'],
      ['chart'],
    ])
    expect(ids(migrateLayout(undefined))).toEqual([['groupDist'], ['buckets', 'chart']])
  })
})
