# Simulation chart Y-zoom, RTP-so-far color, forced stacking, and totals-free export

Date: 2026-08-11

## Problem

Four independent requests:

1. Both simulation charts (`SimChart`'s convergence view, `BankrollChart`'s
   balance view) auto-fit their y-axis to the data. There is no way to zoom in
   on a region of interest or zoom out past the auto-fit range — the axis is
   entirely non-interactive.
2. `SimChart`'s "RTP so far" line (`.sim-cum-path`) shares `var(--series-0)`
   with nothing else in particular; it does not read as the primary signal
   against the noisier block-average series and the dashed reference line.
3. `DistributionChart` and the buckets table share `.content-row`, a flex row
   that wraps the chart below the table only when the two no longer fit
   side by side (`bb2094b`, `129121e`). There is no way to force that wrap —
   e.g. to get a wider distribution chart — while the window is still wide
   enough to fit both.
4. `buildTsv` (`src/lib/exportTsv.ts`) always appends a totals row (blank
   first three fields, then total weight/weighted-value/chance) after the
   bucket rows. The export should carry buckets only.

## Design

### 1. Y-axis zoom (`SimChart` and `BankrollChart`)

Both charts already compute an auto-fit ceiling (`SimChart`: p95 of block
means, cumulative max, and expected RTP; `BankrollChart`: peak balance vs.
start credits) via `niceCeil`. Zoom is layered on top of that, not a
replacement for it:

```
effectiveYMax = autoYMax * zoomFactor
```

`zoomFactor` is clamped to **[0.15, 6]** — zoom in to 15% of the auto range,
or out to 6×. Multiplying the *auto* ceiling (rather than persisting a raw
pixel value) means a zoomed-in view stays anchored to the data's own scale as
a live run adds points — the auto ceiling keeps moving, zoom just rides on
top of it.

New component `src/components/ChartYAxisZoom.tsx`, a sibling to
`ChartResizeGrip.tsx`:

```ts
interface ChartYAxisZoomProps {
  zoom: number
  onZoom: (z: number) => void
  /** Hit-region geometry — the y-axis label column. */
  x: number
  y: number
  width: number
  height: number
}
```

Rendered as an `<rect>` (SVG, matching the crosshair/bar hit-rects already in
these charts) at `x: 0, y: MARGIN.top, width: MARGIN.left, height: plotH`,
`fill: transparent`, `cursor: ns-resize`:

- **Wheel**: `onWheel` (with `preventDefault`) multiplies or divides the
  factor by 1.1 per notch — scroll up (`deltaY < 0`) zooms in.
- **Drag**: `onPointerDown` records `{ startY, startZoom }`; `onPointerMove`
  maps the signed pixel delta exponentially — `startZoom *
  Math.exp(-(startY - clientY) * RATE)` — so dragging up zooms in, dragging
  down zooms out, at a constant *relative* rate per pixel (the same
  "constant multiplier per pixel" convention `DistributionChart`'s log axis
  already uses). `RATE` tuned so roughly 115px doubles/halves the factor.
- **Double-click**: resets the factor to 1 (auto), matching `ChartResizeGrip`'s
  reset gesture.
- **Keyboard**: focusable (`tabIndex={0}`, `role="slider"`,
  `aria-orientation="vertical"`, `aria-valuenow/min/max`), Arrow Up/Down step
  the factor by the same 1.1×, Home resets to 1 — parity with the resize grip
  and the distribution chart's group handles, both already keyboard-operable.

Every move calls `onZoom` directly (no local/prop divergence) — the same
pattern `ChartResizeGrip` uses for height: the factor is owned by the caller,
the component holds only the live pointer session in a ref.

Both charts restructure their existing ceiling `useMemo` into two steps: the
*auto* ceiling (unchanged inputs/logic) and the *effective* `yMax = autoYMax *
zoom`, used everywhere the current `yMax` is used today (axis ticks, `y()`,
paths). `SimChart`'s "N spike blocks pinned to the top edge" count is
recomputed against the *effective* ceiling, so it stays accurate when zoomed
in — a block that only clips after the user zooms in should count. This is
the one place zoom changes something other than the axis scale.

`BankrollChart` gets no equivalent note: its single balance line simply pins
to the top edge when zoomed in past its peak, same as today's untouched
behavior when the balance exceeds the auto ceiling — self-evident since the
zoom was a deliberate action.

### 2. RTP-so-far line color

`.sim-cum-path` (stroke) and `.legend-line.cumulative` (border-color) switch
from `var(--series-0)` to `var(--danger)` (`#cf222e`) — the token the app
already uses for its other danger/attention marks (bankroll bust line and
marker). No new color, no other lines change.

### 3. Force-stack toggle for the distribution chart

`ChartSettings` (`src/lib/types.ts`) gains `forceStack: boolean`, default
`false` in `DEFAULT_CHART`.

A toggle button appears in the Distribution panel's header in `App.tsx`
(next to the "Distribution" `<h2>`), styled like the Buckets panel's existing
`group-sort` button:

```tsx
<button
  type="button"
  className={`btn ${chart.forceStack ? 'primary' : ''}`}
  aria-pressed={chart.forceStack}
  title="Always show the distribution chart below the table"
  onClick={() => setChart({ ...chart, forceStack: !chart.forceStack })}
>
  Stack below
</button>
```

CSS: `.content-row.force-stack > .panel.chart { flex-basis: 100%; min-width:
100%; }` — an oversized flex-basis guarantees the chart panel cannot fit
beside the table regardless of viewport width, forcing the wrap.
`content-row`'s className becomes conditional on `chart.forceStack`.

No change to the existing `rowRef` measurement logic: it already detects a
wrap by comparing `offsetTop` between the table and chart panels and toggles
the `.stacked` class (which centers the table) accordingly. A forced wrap
produces the same differing `offsetTop`s a narrow-viewport wrap would, so
`.stacked` is added automatically — `.force-stack` and `.stacked` are
independent classes doing independent jobs (force the wrap vs. center the
table once wrapped) and never need to coordinate.

### 4. Export: drop the totals row

`buildTsv` stops appending the totals line entirely — it becomes header +
one line per bucket, nothing else. The `totalValue`/`totalChance` reduces and
the `totals` array that build that last line are deleted; `totalWeight`
becomes unused as a *totals-row* input (it stays a parameter — `valueOf`/
`chanceOf` still divide by it per bucket).

This is an intentional, visible change to the exported file's shape, not a
side effect: `exportTsv.test.ts`'s acceptance test currently asserts
`buildTsv(...)` reproduces `example-output-data.tsv` **byte for byte**,
including that file's own trailing totals line. `example-output-data.tsv` is
the engine's reference export, not something this change should edit — it
documents what the engine itself once produced. So the acceptance test
changes to compare against the reference **minus its last line**, and the
dedicated totals-row test (`'writes the totals row with three empty leading
fields'`) is replaced with one asserting the row is simply absent. The
line-count assertion in `'uses CRLF line endings with no trailing newline'`
drops from 32 to 31, and the weight-id test's comment/assertion about "the
totals row" (there is no `lines[3]` once there's no totals row for a
two-bucket table) is corrected to match.

The on-screen totals row in `BucketTable.tsx` (`.totals-row`, the editable
"Total weight / RTP" row at the bottom of the grid) is untouched — it is
interactive UI, not exported data, and this change only touches `buildTsv`.

### 5. State and persistence

Per the earlier discussion: the zoom factors persist (like `chartHeight`),
the force-stack toggle persists (it already lives in the persisted `chart`
settings bag).

- `App` gains `simChartYZoom` and `bankrollChartYZoom` state (default `1`),
  alongside `simChartHeight` / `chartHeight`.
- `SimulationPanel` threads them through to `ConvergenceSim`/`SimChart` and
  `BankrollSim`/`BankrollChart` the same way it already threads
  `chartHeight`/`onChartHeight`.
- `Workspace` (`src/lib/storage.ts`) gains optional `simChartYZoom?: number`
  and `bankrollChartYZoom?: number`. Optional, so a workspace saved before
  this feature still validates and takes the default — the established
  pattern for `simChartHeight` etc.
- `isWorkspace` accepts `undefined` or a finite number for each.
- Both are **clamped to `[0.15, 6]`** on load as well as on every
  wheel/drag/keyboard update, so a hand-edited or corrupted localStorage
  entry cannot produce a degenerate zoom.
- `ChartSettings.forceStack` is validated in `isChart` as
  `v.forceStack === undefined || typeof v.forceStack === 'boolean'` —
  optional for the same backward-compatibility reason.

## Testing

vitest + jsdom, in the style of the existing chart tests.

`ChartYAxisZoom`:

- wheel up/down changes the reported zoom in the expected direction and
  clamps at the `[0.15, 6]` bounds
- a pointer drag upward zooms in, downward zooms out, clamped the same way
- ArrowUp/ArrowDown adjust and clamp; Home and double-click reset to 1

`SimChart`:

- a smaller zoom factor shrinks the effective range (ticks reflect a smaller
  `yMax`) without changing the auto-computed baseline
- the "N spike blocks pinned" count changes when zoom brings additional
  points above the effective ceiling

`BankrollChart`:

- zoom changes the tick labels' `yMax` the same way

`App.test.tsx` has a `page layout` suite asserting `.content-row`'s children
(`git grep -n "page layout" src/App.test.tsx`); add a case there that
clicking the new toggle adds `.force-stack` to `.content-row` and flips the
button's `aria-pressed`. jsdom does not compute real layout, so `rowRef`'s
`offsetTop`-based `.stacked` detection is untestable here and stays
unexercised by this change, same as today.

`storage`:

- a workspace round-trips both zoom factors and `forceStack`
- a workspace without them still loads (defaults applied: zoom `1`,
  `forceStack` `false`)
- a non-numeric zoom or non-boolean `forceStack` is rejected by `isWorkspace`

`exportTsv`:

- the acceptance test compares against `example-output-data.tsv` with its
  trailing totals line stripped
- a new test asserts the last line of `buildTsv(...)` is the last bucket's
  own line, not a totals line, for a small fixed input
- the CRLF/line-count test expects 31 lines (header + 30 buckets), not 32
- the weight-id trailing-column test's "totals row" assertion is corrected
  to check the last *bucket* row instead

## Out of scope

- Persisting zoom or force-stack per-workspace-*file* rather than per-browser
  — localStorage is where all other view state already lives.
- Zoom or pan on the x-axis.
- Changing `BankrollChart`'s lack of a "clipped" note — no note is added for
  it in this pass.
- Editing `example-output-data.tsv` — it is the engine's own reference file,
  not this tool's output, and stays as-is.
- Any change to the on-screen editable totals row in `BucketTable.tsx`.
