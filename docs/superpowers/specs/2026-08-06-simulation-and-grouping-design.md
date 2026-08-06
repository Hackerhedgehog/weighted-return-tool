# Simulation & Bucket Grouping — Design

Date: 2026-08-06. Written from the brief in chat; the session ran autonomously,
so decisions the brief left open are recorded here with their reasoning rather
than asked back.

## Scope

Three feature clusters, one document:

1. **Monte Carlo simulation** of the current bucket table — spins, live stats
   (RTP, std dev, hit rate, win rate, max win), and a realtime graph of
   downsampled results. New panel below everything else.
2. **Bucket grouping** — label/payout heuristics assign every bucket to a
   group; groups drive pastel row tinting in the table, bar colors in the
   distribution chart, a group sort, and draggable group handles on the
   chart's right edge.
3. **Draggable chart bars** — hover a bar and drag its weight or chance
   directly, with a relativity toggle in weights mode.

## 1. Simulation

### Engine

- True per-spin sampling — the brief says "simulate spins", not approximate.
  Sampling uses **Vose's alias method**: O(n) setup, O(1) per spin, so 100M
  spins stay in whole-seconds territory.
- PRNG is **mulberry32** — fast, tiny, and seedable, so the core is
  deterministic under test. The UI seeds from `Date.now() ^ (Math.random()*2**32)`.
- Runs in a **Web Worker** (`new Worker(new URL(...), {type:'module'})`, the
  Vite idiom). 100M spins on the main thread would freeze the page. The worker
  yields between blocks (`setTimeout 0`) so a cancel message can land;
  `Cancel`/unmount also `terminate()`s outright.
- The simulation snapshots the table at Run time. Edits made mid-run do not
  bend an in-flight simulation; the header states the spin count and snapshot
  is implicit.

### Statistics (per-spin payout multiplier `x`, bet = 1)

| Stat | Definition |
|---|---|
| RTP | `Σx / n` |
| Std dev | `√(Σx²/n − (Σx/n)²)` — population form |
| Hit rate % | share of spins with `x > 0` |
| Win rate % | share of spins with `x > 1` — same `>1` convention the solver's win chance uses |
| Max win × bet | max `x` drawn |

Sums fit comfortably in doubles: `Σx² ≤ 100M · 1000² = 1e14 « 2^53`.

### Graph data points

One point per **0.1 % of the requested spins** (`blockSize = ceil(spins/1000)`,
so 100M spins → 1000 points of 100K spins each). Each stored point is that
block's **mean payout**. The chart draws:

- block means — light dots/steps, the noise;
- **cumulative RTP** — bold line, computed from the stored block means;
- **expected RTP** from the live table — dashed reference.

The worker posts one message per block: `{block index, blockMean, running
aggregates}`. ~1000 messages per run is far below React's comfort threshold,
so no extra throttling layer.

### UI

New `Simulation` panel below the Distribution panel. Controls: spins input
(default **100,000,000**, persisted in the workspace), Run / Cancel, progress.
Stat tiles update live from the latest aggregate snapshot. Sim state is not
undoable and results are not persisted.

## 2. Grouping

### Rules, in priority order

1. **payout == 0** → the `0x` group — explicitly beats name matching
   ("joker2-tease" belongs with the other zero-payout buckets, not with
   "joker3").
2. Label contains **"bonus"** (case-insensitive) → the `bonus` group.
3. Label is a **win range** — matches `^\d+(\.\d+)?-\d+(\.\d+)?x$` after
   trimming, like `0-1x`, `8-16x` → the `wins` group.
4. **Shared stem**: a label token matching `alpha+digits` (e.g. `joker5` in
   `joker5-maxwin`) contributes stem `joker`; stems shared by ≥ 2 buckets form
   a group each (`diamond3`/`diamond4` works the same way unmodified).
5. Everything else → `other`.

On the real engine data this yields: `0x` (joker2-tease, bonus-*-tease, 0x),
`bonus` (bonus3-5, bonuspaid-*), `wins` (0-1x … 512-1024x), `joker`
(joker3/4/5-*), `other` (hp-fullscreen, green-two-only).

Group display order: `wins`, `bonus`, stems A→Z, `0x`, `other`. `groupRows()`
in `src/lib/groups.ts` returns ordered `GroupInfo[]` (id, name, color, member
uids) plus a uid→group map; it is a pure function of `rows`, memoized in App.

### Colors

A fixed pastel palette (8 hues, dataviz-skill validated) assigned by group
order, wrapping if a table produces more stems than hues. The same hue paints
the table row background (low-alpha so both themes survive) and the chart bar
fill. Padding/margins in the table do not change — tint only.

### Group sort

New `SortKey` `'group'`: group rank, then payout ascending, then id.
`sortRows` gains an optional rank map argument (export order continues to
follow the table's sort, unchanged when the map is absent). A `Group sort`
button in the Buckets panel head toggles it; column-header clicks still work
as before.

## 3. Direct manipulation

### Shared core — `src/lib/interact.ts`

One relative operation covers both group handles and relative bar drags:

`scaleSubset(rows, subsetUids, newSubsetTotal)` —
- subset's unlocked rows scale proportionally to hit `newSubsetTotal`
  (locked rows never move; their sum is the floor),
- all other unlocked rows scale to the remainder, so the **grand total is
  invariant** — which keeps `Σchance == 1` for free,
- clamped to `[lockedInside, total − lockedOutside]`,
- integer-exact via the solver's `largestRemainder` (now exported).

Non-relative bar drags (`weights` mode, relativity off) just scale the bar's
own rows to the new value and let the total move.

### Bar dragging

- Hovering a bar shows the existing tooltip; pressing and dragging vertically
  maps pointer y → value through the **inverse of the y-scale frozen at
  drag start** (otherwise the axis would rescale under the pointer —
  feedback loop).
- Aggregate bars (equal payouts merged) drag all their rows proportionally.
- **Weights mode**: `Relative` toggle, default **on** (total weight
  preserved, others compensate). Off → only this bar's weight changes.
- **Chance mode**: always relative, sums to 100 % by construction.
- During a drag the app shows **preview rows** (table, stats and chart all
  update live); history receives **one** entry on pointer-up, so undo undoes
  the whole drag.

### Group handles

- Right edge of the distribution chart, one handle per group, at
  `y = yFrac(group total)` in the current metric — so log/linear mode is
  respected automatically.
- Handle label: group name, chance % (or weight), and the group's weighted
  value `Σ payout·weight / total`.
- Dragging a handle is `scaleSubset` over the whole group: within the group
  relative proportions are preserved, other groups absorb the change, total
  chance stays 1. Same frozen-scale and preview/commit rules as bars.
- A fully locked group renders its handle disabled.
- The chart's right margin widens to make room; handles stack with slight
  x-offsets when values collide.

## Persistence & state

- `ChartSettings` gains `relative: boolean` (default true); `Workspace` gains
  optional `simSpins`. Both are **optional in validation** and defaulted on
  load — an existing v1 workspace must not be wiped by the new fields.
- Groups are derived state (memo), never stored.
- Sim results live only in component state.

## Testing

- `groups.test.ts` — every rule, priority conflicts, real engine labels.
- `interact.test.ts` — invariants: grand total preserved, locks immovable,
  clamps, integer exactness, proportion preservation.
- `sim.test.ts` — alias table correctness (probabilities recovered over a
  seeded run, χ²-loose tolerance), aggregate merging, stats against a
  hand-computable ladder, block plan (0.1 % rule, remainder block).
- App smoke test additions: sim panel renders, group tinting present,
  group sort button reorders rows.

## Out of scope

Simulation of multi-bet strategies, per-bucket sim breakdowns, persisting sim
runs, and any solver changes. The solver's own conventions (locks, win > 1x)
are adopted, not modified.
