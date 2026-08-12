// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { viewRange } from './chartView'
import { useChartAxes, type ChartAxesConfig } from './useChartAxes'

function baseConfig(overrides: Partial<ChartAxesConfig> = {}): ChartAxesConfig {
  return {
    xExtent: 1000,
    xZoom: 1,
    onXZoom: vi.fn(),
    xPan: 0,
    onXPan: vi.fn(),
    autoYMax: 100,
    trueYMax: 100,
    yZoom: 1,
    onYZoom: vi.fn(),
    yPan: 0,
    onYPan: vi.fn(),
    ...overrides,
  }
}

describe('useChartAxes', () => {
  it('matches todays default view at zoom=1, pan=0', () => {
    const { result } = renderHook(() => useChartAxes(baseConfig()))
    expect(result.current.viewX).toEqual({ min: 0, max: 1000 })
    expect(result.current.viewY).toEqual({ min: 0, max: 100 })
  })

  it('reports no scrollbar needed at zoom=1', () => {
    const { result } = renderHook(() => useChartAxes(baseConfig()))
    expect(result.current.xScrollbar).toBeNull()
    expect(result.current.yScrollbar).toBeNull()
  })

  it('reports a scrollbar once an axis is zoomed in', () => {
    const { result } = renderHook(() => useChartAxes(baseConfig({ yZoom: 0.5 })))
    expect(result.current.yScrollbar).not.toBeNull()
    expect(result.current.yScrollbar!.size).toBeCloseTo(0.5, 6)
  })

  it('setYPan clamps to the true extent before calling onYPan', () => {
    const onYPan = vi.fn()
    const { result } = renderHook(() =>
      useChartAxes(baseConfig({ yZoom: 0.2, trueYMax: 100, onYPan })),
    )
    act(() => result.current.setYPan(10)) // wildly out of range
    const [calledWith] = onYPan.mock.calls.at(-1)!
    expect(calledWith).toBeLessThan(10)
  })

  it('setYPan additionally keeps 0 visible when keepZeroVisible is set', () => {
    const onYPan = vi.fn()
    const { result } = renderHook(() =>
      useChartAxes(
        baseConfig({ yZoom: 0.2, autoYMax: 100, trueYMax: 500, keepZeroVisible: true, onYPan }),
      ),
    )
    // pan=1 would center the view at autoYMax*(0.5+1)=150 with a span of
    // only 20 (zoom 0.2 * autoYMax 100) — well clear of 0 if unclamped.
    act(() => result.current.setYPan(1))
    const pan = onYPan.mock.calls.at(-1)![0] as number
    const view = viewRange(100, 0.2, pan)
    expect(view.min).toBeLessThanOrEqual(0)
    expect(view.max).toBeGreaterThanOrEqual(0)
  })

  it('keeps 0 visible at pan=0 once zoomed in, even without any explicit pan action', () => {
    const { result } = renderHook(() =>
      useChartAxes(
        baseConfig({ yZoom: 0.5, autoYMax: 100, trueYMax: 100, yPan: 0, keepZeroVisible: true }),
      ),
    )
    expect(result.current.viewY.min).toBeLessThanOrEqual(0)
    expect(result.current.viewY.max).toBeGreaterThanOrEqual(0)
  })

  it('resetView fits the true extent on both axes, centered', () => {
    const onXZoom = vi.fn()
    const onXPan = vi.fn()
    const onYZoom = vi.fn()
    const onYPan = vi.fn()
    const { result } = renderHook(() =>
      useChartAxes(baseConfig({ autoYMax: 50, trueYMax: 200, onXZoom, onXPan, onYZoom, onYPan })),
    )
    act(() => result.current.resetView())
    expect(onXZoom).toHaveBeenCalledWith(1)
    expect(onXPan).toHaveBeenCalledWith(0)
    expect(onYZoom).toHaveBeenCalledWith(4) // 200 / 50
    // fitZoomPan(50, 0, 200): zoom = 200/50 = 4; pan = (0+200)/2/50 - 0.5 = 1.5
    expect(onYPan).toHaveBeenCalledWith(1.5)
  })

  it('preserves the zoom=1/pan=0 default view even when trueYMax is below autoYMax (the common non-spike case)', () => {
    const { result } = renderHook(() => useChartAxes(baseConfig({ autoYMax: 2, trueYMax: 1 })))
    expect(result.current.viewY).toEqual({ min: 0, max: 2 })
  })

  it('lets the y-pan actually move under keepZeroVisible, rather than freezing at every zoom (regression for the composed-clamp bug)', () => {
    const onYPan = vi.fn()
    const { result } = renderHook(() =>
      useChartAxes(baseConfig({ yZoom: 0.5, autoYMax: 2000, trueYMax: 2000, keepZeroVisible: true, onYPan })),
    )
    act(() => result.current.setYPan(-0.5))
    const pan1 = onYPan.mock.calls.at(-1)![0] as number
    onYPan.mockClear()
    act(() => result.current.setYPan(-0.3))
    const pan2 = onYPan.mock.calls.at(-1)![0] as number
    expect(pan1).not.toBe(pan2)
    expect(pan1).toBeCloseTo(-0.5, 6)
    expect(pan2).toBeCloseTo(-0.3, 6)
  })

  it('never reports a y scrollbar for a keepZeroVisible chart, at any zoom (the reachable pan range is provably exactly one view-width wide)', () => {
    const { result: atDefaultZoom } = renderHook(() =>
      useChartAxes(baseConfig({ yZoom: 1, autoYMax: 2000, trueYMax: 2000, keepZeroVisible: true })),
    )
    expect(atDefaultZoom.current.yScrollbar).toBeNull()

    const { result: zoomedIn } = renderHook(() =>
      useChartAxes(baseConfig({ yZoom: 0.2, autoYMax: 2000, trueYMax: 2000, keepZeroVisible: true })),
    )
    expect(zoomedIn.current.yScrollbar).toBeNull()
  })
})
