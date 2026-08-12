/**
 * Monte Carlo simulation core: seeded PRNG, Vose alias sampling, and the
 * running aggregates the UI turns into stats. Pure and synchronous — the Web
 * Worker shell (sim.worker.ts) owns scheduling and messaging, so everything
 * here is unit-testable in node.
 *
 * Numbers stay honest at 100M spins: Σx² ≤ 1e8 · 1000² = 1e14, far inside
 * double precision. Per-spin cost is O(1) via the alias method.
 */

import { evaluateExpression } from './expr'

/** Tiny seedable PRNG — plenty for simulation, cheap enough for 100M draws. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface AliasTable {
  /** Acceptance probability per slot. */
  prob: Float64Array
  /** Fallback slot when the acceptance roll fails. */
  alias: Int32Array
  /** Payout multiplier per slot. */
  payouts: Float64Array
}

/** Vose's alias method: O(n) build, O(1) draws. Null when nothing can win. */
export function buildAlias(payouts: number[], weights: number[]): AliasTable | null {
  const n = payouts.length
  const total = weights.reduce((a, w) => a + Math.max(0, w), 0)
  if (n === 0 || !(total > 0)) return null

  const prob = new Float64Array(n)
  const alias = new Int32Array(n)
  const scaled = payouts.map((_, i) => (Math.max(0, weights[i]) / total) * n)

  const small: number[] = []
  const large: number[] = []
  for (let i = 0; i < n; i++) (scaled[i] < 1 ? small : large).push(i)

  while (small.length > 0 && large.length > 0) {
    const s = small.pop()!
    const l = large.pop()!
    prob[s] = scaled[s]
    alias[s] = l
    scaled[l] += scaled[s] - 1
    ;(scaled[l] < 1 ? small : large).push(l)
  }
  // Whatever remains is 1 up to floating-point dust.
  for (const i of small) prob[i] = 1
  for (const i of large) prob[i] = 1

  return { prob, alias, payouts: Float64Array.from(payouts) }
}

/** One draw — returns the payout multiplier. */
export function sampleOnce(t: AliasTable, rand: () => number): number {
  const n = t.prob.length
  const i = Math.min(n - 1, Math.floor(rand() * n))
  return t.payouts[rand() < t.prob[i] ? i : t.alias[i]]
}

export interface SimAggregate {
  spins: number
  sum: number
  sumSq: number
  /** Spins with payout > 0. */
  hits: number
  /** Spins with payout > 1 — the solver's win convention. */
  wins: number
  maxWin: number
}

export const emptyAggregate = (): SimAggregate => ({
  spins: 0,
  sum: 0,
  sumSq: 0,
  hits: 0,
  wins: 0,
  maxWin: 0,
})

export function mergeAggregate(a: SimAggregate, b: SimAggregate): SimAggregate {
  return {
    spins: a.spins + b.spins,
    sum: a.sum + b.sum,
    sumSq: a.sumSq + b.sumSq,
    hits: a.hits + b.hits,
    wins: a.wins + b.wins,
    maxWin: Math.max(a.maxWin, b.maxWin),
  }
}

/**
 * Run one block of spins into `agg` (mutated — this is the hot loop) and
 * return the block's mean payout, which is what the realtime chart stores.
 */
export function runBlock(
  t: AliasTable,
  rand: () => number,
  spins: number,
  agg: SimAggregate,
): number {
  const { prob, alias, payouts } = t
  const n = prob.length
  let sum = 0
  let sumSq = 0
  let hits = 0
  let wins = 0
  let maxWin = agg.maxWin

  for (let k = 0; k < spins; k++) {
    const i = Math.min(n - 1, Math.floor(rand() * n))
    const x = payouts[rand() < prob[i] ? i : alias[i]]
    sum += x
    sumSq += x * x
    if (x > 0) hits += 1
    if (x > 1) wins += 1
    if (x > maxWin) maxWin = x
  }

  agg.spins += spins
  agg.sum += sum
  agg.sumSq += sumSq
  agg.hits += hits
  agg.wins += wins
  agg.maxWin = maxWin

  return spins > 0 ? sum / spins : 0
}

export interface SimStats {
  spins: number
  rtp: number
  stdDev: number
  hitRate: number
  winRate: number
  maxWin: number
}

export function statsFromAggregate(agg: SimAggregate): SimStats {
  const n = agg.spins
  if (n === 0) return { spins: 0, rtp: NaN, stdDev: NaN, hitRate: NaN, winRate: NaN, maxWin: 0 }
  const mean = agg.sum / n
  const variance = Math.max(0, agg.sumSq / n - mean * mean)
  return {
    spins: n,
    rtp: mean,
    stdDev: Math.sqrt(variance),
    hitRate: agg.hits / n,
    winRate: agg.wins / n,
    maxWin: agg.maxWin,
  }
}

/** Worker protocol. Lives here so the panel and the worker share one shape. */
export interface SimRunRequest {
  payouts: number[]
  weights: number[]
  spins: number
  seed: number
}

export type SimWorkerMessage =
  | { type: 'block'; blockIndex: number; blockMean: number; agg: SimAggregate }
  | { type: 'done'; agg: SimAggregate }
  | { type: 'error'; message: string }

export const MAX_SPINS = 1_000_000_000
export const DEFAULT_SPINS = 100_000_000

export interface AmountOptions {
  min: number
  max: number
  /** Round to a whole number. Spins and credits are integers; bets are not. */
  integer: boolean
}

/**
 * Numeric field parser: plain numbers with , or space or _ separators, plus
 * k / m / b shorthand ("100m" → 100,000,000). Text that reads as neither
 * falls back to arithmetic (`evaluateExpression`, e.g. "5000*20") — the
 * expression grammar knows nothing of the shorthand, so "100k+1" is
 * unreadable, not 100,001. Null when unreadable; clamped to the caller's
 * range. A negative is unreadable rather than clamped — whether typed ("-5")
 * or computed ("5-10"), it is a mistake, not a request for the floor.
 */
export function parseAmount(text: string, opts: AmountOptions): number | null {
  const cleaned = text.replace(/[,\s_]/g, '')
  const m = /^(\d+(?:\.\d+)?)([kmb])?$/i.exec(cleaned)
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m?.[2]?.toLowerCase() as 'k' | 'm' | 'b'] ?? 1
  // Fallback only when the plain form does not read, so every input the regex
  // accepts behaves exactly as it always has.
  const raw = m !== null ? Number(m[1]) * mult : evaluateExpression(text)
  if (raw === null || !Number.isFinite(raw) || raw < 0) return null
  const n = opts.integer ? Math.round(raw) : raw
  return Math.min(Math.max(n, opts.min), opts.max)
}

/** Spin-count field: whole spins, clamped to [1, MAX_SPINS]. */
export const parseSpinsInput = (text: string): number | null =>
  parseAmount(text, { min: 1, max: MAX_SPINS, integer: true })

/**
 * One chart point per 0.1% of the requested spins — 100M spins → 1000 points
 * of 100K spins each. Small runs bottom out at one spin per block. The last
 * block may run short; the worker trims it to the requested total.
 */
export function blockPlan(totalSpins: number): { blockSize: number; blockCount: number } {
  const spins = Math.max(1, Math.floor(totalSpins))
  const blockSize = Math.max(1, Math.ceil(spins / 1000))
  return { blockSize, blockCount: Math.ceil(spins / blockSize) }
}
