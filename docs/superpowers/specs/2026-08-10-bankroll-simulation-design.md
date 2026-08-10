# Bankroll simulation, chart auto-height and a categorized README

Date: 2026-08-10

Three changes. The large one is the **bankroll simulation** promised at the end
of `2026-08-07-chart-interaction-and-groups-design.md`: play the table with a
real balance — start credits, a bet, an RTP multiplier — and watch the credit
balance until it busts or hits a spin cap. The other two are small: the
distribution chart defaults to the table's height instead of a fixed 340px, and
the README's fifteen flat feature headings gain categories.

The existing simulation answers "what does this table converge to". The
bankroll simulation answers a different question — "how long does a player last
on it" — and that question needs a balance, not an average.

## 1. The bankroll core — `src/lib/bankroll.ts`

Pure and synchronous, standing to `bankroll.worker.ts` exactly as `sim.ts`
stands to `sim.worker.ts`: all the money arithmetic is unit-testable in node,
and the worker owns only scheduling and messaging.

```ts
export interface BankrollConfig {
  /** Starting balance, in credits. */
  credits: number
  /** Stake per spin, in credits. */
  bet: number
  /** Every payout is multiplied by this before the alias table is built. */
  rtpMultiplier: number
}

export interface BankrollState {
  balance: number
  spins: number
  /** Highest and lowest balance seen between spins. */
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
```

### The spin

```ts
if (s.balance < bet) { s.busted = true; break }
s.balance -= bet
const x = /* alias draw */
s.balance += bet * x
```

**Bust is `balance < bet`, checked before the spin** — a balance of 0.5 at a bet
of 1 cannot buy a spin, so stopping at `balance <= 0` would be wrong. `peak` and
`low` are sampled *after* the spin resolves, so they report the balance between
spins rather than the momentary dip while the stake is out.

`runBankrollBlock(t, rand, maxSpins, bet, s)` mutates `s` and returns the spins
actually run, stopping early on bust — the same hot-loop shape as `runBlock`,
with the alias draw inlined for the same reason.

Numbers stay honest: over a 10M-spin chunk, `Σ|Δbalance| ≤ 1e7 × bet × maxPayout`,
which for the realistic worst case here is ~1e10 — far inside double precision,
as in `sim.ts`.

### The RTP multiplier

The multiplier **scales the payouts array once, when the alias table is built**:

```ts
buildAlias(payouts.map((p) => p * config.rtpMultiplier), weights)
```

Zero per-spin cost, and the table on screen is never modified — the multiplier
is a property of the run, not an edit. Realised RTP then tracks
`tableRtp × multiplier` in expectation, exactly.

Two consequences worth stating because they will show up in the stat tiles:
hit rate is **unchanged** (a zero payout stays zero under any multiplier), and
win rate **shifts slightly**, because `wins` counts `payout > 1` and scaling
moves that boundary. A multiplier of 0 is legal — every payout becomes zero and
the balance drains by `bet` per spin, which is a valid stress test.

## 2. The resumable worker — `src/lib/bankroll.worker.ts`

A **second worker file** rather than a mode inside `sim.worker.ts`. The existing
worker is a one-shot: it receives a request, runs to completion, and is done.
Bankroll needs a genuinely different lifecycle — it retains the balance, the
PRNG and the alias table between messages, so `Continue` resumes the exact
sequence an uninterrupted run would have produced. Folding two lifecycles into
one shell would make both harder to read than keeping them apart.

```ts
export type BankrollRequest =
  | { type: 'start'; payouts: number[]; weights: number[]; config: BankrollConfig; seed: number }
  | { type: 'continue' }

export type BankrollMessage =
  | { type: 'progress'; points: BankrollPoint[]; state: BankrollState }
  | { type: 'chunk-done'; points: BankrollPoint[]; state: BankrollState; capped: boolean }
  | { type: 'error'; message: string }

export interface BankrollPoint { spins: number; balance: number }

export const BANKROLL_CHUNK_SPINS = 10_000_000
export const BANKROLL_MAX_POINTS = 2_000
export const BANKROLL_MIN_BLOCK = 100
```

The run reads `doc.rows` — the whole table, not `viewRows` — and normalizes
weights with `Math.max(0, Math.round(r.weight))`, both exactly as convergence
mode already does, so the two modes can never disagree about what they are
simulating. A row's `locked` flag has no meaning here: locks constrain the
solver, not a draw.

A chunk ends when the run busts (`capped: false`) or when it has run
`BANKROLL_CHUNK_SPINS` this chunk (`capped: true`). **`Continue` is offered only
on `capped: true` with `busted: false`** — cancelling terminates the worker and
ends the run, matching what Cancel already does in convergence mode. `state.spins`
accumulates across chunks; only the per-chunk counter resets.

A `continue` arriving with no retained run is an `error`, not a crash.

### Chart resolution

The worker owns the point buffer and **sends the whole buffer** on every
message, throttled to ~10/s. That costs a little bandwidth (2000 points is a
few tens of KB) and buys a lot: the panel has no ref-buffer and no flush timer
of its own, and the decimation below lives in exactly one place.

Because a bankroll run's length is bust-driven, it is not known in advance, so
the block size cannot be planned the way `blockPlan` plans one. Instead:

- the buffer starts at **1 point per `BANKROLL_MIN_BLOCK` (100) spins**;
- when it would exceed **`BANKROLL_MAX_POINTS` (2000)**, every second point is
  dropped and the block size doubles.

Points are dropped, never averaged: a balance curve is a random walk, and
averaging would smooth away the drawdowns that are the whole point of the
chart. Every retained point is a true balance at a true spin count, so the line
stays one continuous, unbroken curve at every scale — short runs stay detailed,
long ones stay bounded. A final point is emitted when the run ends mid-block, so
a run that busts at spin 37 still draws.

The **stat tiles never read the point buffer**. `peak`, `low`, `maxWin` and
`sum` are accumulated per spin in `BankrollState`, so decimation cannot lose a
headline number — only chart resolution is ever traded away.

## 3. Splitting the simulation panel

`SimulationPanel.tsx` is 315 lines and would roughly double. Three files:

| File | Role |
|---|---|
| `SimulationPanel.tsx` | thin shell — the mode toggle, renders one child |
| `ConvergenceSim.tsx` | today's panel content, moved wholesale |
| `BankrollSim.tsx` | new — fields, Run/Cancel/Continue, tiles, chart |

`SimulationPanel.test.tsx` moves to `ConvergenceSim.test.tsx` with it. The mode
is persisted as `simMode?: 'convergence' | 'bankroll'`, defaulting to
convergence, so an existing workspace opens on the panel it opened on before.

```
┌─ Simulation ───────────────────────────────────────────┐
│ [ Convergence ] [ Bankroll ]                           │
│                                                        │
│ Credits [1,000,000]  Bet [1]  RTP× [1]  [Run]          │
│ ▓▓▓▓▓▓▓▓░░░░░░  42% · 4.2M / 10M spins                 │
│                                                        │
│ [balance] [spins] [peak] [lowest] [RTP] [biggest win]  │
│                                                        │
│   (credit balance chart)                               │
└────────────────────────────────────────────────────────┘
```

The toggle is a two-button segmented control carrying `aria-pressed`, inside the
panel body rather than the head — the head's `h2` and hint are rendered by `App`
and stay as they are, since "spins the current table with a fast Monte Carlo
run" describes both modes.

### Fields

All three parse through a generalized `parseAmount(text, opts)`, extracted from
`parseSpinsInput` so the `1m` / `250k` shorthand works everywhere.
`parseSpinsInput` stays as a thin wrapper over it, so no existing caller changes.

| Field | Default | Range | Form |
|---|---|---|---|
| Credits | 1,000,000 | 1 – 1e12 | integer, shorthand |
| Bet | 1 | > 0 | decimal |
| RTP× | 1 | 0 – 1000 | decimal |

**Run is disabled when `bet > credits`** — the run would bust at zero spins and
draw nothing — with a title saying so, alongside the existing "no rows" and "no
Web Workers" guards.

### The RTP ≥ 1 warning

Effective RTP is `achieved.rtp × rtpMultiplier`, computed on the main thread. At
`>= 1` the panel shows a warning above the controls and **Run stays enabled**:

> Effective RTP is 1.0450 — at 1 or above the balance drifts upward, so a bust
> becomes very unlikely and the run will usually just reach the spin cap.

"Very unlikely" rather than "impossible": variance can still bust a short
bankroll at an RTP above 1.

### Stat tiles

Six, matching the convergence panel's shape:

| Tile | Value |
|---|---|
| Balance | current, or final if the run ended |
| Spins survived | `state.spins` |
| Peak | highest balance |
| Lowest | lowest balance |
| Realised RTP | `sum / spins`, labelled with `table RTP × multiplier` |
| Biggest win | `maxWin × bet`, in credits |

Credits are the unit the panel thinks in, so `maxWin` is stored as a multiplier
(consistent with `SimAggregate`) and multiplied by the bet only for display.

The progress line reports the outcome in words — `busted after 3,412,880 spins`
or `10,000,000 spins · 412,000 credits left`.

## 4. `BankrollChart.tsx`

Balance against spins, and deliberately *not* a variant of `SimChart`: that
chart's whole structure — three series, a p95 ceiling, spike clipping — exists
to make an average legible, and none of it applies to a single balance line.

- **Y is linear with 0 pinned to the bottom.** Busting is the story, so zero has
  to be on the chart; `yMax` is `niceCeil(peak * 1.05)`. No log option — a log
  axis cannot show the value the run is heading for.
- **X is 0 to `state.spins`**, growing with each `Continue`.
- A dashed reference at the starting credits, so up and down are readable at a
  glance without doing arithmetic against the axis.
- A bust marker — a rule and a dot at the final point — when `busted`.
- The usual crosshair through `ChartReadout`, reporting spins, balance, and
  change against the starting credits.
- `ChartResizeGrip` on `SIM_HEIGHT`, sharing `simChartHeight` with the
  convergence chart: one chart slot in one panel, one remembered height.

## 5. The distribution chart fits the table

`chartHeight` is currently seeded from `DIST_HEIGHT.fallback` (340) and only
ever changes when the grip is dragged. It should start at the table's height
instead.

```ts
const [chartHeightAuto, setChartHeightAuto] = useState(saved?.chartHeightAuto ?? true)
const [tableHeight, setTableHeight] = useState<number | null>(null)

const effectiveChartHeight =
  chartHeightAuto && tableHeight !== null
    ? clampHeight(tableHeight, DIST_HEIGHT)
    : chartHeight
```

The `?? true` is deliberate: `chartHeight` is written into the workspace on
*every* save, not only on a manual resize, so its presence in an existing
workspace says nothing about whether the user ever chose it. Defaulting to auto
is what makes the feature appear for a workspace that already exists.

Clamping to `DIST_HEIGHT` (220–900) is what keeps this sane — a 200-bucket table
is several thousand pixels tall, and matching that literally would produce a
chart that cannot stick to the viewport and cannot be read.

**Measurement reuses the observer that is already there.** `rowRef` observes
`.content-row` and its children to decide whether the row has wrapped; it gains
one more read:

```ts
setTableHeight((h) => (h === null || Math.abs(h - table.offsetHeight) >= 1 ? table.offsetHeight : h))
```

No feedback loop is possible: the two panels are independent flex items under
`align-items: flex-start`, so the table's height never depends on the chart's. A
chart resize re-fires the observer, reads an unchanged table height, and the
state update no-ops. The `>= 1` guard absorbs sub-pixel jitter.

**Dragging the grip sets `chartHeightAuto` false**; auto-fit stops and the
chosen height is remembered as it is today. **Double-clicking the grip restores
auto** rather than the old fixed 340 — the reset gesture should return you to
the default, and the default is now "fit the table". `ChartResizeGrip` gains an
optional `onReset?: () => void` used by double-click and Home when provided; the
simulation chart does not pass it and its behaviour is unchanged.

New optional workspace field `chartHeightAuto?: boolean`, validated with the
others.

## 6. README structure

The Features section is fifteen sibling `###` headings, which is a list rather
than a structure. Categories are promoted to `##` and `## Features` goes away,
so individual features stay at `###` and the two nested topics stay at `####` —
the restructure adds no heading depth.

```
## Data formats
## Getting started
## Solving weights          solver · tolerance · volatility · weight step · targets panel
## Editing the table        keyboard · arithmetic · totals · locks (group locks) · groups · columns
## The distribution chart   dragging and setting values (group bars) · tooltip and height
## Simulation               convergence mode · bankroll mode
## Workspace                layout · export · persistence
## Project layout
## Tests
```

The Contents list is regenerated to match. Two sections also change in
substance: **Simulation** splits into the two modes, and **the tooltip and chart
height** documents the auto-fit and the new double-click-to-restore.

## Testing

- **`bankroll.test.ts`** — where the risk lives. The bust boundary (`balance <
  bet` busts, `balance == bet` spins); balance arithmetic over a scripted PRNG;
  the multiplier scaling realised RTP proportionally while leaving hit rate
  alone; `peak`/`low` tracking including a run whose low is its final busted
  balance; **two chunks from one seed producing exactly the state one
  uninterrupted run produces**, which is the property `Continue` rests on; a
  zero-total-weight table erroring rather than looping; a multiplier of 0
  busting in `floor(credits / bet)` spins exactly.
- **Point decimation** — the buffer never exceeds the cap; retained points keep
  their true spins and balances; a run that busts inside the first block still
  emits one point; `peak`/`low` survive decimation that drops the points they
  occurred at.
- **`BankrollSim.test.tsx`** — fields parse shorthand and clamp; Run is disabled
  when `bet > credits`; the RTP ≥ 1 warning appears at exactly 1 and Run stays
  enabled; `Continue` appears only when the chunk capped *and* the run is
  solvent, and not after a bust or a cancel; Cancel ends the run and keeps the
  drawn line.
- **`BankrollChart.test.tsx`** — the path renders, 0 is on the axis, the
  starting-credits reference sits at the right height, the bust marker appears
  only when busted, and the crosshair reports the point under it.
- **`storage.test.ts`** — `simMode`, `chartHeightAuto`, credits, bet and
  multiplier round-trip; bad values are rejected and the workspace still loads.
- **`App.test.tsx`** — the chart takes the table's height, clamps at both ends,
  stops fitting once the grip is dragged, and fits again after a grip reset.

## Out of scope

- Running many bankroll sessions to get a distribution of bust times. That is a
  genuinely different feature — a histogram, not a balance line — and would want
  its own panel.
- Saving or exporting a bankroll run's results.
- Bet-sizing strategies (raise on loss, and so on). The bet is constant.
- Making the 10M chunk size configurable; it is a constant.
- Any change to convergence mode beyond moving it into its own file.
- A log Y axis on the balance chart; §4 explains why.
