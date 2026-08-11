# Weight floor, payout-ordered weights, and collapsible table groups

Date: 2026-08-11

## Problem

Three requests against the current solver and buckets table.

### 1. Auto-Distribute leaves buckets on zero weight

`solveWeights` applies its minimum-weight floor *per group*, inside `allocate`,
after each group's budget is already fixed:

```ts
const groupBudgets = largestRemainder(groupSums, free, false, step)
active.forEach((g, k) => {
  const alloc = largestRemainder(idx.map((i) => cont[i]), groupBudgets[k], true, step)
```

`largestRemainder`'s `minOne` only applies when `t >= n` — when the budget can
go round. Two reproducible cases starve it:

- **A group with no mass.** `massesFor` gives the small-win group
  (`0 < payout <= 1`) `(hit - win) * total`. Setting hit chance = win chance
  makes that exactly 0, so on the reference ladder `green-two-only` (0.33x) and
  `0-1x` (0.6x) both land on **0 weight**. This is the reported "1x payout as 0
  weight".
- **A budget too small to fund one step per member.** At `step = 100` with a
  total of 10,000, 13 of the 30 reference buckets land on 0.

### 2. Weights are not ordered by payout

Solving the reference table across the settings matrix produces three distinct
classes of inversion:

| Case | Break | Cause |
|---|---|---|
| `very low` volatility, RTP 0.95 | `0.33x:73,864 < 0.6x:142,199`, then `1.8x < 2x < 2.12x < 2.61x` | `solveGamma` bisects over `[GAMMA_LO, GAMMA_HI] = [-40, 40]`; reaching RTP under heavy curvature drives `gamma` negative, and `exp(-gamma*u - c*u^2)` then *rises* with payout |
| hit chance = win chance | `0.6x:0 < 1.8x:21,452` | the two positive bands are normalized to independent budgets in `continuousWeights`, so the band boundary at 1x can jump *upward* |
| every case | `50.11x:2,055 < 50.16x:2,056`; at step 100, `50.11x:300 < 50.16x:400` | `largestRemainder`'s fractional tiebreak and `repairRtp`'s pairwise transfers are both blind to the ladder |

Separately, the `0x` residual bucket does not dominate. On a fresh weightless
paste `continuousWeights`' zero-payout branch has no current balance to
preserve and falls back to uniform:

```ts
const props = sum > 0 ? base.map((b) => b / sum) : idx.map(() => 1 / idx.length)
```

so the reference table's `0x` bucket ties with the four tease buckets at 14% of
total each, rather than dominating. In `useChances: false` mode `currentMasses`
falls back to *bucket counts*, handing the zero group only 5/30 of the table and
producing `0x:40,011 < 0.33x:500,728`.

### 3. No way to collapse a group in the buckets table

The distribution chart can already draw a group as one bar (`ChartSettings.
groupBars`, `buildBars`, `GroupBarChips`). The table has no equivalent — every
bucket is always a row.

## Target ranking

The header comment in `distribute.ts` documents the current rank as
locks > chances (structural) > RTP > volatility. This design replaces it with:

1. **Locks** — absolute, never touched.
2. **Target RTP** — hit exactly, to integer-weight granularity.
3. **Payout ordering** — see the invariants below.
4. **Volatility** — curvature `c`; flattened when it fights ordering.
5. **Hit chance** — preference, with the existing tolerance band.
6. **Win chance** — preference, with the existing tolerance band.

When targets collide the solver yields in reverse rank order: win chance first,
then hit chance, then volatility, and only breaks ordering when the RTP target
is otherwise unreachable. Every yield emits a named warning.

## Design

### 1. Minimum weight floor

**Invariant:** every *unlocked* bucket receives at least one `step` of weight
from any tool-computed distribution.

Locked rows are untouched, including a locked 0. A hand-typed 0 in a weight
cell stays 0 — the floor is a property of the solver, not of the document.

The floor moves from per-group (inside `allocate`) to a reservation taken off
the top in `freeBudgets`, before the chance-driven masses are split:

```
reserve[g]  = ctx.freeIdx[g].length * step
totalReserve = reserve[0] + reserve[1] + reserve[2]
budgets[g]  = reserve[g] + share[g] * (free - totalReserve)
```

`share[g]` is the existing mass-proportional split, renormalized over
`free - totalReserve` instead of `free`. Because every group's budget is now at
least `count * step`, `largestRemainder(..., minOne: true, step)` inside
`allocate` always takes its `useMin` branch and the floor holds.

`allocate` currently re-derives group budgets from the continuous sums
(`largestRemainder(groupSums, free, false, step)`), which can round a group back
below its reserve. It gains a post-step that raises any group below
`count * step` and takes the difference from the largest group.

When `totalReserve > free` the solve is refused rather than shipping zeros,
following the shape of the existing `stepBlockWarning`:

> Weight step 100 cannot give all 30 buckets a minimum weight at a total of
> 1,000 — raise the total to at least 3,000, or lower the weight step.

`rescaleToTotal` (the Total cell) switches its
`largestRemainder(..., minOne: false, ...)` to the reserved-budget form and
returns `null` when the new total cannot fund the floors. `App.
changeTotalWeight` reconstructs the *reason* for a `null` from the row data and
would otherwise report this new case as a step-divisibility problem, so
`distribute.ts` exports

```ts
/** Smallest total that can hold the locks and still floor every unlocked row. */
export function minTotalWeight(rows: BucketRow[], step: WeightStep): number
```

and `changeTotalWeight` gains a branch ahead of its `stepBlockWarning` fallback
that names that figure. Keeping the arithmetic in `distribute.ts` means the
refusal and the message can never disagree.

`retargetRtp` (the RTP cell) preserves each group's unlocked sum exactly, so it
gets no new refusal: when a group's own sum cannot fund one step per member the
floor is simply unenforceable there and today's `minOne` behavior stands. Only
Auto-Distribute, which chooses the group sums, can guarantee the floor — and a
table that came from Auto-Distribute already satisfies it.

### 2. Payout-ordered weights

#### Invariants

Let `ladder` be the unlocked rows with `payout > 0` sorted by payout ascending.

- **Ordered:** for any two ladder rows with `payout_i < payout_j`,
  `w_i >= w_j`. Equal payouts are unconstrained relative to each other.
- **Dominant residual:** if a residual bucket exists, its weight is `>=` every
  ladder weight — i.e. it is the largest weight in the table.

The **residual** is the zero-payout row whose label, trimmed and lowercased, is
exactly `0x`; failing that, the zero-payout row whose label contains `0x` as a
whole token (`/(^|[^0-9a-z])0x([^0-9a-z]|$)/`, so `100x` and `1000x` do not
match). If no zero-payout row matches, there is no residual and the dominance
invariant is vacuous.

Ordering is enforced over **unlocked** rows only. A lock is rank 1 and may sit
anywhere; a locked row that breaks the ladder is reported, not corrected:

> "joker5-maxwin" is locked at 500,000, above lower-paying buckets — locked
> weights are never reordered.

**The tease buckets are deliberately exempt.** They pay 0x, so a strict global
reading would force each of them above the top paying bucket. The reference
export contradicts that: its teases hold ~15,000 against `green-two-only` at
290,000. Zero-payout buckets draw their mass from hit chance and divide it by
the split rule below; only the residual is held to an ordering constraint.

#### Mechanism A — non-negative slope, with volatility yielding

`GAMMA_LO` becomes `0`, so `solveGamma` can never return a rising curve and
each band is non-increasing by construction (`-gamma*u - c*u^2` has derivative
`-gamma - 2*c*u <= 0` for `gamma >= 0`, `c >= 0`, `u >= 0`).

Clamping alone would put the RTP target out of reach at low volatility, and RTP
outranks volatility. So when `reachRange` at `gamma >= 0` does not contain the
target, the solver bisects the curvature `c` over `[0, curve]` for the largest
`c` that brings the target back into reach, and reports it:

> Volatility flattened (curve 0.32 → 0.14) to keep weights ordered by payout
> while hitting RTP 0.95.

`c = 0, gamma = 0` is uniform-within-band, which on the reference ladder reaches
RTP ≈ 15.7 — far above any realistic target — so this fallback effectively
always succeeds. If it does not, `GAMMA_LO` reverts to `-40` for that solve and
the tool says ordering was spent:

> Weights could not be kept in payout order at RTP 5.0 — ordering yielded to the
> RTP target.

The flattened curve is returned as `SolveResult.curveUsed` and reported in the
notices. It is **not** written back into `doc.curve`: the volatility control
keeps showing what the user chose, and the notice explains what was used.

`reachRange` bisects between `GAMMA_HI` and `GAMMA_LO`, so raising the floor to
0 also narrows the range the *band search* tests for reachability — the search
and the solve stay consistent for free. The band search keeps its current job
(spend chance tolerance only when RTP is otherwise out of reach) and runs before
the ordering loop; curvature flattening is the second lever, tried only when
spending the band was not enough. This orders the two RTP levers chances-first,
volatility-second, which is the reverse of their rank — a deliberate
simplification, since the ±3.5% band moves RTP reach far less than curvature
does and threading both through one search would double the solve's cost for a
case that barely arises.

#### Mechanism B — no upward jump at the band boundary

A downward step at 1x is legitimate and is what lets the win band be rare
without crushing the tail; only an upward step violates ordering. After the
continuous weights are computed, the solver compares the *lowest* small-win
weight (largest payout `<= 1`) against the *highest* win weight (smallest payout
`> 1`). When the win side is higher, the minimum mass that levels the step is
moved from `budgets[2]` to `budgets[1]` and `gamma` is re-solved for RTP.

Mechanism C (below) can move mass the other way, so the two run together in a
fixed-point loop, capped at `ORDER_ROUNDS = 12`; each round moves mass in one
direction only, so it settles. Not settling is reported rather than looped on.

Because band 2's mass *is* win chance, this trades win chance for ordering,
which the ranking permits:

> Win chance yielded to payout ordering — achieved 0.084 against a target of
> 0.12.

This warning replaces the generic `outOfBand` warning for win chance when it
fires, rather than doubling it.

#### Mechanism C — residual dominance

When the residual's share of `budgets[0]` falls below the largest ladder weight,
mass moves from `budgets[1]` and `budgets[2]` (in proportion) into `budgets[0]`
until it does not, and `gamma` is re-solved. Since `budgets[0]` is `1 - hit`,
this trades hit chance for ordering:

> Hit chance yielded to payout ordering — achieved 0.78 against a target of 0.90.

The practical consequence is that **hit chance has a ceiling** — on the
reference ladder roughly 0.75–0.80. Above that the residual cannot stay the
largest weight.

#### Mechanism D — order-preserving integer stage

Two changes downstream of the continuous solve:

- **`enforceOrder(ctx, w, step)`**, a new sweep run after `allocate`: walking the
  ladder ascending, any pair with `w[i] > w[i-1]` has
  `ceil((w[i] - w[i-1]) / 2 / step) * step` moved from `i` down to `i-1`.
  Repeated until stable (bounded sweeps). It is a pure transfer, so the total is
  preserved exactly; it only ever moves weight *down* the ladder, so RTP falls
  monotonically and by a bounded amount — the violations it fixes are between
  near-equal payouts, so the drift is on the order of `step * gap / total`
  (4e-6 at step 100 on the reference table).
- **`repairRtp` gains an ordering guard.** `transfer` moves units between a
  low- and a high-payout bucket; the direction that raises RTP can invert the
  ladder. Each candidate step is now checked against the ladder and rejected if
  it would break the order, so `repairRtp` restores RTP only through moves that
  keep the invariant. The existing accuracy note in its comment gains the
  caveat that the guard can leave a residue when every RTP-improving move is
  blocked.

Order of operations inside `solveWeights` becomes:

```
band search  ->  [ solveGamma (gamma >= 0, flatten c if needed)
                   -> continuousWeights
                   -> check boundary jump / residual dominance
                   -> shift budgets and repeat ]  x ORDER_ROUNDS
             ->  allocate (with reserved floors)
             ->  enforceOrder
             ->  repairRtp (order-guarded)
```

#### Zero-payout split

`continuousWeights`' zero-payout branch keeps preserving the current balance
whenever the zero buckets hold any weight — Auto-Distribute must not discard a
hand-tuned tease balance. Only the `sum === 0` fallback changes: instead of
splitting evenly, the residual takes `ZERO_RESIDUAL_SHARE = 0.8` of the zero
mass and the remaining zero buckets split the other 20% evenly. With hit chance
0.3 that puts the reference table's `0x` bucket at ~56% of total, matching the
shape of the reference export (550,000 of 1,200,350 = 46%, teases at ~1.3%
each).

When no residual can be identified the fallback stays even, exactly as today.

`currentMasses` (the `useChances: false` path) gets the same treatment: its
bucket-count fallback for a weightless table is what produces
`0x:40,011 < 0.33x:500,728`, and it is replaced by the default target's hit
chance so the zero group is sized by mass rather than by member count.

### 3. Collapsible table groups

#### State

`App` gains `collapsedGroups: string[]` — view state, persisted, not undoable,
exactly like `chart.groupBars`. It is **separate** from `groupBars`: collapsing
in the table does not change the chart.

`Workspace` (`src/lib/storage.ts`) gains `tableCollapsed?: string[]`, optional
for backward compatibility and validated as an array of strings, following the
`groupBars` precedent. `loadData` resets it to `[]` alongside `groupBars` — new
data means new group ids.

#### Display-row model

New module `src/lib/tableRows.ts`, deliberately mirroring `buildBars`' structure
(collapse first, then handle whatever is left):

```ts
export interface GroupAggregate {
  /** Weight-weighted mean; plain mean when the group holds no weight. */
  payout: number
  weight: number
  value: number
  chance: number
  count: number
  lock: LockState
}

export type TableRow =
  | { kind: 'bucket'; row: BucketRow }
  | { kind: 'group'; group: GroupInfo; members: BucketRow[]; agg: GroupAggregate }

export function buildTableRows(
  rows: BucketRow[],
  grouping: Grouping,
  collapsed: string[],
  sort: SortState,
  totalWeight: number,
): TableRow[]
```

`payout` uses the same rule as `buildBars`' `groupBar` — `sum(p*w) / sum(w)`,
falling back to the plain mean at zero weight — so the table and the chart
agree on where a collapsed group sits. `weight`, `value` and `chance` are sums,
so the Weights column still foots to the total and Chance still foots to 1.
`lock` reuses `groupLockState`.

Sorting operates on the display units, not on buckets: a collapsed group is
ranked by its aggregate for whichever column is active (`payout`, `weight`,
`weightedValue`, `chance`), by group rank for `group`, by group name for
`label`, and by its lowest member `bucketId` for `id` and `weightId`. This works
under every sort, not only Group sort. The existing `sortRows` is left alone —
it is shared with the export, which is unaffected.

#### Rendering

`BucketTable` maps over `TableRow[]` instead of `BucketRow[]`. A group row
renders:

| Column | Content |
|---|---|
| lock | group lock state, click toggles every member (reuses `App.setGroupLocked`) |
| group | `▸ bonus` — a button that expands the group |
| id, weightId | em-dash, not editable |
| payout | `fmtPayout(agg.payout)`, not editable |
| label | `9 buckets`, not editable |
| weight, weightedValue, chance | the summed aggregates, not editable |

`isEditable` returns `false` for every cell of a group row, so `useGridNavigation`
still walks it (no focus traps, same reason the totals row renders real cells)
but nothing commits. `rowCount` becomes `displayRows.length + 1`; selection is
clamped when the count shrinks on collapse.

#### Affordance

`GroupBarChips` is generalized into `src/components/GroupChips.tsx` — same
markup and All/None behavior, parameterized by the row label and the per-chip
titles. The chart keeps its `Group bars` row; the Buckets panel head gets a
`Collapse` row using the same component. Expanding is also possible from the
`▸` button on the collapsed row itself.

#### Not affected

Export writes per-bucket rows regardless of what is collapsed — `buildTsv` runs
off `sortRows(doc.rows, ...)` and never sees the display model. The chart is
likewise independent.

## Testing

vitest, in the style of the existing suites.

`distribute.test.ts`:

- **floor:** every unlocked weight `>= step` at `step` 1, 10 and 100, including
  the two cases that currently fail — hit chance = win chance, and step 100 at a
  10,000 total
- a total that cannot fund the floors returns the refusal warning and leaves
  weights untouched
- a locked 0-weight row stays 0
- **ordering:** across the full matrix (five volatility presets x a range of RTP
  targets x steps 1/10/100), the unlocked positive ladder is non-increasing —
  the direct regression test for all three break classes above
- the residual is the largest weight in the table whenever one exists
- low volatility at RTP 0.95 hits RTP exactly, stays ordered, and reports a
  flattened curve in `curveUsed` plus its warning
- hit chance = win chance produces an ordered ladder, a win-chance-yielded
  warning, and no generic band warning for win chance
- hit chance 0.9 clamps, stays ordered, and reports hit chance yielding
- a locked row that breaks the ladder is reported and not moved
- **zero split:** a weightless table puts the residual at 80% of the zero mass;
  a table that already carries zero weights keeps their proportions through
  Auto-Distribute; a table with no `0x`-labeled row splits evenly; `100x` and
  `1000x` labels do not match the residual pattern
- `useChances: false` no longer sizes the zero group by member count
- existing assertions on exact RTP, group sums and step multiples continue to
  hold

`tableRows.test.ts` (new):

- a collapsed group produces one row whose weight/value/chance are the member
  sums and whose payout is the weight-weighted mean
- the zero-weight group falls back to the plain mean payout
- collapsed and loose rows sort together by each sort key
- collapsing changes neither the row set nor the order of the *uncollapsed*
  remainder
- lock state reflects none / some / all

`App.test.tsx`:

- collapsing a group via the chips row reduces the rendered row count and shows
  the aggregate row; the `▸` button expands it again
- the collapsed row's lock cell toggles every member
- the chart's `groupBars` is unchanged by table collapse, and vice versa
- a re-import clears `tableCollapsed`
- export output is identical with a group collapsed and expanded

`storage.test.ts`:

- a workspace round-trips `tableCollapsed`
- a workspace without it still loads with `[]`
- a non-array or non-string-array `tableCollapsed` is rejected

`README.md` gains the floor, the ordering invariants and ranking, the residual
rule, and the table-collapse control; the ranking comment at the head of
`distribute.ts` is rewritten to the new order.

## Out of scope

- Enforcing the floor or ordering on chart drags (`interact.ts`) or on
  hand-typed weight cells — direct manipulation stays direct.
- Reordering or correcting locked rows.
- Making `ZERO_RESIDUAL_SHARE` or the ordering rule user-configurable; both are
  constants with the rationale recorded above.
- Writing the flattened curvature back into `doc.curve`.
- Marking the residual bucket explicitly as document data — it is detected from
  the label, like the group seeding heuristics.
- Sharing collapse state between the table and the chart.
- Any change to the exported TSV.
