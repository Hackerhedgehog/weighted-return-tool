import { describe, it, expect } from 'vitest'
import {
  parseSpinsInput,
  blockPlan,
  buildAlias,
  emptyAggregate,
  mergeAggregate,
  mulberry32,
  runBlock,
  sampleOnce,
  statsFromAggregate,
} from './sim'

describe('mulberry32', () => {
  it('is deterministic for a given seed and stays in [0, 1)', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    for (let i = 0; i < 1000; i++) {
      const v = a()
      expect(v).toBe(b())
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('differs across seeds', () => {
    const a = mulberry32(1)()
    const b = mulberry32(2)()
    expect(a).not.toBe(b)
  })
})

describe('blockPlan', () => {
  it('yields one point per 0.1% of the requested spins', () => {
    expect(blockPlan(100_000_000)).toEqual({ blockSize: 100_000, blockCount: 1000 })
  })

  it('never goes below one spin per block', () => {
    expect(blockPlan(500)).toEqual({ blockSize: 1, blockCount: 500 })
    expect(blockPlan(1)).toEqual({ blockSize: 1, blockCount: 1 })
  })

  it('covers every spin including a short last block', () => {
    const { blockSize, blockCount } = blockPlan(1500)
    expect(blockSize).toBe(2)
    expect(blockCount).toBe(750)
    expect(blockSize * blockCount).toBeGreaterThanOrEqual(1500)
  })
})

describe('buildAlias + sampleOnce', () => {
  it('reproduces the weighted distribution over a long seeded run', () => {
    const table = buildAlias([0, 10], [750_000, 250_000])!
    const rand = mulberry32(7)
    let tens = 0
    const n = 100_000
    for (let i = 0; i < n; i++) if (sampleOnce(table, rand) === 10) tens += 1
    expect(tens / n).toBeGreaterThan(0.24)
    expect(tens / n).toBeLessThan(0.26)
  })

  it('never draws a zero-weight bucket', () => {
    const table = buildAlias([1, 5, 9], [100, 0, 100])!
    const rand = mulberry32(11)
    for (let i = 0; i < 10_000; i++) expect(sampleOnce(table, rand)).not.toBe(5)
  })

  it('handles a single bucket', () => {
    const table = buildAlias([3], [42])!
    const rand = mulberry32(1)
    expect(sampleOnce(table, rand)).toBe(3)
  })

  it('returns null when no weight is positive', () => {
    expect(buildAlias([1, 2], [0, 0])).toBeNull()
    expect(buildAlias([], [])).toBeNull()
  })
})

describe('aggregates and stats', () => {
  it('computes stats from a hand-built aggregate', () => {
    const stats = statsFromAggregate({
      spins: 4,
      sum: 6,
      sumSq: 14,
      hits: 3,
      wins: 2,
      maxWin: 3,
    })
    expect(stats.rtp).toBeCloseTo(1.5, 12)
    expect(stats.stdDev).toBeCloseTo(Math.sqrt(14 / 4 - 1.5 * 1.5), 12)
    expect(stats.hitRate).toBeCloseTo(0.75, 12)
    expect(stats.winRate).toBeCloseTo(0.5, 12)
    expect(stats.maxWin).toBe(3)
  })

  it('merging two blocks equals one combined run', () => {
    const table = buildAlias([0, 1, 4], [500, 300, 200])!
    const randA = mulberry32(5)
    const randB = mulberry32(5)

    const combined = emptyAggregate()
    runBlock(table, randB, 2000, combined)

    let split = emptyAggregate()
    const first = emptyAggregate()
    runBlock(table, randA, 1200, first)
    split = mergeAggregate(split, first)
    const second = emptyAggregate()
    runBlock(table, randA, 800, second)
    split = mergeAggregate(split, second)

    expect(split).toEqual(combined)
  })

  it('converges on the analytic stats of a known ladder', () => {
    // payouts 0 and 2, equal weight: rtp 1, variance 1, hit 0.5, win 0.5
    const table = buildAlias([0, 2], [1, 1])!
    const rand = mulberry32(1234)
    const agg = emptyAggregate()
    runBlock(table, rand, 200_000, agg)
    const stats = statsFromAggregate(agg)

    expect(stats.spins).toBe(200_000)
    expect(stats.rtp).toBeCloseTo(1, 1)
    expect(stats.stdDev).toBeCloseTo(1, 1)
    expect(stats.hitRate).toBeCloseTo(0.5, 1)
    expect(stats.winRate).toBeCloseTo(0.5, 1)
    expect(stats.maxWin).toBe(2)
  })

  it('reports the block mean from runBlock', () => {
    const table = buildAlias([7], [1])!
    const agg = emptyAggregate()
    const mean = runBlock(table, mulberry32(3), 50, agg)
    expect(mean).toBe(7)
    expect(agg.sum).toBe(350)
    expect(agg.spins).toBe(50)
    expect(agg.hits).toBe(50)
    expect(agg.wins).toBe(50)
    expect(agg.maxWin).toBe(7)
  })
})

describe('parseSpinsInput', () => {
  it('reads plain integers with separators', () => {
    expect(parseSpinsInput('100000000')).toBe(100_000_000)
    expect(parseSpinsInput('100,000,000')).toBe(100_000_000)
    expect(parseSpinsInput('1 000 000')).toBe(1_000_000)
  })

  it('reads k / m / b shorthand, case-insensitively', () => {
    expect(parseSpinsInput('100m')).toBe(100_000_000)
    expect(parseSpinsInput('100M')).toBe(100_000_000)
    expect(parseSpinsInput('250k')).toBe(250_000)
    expect(parseSpinsInput('1.5m')).toBe(1_500_000)
    expect(parseSpinsInput('1b')).toBe(1_000_000_000)
  })

  it('clamps to the supported range and rejects junk', () => {
    expect(parseSpinsInput('0')).toBe(1)
    expect(parseSpinsInput('2b')).toBe(1_000_000_000)
    expect(parseSpinsInput('')).toBeNull()
    expect(parseSpinsInput('spin')).toBeNull()
    expect(parseSpinsInput('-5')).toBeNull()
  })
})
