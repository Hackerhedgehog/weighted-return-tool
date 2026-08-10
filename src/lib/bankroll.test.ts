import { describe, it, expect } from 'vitest'
import { buildAlias, mulberry32 } from './sim'
import {
  BANKROLL_MAX_POINTS,
  effectiveRtp,
  emptyPointBuffer,
  initialBankrollState,
  realisedRtp,
  runBankrollBlock,
  samplePoint,
  scalePayouts,
  sealPoint,
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

/** Drive the buffer directly with a scripted balance, no spinning involved. */
const at = (spins: number, balance: number) =>
  ({ ...initialBankrollState(0), spins, balance })

describe('the point buffer', () => {
  it('samples once per block and not between blocks', () => {
    const buf = emptyPointBuffer()
    samplePoint(buf, at(50, 990))
    expect(buf.points).toHaveLength(0)

    samplePoint(buf, at(100, 980))
    expect(buf.points).toEqual([{ spins: 100, balance: 980 }])

    samplePoint(buf, at(150, 975))
    expect(buf.points).toHaveLength(1)

    samplePoint(buf, at(200, 970))
    expect(buf.points).toHaveLength(2)
  })

  it('halves the buffer and doubles the block when it fills', () => {
    const buf = emptyPointBuffer()
    for (let i = 1; i <= BANKROLL_MAX_POINTS; i++) samplePoint(buf, at(i * 100, i))

    expect(buf.points).toHaveLength(BANKROLL_MAX_POINTS / 2)
    expect(buf.blockSpins).toBe(200)
    // the points kept are the even multiples — the newest survives
    expect(buf.points[0]).toEqual({ spins: 200, balance: 2 })
    expect(buf.points[buf.points.length - 1]).toEqual({
      spins: BANKROLL_MAX_POINTS * 100,
      balance: BANKROLL_MAX_POINTS,
    })
  })

  it('stays uniformly spaced after decimating', () => {
    const buf = emptyPointBuffer()
    for (let i = 1; i <= BANKROLL_MAX_POINTS + 2; i++) samplePoint(buf, at(i * 100, i))
    const gaps = buf.points.slice(1).map((p, i) => p.spins - buf.points[i].spins)
    expect(new Set(gaps)).toEqual(new Set([200]))
  })

  it('never exceeds the cap however long the run gets', () => {
    const buf = emptyPointBuffer()
    for (let i = 1; i <= 20_000; i++) samplePoint(buf, at(i * 100, i))
    expect(buf.points.length).toBeLessThanOrEqual(BANKROLL_MAX_POINTS)
  })

  it('drops points rather than averaging them, so every point is a real balance', () => {
    const buf = emptyPointBuffer()
    for (let i = 1; i <= BANKROLL_MAX_POINTS; i++) samplePoint(buf, at(i * 100, i * 7))
    // balance was exactly spins/100 * 7 at every sample; survivors must match
    for (const p of buf.points) expect(p.balance).toBe((p.spins / 100) * 7)
  })

  it('seals a run that ended mid-block', () => {
    const buf = emptyPointBuffer()
    samplePoint(buf, at(100, 980))
    sealPoint(buf, at(137, 0))
    expect(buf.points).toHaveLength(2)
    expect(buf.points[1]).toEqual({ spins: 137, balance: 0 })
  })

  it('seals a run that busted before the first block', () => {
    const buf = emptyPointBuffer()
    sealPoint(buf, at(37, 0))
    expect(buf.points).toEqual([{ spins: 37, balance: 0 }])
  })

  it('does not duplicate a final point that landed on a block boundary', () => {
    const buf = emptyPointBuffer()
    samplePoint(buf, at(100, 980))
    sealPoint(buf, at(100, 980))
    expect(buf.points).toHaveLength(1)
  })
})
