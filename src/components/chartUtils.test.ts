import { describe, it, expect } from 'vitest'
import { clampHeight, clampZoom, DIST_HEIGHT, linearBarWidth, logBarWidth, SIM_HEIGHT, Y_ZOOM_RANGE } from './chartUtils'

describe('bar widths', () => {
  it('caps a linear bar at 16px however much room there is', () => {
    expect(linearBarWidth(400)).toBe(16)
  })

  it('leaves a 14% gap when the slot is the constraint', () => {
    expect(linearBarWidth(10)).toBeCloseTo(8.6, 6)
  })

  it('never lets a bar disappear', () => {
    expect(linearBarWidth(0.5)).toBe(2)
    expect(logBarWidth(0)).toBeCloseTo(6.8, 6) // no measurable gap → 8px fallback
  })

  it('caps a log-axis bar at 12px', () => {
    expect(logBarWidth(400)).toBe(12)
    expect(logBarWidth(10)).toBeCloseTo(8.5, 6)
  })
})

describe('clampHeight', () => {
  it('keeps a height inside the range', () => {
    expect(clampHeight(400, DIST_HEIGHT)).toBe(400)
  })

  it('clamps below the floor and above the ceiling', () => {
    expect(clampHeight(10, DIST_HEIGHT)).toBe(220)
    expect(clampHeight(99_999, DIST_HEIGHT)).toBe(900)
    expect(clampHeight(10, SIM_HEIGHT)).toBe(160)
    expect(clampHeight(99_999, SIM_HEIGHT)).toBe(800)
  })

  it('rounds fractional heights', () => {
    expect(clampHeight(340.6, DIST_HEIGHT)).toBe(341)
  })

  it('falls back when the stored value is not a number', () => {
    expect(clampHeight(NaN, DIST_HEIGHT)).toBe(DIST_HEIGHT.fallback)
    expect(clampHeight(Infinity, SIM_HEIGHT)).toBe(SIM_HEIGHT.fallback)
  })

  it('has a fallback inside its own range', () => {
    expect(clampHeight(DIST_HEIGHT.fallback, DIST_HEIGHT)).toBe(DIST_HEIGHT.fallback)
    expect(clampHeight(SIM_HEIGHT.fallback, SIM_HEIGHT)).toBe(SIM_HEIGHT.fallback)
  })
})

describe('clampZoom', () => {
  it('keeps a zoom factor inside the range', () => {
    expect(clampZoom(1)).toBe(1)
    expect(clampZoom(2)).toBe(2)
  })

  it('clamps below the floor and above the ceiling', () => {
    expect(clampZoom(0.01)).toBe(Y_ZOOM_RANGE.min)
    expect(clampZoom(50)).toBe(Y_ZOOM_RANGE.max)
  })

  it('falls back to 1 when the stored value is not a number', () => {
    expect(clampZoom(NaN)).toBe(1)
    expect(clampZoom(Infinity)).toBe(1)
  })
})
