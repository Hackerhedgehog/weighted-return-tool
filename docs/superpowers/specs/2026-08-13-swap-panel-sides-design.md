# Swap panel sides — design

## Problem

The buckets table always renders left of the distribution chart. Users want to
flip the layout (chart left, table right), with the choice persisted, and the
table's column alignment following which side it's on (columns hug the edge
nearest the chart).

## Design

**State**: add `swapped: boolean` to `ChartSettings` (`src/lib/types.ts`),
defaulting to `false` in `DEFAULT_CHART`. Validated in `src/lib/storage.ts`'s
`isChart` the same optional-boolean way `forceStack` is, so older saved
workspaces without the field still load.

**Button**: a "Swap sides" button in the Distribution panel head, next to
"Stack below". Same toggle styling (`primary` class + `aria-pressed` when
`chart.swapped` is true). Click does `setChart({ ...chart, swapped: !chart.swapped })`
— view state, not routed through `commit`/undo history, matching `forceStack`.

**Render order**: in `App.tsx`, the buckets `<section>` and chart `<section>`
are assigned to variables and rendered in `chart.swapped ? [chart, buckets] :
[buckets, chart]` order inside `.content-row`.

**Column alignment**: `.content-row` gets a `swapped` class when active.
`.grid-table`'s default alignment (`margin-left: auto; margin-right: 0`, i.e.
hugging the right edge next to the chart) is overridden by
`.content-row.swapped .grid-table { margin-left: 0; margin-right: auto; }`
when the table is on the right. The existing `.content-row.stacked
.grid-table` centering rule (for when the two panels wrap onto separate
lines) must stay authoritative over the swap rule regardless of swap state —
enforced by declaring the stacked rule after the swapped rule in the
stylesheet (both selectors have equal specificity, so source order decides).

**Positional-assumption fix**: `rowRef`'s `ResizeObserver` callback in
`App.tsx` currently does `const [table, chartPanel] = [...el.children]`,
assuming the table is always the first DOM child. Since swapping changes DOM
order, this is changed to `el.querySelector('.panel.buckets')` /
`el.querySelector('.panel.chart')` so height-matching and stacked-detection
keep working in both orders.

## Testing

- `storage.test.ts`: round-trip `swapped` through save/load, reject a
  non-boolean value, accept a workspace saved before the field existed
  (mirrors the existing `forceStack` tests).
- `App.test.tsx`: clicking "Swap sides" reorders the two panels and toggles
  the alignment class; the setting persists across reload.
