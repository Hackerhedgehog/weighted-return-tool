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

function renderChart(
  chart: Partial<ChartSettings>,
  rows = baseRows(),
  height = 340,
  weightStep: 1 | 10 | 100 = 1,
  extra: Partial<React.ComponentProps<typeof DistributionChart>> = {},
) {
  const onChart = vi.fn()
  const onPreview = vi.fn()
  const onCommit = vi.fn()
  const onBlocked = vi.fn()
  const onHeight = vi.fn()
  const onGroupLock = vi.fn()
  const onGroupSoftLock = vi.fn()
  const onYZoom = vi.fn()
  const onYPan = vi.fn()
  const onXZoom = vi.fn()
  const onXPan = vi.fn()
  const total = rows.reduce((a, r) => a + r.weight, 0)
  render(
    <DistributionChart
      rows={rows}
      totalWeight={total}
      chart={{ ...DEFAULT_CHART, logY: false, aggregate: false, ...chart }}
      grouping={groupRows(rows)}
      weightStep={weightStep}
      height={height}
      userCurve={null}
      onSaveCurve={() => {}}
      onChart={onChart}
      onPreview={onPreview}
      onCommit={onCommit}
      onBlocked={onBlocked}
      onHeight={onHeight}
      onGroupLock={onGroupLock}
      softLocked={new Set()}
      onGroupSoftLock={onGroupSoftLock}
      yZoom={1}
      onYZoom={onYZoom}
      yPan={0}
      onYPan={onYPan}
      xZoom={1}
      onXZoom={onXZoom}
      xPan={0}
      onXPan={onXPan}
      {...extra}
    />,
  )
  return {
    onChart,
    onPreview,
    onCommit,
    onBlocked,
    onHeight,
    onGroupLock,
    onGroupSoftLock,
    onYZoom,
    onYPan,
    onXZoom,
    onXPan,
    rows,
    total,
  }
}

const lastRows = (fn: ReturnType<typeof vi.fn>): BucketRow[] =>
  fn.mock.calls[fn.mock.calls.length - 1][0] as BucketRow[]

const weightsOf = (rows: BucketRow[]) => rows.map((r) => r.weight)
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

describe('DistributionChart user curve', () => {
  it('draws the saved curve as a reference line and offers Save curve', () => {
    const onSaveCurve = vi.fn()
    const shares = Object.fromEntries(baseRows().map((r) => [r.uid, 0.25]))
    renderChart({ metric: 'weights' }, baseRows(), 340, 1, { userCurve: shares, onSaveCurve })
    expect(document.querySelector('.user-curve-line')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save curve' }))
    expect(onSaveCurve).toHaveBeenCalled()
  })

  it('draws no line when no curve is saved', () => {
    renderChart({ metric: 'weights' })
    expect(document.querySelector('.user-curve-line')).toBeNull()
  })

  it('skips bars whose buckets carry no saved share', () => {
    const shares = { a: 0.5, b: 0.3 } // c and d unsaved
    renderChart({ metric: 'weights' }, baseRows(), 340, 1, { userCurve: shares })
    // Two points cannot span the unsaved bars — the line still draws through
    // the two saved ones.
    const line = document.querySelector('.user-curve-line')!
    expect(line.getAttribute('points')!.split(' ')).toHaveLength(2)
  })
})

describe('DistributionChart x-axis labels', () => {
  it('rotates tick labels diagonally', () => {
    renderChart({ metric: 'weights' })
    const tick = document.querySelector('text.axis-label.diag')!
    expect(tick).toBeTruthy()
    expect(tick.getAttribute('transform')).toContain('rotate(-45')
  })

  it('labels ticks by bucket name when xLabels is label', () => {
    renderChart({ metric: 'weights', xLabels: 'label' })
    const texts = [...document.querySelectorAll('text.axis-label.diag')].map((t) => t.textContent)
    expect(texts).toContain('bonus3')
    expect(texts.some((t) => t?.startsWith('×'))).toBe(false)
  })
})

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
    // Excludes the axis-zoom sliders, which are also role="slider".
    const handles = screen.getAllByRole('slider', { name: /group$/ })
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

  it('carries no inline Log Y or Relative drag controls — both live in the ⚙ menu', () => {
    renderChart({ metric: 'weights' })
    expect(screen.queryByText('Relative drag')).toBeNull()
    expect(screen.queryByText('Log Y')).toBeNull()
    expect(screen.getByText('Log X')).toBeDefined()
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

describe('DistributionChart soft locks', () => {
  // rows c and d form the bonus group (150k + 50k = 200k).
  const soft = { softLocked: new Set(['bonus']) }

  it('keeps a soft-locked group’s bars draggable, exchanging weight only inside it', () => {
    const { onPreview, onCommit } = renderChart({ metric: 'weights', relative: true }, baseRows(), 340, 1, soft)
    const hit = document.querySelectorAll('.bar-hit')[2] // payout 8 → row c

    fireEvent.pointerDown(hit, { pointerId: 1, clientY: 250 })
    fireEvent.pointerMove(hit, { pointerId: 1, clientY: 120 })

    const preview = lastRows(onPreview)
    expect(preview[2].weight).not.toBe(150_000)
    // The group total holds, so its partner absorbed the whole change…
    expect(preview[2].weight + preview[3].weight).toBe(200_000)
    // …and nothing outside the group moved.
    expect(preview[0].weight).toBe(500_000)
    expect(preview[1].weight).toBe(300_000)

    fireEvent.pointerUp(hit, { pointerId: 1, clientY: 120 })
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('confines the drag even with relativity off — the total is what the lock pins', () => {
    const { onPreview } = renderChart({ metric: 'weights', relative: false }, baseRows(), 340, 1, soft)
    const hit = document.querySelectorAll('.bar-hit')[3] // payout 100 → row d

    fireEvent.pointerDown(hit, { pointerId: 1, clientY: 250 })
    fireEvent.pointerMove(hit, { pointerId: 1, clientY: 120 })

    const preview = lastRows(onPreview)
    expect(preview[3].weight).not.toBe(50_000)
    expect(preview[2].weight + preview[3].weight).toBe(200_000)
  })

  it('freezes soft-locked members against drags from outside the group', () => {
    const { onPreview } = renderChart({ metric: 'weights', relative: true }, baseRows(), 340, 1, soft)
    const hit = document.querySelectorAll('.bar-hit')[1] // row b, not in the group

    fireEvent.pointerDown(hit, { pointerId: 1, clientY: 250 })
    fireEvent.pointerMove(hit, { pointerId: 1, clientY: 120 })

    const preview = lastRows(onPreview)
    expect(preview[1].weight).not.toBe(300_000)
    // Only the 0x bucket may compensate — the pinned group stands whole.
    expect(preview[2].weight).toBe(150_000)
    expect(preview[3].weight).toBe(50_000)
  })

  it('makes the soft-locked group’s handle inert without locking its bars', () => {
    const { onPreview } = renderChart({ metric: 'weights', relative: true }, baseRows(), 340, 1, soft)
    const handle = screen.getByRole('slider', { name: 'bonus group' })
    expect(handle.getAttribute('aria-disabled')).toBe('true')

    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 250 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 100 })
    expect(onPreview).not.toHaveBeenCalled()
  })

  it('toggles the soft lock from the Σ control, separately from the padlock', () => {
    const { onGroupSoftLock, onGroupLock } = renderChart({ metric: 'weights' }, baseRows(), 340, 1, soft)

    fireEvent.click(screen.getByRole('button', { name: 'Release the bonus group total' }))
    expect(onGroupSoftLock).toHaveBeenCalledWith('bonus', false)

    fireEvent.click(screen.getByRole('button', { name: 'Soft-lock the wins group total' }))
    expect(onGroupSoftLock).toHaveBeenCalledWith('wins', true)
    expect(onGroupLock).not.toHaveBeenCalled()
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

describe('DistributionChart delta dragging', () => {
  it('does not move a bar when the pointer is pressed and not moved', () => {
    // The regression this feature exists for: the old drag jumped the bar to
    // wherever the pointer happened to land, destroying its value on contact.
    const { onPreview } = renderChart({ metric: 'weights', relative: true })
    const hit = document.querySelectorAll('.bar-hit')[1]

    fireEvent.pointerDown(hit, { pointerId: 1, clientY: 250 })
    fireEvent.pointerMove(hit, { pointerId: 1, clientY: 250 })

    expect(weightsOf(lastRows(onPreview))).toEqual([500_000, 300_000, 150_000, 50_000])
  })

  it('gives the same result for the same delta from different grab points', () => {
    const low = renderChart({ metric: 'weights', relative: true })
    const lowHit = document.querySelectorAll('.bar-hit')[1]
    fireEvent.pointerDown(lowHit, { pointerId: 1, clientY: 300 })
    fireEvent.pointerMove(lowHit, { pointerId: 1, clientY: 260 })
    const fromLow = weightsOf(lastRows(low.onPreview))
    cleanup()

    const high = renderChart({ metric: 'weights', relative: true })
    const highHit = document.querySelectorAll('.bar-hit')[1]
    fireEvent.pointerDown(highHit, { pointerId: 1, clientY: 120 })
    fireEvent.pointerMove(highHit, { pointerId: 1, clientY: 80 })

    expect(weightsOf(lastRows(high.onPreview))).toEqual(fromLow)
  })

  it('raises the value when the pointer moves up and lowers it when it moves down', () => {
    const { onPreview } = renderChart({ metric: 'weights', relative: true })
    const hit = document.querySelectorAll('.bar-hit')[1]

    fireEvent.pointerDown(hit, { pointerId: 1, clientY: 200 })
    fireEvent.pointerMove(hit, { pointerId: 1, clientY: 160 })
    expect(lastRows(onPreview)[1].weight).toBeGreaterThan(300_000)

    fireEvent.pointerMove(hit, { pointerId: 1, clientY: 240 })
    expect(lastRows(onPreview)[1].weight).toBeLessThan(300_000)
  })

  it('starts a group handle drag from the group’s own value', () => {
    const { onPreview } = renderChart({ metric: 'weights', relative: true })
    const handle = screen.getByRole('slider', { name: 'bonus group' })

    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 200 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 200 })

    expect(weightsOf(lastRows(onPreview))).toEqual([500_000, 300_000, 150_000, 50_000])
  })
})

describe('DistributionChart value entry', () => {
  it('opens a pre-filled popover when a bar is right-clicked', () => {
    renderChart({ metric: 'weights' })
    fireEvent.contextMenu(document.querySelectorAll('.bar-hit')[1], { clientX: 200, clientY: 150 })
    expect(screen.getByRole('dialog')).toBeDefined()
    expect((screen.getByLabelText('Weight') as HTMLInputElement).value).toBe('300000')
  })

  it('opens from a group handle with the group total', () => {
    renderChart({ metric: 'weights' })
    fireEvent.contextMenu(screen.getByRole('slider', { name: 'bonus group' }), {
      clientX: 800,
      clientY: 100,
    })
    expect((screen.getByLabelText('Weight') as HTMLInputElement).value).toBe('200000')
  })

  it('commits a typed weight as one undo step, preserving the grand total', () => {
    const { onCommit } = renderChart({ metric: 'weights', relative: true })
    fireEvent.contextMenu(document.querySelectorAll('.bar-hit')[1], { clientX: 200, clientY: 150 })
    fireEvent.change(screen.getByLabelText('Weight'), { target: { value: '250000' } })
    fireEvent.keyDown(screen.getByLabelText('Weight'), { key: 'Enter' })

    expect(onCommit).toHaveBeenCalledTimes(1)
    const rows = lastRows(onCommit)
    expect(rows[1].weight).toBe(250_000)
    expect(sum(weightsOf(rows))).toBe(1_000_000)
  })

  it('commits a typed percentage in chance mode', () => {
    const { onCommit } = renderChart({ metric: 'chance' })
    fireEvent.contextMenu(document.querySelectorAll('.bar-hit')[1], { clientX: 200, clientY: 150 })
    fireEvent.change(screen.getByLabelText('Chance %'), { target: { value: '25' } })
    fireEvent.keyDown(screen.getByLabelText('Chance %'), { key: 'Enter' })
    expect(lastRows(onCommit)[1].weight).toBe(250_000)
  })

  it('reports a step-blocked entry and keeps the weights', () => {
    // 1,000,005 free weight cannot be partitioned on a step of 10.
    const rows = baseRows().map((r) => (r.uid === 'a' ? { ...r, weight: 500_005 } : r))
    const { onCommit, onBlocked } = renderChart({ metric: 'weights', relative: true }, rows, 340, 10)
    fireEvent.contextMenu(document.querySelectorAll('.bar-hit')[1], { clientX: 200, clientY: 150 })
    fireEvent.change(screen.getByLabelText('Weight'), { target: { value: '250000' } })
    fireEvent.keyDown(screen.getByLabelText('Weight'), { key: 'Enter' })
    expect(onBlocked).toHaveBeenCalledWith('off-step')
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('reports a pinned entry, rather than silently no-opping, when every other unlocked bucket is locked', () => {
    // Locking c and d leaves b (the dragged subset) as the only unlocked row
    // outside the target — scaleSubset has nowhere to put the complementary
    // change and hands back the weights unchanged.
    const rows = baseRows().map((r) => (r.uid === 'b' ? r : { ...r, locked: true }))
    const { onCommit, onBlocked } = renderChart({ metric: 'weights', relative: true }, rows)
    fireEvent.contextMenu(document.querySelectorAll('.bar-hit')[1], { clientX: 200, clientY: 150 })
    fireEvent.change(screen.getByLabelText('Weight'), { target: { value: '250000' } })
    fireEvent.keyDown(screen.getByLabelText('Weight'), { key: 'Enter' })

    expect(onCommit).not.toHaveBeenCalled()
    expect(onBlocked).toHaveBeenCalledWith('pinned')
    expect(screen.getByRole('dialog')).toBeDefined()
  })

  it('does not open on a locked bar', () => {
    const rows = baseRows().map((r) => (r.uid === 'a' ? { ...r, locked: true } : r))
    renderChart({ metric: 'weights' }, rows)
    fireEvent.contextMenu(document.querySelectorAll('.bar-hit')[0], { clientX: 100, clientY: 150 })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('does not open from a fully locked group handle', () => {
    const rows = baseRows().map((r) => (r.payout >= 8 ? { ...r, locked: true } : r))
    renderChart({ metric: 'weights' }, rows)
    fireEvent.contextMenu(screen.getByRole('slider', { name: 'bonus group' }), {
      clientX: 800,
      clientY: 100,
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('DistributionChart zoom and pan', () => {
  it('renders x and y axis zoom handles', () => {
    renderChart({ metric: 'weights' })
    expect(screen.getByRole('slider', { name: "Zoom the distribution chart's y-axis" })).toBeDefined()
    expect(screen.getByRole('slider', { name: "Zoom the distribution chart's x-axis" })).toBeDefined()
  })

  it('renders a reset view button', () => {
    renderChart({ metric: 'weights' })
    expect(screen.getByRole('button', { name: /reset/i })).toBeDefined()
  })

  it('zooms both axes together when scrolling the plot itself', () => {
    const { onXZoom, onYZoom } = renderChart({ metric: 'weights' })
    fireEvent.wheel(document.querySelector('.dist-plot-bg')!, { deltaY: -100 })
    expect(onXZoom).toHaveBeenCalled()
    expect(onYZoom).toHaveBeenCalled()
    expect(onXZoom.mock.calls[0][0]).toBeLessThan(1)
    expect(onYZoom.mock.calls[0][0]).toBeLessThan(1)
  })

  it('pans both axes on a middle-button drag once zoomed in', () => {
    const { onXPan, onYPan } = renderChart({ metric: 'weights' }, baseRows(), 340, 1, {
      xZoom: 0.5,
      yZoom: 0.5,
    })
    const bg = document.querySelector('.dist-plot-bg')!
    fireEvent.pointerDown(bg, { pointerId: 1, button: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(bg, { pointerId: 1, clientX: 50, clientY: 50 })
    expect(onXPan).toHaveBeenCalled()
    expect(onYPan).toHaveBeenCalled()
  })
})

describe('DistributionChart multi-select', () => {
  it('toggles selection on shift+click', () => {
    renderChart({ metric: 'weights' })
    const hit = document.querySelectorAll('.bar-hit')[1]
    fireEvent.pointerDown(hit, { pointerId: 1, button: 0, shiftKey: true, clientY: 200 })
    expect(hit.classList.contains('selected')).toBe(true)
    fireEvent.pointerDown(hit, { pointerId: 1, button: 0, shiftKey: true, clientY: 200 })
    expect(hit.classList.contains('selected')).toBe(false)
  })

  it('does not start a drag on a shift+click', () => {
    const { onPreview } = renderChart({ metric: 'weights' })
    const hit = document.querySelectorAll('.bar-hit')[1]
    fireEvent.pointerDown(hit, { pointerId: 1, button: 0, shiftKey: true, clientY: 200 })
    fireEvent.pointerMove(hit, { pointerId: 1, clientY: 100 })
    expect(onPreview).not.toHaveBeenCalled()
  })

  it('moves every selected bar by the same absolute delta when one of them is dragged', () => {
    const { onPreview } = renderChart({ metric: 'weights', relative: false })
    const hits = document.querySelectorAll('.bar-hit')

    fireEvent.pointerDown(hits[1], { pointerId: 1, button: 0, shiftKey: true, clientY: 200 })
    fireEvent.pointerDown(hits[2], { pointerId: 1, button: 0, shiftKey: true, clientY: 200 })

    fireEvent.pointerDown(hits[1], { pointerId: 1, clientY: 200 })
    fireEvent.pointerMove(hits[1], { pointerId: 1, clientY: 100 })

    const preview = lastRows(onPreview)
    const deltaB = preview[1].weight - 300_000
    const deltaC = preview[2].weight - 150_000
    expect(deltaB).toBeGreaterThan(0)
    expect(deltaC).toBeCloseTo(deltaB, 5)
    // bars outside the selection hold still — relative drag is off.
    expect(preview[0].weight).toBe(500_000)
    expect(preview[3].weight).toBe(50_000)
  })

  it('clears the selection on a plain click on empty plot space', () => {
    renderChart({ metric: 'weights' })
    const hit = document.querySelectorAll('.bar-hit')[1]
    fireEvent.pointerDown(hit, { pointerId: 1, button: 0, shiftKey: true, clientY: 200 })
    expect(hit.classList.contains('selected')).toBe(true)

    fireEvent.pointerDown(document.querySelector('.dist-plot-bg')!, { pointerId: 2, button: 0 })
    expect(hit.classList.contains('selected')).toBe(false)
  })

  it('clears the selection on a click outside the chart', () => {
    renderChart({ metric: 'weights' })
    const hit = document.querySelectorAll('.bar-hit')[1]
    fireEvent.pointerDown(hit, { pointerId: 1, button: 0, shiftKey: true, clientY: 200 })
    expect(hit.classList.contains('selected')).toBe(true)

    fireEvent.pointerDown(document.body, { pointerId: 2, button: 0 })
    expect(hit.classList.contains('selected')).toBe(false)
  })
})

describe('DistributionChart group locks', () => {
  it('locks an unlocked group from its handle', () => {
    const onGroupLock = vi.fn()
    renderChart({ metric: 'weights' }, baseRows(), 340, 1, { onGroupLock })
    fireEvent.click(screen.getByRole('button', { name: 'Hard-lock the bonus group' }))
    expect(onGroupLock).toHaveBeenCalledWith('bonus', true)
  })

  it('unlocks a fully locked group from its handle', () => {
    const onGroupLock = vi.fn()
    const rows = baseRows().map((r) => (r.payout >= 8 ? { ...r, locked: true } : r))
    renderChart({ metric: 'weights' }, rows, 340, 1, { onGroupLock })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock the bonus group' }))
    expect(onGroupLock).toHaveBeenCalledWith('bonus', false)
  })

  it('locks the rest of a partly locked group', () => {
    const onGroupLock = vi.fn()
    const rows = baseRows().map((r) => (r.uid === 'c' ? { ...r, locked: true } : r))
    renderChart({ metric: 'weights' }, rows, 340, 1, { onGroupLock })
    fireEvent.click(screen.getByRole('button', { name: 'Hard-lock the bonus group' }))
    expect(onGroupLock).toHaveBeenCalledWith('bonus', true)
  })

  it('locks a group when Enter is pressed on its focused padlock', () => {
    const onGroupLock = vi.fn()
    renderChart({ metric: 'weights' }, baseRows(), 340, 1, { onGroupLock })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Hard-lock the bonus group' }), { key: 'Enter' })
    expect(onGroupLock).toHaveBeenCalledWith('bonus', true)
  })

  it('does not start a drag when the padlock is pressed', () => {
    const { onPreview } = renderChart({ metric: 'weights' }, baseRows(), 340, 1, {
      onGroupLock: vi.fn(),
    })
    const lock = screen.getByRole('button', { name: 'Hard-lock the bonus group' })
    fireEvent.pointerDown(lock, { pointerId: 1, clientY: 250 })
    fireEvent.pointerMove(lock, { pointerId: 1, clientY: 100 })
    expect(onPreview).not.toHaveBeenCalled()
  })
})
