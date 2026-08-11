# Weighted Return Tool

A spreadsheet for distributing weight across slot-engine payout buckets. Paste
the engine's bucket list, set the targets you want, and the tool solves the
weights — then exports a `.tsv` the engine can read back.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Usage](#usage)
- [Bridge](#bridge)
- [Data formats](#data-formats)
  - [Input — what you paste](#input--what-you-paste)
  - [Output — what you export](#output--what-you-export)
- [Getting started](#getting-started)
- [Solving weights](#solving-weights)
  - [The solver](#the-solver)
  - [Tolerance](#tolerance)
  - [Volatility](#volatility)
  - [Weight step](#weight-step)
  - [The targets panel](#the-targets-panel)
- [Editing the table](#editing-the-table)
  - [Keyboard](#keyboard)
  - [In-cell arithmetic](#in-cell-arithmetic)
  - [The totals row](#the-totals-row)
  - [Locks](#locks)
    - [Group locks](#group-locks)
  - [Bucket groups](#bucket-groups)
  - [Columns](#columns)
- [The distribution chart](#the-distribution-chart)
  - [Dragging and setting values on the chart](#dragging-and-setting-values-on-the-chart)
    - [Group bars](#group-bars)
  - [The tooltip, and chart height](#the-tooltip-and-chart-height)
- [Simulation](#simulation)
  - [Convergence mode](#convergence-mode)
  - [Bankroll mode](#bankroll-mode)
- [Workspace](#workspace)
  - [Layout](#layout)
  - [Export](#export)
  - [Persistence](#persistence)
- [Project layout](#project-layout)
- [Tests](#tests)

## Requirements

- Node.js 20.19+ or 22.12+ (Vite 8)
- npm

## Install

```bash
npm install
```

## Usage

```bash
npm run dev        # dev server on http://localhost:5173
npm run build      # typecheck + production build to dist/
npm run preview    # serve the production build
npm test           # vitest, watch mode
npm run test:run   # vitest, single run
npm run lint       # eslint
```

## Bridge

When `tools/auto-scenarios` launches the dev server, it sets four environment
variables (`WRT_BRIDGE_DIR`, `WRT_BRIDGE_FILE`, `WRT_BRIDGE_EXPORT_NAME`,
`WRT_BRIDGE_GAME`) and a Vite plugin (`bridge/`) serves three routes:

- `GET /__bridge/session` → the TSV plus its metadata
- `POST /__bridge/save` → writes one `.tsv` into the bridge directory; `409`
  if it exists and `overwrite` was not `true`
- `POST /__bridge/switch` → re-points the session at another file — or
  another game's directory entirely — and pushes a full page reload

Without those variables the plugin registers nothing, and the tool behaves
exactly as it does when started with a plain `npm run dev`.

The two routes are guarded differently, because they do different things. A
**save** writes, so its filename can only ever name a single `.tsv` directly
inside the nominated directory — separators, traversal, colons, control
characters and non-`.tsv` names are all refused. A **switch** only re-points
the session at something that already exists: its `dir` must be an existing
directory and its `file` an existing `.tsv`, but that file may be any `.tsv`
on disk, anywhere — it is read, never written. What a switch cannot do is
widen what a later save may write: its `exportName` goes through the same
save-path check, so the new session's export stays a single `.tsv` inside the
new `dir`.

## Data formats

### Input — what you paste

Three tab-separated columns, **no header required**:

| # | Column | Notes |
|---|---|---|
| 0 | ID | integer |
| 1 | Avg Payout | float — `50.16` and `0.33` are preserved, never rounded |
| 2 | Label | free text |

```
0	1000.00	joker5-maxwin
1	200.00	joker4-stacks
17	0.33	green-two-only
18	0.00	0x
```

A header row is skipped automatically. Comma-separated and multi-space data
also parse, for pastes that came from somewhere other than a TSV.

### Output — what you export

```
ID	Avg Payout 	Label	Weights	Weighted Value	Chance
0	1000	joker5-maxwin	200	0.1666180697	0.0001666180697
…
			1200350	1.08819261	1
```

Header, one row per bucket in the table's current sort order, then a totals row
with three empty leading fields. Computed columns carry 10 significant digits.

**Weight ID rides as a trailing seventh column, and only when a table uses
one** — a table that leaves the field empty exports exactly the six columns
above, byte for byte. Trailing keeps the first six positional, so an export
with the extra column still pastes back cleanly, Weight IDs included.

**Exports paste straight back in.** The Weights column is picked up, and the
header and totals rows are ignored — so you can export, adjust in Excel, and
paste the result back without editing anything out.

## Getting started

First launch opens the paste screen. `Load sample` builds the table from a
bundled sample (14 buckets); `Paste TSV data` takes your own bucket list
and stays available in the top bar afterwards. `Clear workspace`, at the far
right of the top bar, wipes everything and returns to the paste screen, after
confirming.

## Solving weights

How the tool turns targets into weights, and the knobs that shape the result.

### The solver

`Auto-Distribute` assigns weights to every unlocked bucket. Four controls,
resolved in this order of authority:

1. **Locked rows** are absolute and never move.
2. **Target RTP** is hit exactly, to integer-weight granularity.
3. **Preferred Hit Chance / Win Chance** are met exactly whenever RTP allows,
   otherwise inside a tolerance band.
4. **Volatility** shapes whatever freedom remains.

Steps 3 and 4 can each be **switched off** from the `Solve for` checkboxes.
Off, the fields keep reporting what the table currently achieves — they simply
stop being goals, so everything goes into RTP. With chance targets off the
paying groups are pooled and the curve is free to move mass across the whole
ladder; with volatility off the curvature term is dropped and the tail is a
pure power law (`c = 0`), leaving γ alone to solve RTP.

Hit chance counts buckets paying above `0`; **win chance** counts buckets paying
above `1` — the wins that actually return more than the stake.

The chances are met structurally, by deciding how much of the total weight each
payout group receives:

```
payout == 0      →  1 − hitChance
0 < payout <= 1  →  hitChance − winChance
payout > 1       →  winChance
```

Zero-payout buckets keep their existing relative balance, since they contribute
nothing to RTP and there is no principled curve for a tease bucket.

### Tolerance

Hit and win chance are *preferences* with a relative band, `±3.5%` by default
and editable. The band is spent only when the RTP target is otherwise out of
reach, or when locked weight overruns a group's budget — and then only as far
as needed. In normal use both land exactly on the preferred value; the panel
shows the achieved figure to 3 decimals and flags anything out of band.

### Volatility

Weights follow a curve in log-log space:

```
u     = ln(payout) − ln(smallest positive payout)
share ∝ exp(−γ·u − c·u²)
```

`c` is volatility. The local decay rate is `γ + 2c·u`, so `c` controls how fast
the decay accelerates up the ladder. `γ` is then solved for RTP — and because
slope and curvature are different basis functions, solving one does not cancel
the other.

| Volatility | c | Effect |
|---|---|---|
| very high | 0.00 | pure power law — a straight line on a log-log chart, big payouts stay relatively likely |
| high | 0.035 | |
| medium | 0.09 | |
| low | 0.18 | |
| very low | 0.32 | steep bend — high payouts crushed far harder than mid ones |

On the reference 30-bucket ladder, at a fixed RTP of 0.95 and fixed chances,
the weight in buckets paying 100x or more runs **881 → 768 → 586 → 330 → 103**
from very high to very low.

**Tuning:** the `Curve c` field next to the presets is directly editable, so you
can feel the shape out against the log-log chart. Once you know the values you
want, put them in `CURVE_PRESETS` in `src/lib/types.ts`.

### Weight step

The **Weight step** switch (`free` · `×10` · `×100`) sets the granularity of
every tool-distributed weight: Auto-Distribute, rescaling the total, RTP
retargeting, the chance/value cell solves, and chart drags all land their
results on a multiple of the step. Typed weight cells are never snapped —
type any integer and it sticks.

When the free weight is not a multiple of the step, **Auto-Distribute goes
ahead anyway**: it distributes the divisible part on-step and parks the
leftover on a single bucket, so the grand total stays exact and every other
weight stays clean. The leftover goes to the lowest-payout unlocked bucket,
where it moves the solved RTP least — nowhere at all when there is a 0x
bucket — and a notice says how much went where.

The other step-bound operations — rescaling the total, RTP retargeting, chart
drags — are still blocked rather than fudged: they leave the weights unchanged
and the panel names the nearest totals that would work.

### The targets panel

Everything sits on one wrapping row — Target RTP, Preferred Hit Chance,
Preferred Win Chance, Chance tolerance, Volatility, Curve c, the weight step,
then `Auto-Distribute`, `Group settings` and undo/redo.

The panel **sticks to the top of the viewport** as you scroll, and
**collapses**: the ▾ toggle at its left folds the inputs away, leaving a slim
bar that reads every setting back as `name: value` — RTP, hit, win,
tolerance, volatility, curve and step — alongside the `Auto-Distribute`,
`Group settings`, `Undo` and `Redo` buttons, so you can still act on the
table from the bottom of a long page; only editing the targets needs an
expand. `Group settings` appears in exactly one of the two rows at a time,
never both. The collapsed state is remembered with the workspace. The table
header and the chart panel offset themselves by the panel's measured height,
so nothing slides underneath it.

A target that is switched off greys out and its badge stops being flagged; it
is a readout, not a goal. Every other target shows its achieved value beside it
as a badge, flagged when the solve could not keep it inside the band. Hover a badge for the detail: the
chance badges give the tolerance band, the RTP badge the exact "off by"
figure. The RTP field also carries a small gauge of achieved against target.
The `= current` button under each chance copies the achieved figure into the
target — handy after hand-editing weights, to adopt the current state as the
new goal.

## Editing the table

The grid itself — navigating it, typing arithmetic into it, locking rows,
grouping buckets and shaping the columns around them.

### Keyboard

| Key | Action |
|---|---|
| Arrows | move selection |
| Tab / Shift+Tab | move across, wrapping rows |
| Enter / F2 | start editing |
| Enter *(editing)* | commit and move down |
| Escape | cancel the edit |
| Home / End | first / last cell in the row |
| Ctrl+Home / Ctrl+End | first / last cell in the grid |
| PageUp / PageDown | jump a page |
| Delete / Backspace | clear the cell |
| Space | toggle the lock, on the lock column |
| Ctrl+Z / Ctrl+Y | undo / redo (20 steps) |
| Numpad `.` | always types a decimal point, as in Excel |

The numpad remap covers every numeric field, not just the grid. A comma typed
on the **main** keyboard row keeps its thousands-separator meaning, so
`1,200,350` still pastes and parses as one number.

The table above is the grid's. The chart resize grips carry their own keys —
see [The tooltip, and chart height](#the-tooltip-and-chart-height).

### In-cell arithmetic

Number cells accept `+ - * / ( )`. Two ways in:

- Select a cell showing `200` and type `+500` — the operator **appends**, giving
  `200+500`. Enter → `700`. This is the quick way to nudge a weight.
- Type a digit and it **replaces**, as in any spreadsheet.

A leading `=` is accepted, thousands separators are ignored, and invalid input
reverts the cell rather than silently becoming `0`. The numpad decimal key
always types `.`, even on layouts where it emits a comma — in every numeric
field, not just the grid.

### The totals row

Pinned to the bottom of the table and editable:

- **Weights** — sets the total; unlocked rows rescale proportionally.
- **Weighted Value** — sets RTP; unlocked weights reshape to reach it while hit
  and win chance stay put.
- **Chance** — always `1`.

Total weight is always the sum of the column, so there is no drift to reconcile.
Editing a single bucket's Chance or Weighted Value solves for the weight that
makes the typed figure true *after* the total moves with it.

### Locks

Click the padlock column (or press Space on it) to freeze a row's weight.
Auto-Distribute, rescaling and RTP retargeting all work around locked rows. If
locks overrun a group's share of the total, the panel says so rather than
missing the target silently. A locked row keeps its group color and only
deepens a shade, so the grouping stays readable while rows are pinned.

#### Group locks

Whole groups lock too. A group is locked when every bucket in it is, and the
padlock — in **Group settings** beside each group's name, and on the group's
handle at the chart's right edge — locks or unlocks all of them in one
undoable step. A group with some buckets locked shows a half-lit padlock;
clicking it locks the rest. There is no separate group-level lock: row locks
stay the single thing the solver, the export and the chart all read.

### Bucket groups

Every bucket belongs to a group, and groups drive the chart bar colors, the
table row tints, the chart's group handles and the group sort.

Groups are **detected from the labels once, when data is imported**, then they
are yours. The detector's rules, in priority order:

1. `payout == 0` → the `0x` group, ahead of any name rule, so a
   `joker2-tease` that pays nothing sits with the other duds.
2. label contains `bonus` → the bonus group, case-insensitively.
3. label is a pure range → the wins group (`0-1x`, `8-16x`, `512-1024x`).
4. **shared leading token** → one group per stem with two or more members.
   The stem is the label's first token with any trailing digits cut, so
   `joker5-maxwin`/`joker4-stacks` → `joker`, and equally `lw-8-16`/`lw-16-32`
   → `lw` and `fs-16-32`/`fs-32-64` → `fs`. A stem with one member is no group.
5. anything else → other.

After the import the heuristics never run again, so nothing you do can be
silently undone by them. Change a bucket's group from the **Group** column's
dropdown, and manage the groups themselves from **Group settings** in the
targets panel: add, rename, recolor from a palette of 20 pastels, lock, or
delete. Deleting a group never deletes buckets — they move to the first
remaining group. All of it is undoable and saved with the workspace.

### Columns

The table carries **Group**, **ID**, **Weight ID**, **Avg Payout**, **Label**,
**Weights**, **Weighted Value** and **Chance**, plus the lock toggle. Weight ID
is free text the tool never interprets — somewhere to put your own identifier
when the bucket id is not the one that matters downstream.

Drag a header edge to resize; double-click it to fit the content. Click a header
to sort. Widths persist with the workspace. The defaults are sized to fit the
table in its half of the page; widen the Chance column when you want to read a
chance to its full 15 decimals.

## The distribution chart

The same weights, read as bars — drag or right-click one to change the table,
collapse groups into a single bar, and size the chart to what you're doing.

### Dragging and setting values on the chart

Bars and group handles are draggable: press and move vertically to change the
bucket's weight (weights mode) or chance (% mode). **Drags move by how far the
pointer moves, not to where it is** — the bar never jumps on press, so it can
be grabbed anywhere along its length, and a given pixel distance means the
same thing wherever you grabbed: a constant multiplier on a log Y axis, a
constant amount on a linear one. Escape cancels a drag in flight; a drag
previews live in the table and commits as one undo step on release.

**Right-click a bar or a handle to type an exact value** — a drag cannot land
on 4,200 reliably. The popover pre-fills with the current weight, or the
current percentage in % Chance mode, and accepts arithmetic like the grid
cells do (`4150+50`). It commits through the same machinery a drag does, so
locked rows, the weight step and the grand-total invariant behave identically,
and it lands as one undo step. Enter sets, Escape and click-away cancel.

With **Relative drag** on — the default — the grand total is preserved: other
unlocked buckets absorb the change, and chances keep summing to 1. Switch it
off (weights mode only) to move a single bar and let the total drift. Chance
mode is always relative.

The view has its own controls: **Weights / % Chance** switches the metric,
**Log Y** and **Log X** flip the axes to log scale, and **Aggregate equal
payouts** merges buckets sharing a payout into one bar (the reference data's
two 200x buckets, for instance).

Every group also gets a **handle on the chart's right edge**, sitting at the
height of the group's total in the current metric and axis mode, labelled with
its total and its weighted value. Dragging a handle rescales the whole group
while proportions inside the group are preserved.

Aggregated bars that span several groups draw as stacked segments; a drag
moves all their rows together. Locked rows never move; a fully locked group's
handle is disabled.

#### Group bars

Any group can be **collapsed into a single bar**. The chip row under the
chart controls has one chip per group — click to collapse or expand it, or
use `All` / `None`. Collapsed groups are taken out first and each becomes one
solid bar; whatever is left still aggregates by equal payout as before, so the
two never double-count a bucket.

A group bar sits at the group's **weight-weighted mean payout**,
`Σ(payout × weight) / Σ weight`, so it is placed where the group's mass
actually is and its position against the loose bars still means something. It
is labelled with the group name rather than a payout, and drags and
right-clicks exactly like that group's handle. Its tooltip gives the payout
range, the mean, and the group's weight, chance and weighted value. The chip
row doubles as the chart's legend. Which groups are collapsed is remembered
with the workspace, and reset when new data is imported.

### The tooltip, and chart height

Hovering a bar raises a **tooltip anchored under it**, in two columns: the
buckets in that bar on the left, one per line in its group color, and the
bar's payout, weight, chance and weighted value (its share of RTP) on the
right. Nothing is truncated — a bar holding more labels than fit scrolls the
list slowly, pauses at the bottom, and starts again from the top.

The tooltip floats in a reserved band *below* the plot, at the hovered bar's x.
Below is the only place it can go without hiding data — anywhere inside the
plot covers either the bar it describes or that bar's taller neighbours. Near
an edge it slides just far enough to stay whole, clamped against its own
measured width rather than an assumed one, so a wide tooltip never overhangs
the panel. The band is always in the layout, so a hover never shifts the page.

Both charts can be made **taller**: drag the grip below the tooltip band, or
focus it and use ↑/↓ (16px) or PageUp/PageDown (64px). The distribution chart
defaults to the height of the data table beside it, clamped to 220–900px, so
the two line up with no resizing at all; dragging the grip pins your own
height instead and stops the fitting, and double-clicking the grip — or
pressing Home while it's focused — drops the pin and goes back to fitting the
table. The simulation chart is unchanged: it runs 160–800px, its grip works
before a run too, and Home on it resets to its own fixed default. Both
heights, and whether the distribution chart is pinned, are remembered with the
rest of the workspace.

## Simulation

The Simulation panel, at the bottom of the page, runs the current table in a
Web Worker under one of two modes — `Convergence`, which asks what the table
pays out on average, and `Bankroll`, which asks how long a real balance lasts
on it.

### Convergence mode

Spins the current table for a fixed spin count and reports **RTP, standard
deviation, hit rate, win rate and max win × bet**, live while the run
progresses. Alias-method sampling makes 100M spins take a few seconds without
freezing the page.

The spins field accepts plain numbers or `250k` / `100m` / `1b` shorthand
(default 100,000,000, persisted). The chart stores one point per **0.1% of
the requested spins** — the block's mean payout — and draws the block means,
the cumulative RTP converging on it, and the table's expected RTP as a dashed
reference. The legend states how many spins a block covers, so you can judge
how much smoothing the noise series carries; the tooltip adds the hovered
block's own spin count, which is smaller for the final block when the run does
not divide evenly. Block means that spike above the 95th percentile are pinned
to the top edge and counted in the legend; the tooltip always shows true
values.

The run snapshots the table when Run is clicked, so edits made mid-run don't
bend an in-flight simulation. Cancel keeps the partial statistics.

### Bankroll mode

Plays the table with a real balance rather than an average: start with a
stake, bet a fixed amount every spin, and watch the balance until it runs dry.

Three fields set up the run — **Credits** (default 1,000,000), **Bet**
(default 1) and **RTP×** (default 1) — and all three take `1m` / `250k`
shorthand where a whole number makes sense; Bet and RTP× also take decimals.

The multiplier scales every payout before the run starts, so realised RTP
scales with it exactly: a table paying 0.95 plays at 0.855 under a 0.9
multiplier. Hit rate is untouched — a zero payout stays zero at any
multiplier — but win rate shifts slightly, because a "win" is a payout above 1
and scaling the payouts moves where that boundary falls. The table on screen
is never modified; the multiplier is a property of the run, not an edit.

The run plays until the balance can no longer cover the bet — which is why it
can bust holding change smaller than a single bet — or until it reaches
10,000,000 spins. `Continue` extends the same run rather than starting a new
one: the worker keeps the balance and the PRNG between chunks, so the
continued run is exactly the sequence an uninterrupted one would have
produced, and the chart's x axis just keeps growing. It appears only when a
chunk reached the cap with credit still in the balance — never after a bust.

An effective RTP of 1 or above — the table's RTP times the multiplier — warns
but still runs. Above 1 the balance drifts upward, so a bust becomes very
unlikely; not impossible, since variance can still take down a short
bankroll.

The chart draws the credit balance, with zero always on the axis since
busting is the story, a dashed reference line at the starting credits, and a
marker where the run busted. The stat tiles read **balance, spins survived,
peak, lowest, realised RTP and biggest win**, taken from the running totals
rather than the chart's own points, so peak and lowest stay exact no matter
how much the chart has thinned. Chart resolution starts at one point per 100
spins, and the buffer halves itself once it holds 2,000 points, so a run of
any length draws in a bounded amount of data; points are dropped rather than
averaged, since a balance curve is a random walk and averaging would smooth
away the drawdowns worth seeing.

## Workspace

How the page lays itself out, what leaves it on export, and what survives a
reload.

### Layout

The page runs at 95% of the viewport width with the **table and the
distribution chart side by side**. The table takes exactly the width its
columns need and sits against the right of its half, so the numbers stay next
to the chart they are read against and any slack falls on the left. The chart
takes the rest. The chart panel sticks as you scroll, so the bars stay beside
whichever rows you are editing. Targets sit across the top and the simulation
across the bottom, both full width.

**The bucket table has no scroll box of its own.** However many buckets there
are, it renders every row and grows the page instead — so there is never a
little window to scroll inside a taller page. The header row stays pinned
below the targets panel and the editable totals row to the bottom while you
scroll a long table.

**The chart wraps below the table when it no longer fits beside it** — not at
a fixed breakpoint, but at whatever width the table's own columns imply. Widen
a column and the wrap happens sooner; narrow them and the two stay side by
side for longer. Once wrapped the table centres itself instead, since there is
no chart beside it to sit against. Below 1200px the chart also stops sticking.

Widening a column eats the table's own left-hand slack first: the two panels
split the row by share rather than by content, so the chart only gives up
width once the table genuinely needs more than its half.

The sticky chart is bounded by the table's row, so it follows you down the
table and then stops — it never rides over the simulation panel below.

### Export

The top bar carries two blocks. **Import** holds `Load sample` and
`Paste TSV data`; **Export** holds the editable filename, `Copy TSV` and
`Download .tsv`. `Copy TSV` puts the document on the clipboard;
`Download .tsv` saves it, named `ref-weights-regular.tsv` by default.
`Clear workspace` sits outside both, at the far right, since it destroys the
table.

### Persistence

The table, targets, volatility, weight step, column widths, chart settings,
which groups are collapsed into bars, both chart heights, the groups and
their colors, whether the targets panel is collapsed, export filename and
simulation spin count autosave to `localStorage` and come back on reload.
A workspace saved before groups became data is migrated on load — the
detector seeds it once, exactly as an import would. `Clear workspace`, at the
right of the top bar, wipes it after confirming. Undo history and simulation
results are not persisted.

## Project layout

```
src/
  lib/
    types.ts        row model, targets, volatility presets
    columns.ts      column definitions and shared sorting
    parse.ts        TSV in, including round-tripping our own export
    format.ts       plain-decimal display, 10-sig-digit export
    expr.ts         in-cell arithmetic parser
    distribute.ts   the solver, rescaling, RTP retargeting
    groups.ts       bucket grouping heuristics and colors
    bars.ts         chart bar construction, including collapsed groups
    interact.ts     relative/absolute subset scaling for chart drags
    sim.ts          Monte Carlo core: PRNG, alias sampling, aggregates
    sim.worker.ts   worker shell around sim.ts
    bankroll.ts     the bankroll core: per-spin balance arithmetic and the
                    chart's self-decimating point buffer
    bankroll.worker.ts resumable bankroll worker; retains balance and PRNG
                       between chunks
    exportTsv.ts    TSV out, clipboard, download
    history.ts      bounded undo/redo
    storage.ts      localStorage workspace
    palette.ts      the 20 pastel group colors and their row tints
  components/
    BucketTable.tsx      the grid, totals row, column resizing, group tints
    cells.tsx            cell rendering and edit lifecycle
    numpadDecimal.ts     numpad ',' → '.' remap shared by every numeric input
    useGridNavigation.ts selection and edit state machine
    TargetsPanel.tsx     targets, volatility, weight step, undo
    DistributionChart.tsx draggable bars, group handles
    ChartValueEntry.tsx  right-click popover for an exact weight or chance
    GroupBarChips.tsx    which groups are drawn as a single bar
    SimulationPanel.tsx  mode toggle over the two simulation panels
    ConvergenceSim.tsx  spins, run control, live stats
    BankrollSim.tsx      credits, bet, RTP multiplier, Run/Continue, bankroll stats
    SimChart.tsx         realtime simulation chart
    BankrollChart.tsx    the credit balance chart
    ChartReadout.tsx     the hover tooltip anchored under both charts
    GroupSettings.tsx    add, rename, recolor, lock and delete bucket groups
    ChartResizeGrip.tsx  drag or key a chart taller
    chartUtils.ts        shared axis, width, bar-geometry and height helpers
    RtpGauge.tsx
  App.tsx           document state, undo wiring, drag previews, autosave,
                    the top bar and its export controls
```

## Tests

`src/lib` is covered by Vitest — the solver, parser, formatter, expression
evaluator, grouping rules, drag operations and both simulation cores are
where the real risk is. `bars.ts` carries the chart's construction rules and
is tested directly: group collapse, mean-payout placement, the log-axis zero
drop and the interaction with equal-payout aggregation. `bankroll.ts` is
tested directly too: the balance arithmetic, the bust boundary, `continue`'s
resumability and the point buffer's decimation. The key one is the export
acceptance test, which parses `example-input-data.tsv`, applies the weights
from `example-output-data.tsv`, and asserts the generated text matches the
reference file byte for byte.
Component tests drive the chart's drag interactions, the tooltip's contents,
colors and edge clamping, the resize grip's pointer and keyboard paths, and
both simulation panels against faked workers; the App smoke test covers
grouping, sorting, the targets panel's collapse and the simulation panel end
to end, including switching modes and persisting which one is active.

```bash
npm run test:run
```
