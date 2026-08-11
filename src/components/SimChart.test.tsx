// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SimChart } from './SimChart'

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

afterEach(cleanup)

/** 1000 spins in blocks of 400 → the third block runs short at 200. */
function renderSim(height = 260, yZoom = 1) {
  const onHeight = vi.fn()
  const onYZoom = vi.fn()
  render(
    <SimChart
      points={[1.5, 0.5, 1.0]}
      blockSize={400}
      requestedSpins={1000}
      expectedRtp={0.95}
      height={height}
      yZoom={yZoom}
      onYZoom={onYZoom}
      onHeight={onHeight}
    />,
  )
  return { onHeight, onYZoom }
}

const readoutStats = (): Record<string, string> =>
  Object.fromEntries(
    [...document.querySelectorAll('.readout-stat')].map((el) => [
      el.querySelector('span')!.textContent,
      el.querySelector('b')!.textContent,
    ]),
  )

/**
 * jsdom reports a zero-origin bounding rect, so clientX is the plot-local x.
 * plotW is 900 - 64 - 74 = 762, so x = 762 lands on the final block.
 */
const hoverAt = (clientX: number) =>
  fireEvent.mouseMove(document.querySelector('.sim-hit')!, { clientX })

describe('SimChart', () => {
  it('states the block size in the legend', () => {
    renderSim()
    expect(screen.getByText(/block avg · 400 spins each/)).toBeDefined()
  })

  it('draws no bubble until the chart is hovered', () => {
    renderSim()
    expect(document.querySelector('.chart-readout-band')).not.toBeNull()
    expect(document.querySelector('.chart-readout')).toBeNull()
  })

  it('reports the hovered block, including a short final block', () => {
    renderSim()
    hoverAt(762)
    expect(document.querySelector('.readout-title')!.textContent).toBe('1,000 spins')
    expect(readoutStats()).toEqual({
      block: '200 spins',
      'block avg': '1.0000',
      'RTP so far': '1.0000',
      'table RTP': '0.9500',
    })
  })

  it('reports a full block at full size', () => {
    renderSim()
    hoverAt(300)
    expect(readoutStats().block).toBe('400 spins')
    expect(readoutStats()['block avg']).toBe('1.5000')
  })
})

describe('SimChart height', () => {
  it('draws at the height it is given', () => {
    renderSim(420)
    expect(document.querySelector('svg')!.getAttribute('height')).toBe('420')
  })

  it('reports a new height when the grip is dragged', () => {
    const { onHeight } = renderSim(260)
    const grip = screen.getByRole('separator', { name: 'Resize the simulation chart' })
    fireEvent.pointerDown(grip, { pointerId: 1, clientY: 0 })
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 40 })
    expect(onHeight).toHaveBeenLastCalledWith(300)
  })
})

describe('SimChart y-zoom', () => {
  it('shows no spike note at the default zoom', () => {
    renderSim()
    expect(screen.queryByText(/pinned to the top edge/)).toBeNull()
  })

  it('recomputes the clipped-spike count against the zoomed range', () => {
    // autoYMax is niceCeil(1.725) = 2; zoomed to 0.5 the effective ceiling is
    // 1, and only the 1.5 block mean sits above it.
    renderSim(260, 0.5)
    expect(screen.getByText(/1 spike block pinned to the top edge/)).toBeDefined()
  })

  it('renders a y-axis zoom handle', () => {
    renderSim()
    expect(screen.getByRole('slider', { name: "Zoom the simulation chart's y-axis" })).toBeDefined()
  })

  it('reports a new zoom factor when the handle is dragged', () => {
    const { onYZoom } = renderSim()
    const handle = screen.getByRole('slider', { name: "Zoom the simulation chart's y-axis" })
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 100 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 0 })
    expect(onYZoom).toHaveBeenCalled()
    expect(onYZoom.mock.calls.at(-1)![0]).toBeLessThan(1)
  })
})
