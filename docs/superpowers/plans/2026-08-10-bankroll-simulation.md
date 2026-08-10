# Bankroll Simulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bankroll mode to the simulation panel that plays the table with a real credit balance until it busts or hits a 10M-spin cap, plus make the distribution chart default to the table's height and categorize the README.

**Architecture:** A pure core (`lib/bankroll.ts`) holds the money arithmetic and the chart's point buffer; a second, *resumable* worker (`lib/bankroll.worker.ts`) retains balance + PRNG + alias table between messages so `Continue` extends one run. The 315-line `SimulationPanel` splits into a thin mode-toggle shell over `ConvergenceSim` (today's content, moved) and `BankrollSim` (new).

**Tech Stack:** React 19 + TypeScript, Vite 8, Vitest 4 + @testing-library/react, plain CSS custom properties, Web Workers.

## Global Constraints

- Source spec: `docs/superpowers/specs/2026-08-10-bankroll-simulation-design.md`
- `BANKROLL_CHUNK_SPINS = 10_000_000`, `BANKROLL_MAX_POINTS = 2_000`, `BANKROLL_MIN_BLOCK = 100`
- Defaults: credits `1_000_000`, bet `1`, RTP multiplier `1`
- Bust is `balance < bet`, tested **before** the spin. `peak`/`low` sample **after** the spin resolves.
- The RTP multiplier scales payouts once at alias-build time. The table on screen is never modified.
- The run reads `doc.rows` (not `viewRows`) and normalizes weights with `Math.max(0, Math.round(r.weight))`, exactly as convergence mode does. A row's `locked` flag has no meaning to a draw.
- Chart points are **dropped, never averaged**, when decimating. Stat tiles read `BankrollState`, never the point buffer.
- Every new persisted workspace field is optional and validated; a bad value makes `loadWorkspace()` return `null`.
- Run `npm run test:run` before every commit. Do not use `npm test` (watch mode).
- No scientific notation in any user-visible number — use the helpers in `lib/format.ts`.

---

### Task 1: Generalize the amount parser

`parseSpinsInput` already does the `1m` / `250k` shorthand the credits field needs, but hardcodes the spins range and integer rounding. Extract the general form and keep the old name as a wrapper so no existing caller changes.

**Files:**
- Modify: `src/lib/sim.ts:176-189`
- Test: `src/lib/sim.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `parseAmount(text: string, opts: { min: number; max: number; integer: boolean }): number | null`, and `parseSpinsInput(text: string): number | null` unchanged in behaviour

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/sim.test.ts`, and add `parseAmount` to the existing import block at the top of the file:

```ts
describe('parseAmount', () => {
  it('keeps fractions when integer is false', () => {
    expect(parseAmount('0.5', { min: 0, max: 10, integer: false })).toBe(0.5)
    expect(parseAmount('1.25', { min: 0, max: 10, integer: false })).toBe(1.25)
  })

  it('rounds when integer is true', () => {
    expect(parseAmount('0.5', { min: 0, max: 10, integer: true })).toBe(1)
    expect(parseAmount('2.4', { min: 0, max: 10, integer: true })).toBe(2)
  })

  it('applies k/m/b shorthand before clamping', () => {
    expect(parseAmount('2m', { min: 0, max: 1e12, integer: true })).toBe(2_000_000)
    expect(parseAmount('250k', { min: 0, max: 1e12, integer: true })).toBe(250_000)
  })

  it('clamps to the given range', () => {
    expect(parseAmount('999', { min: 0, max: 10, integer: false })).toBe(10)
    expect(parseAmount('0', { min: 1, max: 10, integer: true })).toBe(1)
  })

  it('allows zero when min is zero', () => {
    expect(parseAmount('0', { min: 0, max: 10, integer: false })).toBe(0)
  })

  it('rejects text it cannot read', () => {
    expect(parseAmount('abc', { min: 0, max: 10, integer: false })).toBeNull()
    expect(parseAmount('-5', { min: 0, max: 10, integer: false })).toBeNull()
    expect(parseAmount('', { min: 0, max: 10, integer: false })).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest --run src/lib/sim.test.ts`
Expected: FAIL — `parseAmount is not a function` / no export named `parseAmount`.

- [ ] **Step 3: Implement**

In `src/lib/sim.ts`, replace the whole `parseSpinsInput` function (and its doc comment) with:

```ts
export interface AmountOptions {
  min: number
  max: number
  /** Round to a whole number. Spins and credits are integers; bets are not. */
  integer: boolean
}

/**
 * Numeric field parser: plain numbers with , or space or _ separators, plus
 * k / m / b shorthand ("100m" → 100,000,000). Null when unreadable; clamped to
 * the caller's range. The regex admits no sign, so a negative is unreadable
 * rather than clamped — typing "-5" is a mistake, not a request for the floor.
 */
export function parseAmount(text: string, opts: AmountOptions): number | null {
  const cleaned = text.replace(/[,\s_]/g, '')
  const m = /^(\d+(?:\.\d+)?)([kmb])?$/i.exec(cleaned)
  if (m === null) return null
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2]?.toLowerCase() as 'k' | 'm' | 'b'] ?? 1
  const raw = Number(m[1]) * mult
  if (!Number.isFinite(raw)) return null
  const n = opts.integer ? Math.round(raw) : raw
  return Math.min(Math.max(n, opts.min), opts.max)
}

/** Spin-count field: whole spins, clamped to [1, MAX_SPINS]. */
export const parseSpinsInput = (text: string): number | null =>
  parseAmount(text, { min: 1, max: MAX_SPINS, integer: true })
```

- [ ] **Step 4: Run the full suite**

Run: `npm run test:run`
Expected: PASS — the existing `parseSpinsInput` tests still pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sim.ts src/lib/sim.test.ts
git commit -m "refactor: generalize the spins parser into parseAmount"
```

---

### Task 2: Bankroll config and state types

The persisted config joins `types.ts` beside `Targets`; the runtime state and arithmetic go in the new `bankroll.ts`, the way `Targets` lives in `types.ts` while the solver lives in `distribute.ts`.

**Files:**
- Modify: `src/lib/types.ts` (append)
- Create: `src/lib/bankroll.ts`
- Test: `src/lib/bankroll.test.ts`

**Interfaces:**
- Consumes: `AliasTable` from `src/lib/sim.ts`
- Produces: `BankrollConfig`, `DEFAULT_BANKROLL`, `SimMode`, `DEFAULT_SIM_MODE` (types.ts); `BankrollState`, `initialBankrollState(credits)`, `runBankrollBlock(t, rand, maxSpins, bet, s)`, `realisedRtp(s)`, `effectiveRtp(tableRtp, mult)`, `scalePayouts(payouts, mult)`, and the three `BANKROLL_*` constants (bankroll.ts)

- [ ] **Step 1: Write the failing tests**

Create `src/lib/bankroll.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest --run src/lib/bankroll.test.ts`
Expected: FAIL — cannot resolve `./bankroll`.

- [ ] **Step 3: Add the persisted types**

Append to `src/lib/types.ts`:

```ts
/** Which question the simulation panel is answering. */
export type SimMode = 'convergence' | 'bankroll'

export const DEFAULT_SIM_MODE: SimMode = 'convergence'

/** A bankroll run's inputs. Persisted with the workspace, like Targets. */
export interface BankrollConfig {
  /** Starting balance, in credits. */
  credits: number
  /** Stake per spin, in credits. */
  bet: number
  /** Every payout is multiplied by this before the alias table is built. */
  rtpMultiplier: number
}

export const DEFAULT_BANKROLL: BankrollConfig = {
  credits: 1_000_000,
  bet: 1,
  rtpMultiplier: 1,
}
```

- [ ] **Step 4: Implement the core**

Create `src/lib/bankroll.ts`:

```ts
import type { AliasTable } from './sim'

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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest --run src/lib/bankroll.test.ts`
Expected: PASS — all 15 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/types.ts src/lib/bankroll.ts src/lib/bankroll.test.ts
git commit -m "feat: bankroll simulation core — balance, bust and the RTP multiplier"
```

---

### Task 3: The chart's point buffer

A bankroll run's length is bust-driven, so the block size cannot be planned the way `blockPlan` plans one. The buffer starts fine and halves itself as the run grows.

**Files:**
- Modify: `src/lib/bankroll.ts` (append)
- Test: `src/lib/bankroll.test.ts` (append)

**Interfaces:**
- Consumes: `BankrollState`, `BANKROLL_MAX_POINTS`, `BANKROLL_MIN_BLOCK` from Task 2
- Produces: `BankrollPoint { spins, balance }`, `PointBuffer { points, blockSpins, nextAt }`, `emptyPointBuffer()`, `samplePoint(buf, s)`, `sealPoint(buf, s)`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/bankroll.test.ts`, and add `BANKROLL_MAX_POINTS`, `emptyPointBuffer`, `samplePoint`, `sealPoint` to its import block:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest --run src/lib/bankroll.test.ts`
Expected: FAIL — no export named `emptyPointBuffer`.

- [ ] **Step 3: Implement**

Append to `src/lib/bankroll.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest --run src/lib/bankroll.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/bankroll.ts src/lib/bankroll.test.ts
git commit -m "feat: self-decimating point buffer for the bankroll chart"
```

---

### Task 4: The resumable worker

**Files:**
- Modify: `src/lib/bankroll.ts` (append the protocol types)
- Create: `src/lib/bankroll.worker.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–3, plus `buildAlias`, `mulberry32` from `sim.ts`
- Produces: `BankrollRequest`, `BankrollMessage` (in `bankroll.ts`, mirroring how `SimWorkerMessage` lives in `sim.ts`)

The worker file itself gets no unit test, matching `sim.worker.ts` — the logic that can be wrong lives in `bankroll.ts` and is covered by Tasks 2–3, and the message contract is covered by the `FakeWorker` in Task 6.

- [ ] **Step 1: Add the protocol types**

Append to `src/lib/bankroll.ts`:

```ts
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
```

Add `BankrollConfig` to the imports at the top of `bankroll.ts`:

```ts
import type { BankrollConfig } from './types'
```

- [ ] **Step 2: Implement the worker**

Create `src/lib/bankroll.worker.ts`:

```ts
import { buildAlias, mulberry32, type AliasTable } from './sim'
import {
  BANKROLL_CHUNK_SPINS,
  emptyPointBuffer,
  initialBankrollState,
  runBankrollBlock,
  samplePoint,
  scalePayouts,
  sealPoint,
  type BankrollMessage,
  type BankrollRequest,
  type BankrollState,
  type PointBuffer,
} from './bankroll'

/**
 * Scheduling shell around the pure core in bankroll.ts. Blocks run inside a
 * ~24ms timeslice, then yield through setTimeout so a terminate() from the
 * main thread can land between slices.
 *
 * Unlike sim.worker.ts this shell is stateful: `run` outlives the message that
 * created it, so a `continue` resumes the same balance and the same PRNG. That
 * retention is the whole reason this is a separate worker rather than a mode
 * inside the other one.
 *
 * Progress messages carry the *whole* point buffer rather than the new points.
 * It costs a little bandwidth and buys two things: decimation stays in exactly
 * one place, and the panel needs no buffer or flush timer of its own.
 */

// The app tsconfig targets the DOM lib, so `self` types as Window here.
interface WorkerScope {
  onmessage: ((e: MessageEvent<BankrollRequest>) => void) | null
  postMessage(msg: BankrollMessage): void
  setTimeout(fn: () => void, ms: number): number
}

const scope = self as unknown as WorkerScope
const TIMESLICE_MS = 24
const EMIT_MS = 100

interface Run {
  table: AliasTable
  rand: () => number
  bet: number
  state: BankrollState
  buf: PointBuffer
}

let run: Run | null = null
/**
 * True while a `runChunk` chain is actually mid-flight for `run`. This guards
 * something the identity check below cannot: `continue` calls `runChunk` on
 * the *same* `run` object, so `run !== r` never trips for a second `continue`
 * dispatched while the first chunk is still running — a chunk is up to 10M
 * spins over many 24ms slices, so that overlap is the normal case, not an
 * edge case. `busy` closes that gap by making a second `continue` a no-op
 * instead of a second concurrent loop drawing from the same PRNG.
 */
let busy = false

function runChunk(r: Run): void {
  let chunkSpins = 0
  let lastEmit = Date.now()
  busy = true

  const step = () => {
    // A newer `start` has replaced this run — abandon the old timeslice chain.
    // (This says nothing about `continue`; that overlap is `busy`'s job.)
    if (run !== r) return

    const start = Date.now()
    while (chunkSpins < BANKROLL_CHUNK_SPINS && Date.now() - start < TIMESLICE_MS) {
      // Run exactly up to the next sample boundary, so short runs still get
      // their fine-grained points. The boundary widens as the buffer decimates,
      // so this call's overhead shrinks as the run lengthens.
      const want = Math.min(
        BANKROLL_CHUNK_SPINS - chunkSpins,
        Math.max(1, r.buf.nextAt - r.state.spins),
      )
      chunkSpins += runBankrollBlock(r.table, r.rand, want, r.bet, r.state)
      samplePoint(r.buf, r.state)
      if (r.state.busted) break
    }

    if (r.state.busted || chunkSpins >= BANKROLL_CHUNK_SPINS) {
      // Clear before posting: by the time the panel could react to
      // `chunk-done` with another `continue`, this chain must already read
      // as free, not as still owning the run.
      busy = false
      sealPoint(r.buf, r.state)
      scope.postMessage({
        type: 'chunk-done',
        points: r.buf.points,
        state: { ...r.state },
        capped: !r.state.busted,
      })
      return
    }

    if (Date.now() - lastEmit >= EMIT_MS) {
      lastEmit = Date.now()
      scope.postMessage({ type: 'progress', points: r.buf.points, state: { ...r.state } })
    }
    scope.setTimeout(step, 0)
  }

  step()
}

scope.onmessage = (e: MessageEvent<BankrollRequest>) => {
  const msg = e.data

  if (msg.type === 'start') {
    const table = buildAlias(scalePayouts(msg.payouts, msg.config.rtpMultiplier), msg.weights)
    if (table === null) {
      run = null
      busy = false
      scope.postMessage({
        type: 'error',
        message: 'Every bucket has zero weight — nothing to play.',
      })
      return
    }
    run = {
      table,
      rand: mulberry32(msg.seed),
      bet: msg.config.bet,
      state: initialBankrollState(msg.config.credits),
      buf: emptyPointBuffer(),
    }
    runChunk(run)
    return
  }

  if (run === null) {
    scope.postMessage({ type: 'error', message: 'Nothing to continue — start a run first.' })
    return
  }
  // A chunk is already mid-flight for this run — the caller's request to
  // continue it is already satisfied, not an error and not a second chain.
  if (busy) return
  runChunk(run)
}
```

- [ ] **Step 3: Verify it typechecks and the suite still passes**

Run: `npm run build && npm run test:run`
Expected: build succeeds (it runs `tsc` first), all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/bankroll.ts src/lib/bankroll.worker.ts
git commit -m "feat: resumable bankroll worker with a retained balance and PRNG"
```

---

### Task 5: The balance chart

Deliberately not a variant of `SimChart`: that chart's three series, p95 ceiling and spike clipping all exist to make an *average* legible, and none of it applies to a single balance line.

**Files:**
- Create: `src/components/BankrollChart.tsx`
- Create: `src/components/BankrollChart.test.tsx`
- Modify: `src/index.css` (append)

**Interfaces:**
- Consumes: `BankrollPoint`, `BankrollState` (Task 2–3); `ChartReadout`, `ChartResizeGrip`, `niceCeil`, `fmtCompact`, `SIM_HEIGHT`, `useContainerWidth`
- Produces: `BankrollChart` with props `{ points, startCredits, state, height, onHeight }`

- [ ] **Step 1: Write the failing tests**

Create `src/components/BankrollChart.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { BankrollChart } from './BankrollChart'
import { initialBankrollState, type BankrollPoint, type BankrollState } from '../lib/bankroll'

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

afterEach(cleanup)

const points: BankrollPoint[] = [
  { spins: 100, balance: 1000 },
  { spins: 200, balance: 1200 },
  { spins: 300, balance: 600 },
]

const state = (over: Partial<BankrollState> = {}): BankrollState => ({
  ...initialBankrollState(1000),
  spins: 300,
  balance: 600,
  peak: 1200,
  low: 600,
  sum: 285,
  ...over,
})

function renderChart(over: { points?: BankrollPoint[]; state?: BankrollState } = {}) {
  render(
    <BankrollChart
      points={over.points ?? points}
      startCredits={1000}
      state={over.state ?? state()}
      height={260}
      onHeight={vi.fn()}
    />,
  )
}

describe('BankrollChart', () => {
  it('draws the balance line', () => {
    renderChart()
    expect(screen.getByRole('img', { name: 'Bankroll results' })).toBeDefined()
    const path = document.querySelector('.bankroll-path') as SVGPathElement
    expect(path).not.toBeNull()
    expect(path.getAttribute('d')?.startsWith('M')).toBe(true)
  })

  it('keeps zero on the axis, because busting is the point', () => {
    renderChart()
    const labels = [...document.querySelectorAll('.axis-label')].map((n) => n.textContent)
    expect(labels).toContain('0')
  })

  it('marks the starting credits so up and down read at a glance', () => {
    renderChart()
    // peak 1200 → yMax = niceCeil(1260) = 2000; plotH = 260 - 14 - 40 = 206
    // y(1000) = 14 + 206 * (1 - 1000/2000) = 117
    const line = document.querySelector('.bankroll-start-line') as SVGLineElement
    expect(line).not.toBeNull()
    expect(Number(line.getAttribute('y1'))).toBeCloseTo(117, 1)
  })

  it('shows a bust marker only once the run has busted', () => {
    renderChart()
    expect(document.querySelector('.bankroll-bust')).toBeNull()

    cleanup()
    renderChart({ state: state({ busted: true, balance: 0 }) })
    expect(document.querySelector('.bankroll-bust')).not.toBeNull()
  })

  it('reports the hovered point, and its change against the start', () => {
    renderChart()
    fireEvent.mouseMove(document.querySelector('.sim-hit') as Element, { clientX: 0 })
    expect(screen.getByText('balance')).toBeDefined()
    // leftmost point is spins 100, balance 1000 — level with the start
    expect(screen.getByText('100 spins')).toBeDefined()
  })

  it('renders nothing to hover when the run produced no points', () => {
    renderChart({ points: [], state: state({ spins: 0, balance: 1000 }) })
    expect(document.querySelector('.bankroll-path')).toBeNull()
    expect(screen.getByRole('img', { name: 'Bankroll results' })).toBeDefined()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest --run src/components/BankrollChart.test.tsx`
Expected: FAIL — cannot resolve `./BankrollChart`.

- [ ] **Step 3: Implement the component**

Create `src/components/BankrollChart.tsx`:

```tsx
import { useMemo, useState } from 'react'
import { ChartReadout, type ReadoutStat } from './ChartReadout'
import { ChartResizeGrip } from './ChartResizeGrip'
import { fmtCompact, niceCeil, SIM_HEIGHT, useContainerWidth } from './chartUtils'
import { fmtWeight } from '../lib/format'
import type { BankrollPoint, BankrollState } from '../lib/bankroll'

/**
 * The credit balance over a bankroll run.
 *
 * Not a variant of SimChart: that chart's three series, p95 ceiling and spike
 * clipping all exist to make an average legible, and none of it applies to a
 * single balance line.
 *
 * The y axis is linear with zero pinned to the bottom. Busting is the story, so
 * zero has to be on the chart — and a log axis cannot show the value the run is
 * heading for. The x axis grows with each Continue, so one run reads as one
 * unbroken curve however many chunks it took.
 */

interface BankrollChartProps {
  points: BankrollPoint[]
  /** Where the run started — the dashed reference line. */
  startCredits: number
  state: BankrollState
  height: number
  onHeight: (h: number) => void
}

const MARGIN = { top: 14, right: 74, bottom: 40, left: 72 }

export function BankrollChart({
  points,
  startCredits,
  state,
  height,
  onHeight,
}: BankrollChartProps) {
  const [containerRef, width] = useContainerWidth()
  const [hover, setHover] = useState<number | null>(null)

  const plotW = width - MARGIN.left - MARGIN.right
  const plotH = height - MARGIN.top - MARGIN.bottom
  const totalSpins = Math.max(1, state.spins)

  // Headroom above whichever is higher, so the reference line is never off the
  // top of a run that only ever lost money.
  const yMax = useMemo(
    () => niceCeil(Math.max(state.peak, startCredits, 1e-9) * 1.05),
    [state.peak, startCredits],
  )

  const x = (spins: number) => MARGIN.left + (spins / totalSpins) * plotW
  const y = (v: number) => MARGIN.top + plotH * (1 - Math.min(Math.max(v, 0), yMax) / yMax)

  const path = useMemo(
    () =>
      points
        .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.spins).toFixed(1)},${y(p.balance).toFixed(1)}`)
        .join(''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [points, yMax, plotW, plotH, totalSpins],
  )

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
    y: MARGIN.top + plotH * (1 - t),
    label: fmtCompact(t * yMax),
  }))
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
    x: MARGIN.left + plotW * t,
    label: fmtCompact(t * totalSpins),
  }))

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    if (points.length === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const spins = ((e.clientX - rect.left) / Math.max(1, plotW)) * totalSpins
    let best = 0
    let bestDist = Infinity
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(points[i].spins - spins)
      if (d < bestDist) {
        bestDist = d
        best = i
      }
    }
    setHover(best)
  }

  const h = hover !== null && hover < points.length ? hover : null
  const last = points[points.length - 1]

  const readoutStats: ReadoutStat[] =
    h === null
      ? []
      : [
          { label: 'balance', value: fmtWeight(points[h].balance) },
          { label: 'started', value: fmtWeight(startCredits) },
          {
            label: 'change',
            value: `${points[h].balance >= startCredits ? '+' : '−'}${fmtWeight(
              Math.abs(points[h].balance - startCredits),
            )}`,
          },
        ]

  return (
    <div className="chart-wrap" ref={containerRef}>
      <div className="sim-legend">
        <span className="legend-item">
          <span className="legend-line cumulative" /> credit balance
        </span>
        <span className="legend-item">
          <span className="legend-line expected" /> started with {fmtWeight(startCredits)}
        </span>
        {state.busted && <span className="legend-note">busted — no credit left to bet</span>}
      </div>

      <svg width={width} height={height} role="img" aria-label="Bankroll results">
        {yTicks.map((t, i) => (
          <g key={i}>
            <line className="grid-line" x1={MARGIN.left} x2={width - MARGIN.right} y1={t.y} y2={t.y} />
            <text className="axis-label" x={MARGIN.left - 8} y={t.y + 4} textAnchor="end">
              {t.label}
            </text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text key={i} className="axis-label" x={t.x} y={height - MARGIN.bottom + 18} textAnchor="middle">
            {t.label}
          </text>
        ))}
        <line
          className="axis-line"
          x1={MARGIN.left}
          x2={width - MARGIN.right}
          y1={MARGIN.top + plotH}
          y2={MARGIN.top + plotH}
        />

        {/* where the run started */}
        <line
          className="bankroll-start-line"
          x1={MARGIN.left}
          x2={width - MARGIN.right}
          y1={y(startCredits)}
          y2={y(startCredits)}
        />
        <text className="axis-label" x={width - MARGIN.right + 6} y={y(startCredits) + 4}>
          start
        </text>

        {points.length > 0 && <path className="bankroll-path" d={path} />}

        {state.busted && last !== undefined && (
          <g className="bankroll-bust">
            <line x1={x(last.spins)} x2={x(last.spins)} y1={MARGIN.top} y2={MARGIN.top + plotH} />
            <circle cx={x(last.spins)} cy={y(last.balance)} r={3.5} />
          </g>
        )}

        {h !== null && (
          <line
            className="sim-crosshair"
            x1={x(points[h].spins)}
            x2={x(points[h].spins)}
            y1={MARGIN.top}
            y2={MARGIN.top + plotH}
          />
        )}

        <text className="axis-title" x={width / 2} y={height - 8} textAnchor="middle">
          spins
        </text>

        <rect
          className="sim-hit"
          x={MARGIN.left}
          y={MARGIN.top}
          width={Math.max(0, plotW)}
          height={plotH}
          fill="transparent"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        />
      </svg>

      <ChartReadout
        titles={h === null ? [] : [{ text: `${fmtWeight(points[h].spins)} spins` }]}
        stats={readoutStats}
        anchor={h === null ? null : x(points[h].spins)}
        width={width}
      />

      <ChartResizeGrip
        height={height}
        range={SIM_HEIGHT}
        label="Resize the simulation chart"
        onHeight={onHeight}
      />
    </div>
  )
}
```

- [ ] **Step 4: Add the styles**

Append to `src/index.css`:

```css
/* ---------- bankroll chart ---------- */

.bankroll-path {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.6;
  stroke-linejoin: round;
}

.bankroll-start-line {
  stroke: var(--line-strong);
  stroke-width: 1;
  stroke-dasharray: 4 3;
}

.bankroll-bust line {
  stroke: var(--danger);
  stroke-width: 1;
  stroke-dasharray: 2 2;
}

.bankroll-bust circle {
  fill: var(--danger);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest --run src/components/BankrollChart.test.tsx`
Expected: PASS — all 6 tests.

- [ ] **Step 6: Commit**

```bash
git add src/components/BankrollChart.tsx src/components/BankrollChart.test.tsx src/index.css
git commit -m "feat: credit balance chart with a start reference and a bust marker"
```

---

### Task 6: The bankroll panel

**Files:**
- Create: `src/components/BankrollSim.tsx`
- Create: `src/components/BankrollSim.test.tsx`
- Modify: `src/index.css` (append)

**Interfaces:**
- Consumes: `BankrollChart` (Task 5); `parseAmount` (Task 1); `BankrollConfig` from `types.ts`; `BankrollMessage`, `BankrollRequest`, `effectiveRtp`, `initialBankrollState`, `realisedRtp`, `BANKROLL_CHUNK_SPINS` from `bankroll.ts`
- Produces: `BankrollSim`, and `BankrollWorkerLike` (the fake-able worker edge, mirroring `SimWorkerLike`)

- [ ] **Step 1: Write the failing tests**

Create `src/components/BankrollSim.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { BankrollSim, type BankrollWorkerLike } from './BankrollSim'
import {
  initialBankrollState,
  type BankrollMessage,
  type BankrollRequest,
  type BankrollState,
} from '../lib/bankroll'
import { DEFAULT_BANKROLL, type BankrollConfig, type BucketRow } from '../lib/types'

const rows: BucketRow[] = [
  { uid: 'a', bucketId: 0, payout: 0, label: '0x', weight: 700_000, locked: false, groupId: 'other', weightId: '' },
  { uid: 'b', bucketId: 1, payout: 2, label: '1-2x', weight: 300_000, locked: false, groupId: 'other', weightId: '' },
]

class FakeWorker implements BankrollWorkerLike {
  onmessage: ((e: MessageEvent<BankrollMessage>) => void) | null = null
  posted: BankrollRequest[] = []
  terminated = false
  postMessage(msg: BankrollRequest) {
    this.posted.push(msg)
  }
  terminate() {
    this.terminated = true
  }
}

const reply = (w: FakeWorker, msg: BankrollMessage) => {
  act(() => {
    w.onmessage?.({ data: msg } as MessageEvent<BankrollMessage>)
  })
}

const state = (over: Partial<BankrollState> = {}): BankrollState => ({
  ...initialBankrollState(1000),
  spins: 300,
  balance: 1200,
  peak: 1400,
  low: 800,
  sum: 285,
  maxWin: 12,
  ...over,
})

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

afterEach(cleanup)

function renderSim(
  worker?: FakeWorker,
  config: BankrollConfig = DEFAULT_BANKROLL,
  tableRtp = 0.95,
) {
  const onConfig = vi.fn()
  render(
    <BankrollSim
      rows={rows}
      totalWeight={1_000_000}
      tableRtp={tableRtp}
      config={config}
      onConfig={onConfig}
      chartHeight={260}
      onChartHeight={vi.fn()}
      createWorker={worker === undefined ? undefined : () => worker}
    />,
  )
  return onConfig
}

describe('BankrollSim fields', () => {
  it('shows the configured credits, bet and multiplier', () => {
    renderSim(new FakeWorker())
    expect(screen.getByDisplayValue('1,000,000')).toBeDefined()
    expect((screen.getByLabelText('Bet') as HTMLInputElement).value).toBe('1')
    expect((screen.getByLabelText('RTP multiplier') as HTMLInputElement).value).toBe('1')
  })

  it('commits shorthand credits on Enter', () => {
    const onConfig = renderSim(new FakeWorker())
    const input = screen.getByLabelText('Starting credits')
    fireEvent.change(input, { target: { value: '2m' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onConfig).toHaveBeenCalledWith({ ...DEFAULT_BANKROLL, credits: 2_000_000 })
  })

  it('keeps a fractional bet', () => {
    const onConfig = renderSim(new FakeWorker())
    const input = screen.getByLabelText('Bet')
    fireEvent.change(input, { target: { value: '0.5' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onConfig).toHaveBeenCalledWith({ ...DEFAULT_BANKROLL, bet: 0.5 })
  })

  it('reverts an unreadable entry on blur', () => {
    renderSim(new FakeWorker())
    const input = screen.getByLabelText('Bet')
    fireEvent.change(input, { target: { value: 'abc' } })
    fireEvent.blur(input)
    expect((input as HTMLInputElement).value).toBe('1')
  })
})

describe('BankrollSim guards', () => {
  it('disables Run when the bet exceeds the credits', () => {
    renderSim(new FakeWorker(), { credits: 10, bet: 50, rtpMultiplier: 1 })
    expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('disables Run when workers are unavailable', () => {
    renderSim(undefined)
    expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('warns at an effective RTP of 1 but still allows the run', () => {
    renderSim(new FakeWorker(), { ...DEFAULT_BANKROLL, rtpMultiplier: 1 / 0.95 }, 0.95)
    expect(screen.getByRole('status', { name: 'Bankroll warning' })).toBeDefined()
    expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('does not warn below an effective RTP of 1', () => {
    renderSim(new FakeWorker(), DEFAULT_BANKROLL, 0.95)
    expect(screen.queryByRole('status', { name: 'Bankroll warning' })).toBeNull()
  })
})

describe('BankrollSim runs', () => {
  it('starts a run with scaled config and the raw table', () => {
    const w = new FakeWorker()
    renderSim(w)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))

    expect(w.posted).toHaveLength(1)
    const msg = w.posted[0]
    expect(msg.type).toBe('start')
    if (msg.type !== 'start') throw new Error('expected a start message')
    expect(msg.payouts).toEqual([0, 2])
    expect(msg.weights).toEqual([700_000, 300_000])
    expect(msg.config).toEqual(DEFAULT_BANKROLL)
  })

  it('streams the balance and the stat tiles', () => {
    const w = new FakeWorker()
    renderSim(w)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))

    reply(w, {
      type: 'progress',
      points: [{ spins: 100, balance: 1200 }],
      state: state(),
    })

    const tiles = within(document.querySelector('.sim-stats') as HTMLElement)
    expect(tiles.getByText('1,200')).toBeDefined() // balance
    expect(tiles.getByText('1,400')).toBeDefined() // peak
    expect(tiles.getByText('800')).toBeDefined() // lowest
  })

  it('offers Continue only when a chunk capped with credit left', () => {
    const w = new FakeWorker()
    renderSim(w)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))

    reply(w, {
      type: 'chunk-done',
      points: [{ spins: 10_000_000, balance: 1200 }],
      state: state({ spins: 10_000_000 }),
      capped: true,
    })
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(w.posted[1]).toEqual({ type: 'continue' })
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
  })

  it('offers no Continue after a bust', () => {
    const w = new FakeWorker()
    renderSim(w)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))

    reply(w, {
      type: 'chunk-done',
      points: [{ spins: 4200, balance: 0 }],
      state: state({ spins: 4200, balance: 0, busted: true }),
      capped: false,
    })
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
    // scoped to the progress line — the chart legend also says "busted"
    expect(document.querySelector('.sim-progress-text')?.textContent).toBe(
      'busted after 4,200 spins',
    )
  })

  it('cancel terminates the worker, ends the run and keeps the line', () => {
    const w = new FakeWorker()
    renderSim(w)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    reply(w, { type: 'progress', points: [{ spins: 100, balance: 1200 }], state: state() })

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(w.terminated).toBe(true)
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
    expect(document.querySelector('.bankroll-path')).not.toBeNull()
  })

  it('surfaces a worker error', () => {
    const w = new FakeWorker()
    renderSim(w)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    reply(w, { type: 'error', message: 'Every bucket has zero weight — nothing to play.' })
    expect(screen.getByText(/zero weight/)).toBeDefined()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest --run src/components/BankrollSim.test.tsx`
Expected: FAIL — cannot resolve `./BankrollSim`.

- [ ] **Step 3: Implement the component**

Create `src/components/BankrollSim.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react'
import type { BankrollConfig, BucketRow } from '../lib/types'
import {
  BANKROLL_CHUNK_SPINS,
  effectiveRtp,
  initialBankrollState,
  realisedRtp,
  type BankrollMessage,
  type BankrollPoint,
  type BankrollRequest,
  type BankrollState,
} from '../lib/bankroll'
import { parseAmount } from '../lib/sim'
import { fmtDecimal, fmtRtp, fmtWeight } from '../lib/format'
import { BankrollChart } from './BankrollChart'
import { ChartResizeGrip } from './ChartResizeGrip'
import { SIM_HEIGHT } from './chartUtils'
import { remapNumpadComma } from './numpadDecimal'

/**
 * Play the table with a real balance: start with X credits, stake Y per spin,
 * and watch the balance until it busts or reaches the chunk cap.
 *
 * The worker retains its state between chunks, so `Continue` extends one run
 * rather than starting a new one — the panel just posts `continue` and keeps
 * appending to the same chart. Because the worker sends the whole point buffer
 * on every message, this panel needs no ref-buffer and no flush timer of its
 * own, unlike ConvergenceSim.
 */

/** What the panel needs from a worker — lets tests fake the platform edge. */
export interface BankrollWorkerLike {
  onmessage: ((e: MessageEvent<BankrollMessage>) => void) | null
  postMessage(msg: BankrollRequest): void
  terminate(): void
}

interface BankrollSimProps {
  rows: BucketRow[]
  totalWeight: number
  /** The table's weighted return right now, before the multiplier. */
  tableRtp: number
  config: BankrollConfig
  onConfig: (c: BankrollConfig) => void
  chartHeight: number
  onChartHeight: (h: number) => void
  createWorker?: () => BankrollWorkerLike
}

interface Run {
  status: 'running' | 'capped' | 'busted' | 'cancelled' | 'error'
  /** Snapshotted at Run, so the chart's reference matches what ran. */
  startCredits: number
  points: BankrollPoint[]
  state: BankrollState
  error?: string
}

const CREDITS = { min: 1, max: 1e12, integer: true }
const BET = { min: 1e-6, max: 1e12, integer: false }
const MULT = { min: 0, max: 1000, integer: false }

const defaultFactory = (): BankrollWorkerLike =>
  new Worker(new URL('../lib/bankroll.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as BankrollWorkerLike

export function BankrollSim({
  rows,
  totalWeight,
  tableRtp,
  config,
  onConfig,
  chartHeight,
  onChartHeight,
  createWorker,
}: BankrollSimProps) {
  const [run, setRun] = useState<Run | null>(null)
  const workerRef = useRef<BankrollWorkerLike | null>(null)

  // A leftover worker must not outlive the panel.
  useEffect(
    () => () => {
      workerRef.current?.terminate()
    },
    [],
  )

  const workersAvailable = createWorker !== undefined || typeof Worker !== 'undefined'
  const affordable = config.bet <= config.credits
  const canRun = rows.length > 0 && totalWeight > 0 && workersAvailable && affordable

  const effective = effectiveRtp(tableRtp, config.rtpMultiplier)
  const running = run?.status === 'running'

  const stopWorker = () => {
    workerRef.current?.terminate()
    workerRef.current = null
  }

  const handleMessage = (msg: BankrollMessage) => {
    if (msg.type === 'progress') {
      setRun((prev) =>
        prev === null ? prev : { ...prev, points: msg.points, state: msg.state },
      )
    } else if (msg.type === 'chunk-done') {
      // `capped` is already false on a bust, but read both rather than trusting
      // one to imply the other — a resumable run that cannot be resumed is the
      // one bug in here a user could not recover from without a reload.
      const resumable = msg.capped && !msg.state.busted
      setRun((prev) =>
        prev === null
          ? prev
          : {
              ...prev,
              points: msg.points,
              state: msg.state,
              status: resumable ? 'capped' : 'busted',
            },
      )
      // A resumable chunk keeps the worker alive so Continue can pick it up.
      if (!resumable) stopWorker()
    } else {
      stopWorker()
      setRun((prev) => (prev === null ? prev : { ...prev, status: 'error', error: msg.message }))
    }
  }

  const start = () => {
    if (!canRun) return
    const worker = (createWorker ?? defaultFactory)()
    workerRef.current = worker
    worker.onmessage = (e) => handleMessage(e.data)
    worker.postMessage({
      type: 'start',
      payouts: rows.map((r) => r.payout),
      weights: rows.map((r) => Math.max(0, Math.round(r.weight))),
      config,
      seed: (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0,
    })
    setRun({
      status: 'running',
      startCredits: config.credits,
      points: [],
      state: initialBankrollState(config.credits),
    })
  }

  const resume = () => {
    if (workerRef.current === null) return
    workerRef.current.postMessage({ type: 'continue' })
    setRun((prev) => (prev === null ? prev : { ...prev, status: 'running' }))
  }

  const cancel = () => {
    stopWorker()
    setRun((prev) => (prev === null ? prev : { ...prev, status: 'cancelled' }))
  }

  const stats = run?.state ?? null
  // A chunk that reached the cap is 100% done, but `spins % CHUNK` is exactly 0
  // there — the modulo alone would snap a finished bar back to empty.
  const chunkProgress =
    run === null
      ? 0
      : run.status === 'capped'
        ? 1
        : (run.state.spins % BANKROLL_CHUNK_SPINS) / BANKROLL_CHUNK_SPINS

  const outcome = (): string => {
    if (run === null) return ''
    const spins = fmtWeight(run.state.spins)
    if (run.status === 'running') return `${spins} spins · ${fmtWeight(run.state.balance)} credits`
    if (run.status === 'busted') return `busted after ${spins} spins`
    if (run.status === 'cancelled') return `cancelled · ${spins} spins`
    if (run.status === 'error') return 'stopped'
    return `${spins} spins · ${fmtWeight(run.state.balance)} credits left`
  }

  return (
    <>
      {effective >= 1 && (
        <div className="notice warn" role="status" aria-label="Bankroll warning">
          Effective RTP is {fmtRtp(effective)} — at 1 or above the balance drifts upward, so a bust
          becomes very unlikely and the run will usually just reach the spin cap.
        </div>
      )}

      <div className="sim-controls">
        <AmountField
          label="Credits"
          aria="Starting credits"
          value={config.credits}
          format={fmtWeight}
          opts={CREDITS}
          onCommit={(credits) => onConfig({ ...config, credits })}
          title="Plain number or shorthand: 1m, 250k"
        />
        <AmountField
          label="Bet"
          aria="Bet"
          value={config.bet}
          format={(n) => fmtDecimal(n, 6)}
          opts={BET}
          onCommit={(bet) => onConfig({ ...config, bet })}
          title="Credits staked per spin"
        />
        <AmountField
          label="RTP×"
          aria="RTP multiplier"
          value={config.rtpMultiplier}
          format={(n) => fmtDecimal(n, 6)}
          opts={MULT}
          onCommit={(rtpMultiplier) => onConfig({ ...config, rtpMultiplier })}
          title="Scales every payout — the table itself is not changed"
        />

        {running ? (
          <button type="button" className="btn" onClick={cancel}>
            Cancel
          </button>
        ) : (
          <button
            type="button"
            className="btn primary"
            disabled={!canRun}
            onClick={start}
            title={
              !workersAvailable
                ? 'Web Workers are unavailable in this browser'
                : !affordable
                  ? 'The bet is larger than the starting credits — the run would bust at zero spins'
                  : 'Play the current table until the credits run out'
            }
          >
            Run
          </button>
        )}

        {run?.status === 'capped' && (
          <button type="button" className="btn primary" onClick={resume}>
            Continue
          </button>
        )}

        {run !== null && (
          <div className="sim-progress" role="status">
            <div className="sim-progress-track">
              <div
                className="sim-progress-fill"
                style={{ width: `${Math.min(100, chunkProgress * 100)}%` }}
              />
            </div>
            <span className="sim-progress-text">{outcome()}</span>
          </div>
        )}

        {run?.error !== undefined && <div className="paste-error">{run.error}</div>}
      </div>

      {stats !== null && (
        <div className="sim-stats">
          <div className="sim-tile">
            <span className="sim-tile-value">{fmtWeight(stats.balance)}</span>
            <span className="sim-tile-label">Balance</span>
          </div>
          <div className="sim-tile">
            <span className="sim-tile-value">{fmtWeight(stats.spins)}</span>
            <span className="sim-tile-label">Spins Survived</span>
          </div>
          <div className="sim-tile">
            <span className="sim-tile-value">{fmtWeight(stats.peak)}</span>
            <span className="sim-tile-label">Peak</span>
          </div>
          <div className="sim-tile">
            <span className="sim-tile-value">{fmtWeight(stats.low)}</span>
            <span className="sim-tile-label">Lowest</span>
          </div>
          <div className="sim-tile">
            <span className="sim-tile-value">{fmtRtp(realisedRtp(stats))}</span>
            <span className="sim-tile-label">RTP · table {fmtRtp(effective)}</span>
          </div>
          <div className="sim-tile">
            <span className="sim-tile-value">{fmtWeight(stats.maxWin * config.bet)}</span>
            <span className="sim-tile-label">Biggest Win</span>
          </div>
        </div>
      )}

      {run !== null ? (
        <BankrollChart
          points={run.points}
          startCredits={run.startCredits}
          state={run.state}
          height={chartHeight}
          onHeight={onChartHeight}
        />
      ) : (
        <div className="chart-wrap">
          <div className="chart-empty" style={{ height: chartHeight }}>
            Run a bankroll to see how long {fmtWeight(config.credits)} credits last at a bet of{' '}
            {fmtDecimal(config.bet, 6)}.
          </div>
          <ChartResizeGrip
            height={chartHeight}
            range={SIM_HEIGHT}
            label="Resize the simulation chart"
            onHeight={onChartHeight}
          />
        </div>
      )}
    </>
  )
}

/**
 * One numeric field. Local text state so a half-typed value is not fought by
 * the parser, committed on Enter and blur — the same contract the spins field
 * uses, extracted because there are three of them here.
 */
function AmountField({
  label,
  aria,
  value,
  format,
  opts,
  onCommit,
  title,
}: {
  label: string
  aria: string
  value: number
  format: (n: number) => string
  opts: { min: number; max: number; integer: boolean }
  onCommit: (n: number) => void
  title: string
}) {
  const [text, setText] = useState(() => format(value))
  // Re-derive when the setting changes from outside — the render-time
  // adjustment pattern, not an effect.
  const [last, setLast] = useState(value)
  if (value !== last) {
    setLast(value)
    setText(format(value))
  }

  const commit = () => {
    const parsed = parseAmount(text, opts)
    if (parsed === null) {
      setText(format(value))
      return
    }
    setText(format(parsed))
    if (parsed !== value) onCommit(parsed)
  }

  return (
    <label className="sim-field">
      <span>{label}</span>
      <input
        aria-label={aria}
        className="panel-num sim-spins"
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (remapNumpadComma(e)) {
            setText(e.currentTarget.value)
            return
          }
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setText(format(value))
        }}
        title={title}
      />
    </label>
  )
}
```

- [ ] **Step 4: Add the warning spacing**

Append to `src/index.css`:

```css
.sim-controls + .sim-stats,
.notice.warn + .sim-controls {
  margin-top: 10px;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest --run src/components/BankrollSim.test.tsx`
Expected: PASS — all 14 tests.

- [ ] **Step 6: Commit**

```bash
git add src/components/BankrollSim.tsx src/components/BankrollSim.test.tsx src/index.css
git commit -m "feat: bankroll panel with credits, bet, RTP multiplier and Continue"
```

---

### Task 7: Persist the new settings

**Files:**
- Modify: `src/lib/storage.ts:11-31` (the `Workspace` interface) and `:83-105` (`isWorkspace`)
- Test: `src/lib/storage.test.ts` (append)

**Interfaces:**
- Consumes: `SimMode`, `BankrollConfig` from `types.ts` (Task 2)
- Produces: `Workspace` gains `simMode?`, `bankroll?`, `chartHeightAuto?`

- [ ] **Step 1: Write the failing tests**

Append to the final `describe` block in `src/lib/storage.test.ts`, and add `DEFAULT_BANKROLL` to its imports from `./types`:

```ts
  it('round-trips the simulation mode and rejects an unknown one', () => {
    saveWorkspace({ ...workspace, simMode: 'bankroll' })
    expect(loadWorkspace()?.simMode).toBe('bankroll')

    store.set(STORAGE_KEY, JSON.stringify({ ...workspace, simMode: 'roulette' }))
    expect(loadWorkspace()).toBeNull()
  })

  it('round-trips the bankroll config and rejects a malformed one', () => {
    saveWorkspace({ ...workspace, bankroll: { credits: 500, bet: 0.5, rtpMultiplier: 0.9 } })
    expect(loadWorkspace()?.bankroll).toEqual({ credits: 500, bet: 0.5, rtpMultiplier: 0.9 })

    store.set(
      STORAGE_KEY,
      JSON.stringify({ ...workspace, bankroll: { ...DEFAULT_BANKROLL, bet: 'one' } }),
    )
    expect(loadWorkspace()).toBeNull()

    store.set(STORAGE_KEY, JSON.stringify({ ...workspace, bankroll: { credits: 500 } }))
    expect(loadWorkspace()).toBeNull()
  })

  it('round-trips the chart auto-height flag and rejects a non-boolean', () => {
    saveWorkspace({ ...workspace, chartHeightAuto: false })
    expect(loadWorkspace()?.chartHeightAuto).toBe(false)

    store.set(STORAGE_KEY, JSON.stringify({ ...workspace, chartHeightAuto: 'yes' }))
    expect(loadWorkspace()).toBeNull()
  })

  it('accepts a workspace saved before any of the new fields existed', () => {
    saveWorkspace(workspace)
    const loaded = loadWorkspace()
    expect(loaded).not.toBeNull()
    expect(loaded?.simMode).toBeUndefined()
    expect(loaded?.bankroll).toBeUndefined()
    expect(loaded?.chartHeightAuto).toBeUndefined()
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest --run src/lib/storage.test.ts`
Expected: FAIL — TypeScript rejects `simMode` on `Workspace`.

- [ ] **Step 3: Implement**

In `src/lib/storage.ts`, extend the import on line 1:

```ts
import type {
  BankrollConfig,
  BucketRow,
  ChartSettings,
  GroupDef,
  SimMode,
  Targets,
  Volatility,
  WeightStep,
} from './types'
```

Add to the `Workspace` interface, after `targetsCollapsed`:

```ts
  /** Optional — absent in workspaces saved before bankroll mode existed. */
  simMode?: SimMode
  bankroll?: BankrollConfig
  /** Optional — absent before the chart could fit itself to the table. */
  chartHeightAuto?: boolean
```

Add a validator beside `isChart`:

```ts
function isBankroll(v: unknown): v is BankrollConfig {
  return (
    isObject(v) &&
    isFiniteNumber(v.credits) &&
    isFiniteNumber(v.bet) &&
    isFiniteNumber(v.rtpMultiplier)
  )
}
```

Add to `isWorkspace`, before the closing `)`:

```ts
    (v.simMode === undefined || v.simMode === 'convergence' || v.simMode === 'bankroll') &&
    (v.bankroll === undefined || isBankroll(v.bankroll)) &&
    (v.chartHeightAuto === undefined || typeof v.chartHeightAuto === 'boolean')
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest --run src/lib/storage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/storage.ts src/lib/storage.test.ts
git commit -m "feat: persist the simulation mode, bankroll config and auto-height flag"
```

---

### Task 8: Split the simulation panel and wire it into App

`SimulationPanel` becomes a thin shell over two modes. Today's content moves to `ConvergenceSim` unchanged, and its test file moves with it.

**The split and the App wiring are one task deliberately.** Changing
`SimulationPanel`'s props while `App` still passes the old ones is a
TypeScript error, so splitting them would land a commit that neither builds
nor tests. Steps 1–6 do the split, steps 7–11 update the only caller, and the
whole thing commits once with the suite green.

**Files:**
- Create: `src/components/ConvergenceSim.tsx` (moved content)
- Create: `src/components/ConvergenceSim.test.tsx` (moved tests)
- Delete: `src/components/SimulationPanel.test.tsx`
- Modify: `src/components/SimulationPanel.tsx` (replaced with the shell)
- Modify: `src/index.css` (append)
- Modify: `src/App.tsx` — imports, state near `:127-136`, the save payload near `:233-245`, the panel render near `:656-664`
- Test: `src/App.test.tsx` (append)

**Interfaces:**
- Consumes: `BankrollSim`, `BankrollWorkerLike` (Task 6); `SimMode`, `BankrollConfig`, `DEFAULT_BANKROLL`, `DEFAULT_SIM_MODE` from `types.ts` (Task 2); the `simMode` / `bankroll` storage fields (Task 7)
- Produces: `SimulationPanel` with props `{ mode, onMode, rows, totalWeight, expectedRtp, spins, onSpins, bankroll, onBankroll, chartHeight, onChartHeight, createWorker?, createBankrollWorker? }`; `ConvergenceSim` keeping today's props and re-exporting `SimWorkerLike`

- [ ] **Step 1: Move the convergence panel**

```bash
git mv src/components/SimulationPanel.tsx src/components/ConvergenceSim.tsx
git mv src/components/SimulationPanel.test.tsx src/components/ConvergenceSim.test.tsx
```

In `src/components/ConvergenceSim.tsx`, rename the component and its props interface only — the body is unchanged:
- `export interface SimulationPanelProps` → `interface ConvergenceSimProps`
- `export function SimulationPanel(` → `export function ConvergenceSim(`
- `}: SimulationPanelProps) {` → `}: ConvergenceSimProps) {`

Update the doc comment's first line to:

```ts
/**
 * Convergence mode: spins input, Run/Cancel, live stat tiles and the realtime
 * RTP chart. The run snapshots the table when Run is clicked — edits made
 * mid-run don't bend an in-flight simulation.
 *
 ...
```

In `src/components/ConvergenceSim.test.tsx`, update the import and the two references:
- `import { SimulationPanel, type SimWorkerLike } from './SimulationPanel'` → `import { ConvergenceSim, type SimWorkerLike } from './ConvergenceSim'`
- `<SimulationPanel` → `<ConvergenceSim`
- `describe('SimulationPanel', ...)` → `describe('ConvergenceSim', ...)`

- [ ] **Step 2: Run the moved tests to verify they still pass**

Run: `npx vitest --run src/components/ConvergenceSim.test.tsx`
Expected: PASS — all 6 tests, unchanged behaviour.

- [ ] **Step 3: Write the failing shell test**

Create `src/components/SimulationPanel.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SimulationPanel } from './SimulationPanel'
import { DEFAULT_BANKROLL, type BucketRow, type SimMode } from '../lib/types'

const rows: BucketRow[] = [
  { uid: 'a', bucketId: 0, payout: 0, label: '0x', weight: 700_000, locked: false, groupId: 'other', weightId: '' },
  { uid: 'b', bucketId: 1, payout: 2, label: '1-2x', weight: 300_000, locked: false, groupId: 'other', weightId: '' },
]

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

afterEach(cleanup)

function renderPanel(mode: SimMode) {
  const onMode = vi.fn()
  render(
    <SimulationPanel
      mode={mode}
      onMode={onMode}
      rows={rows}
      totalWeight={1_000_000}
      expectedRtp={0.95}
      spins={1000}
      onSpins={vi.fn()}
      bankroll={DEFAULT_BANKROLL}
      onBankroll={vi.fn()}
      chartHeight={260}
      onChartHeight={vi.fn()}
    />,
  )
  return onMode
}

describe('SimulationPanel', () => {
  it('shows the convergence controls in convergence mode', () => {
    renderPanel('convergence')
    expect(screen.getByLabelText('Spins')).toBeDefined()
    expect(screen.queryByLabelText('Starting credits')).toBeNull()
  })

  it('shows the bankroll controls in bankroll mode', () => {
    renderPanel('bankroll')
    expect(screen.getByLabelText('Starting credits')).toBeDefined()
    expect(screen.getByLabelText('Bet')).toBeDefined()
    expect(screen.queryByLabelText('Spins')).toBeNull()
  })

  it('marks the active mode for assistive tech', () => {
    renderPanel('bankroll')
    expect(screen.getByRole('button', { name: 'Bankroll' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Convergence' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('switches mode when the other button is pressed', () => {
    const onMode = renderPanel('convergence')
    fireEvent.click(screen.getByRole('button', { name: 'Bankroll' }))
    expect(onMode).toHaveBeenCalledWith('bankroll')
  })
})
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest --run src/components/SimulationPanel.test.tsx`
Expected: FAIL — `SimulationPanel` is not exported from `./SimulationPanel`.

- [ ] **Step 5: Implement the shell**

Create `src/components/SimulationPanel.tsx`:

```tsx
import type { BankrollConfig, BucketRow, SimMode } from '../lib/types'
import { BankrollSim, type BankrollWorkerLike } from './BankrollSim'
import { ConvergenceSim, type SimWorkerLike } from './ConvergenceSim'

/**
 * The simulation panel's shell: a mode toggle over two independent panels.
 *
 * The two modes answer different questions — "what does this table converge
 * to" and "how long does a player last on it" — and share almost nothing but
 * the chart slot, so each owns its own controls, worker and chart rather than
 * one component branching throughout.
 */

interface SimulationPanelProps {
  mode: SimMode
  onMode: (m: SimMode) => void
  rows: BucketRow[]
  totalWeight: number
  /** The table's weighted return right now. */
  expectedRtp: number
  spins: number
  onSpins: (n: number) => void
  bankroll: BankrollConfig
  onBankroll: (c: BankrollConfig) => void
  /** Shared by both modes — one chart slot, one remembered height. */
  chartHeight: number
  onChartHeight: (h: number) => void
  createWorker?: () => SimWorkerLike
  createBankrollWorker?: () => BankrollWorkerLike
}

const MODES: { id: SimMode; label: string; title: string }[] = [
  { id: 'convergence', label: 'Convergence', title: 'Spin the table and watch its RTP settle' },
  { id: 'bankroll', label: 'Bankroll', title: 'Play the table with a balance until it runs out' },
]

export function SimulationPanel({
  mode,
  onMode,
  rows,
  totalWeight,
  expectedRtp,
  spins,
  onSpins,
  bankroll,
  onBankroll,
  chartHeight,
  onChartHeight,
  createWorker,
  createBankrollWorker,
}: SimulationPanelProps) {
  return (
    <>
      <div className="sim-modes" role="group" aria-label="Simulation mode">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`btn ${mode === m.id ? 'primary' : ''}`}
            aria-pressed={mode === m.id}
            title={m.title}
            onClick={() => onMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode === 'convergence' ? (
        <ConvergenceSim
          rows={rows}
          totalWeight={totalWeight}
          expectedRtp={expectedRtp}
          spins={spins}
          onSpins={onSpins}
          chartHeight={chartHeight}
          onChartHeight={onChartHeight}
          createWorker={createWorker}
        />
      ) : (
        <BankrollSim
          rows={rows}
          totalWeight={totalWeight}
          tableRtp={expectedRtp}
          config={bankroll}
          onConfig={onBankroll}
          chartHeight={chartHeight}
          onChartHeight={onChartHeight}
          createWorker={createBankrollWorker}
        />
      )}
    </>
  )
}
```

- [ ] **Step 6: Add the toggle styles**

Append to `src/index.css`:

```css
.sim-modes {
  display: flex;
  gap: 6px;
  padding: 10px 14px 0;
}
```

- [ ] **Step 7: Write the failing test**

Append to `src/App.test.tsx`:

```tsx
describe('simulation modes', () => {
  it('opens on convergence and switches to bankroll', () => {
    loadRealData()
    expect(screen.getByLabelText('Spins')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Bankroll' }))
    expect(screen.getByLabelText('Starting credits')).toBeDefined()
    expect(screen.getByLabelText('Bet')).toBeDefined()
    expect(screen.getByLabelText('RTP multiplier')).toBeDefined()
    expect(screen.queryByLabelText('Spins')).toBeNull()
  })

  it('defaults the bankroll to a million credits at a bet of one', () => {
    loadRealData()
    fireEvent.click(screen.getByRole('button', { name: 'Bankroll' }))
    expect((screen.getByLabelText('Starting credits') as HTMLInputElement).value).toBe('1,000,000')
    expect((screen.getByLabelText('Bet') as HTMLInputElement).value).toBe('1')
  })

  it('remembers the mode and the credits across a reload', () => {
    loadRealData()
    fireEvent.click(screen.getByRole('button', { name: 'Bankroll' }))
    const credits = screen.getByLabelText('Starting credits')
    fireEvent.change(credits, { target: { value: '250k' } })
    fireEvent.keyDown(credits, { key: 'Enter' })

    // autosave is debounced by 300ms; flush it the way the other reload tests do
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        cleanup()
        render(<App />)
        expect(
          screen.getByRole('button', { name: 'Bankroll' }).getAttribute('aria-pressed'),
        ).toBe('true')
        expect((screen.getByLabelText('Starting credits') as HTMLInputElement).value).toBe(
          '250,000',
        )
        resolve()
      }, 400)
    })
  })
})
```

- [ ] **Step 8: Run it to verify it fails**

Run: `npx vitest --run src/App.test.tsx`
Expected: FAIL — no `Bankroll` button; `SimulationPanel` is missing required props.

- [ ] **Step 9: Implement**

In `src/App.tsx`, extend the `./lib/types` import to include `DEFAULT_BANKROLL`, `DEFAULT_SIM_MODE`, and the types `BankrollConfig`, `SimMode`.

Add state beside `simSpins` (after line 133):

```ts
  const [simMode, setSimMode] = useState<SimMode>(saved?.simMode ?? DEFAULT_SIM_MODE)
  const [bankroll, setBankroll] = useState<BankrollConfig>(
    saved?.bankroll === undefined ? DEFAULT_BANKROLL : { ...DEFAULT_BANKROLL, ...saved.bankroll },
  )
```

Add `simMode` and `bankroll` to the saved workspace payload (beside `simSpins`) **and** to that `useEffect`'s dependency array.

Replace the `<SimulationPanel .../>` element with:

```tsx
            <SimulationPanel
              mode={simMode}
              onMode={setSimMode}
              rows={doc.rows}
              totalWeight={totalWeight}
              expectedRtp={achieved.rtp}
              spins={simSpins}
              onSpins={setSimSpins}
              bankroll={bankroll}
              onBankroll={setBankroll}
              chartHeight={simChartHeight}
              onChartHeight={setSimChartHeight}
            />
```

- [ ] **Step 10: Run the full suite**

Run: `npm run build && npm run test:run`
Expected: both PASS — the split and the wiring land together, so nothing is
transiently red.

- [ ] **Step 11: Commit**

```bash
git add src/components/SimulationPanel.tsx src/components/SimulationPanel.test.tsx \
        src/components/ConvergenceSim.tsx src/components/ConvergenceSim.test.tsx \
        src/index.css src/App.tsx src/App.test.tsx
git commit -m "feat: a mode toggle splits the simulation panel, and bankroll reaches the app"
```

---

### Task 9: The distribution chart fits the table

**Files:**
- Modify: `src/components/ChartResizeGrip.tsx:14-19, 61, 67-70`
- Modify: `src/components/ChartResizeGrip.test.tsx` (append)
- Modify: `src/components/DistributionChart.tsx:48, 136, 730-735`
- Modify: `src/App.tsx` — state near `:124-129`, `rowRef` at `:151-164`, the save payload, the `DistributionChart` render at `:631-644`
- Test: `src/App.test.tsx` (append)

**Interfaces:**
- Consumes: `chartHeightAuto` storage field (Task 7)
- Produces: `ChartResizeGrip` gains `onReset?: () => void`; `DistributionChart` gains `onHeightReset?: () => void`

- [ ] **Step 1: Write the failing grip test**

Append to `src/components/ChartResizeGrip.test.tsx`:

```tsx
  it('calls onReset instead of the fallback when one is given', () => {
    const onHeight = vi.fn()
    const onReset = vi.fn()
    render(
      <ChartResizeGrip
        height={400}
        range={{ min: 220, max: 900, fallback: 340 }}
        label="Resize"
        onHeight={onHeight}
        onReset={onReset}
      />,
    )
    const grip = screen.getByRole('separator', { name: 'Resize' })

    fireEvent.doubleClick(grip)
    expect(onReset).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(grip, { key: 'Home' })
    expect(onReset).toHaveBeenCalledTimes(2)
    expect(onHeight).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest --run src/components/ChartResizeGrip.test.tsx`
Expected: FAIL — `onReset` is not a valid prop.

- [ ] **Step 3: Implement the grip change**

In `src/components/ChartResizeGrip.tsx`, extend the props:

```ts
interface ChartResizeGripProps {
  height: number
  range: HeightRange
  label: string
  onHeight: (h: number) => void
  /**
   * What the reset gesture means. Without one, reset restores `range.fallback`;
   * with one, the caller decides — the distribution chart uses it to go back to
   * fitting the table rather than to a fixed number.
   */
  onReset?: () => void
}
```

Destructure `onReset` and add, just above the returned JSX:

```ts
  const reset = () => (onReset === undefined ? onHeight(range.fallback) : onReset())
```

Replace `onDoubleClick={() => onHeight(range.fallback)}` with `onDoubleClick={reset}`, and in `onKeyDown` replace the `Home` branch's `onHeight(range.fallback)` with `reset()`.

- [ ] **Step 4: Thread it through the distribution chart**

In `src/components/DistributionChart.tsx`, add to `DistributionChartProps` after `onHeight`:

```ts
  /** Reset gesture on the grip — restores auto-fit rather than a fixed height. */
  onHeightReset?: () => void
```

Destructure `onHeightReset` in the component signature, and add `onReset={onHeightReset}` to the `<ChartResizeGrip>` element at line ~730.

- [ ] **Step 5: Write the failing App test**

Append to `src/App.test.tsx`:

```tsx
describe('distribution chart height', () => {
  // jsdom lays nothing out, so offsetHeight is always 0 and the observer has
  // nothing to read. Stub it for the table panel only, and put it back after —
  // ChartReadout and the targets panel measure themselves through it too.
  const REAL_OFFSET_HEIGHT = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'offsetHeight',
  )!

  const withTableHeight = (px: number) => {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('buckets') ? px : 0
      },
    })
  }

  afterEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', REAL_OFFSET_HEIGHT)
  })

  const chart = () => screen.getByRole('img', { name: 'Bucket distribution' })

  it('fits the table, clamped to the chart range', () => {
    withTableHeight(500)
    loadRealData()
    expect(Number(chart().getAttribute('height'))).toBe(500)
  })

  it('clamps a table taller than the chart ceiling', () => {
    withTableHeight(5000)
    loadRealData()
    expect(Number(chart().getAttribute('height'))).toBe(900)
  })

  it('clamps a table shorter than the chart floor', () => {
    withTableHeight(80)
    loadRealData()
    expect(Number(chart().getAttribute('height'))).toBe(220)
  })

  it('stops fitting once the grip has been dragged, and fits again after a reset', () => {
    withTableHeight(500)
    loadRealData()
    const grip = screen.getByRole('separator', { name: 'Resize the distribution chart' })

    fireEvent.pointerDown(grip, { button: 0, clientY: 0 })
    fireEvent.pointerMove(grip, { clientY: -200 })
    fireEvent.pointerUp(grip)
    expect(Number(chart().getAttribute('height'))).toBe(300)

    fireEvent.doubleClick(grip)
    expect(Number(chart().getAttribute('height'))).toBe(500)
  })
})
```

The two labels above are the ones `DistributionChart.tsx` actually renders
today — `aria-label="Bucket distribution"` on the svg (line 497) and
`label="Resize the distribution chart"` on the grip (line 733). Do not
paraphrase them.

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest --run src/App.test.tsx`
Expected: FAIL — the chart renders at the fixed fallback height, not the table's.

- [ ] **Step 7: Implement in App**

Replace the `chartHeight` state (line ~124) with:

```ts
  // Clamped on the way in as well as on drag — the stored value is user data.
  const [chartHeight, setChartHeight] = useState(() =>
    clampHeight(saved?.chartHeight ?? DIST_HEIGHT.fallback, DIST_HEIGHT),
  )
  /**
   * Auto-fit defaults on, even for a workspace that already has a chartHeight:
   * that field is written on every save, not only on a manual resize, so its
   * presence says nothing about whether the user ever chose it.
   */
  const [chartHeightAuto, setChartHeightAuto] = useState(saved?.chartHeightAuto ?? true)
  const [tableHeight, setTableHeight] = useState<number | null>(null)
```

Add below the `rowRef` definition:

```ts
  const effectiveChartHeight =
    chartHeightAuto && tableHeight !== null
      ? clampHeight(tableHeight, DIST_HEIGHT)
      : chartHeight
```

Inside `rowRef`'s `check`, after the `stacked` toggle, add:

```ts
      // The chart defaults to the table's height. Safe against a feedback loop:
      // the two panels are independent flex items under align-items: flex-start,
      // so the table's height never depends on the chart's — a chart resize
      // re-fires this, reads an unchanged table, and the update no-ops.
      const h = table.offsetHeight
      setTableHeight((prev) => (prev === null || Math.abs(prev - h) >= 1 ? h : prev))
```

Add `chartHeightAuto` to the saved workspace payload and to that effect's dependency array.

Update the `<DistributionChart>` element:

```tsx
              height={effectiveChartHeight}
              onHeight={(h) => {
                setChartHeight(h)
                setChartHeightAuto(false)
              }}
              onHeightReset={() => setChartHeightAuto(true)}
```

- [ ] **Step 8: Run the full suite**

Run: `npm run test:run`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/App.tsx src/App.test.tsx src/components/ChartResizeGrip.tsx \
        src/components/ChartResizeGrip.test.tsx src/components/DistributionChart.tsx
git commit -m "feat: the distribution chart defaults to the table's height"
```

---

### Task 10: Categorize the README

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: nothing
- Produces: nothing

- [ ] **Step 1: Restructure the headings**

In `README.md`:

1. Delete the `## Features` heading entirely.
2. Promote each category to `##` and demote nothing — the former `###` feature headings stay `###`, and `#### Group locks` / `#### Group bars` stay `####`. Reorder the feature sections so each sits under its category, in this order:

```
## Data formats          (unchanged, stays where it is)
## Getting started       (was ### Getting started)
## Solving weights       (new) → ### The solver, ### Tolerance, ### Volatility,
                                  ### Weight step, ### The targets panel
## Editing the table     (new) → ### Keyboard, ### In-cell arithmetic,
                                  ### The totals row, ### Locks (#### Group locks),
                                  ### Bucket groups, ### Columns
## The distribution chart (new) → ### Dragging and setting values on the chart
                                  (#### Group bars), ### The tooltip, and chart height
## Simulation            (was ### Simulation) → ### Convergence mode, ### Bankroll mode
## Workspace             (new) → ### Layout, ### Export, ### Persistence
## Project layout        (unchanged)
## Tests                 (unchanged)
```

3. Add a one-line lead-in under each new `##` category heading, e.g. under `## Solving weights`: `How the tool turns targets into weights, and the knobs that shape the result.`

- [ ] **Step 2: Regenerate the Contents list**

Replace the `## Contents` list (lines 9-37) to match the new structure exactly, with anchors matching the new heading text. Verify every anchor by checking each link's target heading exists.

- [ ] **Step 3: Document the two simulation modes**

Under `## Simulation`, split the existing prose into:

- `### Convergence mode` — the existing content about spins, block means, cumulative RTP and the stat tiles.
- `### Bankroll mode` — new. Cover: start credits (default 1,000,000), bet (default 1) and the RTP multiplier (default 1, scales every payout so realised RTP scales with it while hit rate is untouched); the run plays until the balance can no longer cover the bet or it reaches 10,000,000 spins; `Continue` extends the same run — the worker keeps the balance and the PRNG, so it is exactly the sequence an uninterrupted run would have produced, and the x axis just keeps growing; an effective RTP of 1 or above warns but still runs; the chart is the credit balance with zero always on the axis, a dashed line at the starting credits and a marker where the run busted; the stat tiles are balance, spins survived, peak, lowest, realised RTP and biggest win.

- [ ] **Step 4: Document the chart auto-height**

In `### The tooltip, and chart height`, replace the description of the fixed default with: the distribution chart defaults to the height of the data table beside it, clamped to 220–900px; dragging the grip pins your own height and stops the fitting; double-clicking the grip (or pressing Home on it) returns to fitting the table. The simulation chart is unchanged and still resets to its fixed default.

- [ ] **Step 5: Verify the build and the suite are still clean**

Run: `npm run build && npm run test:run && npm run lint`
Expected: all three pass.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: categorize the README and document bankroll mode"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1 core, bust rule, peak/low, multiplier | 2 |
| §1 `parseAmount` prerequisite | 1 |
| §2 protocol, chunking, resumability, decimation | 3, 4 |
| §3 panel split, fields, RTP≥1 warning, tiles | 6, 8 |
| §4 `BankrollChart` | 5 |
| §5 chart auto-height, grip reset | 9 |
| §6 README | 10 |
| Persistence of all new settings | 7, 8 |

**Fixed during the pre-flight scan (after the plan was first committed):**

- The original Task 7 split `SimulationPanel` while leaving `App` passing the old props, so both `npm run build` and the suite failed until the original Task 9 — a commit in history that did not compile. The split and the wiring are now one task (Task 8), storage moved ahead of it (Task 7), and everything after renumbered down by one. Ten tasks, every commit green.

**Fixed during review:**

- Task 8's reload test ignored the 300ms autosave debounce; it now uses the `setTimeout(…, 400)` flush the other reload tests use.
- Task 9's tests asserted an invented `aria-label`; corrected to `Bucket distribution`, and the `offsetHeight` stub now restores the real descriptor in `afterEach` so it cannot leak into other tests in the file.
- `chunkProgress` read 0% at exactly the cap, because `spins % CHUNK` is 0 there; a capped chunk now pins to 100%.
- `handleMessage`'s status ternary had an unreachable third branch; replaced with an explicit `resumable` flag that gates both the status and whether the worker is kept alive.
- Task 6's bust test used `getByText(/busted/)`, which matches both the progress line and the chart legend and would throw; now scoped to `.sim-progress-text`.
- Task 6's test file imported `../lib/types` twice.

**Known gaps, accepted deliberately:**

- `bankroll.worker.ts` has no direct unit test, matching `sim.worker.ts`. The logic that can be wrong is in `bankroll.ts` (Tasks 2–3); the message contract is exercised by `FakeWorker` in Task 6.
- Task 9's App tests stub `offsetHeight` because jsdom has no layout engine, so they pin the wiring rather than the real fitting. Confirming it actually looks right needs a browser.
- Task 10's README steps specify the heading structure exactly but describe the prose by required content rather than supplying finished paragraphs.
