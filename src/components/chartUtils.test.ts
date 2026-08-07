import { describe, it, expect } from 'vitest'
import { linearBarWidth, logBarWidth } from './chartUtils'

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
