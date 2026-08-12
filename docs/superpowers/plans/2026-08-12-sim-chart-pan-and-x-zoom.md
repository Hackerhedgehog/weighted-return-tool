# Simulation chart pan, x-zoom, scrollbars, and reset view — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `SimChart` and `BankrollChart` full 2-axis pan/zoom (wheel, drag, middle-mouse, scrollbars) plus a "reset to fit everything, centered" button, replacing the current y-only, zero-anchored zoom.

**Architecture:** A pure-math module (`chartView.ts`) defines the view model (`viewRange = autoMax * (zoom, pan)`, clamps, fit-solver, scrollbar geometry). A `useChartAxes` hook composes those helpers against each chart's specific baselines/extents and exposes ready-to-render view ranges, clamped pan setters, a reset function, and scrollbar geometry. Two small presentational pieces (`ChartXAxisZoom`, `ChartScrollbar`) and one interaction hook (`useMiddleDragPan`) plug into `SimChart`/`BankrollChart`, which are otherwise unchanged in structure. State ownership and prop-threading (`SimulationPanel` → `ConvergenceSim`/`BankrollSim` → chart, and `App` → `SimulationPanel`) follows the exact pattern the existing `yZoom`/`onYZoom` prop already uses.

**Tech Stack:** React 19, TypeScript, Vite, Vitest + `@testing-library/react` (jsdom), SVG (no chart library).

## Global Constraints

- Every new persisted field is **optional** on `Workspace` and defaults to today's behavior (`zoom: 1, pan: 0`) — a workspace saved before this feature must still load. (Spec §5)
- `pan` is a **fraction of the axis's own auto-baseline** (`autoMax`), never a raw pixel or absolute value, so it stays meaningful as `autoYMax` grows during a live run — same reasoning as the existing multiplicative `zoom`. (Spec §1)
- At `zoom=1, pan=0` every chart's view must be pixel-identical to today's output — this is a correctness invariant, not just a nice-to-have, and every new test that renders at the defaults should assert against today's existing expected values.
- `SimChart`'s spike-clip note continues to count against the *effective* (zoomed) ceiling, now `viewY.max` instead of `yMax`. (Spec §4)
- `BankrollChart`'s y-pan must never let `0` scroll outside `[viewY.min, viewY.max]`. (Spec §1)
- Reset View computes the **true** full extent (real min/max across all series, ignoring `SimChart`'s p95 spike-clip) — it is a distinct action from the default unzoomed view, which keeps clipping spikes exactly as today. (Spec §2)
- `X_ZOOM_RANGE = { min: 0.02, max: 1 }` — x can zoom in almost arbitrarily far but not out past the full domain (unlike y, the x domain is exact, not an estimate). (Spec §1)

---

## File Structure

| File | Responsibility |
|---|---|
| `src/components/chartView.ts` (new) | Pure view-model math: `viewRange`, `clampPanToExtent`, `clampPanKeepZeroVisible`, `fitZoomPan`, `scrollbarGeometry`, `panFromScrollbarStart`. No React. |
| `src/components/chartView.test.ts` (new) | Unit tests for the above. |
| `src/components/useChartAxes.ts` (new) | Hook composing `chartView.ts` against one chart's baselines/extents; returns view ranges, clamped pan setters, `resetView`, scrollbar geometry. |
| `src/components/useChartAxes.test.ts` (new) | `renderHook`-based tests. |
| `src/components/ChartXAxisZoom.tsx` (new) | Wheel/drag/keyboard zoom handle for the x-axis label row — horizontal mirror of `ChartYAxisZoom.tsx`. |
| `src/components/ChartXAxisZoom.test.tsx` (new) | Mirrors `ChartYAxisZoom.test.tsx`. |
| `src/components/ChartScrollbar.tsx` (new) | Draggable track+thumb, one instance per zoomed axis. |
| `src/components/ChartScrollbar.test.tsx` (new) | Drag/geometry tests. |
| `src/components/useMiddleDragPan.ts` (new) | Middle-mouse-button drag-to-pan pointer handlers for a chart's hit-rect. |
| `src/components/useMiddleDragPan.test.ts` (new) | `renderHook`-based tests. |
| `src/components/chartUtils.ts` (modify) | Add `X_ZOOM_RANGE`. |
| `src/components/chartUtils.test.ts` (modify) | Cover `X_ZOOM_RANGE`. |
| `src/components/SimChart.tsx` (modify) | Wire in `useChartAxes`, `ChartXAxisZoom`, `ChartScrollbar` ×2, `useMiddleDragPan`, reset button, clip path. |
| `src/components/SimChart.test.tsx` (modify) | Extend with pan/x-zoom/reset/scrollbar/middle-drag cases. |
| `src/components/BankrollChart.tsx` (modify) | Same as `SimChart.tsx`, with `keepZeroVisible: true`. |
| `src/components/BankrollChart.test.tsx` (modify) | Same additions, plus the zero-visible constraint. |
| `src/components/ConvergenceSim.tsx`, `BankrollSim.tsx`, `SimulationPanel.tsx` (modify) | Thread 6 new props per chart (`xZoom/onXZoom/xPan/onXPan/yPan/onYPan`) the same way `yZoom/onYZoom` already thread. |
| `src/components/SimulationPanel.test.tsx`, `ConvergenceSim.test.tsx`, `BankrollSim.test.tsx` (modify) | Extend prop-plumbing assertions. |
| `src/lib/storage.ts` (modify) | Add 6 optional `Workspace` fields + `isWorkspace` checks. |
| `src/lib/storage.test.ts` (modify) | Round-trip + rejection tests for the 6 fields. |
| `src/App.tsx` (modify) | 6 new `useState`s, snapshot effect deps, props to `SimulationPanel`. |
| `src/index.css` (modify) | `.chart-x-zoom-hit`, `.chart-scrollbar-track`, `.chart-scrollbar-thumb`, `.chart-reset` styles; margin bump already reflected in the chart files. |

---

### Task 1: `chartView.ts` — pure view-model helpers

**Files:**
- Create: `src/components/chartView.ts`
- Test: `src/components/chartView.test.ts`

**Interfaces:**
- Produces: `ViewRange { min: number; max: number }`, `viewRange(autoMax, zoom, pan): ViewRange`, `clampPanToExtent(autoMax, zoom, pan, extentMax): number`, `clampPanKeepZeroVisible(autoMax, zoom, pan): number`, `fitZoomPan(autoMax, lo, hi): { zoom: number; pan: number }`, `scrollbarGeometry(autoMax, zoom, pan, extentMin, extentMax): { size: number; start: number }`, `panFromScrollbarStart(autoMax, zoom, start, extentMin, extentMax): number`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/components/chartView.test.ts
import { describe, it, expect } from 'vitest'
import {
  clampPanKeepZeroVisible,
  clampPanToExtent,
  fitZoomPan,
  panFromScrollbarStart,
  scrollbarGeometry,
  viewRange,
} from './chartView'

describe('viewRange', () => {
  it('reproduces [0, autoMax] at zoom=1, pan=0 — the existing default view', () => {
    expect(viewRange(100, 1, 0)).toEqual({ min: 0, max: 100 })
  })

  it('centres on autoMax/2 when zoomed in with pan=0, instead of anchoring to 0', () => {
    expect(viewRange(100, 0.5, 0)).toEqual({ min: 25, max: 75 })
  })

  it('shifts the center by pan, in autoMax units', () => {
    expect(viewRange(100, 0.5, 0.2)).toEqual({ min: 45, max: 95 })
  })
})

describe('clampPanToExtent', () => {
  it('passes an in-bounds pan through unchanged', () => {
    expect(clampPanToExtent(100, 0.5, 0, 100)).toBe(0)
  })

  it('clamps so viewMin never drops below 0', () => {
    // zoom=0.5 -> span=50; centering at pan=-0.5 would put viewMin at -25
    const pan = clampPanToExtent(100, 0.5, -0.5, 100)
    expect(viewRange(100, 0.5, pan).min).toBeCloseTo(0, 6)
  })

  it('clamps so viewMax never exceeds the extent', () => {
    const pan = clampPanToExtent(100, 0.5, 0.5, 100)
    expect(viewRange(100, 0.5, pan).max).toBeCloseTo(100, 6)
  })

  it('centers exactly when the span is at least as wide as the extent', () => {
    expect(clampPanToExtent(100, 1, 0.3, 100)).toBe(0)
  })
})

describe('clampPanKeepZeroVisible', () => {
  it('passes through a pan that already keeps 0 in view', () => {
    expect(clampPanKeepZeroVisible(100, 1, 0)).toBe(0)
  })

  it('pulls the view back down so 0 stays visible when panned too far up', () => {
    // zoom=0.2 -> span=20; pan=1 would center at 120, putting viewMin at 110
    const pan = clampPanKeepZeroVisible(100, 0.2, 1)
    const v = viewRange(100, 0.2, pan)
    expect(v.min).toBeLessThanOrEqual(0)
    expect(v.max).toBeGreaterThanOrEqual(0)
  })

  it('pulls the view back up so 0 stays visible when panned too far down', () => {
    const pan = clampPanKeepZeroVisible(100, 0.2, -1)
    const v = viewRange(100, 0.2, pan)
    expect(v.min).toBeLessThanOrEqual(0)
    expect(v.max).toBeGreaterThanOrEqual(0)
  })
})

describe('fitZoomPan', () => {
  it('solves the zoom/pan that makes the view exactly [lo, hi]', () => {
    const { zoom, pan } = fitZoomPan(100, 20, 180)
    const v = viewRange(100, zoom, pan)
    expect(v.min).toBeCloseTo(20, 6)
    expect(v.max).toBeCloseTo(180, 6)
  })

  it('returns zoom=1, pan=0 when fitting exactly the auto range', () => {
    expect(fitZoomPan(100, 0, 100)).toEqual({ zoom: 1, pan: 0 })
  })
})

describe('scrollbarGeometry / panFromScrollbarStart', () => {
  it('reports a full-size thumb with no scrolling needed at zoom=1', () => {
    expect(scrollbarGeometry(100, 1, 0, 0, 100)).toEqual({ size: 1, start: 0 })
  })

  it('reports a half-size thumb positioned at the current pan', () => {
    const { size, start } = scrollbarGeometry(100, 0.5, 0, 0, 100)
    expect(size).toBeCloseTo(0.5, 6)
    expect(start).toBeCloseTo(0.25, 6)
  })

  it('round-trips: the pan a given thumb start implies reproduces that start', () => {
    const pan = panFromScrollbarStart(100, 0.5, 0.1, 0, 100)
    const { start } = scrollbarGeometry(100, 0.5, pan, 0, 100)
    expect(start).toBeCloseTo(0.1, 6)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- chartView.test.ts`
Expected: FAIL — `chartView.ts` does not exist yet.

- [ ] **Step 3: Implement `chartView.ts`**

```ts
// src/components/chartView.ts
/**
 * The pan/zoom view model shared by SimChart and BankrollChart.
 *
 * `zoom` is a span multiplier of an axis's own auto-computed baseline
 * (`autoMax`) — unchanged from the y-only zoom this extends. `pan` is new:
 * a *fraction of that same baseline*, not a pixel or absolute value, so it
 * scales automatically as the baseline moves (autoYMax grows during a live
 * run) — the same reason zoom is multiplicative rather than absolute.
 *
 *   span   = autoMax * zoom
 *   center = autoMax * (0.5 + pan)
 *   view   = [center - span/2, center + span/2]
 *
 * At zoom=1, pan=0 this is exactly [0, autoMax] — today's default view.
 * Zooming in with pan=0 shrinks symmetrically around autoMax/2 instead of
 * toward a 0 anchor, which is the fix for "zooming in only shows the
 * bottom." Every clamp below operates on `pan` only — `zoom` is bounded by
 * the callers' own Y_ZOOM_RANGE/X_ZOOM_RANGE.
 */

export interface ViewRange {
  min: number
  max: number
}

export function viewRange(autoMax: number, zoom: number, pan: number): ViewRange {
  const span = autoMax * zoom
  const center = autoMax * (0.5 + pan)
  return { min: center - span / 2, max: center + span / 2 }
}

/** The pan that puts the view's center at `center`, in autoMax units. */
function panForCenter(autoMax: number, center: number): number {
  return center / autoMax - 0.5
}

/**
 * Clamp `pan` so the view never scrolls past `[0, extentMax]` on this axis.
 * When the span is at least as wide as the extent, there is no valid
 * position that satisfies both edges — center exactly instead.
 */
export function clampPanToExtent(
  autoMax: number,
  zoom: number,
  pan: number,
  extentMax: number,
): number {
  const span = autoMax * zoom
  if (span >= extentMax) return panForCenter(autoMax, extentMax / 2)
  const center = autoMax * (0.5 + pan)
  const clampedCenter = Math.min(Math.max(center, span / 2), extentMax - span / 2)
  return panForCenter(autoMax, clampedCenter)
}

/** Clamp `pan` so 0 stays within [viewMin, viewMax] — BankrollChart's y-axis. */
export function clampPanKeepZeroVisible(autoMax: number, zoom: number, pan: number): number {
  const half = (autoMax * zoom) / 2
  const center = autoMax * (0.5 + pan)
  const clampedCenter = Math.min(Math.max(center, -half), half)
  return panForCenter(autoMax, clampedCenter)
}

/** The (zoom, pan) that makes `viewRange(autoMax, zoom, pan)` exactly `[lo, hi]`. */
export function fitZoomPan(autoMax: number, lo: number, hi: number): { zoom: number; pan: number } {
  return { zoom: (hi - lo) / autoMax, pan: panForCenter(autoMax, (lo + hi) / 2) }
}

/** Scrollbar thumb size/position (0..1 track fractions) for the current view. */
export function scrollbarGeometry(
  autoMax: number,
  zoom: number,
  pan: number,
  extentMin: number,
  extentMax: number,
): { size: number; start: number } {
  const { min, max } = viewRange(autoMax, zoom, pan)
  const extent = extentMax - extentMin
  const size = Math.min(1, (max - min) / extent)
  const start = Math.min(1 - size, Math.max(0, (min - extentMin) / extent))
  return { size, start }
}

/** Inverse of scrollbarGeometry: the pan value that puts the thumb at `start`. */
export function panFromScrollbarStart(
  autoMax: number,
  zoom: number,
  start: number,
  extentMin: number,
  extentMax: number,
): number {
  const extent = extentMax - extentMin
  const span = autoMax * zoom
  const viewMin = extentMin + start * extent
  return panForCenter(autoMax, viewMin + span / 2)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- chartView.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/components/chartView.ts src/components/chartView.test.ts
git commit -m "feat: add pan/zoom view-model math for the simulation charts

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `X_ZOOM_RANGE` in `chartUtils.ts`

**Files:**
- Modify: `src/components/chartUtils.ts`
- Modify: `src/components/chartUtils.test.ts`

**Interfaces:**
- Produces: `X_ZOOM_RANGE: YZoomRange` (same shape as the existing `Y_ZOOM_RANGE`).

- [ ] **Step 1: Write the failing test**

Add to `src/components/chartUtils.test.ts`, inside a new `describe`:

```ts
describe('X_ZOOM_RANGE', () => {
  it('allows zooming in close to nothing but not zooming out past the full domain', () => {
    expect(clampZoom(0.5, X_ZOOM_RANGE)).toBe(0.5)
    expect(clampZoom(0.001, X_ZOOM_RANGE)).toBe(X_ZOOM_RANGE.min)
    expect(clampZoom(5, X_ZOOM_RANGE)).toBe(X_ZOOM_RANGE.max)
    expect(X_ZOOM_RANGE.max).toBe(1)
  })
})
```

Add `X_ZOOM_RANGE` to the existing import line at the top of the file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- chartUtils.test.ts`
Expected: FAIL — `X_ZOOM_RANGE` is not exported yet.

- [ ] **Step 3: Add `X_ZOOM_RANGE`**

In `src/components/chartUtils.ts`, directly below the existing `export const Y_ZOOM_RANGE: YZoomRange = { min: 0.15, max: 6 }` line:

```ts
/**
 * The x-axis domain (0..requestedSpins) is exact, not a percentile estimate
 * like autoYMax — so, unlike Y_ZOOM_RANGE, there is nothing to gain by
 * zooming out past the full domain. Zooming in has effectively no floor.
 */
export const X_ZOOM_RANGE: YZoomRange = { min: 0.02, max: 1 }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- chartUtils.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/chartUtils.ts src/components/chartUtils.test.ts
git commit -m "feat: add X_ZOOM_RANGE for the new x-axis zoom

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: `useChartAxes` hook

**Files:**
- Create: `src/components/useChartAxes.ts`
- Test: `src/components/useChartAxes.test.ts`

**Interfaces:**
- Consumes: `chartView.ts` (Task 1) — `viewRange`, `clampPanToExtent`, `clampPanKeepZeroVisible`, `fitZoomPan`, `scrollbarGeometry`, `panFromScrollbarStart`.
- Produces:

```ts
export interface ChartAxesConfig {
  /** Fixed x-domain width (requestedSpins / totalSpins) — also the x pan-clamp extent. */
  xExtent: number
  xZoom: number
  onXZoom: (z: number) => void
  xPan: number
  onXPan: (p: number) => void
  /** The y-axis's default auto-fit ceiling (may be a percentile estimate, e.g. SimChart's p95). */
  autoYMax: number
  /** The y-axis's TRUE full extent (real max, spikes included) — bounds y pan and drives Reset View. */
  trueYMax: number
  yZoom: number
  onYZoom: (z: number) => void
  yPan: number
  onYPan: (p: number) => void
  /** BankrollChart only: keep 0 inside the visible y-range no matter how the user pans. */
  keepZeroVisible?: boolean
}

export interface ScrollbarState {
  size: number
  start: number
  onScroll: (start: number) => void
}

export interface ChartAxes {
  viewX: { min: number; max: number }
  viewY: { min: number; max: number }
  setXPan: (p: number) => void
  setYPan: (p: number) => void
  resetView: () => void
  xScrollbar: ScrollbarState | null
  yScrollbar: ScrollbarState | null
}

export function useChartAxes(cfg: ChartAxesConfig): ChartAxes
```

- [ ] **Step 1: Write the failing tests**

```ts
// src/components/useChartAxes.test.ts
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { viewRange } from './chartView'
import { useChartAxes, type ChartAxesConfig } from './useChartAxes'

function baseConfig(overrides: Partial<ChartAxesConfig> = {}): ChartAxesConfig {
  return {
    xExtent: 1000,
    xZoom: 1,
    onXZoom: vi.fn(),
    xPan: 0,
    onXPan: vi.fn(),
    autoYMax: 100,
    trueYMax: 100,
    yZoom: 1,
    onYZoom: vi.fn(),
    yPan: 0,
    onYPan: vi.fn(),
    ...overrides,
  }
}

describe('useChartAxes', () => {
  it('matches todays default view at zoom=1, pan=0', () => {
    const { result } = renderHook(() => useChartAxes(baseConfig()))
    expect(result.current.viewX).toEqual({ min: 0, max: 1000 })
    expect(result.current.viewY).toEqual({ min: 0, max: 100 })
  })

  it('reports no scrollbar needed at zoom=1', () => {
    const { result } = renderHook(() => useChartAxes(baseConfig()))
    expect(result.current.xScrollbar).toBeNull()
    expect(result.current.yScrollbar).toBeNull()
  })

  it('reports a scrollbar once an axis is zoomed in', () => {
    const { result } = renderHook(() => useChartAxes(baseConfig({ yZoom: 0.5 })))
    expect(result.current.yScrollbar).not.toBeNull()
    expect(result.current.yScrollbar!.size).toBeCloseTo(0.5, 6)
  })

  it('setYPan clamps to the true extent before calling onYPan', () => {
    const onYPan = vi.fn()
    const { result } = renderHook(() =>
      useChartAxes(baseConfig({ yZoom: 0.2, trueYMax: 100, onYPan })),
    )
    act(() => result.current.setYPan(10)) // wildly out of range
    const [calledWith] = onYPan.mock.calls.at(-1)!
    expect(calledWith).toBeLessThan(10)
  })

  it('setYPan additionally keeps 0 visible when keepZeroVisible is set', () => {
    const onYPan = vi.fn()
    const { result } = renderHook(() =>
      useChartAxes(
        baseConfig({ yZoom: 0.2, autoYMax: 100, trueYMax: 500, keepZeroVisible: true, onYPan }),
      ),
    )
    // pan=1 would center the view at autoYMax*(0.5+1)=150 with a span of
    // only 20 (zoom 0.2 * autoYMax 100) — well clear of 0 if unclamped.
    act(() => result.current.setYPan(1))
    const pan = onYPan.mock.calls.at(-1)![0] as number
    const view = viewRange(100, 0.2, pan)
    expect(view.min).toBeLessThanOrEqual(0)
    expect(view.max).toBeGreaterThanOrEqual(0)
  })

  it('resetView fits the true extent on both axes, centered', () => {
    const onXZoom = vi.fn()
    const onXPan = vi.fn()
    const onYZoom = vi.fn()
    const onYPan = vi.fn()
    const { result } = renderHook(() =>
      useChartAxes(baseConfig({ autoYMax: 50, trueYMax: 200, onXZoom, onXPan, onYZoom, onYPan })),
    )
    act(() => result.current.resetView())
    expect(onXZoom).toHaveBeenCalledWith(1)
    expect(onXPan).toHaveBeenCalledWith(0)
    expect(onYZoom).toHaveBeenCalledWith(4) // 200 / 50
    // fitZoomPan(50, 0, 200): zoom = 200/50 = 4; pan = (0+200)/2/50 - 0.5 = 1.5
    expect(onYPan).toHaveBeenCalledWith(1.5)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- useChartAxes.test.ts`
Expected: FAIL — `useChartAxes.ts` does not exist yet.

- [ ] **Step 3: Implement `useChartAxes.ts`**

```ts
// src/components/useChartAxes.ts
import {
  clampPanKeepZeroVisible,
  clampPanToExtent,
  fitZoomPan,
  panFromScrollbarStart,
  scrollbarGeometry,
  viewRange,
  type ViewRange,
} from './chartView'

/**
 * Composes chartView.ts's pure math against one chart's specific baselines,
 * so SimChart and BankrollChart each get a ready-to-render view without
 * duplicating the clamp/scrollbar wiring between them. See chartView.ts's
 * module doc for the underlying model.
 */

export interface ChartAxesConfig {
  xExtent: number
  xZoom: number
  onXZoom: (z: number) => void
  xPan: number
  onXPan: (p: number) => void
  autoYMax: number
  trueYMax: number
  yZoom: number
  onYZoom: (z: number) => void
  yPan: number
  onYPan: (p: number) => void
  keepZeroVisible?: boolean
}

export interface ScrollbarState {
  size: number
  start: number
  onScroll: (start: number) => void
}

export interface ChartAxes {
  viewX: ViewRange
  viewY: ViewRange
  setXPan: (p: number) => void
  setYPan: (p: number) => void
  resetView: () => void
  xScrollbar: ScrollbarState | null
  yScrollbar: ScrollbarState | null
}

/** No scrollbar clutter once the view is (near enough) the full extent. */
const FULL_SIZE_EPSILON = 0.999

export function useChartAxes(cfg: ChartAxesConfig): ChartAxes {
  const viewX = viewRange(cfg.xExtent, cfg.xZoom, cfg.xPan)
  const viewY = viewRange(cfg.autoYMax, cfg.yZoom, cfg.yPan)

  const setXPan = (p: number) => {
    cfg.onXPan(clampPanToExtent(cfg.xExtent, cfg.xZoom, p, cfg.xExtent))
  }

  const setYPan = (p: number) => {
    const clamped = clampPanToExtent(cfg.autoYMax, cfg.yZoom, p, cfg.trueYMax)
    cfg.onYPan(
      cfg.keepZeroVisible === true
        ? clampPanKeepZeroVisible(cfg.autoYMax, cfg.yZoom, clamped)
        : clamped,
    )
  }

  const resetView = () => {
    const xFit = fitZoomPan(cfg.xExtent, 0, cfg.xExtent)
    cfg.onXZoom(xFit.zoom)
    cfg.onXPan(xFit.pan)
    const yFit = fitZoomPan(cfg.autoYMax, 0, cfg.trueYMax)
    cfg.onYZoom(yFit.zoom)
    cfg.onYPan(yFit.pan)
  }

  const xGeom = scrollbarGeometry(cfg.xExtent, cfg.xZoom, cfg.xPan, 0, cfg.xExtent)
  const yGeom = scrollbarGeometry(cfg.autoYMax, cfg.yZoom, cfg.yPan, 0, cfg.trueYMax)

  const xScrollbar: ScrollbarState | null =
    xGeom.size >= FULL_SIZE_EPSILON
      ? null
      : {
          ...xGeom,
          onScroll: (start) =>
            setXPan(panFromScrollbarStart(cfg.xExtent, cfg.xZoom, start, 0, cfg.xExtent)),
        }

  const yScrollbar: ScrollbarState | null =
    yGeom.size >= FULL_SIZE_EPSILON
      ? null
      : {
          ...yGeom,
          onScroll: (start) =>
            setYPan(panFromScrollbarStart(cfg.autoYMax, cfg.yZoom, start, 0, cfg.trueYMax)),
        }

  return { viewX, viewY, setXPan, setYPan, resetView, xScrollbar, yScrollbar }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- useChartAxes.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/components/useChartAxes.ts src/components/useChartAxes.test.ts
git commit -m "feat: add useChartAxes hook composing the pan/zoom view model

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: `ChartXAxisZoom.tsx`

**Files:**
- Create: `src/components/ChartXAxisZoom.tsx`
- Test: `src/components/ChartXAxisZoom.test.tsx`
- Reference: `src/components/ChartYAxisZoom.tsx` (mirrored exactly, rotated to horizontal)

**Interfaces:**
- Consumes: `clampZoom`, `X_ZOOM_RANGE` from `chartUtils.ts` (Task 2).
- Produces: `ChartXAxisZoom(props: ChartXAxisZoomProps)`, same prop shape as `ChartYAxisZoomProps` (`zoom, onZoom, x, y, width, height, label`).

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/ChartXAxisZoom.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { ChartXAxisZoom } from './ChartXAxisZoom'
import { X_ZOOM_RANGE } from './chartUtils'

afterEach(cleanup)

function ZoomTestWrapper({
  initialZoom,
  onZoomCall,
}: {
  initialZoom: number
  onZoomCall: (z: number) => void
}) {
  const [zoom, setZoom] = useState(initialZoom)
  return (
    <svg>
      <ChartXAxisZoom
        zoom={zoom}
        onZoom={(z) => {
          onZoomCall(z)
          setZoom(z)
        }}
        x={0}
        y={0}
        width={200}
        height={64}
        label="Zoom"
      />
    </svg>
  )
}

function renderZoom(zoom: number) {
  const onZoom = vi.fn()
  render(<ZoomTestWrapper initialZoom={zoom} onZoomCall={onZoom} />)
  return { handle: screen.getByRole('slider', { name: 'Zoom' }), onZoom }
}

const last = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls[fn.mock.calls.length - 1][0] as number

describe('ChartXAxisZoom', () => {
  it('zooms in on wheel-up and out on wheel-down', () => {
    const { handle, onZoom } = renderZoom(1)
    fireEvent.wheel(handle, { deltaY: -100 })
    expect(last(onZoom)).toBeCloseTo(1 / 1.1, 5)
    fireEvent.wheel(handle, { deltaY: 100 })
    expect(last(onZoom)).toBeCloseTo(1, 5)
  })

  it('clamps wheel zoom at the range', () => {
    const { handle, onZoom } = renderZoom(X_ZOOM_RANGE.max)
    fireEvent.wheel(handle, { deltaY: 100 })
    expect(last(onZoom)).toBe(X_ZOOM_RANGE.max)
  })

  it('zooms in when dragged right and out when dragged left', () => {
    const { handle, onZoom } = renderZoom(0.5)
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 200 })
    expect(last(onZoom)).toBeLessThan(0.5)
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 0 })
    expect(last(onZoom)).toBeGreaterThan(0.5)
  })

  it('ignores pointer movement once the drag has ended', () => {
    const { handle, onZoom } = renderZoom(1)
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100 })
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 100 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 0 })
    expect(onZoom).not.toHaveBeenCalled()
  })

  it('resets to 1 on Home and on double-click', () => {
    const { handle, onZoom } = renderZoom(0.3)
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(last(onZoom)).toBe(1)
    fireEvent.doubleClick(handle)
    expect(last(onZoom)).toBe(1)
  })

  it('steps from the keyboard', () => {
    const { handle, onZoom } = renderZoom(0.5)
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(last(onZoom)).toBeCloseTo(0.5 / 1.1, 5)
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(last(onZoom)).toBeCloseTo(0.5, 5)
  })

  it('exposes the current zoom to assistive tech', () => {
    const { handle } = renderZoom(0.5)
    expect(handle.getAttribute('aria-valuenow')).toBe('0.5')
    expect(handle.getAttribute('aria-valuemin')).toBe(String(X_ZOOM_RANGE.min))
    expect(handle.getAttribute('aria-valuemax')).toBe(String(X_ZOOM_RANGE.max))
    expect(handle.getAttribute('aria-orientation')).toBe('horizontal')
    expect(handle.getAttribute('tabindex')).toBe('0')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- ChartXAxisZoom.test.tsx`
Expected: FAIL — `ChartXAxisZoom.tsx` does not exist yet.

- [ ] **Step 3: Implement `ChartXAxisZoom.tsx`**

```tsx
// src/components/ChartXAxisZoom.tsx
import { useEffect, useRef } from 'react'
import { clampZoom, X_ZOOM_RANGE } from './chartUtils'

/**
 * Horizontal mirror of ChartYAxisZoom.tsx — see that file's doc for the
 * rationale (multiplicative zoom, passive:false wheel listener). Rendered
 * over a chart's x-axis label row: scroll or drag horizontally to zoom the
 * x-axis in or out. Dragging right zooms in, left zooms out — the
 * horizontal analogue of the y version's "drag up zooms in."
 */

interface ChartXAxisZoomProps {
  zoom: number
  onZoom: (z: number) => void
  x: number
  y: number
  width: number
  height: number
  label: string
}

const WHEEL_FACTOR = 1.1
const DRAG_HALF_LIFE = 115

export function ChartXAxisZoom({ zoom, onZoom, x, y, width, height, label }: ChartXAxisZoomProps) {
  const drag = useRef<{ startX: number; startZoom: number } | null>(null)
  const ref = useRef<SVGRectElement>(null)

  useEffect(() => {
    const el = ref.current
    if (el === null) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      onZoom(clampZoom(zoom * (e.deltaY < 0 ? 1 / WHEEL_FACTOR : WHEEL_FACTOR), X_ZOOM_RANGE))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoom, onZoom])

  return (
    <rect
      ref={ref}
      className="x-zoom-hit"
      x={x}
      y={y}
      width={Math.max(0, width)}
      height={Math.max(0, height)}
      fill="transparent"
      role="slider"
      aria-label={label}
      aria-orientation="horizontal"
      aria-valuenow={Math.round(zoom * 1000) / 1000}
      aria-valuemin={X_ZOOM_RANGE.min}
      aria-valuemax={X_ZOOM_RANGE.max}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
        drag.current = { startX: e.clientX, startZoom: zoom }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (d === null) return
        const dx = e.clientX - d.startX
        onZoom(clampZoom(d.startZoom * Math.exp((-dx * Math.LN2) / DRAG_HALF_LIFE), X_ZOOM_RANGE))
      }}
      onPointerUp={() => {
        drag.current = null
      }}
      onPointerCancel={() => {
        drag.current = null
      }}
      onDoubleClick={() => onZoom(1)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') {
          e.preventDefault()
          onZoom(clampZoom(zoom / WHEEL_FACTOR, X_ZOOM_RANGE))
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault()
          onZoom(clampZoom(zoom * WHEEL_FACTOR, X_ZOOM_RANGE))
        } else if (e.key === 'Home') {
          e.preventDefault()
          onZoom(1)
        }
      }}
    />
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- ChartXAxisZoom.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/ChartXAxisZoom.tsx src/components/ChartXAxisZoom.test.tsx
git commit -m "feat: add ChartXAxisZoom, the horizontal mirror of ChartYAxisZoom

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: `ChartScrollbar.tsx`

**Files:**
- Create: `src/components/ChartScrollbar.tsx`
- Test: `src/components/ChartScrollbar.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks besides the `size/start` numbers `useChartAxes` (Task 3) will supply at integration time — this component takes them as plain props so it stays independently testable.
- Produces:

```ts
interface ChartScrollbarProps {
  orientation: 'x' | 'y'
  x: number
  y: number
  width: number
  height: number
  size: number
  start: number
  onScroll: (start: number) => void
  label: string
}
export function ChartScrollbar(props: ChartScrollbarProps): JSX.Element
```

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/ChartScrollbar.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChartScrollbar } from './ChartScrollbar'

afterEach(cleanup)

function renderBar(orientation: 'x' | 'y', size: number, start: number) {
  const onScroll = vi.fn()
  render(
    <svg>
      <ChartScrollbar
        orientation={orientation}
        x={0}
        y={0}
        width={orientation === 'x' ? 200 : 6}
        height={orientation === 'x' ? 6 : 200}
        size={size}
        start={start}
        onScroll={onScroll}
        label="Scroll"
      />
    </svg>,
  )
  return { thumb: screen.getByRole('scrollbar', { name: 'Scroll' }), onScroll }
}

const last = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls[fn.mock.calls.length - 1][0] as number

describe('ChartScrollbar', () => {
  it('exposes size/start to assistive tech', () => {
    const { thumb } = renderBar('x', 0.4, 0.1)
    expect(thumb.getAttribute('aria-valuenow')).toBe('0.1')
    expect(thumb.getAttribute('aria-orientation')).toBe('horizontal')
  })

  it('dragging the x thumb right increases start, clamped to 1 - size', () => {
    const { thumb, onScroll } = renderBar('x', 0.4, 0.1)
    fireEvent.pointerDown(thumb, { pointerId: 1, clientX: 0 })
    fireEvent.pointerMove(thumb, { pointerId: 1, clientX: 400 }) // half the 200px-wide, size-0.4 track
    expect(last(onScroll)).toBeCloseTo(0.6, 1) // clamped at 1 - 0.4
  })

  it('dragging the y thumb down increases start, clamped to 1 - size', () => {
    const { thumb, onScroll } = renderBar('y', 0.5, 0)
    fireEvent.pointerDown(thumb, { pointerId: 1, clientY: 0 })
    fireEvent.pointerMove(thumb, { pointerId: 1, clientY: 1000 })
    expect(last(onScroll)).toBeCloseTo(0.5, 1) // clamped at 1 - 0.5
  })

  it('ignores movement once the drag has ended', () => {
    const { thumb, onScroll } = renderBar('x', 0.4, 0.1)
    fireEvent.pointerDown(thumb, { pointerId: 1, clientX: 0 })
    fireEvent.pointerUp(thumb, { pointerId: 1, clientX: 0 })
    fireEvent.pointerMove(thumb, { pointerId: 1, clientX: 400 })
    expect(onScroll).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- ChartScrollbar.test.tsx`
Expected: FAIL — `ChartScrollbar.tsx` does not exist yet.

- [ ] **Step 3: Implement `ChartScrollbar.tsx`**

```tsx
// src/components/ChartScrollbar.tsx
import { useRef } from 'react'

/**
 * A thin draggable track+thumb over a plot's edge, shown only while that
 * axis is zoomed in (its caller, useChartAxes, returns null otherwise).
 * `size`/`start` are 0..1 track fractions — the same units ChartYAxisZoom's
 * `zoom`/pan-derived center would produce, but this component knows nothing
 * about the chart's data units; that translation happens in useChartAxes.
 */

interface ChartScrollbarProps {
  orientation: 'x' | 'y'
  x: number
  y: number
  width: number
  height: number
  size: number
  start: number
  onScroll: (start: number) => void
  label: string
}

export function ChartScrollbar({
  orientation,
  x,
  y,
  width,
  height,
  size,
  start,
  onScroll,
  label,
}: ChartScrollbarProps) {
  const drag = useRef<{ startClient: number; startPos: number } | null>(null)
  const trackLength = orientation === 'x' ? width : height

  const thumbLength = Math.max(4, size * trackLength)
  const thumbOffset = start * trackLength
  const thumbRect =
    orientation === 'x'
      ? { x: x + thumbOffset, y, width: thumbLength, height }
      : { x, y: y + thumbOffset, width, height: thumbLength }

  return (
    <g className="chart-scrollbar">
      <rect className="chart-scrollbar-track" x={x} y={y} width={Math.max(0, width)} height={Math.max(0, height)} />
      <rect
        {...thumbRect}
        className="chart-scrollbar-thumb"
        role="scrollbar"
        aria-label={label}
        aria-orientation={orientation === 'x' ? 'horizontal' : 'vertical'}
        aria-valuenow={Math.round(start * 1000) / 1000}
        aria-valuemin={0}
        aria-valuemax={Math.round((1 - size) * 1000) / 1000}
        tabIndex={0}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
          drag.current = {
            startClient: orientation === 'x' ? e.clientX : e.clientY,
            startPos: start,
          }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (d === null) return
          const client = orientation === 'x' ? e.clientX : e.clientY
          const delta = (client - d.startClient) / Math.max(1, trackLength)
          onScroll(Math.min(1 - size, Math.max(0, d.startPos + delta)))
        }}
        onPointerUp={() => {
          drag.current = null
        }}
        onPointerCancel={() => {
          drag.current = null
        }}
      />
    </g>
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- ChartScrollbar.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/ChartScrollbar.tsx src/components/ChartScrollbar.test.tsx
git commit -m "feat: add ChartScrollbar for panning a zoomed-in axis

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: `useMiddleDragPan` hook

**Files:**
- Create: `src/components/useMiddleDragPan.ts`
- Test: `src/components/useMiddleDragPan.test.ts`

**Interfaces:**
- Produces:

```ts
interface UseMiddleDragPanArgs {
  xZoom: number
  xPan: number
  onXPan: (p: number) => void
  yZoom: number
  yPan: number
  onYPan: (p: number) => void
  plotW: number
  plotH: number
}
interface MiddleDragPanHandlers {
  onPointerDown: (e: React.PointerEvent) => void
  onPointerMove: (e: React.PointerEvent) => void
  onPointerUp: (e: React.PointerEvent) => void
  onPointerCancel: (e: React.PointerEvent) => void
}
export function useMiddleDragPan(args: UseMiddleDragPanArgs): MiddleDragPanHandlers
```

`onXPan`/`onYPan` are expected to already be the *clamped* setters
(`useChartAxes`'s `setXPan`/`setYPan`) — this hook only converts pixels to
pan-fraction deltas, it does no clamping of its own.

- [ ] **Step 1: Write the failing tests**

```ts
// src/components/useMiddleDragPan.test.ts
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useMiddleDragPan } from './useMiddleDragPan'

function fakePointerEvent(overrides: Partial<React.PointerEvent>): React.PointerEvent {
  return {
    button: 1,
    clientX: 0,
    clientY: 0,
    pointerId: 1,
    preventDefault: () => {},
    currentTarget: { setPointerCapture: () => {} },
    ...overrides,
  } as unknown as React.PointerEvent
}

describe('useMiddleDragPan', () => {
  it('ignores non-middle buttons', () => {
    const onXPan = vi.fn()
    const onYPan = vi.fn()
    const { result } = renderHook(() =>
      useMiddleDragPan({ xZoom: 1, xPan: 0, onXPan, yZoom: 1, yPan: 0, onYPan, plotW: 100, plotH: 100 }),
    )
    act(() => result.current.onPointerDown(fakePointerEvent({ button: 0 })))
    act(() => result.current.onPointerMove(fakePointerEvent({ clientX: 50 })))
    expect(onXPan).not.toHaveBeenCalled()
  })

  it('dragging right pans x backward (reveals earlier data)', () => {
    const onXPan = vi.fn()
    const onYPan = vi.fn()
    const { result } = renderHook(() =>
      useMiddleDragPan({ xZoom: 1, xPan: 0, onXPan, yZoom: 1, yPan: 0, onYPan, plotW: 100, plotH: 100 }),
    )
    act(() => result.current.onPointerDown(fakePointerEvent({ clientX: 0, clientY: 0 })))
    act(() => result.current.onPointerMove(fakePointerEvent({ clientX: 50, clientY: 0 })))
    expect(onXPan.mock.calls.at(-1)![0]).toBeLessThan(0)
  })

  it('dragging down pans y forward (reveals higher values)', () => {
    const onXPan = vi.fn()
    const onYPan = vi.fn()
    const { result } = renderHook(() =>
      useMiddleDragPan({ xZoom: 1, xPan: 0, onXPan, yZoom: 1, yPan: 0, onYPan, plotW: 100, plotH: 100 }),
    )
    act(() => result.current.onPointerDown(fakePointerEvent({ clientX: 0, clientY: 0 })))
    act(() => result.current.onPointerMove(fakePointerEvent({ clientX: 0, clientY: 50 })))
    expect(onYPan.mock.calls.at(-1)![0]).toBeGreaterThan(0)
  })

  it('stops updating after pointer up', () => {
    const onXPan = vi.fn()
    const onYPan = vi.fn()
    const { result } = renderHook(() =>
      useMiddleDragPan({ xZoom: 1, xPan: 0, onXPan, yZoom: 1, yPan: 0, onYPan, plotW: 100, plotH: 100 }),
    )
    act(() => result.current.onPointerDown(fakePointerEvent({ clientX: 0 })))
    act(() => result.current.onPointerUp(fakePointerEvent({ clientX: 0 })))
    act(() => result.current.onPointerMove(fakePointerEvent({ clientX: 50 })))
    expect(onXPan).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- useMiddleDragPan.test.ts`
Expected: FAIL — `useMiddleDragPan.ts` does not exist yet.

- [ ] **Step 3: Implement `useMiddleDragPan.ts`**

```ts
// src/components/useMiddleDragPan.ts
import { useRef } from 'react'

/**
 * Middle-mouse-button drag-to-pan for a chart's hit-rect. Converts a pixel
 * delta into a pan-fraction delta using the plot's own pixel dimensions and
 * the axis's current zoom — dragging by one plot-width at zoom=1 pans by
 * exactly one full autoMax; at a tighter zoom the same pixel drag covers
 * proportionally less of the (now zoomed-in) data, matching how the
 * scrollbar thumb and the axis-zoom drag handles already scale with zoom.
 *
 * `preventDefault()` on pointerdown stops the browser's native middle-click
 * autoscroll cursor from appearing over the plot.
 */

interface UseMiddleDragPanArgs {
  xZoom: number
  xPan: number
  onXPan: (p: number) => void
  yZoom: number
  yPan: number
  onYPan: (p: number) => void
  plotW: number
  plotH: number
}

export function useMiddleDragPan({
  xZoom,
  xPan,
  onXPan,
  yZoom,
  yPan,
  onYPan,
  plotW,
  plotH,
}: UseMiddleDragPanArgs) {
  const drag = useRef<{
    startX: number
    startY: number
    startXPan: number
    startYPan: number
  } | null>(null)

  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 1) return
      e.preventDefault()
      ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
      drag.current = { startX: e.clientX, startY: e.clientY, startXPan: xPan, startYPan: yPan }
    },
    onPointerMove: (e: React.PointerEvent) => {
      const d = drag.current
      if (d === null) return
      const dx = e.clientX - d.startX
      const dy = e.clientY - d.startY
      onXPan(d.startXPan - xZoom * (dx / Math.max(1, plotW)))
      onYPan(d.startYPan + yZoom * (dy / Math.max(1, plotH)))
    },
    onPointerUp: () => {
      drag.current = null
    },
    onPointerCancel: () => {
      drag.current = null
    },
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- useMiddleDragPan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/useMiddleDragPan.ts src/components/useMiddleDragPan.test.ts
git commit -m "feat: add middle-mouse drag-to-pan hook for the simulation charts

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Wire `SimChart.tsx`

**Files:**
- Modify: `src/components/SimChart.tsx`
- Modify: `src/components/SimChart.test.tsx`
- Modify: `src/index.css`

**Interfaces:**
- Consumes: `useChartAxes` (Task 3), `ChartXAxisZoom` (Task 4), `ChartScrollbar` (Task 5), `useMiddleDragPan` (Task 6).
- Produces: `SimChartProps` grows by `xZoom, onXZoom, xPan, onXPan, yPan, onYPan` (existing `yZoom, onYZoom` unchanged in name/shape) — this is what Task 8 threads through.

- [ ] **Step 1: Write the failing tests**

Add to `src/components/SimChart.test.tsx`. First, extend `renderSim` to accept the new props (default them to `1`/`0` so every existing call site keeps testing today's default view unchanged):

```tsx
function renderSim(
  height = 260,
  yZoom = 1,
  extra: Partial<{ xZoom: number; xPan: number; yPan: number }> = {},
) {
  const onHeight = vi.fn()
  const onYZoom = vi.fn()
  const onXZoom = vi.fn()
  const onXPan = vi.fn()
  const onYPan = vi.fn()
  render(
    <SimChart
      points={[1.5, 0.5, 1.0]}
      blockSize={400}
      requestedSpins={1000}
      expectedRtp={0.95}
      height={height}
      yZoom={yZoom}
      onYZoom={onYZoom}
      xZoom={extra.xZoom ?? 1}
      onXZoom={onXZoom}
      xPan={extra.xPan ?? 0}
      onXPan={onXPan}
      yPan={extra.yPan ?? 0}
      onYPan={onYPan}
      onHeight={onHeight}
    />,
  )
  return { onHeight, onYZoom, onXZoom, onXPan, onYPan }
}
```

Then add new test cases:

```tsx
describe('SimChart pan and x-zoom', () => {
  it('renders an x-axis zoom handle', () => {
    renderSim()
    expect(screen.getByRole('slider', { name: "Zoom the simulation chart's x-axis" })).toBeDefined()
  })

  it('shows no scrollbars at the default view', () => {
    renderSim()
    expect(document.querySelector('.chart-scrollbar')).toBeNull()
  })

  it('shows a y scrollbar once zoomed in on y', () => {
    renderSim(260, 0.5)
    expect(document.querySelectorAll('.chart-scrollbar')).toHaveLength(1)
  })

  it('renders a reset view button', () => {
    renderSim()
    expect(screen.getByRole('button', { name: /reset/i })).toBeDefined()
  })

  it('reset view fits the true max, including a spike above the p95 ceiling', () => {
    const { onYZoom, onYPan } = (() => {
      const onHeight = vi.fn()
      const onYZoom = vi.fn()
      const onXZoom = vi.fn()
      const onXPan = vi.fn()
      const onYPan = vi.fn()
      render(
        <SimChart
          points={[1.5, 0.5, 1.0, 50]} // 50 is a huge spike, clipped by the p95 ceiling today
          blockSize={400}
          requestedSpins={1000}
          expectedRtp={0.95}
          height={260}
          yZoom={1}
          onYZoom={onYZoom}
          xZoom={1}
          onXZoom={onXZoom}
          xPan={0}
          onXPan={onXPan}
          yPan={0}
          onYPan={onYPan}
          onHeight={onHeight}
        />,
      )
      return { onYZoom, onYPan }
    })()
    fireEvent.click(screen.getByRole('button', { name: /reset/i }))
    // autoYMax is niceCeil-based and much smaller than 50 — resetting must
    // zoom out past today's default ceiling to fit the spike.
    expect(onYZoom.mock.calls.at(-1)![0]).toBeGreaterThan(1)
  })

  it('middle-mouse drag on the plot pans both axes', () => {
    const { onXPan, onYPan } = renderSim()
    const hit = document.querySelector('.sim-hit')!
    fireEvent.pointerDown(hit, { pointerId: 1, button: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(hit, { pointerId: 1, clientX: 50, clientY: 50 })
    expect(onXPan).toHaveBeenCalled()
    expect(onYPan).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- SimChart.test.tsx`
Expected: FAIL — new props aren't accepted, new elements don't exist.

- [ ] **Step 3: Update `SimChart.tsx`**

Apply these changes to `src/components/SimChart.tsx`:

1. Imports — add:

```ts
import { ChartScrollbar } from './ChartScrollbar'
import { ChartXAxisZoom } from './ChartXAxisZoom'
import { useChartAxes } from './useChartAxes'
import { useMiddleDragPan } from './useMiddleDragPan'
```

2. `SimChartProps` (replace the existing `yZoom`/`onYZoom` pair with the full six):

```ts
interface SimChartProps {
  points: number[]
  blockSize: number
  requestedSpins: number
  expectedRtp: number
  height: number
  onHeight: (h: number) => void
  /** Multiplies the auto-fit ceiling; 1 is auto, <1 zooms in, >1 zooms out. */
  yZoom: number
  onYZoom: (z: number) => void
  /** Fraction of the auto-fit ceiling the view is centered away from default; see chartView.ts. */
  yPan: number
  onYPan: (p: number) => void
  xZoom: number
  onXZoom: (z: number) => void
  xPan: number
  onXPan: (p: number) => void
}
```

3. `MARGIN` — widen to reserve scrollbar strips:

```ts
const MARGIN = { top: 14, right: 82, bottom: 52, left: 64 }
```

4. Right after the existing `autoYMax` `useMemo` (which stays exactly as-is —
   it is still the *default* p95-based ceiling), add the true extent and the
   `useChartAxes` call, and replace the old `const yMax = autoYMax * yZoom`
   line and the old `x`/`y` functions:

```ts
  /** The real max across every series — ignores the p95 clip, drives Reset View and the pan bound. */
  const trueYMax = useMemo(() => {
    if (points.length === 0) return niceCeil(expectedRtp * 1.5)
    const dataMax = Math.max(...points, ...cumulative, expectedRtp)
    return niceCeil(Math.max(dataMax, 1e-9))
  }, [points, cumulative, expectedRtp])

  const { viewX, viewY, setXPan, setYPan, resetView, xScrollbar, yScrollbar } = useChartAxes({
    xExtent: requestedSpins,
    xZoom,
    onXZoom,
    xPan,
    onXPan,
    autoYMax,
    trueYMax,
    yZoom,
    onYZoom,
    yPan,
    onYPan,
  })

  const middleDragPan = useMiddleDragPan({
    xZoom,
    xPan,
    onXPan: setXPan,
    yZoom,
    yPan,
    onYPan: setYPan,
    plotW,
    plotH,
  })

  // Recomputed against the *effective* (zoomed+panned) ceiling: a block that
  // only clips once the user zooms/pans should count.
  const clipped = useMemo(() => points.filter((v) => v > viewY.max).length, [points, viewY.max])

  const x = (spins: number) =>
    MARGIN.left + ((spins - viewX.min) / Math.max(1e-9, viewX.max - viewX.min)) * plotW
  const y = (v: number) => {
    const clamped = Math.min(Math.max(v, viewY.min), viewY.max)
    return MARGIN.top + plotH * (1 - (clamped - viewY.min) / Math.max(1e-9, viewY.max - viewY.min))
  }
```

   Delete the old `const yMax = autoYMax * yZoom`, the old `clipped` `useMemo`
   (the one filtering against `yMax`), and the old `x`/`y` function
   definitions — all superseded by the block above.

5. `yTicks`/`xTicks` — rebase on `viewY`/`viewX` instead of `yMax`/`requestedSpins`:

```ts
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
    y: MARGIN.top + plotH * (1 - t),
    label: fmtRtp(viewY.min + t * (viewY.max - viewY.min)),
  }))
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
    x: MARGIN.left + plotW * t,
    label: fmtCompact(viewX.min + t * (viewX.max - viewX.min)),
  }))
```

6. `onMove` — the hover lookup maps pixel → spins using `requestedSpins`
   today; rebase it on `viewX` so hovering stays correct when x is panned/zoomed:

```ts
  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    if (points.length === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    const spins = viewX.min + (px / Math.max(1, plotW)) * (viewX.max - viewX.min)
    let best = 0
    let bestDist = Infinity
    for (let i = 0; i < spinsAt.length; i++) {
      const d = Math.abs(spinsAt[i] - spins)
      if (d < bestDist) {
        bestDist = d
        best = i
      }
    }
    setHover(best)
  }
```

7. Add a clip path so panned-out-of-view path data doesn't bleed into the
   margins, and wrap the two `<path>`s and the crosshair `<line>` in it.
   Right after the opening `<svg ...>` tag:

```tsx
        <defs>
          <clipPath id="sim-chart-plot-clip">
            <rect x={MARGIN.left} y={MARGIN.top} width={Math.max(0, plotW)} height={Math.max(0, plotH)} />
          </clipPath>
        </defs>
```

   Then wrap the existing mean/cumulative paths and crosshair block:

```tsx
        <g clipPath="url(#sim-chart-plot-clip)">
          {points.length > 0 && <path className="sim-mean-path" d={meanPath} />}
          {cumulative.length > 0 && <path className="sim-cum-path" d={cumPath} />}
          {h !== null && (
            <line
              className="sim-crosshair"
              x1={x(spinsAt[h])}
              x2={x(spinsAt[h])}
              y1={MARGIN.top}
              y2={MARGIN.top + plotH}
            />
          )}
        </g>
```

   (Remove the old, unwrapped versions of these three elements.)

8. Middle-drag on the hit-rect — spread `middleDragPan` onto the existing
   `.sim-hit` `<rect>` (which keeps its own `onMouseMove`/`onMouseLeave` for
   the hover crosshair — both sets of handlers coexist on the same element):

```tsx
        <rect
          className="sim-hit"
          x={MARGIN.left}
          y={MARGIN.top}
          width={Math.max(0, plotW)}
          height={plotH}
          fill="transparent"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
          {...middleDragPan}
        />
```

9. Mount `ChartXAxisZoom` next to the existing `ChartYAxisZoom`, and the
   scrollbars after both (so their thumbs sit on top for pointer hit-testing
   — see the plan's design note on this):

```tsx
        <ChartYAxisZoom
          zoom={yZoom}
          onZoom={onYZoom}
          x={0}
          y={MARGIN.top}
          width={MARGIN.left}
          height={plotH}
          label="Zoom the simulation chart's y-axis"
        />
        <ChartXAxisZoom
          zoom={xZoom}
          onZoom={onXZoom}
          x={MARGIN.left}
          y={height - MARGIN.bottom}
          width={plotW}
          height={MARGIN.bottom}
          label="Zoom the simulation chart's x-axis"
        />
        {xScrollbar !== null && (
          <ChartScrollbar
            orientation="x"
            x={MARGIN.left}
            y={height - 24}
            width={plotW}
            height={6}
            size={xScrollbar.size}
            start={xScrollbar.start}
            onScroll={xScrollbar.onScroll}
            label="Scroll the simulation chart horizontally"
          />
        )}
        {yScrollbar !== null && (
          <ChartScrollbar
            orientation="y"
            x={width - 10}
            y={MARGIN.top}
            width={6}
            height={plotH}
            size={yScrollbar.size}
            start={yScrollbar.start}
            onScroll={yScrollbar.onScroll}
            label="Scroll the simulation chart vertically"
          />
        )}
      </svg>
```

10. Reset View button — add to the `.sim-legend` row, after the existing
    `clipped > 0` note:

```tsx
        <button type="button" className="btn chart-reset" onClick={resetView} title="Zoom out to fit all data, centered">
          Reset view
        </button>
      </div>
```

    (This closes the existing `.sim-legend` `<div>` — the button is its last child.)

- [ ] **Step 4: Update `src/index.css`**

Add near the existing `.y-zoom-hit` rules:

```css
.x-zoom-hit {
  cursor: ew-resize;
  touch-action: none;
  outline: none;
}

.x-zoom-hit:focus-visible {
  outline: 2px solid var(--accent-soft);
  outline-offset: -2px;
}

.chart-scrollbar-track {
  fill: var(--line);
}

.chart-scrollbar-thumb {
  fill: var(--line-strong);
  cursor: grab;
  touch-action: none;
  outline: none;
}

.chart-scrollbar-thumb:hover,
.chart-scrollbar-thumb:focus-visible {
  fill: var(--accent-soft);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- SimChart.test.tsx`
Expected: PASS, including the pre-existing tests (they now pass `xZoom={1}
xPan={0} yPan={0}` by default, reproducing today's view exactly).

- [ ] **Step 6: Commit**

```bash
git add src/components/SimChart.tsx src/components/SimChart.test.tsx src/index.css
git commit -m "feat: add x-zoom, pan, scrollbars, and reset view to SimChart

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Wire `BankrollChart.tsx`

**Files:**
- Modify: `src/components/BankrollChart.tsx`
- Modify: `src/components/BankrollChart.test.tsx`

**Interfaces:**
- Consumes: same as Task 7, plus `keepZeroVisible: true` passed to `useChartAxes`.
- Produces: `BankrollChartProps` grows the same way `SimChartProps` did.

This task mirrors Task 7 exactly, with three differences:

1. **No spike-clip note or `clipped` count** — `BankrollChart` never had one;
   don't add one here either (out of scope, per the design spec).
2. **`trueYMax`** is simpler — `BankrollChart`'s existing `autoYMax` was
   already true-max-based (`niceCeil(Math.max(state.peak, startCredits,
   1e-9) * 1.05)`), so `trueYMax` can reuse that same computation directly
   rather than deriving a separate percentile-free version:

```ts
  const trueYMax = autoYMax
```

3. **`keepZeroVisible: true`** in the `useChartAxes` call, and `y()`'s clamp
   floor stays `0` as it already effectively is (values are drawn clamped to
   `[viewY.min, viewY.max]`, and `viewY.min <= 0` is guaranteed by the hook).

- [ ] **Step 1: Write the failing tests**

`BankrollChart.test.tsx`'s existing render helper is `renderChart(over)`,
taking an options object (`points`, `state`, `startCredits`, `yZoom`,
`onYZoom`), not positional args. Extend it in place with the six new
options, all defaulted so every existing call in the file keeps testing
today's default view unchanged:

```tsx
function renderChart(
  over: {
    points?: BankrollPoint[]
    state?: BankrollState
    startCredits?: number
    yZoom?: number
    onYZoom?: (z: number) => void
    yPan?: number
    onYPan?: (p: number) => void
    xZoom?: number
    onXZoom?: (z: number) => void
    xPan?: number
    onXPan?: (p: number) => void
  } = {},
) {
  render(
    <BankrollChart
      points={over.points ?? points}
      startCredits={over.startCredits ?? 1000}
      state={over.state ?? state()}
      height={260}
      onHeight={vi.fn()}
      yZoom={over.yZoom ?? 1}
      onYZoom={over.onYZoom ?? vi.fn()}
      yPan={over.yPan ?? 0}
      onYPan={over.onYPan ?? vi.fn()}
      xZoom={over.xZoom ?? 1}
      onXZoom={over.onXZoom ?? vi.fn()}
      xPan={over.xPan ?? 0}
      onXPan={over.onXPan ?? vi.fn()}
    />,
  )
}
```

Then add:

```tsx
describe('BankrollChart pan and x-zoom', () => {
  it('renders an x-axis zoom handle', () => {
    renderChart()
    expect(screen.getByRole('slider', { name: "Zoom the bankroll chart's x-axis" })).toBeDefined()
  })

  it('keeps 0 visible however far the y-axis is panned', () => {
    // Zoomed tight (yZoom 0.2), then middle-drag far down — per
    // useMiddleDragPan's convention, dragging down raises the visible
    // range, which is exactly the direction that would hide 0 above the
    // view if BankrollChart's zero-visible clamp weren't wired in.
    renderChart({ yZoom: 0.2 })
    const hit = document.querySelector('.sim-hit')!
    fireEvent.pointerDown(hit, { pointerId: 1, button: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(hit, { pointerId: 1, clientX: 0, clientY: 10_000 })
    const labels = [...document.querySelectorAll('.axis-label')].map((n) => n.textContent)
    expect(labels).toContain('0')
  })

  it('renders a reset view button', () => {
    renderChart()
    expect(screen.getByRole('button', { name: /reset/i })).toBeDefined()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- BankrollChart.test.tsx`
Expected: FAIL — new props/elements don't exist yet.

- [ ] **Step 3: Update `BankrollChart.tsx`**

Apply the same nine categories of changes as Task 7 Step 3, adapted to this
file's names (`state.peak`/`startCredits` instead of `points`/`cumulative`/
`expectedRtp`; label text says "bankroll chart" instead of "simulation
chart"; no spike-clip note/count to preserve or recompute). Concretely:

- Imports: add `ChartScrollbar`, `ChartXAxisZoom`, `useChartAxes`, `useMiddleDragPan`.
- `BankrollChartProps`: add `yPan, onYPan, xZoom, onXZoom, xPan, onXPan` (keep
  existing `yZoom, onYZoom`).
- `MARGIN`: `{ top: 14, right: 88, bottom: 52, left: 72 }` (this file's
  existing `right` was `74` vs `SimChart`'s `74` too, but its labels are
  wider — `fmtCredits` — so bump to `88` for headroom, `bottom` to `52`
  matching `SimChart`).
- After the existing `autoYMax` `useMemo` (unchanged):

```ts
  const trueYMax = autoYMax

  const { viewX, viewY, setXPan, setYPan, resetView, xScrollbar, yScrollbar } = useChartAxes({
    xExtent: totalSpins,
    xZoom,
    onXZoom,
    xPan,
    onXPan,
    autoYMax,
    trueYMax,
    yZoom,
    onYZoom,
    yPan,
    onYPan,
    keepZeroVisible: true,
  })

  const middleDragPan = useMiddleDragPan({
    xZoom,
    xPan,
    onXPan: setXPan,
    yZoom,
    yPan,
    onYPan: setYPan,
    plotW,
    plotH,
  })

  const x = (spins: number) =>
    MARGIN.left + ((spins - viewX.min) / Math.max(1e-9, viewX.max - viewX.min)) * plotW
  const y = (v: number) => {
    const clamped = Math.min(Math.max(v, viewY.min), viewY.max)
    return MARGIN.top + plotH * (1 - (clamped - viewY.min) / Math.max(1e-9, viewY.max - viewY.min))
  }
```

  Delete the old `const yMax = autoYMax * yZoom` and the old `x`/`y`
  definitions.
- `yTicks`/`xTicks`: rebase on `viewY`/`viewX`, same formula as Task 7 Step 5.
- `onMove`: rebase on `viewX`, same as Task 7 Step 6 (this file's `onMove`
  uses `totalSpins` directly rather than a `spinsAt` array — replace
  `((e.clientX - rect.left) / Math.max(1, plotW)) * totalSpins` with
  `viewX.min + ((e.clientX - rect.left) / Math.max(1, plotW)) * (viewX.max - viewX.min)`).
- Add a `<clipPath id="bankroll-chart-plot-clip">` (same shape as Task 7 Step
  7) and wrap the `path`, the bust marker `<g className="bankroll-bust">`,
  and the crosshair `<line>` in a `<g clipPath="url(#bankroll-chart-plot-clip)">`.
- Spread `middleDragPan` onto the `.sim-hit` rect, same as Task 7 Step 8.
- Mount `ChartXAxisZoom` (label: `"Zoom the bankroll chart's x-axis"`) and
  the two `ChartScrollbar`s (labels: `"Scroll the bankroll chart
  horizontally"` / `"...vertically"`), same layout as Task 7 Step 9.
- Add the Reset View button to `.sim-legend`, same as Task 7 Step 10.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- BankrollChart.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/BankrollChart.tsx src/components/BankrollChart.test.tsx
git commit -m "feat: add x-zoom, pan, scrollbars, and reset view to BankrollChart

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: Thread props through `ConvergenceSim`, `BankrollSim`, `SimulationPanel`

**Files:**
- Modify: `src/components/ConvergenceSim.tsx`, `src/components/ConvergenceSim.test.tsx`
- Modify: `src/components/BankrollSim.tsx`, `src/components/BankrollSim.test.tsx`
- Modify: `src/components/SimulationPanel.tsx`, `src/components/SimulationPanel.test.tsx`

**Interfaces:**
- Consumes: `SimChartProps`/`BankrollChartProps` (Tasks 7–8).
- Produces: `ConvergenceSimProps`/`BankrollSimProps`/`SimulationPanelProps` each grow by `xZoom, onXZoom, xPan, onXPan, yPan, onYPan` (`ConvergenceSim`/`BankrollSim`) or the doubled set for both charts, prefixed `sim`/`bankroll` (`SimulationPanel`) — exactly the same naming pattern the existing `yZoom`/`onYZoom` already uses at each layer.

- [ ] **Step 1: Write the failing tests**

**`ConvergenceSim.test.tsx`** — its existing helper is
`renderPanel(worker?, spins = 1000)`, calling `<ConvergenceSim ... yZoom={1}
onYZoom={vi.fn()} .../>`. Change its signature to take an options object so
the six new props can be overridden without breaking every existing call
site (which all currently pass positional `worker`/`spins`, so this needs
updating throughout the file too — mechanical, see the diff below):

```tsx
function renderPanel(
  over: {
    worker?: FakeWorker
    spins?: number
    yZoom?: number
    onYZoom?: (z: number) => void
    yPan?: number
    onYPan?: (p: number) => void
    xZoom?: number
    onXZoom?: (z: number) => void
    xPan?: number
    onXPan?: (p: number) => void
  } = {},
) {
  const onSpins = vi.fn()
  render(
    <ConvergenceSim
      rows={rows}
      totalWeight={1_000_000}
      expectedRtp={0.6}
      spins={over.spins ?? 1000}
      onSpins={onSpins}
      chartHeight={260}
      onChartHeight={vi.fn()}
      yZoom={over.yZoom ?? 1}
      onYZoom={over.onYZoom ?? vi.fn()}
      yPan={over.yPan ?? 0}
      onYPan={over.onYPan ?? vi.fn()}
      xZoom={over.xZoom ?? 1}
      onXZoom={over.onXZoom ?? vi.fn()}
      xPan={over.xPan ?? 0}
      onXPan={over.onXPan ?? vi.fn()}
      createWorker={over.worker === undefined ? undefined : () => over.worker!}
    />,
  )
  return onSpins
}
```

Update every existing call site in the file from `renderPanel(worker,
spins)` to `renderPanel({ worker, spins })` (a small mechanical rewrite —
grep the file for `renderPanel(` to find them all), then add:

```tsx
describe('ConvergenceSim pan/x-zoom threading', () => {
  it('passes the x-zoom and pan props through to SimChart', () => {
    renderPanel({ xZoom: 0.6, yPan: 0.2 })
    const slider = screen.getByRole('slider', { name: "Zoom the simulation chart's x-axis" })
    expect(slider.getAttribute('aria-valuenow')).toBe('0.6')
  })
})
```

**`BankrollSim.test.tsx`** — same shape of change to its `renderSim(worker?,
config, tableRtp)` helper: convert it to an options object adding
`yPan/onYPan/xZoom/onXZoom/xPan/onXPan` (mirroring the block above), update
existing call sites the same mechanical way, then add:

```tsx
describe('BankrollSim pan/x-zoom threading', () => {
  it('passes the x-zoom and pan props through to BankrollChart', () => {
    renderSim({ xZoom: 0.6, yPan: 0.2 })
    const slider = screen.getByRole('slider', { name: "Zoom the bankroll chart's x-axis" })
    expect(slider.getAttribute('aria-valuenow')).toBe('0.6')
  })
})
```

**`SimulationPanel.test.tsx`** — its existing "y-zoom independence" describe
block builds full inline `<SimulationPanel ... />` JSX per test rather than
a shared helper (see `"threads the convergence chart's own zoom..."`). Add a
sibling test in that same style:

```tsx
it("threads the convergence chart's own x-zoom and pan, not the bankroll chart's", () => {
  render(
    <SimulationPanel
      mode="convergence"
      onMode={vi.fn()}
      rows={rows}
      totalWeight={1_000_000}
      expectedRtp={0.95}
      spins={1000}
      onSpins={vi.fn()}
      bankroll={DEFAULT_BANKROLL}
      onBankroll={vi.fn()}
      chartHeight={260}
      onChartHeight={vi.fn()}
      simYZoom={1}
      onSimYZoom={vi.fn()}
      simYPan={0}
      onSimYPan={vi.fn()}
      simXZoom={0.7}
      onSimXZoom={vi.fn()}
      simXPan={0}
      onSimXPan={vi.fn()}
      bankrollYZoom={1}
      onBankrollYZoom={vi.fn()}
      bankrollYPan={0}
      onBankrollYPan={vi.fn()}
      bankrollXZoom={0.3}
      onBankrollXZoom={vi.fn()}
      bankrollXPan={0}
      onBankrollXPan={vi.fn()}
    />,
  )
  const slider = screen.getByRole('slider', { name: "Zoom the simulation chart's x-axis" })
  expect(slider.getAttribute('aria-valuenow')).toBe('0.7')
})
```

Also update `SimulationPanel.test.tsx`'s other helper, `renderPanel(mode)`
(used by the plain `describe('SimulationPanel', ...)` block above the
zoom-independence tests) — add the twelve new props with default values
(`1`/`vi.fn()` for zooms, `0`/`vi.fn()` for pans) to its `<SimulationPanel
.../>` call, the same way `simYZoom`/`onSimYZoom` are already there. This is
required for the file to type-check, not just to pass — `SimulationPanel`'s
props become mandatory once Task 9 Step 5 adds them.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- ConvergenceSim.test.tsx BankrollSim.test.tsx SimulationPanel.test.tsx`
Expected: FAIL — new props don't exist on any of the three components yet.

- [ ] **Step 3: Update `ConvergenceSim.tsx`**

`ConvergenceSimProps` — add after the existing `yZoom`/`onYZoom`:

```ts
  yPan: number
  onYPan: (p: number) => void
  xZoom: number
  onXZoom: (z: number) => void
  xPan: number
  onXPan: (p: number) => void
```

Destructure the six new props in the function signature, and pass them
through to `<SimChart ... />` alongside the existing `yZoom`/`onYZoom`.

- [ ] **Step 4: Update `BankrollSim.tsx`**

Same shape as Step 3, applied to `BankrollSimProps` and the `<BankrollChart
... />` call site.

- [ ] **Step 5: Update `SimulationPanel.tsx`**

`SimulationPanelProps` — after `simYZoom`/`onSimYZoom` add:

```ts
  simYPan: number
  onSimYPan: (p: number) => void
  simXZoom: number
  onSimXZoom: (z: number) => void
  simXPan: number
  onSimXPan: (p: number) => void
```

and after `bankrollYZoom`/`onBankrollYZoom` add the equivalent
`bankroll`-prefixed six. Destructure all twelve new props and pass the
convergence six to `<ConvergenceSim ... />` (as `yPan/onYPan/xZoom/onXZoom/
xPan/onXPan`) and the bankroll six to `<BankrollSim ... />` the same way.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- ConvergenceSim.test.tsx BankrollSim.test.tsx SimulationPanel.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/ConvergenceSim.tsx src/components/ConvergenceSim.test.tsx \
        src/components/BankrollSim.tsx src/components/BankrollSim.test.tsx \
        src/components/SimulationPanel.tsx src/components/SimulationPanel.test.tsx
git commit -m "feat: thread pan/x-zoom props through the simulation panel layers

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10: Persist in `storage.ts`

**Files:**
- Modify: `src/lib/storage.ts`
- Modify: `src/lib/storage.test.ts`

**Interfaces:**
- Produces: `Workspace` gains `simChartXZoom?, simChartXPan?, simChartYPan?, bankrollChartXZoom?, bankrollChartXPan?, bankrollChartYPan?` (all `number`, all optional).

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/storage.test.ts`, near the existing "round-trips both y-zoom
factors" test:

```ts
it('round-trips the new pan/x-zoom fields and rejects a non-numeric one', () => {
  saveWorkspace({
    ...workspace,
    simChartXZoom: 0.6,
    simChartXPan: 0.1,
    simChartYPan: -0.2,
    bankrollChartXZoom: 0.8,
    bankrollChartXPan: 0,
    bankrollChartYPan: 0.05,
  })
  const loaded = loadWorkspace()
  expect(loaded?.simChartXZoom).toBe(0.6)
  expect(loaded?.simChartXPan).toBe(0.1)
  expect(loaded?.simChartYPan).toBe(-0.2)
  expect(loaded?.bankrollChartXZoom).toBe(0.8)
  expect(loaded?.bankrollChartXPan).toBe(0)
  expect(loaded?.bankrollChartYPan).toBe(0.05)

  store.set(STORAGE_KEY, JSON.stringify({ ...workspace, simChartXPan: 'wide' }))
  expect(loadWorkspace()).toBeNull()
})

it('accepts a workspace saved before the pan/x-zoom fields existed', () => {
  saveWorkspace(workspace)
  const loaded = loadWorkspace()
  expect(loaded?.simChartXZoom).toBeUndefined()
  expect(loaded?.simChartXPan).toBeUndefined()
  expect(loaded?.simChartYPan).toBeUndefined()
  expect(loaded?.bankrollChartXZoom).toBeUndefined()
  expect(loaded?.bankrollChartXPan).toBeUndefined()
  expect(loaded?.bankrollChartYPan).toBeUndefined()
})
```

(Match `store.set`'s actual name/import in the existing file — it's already
used two tests above this insertion point.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- storage.test.ts`
Expected: FAIL — the six fields aren't recognized by `isWorkspace` yet
(round-trip assertions fail, or `loadWorkspace()` incorrectly returns `null`
for the valid save).

- [ ] **Step 3: Update `storage.ts`**

In the `Workspace` interface, right after `bankrollChartYZoom?: number`:

```ts
  /** Optional — absent in workspaces saved before x-axis zoom/pan and y-pan existed. */
  simChartXZoom?: number
  simChartXPan?: number
  simChartYPan?: number
  bankrollChartXZoom?: number
  bankrollChartXPan?: number
  bankrollChartYPan?: number
```

In `isWorkspace`, right after the existing
`(v.bankrollChartYZoom === undefined || isFiniteNumber(v.bankrollChartYZoom))
&&` line:

```ts
    (v.simChartXZoom === undefined || isFiniteNumber(v.simChartXZoom)) &&
    (v.simChartXPan === undefined || isFiniteNumber(v.simChartXPan)) &&
    (v.simChartYPan === undefined || isFiniteNumber(v.simChartYPan)) &&
    (v.bankrollChartXZoom === undefined || isFiniteNumber(v.bankrollChartXZoom)) &&
    (v.bankrollChartXPan === undefined || isFiniteNumber(v.bankrollChartXPan)) &&
    (v.bankrollChartYPan === undefined || isFiniteNumber(v.bankrollChartYPan)) &&
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- storage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/storage.ts src/lib/storage.test.ts
git commit -m "feat: persist simulation chart pan and x-zoom in the workspace

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 11: Wire `App.tsx`

**Files:**
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `SimulationPanelProps` (Task 9), `Workspace` (Task 10), `clampZoom`/`X_ZOOM_RANGE` (Task 2).
- Produces: nothing new — this is the top of the tree.

There is no isolated unit test for `App.tsx`'s state wiring beyond what
`SimulationPanel.test.tsx` already covers at its own layer, so this task is
verified by running the **full** test suite plus a manual smoke check.

- [ ] **Step 1: Add the six new `useState`s**

In `src/App.tsx`, immediately after the existing:

```ts
  const [simChartYZoom, setSimChartYZoom] = useState(() => clampZoom(saved?.simChartYZoom ?? 1))
  const [bankrollChartYZoom, setBankrollChartYZoom] = useState(() =>
    clampZoom(saved?.bankrollChartYZoom ?? 1),
  )
```

add:

```ts
  const [simChartXZoom, setSimChartXZoom] = useState(() =>
    clampZoom(saved?.simChartXZoom ?? 1, X_ZOOM_RANGE),
  )
  const [simChartXPan, setSimChartXPan] = useState(saved?.simChartXPan ?? 0)
  const [simChartYPan, setSimChartYPan] = useState(saved?.simChartYPan ?? 0)
  const [bankrollChartXZoom, setBankrollChartXZoom] = useState(() =>
    clampZoom(saved?.bankrollChartXZoom ?? 1, X_ZOOM_RANGE),
  )
  const [bankrollChartXPan, setBankrollChartXPan] = useState(saved?.bankrollChartXPan ?? 0)
  const [bankrollChartYPan, setBankrollChartYPan] = useState(saved?.bankrollChartYPan ?? 0)
```

Add `X_ZOOM_RANGE` to the existing `chartUtils` import line.

- [ ] **Step 2: Add the six fields to the persisted snapshot**

In the workspace-snapshot `useMemo`/effect (right after the existing
`simChartYZoom, bankrollChartYZoom,` line inside the object literal):

```ts
      simChartXZoom,
      simChartXPan,
      simChartYPan,
      bankrollChartXZoom,
      bankrollChartXPan,
      bankrollChartYPan,
```

And in that same hook's dependency array (right after the existing
`simChartYZoom, bankrollChartYZoom,` line):

```ts
    simChartXZoom,
    simChartXPan,
    simChartYPan,
    bankrollChartXZoom,
    bankrollChartXPan,
    bankrollChartYPan,
```

- [ ] **Step 3: Pass the twelve new props to `<SimulationPanel ... />`**

Right after the existing:

```tsx
              simYZoom={simChartYZoom}
              onSimYZoom={setSimChartYZoom}
              bankrollYZoom={bankrollChartYZoom}
              onBankrollYZoom={setBankrollChartYZoom}
```

add:

```tsx
              simYPan={simChartYPan}
              onSimYPan={setSimChartYPan}
              simXZoom={simChartXZoom}
              onSimXZoom={setSimChartXZoom}
              simXPan={simChartXPan}
              onSimXPan={setSimChartXPan}
              bankrollYPan={bankrollChartYPan}
              onBankrollYPan={setBankrollChartYPan}
              bankrollXZoom={bankrollChartXZoom}
              onBankrollXZoom={setBankrollChartXZoom}
              bankrollXPan={bankrollChartXPan}
              onBankrollXPan={setBankrollChartXPan}
```

- [ ] **Step 4: Run the full suite**

Run: `npm test -- run`
Expected: PASS, no regressions in `App.test.tsx` or any other file.

- [ ] **Step 5: Manual smoke check**

Run: `npm run dev`, open the app, run a Convergence simulation, and verify:
- Scrolling over the y-axis label column zooms in centered on the data, not
  anchored to 0.
- Scrolling over the x-axis label row zooms the x-axis.
- Middle-mouse-drag on the plot pans both axes.
- Scrollbars appear once zoomed in on an axis and drag correctly.
- "Reset view" shows the full data (including any spike) centered.
- Repeat for a Bankroll run, additionally confirming 0 never scrolls out of
  view no matter how far up you pan.
- Reload the page and confirm the view state survived.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx
git commit -m "feat: wire pan and x-zoom state for both simulation charts into App

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** §1 (view model) → Tasks 1, 3, 7, 8. §2 (reset) → Tasks
  3, 7, 8. §3 (interactions: x-zoom, middle-drag, scrollbars) → Tasks 4, 5,
  6, 7, 8. §4 (component wiring) → Tasks 7, 8, 9. §5 (persistence) → Tasks
  10, 11. Testing section → every task's own test file plus Task 11's full
  suite + manual pass.
- **Placeholder scan:** the draft had three issues, now fixed — Task 5's
  `ChartScrollbar` code sample had a missing ternary colon (fixed directly
  rather than shipping broken code with a follow-up "fix the typo" step);
  Task 3's `resetView` test asserted the wrong `onYPan` value (recomputed by
  hand and corrected to `1.5`, with the arithmetic left in a comment) and
  its "keeps 0 visible" test called a hook directly outside a component
  (rewritten with `renderHook` + a direct `viewRange` check); Tasks 8 and 9's
  test steps originally deferred to "read the file first" — replaced with
  each file's actual existing helper (`renderChart`/`renderPanel`/`renderSim`
  read verbatim from source) and concrete extended versions.
- **Type consistency:** `xZoom/onXZoom/xPan/onXPan/yPan/onYPan` naming is
  identical across `chartView.ts` (via `ChartAxesConfig`), `useChartAxes.ts`,
  `SimChart.tsx`/`BankrollChart.tsx`, and the three panel layers — checked
  task-by-task while writing.
