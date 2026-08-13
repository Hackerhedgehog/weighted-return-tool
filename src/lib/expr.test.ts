import { describe, it, expect } from 'vitest'
import { evaluateExpression as ev } from './expr'

describe('evaluateExpression', () => {
  it('evaluates plain numbers', () => {
    expect(ev('200')).toBe(200)
    expect(ev('0.33')).toBe(0.33)
    expect(ev('.5')).toBe(0.5)
    expect(ev('0')).toBe(0)
  })

  it('evaluates the append forms the grid produces', () => {
    expect(ev('200+500')).toBe(700)
    expect(ev('200-50')).toBe(150)
    expect(ev('200*2')).toBe(400)
    expect(ev('200/2')).toBe(100)
  })

  it('respects precedence', () => {
    expect(ev('2+3*4')).toBe(14)
    expect(ev('12-6/3')).toBe(10)
  })

  it('respects parentheses', () => {
    expect(ev('(2+3)*4')).toBe(20)
    expect(ev('((1+2))*3')).toBe(9)
  })

  it('is left-associative for subtraction and division', () => {
    expect(ev('10-3-2')).toBe(5)
    expect(ev('100/5/2')).toBe(10)
  })

  it('handles unary minus and plus', () => {
    expect(ev('-5')).toBe(-5)
    expect(ev('+5')).toBe(5)
    expect(ev('2*-3')).toBe(-6)
    expect(ev('-(2+3)')).toBe(-5)
  })

  it('strips a leading = so spreadsheet habits work', () => {
    expect(ev('=200+5')).toBe(205)
    expect(ev('=42')).toBe(42)
  })

  it('strips thousands separators and whitespace', () => {
    expect(ev('1,200,350')).toBe(1200350)
    expect(ev(' 200 + 5 ')).toBe(205)
    expect(ev("1'000")).toBe(1000)
    expect(ev('1_000')).toBe(1000)
  })

  it('reads a comma as a decimal point unless it groups thousands', () => {
    expect(ev('1,5')).toBe(1.5)
    expect(ev('0,33+0,6')).toBeCloseTo(0.93, 10)
    expect(ev(',5')).toBe(0.5)
    expect(ev('2*1,5')).toBe(3)
    // A leading 0 groups nothing — this is a typed decimal, not 375.
    expect(ev('0,375')).toBe(0.375)
    // Exact thousands grouping keeps its long-standing meaning.
    expect(ev('1,500')).toBe(1500)
    expect(ev('(1+3)*250,000')).toBe(1_000_000)
  })

  it('supports decimals throughout', () => {
    expect(ev('50.16*2')).toBe(100.32)
    expect(ev('0.33+0.6')).toBeCloseTo(0.93, 10)
  })

  it('rejects invalid input rather than returning 0', () => {
    expect(ev('')).toBeNull()
    expect(ev('   ')).toBeNull()
    expect(ev('=')).toBeNull()
    expect(ev('200+')).toBeNull()
    expect(ev('abc')).toBeNull()
    expect(ev('200abc')).toBeNull()
    expect(ev('2++')).toBeNull()
    expect(ev('(2+3')).toBeNull()
    expect(ev('2+3)')).toBeNull()
    expect(ev('*5')).toBeNull()
  })

  it('rejects division by zero and non-finite results', () => {
    expect(ev('1/0')).toBeNull()
    expect(ev('1/(2-2)')).toBeNull()
  })
})
