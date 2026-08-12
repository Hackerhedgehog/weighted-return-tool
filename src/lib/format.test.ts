import { describe, it, expect } from 'vitest'
import {
  fmtCredits,
  fmtDecimal,
  fmtPayout,
  fmtPct,
  fmtRtp,
  fmtSig,
  fmtWeight,
  toPlainDecimal,
} from './format'

describe('fmtDecimal', () => {
  it('never uses scientific notation', () => {
    expect(fmtDecimal(0.000166618069702)).toBe('0.000166618069702')
    expect(fmtDecimal(1e-8)).toBe('0.00000001')
    expect(fmtDecimal(1e-15)).toBe('0.000000000000001')
  })

  it('caps at 15 decimal places', () => {
    expect(fmtDecimal(1 / 3)).toBe('0.333333333333333')
  })

  it('trims trailing zeros', () => {
    expect(fmtDecimal(0.5)).toBe('0.5')
    expect(fmtDecimal(2)).toBe('2')
  })

  it('handles zero and non-finite values', () => {
    expect(fmtDecimal(0)).toBe('0')
    expect(fmtDecimal(NaN)).toBe('—')
    expect(fmtDecimal(Infinity)).toBe('—')
  })

  it('rounds anything below 1e-15 to zero rather than showing an exponent', () => {
    expect(fmtDecimal(1e-20)).toBe('0')
  })
})

describe('toPlainDecimal', () => {
  it('expands negative exponents', () => {
    expect(toPlainDecimal('1e-8')).toBe('0.00000001')
    expect(toPlainDecimal('1.234e-7')).toBe('0.0000001234')
    expect(toPlainDecimal('-2.5e-3')).toBe('-0.0025')
  })

  it('expands positive exponents', () => {
    expect(toPlainDecimal('1.5e+3')).toBe('1500')
    expect(toPlainDecimal('1e21')).toBe('1000000000000000000000')
  })

  it('passes plain decimals through untouched', () => {
    expect(toPlainDecimal('0.5')).toBe('0.5')
    expect(toPlainDecimal('1200350')).toBe('1200350')
  })
})

describe('fmtSig', () => {
  it('reproduces values from example-output-data.tsv at 10 significant digits', () => {
    expect(fmtSig((1000 * 200) / 1200350)).toBe('0.1666180697')
    expect(fmtSig(200 / 1200350)).toBe('0.0001666180697')
    expect(fmtSig(15000 / 1200350)).toBe('0.01249635523')
    expect(fmtSig((0.33 * 290000) / 1200350)).toBe('0.07972674637')
    expect(fmtSig(550000 / 1200350)).toBe('0.4581996918')
  })

  it('formats exact integers plainly', () => {
    expect(fmtSig(0)).toBe('0')
    expect(fmtSig(1)).toBe('1')
    expect(fmtSig(1200350)).toBe('1200350')
  })

  it('never emits an exponent', () => {
    expect(fmtSig(1.234e-9)).not.toContain('e')
    expect(fmtSig(1.234e-9)).toBe('0.000000001234')
  })

  it('returns an empty string for non-finite values', () => {
    expect(fmtSig(NaN)).toBe('')
  })
})

describe('display helpers', () => {
  it('formats payouts in shortest round-trip form', () => {
    expect(fmtPayout(1000)).toBe('1000')
    expect(fmtPayout(18.7)).toBe('18.7')
    expect(fmtPayout(0.33)).toBe('0.33')
    expect(fmtPayout(0)).toBe('0')
    expect(fmtPayout(NaN)).toBe('—')
  })

  it('groups weights', () => {
    expect(fmtWeight(1200350)).toBe('1,200,350')
    expect(fmtWeight(0)).toBe('0')
  })

  it('formats RTP to four decimals', () => {
    expect(fmtRtp(0.95)).toBe('0.9500')
    expect(fmtRtp(NaN)).toBe('—')
  })

  it('formats percentages for chart and hint use', () => {
    expect(fmtPct(0.5)).toBe('50%')
    expect(fmtPct(0.12345, 2)).toBe('12.35%')
    expect(fmtPct(NaN)).toBe('—')
  })
})

describe('fmtCredits', () => {
  it('groups integers at 1000 and above, like fmtWeight', () => {
    expect(fmtCredits(1200350)).toBe('1,200,350')
    expect(fmtCredits(1000)).toBe('1,000')
  })

  it('keeps two decimal places below 1000, unlike fmtWeight', () => {
    expect(fmtCredits(0.5)).toBe('0.5')
    expect(fmtCredits(999.999)).toBe('1000')
    expect(fmtCredits(12.3456)).toBe('12.35')
  })

  it('never rounds a fractional balance up to a whole credit', () => {
    // The scenario the bug report was about: busted holding half a credit.
    expect(fmtCredits(0.5)).not.toBe('1')
    expect(fmtCredits(0.5)).toBe('0.5')
  })

  it('handles zero and non-finite values', () => {
    expect(fmtCredits(0)).toBe('0')
    expect(fmtCredits(NaN)).toBe('—')
    expect(fmtCredits(Infinity)).toBe('—')
  })

  it('applies the same 1000 threshold to negative values by magnitude', () => {
    expect(fmtCredits(-0.5)).toBe('-0.5')
    expect(fmtCredits(-1200)).toBe('-1,200')
  })
})
