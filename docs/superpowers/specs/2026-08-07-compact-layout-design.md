# Compact layout, side-by-side table and chart, numpad decimals — Design

**Date:** 2026-08-07
**Status:** Approved

## Problem

The page wastes width and forces scrolling in the wrong places:

- The table sits in its own 620px-tall scroll box, so a long bucket list is
  read through a letterbox while the page around it stays still.
- Table and chart are stacked, each the full width of a 1600px column, so
  neither is ever on screen with the other.
- The targets panel spends two tall rows on six settings, with number inputs
  stretched to field width for values that are five digits at most.
- Export controls sit at the bottom right of the targets panel, far from the
  Load sample / Paste TSV buttons they belong with.
- Typing `2,5` on the numpad produces `25`: the expression parser strips
  commas as thousands separators, and the numpad decimal key emits a comma.

Plus the weight step switch, already specced separately, needs a home in the
new panel layout.

## Decisions made during brainstorming

1. **Numpad comma** — intercept the key, not the parser. `e.code ===
   'NumpadDecimal'` types a `.` regardless of what the layout emits, exactly
   as Excel does. A comma typed from the main keyboard row still means a
   thousands separator, so `1,200,350` keeps parsing. `expr.ts` is untouched.
2. **Bar geometry** — bars keep spanning the full plot width; the maximum bar
   width and the inter-bar gap shrink. Not a fixed pitch that would leave the
   right of the plot empty.
3. **Chart column** — the Distribution panel sticks to the top of the viewport
   while a long table scrolls past it.
4. **Column widths** — trim the oversized numeric defaults so the table fits
   half the content width on a 1440px screen.

## 1. Top bar

Document-level actions collect in the header:

```
Weighted Return · slot engine bucket weights
        [Load sample] [Paste TSV data] │ [filename.tsv] [Copy TSV] [Download .tsv] │ [Clear workspace]
```

The export group (filename input, `Copy TSV`, `Download .tsv`) and
`Clear workspace` move out of `TargetsPanel` into `App`'s `topbar-actions`,
separated by thin vertical rules. The filename input is 200px wide. The row
wraps below ~1100px.

`TargetsPanel` loses six props: `exportFilename`, `copyState`, `onCopy`,
`onDownload`, `onFilename`, `onClear`.

## 2. Targets panel

Two rows:

| Row | Fields |
|---|---|
| 1 | Target RTP · Preferred Hit Chance · Preferred Win Chance · Chance tolerance · Volatility · Curve c |
| 2 | Weight step · Auto-Distribute + Undo/Redo + bucket count |

Compaction:

- `.panel-num` gets a fixed `width: 88px` instead of `100%` — enough for
  `0.9500`, `3.5%` and `0.09` with room to spare.
- `.target-field` `min-width` 170px → 104px; `.target-field.rtp` 230px → 150px;
  `.targets-row` gap 22px → 16px; panel padding 14px/16px → 10px/14px.
- `.target-field.wide` (Volatility) stops flexing to 340px and sizes to its
  content; the segmented control uses the smaller `seg small` styling.
- `ChanceTarget` drops the inline `band 0.290–0.311` text. The band moves into
  the achieved badge's `title`, so the field is label + input + badge +
  `= current`.
- The RTP field keeps its gauge and its `off by ±…` hint.

## 3. Weight step switch

Per `docs/superpowers/specs/2026-08-06-weight-step-design.md`, unchanged in
substance. Two amendments:

- **Placement:** first field of the second targets row, not next to Curve c.
- **Labels:** `free · ×10 · ×100`.

Everything else stands: every tool-computed weight lands on a multiple of the
step (Auto-Distribute, the total-weight and total-RTP footer edits, typed
chance/value cells, chart drags); typed weight cells are never snapped;
locked weights are never touched and only the free budget must divide;
operations that cannot keep the total on-step block with a notice naming the
nearest compatible totals; the setting is undoable and persisted.

## 4. Layout

```
┌──────────────── targets (spans both) ────────────────┐
┌──── Buckets (1fr) ────┐   ┌─ Distribution (1fr) ─┐ ← sticky
│ every row, no scroll  │   └──────────────────────┘
│                       │
└───────────────────────┘
┌────────────── Simulation (spans both) ───────────────┐
```

- `.app`: `width: 95vw; max-width: none` (was `max-width: 1600px`), still
  centred, padding 0 20px → 0 12px.
- `.content`: `display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)`.
  Targets and Simulation get `grid-column: 1 / -1`.
- Distribution panel: `position: sticky; top: 8px; align-self: start`, so it
  holds its place beside a long table. `align-self: start` is what keeps it at
  its natural height inside the taller grid row.
- Below 1200px the grid collapses to a single column and the sticky is
  dropped, so nothing overlaps on a laptop or tablet.

### The table stops scrolling

`.grid-wrap` loses `max-height: 620px` and `overflow: auto` for
`overflow: visible`. Consequences, all wanted:

- The table renders at full height and the *page* scrolls.
- `thead th` (`position: sticky; top: 0`) and `.totals-row td`
  (`position: sticky; bottom: 0`) now resolve against the viewport rather than
  the dead scroll box, so on a long table the header stays pinned at the top
  and the editable totals row stays reachable at the bottom while scrolling.
- `.panel` keeps `overflow: hidden` everywhere except the buckets panel, which
  gets `overflow: visible` so a manually over-widened table is not clipped —
  it overflows into the page's own horizontal scroll instead. The cost is
  square bottom corners on that one panel.

### Column widths

Defaults trim to 712px total so the table fits its half at 1440px viewport
width (95vw ÷ 2 ≈ 684px + the panel's own borders; wider screens have slack):

| Column | Was | Now |
|---|---|---|
| lock | 34 | 34 |
| ID | 62 | 62 |
| Avg Payout | 110 | 92 |
| Label | 190 | 150 |
| Weights | 118 | 118 |
| Weighted Value | 152 | 124 |
| Chance | 200 | 132 |

Chance still shows ~15 characters, enough for the values that matter; the
column is resizable and double-click auto-fit still expands it on demand.
Saved workspaces keep their stored widths — the merge over `DEFAULT_WIDTHS`
in `App.tsx` already does that.

## 5. Chart bars

In `DistributionChart.tsx`:

```
linear x:  Math.max(2, Math.min(48, step * 0.72))  →  Math.max(2, Math.min(16, step * 0.86))
log x:     Math.max(2, Math.min(36, gap  * 0.7 ))  →  Math.max(2, Math.min(12, gap  * 0.85))
```

Cap thirds; the gap fraction halves (28% → 14% of the slot, 30% → 15% on log
X). Bars still spread across the whole plot width. `MARGIN.left` 76 → 64 and
`MARGIN.right` 150 → 128 give the narrower pane more plot; the group handle
labels truncate against the shorter margin as they already do.

## 6. Numpad decimal

New module `src/lib/numpad.ts`:

```ts
/** The character a keypress contributes, with numpad-comma read as a point. */
export function numpadChar(e: { code: string; key: string }): string

/**
 * Insert a decimal point at the caret when the numpad decimal key produced
 * something else (a comma, on most non-US layouts). Returns true when it
 * handled the event, having already updated the input in place.
 */
export function applyNumpadDecimal(e: React.KeyboardEvent<HTMLInputElement>): boolean
```

`applyNumpadDecimal` calls `preventDefault()`, splices a `.` over the current
selection in `e.currentTarget.value`, and puts the caret after it, so any
selected text is replaced. It declines the event when a modifier is held or
the key already produced a point.

Call sites:

- `cells.tsx` `CellInput` — uncontrolled (`defaultValue`), so `setRangeText`
  alone is enough; `if (applyNumpadDecimal(e)) return` after the existing
  `stopPropagation()`.
- `TargetsPanel` `PanelNumber` — controlled by `draft`; after the helper runs,
  `setDraft(e.currentTarget.value)` re-syncs React with the DOM. Because the
  strings match, React does not re-render a different value and the caret
  stays put.
- `SimulationPanel` spins input — same controlled treatment, so `2.5m` is
  typeable on the numpad.
- `useGridNavigation.handleKeyDown` — the seed character for a typed-into
  selected cell becomes `numpadChar(e)`, so numpad-comma opens the editor with
  `.` rather than `,`.

`expr.ts` is unchanged: a comma reaching the parser is still a thousands
separator.

## Testing

- `numpad.test.ts` — `numpadChar` maps `{code: 'NumpadDecimal', key: ','}` to
  `.` and passes every other key through; `applyNumpadDecimal` inserts at the
  caret, replaces a selection, declines when `e.key` is already `.`, and
  declines with Ctrl held.
- Cell-level test — numpad-comma inside an open weight cell types `.`, and on
  a selected idle cell opens the editor seeded with `.`. Committing `2,5` from
  the numpad yields `2.5`, and a pasted `1,200,350` still yields `1200350`.
- `App.test.tsx` — export buttons and the filename field render in the header
  (outside the targets panel); the buckets panel has no scroll box
  (`.grid-wrap` has no `max-height`).
- Existing suites must keep passing, in particular the export acceptance test
  and the chart drag tests. Bar-width changes are geometry only; the drag
  tests assert weights, not pixels.

## Out of scope

- Reflowing the Simulation panel; it stays full width below the two columns.
- Making the chart grow to match the table's height.
- Making a comma typed on the main keyboard row mean a decimal point.
- Persisting anything new beyond the weight step, which its own spec covers.
