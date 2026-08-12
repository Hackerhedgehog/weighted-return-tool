// src/components/chartView.test.ts
import { describe, it, expect } from 'vitest'
import {
  clampPanKeepZeroVisible,
  clampPanToExtent,
  fitZoomPan,
  panFromScrollbarStart,
  scrollbarGeometry,
  viewRange,
} from './chartView'

describe('viewRange', () => {
  it('reproduces [0, autoMax] at zoom=1, pan=0 — the existing default view', () => {
    expect(viewRange(100, 1, 0)).toEqual({ min: 0, max: 100 })
  })

  it('centres on autoMax/2 when zoomed in with pan=0, instead of anchoring to 0', () => {
    expect(viewRange(100, 0.5, 0)).toEqual({ min: 25, max: 75 })
  })

  it('shifts the center by pan, in autoMax units', () => {
    expect(viewRange(100, 0.5, 0.2)).toEqual({ min: 45, max: 95 })
  })
})

describe('clampPanToExtent', () => {
  it('passes an in-bounds pan through unchanged', () => {
    expect(clampPanToExtent(100, 0.5, 0, 100)).toBe(0)
  })

  it('clamps so viewMin never drops below 0', () => {
    // zoom=0.5 -> span=50; centering at pan=-0.5 would put viewMin at -25
    const pan = clampPanToExtent(100, 0.5, -0.5, 100)
    expect(viewRange(100, 0.5, pan).min).toBeCloseTo(0, 6)
  })

  it('clamps so viewMax never exceeds the extent', () => {
    const pan = clampPanToExtent(100, 0.5, 0.5, 100)
    expect(viewRange(100, 0.5, pan).max).toBeCloseTo(100, 6)
  })

  it('centers exactly when the span is at least as wide as the extent', () => {
    expect(clampPanToExtent(100, 1, 0.3, 100)).toBe(0)
  })
})

describe('clampPanKeepZeroVisible', () => {
  it('passes through a pan that already keeps 0 in view', () => {
    expect(clampPanKeepZeroVisible(100, 1, 0)).toBe(0)
  })

  it('pulls the view back down so 0 stays visible when panned too far up', () => {
    // zoom=0.2 -> span=20; pan=1 would center at 120, putting viewMin at 110
    const pan = clampPanKeepZeroVisible(100, 0.2, 1)
    const v = viewRange(100, 0.2, pan)
    expect(v.min).toBeLessThanOrEqual(0)
    expect(v.max).toBeGreaterThanOrEqual(0)
  })

  it('pulls the view back up so 0 stays visible when panned too far down', () => {
    const pan = clampPanKeepZeroVisible(100, 0.2, -1)
    const v = viewRange(100, 0.2, pan)
    expect(v.min).toBeLessThanOrEqual(0)
    expect(v.max).toBeGreaterThanOrEqual(0)
  })
})

describe('fitZoomPan', () => {
  it('solves the zoom/pan that makes the view exactly [lo, hi]', () => {
    const { zoom, pan } = fitZoomPan(100, 20, 180)
    const v = viewRange(100, zoom, pan)
    expect(v.min).toBeCloseTo(20, 6)
    expect(v.max).toBeCloseTo(180, 6)
  })

  it('returns zoom=1, pan=0 when fitting exactly the auto range', () => {
    expect(fitZoomPan(100, 0, 100)).toEqual({ zoom: 1, pan: 0 })
  })
})

describe('scrollbarGeometry / panFromScrollbarStart', () => {
  it('reports a full-size thumb with no scrolling needed at zoom=1', () => {
    expect(scrollbarGeometry(100, 1, 0, 0, 100)).toEqual({ size: 1, start: 0 })
  })

  it('reports a half-size thumb positioned at the current pan', () => {
    const { size, start } = scrollbarGeometry(100, 0.5, 0, 0, 100)
    expect(size).toBeCloseTo(0.5, 6)
    expect(start).toBeCloseTo(0.25, 6)
  })

  it('round-trips: the pan a given thumb start implies reproduces that start', () => {
    const pan = panFromScrollbarStart(100, 0.5, 0.1, 0, 100)
    const { start } = scrollbarGeometry(100, 0.5, pan, 0, 100)
    expect(start).toBeCloseTo(0.1, 6)
  })
})
