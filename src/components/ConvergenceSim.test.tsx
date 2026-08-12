// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ConvergenceSim, type SimWorkerLike } from './ConvergenceSim'
import type { SimRunRequest, SimWorkerMessage } from '../lib/sim'
import type { BucketRow } from '../lib/types'

const rows: BucketRow[] = [
  { uid: 'a', bucketId: 0, payout: 0, label: '0x', weight: 700_000, locked: false, groupId: 'other', weightId: '' },
  { uid: 'b', bucketId: 1, payout: 2, label: '1-2x', weight: 300_000, locked: false, groupId: 'other', weightId: '' },
]

class FakeWorker implements SimWorkerLike {
  onmessage: ((e: MessageEvent<SimWorkerMessage>) => void) | null = null
  posted: SimRunRequest[] = []
  terminated = false
  postMessage(msg: SimRunRequest) {
    this.posted.push(msg)
  }
  terminate() {
    this.terminated = true
  }
}

const reply = (w: FakeWorker, msg: SimWorkerMessage) => {
  act(() => {
    w.onmessage?.({ data: msg } as MessageEvent<SimWorkerMessage>)
  })
}

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

afterEach(cleanup)

function renderPanel(
  over: {
    worker?: FakeWorker
    spins?: number
    yZoom?: number
    onYZoom?: (z: number) => void
    yPan?: number
    onYPan?: (p: number) => void
    xZoom?: number
    onXZoom?: (z: number) => void
    xPan?: number
    onXPan?: (p: number) => void
  } = {},
) {
  const onSpins = vi.fn()
  render(
    <ConvergenceSim
      rows={rows}
      totalWeight={1_000_000}
      expectedRtp={0.6}
      spins={over.spins ?? 1000}
      onSpins={onSpins}
      chartHeight={260}
      onChartHeight={vi.fn()}
      yZoom={over.yZoom ?? 1}
      onYZoom={over.onYZoom ?? vi.fn()}
      yPan={over.yPan ?? 0}
      onYPan={over.onYPan ?? vi.fn()}
      xZoom={over.xZoom ?? 1}
      onXZoom={over.onXZoom ?? vi.fn()}
      xPan={over.xPan ?? 0}
      onXPan={over.onXPan ?? vi.fn()}
      createWorker={over.worker === undefined ? undefined : () => over.worker!}
    />,
  )
  return onSpins
}

describe('ConvergenceSim', () => {
  it('shows the configured spin count and a Run button', () => {
    renderPanel({ worker: new FakeWorker(), spins: 100_000_000 })
    expect(screen.getByDisplayValue('100,000,000')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Run' })).toBeDefined()
  })

  it('commits a parsed shorthand spin count on Enter', () => {
    const onSpins = renderPanel({ worker: new FakeWorker() })
    const input = screen.getByLabelText('Spins')
    fireEvent.change(input, { target: { value: '50m' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSpins).toHaveBeenCalledWith(50_000_000)
  })

  it('commits an arithmetic spin count on Enter', () => {
    const onSpins = renderPanel({ worker: new FakeWorker() })
    const input = screen.getByLabelText('Spins')
    fireEvent.change(input, { target: { value: '5000*20' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSpins).toHaveBeenCalledWith(100_000)
  })

  it('disables Run when workers are unavailable', () => {
    renderPanel()
    expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('runs, streams stats live, and finishes', () => {
    const w = new FakeWorker()
    renderPanel({ worker: w })

    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(w.posted).toHaveLength(1)
    expect(w.posted[0].spins).toBe(1000)
    expect(w.posted[0].payouts).toEqual([0, 2])
    expect(w.posted[0].weights).toEqual([700_000, 300_000])

    reply(w, {
      type: 'block',
      blockIndex: 0,
      blockMean: 1.9,
      agg: { spins: 500, sum: 950, sumSq: 1805, hits: 250, wins: 250, maxWin: 2 },
    })
    reply(w, {
      type: 'done',
      agg: { spins: 1000, sum: 950, sumSq: 1805, hits: 250, wins: 250, maxWin: 2 },
    })

    // rtp = 950/1000, hit rate 25%, max win ×2
    const tiles = within(document.querySelector('.sim-stats') as HTMLElement)
    expect(tiles.getAllByText('0.9500').length).toBeGreaterThanOrEqual(1)
    // hit rate and win rate are both 250/1000 here
    expect(tiles.getAllByText('25%')).toHaveLength(2)
    expect(tiles.getByText('×2')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Run' })).toBeDefined()
  })

  it('can be resized before a run has produced a chart', () => {
    renderPanel({ worker: new FakeWorker() })
    expect(screen.queryByRole('img', { name: 'Simulation results' })).toBeNull()
    expect(screen.getByRole('separator', { name: 'Resize the simulation chart' })).toBeDefined()
  })

  it('cancel terminates the worker and keeps the partial stats', () => {
    const w = new FakeWorker()
    renderPanel({ worker: w })
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))

    reply(w, {
      type: 'block',
      blockIndex: 0,
      blockMean: 1.0,
      agg: { spins: 500, sum: 500, sumSq: 1000, hits: 250, wins: 250, maxWin: 2 },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(w.terminated).toBe(true)
    const tiles = within(document.querySelector('.sim-stats') as HTMLElement)
    expect(tiles.getAllByText('1.0000').length).toBeGreaterThanOrEqual(1)
  })

  it('shows the y-axis zoom handle once a run has produced a chart', () => {
    const w = new FakeWorker()
    renderPanel({ worker: w })
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    reply(w, {
      type: 'done',
      agg: { spins: 1000, sum: 950, sumSq: 1805, hits: 250, wins: 250, maxWin: 2 },
    })
    expect(screen.getByRole('slider', { name: "Zoom the simulation chart's y-axis" })).toBeDefined()
  })
})

describe('ConvergenceSim pan/x-zoom threading', () => {
  it('passes the x-zoom and pan props through to SimChart', () => {
    const w = new FakeWorker()
    renderPanel({ worker: w, xZoom: 0.6, yPan: 0.2 })
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    reply(w, {
      type: 'done',
      agg: { spins: 1000, sum: 950, sumSq: 1805, hits: 250, wins: 250, maxWin: 2 },
    })
    const slider = screen.getByRole('slider', { name: "Zoom the simulation chart's x-axis" })
    expect(slider.getAttribute('aria-valuenow')).toBe('0.6')
  })
})
