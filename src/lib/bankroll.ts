import type { AliasTable, AmountOptions } from './sim'
import { DEFAULT_BANKROLL, type BankrollConfig } from './types'

/**
 * Bankroll simulation core: the per-spin money arithmetic and the chart's
 * point buffer. Pure and synchronous — `bankroll.worker.ts` owns scheduling
 * and messaging, so everything here is unit-testable in node.
 *
 * The existing simulation answers "what does this table converge to". This one
 * answers "how long does a player last on it", which needs a balance rather
 * than an average, and a run whose length is decided by a bust rather than
 * requested up front.
 *
 * Numbers stay honest: over a chunk, Σ|Δbalance| ≤ 1e7 · bet · maxPayout,
 * which for realistic inputs is ~1e10 — far inside double precision.
 */

/** One chunk. A run past this is resumed by an explicit Continue. */
export const BANKROLL_CHUNK_SPINS = 10_000_000
/** Chart points retained before the buffer halves itself. */
export const BANKROLL_MAX_POINTS = 2_000
/** Spins per point at the start of a run. */
export const BANKROLL_MIN_BLOCK = 100

/**
 * The single source of truth for what a bankroll config field may hold —
 * shared by the panel's input fields (via `AmountOptions`) and by
 * `clampBankrollConfig` below, so the two can never drift apart. A workspace
 * loaded from localStorage is user-editable text, same as any other stored
 * field: `bet: 0` never busts and burns a full 10M-spin chunk per Continue,
 * and a negative `rtpMultiplier` pays out negative credits.
 */
export const CREDITS_RANGE: AmountOptions = { min: 1, max: 1e12, integer: true }
export const BET_RANGE: AmountOptions = { min: 1e-6, max: 1e12, integer: false }
export const RTP_MULTIPLIER_RANGE: AmountOptions = { min: 0, max: 1000, integer: false }

const clampAmount = (n: number, r: AmountOptions, fallback: number): number => {
  if (!Number.isFinite(n)) return fallback
  const clamped = Math.min(Math.max(n, r.min), r.max)
  return r.integer ? Math.round(clamped) : clamped
}

/**
 * Clamp a bankroll config to the ranges the panel enforces on entry — the
 * same discipline `clampHeight` applies to a stored chart height, for the
 * same reason: a hand-edited workspace is unvalidated input, not a value the
 * app ever produced itself.
 */
export function clampBankrollConfig(c: BankrollConfig): BankrollConfig {
  return {
    credits: clampAmount(c.credits, CREDITS_RANGE, DEFAULT_BANKROLL.credits),
    bet: clampAmount(c.bet, BET_RANGE, DEFAULT_BANKROLL.bet),
    rtpMultiplier: clampAmount(c.rtpMultiplier, RTP_MULTIPLIER_RANGE, DEFAULT_BANKROLL.rtpMultiplier),
  }
}

export interface BankrollState {
  balance: number
  spins: number
  /** Highest and lowest balance seen *between* spins. */
  peak: number
  low: number
  /** Σ payout multiplier — realised RTP is `sum / spins`. */
  sum: number
  hits: number
  wins: number
  /** Largest single payout multiplier, already scaled. */
  maxWin: number
  busted: boolean
}

export const initialBankrollState = (credits: number): BankrollState => ({
  balance: credits,
  spins: 0,
  peak: credits,
  low: credits,
  sum: 0,
  hits: 0,
  wins: 0,
  maxWin: 0,
  busted: false,
})

/**
 * Run up to `maxSpins` into `s` (mutated — this is the hot loop) and return the
 * spins actually run, stopping early on bust.
 *
 * Bust is `balance < bet`, tested *before* the spin: a balance of 0.5 at a bet
 * of 1 cannot buy a spin, so stopping at `<= 0` would let a broke player keep
 * playing. `peak` and `low` are sampled after the spin resolves, so they report
 * the balance between spins rather than the momentary dip while the stake is
 * out — that dip is not a balance the player was ever at.
 */
export function runBankrollBlock(
  t: AliasTable,
  rand: () => number,
  maxSpins: number,
  bet: number,
  s: BankrollState,
): number {
  const { prob, alias, payouts } = t
  const n = prob.length
  let { balance, peak, low, sum, hits, wins, maxWin } = s
  let spun = 0

  while (spun < maxSpins) {
    if (balance < bet) {
      s.busted = true
      break
    }
    balance -= bet
    const i = Math.min(n - 1, Math.floor(rand() * n))
    const x = payouts[rand() < prob[i] ? i : alias[i]]
    balance += bet * x

    sum += x
    if (x > 0) hits += 1
    if (x > 1) wins += 1
    if (x > maxWin) maxWin = x
    if (balance > peak) peak = balance
    if (balance < low) low = balance
    spun += 1
  }

  s.balance = balance
  s.spins += spun
  s.peak = peak
  s.low = low
  s.sum = sum
  s.hits = hits
  s.wins = wins
  s.maxWin = maxWin
  return spun
}

/** Mean payout so far — NaN before the first spin. */
export const realisedRtp = (s: BankrollState): number => (s.spins > 0 ? s.sum / s.spins : NaN)

/** The RTP the run actually plays against. */
export const effectiveRtp = (tableRtp: number, mult: number): number => tableRtp * mult

/**
 * Payouts as the run sees them. Applied once, when the alias table is built,
 * so the multiplier costs nothing per spin and the table on screen is never
 * touched — it is a property of the run, not an edit.
 */
export const scalePayouts = (payouts: number[], mult: number): number[] =>
  payouts.map((p) => p * mult)

export interface BankrollPoint {
  spins: number
  balance: number
}

export interface PointBuffer {
  points: BankrollPoint[]
  /** Spins between samples. Doubles each time the buffer decimates. */
  blockSpins: number
  /** Spin count of the next sample. */
  nextAt: number
}

export const emptyPointBuffer = (): PointBuffer => ({
  points: [],
  blockSpins: BANKROLL_MIN_BLOCK,
  nextAt: BANKROLL_MIN_BLOCK,
})

/**
 * Sample the balance if the run has reached the next block boundary, and halve
 * the buffer when it fills.
 *
 * Every second point is *dropped*, never averaged: a balance curve is a random
 * walk, and averaging would smooth away exactly the drawdowns the chart exists
 * to show. Every retained point is a true balance at a true spin count, so the
 * line stays one continuous curve at any scale — and because the stat tiles
 * read `BankrollState` rather than this buffer, decimation can only ever cost
 * chart resolution, never a headline number.
 *
 * Dropping the odd indices keeps the newest point and leaves the survivors
 * uniformly spaced at the doubled block.
 *
 * Callers must advance no further than the next block boundary before each call
 * — i.e. batch size ≤ `nextAt - spins`. The worker does this by construction
 * via `Math.min(CHUNK - chunkSpins, Math.max(1, buf.nextAt - state.spins))`.
 * If a caller overshoots, this function records only the batch's end state,
 * `nextAt` falls permanently behind `spins`, and spacing degrades to the batch
 * size until decimation doubles `blockSpins` past it. This cannot be repaired
 * here because the intermediate balances at the missed boundaries were never
 * observed — they are gone forever — so the precondition sits on the caller.
 */
export function samplePoint(buf: PointBuffer, s: BankrollState): void {
  if (s.spins < buf.nextAt) return
  buf.points.push({ spins: s.spins, balance: s.balance })
  buf.nextAt += buf.blockSpins

  if (buf.points.length >= BANKROLL_MAX_POINTS) {
    buf.points = buf.points.filter((_, i) => i % 2 === 1)
    buf.blockSpins *= 2
    buf.nextAt = buf.points[buf.points.length - 1].spins + buf.blockSpins
  }
}

/**
 * Record where the run actually ended. A bust lands mid-block far more often
 * than on a boundary, and a run that busts at spin 37 still has to draw.
 */
export function sealPoint(buf: PointBuffer, s: BankrollState): void {
  const last = buf.points[buf.points.length - 1]
  if (last === undefined || last.spins !== s.spins) {
    buf.points.push({ spins: s.spins, balance: s.balance })
  }
}

/**
 * Worker protocol. Lives here so the panel and the worker share one shape,
 * exactly as the convergence protocol lives in sim.ts.
 *
 * Unlike that one-shot protocol, this one is resumable: the worker retains the
 * balance, the PRNG and the alias table between messages, so a `continue`
 * produces exactly the sequence an uninterrupted run would have produced.
 */
export type BankrollRequest =
  | {
      type: 'start'
      payouts: number[]
      weights: number[]
      config: BankrollConfig
      seed: number
    }
  | { type: 'continue' }

export type BankrollMessage =
  | { type: 'progress'; points: BankrollPoint[]; state: BankrollState }
  | {
      type: 'chunk-done'
      points: BankrollPoint[]
      state: BankrollState
      /** True when the chunk hit the spin cap — the run can be continued. */
      capped: boolean
    }
  | { type: 'error'; message: string }
