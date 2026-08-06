import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseTsv } from './parse'
import { groupOf, rescaleToTotal, retargetRtp, solveWeights, statsOf } from './distribute'
import { CURVE_PRESETS, DEFAULT_TARGETS, VOLATILITY_STEPS, type BucketRow } from './types'

const rows = parseTsv(readFileSync('example-input-data.tsv', 'utf8')).rows
const T = 1200350
const withWeights = (w: number[]): BucketRow[] => rows.map((r, i) => ({ ...r, weight: w[i] }))
const sum = (w: number[]) => w.reduce((a, b) => a + b, 0)

describe('groupOf', () => {
  it('splits on 0 and 1', () => {
    expect(groupOf(0)).toBe(0)
    expect(groupOf(0.33)).toBe(1)
    expect(groupOf(1)).toBe(1)
    expect(groupOf(1.8)).toBe(2)
    expect(groupOf(1000)).toBe(2)
  })
})

describe('statsOf', () => {
  it('measures hit chance above 0 and win chance above 1', () => {
    const s = statsOf(parseTsv(readFileSync('example-output-data.tsv', 'utf8')).rows, T)
    expect(s.rtp).toBeCloseTo(1.0881926105, 8)
    // 1 minus the five zero-payout buckets
    expect(s.hitChance).toBeCloseTo(0.4903153247, 8)
    // the 23 buckets paying above 1x hold 128,550 of the 1,200,350 weight
    expect(s.winChance).toBeCloseTo(0.1070937643, 8)
  })
})

describe('solveWeights at the default targets', () => {
  const r = solveWeights(rows, T, DEFAULT_TARGETS, CURVE_PRESETS.medium)

  it('sums to the total exactly', () => {
    expect(sum(r.weights)).toBe(T)
  })

  it('produces only non-negative integers', () => {
    expect(r.weights.every((w) => Number.isInteger(w) && w >= 0)).toBe(true)
  })

  it('hits the RTP target', () => {
    expect(statsOf(withWeights(r.weights), T).rtp).toBeCloseTo(0.95, 6)
  })

  it('lands on the preferred chances without spending the band', () => {
    const s = statsOf(withWeights(r.weights), T)
    expect(s.hitChance).toBeCloseTo(0.3, 4)
    expect(s.winChance).toBeCloseTo(0.12, 4)
    expect(r.bandUsed).toBe(0)
    expect(r.warnings).toHaveLength(0)
  })

  it('gives every bucket at least one weight unit when the budget allows', () => {
    expect(Math.min(...r.weights)).toBeGreaterThanOrEqual(1)
  })
})

describe('volatility', () => {
  it('monotonically thins the big-payout tail as volatility falls', () => {
    // Measured across the whole tail rather than the single top bucket: at low
    // volatility the 1000x share falls below one weight unit and gets held up
    // by the min-weight-1 floor, so low and very low tie there.
    const tail = rows.map((r, i) => [r, i] as const).filter(([r]) => r.payout >= 100).map(([, i]) => i)

    const weights = [...VOLATILITY_STEPS].reverse().map((v) => {
      const r = solveWeights(rows, T, DEFAULT_TARGETS, CURVE_PRESETS[v])
      // volatility must not disturb the other targets
      const s = statsOf(withWeights(r.weights), T)
      expect(s.rtp).toBeCloseTo(0.95, 6)
      expect(s.hitChance).toBeCloseTo(0.3, 4)
      expect(s.winChance).toBeCloseTo(0.12, 4)
      return tail.reduce((a, i) => a + r.weights[i], 0)
    })

    // reversed VOLATILITY_STEPS runs very high -> very low
    for (let i = 1; i < weights.length; i++) {
      expect(weights[i]).toBeLessThan(weights[i - 1])
    }
  })

  it('never lets a bucket vanish entirely, even at the extreme', () => {
    const r = solveWeights(rows, T, DEFAULT_TARGETS, CURVE_PRESETS['very low'])
    expect(Math.min(...r.weights)).toBeGreaterThanOrEqual(1)
  })

  it('moves that mass to the middle of the ladder instead', () => {
    const mid = rows.findIndex((r) => r.label === 'bonuspaid-8-16x')
    const high = solveWeights(rows, T, DEFAULT_TARGETS, CURVE_PRESETS['very high']).weights[mid]
    const low = solveWeights(rows, T, DEFAULT_TARGETS, CURVE_PRESETS['very low']).weights[mid]
    expect(low).toBeGreaterThan(high)
  })
})

describe('locks', () => {
  it('never moves a locked weight', () => {
    const locked = rows.map((r, i) => (i === 0 ? { ...r, weight: 12345, locked: true } : r))
    const r = solveWeights(locked, T, DEFAULT_TARGETS, CURVE_PRESETS.medium)
    expect(r.weights[0]).toBe(12345)
    expect(sum(r.weights)).toBe(T)
  })

  it('keeps several locks simultaneously', () => {
    const locked = rows.map((r, i) =>
      i % 5 === 0 ? { ...r, weight: 1000 * (i + 1), locked: true } : r,
    )
    const r = solveWeights(locked, T, DEFAULT_TARGETS, CURVE_PRESETS.medium)
    locked.forEach((row, i) => {
      if (row.locked) expect(r.weights[i]).toBe(row.weight)
    })
    expect(sum(r.weights)).toBe(T)
  })

  it('warns, and still balances the total, when a lock overruns its group', () => {
    const locked = rows.map((r, i) => (i === 0 ? { ...r, weight: T - 1000, locked: true } : r))
    const r = solveWeights(locked, T, DEFAULT_TARGETS, CURVE_PRESETS.medium)
    expect(r.weights[0]).toBe(T - 1000)
    expect(sum(r.weights)).toBe(T)
    expect(r.warnings.length).toBeGreaterThan(0)
  })
})

describe('the tolerance band', () => {
  const lo = 0.3 * (1 - 0.035)
  const hi = 0.3 * (1 + 0.035)

  it('never leaves the band, whatever the RTP target', () => {
    for (const rtp of [0.2, 0.5, 0.95, 1.5, 5, 50, 200]) {
      const r = solveWeights(rows, T, { ...DEFAULT_TARGETS, rtp }, CURVE_PRESETS.medium)
      const s = statsOf(withWeights(r.weights), T)
      expect(Math.abs(r.bandUsed)).toBeLessThanOrEqual(1)
      expect(sum(r.weights)).toBe(T)
      expect(s.hitChance).toBeGreaterThanOrEqual(lo - 1e-4)
      expect(s.hitChance).toBeLessThanOrEqual(hi + 1e-4)
    }
  })

  it('opens only when the target is otherwise unreachable', () => {
    const tight = { ...DEFAULT_TARGETS, winChance: 0.0005 }
    const opened = [0.7, 0.75, 0.78, 0.8, 0.81, 0.82].some(
      (rtp) => Math.abs(solveWeights(rows, T, { ...tight, rtp }, CURVE_PRESETS.medium).bandUsed) > 0,
    )
    expect(opened).toBe(true)
  })

  it('warns when even the band cannot reach the target', () => {
    const impossible = { ...DEFAULT_TARGETS, winChance: 0.0005, rtp: 3 }
    const r = solveWeights(rows, T, impossible, CURVE_PRESETS.medium)
    expect(r.warnings.length).toBeGreaterThan(0)
    expect(sum(r.weights)).toBe(T)
  })
})

describe('rescaleToTotal', () => {
  const start = solveWeights(rows, T, DEFAULT_TARGETS, CURVE_PRESETS.medium).weights

  it('scales to a new total', () => {
    const out = rescaleToTotal(withWeights(start), 600000)!
    expect(sum(out)).toBe(600000)
  })

  it('leaves locked rows untouched', () => {
    const src = withWeights(start).map((r, i) => (i === 3 ? { ...r, locked: true } : r))
    const out = rescaleToTotal(src, 600000)!
    expect(out[3]).toBe(src[3].weight)
    expect(sum(out)).toBe(600000)
  })

  it('rejects a total below the locked sum', () => {
    const src = rows.map((r, i) =>
      i === 0 ? { ...r, weight: 5000, locked: true } : { ...r, weight: 10 },
    )
    expect(rescaleToTotal(src, 100)).toBeNull()
  })

  it('spreads the budget when every unlocked weight is zero', () => {
    const src = rows.map((r) => ({ ...r, weight: 0 }))
    const out = rescaleToTotal(src, 3000)!
    expect(sum(out)).toBe(3000)
  })
})

describe('retargetRtp', () => {
  const start = solveWeights(rows, T, DEFAULT_TARGETS, CURVE_PRESETS.medium).weights

  it('reaches a new RTP without moving hit or win chance', () => {
    const before = statsOf(withWeights(start), T)
    const out = retargetRtp(withWeights(start), T, 1.05)
    const after = statsOf(withWeights(out), T)

    expect(sum(out)).toBe(T)
    expect(after.rtp).toBeCloseTo(1.05, 4)
    expect(after.hitChance).toBeCloseTo(before.hitChance, 5)
    expect(after.winChance).toBeCloseTo(before.winChance, 5)
  })

  it('works downwards too', () => {
    const out = retargetRtp(withWeights(start), T, 0.8)
    expect(statsOf(withWeights(out), T).rtp).toBeCloseTo(0.8, 4)
    expect(sum(out)).toBe(T)
  })

  it('respects locks', () => {
    const src = withWeights(start).map((r, i) => (i === 0 ? { ...r, locked: true } : r))
    const out = retargetRtp(src, T, 1.05)
    expect(out[0]).toBe(src[0].weight)
    expect(sum(out)).toBe(T)
  })
})
