// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DistributionChart } from './DistributionChart'
import { groupRows } from '../lib/groups'
import { DEFAULT_CHART, type BucketRow, type ChartSettings } from '../lib/types'

const baseRows = (): BucketRow[] => [
  { uid: 'a', bucketId: 0, payout: 0, label: '0x', weight: 500_000, locked: false },
  { uid: 'b', bucketId: 1, payout: 0.6, label: '0-1x', weight: 300_000, locked: false },
  { uid: 'c', bucketId: 2, payout: 8, label: 'bonus3', weight: 150_000, locked: false },
  { uid: 'd', bucketId: 3, payout: 100, label: 'bonus4', weight: 50_000, locked: false },
]

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

afterEach(cleanup)

function renderChart(chart: Partial<ChartSettings>, rows = baseRows()) {
  const onChart = vi.fn()
  const onPreview = vi.fn()
  const onCommit = vi.fn()
  const onDragBlocked = vi.fn()
  const total = rows.reduce((a, r) => a + r.weight, 0)
  render(
    <DistributionChart
      rows={rows}
      totalWeight={total}
      chart={{ ...DEFAULT_CHART, logY: false, aggregate: false, ...chart }}
      grouping={groupRows(rows)}
      weightStep={1}
      onChart={onChart}
      onPreview={onPreview}
      onCommit={onCommit}
      onDragBlocked={onDragBlocked}
    />,
  )
  return { onChart, onPreview, onCommit, onDragBlocked, rows, total }
}

const lastRows = (fn: ReturnType<typeof vi.fn>): BucketRow[] =>
  fn.mock.calls[fn.mock.calls.length - 1][0] as BucketRow[]

const weightsOf = (rows: BucketRow[]) => rows.map((r) => r.weight)
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

describe('DistributionChart grouping', () => {
  it('colors bars by their group', () => {
    renderChart({ metric: 'weights' })
    const styles = [...document.querySelectorAll('.bar')].map((el) => el.getAttribute('style') ?? '')
    expect(styles.some((s) => s.includes('--series-0'))).toBe(true) // wins
    expect(styles.some((s) => s.includes('--series-1'))).toBe(true) // bonus
    expect(styles.some((s) => s.includes('--series-6'))).toBe(true) // zero
  })

  it('splits an aggregated bar into segments when groups share a payout', () => {
    const rows: BucketRow[] = [
      { uid: 'x', bucketId: 0, payout: 5, label: 'hp-fullscreen', weight: 100, locked: false },
      { uid: 'y', bucketId: 1, payout: 5, label: 'bonus9', weight: 100, locked: false },
    ]
    renderChart({ metric: 'weights', aggregate: true }, rows)
    expect(document.querySelectorAll('.bar').length).toBe(2)
  })

  it('renders one handle per group, in group order', () => {
    renderChart({ metric: 'weights' })
    const handles = screen.getAllByRole('slider')
    expect(handles.map((h) => h.getAttribute('aria-label'))).toEqual([
      'wins group',
      'bonus group',
      '0x group',
    ])
  })

  it('disables the handle of a fully locked group', () => {
    const rows = baseRows().map((r) => (r.uid === 'a' ? { ...r, locked: true } : r))
    renderChart({ metric: 'weights' }, rows)
    const zero = screen.getByRole('slider', { name: '0x group' })
    expect(zero.getAttribute('aria-disabled')).toBe('true')
  })

  it('shows the relative toggle in weights mode only', () => {
    renderChart({ metric: 'weights' })
    expect(screen.getByText('Relative drag')).toBeDefined()
    cleanup()
    renderChart({ metric: 'chance' })
    expect(screen.queryByText('Relative drag')).toBeNull()
  })
})

describe('DistributionChart dragging', () => {
  it('previews a relative bar drag with the grand total preserved and commits once', () => {
    const { onPreview, onCommit, total } = renderChart({ metric: 'weights', relative: true })
    const hit = document.querySelectorAll('.bar-hit')[1] // payout 0.6 → row b

    fireEvent.pointerDown(hit, { pointerId: 1, clientY: 250 })
    fireEvent.pointerMove(hit, { pointerId: 1, clientY: 120 })
    expect(onPreview).toHaveBeenCalled()

    const preview = lastRows(onPreview)
    expect(sum(weightsOf(preview))).toBe(total)
    expect(preview[1].weight).not.toBe(300_000)

    fireEvent.pointerUp(hit, { pointerId: 1, clientY: 120 })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(sum(weightsOf(lastRows(onCommit)))).toBe(total)
  })

  it('moves only the dragged bar when relativity is off', () => {
    const { onPreview } = renderChart({ metric: 'weights', relative: false })
    const hit = document.querySelectorAll('.bar-hit')[1]

    fireEvent.pointerDown(hit, { pointerId: 1, clientY: 250 })
    fireEvent.pointerMove(hit, { pointerId: 1, clientY: 60 })

    const preview = lastRows(onPreview)
    expect(preview[0].weight).toBe(500_000)
    expect(preview[2].weight).toBe(150_000)
    expect(preview[3].weight).toBe(50_000)
    expect(preview[1].weight).not.toBe(300_000)
  })

  it('keeps chance drags relative regardless of the toggle', () => {
    const { onPreview } = renderChart({ metric: 'chance', relative: false })
    const hit = document.querySelectorAll('.bar-hit')[1]

    fireEvent.pointerDown(hit, { pointerId: 1, clientY: 250 })
    fireEvent.pointerMove(hit, { pointerId: 1, clientY: 120 })

    const preview = lastRows(onPreview)
    expect(sum(weightsOf(preview))).toBe(1_000_000)
    expect(preview[1].weight).not.toBe(300_000)
  })

  it('rescales a whole group from its handle, keeping in-group proportions', () => {
    const { onPreview, onCommit } = renderChart({ metric: 'weights', relative: true })
    const handle = screen.getByRole('slider', { name: 'bonus group' })

    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 250 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 100 })

    const preview = lastRows(onPreview)
    expect(sum(weightsOf(preview))).toBe(1_000_000)
    const groupTotal = preview[2].weight + preview[3].weight
    expect(groupTotal).not.toBe(200_000)
    // c:d stays ≈ 3:1
    expect(preview[2].weight / preview[3].weight).toBeGreaterThan(2.7)
    expect(preview[2].weight / preview[3].weight).toBeLessThan(3.3)

    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 100 })
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('does not preview from a locked group handle', () => {
    const rows = baseRows().map((r) => (r.uid === 'a' ? { ...r, locked: true } : r))
    const { onPreview } = renderChart({ metric: 'weights' }, rows)
    const handle = screen.getByRole('slider', { name: '0x group' })

    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 250 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 100 })
    expect(onPreview).not.toHaveBeenCalled()
  })
})
