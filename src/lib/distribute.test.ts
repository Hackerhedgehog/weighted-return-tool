import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseTsv } from './parse'
import {
  groupOf,
  largestRemainder,
  minTotalWeight,
  rescaleToTotal,
  residualIndex,
  retargetRtp,
  solveWeights,
  statsOf,
  weightForChance,
  weightForValue,
} from './distribute'
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

describe('single-cell solves', () => {
  const start = solveWeights(rows, T, DEFAULT_TARGETS, CURVE_PRESETS.medium).weights

  // Weights are integers, so "exactly" means within one weight unit: 1/total
  // for a chance, payout/total for a weighted value. Scaling by the stale
  // total, which is what these replace, misses by far more than that.
  it('makes a typed chance land, despite the total moving with it', () => {
    const i = 10
    const w = weightForChance(start[i], T, 0.25)!
    const after = withWeights(start).map((r, k) => (k === i ? { ...r, weight: w } : r))
    const newTotal = after.reduce((a, r) => a + r.weight, 0)
    expect(after[i].weight / newTotal).toBeCloseTo(0.25, 5)
  })

  it('makes a typed weighted value land', () => {
    const i = 10
    const payout = rows[i].payout
    const w = weightForValue(start[i], T, payout, 0.05)!
    const after = withWeights(start).map((r, k) => (k === i ? { ...r, weight: w } : r))
    const newTotal = after.reduce((a, r) => a + r.weight, 0)
    expect((payout * after[i].weight) / newTotal).toBeCloseTo(0.05, 5)
  })

  it('beats scaling by the stale total, which is why it exists', () => {
    const i = 10
    const naive = Math.round(0.25 * T) // the obvious-but-wrong approach
    const after = withWeights(start).map((r, k) => (k === i ? { ...r, weight: naive } : r))
    const newTotal = after.reduce((a, r) => a + r.weight, 0)
    // lands near 0.20, not 0.25 — visibly wrong in the cell just typed into
    expect(Math.abs(after[i].weight / newTotal - 0.25)).toBeGreaterThan(0.01)
  })

  it('refuses the unsatisfiable', () => {
    // no finite weight gives one bucket all the probability while others exist
    expect(weightForChance(100, 1000, 1)).toBeNull()
    expect(weightForChance(100, 1000, -0.1)).toBeNull()
    // a bucket cannot return more than its own payout
    expect(weightForValue(100, 1000, 2, 2)).toBeNull()
    expect(weightForValue(100, 1000, 2, 5)).toBeNull()
    // a lone bucket has no other weight to balance against
    expect(weightForChance(1000, 1000, 0.5)).toBeNull()
  })
})

describe('single-cell solves with a weight step', () => {
  it('rounds the solved weight to the nearest step multiple', () => {
    // exact answer is 0.3·900/0.7 ≈ 385.7 → 400 on the 100-step
    expect(weightForChance(100, 1000, 0.3, 100)).toBe(400)
    // exact answer is 300 — already on the step
    expect(weightForValue(100, 1000, 2, 0.5, 100)).toBe(300)
  })

  it('keeps its refusals regardless of the step', () => {
    expect(weightForChance(100, 1000, 1, 100)).toBeNull()
    expect(weightForValue(100, 1000, 2, 5, 100)).toBeNull()
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
    const out = retargetRtp(withWeights(start), T, 1.05)!
    const after = statsOf(withWeights(out), T)

    expect(sum(out)).toBe(T)
    expect(after.rtp).toBeCloseTo(1.05, 4)
    expect(after.hitChance).toBeCloseTo(before.hitChance, 5)
    expect(after.winChance).toBeCloseTo(before.winChance, 5)
  })

  it('works downwards too', () => {
    const out = retargetRtp(withWeights(start), T, 0.8)!
    expect(statsOf(withWeights(out), T).rtp).toBeCloseTo(0.8, 4)
    expect(sum(out)).toBe(T)
  })

  it('respects locks', () => {
    const src = withWeights(start).map((r, i) => (i === 0 ? { ...r, locked: true } : r))
    const out = retargetRtp(src, T, 1.05)!
    expect(out[0]).toBe(src[0].weight)
    expect(sum(out)).toBe(T)
  })
})

describe('weight steps on rescale and retarget', () => {
  const T100 = 1200300
  const start = solveWeights(rows, T100, DEFAULT_TARGETS, CURVE_PRESETS.medium, 100).weights

  it('rescales on the step', () => {
    const out = rescaleToTotal(withWeights(start), 600000, 100)!
    expect(out).not.toBeNull()
    expect(sum(out)).toBe(600000)
    expect(out.every((w) => w % 100 === 0)).toBe(true)
  })

  it('rejects a rescale whose free budget is off the step', () => {
    expect(rescaleToTotal(withWeights(start), 600050, 100)).toBeNull()
  })

  it('retargets RTP while keeping every weight on the step', () => {
    const out = retargetRtp(withWeights(start), T100, 1.05, 100)!
    expect(out).not.toBeNull()
    expect(sum(out)).toBe(T100)
    expect(out.every((w) => w % 100 === 0)).toBe(true)
    expect(statsOf(withWeights(out), T100).rtp).toBeCloseTo(1.05, 4)
  })

  it('refuses to retarget when the current weights sit off the step', () => {
    // the step-1 solve at T puts 144,042 in the win group — not a multiple of 100
    const offStep = solveWeights(rows, T, DEFAULT_TARGETS, CURVE_PRESETS.medium).weights
    expect(retargetRtp(withWeights(offStep), T, 1.05, 100)).toBeNull()
  })
})

describe('largestRemainder with a step', () => {
  it('allocates only multiples of the step, exactly to the total', () => {
    const out = largestRemainder([3, 1, 1], 1000, false, 100)
    expect(out).toEqual([600, 200, 200])
  })

  it('minOne gives every entry at least one step', () => {
    const out = largestRemainder([1000, 1, 1], 300, true, 100)
    expect(out.every((v) => v >= 100 && v % 100 === 0)).toBe(true)
    expect(sum(out)).toBe(300)
  })

  it('defaults to unit granularity', () => {
    expect(sum(largestRemainder([1, 1, 1], 10, false))).toBe(10)
  })
})

describe('solveWeights with a weight step', () => {
  // T = 1,200,350 divides by 10 but not by 100
  const T100 = 1200300

  it('lands every weight on a multiple of 10 and still sums exactly', () => {
    const r = solveWeights(rows, T, DEFAULT_TARGETS, CURVE_PRESETS.medium, 10)
    expect(r.weights.every((w) => w % 10 === 0)).toBe(true)
    expect(sum(r.weights)).toBe(T)
    expect(r.warnings).toHaveLength(0)
  })

  it('hits RTP to step granularity and keeps the chances in band', () => {
    const r = solveWeights(rows, T100, DEFAULT_TARGETS, CURVE_PRESETS.medium, 100)
    expect(r.weights.every((w) => w % 100 === 0)).toBe(true)
    expect(sum(r.weights)).toBe(T100)
    expect(Math.min(...r.weights)).toBeGreaterThanOrEqual(100)
    const s = statsOf(withWeights(r.weights), T100)
    expect(s.rtp).toBeCloseTo(0.95, 4)
    expect(s.hitChance).toBeCloseTo(0.3, 3)
    expect(s.winChance).toBeCloseTo(0.12, 3)
  })

  it('distributes anyway when the free weight does not divide, parking the remainder', () => {
    // T = 1,200,350 leaves 50 over the 100-step
    const r = solveWeights(rows, T, DEFAULT_TARGETS, CURVE_PRESETS.medium, 100)

    expect(sum(r.weights)).toBe(T)
    expect(r.weights).not.toEqual(rows.map((row) => Math.max(0, Math.round(row.weight))))

    const offStep = r.weights.filter((w) => w % 100 !== 0)
    expect(offStep).toHaveLength(1)
    expect(offStep[0] % 100).toBe(50)
  })

  it('parks the remainder on the lowest-payout bucket, so RTP barely moves', () => {
    const r = solveWeights(rows, T, DEFAULT_TARGETS, CURVE_PRESETS.medium, 100)
    const carrier = r.weights.findIndex((w) => w % 100 !== 0)

    const minPayout = Math.min(...rows.map((row) => row.payout))
    expect(rows[carrier].payout).toBe(minPayout)
    expect(statsOf(withWeights(r.weights), T).rtp).toBeCloseTo(0.95, 4)
  })

  it('says where the remainder went instead of refusing', () => {
    const r = solveWeights(rows, T, DEFAULT_TARGETS, CURVE_PRESETS.medium, 100)
    const carrier = r.weights.findIndex((w) => w % 100 !== 0)
    const note = r.warnings.find((w) => w.includes('remaining'))
    expect(note).toBeDefined()
    expect(note).toContain('1,200,350')
    expect(note).toContain('not a multiple of 100')
    expect(note).toContain(rows[carrier].label)
  })

  it('leaves locked rows alone while parking a remainder', () => {
    const wi = rows.findIndex((r) => r.payout > 1)
    const locked = rows.map((r, i) => (i === wi ? { ...r, weight: 5000, locked: true } : r))
    const r = solveWeights(locked, T, DEFAULT_TARGETS, CURVE_PRESETS.medium, 100)
    expect(r.weights[wi]).toBe(5000)
    expect(sum(r.weights)).toBe(T)
  })

  it('needs no remainder note when the free weight divides cleanly', () => {
    const r = solveWeights(rows, T100, DEFAULT_TARGETS, CURVE_PRESETS.medium, 100)
    expect(r.warnings.some((w) => w.includes('remaining'))).toBe(false)
  })

  it('allows an off-step locked weight when the free budget still divides', () => {
    const zi = rows.findIndex((r) => r.payout === 0)
    const locked = rows.map((r, i) => (i === zi ? { ...r, weight: 107421, locked: true } : r))
    const total = 107421 + T100 // free budget stays a multiple of 100
    const r = solveWeights(locked, total, DEFAULT_TARGETS, CURVE_PRESETS.medium, 100)
    expect(r.weights[zi]).toBe(107421)
    expect(sum(r.weights)).toBe(total)
    locked.forEach((row, i) => {
      if (!row.locked) expect(r.weights[i] % 100).toBe(0)
    })
    expect(r.warnings).toHaveLength(0)
  })
})

describe('the minimum weight floor', () => {
  it('leaves no unlocked bucket on zero when a group has no mass', () => {
    const flat = { ...DEFAULT_TARGETS, hitChance: 0.12, winChance: 0.12 }
    const r = solveWeights(rows, T, flat, CURVE_PRESETS.medium)
    expect(Math.min(...r.weights)).toBeGreaterThanOrEqual(1)
    expect(sum(r.weights)).toBe(T)
  })

  it('gives every unlocked bucket a full step when the step is coarse', () => {
    const r = solveWeights(rows, 10_000, DEFAULT_TARGETS, CURVE_PRESETS.medium, 100)
    expect(Math.min(...r.weights)).toBeGreaterThanOrEqual(100)
    expect(sum(r.weights)).toBe(10_000)
  })

  it('refuses, naming a workable total, when the step cannot go round', () => {
    const r = solveWeights(rows, 1_000, DEFAULT_TARGETS, CURVE_PRESETS.medium, 100)
    expect(r.weights).toEqual(rows.map(() => 0))
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toContain('30 unlocked buckets')
    expect(r.warnings[0]).toContain('3,000')
  })

  it('counts locked weight towards the workable total', () => {
    const locked = rows.map((r, i) => (i === 0 ? { ...r, weight: 5_000, locked: true } : r))
    expect(minTotalWeight(locked, 100)).toBe(5_000 + 29 * 100)
    expect(minTotalWeight(rows, 1)).toBe(30)
  })

  it('leaves a locked zero weight on zero', () => {
    const locked = rows.map((r, i) => (i === 0 ? { ...r, weight: 0, locked: true } : r))
    const r = solveWeights(locked, T, DEFAULT_TARGETS, CURVE_PRESETS.medium)
    expect(r.weights[0]).toBe(0)
    expect(sum(r.weights)).toBe(T)
  })

  it('costs the chance targets nothing when every group clears its floor', () => {
    const r = solveWeights(rows, 1_200_300, DEFAULT_TARGETS, CURVE_PRESETS.medium, 100)
    const s = statsOf(withWeights(r.weights), 1_200_300)
    expect(s.hitChance).toBeCloseTo(0.3, 4)
    expect(s.winChance).toBeCloseTo(0.12, 4)
  })
})

describe('solver switches', () => {
  const noChances = { ...DEFAULT_TARGETS, useChances: false }

  it('hits RTP without steering the chances', () => {
    const r = solveWeights(rows, T, noChances, CURVE_PRESETS.medium)
    const s = statsOf(withWeights(r.weights), T)
    expect(sum(r.weights)).toBe(T)
    expect(s.rtp).toBeCloseTo(DEFAULT_TARGETS.rtp, 4)
  })

  it('reports nothing about chances it was not asked to hit', () => {
    const r = solveWeights(rows, T, { ...noChances, hitChance: 0.9, winChance: 0.8 }, 0.09)
    expect(r.warnings.some((w) => w.includes('hit chance'))).toBe(false)
    expect(r.warnings.some((w) => w.includes('win chance'))).toBe(false)
  })

  it('lets the curve span the whole ladder once the groups are unpinned', () => {
    const steered = solveWeights(rows, T, DEFAULT_TARGETS, CURVE_PRESETS.medium)
    const free = solveWeights(rows, T, noChances, CURVE_PRESETS.medium)
    // both land on RTP, but the free solve is not held to the chance split
    expect(statsOf(withWeights(free.weights), T).rtp).toBeCloseTo(0.95, 4)
    expect(free.weights).not.toEqual(steered.weights)
  })

  it('drops the curvature term when volatility is off', () => {
    const curved = solveWeights(rows, T, DEFAULT_TARGETS, 0.32)
    const flat = solveWeights(rows, T, { ...DEFAULT_TARGETS, useVolatility: false }, 0.32)
    const pure = solveWeights(rows, T, { ...DEFAULT_TARGETS, useVolatility: false }, 0)

    // volatility off == c = 0, whatever the curve field says
    expect(flat.weights).toEqual(pure.weights)
    expect(flat.weights).not.toEqual(curved.weights)
    expect(statsOf(withWeights(flat.weights), T).rtp).toBeCloseTo(0.95, 4)
  })

  it('still respects locks with both switches off', () => {
    const wi = rows.findIndex((r) => r.payout > 1)
    const locked = rows.map((r, i) => (i === wi ? { ...r, weight: 5000, locked: true } : r))
    const r = solveWeights(
      locked,
      T,
      { ...DEFAULT_TARGETS, useChances: false, useVolatility: false },
      0.09,
    )
    expect(r.weights[wi]).toBe(5000)
    expect(sum(r.weights)).toBe(T)
  })
})

describe('the zero-payout residual', () => {
  it('picks the bucket labelled 0x', () => {
    expect(rows[residualIndex(rows)].label).toBe('0x')
  })

  it('ignores payout labels that merely contain the characters', () => {
    const table = [
      { ...rows[0], payout: 0, label: '1000x' },
      { ...rows[1], payout: 0, label: '100x' },
    ]
    expect(residualIndex(table)).toBe(-1)
  })

  it('accepts 0x as a token inside a longer label', () => {
    expect(residualIndex([{ ...rows[0], payout: 0, label: 'lose-0x-total' }])).toBe(0)
  })

  it('never picks a paying bucket', () => {
    expect(residualIndex([{ ...rows[0], payout: 2, label: '0x' }])).toBe(-1)
  })

  it('gives the residual the bulk of the zero mass on a weightless table', () => {
    const r = solveWeights(rows, T, DEFAULT_TARGETS, CURVE_PRESETS.medium)
    const zeros = rows.map((_, i) => i).filter((i) => rows[i].payout === 0)
    const zeroSum = zeros.reduce((a, i) => a + r.weights[i], 0)
    expect(r.weights[residualIndex(rows)] / zeroSum).toBeCloseTo(0.8, 2)
  })

  it('splits evenly when no bucket names itself the residual', () => {
    const anon = rows.map((r) => (r.payout === 0 ? { ...r, label: `dud-${r.bucketId}` } : r))
    const r = solveWeights(anon, T, DEFAULT_TARGETS, CURVE_PRESETS.medium)
    const got = anon.map((_, i) => i).filter((i) => anon[i].payout === 0).map((i) => r.weights[i])
    expect(Math.max(...got) - Math.min(...got)).toBeLessThanOrEqual(1)
  })

  it('preserves an existing zero balance rather than reshaping it', () => {
    const seeded = solveWeights(rows, T, DEFAULT_TARGETS, CURVE_PRESETS.medium).weights
    const hand = withWeights(seeded).map((r) => (r.payout === 0 ? { ...r, weight: 100_000 } : r))
    const total = hand.reduce((a, r) => a + r.weight, 0)
    const again = solveWeights(hand, total, DEFAULT_TARGETS, CURVE_PRESETS.medium)
    const got = hand.map((_, i) => i).filter((i) => hand[i].payout === 0).map((i) => again.weights[i])
    expect(Math.max(...got) - Math.min(...got)).toBeLessThanOrEqual(1)
  })

  it('sizes the zero group by mass, not member count, with chances off', () => {
    const off = { ...DEFAULT_TARGETS, useChances: false }
    const r = solveWeights(rows, T, off, CURVE_PRESETS.medium)
    expect(statsOf(withWeights(r.weights), T).hitChance).toBeCloseTo(0.3, 2)
  })
})
