# Simulation chart pan, x-axis zoom, scrollbars, and reset view

Date: 2026-08-12

## Problem

`SimChart` (Convergence mode) and `BankrollChart` (Bankroll mode) both got
y-axis zoom in `2026-08-11-sim-chart-controls-design.md`, via
`ChartYAxisZoom`: `effectiveYMax = autoYMax * yZoom`, with the view always
`[0, effectiveYMax]`. That leaves four gaps:

1. **Zooming in on the y-axis is stuck anchored at 0.** For `SimChart`
   especially, the interesting data (block means, cumulative RTP) sits well
   above 0 and often near `autoYMax`. Zooming in shrinks the *top* of the
   range toward the data but the *bottom* stays pinned at 0 — the visible
   window doesn't recentre, so a tight zoom can crop the very data the user
   zoomed in to see.
2. **There is no x-axis zoom or pan at all.** The x-axis always shows the
   full `[0, requestedSpins]` / `[0, totalSpins]` domain.
3. **No way to tell, or fix, when data sits outside the current view.**
   Zooming in on either axis with no scrollbar or pan gesture leaves no way
   back to a clipped region except undoing the zoom.
4. **No one-step way back to "show me everything."** The existing
   double-click/Home reset on `ChartYAxisZoom` only restores the *default*
   auto-fit view (which, for `SimChart`, still clips spikes to the top edge
   by design) — there's no action that guarantees literally all data is
   visible.

## Design

### 1. View model

Both charts move from one persisted number (`yZoom`) to four
(`xZoom, xPan, yZoom, yPan`) per chart. `zoom` is a span multiplier of an
auto-computed baseline, exactly as today; `pan` is new — a **fraction of
that same baseline**, not a pixel or absolute value, so it scales
automatically as the baseline moves (e.g. `autoYMax` growing during a live
run), the same reason `zoom` is multiplicative rather than absolute.

```
span   = autoMax * zoom
center = autoMax * (0.5 + pan)
viewMin = center - span / 2
viewMax = center + span / 2
```

At `zoom = 1, pan = 0` this reproduces exactly today's view (`[0, autoMax]`)
— no visible change for anyone who never touches the new controls. The
behavioural fix is in what happens *when* zoom changes: zooming in with
`pan` still `0` now shrinks symmetrically around `autoMax / 2` instead of
shrinking toward a 0 anchor, so a tighter zoom keeps the data centred instead
of cropping it against the bottom edge. `pan` lets the user move further
from there.

Implemented as pure helpers in a new `src/components/chartView.ts` (no
React, unit-testable directly):

```ts
export interface ViewRange { min: number; max: number }

export function viewRange(autoMax: number, zoom: number, pan: number): ViewRange

/** Clamp pan so the view never scrolls past [0, fullExtent] on that axis. */
export function clampPanToExtent(autoMax: number, zoom: number, pan: number, fullExtent: number): number

/** Clamp pan so viewMin <= 0 <= viewMax always holds (BankrollChart's y-axis). */
export function clampPanKeepZeroVisible(autoMax: number, zoom: number, pan: number): number

/** Solve the (zoom, pan) that makes viewRange exactly [lo, hi]. */
export function fitZoomPan(autoMax: number, lo: number, hi: number): { zoom: number; pan: number }
```

- **X axis (both charts)**: `autoMax` = `requestedSpins` / `totalSpins` (the
  fixed full domain — this doesn't grow mid-run, unlike `autoYMax`).
  `xPan`/`xZoom` are clamped with `clampPanToExtent` against `[0,
  requestedSpins]` — panning can't scroll past the data's actual edges. New
  `X_ZOOM_RANGE = { min: 0.02, max: 1 }` in `chartUtils.ts`: zooming in is
  nearly unbounded, zooming *out* stops at 1 (the full domain) since there's
  no data beyond the edges to reveal — unlike the y-axis, this range is
  already exact, not a percentile estimate.
- **Y axis, `SimChart`**: `yPan` unclamped beyond the existing
  `Y_ZOOM_RANGE = { min: 0.15, max: 6 }` on zoom — free vertical movement.
- **Y axis, `BankrollChart`**: `yPan` clamped with `clampPanKeepZeroVisible`
  — 0 must stay somewhere within `[viewMin, viewMax]`, preserving "busting is
  the story" without forcing 0 to the exact bottom pixel.

### 2. Reset View

A new button (icon + "Reset view", label per chart e.g. "Reset the
simulation chart's view") next to the existing `ChartResizeGrip`. It computes
the **true** full extent per axis — real min/max across every series,
ignoring `SimChart`'s p95 spike-clip — and calls `fitZoomPan` for both axes:

- X: `fitZoomPan(autoXMax, 0, requestedSpins)` → always `{ zoom: 1, pan: 0 }`
  today (the x-domain is already exact), but expressed the same way for
  symmetry and to stay correct if a future change makes the x baseline an
  estimate too.
- Y, `SimChart`: `fitZoomPan(autoYMax, 0, trueMax)` where `trueMax = max(...points, ...cumulative, expectedRtp)`.
- Y, `BankrollChart`: `fitZoomPan(autoYMax, 0, trueMax)` where
  `trueMax = max(state.peak, startCredits, lastBalance)` — already close to
  today's `autoYMax` since that chart's baseline was never percentile-based,
  so Reset there is a minor no-op in the common case.

This is a one-shot action, not a new default: the unzoomed, unpanned view
(`zoom=1, pan=0`) keeps clipping `SimChart` spikes exactly as it does today.
Reset is the explicit "show me everything" escape hatch.

### 3. New interactions

- **`ChartXAxisZoom.tsx`** (new, mirrors `ChartYAxisZoom.tsx` exactly —
  wheel/drag/keyboard zoom) rendered over the bottom x-axis label strip
  (`x: MARGIN.left, y: height - MARGIN.bottom, width: plotW, height:
  MARGIN.bottom`). Horizontal drag zooms (left = zoom out, right = zoom in,
  matching the up/down convention of the y version rotated 90°); wheel same
  as `ChartYAxisZoom`; `aria-orientation="horizontal"`.
- **Middle-mouse drag-pan**: a small hook, `useMiddleDragPan`, attached to
  the existing `.sim-hit` rect in both charts. `onPointerDown` with
  `e.button === 1` (middle) calls `e.preventDefault()` (stops the browser's
  autoscroll cursor) and records the start position + start `xPan`/`yPan`;
  `onPointerMove` converts the pixel delta to a pan-fraction delta
  (`dx / plotW`, `dy / plotH`, sign-flipped for y since screen-down is
  data-down) and calls both `onXPan`/`onYPan`; `onPointerUp`/`onPointerCancel`
  end the drag. Clamped the same way as wheel/drag zoom.
- **Scrollbars**: new `ChartScrollbar.tsx`, one `orientation: 'x' | 'y'`
  component used up to twice per chart (rendered only when that axis's
  `zoom < 1`, i.e. the view is narrower than the full extent — no scrollbar
  clutter at the default view). A thin `<rect>` track plus a draggable thumb;
  thumb size = `zoom` (fraction of the track), thumb position derived from
  `pan` clamped the same way as the drag/wheel handlers. Dragging the thumb
  calls the same `onXPan`/`onYPan` as the other pan gestures — one state,
  three ways to move it (drag-zoom-column, middle-mouse, scrollbar).

### 4. Component changes

- `SimChart.tsx` / `BankrollChart.tsx`: replace the single `yMax`-derived
  `y()` with `viewRange`-derived `y()`/`x()` using both axes' `viewMin`/
  `viewMax`; mount `ChartXAxisZoom` alongside the existing
  `ChartYAxisZoom`; mount up to two `ChartScrollbar`s; wire
  `useMiddleDragPan` onto `.sim-hit`; add the Reset View button.
  `SimChart`'s "N spike blocks pinned" count keeps using the *effective*
  `viewMax` (same reasoning as the existing y-zoom feature — a block that
  only clips because of the current view should count), now also affected by
  `yPan`.
- `SimulationPanel.tsx` / `ConvergenceSim.tsx` / `BankrollSim.tsx` / `App.tsx`:
  each chart's zoom/pan state grows from `(yZoom, onYZoom)` to
  `(xZoom, onXZoom, xPan, onXPan, yZoom, onYZoom, yPan, onYPan)`, threaded the
  same way `yZoom` is today.

### 5. Persistence

`Workspace` (`src/lib/storage.ts`) gains, all optional (same
backward-compatible pattern as `simChartYZoom`):

```ts
simChartXZoom?: number
simChartXPan?: number
simChartYPan?: number
bankrollChartXZoom?: number
bankrollChartXPan?: number
bankrollChartYPan?: number
```

`isWorkspace` accepts `undefined` or a finite number for each. Defaults:
`xZoom`/`yZoom` → `1`, `xPan`/`yPan` → `0` — identical to today's unzoomed
view. All six are clamped on load the same way the existing `yZoom` is
(`clampZoom` for the zoom values; pan values are re-clamped against the
*current* extent on every render anyway, since a resized window or a
different sim run changes what's clampable, so no separate load-time pan
clamp is needed beyond what render already does).

## Testing

vitest + jsdom, in the style of the existing chart tests.

`chartView.ts` (pure functions, no rendering needed):

- `viewRange` reproduces `[0, autoMax]` at `zoom=1, pan=0`
- `viewRange` centres on `autoMax/2` when zoomed in with `pan=0` (the core
  bug fix)
- `clampPanToExtent` prevents `viewMin < 0` or `viewMax > fullExtent`
- `clampPanKeepZeroVisible` prevents `viewMin > 0` and `viewMax < 0`
- `fitZoomPan` round-trips: `viewRange(autoMax, ...fitZoomPan(autoMax, lo, hi))` ≈ `{min: lo, max: hi}`

`ChartXAxisZoom`: same test shapes as the existing `ChartYAxisZoom.test.tsx`
(wheel, drag, keyboard, clamped range), rotated to the horizontal axis.

`SimChart` / `BankrollChart`:

- panning shifts tick labels without changing the zoomed span
- `BankrollChart` panning can't push 0 out of `[viewMin, viewMax]`
- middle-mouse drag on `.sim-hit` updates both pan values; other mouse
  buttons don't
- a scrollbar renders only when that axis is zoomed in, and dragging its
  thumb updates pan the same as the other gestures
- Reset View sets `zoom`/`pan` such that the view matches the true
  min/max/domain, including previously-clipped spikes on `SimChart`

`storage`:

- a workspace round-trips all six new fields
- a workspace without them still loads (defaults: zoom `1`, pan `0`)
- a non-numeric value for any of the six is rejected by `isWorkspace`

## Out of scope

- Persisting view state per-workspace-*file* rather than per-browser —
  unchanged from the existing zoom feature; still localStorage.
- Any change to `SimChart`'s spike-clipping as the *default* view — only
  the explicit Reset View action bypasses it.
- Pinch-to-zoom / touch gestures — this tool's existing interactions
  (`ChartYAxisZoom`, `ChartResizeGrip`) are pointer/wheel/keyboard only, and
  this feature stays consistent with that.
- Independent x-axis zoom ranges or pan for the two charts to be linked
  together — each chart's view state is independent, as `yZoom` already is.
