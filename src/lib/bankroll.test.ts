import { describe, it, expect } from 'vitest'
import { buildAlias, mulberry32 } from './sim'
import {
  effectiveRtp,
  initialBankrollState,
  realisedRtp,
  runBankrollBlock,
  scalePayouts,
} from './bankroll'

/** Always pays exactly `payout` — removes the PRNG from balance arithmetic. */
const fixed = (payout: number) => buildAlias([payout], [1])!
const rand = () => mulberry32(1)

describe('runBankrollBlock — the spin', () => {
  it('stakes the bet and credits the payout', () => {
    // pays ×2 every spin at bet 1: balance climbs by exactly 1 per spin
    const s = initialBankrollState(10)
    const spun = runBankrollBlock(fixed(2), rand(), 5, 1, s)
    expect(spun).toBe(5)
    expect(s.balance).toBe(15)
    expect(s.spins).toBe(5)
    expect(s.busted).toBe(false)
  })

  it('scales the stake and the payout by the bet', () => {
    // pays ×2 at bet 4: balance climbs by 4 per spin
    const s = initialBankrollState(100)
    runBankrollBlock(fixed(2), rand(), 3, 4, s)
    expect(s.balance).toBe(112)
  })

  it('busts after exactly floor(credits / bet) spins on a dead table', () => {
    const s = initialBankrollState(10)
    const spun = runBankrollBlock(fixed(0), rand(), 1000, 1, s)
    expect(spun).toBe(10)
    expect(s.balance).toBe(0)
    expect(s.busted).toBe(true)
  })

  it('busts while it still holds change, because change cannot buy a spin', () => {
    const s = initialBankrollState(10.5)
    const spun = runBankrollBlock(fixed(0), rand(), 1000, 1, s)
    expect(spun).toBe(10)
    expect(s.balance).toBe(0.5)
    expect(s.busted).toBe(true)
  })

  it('spins when the balance is exactly the bet, and busts on the next check', () => {
    const s = initialBankrollState(1)
    const spun = runBankrollBlock(fixed(0), rand(), 1000, 1, s)
    expect(spun).toBe(1)
    expect(s.busted).toBe(true)
  })

  it('busts at zero spins when the bet already exceeds the balance', () => {
    const s = initialBankrollState(0.5)
    const spun = runBankrollBlock(fixed(0), rand(), 1000, 1, s)
    expect(spun).toBe(0)
    expect(s.spins).toBe(0)
    expect(s.busted).toBe(true)
  })
})

describe('runBankrollBlock — statistics', () => {
  it('tracks peak and low between spins', () => {
    const s = initialBankrollState(10)
    runBankrollBlock(fixed(2), rand(), 5, 1, s)
    expect(s.peak).toBe(15)
    // the stake dip inside a spin is not a low — 10 is the starting balance
    expect(s.low).toBe(10)
  })

  it('reports the busted balance as the low', () => {
    const s = initialBankrollState(10)
    runBankrollBlock(fixed(0), rand(), 1000, 1, s)
    expect(s.low).toBe(0)
    expect(s.peak).toBe(10)
  })

  it('counts hits, wins and the biggest multiplier', () => {
    const s = initialBankrollState(100)
    runBankrollBlock(fixed(2), rand(), 4, 1, s)
    expect(s.hits).toBe(4)
    expect(s.wins).toBe(4)
    expect(s.maxWin).toBe(2)

    const dead = initialBankrollState(100)
    runBankrollBlock(fixed(0), rand(), 4, 1, dead)
    expect(dead.hits).toBe(0)
    expect(dead.wins).toBe(0)
  })

  it('does not count a payout of exactly 1 as a win, but does as a hit', () => {
    const s = initialBankrollState(100)
    runBankrollBlock(fixed(1), rand(), 4, 1, s)
    expect(s.hits).toBe(4)
    expect(s.wins).toBe(0)
    expect(s.balance).toBe(100)
  })

  it('reports realised RTP as the mean payout, and NaN before any spin', () => {
    const s = initialBankrollState(100)
    runBankrollBlock(fixed(0.5), rand(), 10, 1, s)
    expect(realisedRtp(s)).toBeCloseTo(0.5, 12)
    expect(realisedRtp(initialBankrollState(100))).toBeNaN()
  })
})

describe('resumability', () => {
  it('two chunks from one state and PRNG equal one uninterrupted run', () => {
    // a real two-outcome table, so the PRNG genuinely drives the sequence
    const table = () => buildAlias([0, 2.5], [3, 1])!

    const once = initialBankrollState(500)
    runBankrollBlock(table(), mulberry32(7), 400, 1, once)

    const split = initialBankrollState(500)
    const r = mulberry32(7)
    runBankrollBlock(table(), r, 150, 1, split)
    runBankrollBlock(table(), r, 250, 1, split)

    expect(split).toEqual(once)
  })
})

describe('the RTP multiplier', () => {
  it('scales every payout', () => {
    expect(scalePayouts([0, 0.6, 2.5, 1000], 0.9)).toEqual([0, 0.54, 2.25, 900])
  })

  it('scales realised RTP proportionally but leaves hit rate alone', () => {
    const plain = initialBankrollState(1000)
    runBankrollBlock(buildAlias([0, 2], [1, 1])!, mulberry32(3), 200, 1, plain)

    const scaled = initialBankrollState(1000)
    runBankrollBlock(buildAlias(scalePayouts([0, 2], 0.5), [1, 1])!, mulberry32(3), 200, 1, scaled)

    expect(realisedRtp(scaled)).toBeCloseTo(realisedRtp(plain) * 0.5, 12)
    expect(scaled.hits).toBe(plain.hits)
  })

  it('multiplies the table RTP', () => {
    expect(effectiveRtp(0.95, 1)).toBeCloseTo(0.95, 12)
    expect(effectiveRtp(0.95, 0.9)).toBeCloseTo(0.855, 12)
  })
})
