# Sim chart Y-zoom, RTP color, forced stacking, and totals-free export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a mouse-driven y-axis zoom to both simulation charts, recolor the convergence chart's "RTP so far" line, let the user force the distribution chart to always sit below the buckets table, and stop exporting a totals row.

**Architecture:** A new small, reusable `ChartYAxisZoom` component (styled after the existing `ChartResizeGrip`) renders an invisible wheel/drag/keyboard hit-region over each chart's y-axis label column; both `SimChart` and `BankrollChart` multiply their existing auto-fit ceiling by a zoom factor the caller owns and persists, exactly like chart height today. The distribution force-stack toggle is one more field on the already-persisted `ChartSettings` bag, read by one CSS rule. The export change removes a code path with no new abstractions.

**Tech Stack:** React 18 + TypeScript, Vite, vitest + jsdom + @testing-library/react, plain CSS (no CSS framework), SVG for all charts.

## Global Constraints

- Y-zoom factor range: `[0.15, 6]`, exported as `Y_ZOOM_RANGE` from `src/components/chartUtils.ts`. Default zoom is `1` (auto, no zoom).
- Effective ceiling is always `autoYMax * zoom` — the auto computation itself never changes.
- Wheel and keyboard zoom step: ×1.1 per notch/press (`WHEEL_FACTOR` in `ChartYAxisZoom.tsx`).
- Drag zoom rate: a vertical drag of 115px doubles or halves the zoom factor (`DRAG_HALF_LIFE` in `ChartYAxisZoom.tsx`). Dragging up zooms in (factor shrinks); dragging down zooms out (factor grows). Scrolling up (wheel `deltaY < 0`) zooms in; scrolling down zooms out.
- Double-click or the Home key on the zoom handle resets its factor to `1`.
- RTP-so-far line recolor: `.sim-cum-path` and `.legend-line.cumulative` switch from `var(--series-0)` to `var(--danger)` (`#cf222e`) in `src/index.css`. No other selectors change.
- New `ChartSettings.forceStack: boolean` field (`src/lib/types.ts`), default `false` in `DEFAULT_CHART`.
- Force-stack CSS: `.content-row.force-stack > .panel.chart { flex-basis: 100%; min-width: 100%; }`.
- New persisted `Workspace` fields (`src/lib/storage.ts`): `simChartYZoom?: number`, `bankrollChartYZoom?: number` — optional, so old workspaces still validate.
- `buildTsv` (`src/lib/exportTsv.ts`) emits the header plus exactly one line per bucket — no totals row, ever.
- `example-input-data.tsv` / `example-output-data.tsv` (repo root) are the engine's own reference files and must not be edited by this plan.

---

### Task 1: Y-zoom math and the `ChartYAxisZoom` handle

**Files:**
- Modify: `src/components/chartUtils.ts`
- Modify: `src/components/chartUtils.test.ts`
- Create: `src/components/ChartYAxisZoom.tsx`
- Create: `src/components/ChartYAxisZoom.test.tsx`

**Interfaces:**
- Produces: `Y_ZOOM_RANGE: { min: 0.15, max: 6 }`, `clampZoom(z: number, range?: YZoomRange): number` from `chartUtils.ts`.
- Produces: `ChartYAxisZoom({ zoom, onZoom, x, y, width, height, label }: ChartYAxisZoomProps)` — a self-closing SVG element (`<rect>`), meant to be rendered as a direct child of a chart's `<svg>`. `zoom`/`onZoom` are owned by the caller, like `ChartResizeGrip`'s `height`/`onHeight`.

- [ ] **Step 1: Write the failing tests for `clampZoom`**

Add to `src/components/chartUtils.test.ts`, changing the import line to:

```ts
import { clampHeight, clampZoom, DIST_HEIGHT, linearBarWidth, logBarWidth, SIM_HEIGHT, Y_ZOOM_RANGE } from './chartUtils'
```

and appending:

```ts
describe('clampZoom', () => {
  it('keeps a zoom factor inside the range', () => {
    expect(clampZoom(1)).toBe(1)
    expect(clampZoom(2)).toBe(2)
  })

  it('clamps below the floor and above the ceiling', () => {
    expect(clampZoom(0.01)).toBe(Y_ZOOM_RANGE.min)
    expect(clampZoom(50)).toBe(Y_ZOOM_RANGE.max)
  })

  it('falls back to 1 when the stored value is not a number', () => {
    expect(clampZoom(NaN)).toBe(1)
    expect(clampZoom(Infinity)).toBe(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/chartUtils.test.ts`
Expected: FAIL — `clampZoom` and `Y_ZOOM_RANGE` are not exported yet.

- [ ] **Step 3: Add the zoom range and `clampZoom` to `chartUtils.ts`**

Insert after the existing `clampHeight` function (right before the `fmtCompact` function):

```ts
/**
 * Y-axis zoom is multiplicative and layered on top of each chart's own
 * auto-fit ceiling (see SimChart/BankrollChart): `effectiveYMax = autoYMax *
 * zoom`. Bounding the *factor* rather than the resulting pixel value keeps
 * the bounds meaningful however wide or narrow the auto range currently is.
 */
export interface YZoomRange {
  min: number
  max: number
}

export const Y_ZOOM_RANGE: YZoomRange = { min: 0.15, max: 6 }

export function clampZoom(z: number, range: YZoomRange = Y_ZOOM_RANGE): number {
  if (!Number.isFinite(z)) return 1
  return Math.min(Math.max(z, range.min), range.max)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/chartUtils.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing tests for `ChartYAxisZoom`**

Create `src/components/ChartYAxisZoom.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChartYAxisZoom } from './ChartYAxisZoom'
import { Y_ZOOM_RANGE } from './chartUtils'

afterEach(cleanup)

function renderZoom(zoom: number) {
  const onZoom = vi.fn()
  render(
    <svg>
      <ChartYAxisZoom zoom={zoom} onZoom={onZoom} x={0} y={0} width={64} height={200} label="Zoom" />
    </svg>,
  )
  return { handle: screen.getByRole('slider', { name: 'Zoom' }), onZoom }
}

const last = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls[fn.mock.calls.length - 1][0] as number

describe('ChartYAxisZoom', () => {
  it('zooms in on wheel-up and out on wheel-down', () => {
    const { handle, onZoom } = renderZoom(1)
    fireEvent.wheel(handle, { deltaY: -100 })
    expect(last(onZoom)).toBeCloseTo(1 / 1.1, 5)
    fireEvent.wheel(handle, { deltaY: 100 })
    expect(last(onZoom)).toBeCloseTo(1, 5)
  })

  it('clamps wheel zoom at the range', () => {
    const { handle, onZoom } = renderZoom(Y_ZOOM_RANGE.min)
    fireEvent.wheel(handle, { deltaY: -100 })
    expect(last(onZoom)).toBe(Y_ZOOM_RANGE.min)
  })

  it('zooms in when dragged up and out when dragged down', () => {
    const { handle, onZoom } = renderZoom(1)
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 100 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 0 })
    expect(last(onZoom)).toBeLessThan(1)
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 200 })
    expect(last(onZoom)).toBeGreaterThan(1)
  })

  it('ignores pointer movement once the drag has ended', () => {
    const { handle, onZoom } = renderZoom(1)
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 100 })
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 100 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 0 })
    expect(onZoom).not.toHaveBeenCalled()
  })

  it('resets to 1 on Home and on double-click', () => {
    const { handle, onZoom } = renderZoom(3)
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(last(onZoom)).toBe(1)
    fireEvent.doubleClick(handle)
    expect(last(onZoom)).toBe(1)
  })

  it('steps from the keyboard', () => {
    const { handle, onZoom } = renderZoom(1)
    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    expect(last(onZoom)).toBeCloseTo(1 / 1.1, 5)
    fireEvent.keyDown(handle, { key: 'ArrowDown' })
    expect(last(onZoom)).toBeCloseTo(1, 5)
  })

  it('exposes the current zoom to assistive tech', () => {
    const { handle } = renderZoom(2)
    expect(handle.getAttribute('aria-valuenow')).toBe('2')
    expect(handle.getAttribute('aria-valuemin')).toBe(String(Y_ZOOM_RANGE.min))
    expect(handle.getAttribute('aria-valuemax')).toBe(String(Y_ZOOM_RANGE.max))
    expect(handle.getAttribute('tabindex')).toBe('0')
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run src/components/ChartYAxisZoom.test.tsx`
Expected: FAIL — the module does not exist yet.

- [ ] **Step 7: Create `ChartYAxisZoom.tsx`**

```tsx
import { useEffect, useRef } from 'react'
import { clampZoom, Y_ZOOM_RANGE } from './chartUtils'

/**
 * Invisible drag/scroll handle over a chart's y-axis label column: scroll or
 * drag vertically to zoom the y-axis in or out around the auto-fit range the
 * chart already computes. The zoom factor itself belongs to the caller — it
 * is persisted with the rest of the view state — so this component holds
 * nothing but the live pointer session.
 *
 * Zoom is multiplicative, like the log-axis drag in DistributionChart: a
 * constant relative amount per pixel dragged or per wheel notch, rather than
 * an absolute amount, so the same gesture feels the same whether the range is
 * currently wide or already tight.
 *
 * The wheel listener is attached manually with `passive: false` — React
 * attaches its own wheel listener as passive, and a passive listener's
 * preventDefault() is silently ignored, which would let the page scroll under
 * the pointer while the user is trying to zoom.
 */

interface ChartYAxisZoomProps {
  zoom: number
  onZoom: (z: number) => void
  /** Hit-region geometry — the y-axis label column. */
  x: number
  y: number
  width: number
  height: number
  label: string
}

/** Relative change per wheel notch or keypress. */
const WHEEL_FACTOR = 1.1
/** Pixels of drag that double or halve the zoom factor. */
const DRAG_HALF_LIFE = 115

export function ChartYAxisZoom({ zoom, onZoom, x, y, width, height, label }: ChartYAxisZoomProps) {
  const drag = useRef<{ startY: number; startZoom: number } | null>(null)
  const ref = useRef<SVGRectElement>(null)

  useEffect(() => {
    const el = ref.current
    if (el === null) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      onZoom(clampZoom(zoom * (e.deltaY < 0 ? 1 / WHEEL_FACTOR : WHEEL_FACTOR)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, onZoom])

  return (
    <rect
      ref={ref}
      className="y-zoom-hit"
      x={x}
      y={y}
      width={Math.max(0, width)}
      height={Math.max(0, height)}
      fill="transparent"
      role="slider"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuenow={Math.round(zoom * 1000) / 1000}
      aria-valuemin={Y_ZOOM_RANGE.min}
      aria-valuemax={Y_ZOOM_RANGE.max}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
        drag.current = { startY: e.clientY, startZoom: zoom }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (d === null) return
        const dy = d.startY - e.clientY
        onZoom(clampZoom(d.startZoom * Math.exp((-dy * Math.LN2) / DRAG_HALF_LIFE)))
      }}
      onPointerUp={() => {
        drag.current = null
      }}
      onPointerCancel={() => {
        drag.current = null
      }}
      onDoubleClick={() => onZoom(1)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          onZoom(clampZoom(zoom / WHEEL_FACTOR))
        } else if (e.key === 'ArrowDown') {
          e.preventDefault()
          onZoom(clampZoom(zoom * WHEEL_FACTOR))
        } else if (e.key === 'Home') {
          e.preventDefault()
          onZoom(1)
        }
      }}
    />
  )
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run src/components/ChartYAxisZoom.test.tsx`
Expected: PASS

- [ ] **Step 9: Add the hit-region cursor style**

In `src/index.css`, add right after the `.sim-crosshair` rule (near line 1283):

```css
.y-zoom-hit {
  cursor: ns-resize;
  touch-action: none;
  outline: none;
}
```

- [ ] **Step 10: Commit**

```bash
git add src/components/chartUtils.ts src/components/chartUtils.test.ts src/components/ChartYAxisZoom.tsx src/components/ChartYAxisZoom.test.tsx src/index.css
git commit -m "feat: add a reusable y-axis zoom handle for the simulation charts"
```

---

### Task 2: Wire zoom into `SimChart`

**Files:**
- Modify: `src/components/SimChart.tsx`
- Modify: `src/components/SimChart.test.tsx`

**Interfaces:**
- Consumes: `ChartYAxisZoom` from Task 1 (`{ zoom, onZoom, x, y, width, height, label }`).
- Produces: `SimChart` gains required props `yZoom: number`, `onYZoom: (z: number) => void`.

- [ ] **Step 1: Update the failing tests**

In `src/components/SimChart.test.tsx`, replace the `renderSim` helper:

```tsx
function renderSim(height = 260, yZoom = 1) {
  const onHeight = vi.fn()
  const onYZoom = vi.fn()
  render(
    <SimChart
      points={[1.5, 0.5, 1.0]}
      blockSize={400}
      requestedSpins={1000}
      expectedRtp={0.95}
      height={height}
      yZoom={yZoom}
      onYZoom={onYZoom}
      onHeight={onHeight}
    />,
  )
  return { onHeight, onYZoom }
}
```

and update the one existing call site that uses the return value (in the `'SimChart height'` describe block):

```tsx
  it('reports a new height when the grip is dragged', () => {
    const { onHeight } = renderSim(260)
    const grip = screen.getByRole('separator', { name: 'Resize the simulation chart' })
    fireEvent.pointerDown(grip, { pointerId: 1, clientY: 0 })
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 40 })
    expect(onHeight).toHaveBeenLastCalledWith(300)
  })
```

Then append a new describe block at the end of the file:

```tsx
describe('SimChart y-zoom', () => {
  it('shows no spike note at the default zoom', () => {
    renderSim()
    expect(screen.queryByText(/pinned to the top edge/)).toBeNull()
  })

  it('recomputes the clipped-spike count against the zoomed range', () => {
    // autoYMax is niceCeil(1.725) = 2; zoomed to 0.5 the effective ceiling is
    // 1, and only the 1.5 block mean sits above it.
    renderSim(260, 0.5)
    expect(screen.getByText(/1 spike block pinned to the top edge/)).toBeDefined()
  })

  it('renders a y-axis zoom handle', () => {
    renderSim()
    expect(screen.getByRole('slider', { name: "Zoom the simulation chart's y-axis" })).toBeDefined()
  })

  it('reports a new zoom factor when the handle is dragged', () => {
    const { onYZoom } = renderSim()
    const handle = screen.getByRole('slider', { name: "Zoom the simulation chart's y-axis" })
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 100 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 0 })
    expect(onYZoom).toHaveBeenCalled()
    expect(onYZoom.mock.calls.at(-1)![0]).toBeLessThan(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/SimChart.test.tsx`
Expected: FAIL — `yZoom`/`onYZoom` are not accepted props yet, and there is no `slider` role.

- [ ] **Step 3: Update `SimChart.tsx`**

Add the import:

```ts
import { ChartYAxisZoom } from './ChartYAxisZoom'
```

Add two props to `SimChartProps` (after `onHeight`):

```ts
  height: number
  onHeight: (h: number) => void
  /** Multiplies the auto-fit ceiling; 1 is auto, <1 zooms in, >1 zooms out. */
  yZoom: number
  onYZoom: (z: number) => void
}
```

Destructure them in the function signature:

```ts
export function SimChart({
  points,
  blockSize,
  requestedSpins,
  expectedRtp,
  height,
  onHeight,
  yZoom,
  onYZoom,
}: SimChartProps) {
```

Replace the `{ yMax, clipped }` block:

```ts
  const { yMax, clipped } = useMemo(() => {
    if (points.length === 0) return { yMax: niceCeil(expectedRtp * 1.5), clipped: 0 }
    const sorted = [...points].sort((a, b) => a - b)
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
    const cumMax = cumulative.length > 0 ? Math.max(...cumulative) : 0
    const ceil = niceCeil(Math.max(p95 * 1.15, cumMax * 1.15, expectedRtp * 1.3, 1e-9))
    return { yMax: ceil, clipped: points.filter((v) => v > ceil).length }
  }, [points, cumulative, expectedRtp])
```

with:

```ts
  /**
   * The ceiling before zoom: p95 of block means, cumulative max and expected
   * RTP, whichever is highest. Zoom (ChartYAxisZoom, below) multiplies this
   * rather than replacing it, so a live run's growing cumulative max keeps
   * the auto baseline moving under a zoomed-in view instead of leaving it
   * stale.
   */
  const autoYMax = useMemo(() => {
    if (points.length === 0) return niceCeil(expectedRtp * 1.5)
    const sorted = [...points].sort((a, b) => a - b)
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
    const cumMax = cumulative.length > 0 ? Math.max(...cumulative) : 0
    return niceCeil(Math.max(p95 * 1.15, cumMax * 1.15, expectedRtp * 1.3, 1e-9))
  }, [points, cumulative, expectedRtp])

  const yMax = autoYMax * yZoom

  // Recomputed against the *effective* (zoomed) ceiling: a block that only
  // clips once the user zooms in should count.
  const clipped = useMemo(() => points.filter((v) => v > yMax).length, [points, yMax])
```

Finally, render the handle. Add it right after the `sim-hit` rect, still inside the `<svg>`:

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
        />

        <ChartYAxisZoom
          zoom={yZoom}
          onZoom={onYZoom}
          x={0}
          y={MARGIN.top}
          width={MARGIN.left}
          height={plotH}
          label="Zoom the simulation chart's y-axis"
        />
      </svg>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/SimChart.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/SimChart.tsx src/components/SimChart.test.tsx
git commit -m "feat: zoom the convergence chart's y-axis"
```

---

### Task 3: Wire zoom into `BankrollChart`

**Files:**
- Modify: `src/components/BankrollChart.tsx`
- Modify: `src/components/BankrollChart.test.tsx`

**Interfaces:**
- Consumes: `ChartYAxisZoom` from Task 1.
- Produces: `BankrollChart` gains required props `yZoom: number`, `onYZoom: (z: number) => void`.

- [ ] **Step 1: Update the failing tests**

In `src/components/BankrollChart.test.tsx`, replace the `renderChart` helper:

```tsx
function renderChart(
  over: {
    points?: BankrollPoint[]
    state?: BankrollState
    startCredits?: number
    yZoom?: number
    onYZoom?: ReturnType<typeof vi.fn>
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
    />,
  )
}
```

Then append two tests to the `describe('BankrollChart', ...)` block:

```tsx
  it('renders a y-axis zoom handle', () => {
    renderChart()
    expect(screen.getByRole('slider', { name: "Zoom the bankroll chart's y-axis" })).toBeDefined()
  })

  it('scales the tick labels when zoomed', () => {
    // peak 1200 → autoYMax = niceCeil(1260) = 2000, so the top tick reads "2k".
    renderChart()
    expect([...document.querySelectorAll('.axis-label')].map((n) => n.textContent)).toContain('2k')

    cleanup()
    // zoomed to 0.5 → effective yMax 1000, so the same top tick now reads "1k".
    renderChart({ yZoom: 0.5 })
    expect([...document.querySelectorAll('.axis-label')].map((n) => n.textContent)).toContain('1k')
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/BankrollChart.test.tsx`
Expected: FAIL — `yZoom`/`onYZoom` are not accepted props yet, and there is no `slider` role.

- [ ] **Step 3: Update `BankrollChart.tsx`**

Add the import:

```ts
import { ChartYAxisZoom } from './ChartYAxisZoom'
```

Add two props to `BankrollChartProps` (after `onHeight`):

```ts
  height: number
  onHeight: (h: number) => void
  /** Multiplies the auto-fit ceiling; 1 is auto, <1 zooms in, >1 zooms out. */
  yZoom: number
  onYZoom: (z: number) => void
}
```

Destructure them:

```ts
export function BankrollChart({
  points,
  startCredits,
  state,
  height,
  onHeight,
  yZoom,
  onYZoom,
}: BankrollChartProps) {
```

Replace the `yMax` computation:

```ts
  // Headroom above whichever is higher, so the reference line is never off the
  // top of a run that only ever lost money.
  const yMax = useMemo(
    () => niceCeil(Math.max(state.peak, startCredits, 1e-9) * 1.05),
    [state.peak, startCredits],
  )
```

with:

```ts
  // Headroom above whichever is higher, so the reference line is never off the
  // top of a run that only ever lost money.
  const autoYMax = useMemo(
    () => niceCeil(Math.max(state.peak, startCredits, 1e-9) * 1.05),
    [state.peak, startCredits],
  )

  const yMax = autoYMax * yZoom
```

Render the handle right after the `sim-hit` rect, still inside `<svg>`:

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
        />

        <ChartYAxisZoom
          zoom={yZoom}
          onZoom={onYZoom}
          x={0}
          y={MARGIN.top}
          width={MARGIN.left}
          height={plotH}
          label="Zoom the bankroll chart's y-axis"
        />
      </svg>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/BankrollChart.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/BankrollChart.tsx src/components/BankrollChart.test.tsx
git commit -m "feat: zoom the bankroll chart's y-axis"
```

---

### Task 4: Recolor the "RTP so far" line

**Files:**
- Modify: `src/index.css`

**Interfaces:** None — pure CSS, no new selectors, no prop or type changes.

- [ ] **Step 1: Change the stroke and swatch color**

In `src/index.css`, change:

```css
.legend-line.cumulative {
  border-color: var(--series-0);
}
```

to:

```css
.legend-line.cumulative {
  border-color: var(--danger);
}
```

and change:

```css
.sim-cum-path {
  fill: none;
  stroke: var(--series-0);
  stroke-width: 2;
  stroke-linejoin: round;
  stroke-linecap: round;
}
```

to:

```css
.sim-cum-path {
  fill: none;
  stroke: var(--danger);
  stroke-width: 2;
  stroke-linejoin: round;
  stroke-linecap: round;
}
```

- [ ] **Step 2: Run the existing chart tests to confirm nothing broke**

Run: `npx vitest run src/components/SimChart.test.tsx`
Expected: PASS (these tests assert text content and geometry, not color, so they are unaffected — this step is a regression check, not new coverage).

- [ ] **Step 3: Commit**

```bash
git add src/index.css
git commit -m "style: color the convergence chart's RTP-so-far line red"
```

---

### Task 5: Persist the zoom factors

**Files:**
- Modify: `src/lib/storage.ts`
- Modify: `src/lib/storage.test.ts`

**Interfaces:**
- Produces: `Workspace.simChartYZoom?: number`, `Workspace.bankrollChartYZoom?: number`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/storage.test.ts`, inside the `describe('storage', ...)` block:

```ts
  it('round-trips both y-zoom factors and rejects a non-numeric one', () => {
    saveWorkspace({ ...workspace, simChartYZoom: 0.5, bankrollChartYZoom: 2 })
    const loaded = loadWorkspace()
    expect(loaded?.simChartYZoom).toBe(0.5)
    expect(loaded?.bankrollChartYZoom).toBe(2)

    store.set(STORAGE_KEY, JSON.stringify({ ...workspace, simChartYZoom: 'wide' }))
    expect(loadWorkspace()).toBeNull()
  })

  it('accepts a workspace saved before the y-zoom factors existed', () => {
    saveWorkspace(workspace)
    const loaded = loadWorkspace()
    expect(loaded?.simChartYZoom).toBeUndefined()
    expect(loaded?.bankrollChartYZoom).toBeUndefined()
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/storage.test.ts`
Expected: FAIL — `isWorkspace` currently ignores these fields but a non-numeric `simChartYZoom` is not yet rejected (the `saveWorkspace`/`loadWorkspace` round trip already passes structurally since `isWorkspace` doesn't check them, so the meaningful failing assertion is the rejection case).

- [ ] **Step 3: Add the fields to `Workspace` and validate them**

In `src/lib/storage.ts`, add to the `Workspace` interface (after `chartHeightAuto`):

```ts
  /** Optional — absent before the chart could fit itself to the table. */
  chartHeightAuto?: boolean
  /** Optional — absent in workspaces saved before the y-axis could be zoomed. */
  simChartYZoom?: number
  bankrollChartYZoom?: number
}
```

Add to the end of `isWorkspace`'s conjunction (after the `chartHeightAuto` check):

```ts
    (v.chartHeightAuto === undefined || typeof v.chartHeightAuto === 'boolean') &&
    (v.simChartYZoom === undefined || isFiniteNumber(v.simChartYZoom)) &&
    (v.bankrollChartYZoom === undefined || isFiniteNumber(v.bankrollChartYZoom))
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/storage.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/storage.ts src/lib/storage.test.ts
git commit -m "feat: persist each simulation chart's y-zoom factor"
```

---

### Task 6: Thread the zoom state end-to-end

**Files:**
- Modify: `src/components/ConvergenceSim.tsx`
- Modify: `src/components/ConvergenceSim.test.tsx`
- Modify: `src/components/BankrollSim.tsx`
- Modify: `src/components/BankrollSim.test.tsx`
- Modify: `src/components/SimulationPanel.tsx`
- Modify: `src/components/SimulationPanel.test.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `SimChart`/`BankrollChart`'s `yZoom`/`onYZoom` props (Tasks 2–3); `clampZoom` (Task 1); `Workspace.simChartYZoom`/`bankrollChartYZoom` (Task 5).
- Produces: `ConvergenceSim` and `BankrollSim` each gain required props `yZoom: number`, `onYZoom: (z: number) => void`. `SimulationPanel` gains required props `simYZoom: number`, `onSimYZoom: (z: number) => void`, `bankrollYZoom: number`, `onBankrollYZoom: (z: number) => void`.

- [ ] **Step 1: Update `ConvergenceSim.tsx`**

Add to `ConvergenceSimProps` (after `onChartHeight`):

```ts
  /** Owned by App and persisted; the panel only passes it through. */
  chartHeight: number
  onChartHeight: (h: number) => void
  /** Owned by App and persisted, like chartHeight — the panel only passes it through. */
  yZoom: number
  onYZoom: (z: number) => void
  createWorker?: () => SimWorkerLike
}
```

Destructure in the function signature:

```ts
export function ConvergenceSim({
  rows,
  totalWeight,
  expectedRtp,
  spins,
  onSpins,
  chartHeight,
  onChartHeight,
  yZoom,
  onYZoom,
  createWorker,
}: ConvergenceSimProps) {
```

Update the `SimChart` call site:

```tsx
      {run !== null ? (
        <SimChart
          points={run.points}
          blockSize={run.blockSize}
          requestedSpins={run.requested}
          expectedRtp={run.expectedRtp}
          height={chartHeight}
          onHeight={onChartHeight}
          yZoom={yZoom}
          onYZoom={onYZoom}
        />
      ) : (
```

- [ ] **Step 2: Update `ConvergenceSim.test.tsx`**

Replace the `renderPanel` helper:

```tsx
function renderPanel(worker?: FakeWorker, spins = 1000) {
  const onSpins = vi.fn()
  render(
    <ConvergenceSim
      rows={rows}
      totalWeight={1_000_000}
      expectedRtp={0.6}
      spins={spins}
      onSpins={onSpins}
      chartHeight={260}
      onChartHeight={vi.fn()}
      yZoom={1}
      onYZoom={vi.fn()}
      createWorker={worker === undefined ? undefined : () => worker}
    />,
  )
  return onSpins
}
```

Append a test to the `describe('ConvergenceSim', ...)` block:

```tsx
  it('shows the y-axis zoom handle once a run has produced a chart', () => {
    const w = new FakeWorker()
    renderPanel(w)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    reply(w, {
      type: 'done',
      agg: { spins: 1000, sum: 950, sumSq: 1805, hits: 250, wins: 250, maxWin: 2 },
    })
    expect(screen.getByRole('slider', { name: "Zoom the simulation chart's y-axis" })).toBeDefined()
  })
```

- [ ] **Step 3: Update `BankrollSim.tsx`**

Add to `BankrollSimProps` (after `onChartHeight`):

```ts
  chartHeight: number
  onChartHeight: (h: number) => void
  /** Owned by App and persisted, like chartHeight — the panel only passes it through. */
  yZoom: number
  onYZoom: (z: number) => void
  createWorker?: () => BankrollWorkerLike
}
```

Destructure:

```ts
export function BankrollSim({
  rows,
  totalWeight,
  tableRtp,
  config,
  onConfig,
  chartHeight,
  onChartHeight,
  yZoom,
  onYZoom,
  createWorker,
}: BankrollSimProps) {
```

Update the `BankrollChart` call site:

```tsx
      {run !== null ? (
        <BankrollChart
          points={run.points}
          startCredits={run.startCredits}
          state={run.state}
          height={chartHeight}
          onHeight={onChartHeight}
          yZoom={yZoom}
          onYZoom={onYZoom}
        />
      ) : (
```

- [ ] **Step 4: Update `BankrollSim.test.tsx`**

Three call sites need the new props.

The `renderSim` helper:

```tsx
function renderSim(
  worker?: FakeWorker,
  config: BankrollConfig = DEFAULT_BANKROLL,
  tableRtp = 0.95,
) {
  const onConfig = vi.fn()
  render(
    <BankrollSim
      rows={rows}
      totalWeight={1_000_000}
      tableRtp={tableRtp}
      config={config}
      onConfig={onConfig}
      chartHeight={260}
      onChartHeight={vi.fn()}
      yZoom={1}
      onYZoom={vi.fn()}
      createWorker={worker === undefined ? undefined : () => worker}
    />,
  )
  return onConfig
}
```

The direct render in `'clicking Run while a chunk is capped terminates the parked worker and starts a fresh one'`:

```tsx
      render(
      <BankrollSim
        rows={rows}
        totalWeight={1_000_000}
        tableRtp={0.95}
        config={DEFAULT_BANKROLL}
        onConfig={vi.fn()}
        chartHeight={260}
        onChartHeight={vi.fn()}
        yZoom={1}
        onYZoom={vi.fn()}
        createWorker={createWorker}
      />,
    )
```

The `props` helper in `'keeps the Biggest Win and RTP tiles pinned to the run after a live Bet edit'`:

```tsx
    const props = (config: BankrollConfig) => ({
      rows,
      totalWeight: 1_000_000,
      tableRtp: 0.95,
      config,
      onConfig,
      chartHeight: 260,
      onChartHeight: vi.fn(),
      yZoom: 1,
      onYZoom: vi.fn(),
      createWorker: () => w,
    })
```

Append a test to the `describe('BankrollSim runs', ...)` block:

```tsx
  it('shows the y-axis zoom handle once a run has produced a chart', () => {
    const w = new FakeWorker()
    renderSim(w)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    reply(w, { type: 'progress', points: [{ spins: 100, balance: 1200 }], state: state() })
    expect(screen.getByRole('slider', { name: "Zoom the bankroll chart's y-axis" })).toBeDefined()
  })
```

- [ ] **Step 5: Update `SimulationPanel.tsx`**

Add to `SimulationPanelProps` (after `onChartHeight`):

```ts
  /** Shared by both modes — one chart slot, one remembered height. */
  chartHeight: number
  onChartHeight: (h: number) => void
  /** Independent per mode — each chart keeps its own zoom. */
  simYZoom: number
  onSimYZoom: (z: number) => void
  bankrollYZoom: number
  onBankrollYZoom: (z: number) => void
  createWorker?: () => SimWorkerLike
  createBankrollWorker?: () => BankrollWorkerLike
}
```

Destructure in the function signature and update the JSX:

```tsx
export function SimulationPanel({
  mode,
  onMode,
  rows,
  totalWeight,
  expectedRtp,
  spins,
  onSpins,
  bankroll,
  onBankroll,
  chartHeight,
  onChartHeight,
  simYZoom,
  onSimYZoom,
  bankrollYZoom,
  onBankrollYZoom,
  createWorker,
  createBankrollWorker,
}: SimulationPanelProps) {
  return (
    <>
      <div className="sim-modes" role="group" aria-label="Simulation mode">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`btn ${mode === m.id ? 'primary' : ''}`}
            aria-pressed={mode === m.id}
            title={m.title}
            onClick={() => onMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode === 'convergence' ? (
        <ConvergenceSim
          rows={rows}
          totalWeight={totalWeight}
          expectedRtp={expectedRtp}
          spins={spins}
          onSpins={onSpins}
          chartHeight={chartHeight}
          onChartHeight={onChartHeight}
          yZoom={simYZoom}
          onYZoom={onSimYZoom}
          createWorker={createWorker}
        />
      ) : (
        <BankrollSim
          rows={rows}
          totalWeight={totalWeight}
          tableRtp={expectedRtp}
          config={bankroll}
          onConfig={onBankroll}
          chartHeight={chartHeight}
          onChartHeight={onChartHeight}
          yZoom={bankrollYZoom}
          onYZoom={onBankrollYZoom}
          createWorker={createBankrollWorker}
        />
      )}
    </>
  )
}
```

- [ ] **Step 6: Update `SimulationPanel.test.tsx`**

Add to the `renderPanel` helper's `<SimulationPanel>` props (after `onChartHeight={vi.fn()}`):

```tsx
      chartHeight={260}
      onChartHeight={vi.fn()}
      simYZoom={1}
      onSimYZoom={vi.fn()}
      bankrollYZoom={1}
      onBankrollYZoom={vi.fn()}
    />,
```

- [ ] **Step 7: Update `App.tsx`**

Change the `chartUtils` import (near line 36):

```ts
import { clampHeight, clampZoom, DIST_HEIGHT, SIM_HEIGHT } from './components/chartUtils'
```

Add state right after `simChartHeight` (near line 144):

```ts
  const [simChartHeight, setSimChartHeight] = useState(() =>
    clampHeight(saved?.simChartHeight ?? SIM_HEIGHT.fallback, SIM_HEIGHT),
  )
  const [simChartYZoom, setSimChartYZoom] = useState(() => clampZoom(saved?.simChartYZoom ?? 1))
  const [bankrollChartYZoom, setBankrollChartYZoom] = useState(() =>
    clampZoom(saved?.bankrollChartYZoom ?? 1),
  )
```

In the persistence `useEffect` (near line 292), add the two fields to the saved object:

```ts
      saveWorkspace({
        version: 1,
        rows: doc.rows,
        groups: doc.groups,
        targets: doc.targets,
        volatility: doc.volatility,
        curve: doc.curve,
        columnWidths,
        chart,
        exportFilename,
        simSpins,
        simMode,
        bankroll,
        weightStep: doc.weightStep,
        chartHeight,
        chartHeightAuto,
        simChartHeight,
        simChartYZoom,
        bankrollChartYZoom,
        targetsCollapsed,
      })
```

and to its dependency array:

```ts
  }, [
    doc,
    columnWidths,
    chart,
    exportFilename,
    simSpins,
    simMode,
    bankroll,
    chartHeight,
    chartHeightAuto,
    simChartHeight,
    simChartYZoom,
    bankrollChartYZoom,
    targetsCollapsed,
  ])
```

Update the `SimulationPanel` call site (near line 833):

```tsx
            <SimulationPanel
              mode={simMode}
              onMode={setSimMode}
              rows={doc.rows}
              totalWeight={totalWeight}
              expectedRtp={achieved.rtp}
              spins={simSpins}
              onSpins={setSimSpins}
              bankroll={bankroll}
              onBankroll={setBankroll}
              chartHeight={simChartHeight}
              onChartHeight={setSimChartHeight}
              simYZoom={simChartYZoom}
              onSimYZoom={setSimChartYZoom}
              bankrollYZoom={bankrollChartYZoom}
              onBankrollYZoom={setBankrollChartYZoom}
            />
```

- [ ] **Step 8: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — every modified test file compiles and passes, and `App.test.tsx` still passes unmodified (it never asserts on `chartHeight`/zoom threading directly, relying on the component-level tests above).

- [ ] **Step 9: Commit**

```bash
git add src/components/ConvergenceSim.tsx src/components/ConvergenceSim.test.tsx src/components/BankrollSim.tsx src/components/BankrollSim.test.tsx src/components/SimulationPanel.tsx src/components/SimulationPanel.test.tsx src/App.tsx
git commit -m "feat: thread each simulation chart's y-zoom state end-to-end"
```

---

### Task 7: Force-stack toggle for the distribution chart

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/storage.ts`
- Modify: `src/lib/storage.test.ts`
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Modify: `src/index.css`

**Interfaces:**
- Produces: `ChartSettings.forceStack: boolean`, default `false` in `DEFAULT_CHART`.

- [ ] **Step 1: Add `forceStack` to `ChartSettings`**

In `src/lib/types.ts`, add to the `ChartSettings` interface (after `groupBars`):

```ts
  /**
   * Group ids drawn as a single aggregated bar instead of their buckets.
   * View state, so it is persisted but not undoable. Never mutated in place —
   * DEFAULT_CHART's empty array is shared by every fresh workspace.
   */
  groupBars: string[]
  /**
   * Forces the distribution chart onto its own line below the buckets table,
   * even when the viewport is wide enough to fit both side by side.
   */
  forceStack: boolean
}
```

and to `DEFAULT_CHART`:

```ts
export const DEFAULT_CHART: ChartSettings = {
  metric: 'weights',
  logY: true,
  logX: false,
  aggregate: true,
  relative: true,
  groupBars: [],
  forceStack: false,
}
```

- [ ] **Step 2: Write the failing storage tests**

Append to `src/lib/storage.test.ts`, inside `describe('storage', ...)`:

```ts
  it('round-trips forceStack and rejects a non-boolean', () => {
    saveWorkspace({ ...workspace, chart: { ...DEFAULT_CHART, forceStack: true } })
    expect(loadWorkspace()?.chart.forceStack).toBe(true)

    store.set(
      STORAGE_KEY,
      JSON.stringify({ ...workspace, chart: { ...DEFAULT_CHART, forceStack: 'yes' } }),
    )
    expect(loadWorkspace()).toBeNull()
  })

  it('accepts a workspace saved before forceStack existed', () => {
    const chart: Record<string, unknown> = { ...DEFAULT_CHART }
    delete chart.forceStack
    store.set(STORAGE_KEY, JSON.stringify({ ...workspace, chart }))
    expect(loadWorkspace()).not.toBeNull()
  })
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/lib/storage.test.ts`
Expected: FAIL — a string `forceStack` is currently accepted by `isChart`.

- [ ] **Step 4: Validate `forceStack` in `isChart`**

In `src/lib/storage.ts`, change:

```ts
function isChart(v: unknown): v is ChartSettings {
  return (
    isObject(v) &&
    (v.metric === 'weights' || v.metric === 'chance') &&
    typeof v.logY === 'boolean' &&
    typeof v.logX === 'boolean' &&
    typeof v.aggregate === 'boolean' &&
    // Optional: absent in workspaces saved before groups could be collapsed.
    (v.groupBars === undefined ||
      (Array.isArray(v.groupBars) && v.groupBars.every((s) => typeof s === 'string')))
  )
}
```

to:

```ts
function isChart(v: unknown): v is ChartSettings {
  return (
    isObject(v) &&
    (v.metric === 'weights' || v.metric === 'chance') &&
    typeof v.logY === 'boolean' &&
    typeof v.logX === 'boolean' &&
    typeof v.aggregate === 'boolean' &&
    // Optional: absent in workspaces saved before groups could be collapsed.
    (v.groupBars === undefined ||
      (Array.isArray(v.groupBars) && v.groupBars.every((s) => typeof s === 'string'))) &&
    // Optional: absent in workspaces saved before the chart could be force-stacked.
    (v.forceStack === undefined || typeof v.forceStack === 'boolean')
  )
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/lib/storage.test.ts`
Expected: PASS

- [ ] **Step 6: Write the failing App test**

In `src/App.test.tsx`, inside the existing `describe('page layout', ...)` block, append:

```tsx
  it('forces the chart below the table when the toggle is pressed', () => {
    loadRealData()
    const toggle = screen.getByRole('button', { name: 'Stack below' })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('.content-row')!.className).toContain('force-stack')
  })
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npx vitest run src/App.test.tsx`
Expected: FAIL — there is no "Stack below" button yet.

- [ ] **Step 8: Add the toggle button and the conditional class in `App.tsx`**

Change:

```tsx
          <div className="content-row" ref={rowRef}>
```

to:

```tsx
          <div className={`content-row${chart.forceStack ? ' force-stack' : ''}`} ref={rowRef}>
```

Change:

```tsx
          <section className="panel chart">
            <div className="panel-head">
              <h2>Distribution</h2>
            </div>
```

to:

```tsx
          <section className="panel chart">
            <div className="panel-head">
              <h2>Distribution</h2>
              <button
                type="button"
                className={`btn ${chart.forceStack ? 'primary' : ''}`}
                aria-pressed={chart.forceStack}
                title="Always show the distribution chart below the table, even if there's room beside it"
                onClick={() => setChart({ ...chart, forceStack: !chart.forceStack })}
              >
                Stack below
              </button>
            </div>
```

- [ ] **Step 9: Add the CSS rule**

In `src/index.css`, add right after the existing `.content-row > .panel.chart` rule (near line 543):

```css
.content-row > .panel.chart {
  flex: 1 1 0;
  min-width: 420px;
}

/* Forces the chart onto its own line however wide the viewport is: an
   oversized basis can never fit beside the table. */
.content-row.force-stack > .panel.chart {
  flex-basis: 100%;
  min-width: 100%;
}
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `npx vitest run src/App.test.tsx`
Expected: PASS

- [ ] **Step 11: Run the full test suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 12: Commit**

```bash
git add src/lib/types.ts src/lib/storage.ts src/lib/storage.test.ts src/App.tsx src/App.test.tsx src/index.css
git commit -m "feat: let the user force the distribution chart below the table"
```

---

### Task 8: Drop the totals row from the export

**Files:**
- Modify: `src/lib/exportTsv.ts`
- Modify: `src/lib/exportTsv.test.ts`

**Interfaces:** None — `buildTsv(rows, totalWeight): string`'s signature is unchanged; only its output shrinks by one line.

- [ ] **Step 1: Update the failing tests**

In `src/lib/exportTsv.test.ts`, replace the acceptance test:

```ts
  it('reproduces example-output-data.tsv exactly', () => {
    const input = parseTsv(INPUT)
    const reference = parseTsv(OUTPUT)

    // Take the buckets from the input file and the weights from the
    // reference output — everything else must be computed.
    const rows = input.rows.map((r, i) => ({ ...r, weight: reference.rows[i].weight }))
    const total = rows.reduce((a, r) => a + r.weight, 0)

    expect(total).toBe(1200350)
    expect(buildTsv(rows, total)).toBe(OUTPUT)
  })
```

with:

```ts
  it('reproduces example-output-data.tsv exactly, minus its totals row', () => {
    const input = parseTsv(INPUT)
    const reference = parseTsv(OUTPUT)

    // Take the buckets from the input file and the weights from the
    // reference output — everything else must be computed. The reference
    // file's own totals row is not part of what this tool exports.
    const rows = input.rows.map((r, i) => ({ ...r, weight: reference.rows[i].weight }))
    const total = rows.reduce((a, r) => a + r.weight, 0)

    expect(total).toBe(1200350)
    const withoutTotalsRow = OUTPUT.split(EOL).slice(0, -1).join(EOL)
    expect(buildTsv(rows, total)).toBe(withoutTotalsRow)
  })
```

Replace the line-count test:

```ts
  it('uses CRLF line endings with no trailing newline', () => {
    const rows = parseTsv(OUTPUT).rows
    const text = buildTsv(rows, 1200350)
    expect(text).toContain('\r\n')
    expect(text.endsWith('\n')).toBe(false)
    expect(text.split('\r\n')).toHaveLength(32) // header + 30 buckets + totals
  })
```

with:

```ts
  it('uses CRLF line endings with no trailing newline', () => {
    const rows = parseTsv(OUTPUT).rows
    const text = buildTsv(rows, 1200350)
    expect(text).toContain('\r\n')
    expect(text.endsWith('\n')).toBe(false)
    expect(text.split('\r\n')).toHaveLength(31) // header + 30 buckets, no totals row
  })
```

Replace the totals-row test:

```ts
  it('writes the totals row with three empty leading fields', () => {
    const rows = parseTsv(OUTPUT).rows
    const totals = buildTsv(rows, 1200350).split('\r\n').at(-1)!
    expect(totals).toBe('\t\t\t1200350\t1.08819261\t1')
  })
```

with:

```ts
  it('carries no totals row', () => {
    const rows = parseTsv(OUTPUT).rows
    const lines = buildTsv(rows, 1200350).split('\r\n')
    expect(lines).toHaveLength(31)
    // the last line is the last bucket, not a blank-leading totals line
    expect(lines.at(-1)!.startsWith('\t\t\t')).toBe(false)
  })
```

Replace the weight-id column test:

```ts
  it('rides as a trailing column as soon as one row has it', () => {
    const tsv = buildTsv([{ ...base, weightId: 'W-7' }, { ...base, uid: 'u2', bucketId: 1 }], 200)
    const lines = tsv.split(EOL)
    expect(lines[0]).toBe(`${EXPORT_HEADER}	Weight ID`)
    expect(lines[1].split('	')).toHaveLength(7)
    expect(lines[1].split('	')[6]).toBe('W-7')
    // the row without one still carries the field, empty
    expect(lines[2].split('	')[6]).toBe('')
    // and so does the totals row, so the column count never varies
    expect(lines[3].split('	')).toHaveLength(7)
  })
```

with:

```ts
  it('rides as a trailing column as soon as one row has it', () => {
    const tsv = buildTsv([{ ...base, weightId: 'W-7' }, { ...base, uid: 'u2', bucketId: 1 }], 200)
    const lines = tsv.split(EOL)
    expect(lines[0]).toBe(`${EXPORT_HEADER}	Weight ID`)
    expect(lines[1].split('	')).toHaveLength(7)
    expect(lines[1].split('	')[6]).toBe('W-7')
    // the row without one still carries the field, empty
    expect(lines[2].split('	')[6]).toBe('')
    // no totals row, so there is nothing after the two bucket lines
    expect(lines).toHaveLength(3)
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/exportTsv.test.ts`
Expected: FAIL — `buildTsv` still appends a totals row.

- [ ] **Step 3: Remove the totals row from `buildTsv`**

In `src/lib/exportTsv.ts`, update the docstring above `buildTsv`:

```ts
/**
 * Render the table as TSV: header, then one line per bucket. No totals row —
 * the export carries buckets only.
 *
 * Computed columns use 10 significant digits, which reproduces
 * `example-output-data.tsv` byte for byte (aside from that reference file's
 * own trailing totals line, which this tool does not write). There is no
 * trailing newline — also matching the reference.
 */
```

and replace the function body:

```ts
export function buildTsv(rows: BucketRow[], totalWeight: number): string {
  const safeTotal = totalWeight > 0 ? totalWeight : 0

  const valueOf = (r: BucketRow) => (safeTotal > 0 ? (r.payout * r.weight) / safeTotal : 0)
  const chanceOf = (r: BucketRow) => (safeTotal > 0 ? r.weight / safeTotal : 0)

  const withWeightId = rows.some((r) => r.weightId !== '')
  const lines = [withWeightId ? `${EXPORT_HEADER}\t${WEIGHT_ID_HEADER}` : EXPORT_HEADER]

  for (const r of rows) {
    const fields = [
      String(r.bucketId),
      fmtPayout(r.payout),
      r.label,
      String(Math.round(r.weight)),
      fmtSig(valueOf(r)),
      fmtSig(chanceOf(r)),
    ]
    if (withWeightId) fields.push(r.weightId)
    lines.push(fields.join('\t'))
  }

  return lines.join(EOL)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/exportTsv.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full test suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/exportTsv.ts src/lib/exportTsv.test.ts
git commit -m "fix: stop exporting a totals row"
```
