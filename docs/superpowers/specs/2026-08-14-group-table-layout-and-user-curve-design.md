# Group Distribution Table, Dock Layout, Column Toggles and User Curve — Design

Date: 2026-08-14
Status: approved

Sixteen user-requested features, grouped into seven work chunks. All changes live in the
`weighted-return-tool` submodule. The export format is explicitly unchanged throughout.

## 1. Group Distribution table

A new panel showing one row per bucket group, computed by a new pure lib
`src/lib/groupDistribution.ts` from `(rows, grouping, totalWeight)`:

| Column | Definition | Display |
|---|---|---|
| Group | group name | name with color dot, group color |
| Chance % | `groupWeight / totalWeight` | percent, 2 dp; hover tooltip shows 10 dp |
| One in | `1 / chance` | `1/X`, X to 2 dp; `—` when chance is 0 |
| Payout | weight-weighted mean payout `Σ(p·w)/Σw` (plain mean when weightless) — same rule as `tableRows.ts` aggregates | `fmtPayout` |
| Weighted Value | `Σ(p·w) / totalWeight` | `fmtDecimal` |
| RTP Share | weighted value ÷ table RTP | percent, 2 dp; `—` when RTP is 0 |
| STD | within-group weighted payout STD: `sqrt(Σw·p²/Σw − payout²)` (0 for single-value groups) | 2–4 dp |

- Read-only; rows ordered by group rank (no sorting — YAGNI).
- Gear icon top-right toggles column visibility (shared mechanism, §2).
- The panel collapses via a ▾ header toggle like the Targets panel. The Buckets panel
  gets the same collapse toggle. Both collapsed states persist per tab.
- The panel is a dock-layout citizen (§5). Default placement: its own full-width row
  **above** the buckets+chart row.

## 2. Column visibility toggles (buckets + group tables)

- A shared `GearMenu` popover component (button + panel of checkbox/radio rows,
  click-away closes) used by both tables and the distribution chart (§4).
- Persisted per tab as **hidden key lists** (`hiddenBucketColumns?: string[]`,
  `hiddenGroupColumns?: string[]`) so columns added later default to visible.
- `BucketTable` refactor: a `visibleColumns` array (COLUMNS + the two new columns − hidden)
  replaces every hardcoded column index. `cellProps(rowIdx, colIdx)`, `useGridNavigation`
  col counts, `colgroup`, header, body cells, `GroupSummaryRow` and the totals row all
  render from it. Column widths keyed by column key as today.
- New buckets columns, after Chance: **One in** (`1/chance` of the row, 2 dp) and
  **RTP Share** (row weighted value ÷ table RTP, percent). Derived, read-only, sortable
  (One in sorts by weight like chance; RTP Share sorts like weightedValue). Totals row
  shows `1` and `100%`. Group summary rows show the group aggregates for both.
- **Export unchanged**: `buildTsv` never reads column config. Regression test: export
  output is byte-identical with any column set hidden.

## 3. Usage-hint tooltips + Group sort removal

- The inline `.panel-hint` usage texts move into `title` tooltips on each panel `<h2>`
  ("Buckets", "Distribution", "Group Distribution", "Simulation"), styled with a dotted
  underline and `cursor: help`. Texts extended to cover each panel's actual features,
  including "drag this header to move the panel".
- The **Group sort** button in the Buckets panel head is removed — the Group column
  header already sorts.

## 4. Distribution chart: gear menu, X options, diagonal labels

- Gear popover (top-right of the panel head) contains:
  - **Log Y** (moved from inline; default on)
  - **Relative drag** (moved from inline; default on; disabled in chance mode)
  - **X order**: `payout` | `group` (new `ChartSettings.xOrder`, default `payout`).
    Group order = group rank, then payout within group. Only applies when Log X is off
    (control disabled under Log X, since log-X positions are payout-derived).
  - **X labels**: `payout` | `label` (new `ChartSettings.xLabels`, default `payout`).
    Label mode shows the bucket label (single-bucket bars), a count summary for
    aggregated bars, group name for group bars.
  - **Clear saved curve** (visible only when a user curve is saved, §7).
- Metric toggle (Weights/% Chance), Log X, Aggregate equal payouts, Reset view and
  Save curve stay inline.
- **Swap sides** and **Stack below** buttons are removed (§5 replaces them).
- X-axis tick labels render at −45° (`transform=rotate`, `textAnchor="end"`); the bottom
  margin grows to fit, and the `labelEvery` thinning divisor shrinks so several times
  more labels fit.

## 5. Dock layout (drag panels, resize, persist)

New pure lib `src/lib/layout.ts` + component `src/components/PanelDock.tsx`.

- Model: `PanelId = 'groupDist' | 'buckets' | 'chart'`;
  `DockLayout = { rows: { panels: { id: PanelId; size: number }[] }[] }` where `size`
  is the panel's fraction of its row (sums to 1 per row; min 0.15). Every panel appears
  exactly once; validation rejects anything else and falls back to the default.
- Default layout: `[[groupDist], [buckets, chart]]`.
- **Drag to move**: pointer-down on a panel's header (not on its buttons) starts a drag
  after a small threshold; a ghost/outline follows the pointer; drop targets are the
  left/right halves of each panel (insert beside it in that row) and the gaps
  above/below rows (own new row). The active drop zone highlights. Drop commits a new
  layout; sizes renormalize. Escape cancels.
- **Resize**: a divider between adjacent panels in a row drags their shared boundary
  (adjusting the two fractions, min 15% each). The chart keeps its existing height grip
  and auto-fit-to-table behavior; tables remain content-height by design (no inner
  scrollboxes — the page grows, header/totals stay sticky).
- **Sticky**: the chart panel keeps `position: sticky` only while it shares a row with
  the buckets table (the current useful case); elsewhere it flows normally.
- **Persistence & migration**: `layout?: DockLayout` on the Workspace, validated on
  load. `ChartSettings.swapped` / `forceStack` stop being written; on load, a workspace
  without `layout` derives one from them (`swapped` → `[[groupDist],[chart, buckets]]`,
  `forceStack` → `[[groupDist],[buckets],[chart]]`). The old width-based auto-wrap is
  replaced by a simple rule: below 1200px viewport width every row stacks vertically.
- The rowRef measurement logic in App.tsx (stacked detection, table-height fit, chart
  chrome) is adapted to the dock: the chart's auto-fit target is the buckets panel when
  they share a row, otherwise its own pinned height.

## 6. Small items

- `HISTORY_LIMIT` 20 → 100 (`src/lib/history.ts`); README keyboard table updated.
- Undo / Redo buttons removed from TargetsPanel (both expanded and collapsed rows);
  Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y untouched.
- The ⚙ Settings button moves from the targets panel's action group to the top bar,
  beside the Import/Export blocks (rendered whenever the workspace has rows).
- The Settings drawer's priority list reorders by pointer drag (a ≡ grab handle per
  row, drag moves the row, drop commits via `onTargets`); the ↑/↓ buttons are removed.

## 7. User curve

### State

- `Doc.userCurve?: Record<string, number> | null` — uid → share of total weight,
  snapshotted by **Save curve** (a button beside Reset view in the chart controls).
  Undoable (lives in Doc, mutations go through `commit`), persisted on the Workspace,
  cleared on new data import (uids change). Saving again overwrites. **Clear saved
  curve** lives in the chart gear menu.
- `Targets.useUserCurve: boolean` (default true) — a new **Solve for: User curve**
  checkbox, enabled only when a curve is saved. The curve is *active* when saved AND
  the checkbox is on.
- New `PriorityKey` `'usercurve'`, label "User curve", default rank 2:
  `DEFAULT_PRIORITY = ['rtp', 'usercurve', 'ordering', 'volatility', 'hit', 'win']`.
  `normalizePriority` inserts missing keys at their default-relative position (not
  appended), so existing saved priorities gain User curve at #2.

### Solver (`solveWeights`)

When the curve is active (new optional `userCurve` argument mapping row index → saved
share; rows without a saved share fall back to their current weight share):

- Paying bands' base shape becomes `savedShare_i · exp(−γ·u_i)` — the saved shape,
  exponentially tilted to hit Target RTP (same mechanism as `retargetRtp`). The
  volatility curvature term is not applied; the Volatility/Curve fields grey out with a
  title explaining the user curve owns the shape while active.
- Zero-payout band splits by saved shares instead of current weights.
- Priority semantics of `usercurve`:
  - **vs RTP**: ranked above → γ = 0, shape exact, RTP miss reported; below (default) →
    tilt solves RTP.
  - **vs Ordering**: ranked above (default) → the ordering ladder is the *saved-share
    order* (descending share), so deliberate inversions like "1x rarer than 2x"
    survive `enforceOrder`; below → the payout ladder is enforced and a notice reports
    that the user curve yielded to ordering.
  - **vs Hit/Win**: ranked above (default) → when the saved curve's band masses and the
    chance targets disagree, the curve's masses win and the chance warning reports the
    yield; below → `massesFor(targets)` wins and the shape holds within each band.
- Warnings name what yielded, in the existing notice style.

### Chart

When a curve is saved (regardless of the solve checkbox), the distribution chart draws
it as a dashed reference line: for each bar, the sum of its member uids' saved shares,
converted to the current metric (share × total for weights; share for chance), plotted
at the bar centres on the current scale. Bars with no saved member data are skipped.

## Persistence summary (new Workspace fields, all optional + validated)

`layout`, `hiddenBucketColumns`, `hiddenGroupColumns`, `groupDistCollapsed`,
`bucketsCollapsed`, `userCurve`; `ChartSettings` gains `xOrder`, `xLabels` (validated,
defaulted); `Targets` gains `useUserCurve`. `swapped`/`forceStack` remain accepted on
disk for migration but are no longer written.

## Testing

- Vitest (lib): groupDistribution stats incl. STD edge cases; layout model ops
  (move/insert/renormalize/validate/migrate); `normalizePriority` default-position
  insertion; solver user-curve paths (shape preserved under tilt, saved-order ladder,
  RTP hit, each priority sacrifice + its warning); export invariance under hidden
  columns; history limit 100.
- Component: gear popovers toggle and persist; BucketTable renders/navigates
  visible-only columns; GroupDistributionTable values and tooltip; priority drag
  reorder; chart gear options; user-curve line rendering; dock drag/drop + divider
  resize (jsdom pointer events); App smoke updated (no Group sort button, Settings in
  top bar, collapse toggles).
- `npm run test:run` and `npm run build` clean at the end of every chunk.

## Work chunks (commit each)

1. Group Distribution lib + panel (collapse for both table panels)
2. Column toggles + new buckets columns (BucketTable refactor, GearMenu)
3. Hint tooltips + Group sort removal
4. Chart gear, X order/labels, diagonal labels
5. Dock layout
6. Small items (history, settings button, priority drag)
7. User curve (solver + chart line + UI)
