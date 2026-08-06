# Weighted Return Tool

A spreadsheet for distributing weight across slot-engine payout buckets. Paste
the engine's bucket list, set the targets you want, and the tool solves the
weights — then exports a `.tsv` the engine can read back.

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

**Exports paste straight back in.** The Weights column is picked up, and the
header and totals rows are ignored — so you can export, adjust in Excel, and
paste the result back without editing anything out.

## Features

### The solver

`Auto-Distribute` assigns weights to every unlocked bucket. Four controls,
resolved in this order of authority:

1. **Locked rows** are absolute and never move.
2. **Target RTP** is hit exactly, to integer-weight granularity.
3. **Preferred Hit Chance / Win Chance** are met exactly whenever RTP allows,
   otherwise inside a tolerance band.
4. **Volatility** shapes whatever freedom remains.

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

### Locks

Click the padlock column (or press Space on it) to freeze a row's weight.
Auto-Distribute, rescaling and RTP retargeting all work around locked rows. If
locks overrun a group's share of the total, the panel says so rather than
missing the target silently.

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

### In-cell arithmetic

Number cells accept `+ - * / ( )`. Two ways in:

- Select a cell showing `200` and type `+500` — the operator **appends**, giving
  `200+500`. Enter → `700`. This is the quick way to nudge a weight.
- Type a digit and it **replaces**, as in any spreadsheet.

A leading `=` is accepted, thousands separators are ignored, and invalid input
reverts the cell rather than silently becoming `0`.

### The totals row

Pinned to the bottom of the table and editable:

- **Weights** — sets the total; unlocked rows rescale proportionally.
- **Weighted Value** — sets RTP; unlocked weights reshape to reach it while hit
  and win chance stay put.
- **Chance** — always `1`.

Total weight is always the sum of the column, so there is no drift to reconcile.
Editing a single bucket's Chance or Weighted Value solves for the weight that
makes the typed figure true *after* the total moves with it.

### Columns

Drag a header edge to resize; double-click it to fit the content. Click a header
to sort. Widths persist with the workspace.

### Export

`Copy TSV` puts the document on the clipboard; `Download .tsv` saves it, named
`ref-weights-regular.tsv` by default — the filename field next to the buttons is
editable and remembered.

### Persistence

The table, targets, volatility, column widths, chart settings and export
filename autosave to `localStorage` and come back on reload. `Clear workspace`
wipes it after confirming. Undo history is not persisted.

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
    exportTsv.ts    TSV out, clipboard, download
    history.ts      bounded undo/redo
    storage.ts      localStorage workspace
  components/
    BucketTable.tsx      the grid, totals row, column resizing
    cells.tsx            cell rendering and edit lifecycle
    useGridNavigation.ts selection and edit state machine
    TargetsPanel.tsx     targets, volatility, export, undo
    DistributionChart.tsx
    RtpGauge.tsx
  App.tsx           document state, undo wiring, autosave
```

## Tests

`src/lib` is covered by Vitest — the solver, parser, formatter and expression
evaluator are where the real risk is. The key one is the export acceptance test,
which parses `example-input-data.tsv`, applies the weights from
`example-output-data.tsv`, and asserts the generated text matches the reference
file byte for byte.

```bash
npm run test:run
```
