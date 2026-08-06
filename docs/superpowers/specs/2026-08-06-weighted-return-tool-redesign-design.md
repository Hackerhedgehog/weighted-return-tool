# Weighted Return Tool — data-format fix, solver, and spreadsheet UX

Date: 2026-08-06

## 1. Context

The tool distributes weight across slot-engine payout buckets and reports the
resulting RTP and per-bucket chance. It currently cannot ingest the real data
at all: the parser expects `ID ⇥ Label ⇥ Payout`, but the engine exports
`ID ⇥ Avg Payout ⇥ Label`, so every row fails the numeric check and the user
gets "Could not parse any rows." The parser also calls `Math.round(payout)`,
which would flatten `50.16` to `50` even if the column order were right.

Beyond the format fix, the tool needs to behave like a spreadsheet (keyboard
navigation, in-cell arithmetic, resizable columns, a totals row), needs a
target-driven distribution solver with lockable rows, and needs a lighter,
denser theme.

Reference files, committed at the repo root:

- `example-input-data.tsv` — what the user pastes in
- `example-output-data.tsv` — what the tool must be able to produce

## 2. Data formats

### 2.1 Input

No header row. Tab-separated. Three columns:

| # | Column | Type |
|---|---|---|
| 0 | ID | integer |
| 1 | Avg Payout | **float** (`1000.00`, `50.16`, `0.33`, `0.00`) |
| 2 | Label | string |

Parsing rules:

1. Split on `\n`, strip a trailing `\r`, drop blank lines.
2. Split each line on `\t`. If that yields fewer than 3 fields, fall back to
   splitting on `,`, then on runs of 2+ spaces.
3. Skip a line (recording it as skipped, not an error) when field 0 is blank
   or does not parse as a finite number. This covers both a header row and the
   totals row of our own export.
4. Field 1 must parse to a finite number `>= 0`; otherwise skip the line.
5. Field 2 is the label and may be empty.
6. **Round-trip support:** if the line has 4+ fields and field 3 parses as a
   finite number `>= 0`, use it as the row's initial weight (rounded to an
   integer). Fields 4 and 5 (`Weighted Value`, `Chance`) are ignored — always
   recomputed.
7. Zero parsed rows is an error surfaced to the user.

Payout is stored as a float. It is never rounded.

**On load:** if any row supplied a weight, keep the supplied weights as-is and
set total weight to their sum. Otherwise run Auto-Distribute using the current
targets.

### 2.2 Output

Matches `example-output-data.tsv` exactly.

Header (note the trailing space after `Avg Payout`, reproduced verbatim):

```
ID⇥Avg Payout ⇥Label⇥Weights⇥Weighted Value⇥Chance
```

One line per bucket, then a totals row whose first three fields are empty:

```
⇥⇥⇥1200350⇥1.08819261⇥1
```

Computed columns are written at **10 significant digits with trailing zeros
trimmed** — the precision present in the reference file (`0.1666180697`,
`0.0002499271046`, and `1.08819261`, which is `1.088192610` trimmed).

### 2.3 Column model

Table column order matches the output file. A lock column is prepended; it is
UI-only and never exported.

| Key | Header | Editable | Notes |
|---|---|---|---|
| `lock` | (icon) | toggle | not exported |
| `id` | ID | yes | integer |
| `payout` | Avg Payout | yes | float |
| `label` | Label | yes | text |
| `weight` | Weights | yes | integer |
| `weightedValue` | Weighted Value | yes | writes back to weight |
| `chance` | Chance | yes | writes back to weight |

The existing `Optional ID` column is removed — it has no counterpart in either
file.

## 3. Number formatting

| Context | Rule | Example |
|---|---|---|
| Chance (display) | plain decimal, up to 15 dp, trailing zeros trimmed, **never** scientific | `0.000166618069702` |
| Weighted Value (display) | same as Chance | `0.166618069702` |
| Avg Payout | shortest round-trip form | `1000`, `18.7`, `0.33`, `0` |
| Weights | integer with `en-US` grouping when idle, raw digits while editing | `1,200,350` |
| Hit / win chance (targets panel) | fixed 3 dp | `0.490` |
| Any computed column (export) | 10 significant digits, trailing zeros trimmed, plain decimal | `0.1666180697` |
| Non-finite | `—` on screen, empty in export | |

Implementation notes:

- Display uses `toFixed(15)` then trims — `toFixed` never emits exponent
  notation, so this is safe down to `1e-15`.
- Export uses `toPrecision(10)`, which **can** emit exponent notation below
  `1e-7`. A `toPlainDecimal` helper expands any exponent form into plain
  decimal digits. This matters: with a large total weight, per-bucket chances
  below `1e-7` are reachable.
- Chance is a fraction on screen, identical to the exported value. Percentages
  appear only in the targets panel hints and on the chart.

## 4. Solver

### 4.1 Targets

| Setting | Default | Units |
|---|---|---|
| Target RTP | `0.95` | fraction (`1` = 100%) |
| Preferred Hit Chance | `0.30` | fraction |
| Preferred Win Chance | `0.12` | fraction |
| Chance tolerance | `3.5` | percent, **relative** |
| Volatility | `medium` | very low / low / medium / high / very high |
| Curve `c` | from volatility | raw curvature, editable |

**RTP is the hard target.** It is almost never changed in practice and the
solver hits it exactly (to integer-weight granularity). The two chance figures
are *preferences* with a tolerance band around them:

```
band(x) = [ x·(1 − τ), x·(1 + τ) ]        τ = tolerance, default 0.035
```

Relative, so a `0.300` hit chance gets `0.290 … 0.311` and a `0.010` win chance
gets `0.0097 … 0.0104` — proportional slack at every magnitude. The band is
clipped to `[0, 1]`, and the win band is additionally clipped to `<= hit`.

Hit and win chance are displayed to **3 decimal places** throughout the targets
panel; that resolution is sufficient to see the band. (The Chance *column* is
unaffected and still shows up to 15 dp.)

Validation: `RTP > 0`, `0 <= win <= hit <= 1`, and tolerance between `0` and
`50` percent (the field is entered in percent; `τ = tolerance / 100`).
Violations disable Auto-Distribute and show an inline message.

Each preference has a `= current` button copying the achieved value in.

**Curve `c`** is set by the volatility preset but is also directly editable, so
the five presets can be tuned in the app rather than in code. Editing it puts
the segmented control into a `custom` state. The value persists with the
workspace. Preset values are a single exported constant table so retuning the
defaults later is a one-line change.

### 4.2 Groups

The chance preferences are satisfied structurally, by deciding how much total
weight each payout group receives:

```
G0: payout == 0        mass = (1 − hit) · T
G1: 0 < payout <= 1    mass = (hit − win) · T
G2: payout > 1         mass = win · T
```

where `T` is total weight. "Win chance" is defined as the summed chance of
buckets with `Avg Payout > 1`, per the requirement.

A single scalar `s ∈ [−1, 1]` slides both chances together across their bands
(`−1` = lower edge, `0` = exactly the preferred values, `+1` = upper edge).
RTP is monotonically increasing in `s`: raising win chance moves mass into
payouts above 1, and raising hit chance moves mass out of the zero group into
payouts above 0.

**The band is spent only when it is needed, and only as much as needed:**

1. Solve at `s = 0`. If the RTP target is reachable there, stop — both chances
   land exactly on the preferred values, which is the best outcome.
2. Otherwise bisect `|s|` (in the direction that helps) for the *smallest*
   magnitude at which the RTP target becomes reachable, then solve `γ`.
3. If the RTP target is still unreachable at the band edge, solve as close as
   possible, report the achieved RTP, and warn.

### 4.3 Shape

**G0** has no principled curve — those buckets contribute nothing to RTP and
are typically hand-tuned tease buckets. Their existing relative weights are
preserved; if all are zero, split equally.

**G1 and G2** share one global curve in log-log space:

```
u_i = ln(payout_i) − ln(p_min)      where p_min = smallest positive payout
raw_i = exp( −γ·u_i − c·u_i² )
```

then normalized *within each group* to that group's mass budget.

- `c` comes from volatility. It is curvature: the local decay rate is
  `γ + 2c·u`, so `c` controls how fast decay accelerates up the ladder.
  `c = 0` is a pure power law — a straight line on a log-log chart, big
  payouts stay relatively likely (high volatility). Large `c` bends the curve
  down so high payouts are crushed far harder than mid payouts (low
  volatility).
- `γ` is solved by bisection so total RTP hits the target. RTP is monotonically
  decreasing in `γ`. Bracket `γ ∈ [−40, 40]`; clamp the target to the range
  achievable at the bracket ends.
- `γ` and `c` are different basis functions, so solving `γ` for RTP does not
  cancel the volatility setting.

Starting curvature values, to be tuned against the real 30-bucket ladder so the
five steps are visibly graded and none degenerates:

| Volatility | c |
|---|---|
| very high | 0.00 |
| high | 0.035 |
| medium | 0.09 |
| low | 0.18 |
| very low | 0.32 |

Numerical care: subtract the maximum exponent before calling `exp`.

At extreme target combinations (very low win chance with high RTP) `γ` can go
negative, producing a hump mid-ladder rather than a monotone decay. That is the
correct answer — a high average win cannot be built from small wins — and is
left as-is rather than special-cased.

### 4.4 Locks

A locked row's weight is immovable. Locked weight is subtracted from its
group's mass budget before solving, and only unlocked rows are assigned:

```
F_g = M_g − L_g      (free budget per group)
```

If `F_g < 0` the group's locked weight already exceeds its mass budget. Before
warning, try the band: if some `s` within `[−1, 1]` gives that group a budget
its locks fit inside, use the smallest such `|s|`. Only if no point in the band
works is `F_g` clamped to 0 and a warning recorded naming the group — never a
silent miss.

When both the RTP shortfall and a lock conflict want the band, the lock
conflict wins: locks are hard, RTP is then solved as close as the remaining
freedom allows and reported.

### 4.5 Integers

Weights are integers.

1. Within each group, round with the largest-remainder method so each group's
   sum is exactly `round(F_g)`. Unlocked buckets in a group get a minimum of 1
   — but only when `round(F_g)` is at least the number of unlocked buckets in
   that group. When the budget is too small to give everyone 1, drop the
   minimum and let largest-remainder assign zeros.
2. Push the total residual `T − ΣL − Σ round(F_g)` onto the unlocked bucket
   with the largest weight, so `Σ weights == T` exactly.
3. **RTP repair:** transfer single weight units between the lowest- and
   highest-payout unlocked buckets *within G2*, which preserves every group sum
   (and therefore hit and win chance), until `|achieved RTP − target|` stops
   improving. Bounded iteration count. Skipped when G2 has fewer than two
   unlocked buckets; the achieved RTP is then reported as-is.

Resulting accuracy, stated in the UI rather than claimed as exact:

- **RTP** — within roughly one weight unit of target (~`1e-9` at a 1.2M total).
- **Hit / win chance** — exactly the preferred value (to `±1/T`) whenever the
  RTP target is reachable there, which is the common case. Otherwise somewhere
  inside the ±3.5% band, shown to 3 dp with its distance from preferred.

### 4.6 Solver output

The solver returns weights plus a status object: achieved RTP, hit chance and
win chance, the band position `s` it settled on, the solved `γ`, and any
warnings. The targets panel shows achieved beside preferred for each, marks
each in-band or out-of-band, and notes when band slack was spent (and why —
RTP shortfall or lock conflict).

### 4.7 Edge cases

- No G2 buckets → win chance target must be 0, else warn.
- No G0 buckets → hit chance target must be 1, else warn.
- No rows → solver is a no-op.
- All rows locked → no-op with a warning.

## 5. Grid interaction

### 5.1 Model

The grid owns `selection: {row, col}` and `editing: boolean`. A non-editing
cell renders as a `div` carrying the roving `tabindex`; an editing cell renders
as an `input`. This split is what makes "selected but not editing" possible,
which the arithmetic behaviour depends on.

The totals row is the last navigable row.

### 5.2 Navigation (selected, not editing)

| Key | Action |
|---|---|
| Arrows | move selection |
| Tab / Shift+Tab | move horizontally, wrapping across rows |
| Enter / F2 | enter edit mode, caret at end |
| Home / End | first / last cell of the row |
| Ctrl+Home / Ctrl+End | first / last cell of the grid |
| PageUp / PageDown | move by one visible page |
| Delete / Backspace | clear cell (`0` for numeric, empty for text) |
| Space | toggle lock, when the lock column is selected |
| Ctrl+Z | undo |
| Ctrl+Y / Ctrl+Shift+Z | redo |
| digit or `.` | start editing, **replacing** content with that character |
| `+` `-` `*` `/` `(` | start editing, **appending** to the current raw value |
| `=` | start editing, content becomes `=` |

The append rule is the requirement's "easy way to just add or subtract":
select a cell showing `200`, type `+500`, press Enter, get `700`.

### 5.3 Editing

| Key | Action |
|---|---|
| Enter | commit, move down |
| Tab / Shift+Tab | commit, move horizontally |
| Up / Down | commit, move vertically |
| Left / Right | move the caret (stay in the cell) |
| Escape | revert, exit edit mode |
| blur | commit |

Live commit-per-keystroke is removed. The current `NumCell` commits on every
change, which would commit `200+` as `200`. Commit happens on Enter or blur.

### 5.4 Arithmetic

A hand-written recursive-descent parser — no `eval`.

```
expr   := term (('+' | '-') term)*
term   := factor (('*' | '/') factor)*
factor := ('+' | '-') factor | number | '(' expr ')'
number := digits ['.' digits] | '.' digits
```

- A leading `=` is stripped, so spreadsheet habits work.
- `,`, `_`, `'` and whitespace are stripped before parsing (thousands
  separators).
- Division by zero, a non-finite result, an empty string, or a parse error all
  count as invalid: the cell reverts to its previous value and flags briefly.
  Nothing silently becomes zero.
- The result is then passed through the cell's own validator (integer, range).

### 5.5 Column resize

Each header has a drag handle on its right edge; `mousedown` starts tracking,
minimum width 48px. Double-clicking a handle auto-fits the column, measuring
rendered display strings with a cached `canvas` `measureText`. Widths are saved
with the workspace (§9) but excluded from undo history (§5.7) — resizing a
column is not an edit.

### 5.6 Totals row

Sticky to the bottom of the table's scroll container.

- **Weights total** — editable. New total `T'`: reject and revert with a
  message if `T' < Σ locked`, since locks alone already exceed it. Otherwise
  scale unlocked weights by `(T' − Σlocked) / Σunlocked`, round, and push the
  residual onto the unlocked bucket with the largest weight. If `Σunlocked` is
  currently 0, split `T' − Σlocked` equally among unlocked rows instead of
  scaling.
- **Weighted Value total (RTP)** — editable. Re-solves to that RTP while
  preserving total weight, locks, **and both currently achieved chances** — it
  never re-opens the tolerance band, so the hit and win figures do not move at
  all when you retype an RTP. This is the common workflow: RTP is the number
  that gets nudged, and the chances should stay put. A single tilt
  `θ` is applied to unlocked G1/G2 buckets as `w_i · exp(θ·u_i)`, renormalized
  within each group to that group's current unlocked mass, with `θ` bisected
  for the target RTP. Only the ladder shape changes. Out-of-range requests are
  clamped and reported. A tilt cannot move a group whose unlocked weights are
  all 0 or which has a single unlocked bucket; in that case the edit is a no-op
  for that group and the achieved RTP is reported as-is.
- **Chance total** — read-only, always `1`.

### 5.7 Undo / redo

A snapshot stack, **20 steps** deep, with `Ctrl+Z` to undo and `Ctrl+Y` or
`Ctrl+Shift+Z` to redo.

A snapshot holds the document: rows (values, weights, lock flags), targets,
tolerance, volatility and curve `c`. View state — column widths, chart toggles,
selection — is excluded, so undo never moves the user's viewport around.

One snapshot is pushed *before* each committed mutation. Because cells commit
on Enter or blur rather than per keystroke, one edit is naturally one history
entry — no debouncing or coalescing needed. Mutations that snapshot: cell
commit, lock toggle, totals-row edit, Auto-Distribute, data load/paste, clear.

The redo stack is discarded on any new mutation. Pushing past 20 drops the
oldest entry.

`Ctrl+Z` is only intercepted when **not** in edit mode; inside an editing cell
it falls through to the browser's native text undo, which is what a user
mid-expression expects.

History is in-memory only and is not persisted.

## 6. Targets panel

Replaces the current stats strip. Contains:

- Volatility segmented control (5 steps + `custom`) with the editable curve `c`
  beside it.
- Target RTP input with its achieved value and delta.
- Preferred Hit Chance / Preferred Win Chance inputs, each showing achieved to
  3 dp, the band it must stay inside, an in-band / out-of-band marker, and a
  `= current` button. Both are fractions with a `%` hint, consistent with the
  Chance column.
- Chance tolerance input (percent, default `3.5`).
- Bucket count.
- `Auto-Distribute` button.
- Undo / Redo buttons, disabled when their stack is empty, so the feature is
  discoverable without knowing the shortcut.
- `Export` split button: `Copy TSV` and `Download .tsv`, with the filename
  field.
- `Clear workspace` button.
- Solver warnings and band-usage notes, when present.

The `RtpGauge` is kept but its hardcoded `0.92–0.98` band becomes a band around
the user's Target RTP, since a fixed band contradicts a user-set target.

## 7. Chart

`DistributionChart` is kept and restyled. Controls and defaults:

| Control | Default |
|---|---|
| Y metric: weights ⇄ % chance | **weights** |
| Y scale: linear ⇄ logarithmic | **logarithmic** |
| X: aggregate equal payouts | **on** |
| X scale: linear ⇄ logarithmic | **linear** |

The log-X toggle is new. On log-log axes the volatility setting is directly
visible: very high volatility renders as a straight line, lower volatility as a
downward bend.

## 8. Export

- `Copy TSV` writes the full document to the clipboard via
  `navigator.clipboard.writeText`, with a `document.execCommand` fallback for
  non-secure contexts.
- `Download .tsv` creates a `Blob` and an object URL, default filename
  **`ref-weights-regular.tsv`**. The filename is editable next to the button
  and persists with the workspace; a missing `.tsv` extension is appended.
- Both produce byte-identical text: header, one line per bucket in current
  table order, then the totals row.

## 9. Persistence

One autosaved workspace in `localStorage` under key
`weighted-return-tool:workspace:v1`:

```
{ version, rows, targets, tolerance, volatility, curve,
  columnWidths, chart, exportFilename }
```

- Written on change, debounced ~300ms, so typing does not thrash storage.
- Read on mount. A parse failure, a `version` mismatch, or a shape that fails
  validation is ignored — the app starts empty rather than crashing on stale
  data. Bad entries are cleared.
- `Clear workspace` wipes storage and returns to the paste screen. It is
  destructive and irreversible, so it asks for confirmation first.
- Undo history is not persisted (§5.7).

## 10. Theme

Light spreadsheet. Replaces the dark gaming treatment: the radial gradients,
the grain overlay, gold accents, and the uppercase display font all go.

- Page background near-white, table surface white.
- Every cell has a full 1px border on all four sides — the grid must read as a
  spreadsheet, not a list.
- Header row: light grey fill, dark text, sticky.
- Alternating row tint, subtle.
- Selected cell: 2px blue outline, drawn inset so it does not shift layout.
- Locked rows: amber tint plus a filled padlock in the lock column.
- Invalid cell: red border, red text, brief flash on rejected input.
- Monospace tabular numerals are kept — they matter for scanning a weight
  column.
- Totals row: heavier top border, bold, grey fill.

## 11. Structure

New files:

| File | Responsibility |
|---|---|
| `src/lib/expr.ts` | arithmetic expression parser/evaluator |
| `src/lib/exportTsv.ts` | build TSV text, copy, download |
| `src/lib/storage.ts` | workspace serialize / validate / load / clear |
| `src/lib/history.ts` | bounded undo/redo stack |
| `src/components/useGridNavigation.ts` | selection/edit state machine, key handling |
| `src/components/TargetsPanel.tsx` | targets, tolerance, volatility, curve, actions, warnings |

Rewritten: `src/lib/parse.ts`, `src/lib/format.ts`, `src/lib/distribute.ts`,
`src/lib/types.ts`, `src/components/BucketTable.tsx`, `src/components/cells.tsx`,
`src/index.css`.

Modified: `src/App.tsx` (state wiring), `src/components/DistributionChart.tsx`
(new toggles, restyle), `src/components/RtpGauge.tsx` (target-relative band).

`BucketRow` gains `locked: boolean`, loses `optionalId`, and `payout` becomes a
float. New types: `Volatility`, `Targets`, `SolverResult`, `ColumnKey`,
`Workspace`.

## 12. Testing

Vitest is added as a dev dependency, with tests over `src/lib` — the solver,
parser, formatter and expression evaluator carry the real risk. No component
tests; the UI is verified by running it.

| Suite | Covers |
|---|---|
| `parse.test.ts` | real input file parses to 30 rows with float payouts intact; header tolerance; totals-row skip; 6-column round-trip picks up weights; comma/space fallbacks; empty input errors |
| `format.test.ts` | no exponent notation anywhere; 15 dp cap; trailing-zero trimming; export precision reproduces specific values from the reference file; `toPlainDecimal` handles `1e-8` |
| `expr.test.ts` | `200+500`; append forms `+500`, `*2`, `/2`; precedence; parens; unary minus; `=` prefix; thousands separators; `/0`, empty, and malformed input all rejected |
| `distribute.test.ts` | chances land exactly on preferred when RTP is reachable; `Σ weights == T` exactly; locks never move; band is spent only when needed and never exceeded; achieved chances always within ±3.5% relative or a warning is raised; locked-over-budget resolved via band, else warned; RTP within tolerance of target; volatility ordering — the top bucket's share decreases monotonically from very high to very low volatility on the real ladder at fixed RTP and win chance |
| `history.test.ts` | 20-step cap drops oldest; redo stack cleared by a new mutation; undo/redo round-trips document state and leaves view state untouched |
| `storage.test.ts` | round-trips a workspace; rejects a bad `version`, malformed JSON, and a wrong-shaped payload without throwing |
| `exportTsv.test.ts` | **acceptance test:** parse `example-input-data.tsv`, apply the weights from `example-output-data.tsv`, export, and assert the text equals `example-output-data.tsv` |

The acceptance test is what turns "should work with this data" into something
demonstrable.

Known risk in that test: whether the reference file's `Weighted Value` total
(`1.08819261`) is the sum of full-precision values rounded to 10 significant
digits, or the sum of the already-rounded column values. Compute both; match
whichever reproduces the file, and record the answer in a comment. Trailing
newline is normalized before comparison.

## 13. Out of scope

Multi-cell selection and range copy/paste, adding or deleting rows, named
workspace profiles, and any server component.
