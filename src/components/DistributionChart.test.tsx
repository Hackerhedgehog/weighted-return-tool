// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DistributionChart } from './DistributionChart'
import { groupRows } from '../lib/groups'
import { DEFAULT_CHART, type BucketRow, type ChartSettings } from '../lib/types'

const baseRows = (): BucketRow[] => [
  { uid: 'a', bucketId: 0, payout: 0, label: '0x', weight: 500_000, locked: false, groupId: 'other', weightId: '' },
  { uid: 'b', bucketId: 1, payout: 0.6, label: '0-1x', weight: 300_000, locked: false, groupId: 'other', weightId: '' },
  { uid: 'c', bucketId: 2, payout: 8, label: 'bonus3', weight: 150_000, locked: false, groupId: 'other', weightId: '' },
  { uid: 'd', bucketId: 3, payout: 100, label: 'bonus4', weight: 50_000, locked: false, groupId: 'other', weightId: '' },
]

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

afterEach(cleanup)

function renderChart(chart: Partial<ChartSettings>, rows = baseRows(), height = 340) {
  const onChart = vi.fn()
  const onPreview = vi.fn()
  const onCommit = vi.fn()
  const onDragBlocked = vi.fn()
  const onHeight = vi.fn()
  const total = rows.reduce((a, r) => a + r.weight, 0)
  render(
    <DistributionChart
      rows={rows}
      totalWeight={total}
      chart={{ ...DEFAULT_CHART, logY: false, aggregate: false, ...chart }}
      grouping={groupRows(rows)}
      weightStep={1}
      height={height}
      onChart={onChart}
      onPreview={onPreview}
      onCommit={onCommit}
      onDragBlocked={onDragBlocked}
      onHeight={onHeight}
    />,
  )
  return { onChart, onPreview, onCommit, onDragBlocked, onHeight, rows, total }
}

const lastRows = (fn: ReturnType<typeof vi.fn>): BucketRow[] =>
  fn.mock.calls[fn.mock.calls.length - 1][0] as BucketRow[]

const weightsOf = (rows: BucketRow[]) => rows.map((r) => r.weight)
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

describe('DistributionChart grouping', () => {
  it('draws slim bars', () => {
    // jsdom: useContainerWidth starts at 900px and the faked ResizeObserver
    // never fires, so the geometry here is deterministic.
    renderChart({ metric: 'weights' })
    const widths = [...document.querySelectorAll('.bar')].map((el) => el.getAttribute('width'))
    expect(widths.length).toBeGreaterThan(0)
    expect(widths.every((w) => w === '16')).toBe(true)
  })

  it('colors bars by their group', () => {
    renderChart({ metric: 'weights' })
    const styles = [...document.querySelectorAll('.bar')].map((el) => el.getAttribute('style') ?? '')
    // wins, bonus and 0x each get their own palette color
    const fills = new Set(styles.filter((s) => s.includes('fill')))
    expect(fills.size).toBe(3)
  })

  it('splits an aggregated bar into segments when groups share a payout', () => {
    const rows: BucketRow[] = [
      { uid: 'x', bucketId: 0, payout: 5, label: 'hp-fullscreen', weight: 100, locked: false, groupId: 'other', weightId: '' },
      { uid: 'y', bucketId: 1, payout: 5, label: 'bonus9', weight: 100, locked: false, groupId: 'other', weightId: '' },
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
    const rows = baseRows().map((r) => (r.uid === 'a' ? { ...r, locked: true, groupId: 'other', weightId: '' } : r))
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
    const rows = baseRows().map((r) => (r.uid === 'a' ? { ...r, locked: true, groupId: 'other', weightId: '' } : r))
    const { onPreview } = renderChart({ metric: 'weights' }, rows)
    const handle = screen.getByRole('slider', { name: '0x group' })

    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 250 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 100 })
    expect(onPreview).not.toHaveBeenCalled()
  })
})

/** The readout's label/value pairs, as a plain object. */
const readoutStats = (): Record<string, string> =>
  Object.fromEntries(
    [...document.querySelectorAll('.readout-stat')].map((el) => [
      el.querySelector('span')!.textContent,
      el.querySelector('b')!.textContent,
    ]),
  )

describe('DistributionChart readout', () => {
  it('draws no bubble until a bar is hovered', () => {
    renderChart({ metric: 'weights' })
    expect(document.querySelector('.chart-readout-band')).not.toBeNull()
    expect(document.querySelector('.chart-readout')).toBeNull()
  })

  it('anchors the bubble under the hovered bar', () => {
    renderChart({ metric: 'weights' })
    const hits = [...document.querySelectorAll('.bar-hit')]
    fireEvent.mouseOver(hits[1])
    const first = parseFloat((document.querySelector('.chart-readout') as HTMLElement).style.left)
    fireEvent.mouseOut(hits[1])
    fireEvent.mouseOver(hits[3])
    const later = parseFloat((document.querySelector('.chart-readout') as HTMLElement).style.left)
    // bars ascend left to right, so a later bar anchors further right
    expect(later).toBeGreaterThan(first)
  })

  it('names the hovered bucket in its group color', () => {
    renderChart({ metric: 'weights' })
    // bars run in ascending payout: 0x, 0-1x, bonus3, bonus4
    fireEvent.mouseOver(document.querySelectorAll('.bar-hit')[2])
    const line = document.querySelector('.readout-title')!
    expect(line.textContent).toBe('bonus3')
    // the bonus group's palette color, matching its bars — compared through a
    // probe element because jsdom rewrites hex to rgb() on the way in
    const bonusColor = groupRows(baseRows()).groups.find((g) => g.id === 'bonus')!.color
    const probe = document.createElement('div')
    probe.style.color = bonusColor
    expect((line as HTMLElement).style.color).toBe(probe.style.color)
  })

  it('gives each bucket of an aggregated bar its own colored line', () => {
    const rows: BucketRow[] = [
      { uid: 'x', bucketId: 0, payout: 5, label: 'hp-fullscreen', weight: 100, locked: false, groupId: 'other', weightId: '' },
      { uid: 'y', bucketId: 1, payout: 5, label: 'bonus9', weight: 100, locked: false, groupId: 'other', weightId: '' },
    ]
    renderChart({ metric: 'weights', aggregate: true }, rows)
    fireEvent.mouseOver(document.querySelector('.bar-hit')!)
    const lines = [...document.querySelectorAll('.readout-title')]
    expect(lines.map((el) => el.textContent)).toEqual(['hp-fullscreen', 'bonus9'])
    expect(lines[0].getAttribute('style')).not.toBe(lines[1].getAttribute('style'))
  })

  it('reports payout, weight, chance and the weighted value', () => {
    renderChart({ metric: 'weights' })
    fireEvent.mouseOver(document.querySelectorAll('.bar-hit')[3]) // ×100, weight 50,000 of 1,000,000
    expect(readoutStats()).toEqual({
      payout: '×100',
      weight: '50,000',
      chance: '5%',
      weighted: '5.0000',
    })
  })

  it('no longer offers a drag row', () => {
    renderChart({ metric: 'weights' })
    fireEvent.mouseOver(document.querySelectorAll('.bar-hit')[3])
    expect(screen.queryByText('drag')).toBeNull()
    expect(screen.queryByText('↑↓')).toBeNull()
  })

  it('dismisses the bubble when the pointer leaves the bar', () => {
    renderChart({ metric: 'weights' })
    const hit = document.querySelectorAll('.bar-hit')[3]
    fireEvent.mouseOver(hit)
    expect(document.querySelectorAll('.readout-title')).toHaveLength(1)
    fireEvent.mouseOut(hit)
    expect(document.querySelector('.chart-readout')).toBeNull()
  })
})

describe('DistributionChart group bars', () => {
  it('draws one bar for a collapsed group and none for its buckets', () => {
    renderChart({ metric: 'weights', groupBars: ['bonus'] })
    // 0x, 0-1x and the collapsed bonus group
    expect(document.querySelectorAll('.bar')).toHaveLength(3)
  })

  it('labels a group bar with the group name instead of a payout', () => {
    renderChart({ metric: 'weights', groupBars: ['bonus'] })
    const labels = [...document.querySelectorAll('.axis-label')].map((el) => el.textContent)
    expect(labels).toContain('bonus')
  })

  it('reports the payout range and the mean in the readout', () => {
    renderChart({ metric: 'weights', groupBars: ['bonus'] })
    // bars ascend: 0x, 0-1x, then bonus at its weighted mean of ×31
    fireEvent.mouseOver(document.querySelectorAll('.bar-hit')[2])
    const stats = readoutStats()
    expect(stats.payout).toBe('×8 – ×100')
    expect(stats.avg).toBe('×31')
    expect(stats.weight).toBe('200,000')
    // Σ(payout × weight) / total = (8×150,000 + 100×50,000) / 1,000,000
    expect(stats.weighted).toBe('6.2000')
  })

  it('names every bucket of a collapsed group in the readout', () => {
    renderChart({ metric: 'weights', groupBars: ['bonus'] })
    fireEvent.mouseOver(document.querySelectorAll('.bar-hit')[2])
    const lines = [...document.querySelectorAll('.readout-title')].map((el) => el.textContent)
    expect(lines).toEqual(['bonus3', 'bonus4'])
  })

  it('rescales the whole group when its bar is dragged', () => {
    const { onPreview, onCommit } = renderChart({ metric: 'weights', groupBars: ['bonus'] })
    const hit = document.querySelectorAll('.bar-hit')[2]

    fireEvent.pointerDown(hit, { pointerId: 1, clientY: 250 })
    fireEvent.pointerMove(hit, { pointerId: 1, clientY: 150 })

    const preview = lastRows(onPreview)
    expect(sum(weightsOf(preview))).toBe(1_000_000)
    expect(preview[2].weight + preview[3].weight).not.toBe(200_000)
    // in-group proportions hold at ≈ 3:1
    expect(preview[2].weight / preview[3].weight).toBeGreaterThan(2.7)
    expect(preview[2].weight / preview[3].weight).toBeLessThan(3.3)

    fireEvent.pointerUp(hit, { pointerId: 1, clientY: 150 })
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('still draws the group handle for a collapsed group', () => {
    renderChart({ metric: 'weights', groupBars: ['bonus'] })
    expect(screen.getByRole('slider', { name: 'bonus group' })).toBeDefined()
  })
})

describe('DistributionChart height', () => {
  it('draws at the height it is given', () => {
    renderChart({ metric: 'weights' }, baseRows(), 500)
    expect(document.querySelector('svg')!.getAttribute('height')).toBe('500')
  })

  it('reports a new height when the grip is dragged', () => {
    const { onHeight } = renderChart({ metric: 'weights' }, baseRows(), 340)
    const grip = screen.getByRole('separator', { name: 'Resize the distribution chart' })
    fireEvent.pointerDown(grip, { pointerId: 1, clientY: 0 })
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 60 })
    expect(onHeight).toHaveBeenLastCalledWith(400)
  })
})
