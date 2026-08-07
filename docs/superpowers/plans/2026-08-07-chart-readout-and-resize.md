# Chart Readout and Resize Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace both charts' floating tooltip with a fixed readout strip below the plot, make both charts drag-resizable with persisted heights, and state the simulation block size.

**Architecture:** Two new presentational components — `ChartReadout` (below-plot detail strip) and `ChartResizeGrip` (focusable drag handle) — are shared by `DistributionChart` and `SimChart`. Height is view state owned by `App`, persisted in the workspace beside `chart` and `columnWidths`, and clamped by shared range constants in `chartUtils.ts`. The charts' `HEIGHT` constants become props.

**Tech Stack:** React 19, TypeScript, Vite, vitest + jsdom + @testing-library/react. No new dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-07-chart-readout-and-resize-design.md`.
- No new runtime dependencies.
- Every commit must leave `npm run test:run`, `npm run lint` and `npm run build` green.
- Existing comment style: block comments explain *why*, not *what*. Match it.
- Never use scientific notation in a user-visible number — always go through `src/lib/format.ts`.
- Persisted workspace fields added here are **optional** (`?:`), so a workspace saved before this feature still validates. This is the established pattern for `simSpins` and `weightStep`.
- React synthesizes `onMouseEnter` from the native `mouseover` event, so tests must use `fireEvent.mouseOver`, not `fireEvent.mouseEnter`.
- Height range constants and clamping live in `src/components/chartUtils.ts` so `App`, both charts and the grip can import them without a cycle.

---

### Task 1: ChartReadout component

**Files:**
- Create: `src/components/ChartReadout.tsx`
- Create: `src/components/ChartReadout.test.tsx`
- Modify: `src/index.css` (add a new block after the existing `.tt-row b` rule at ~line 843)

**Interfaces:**
- Consumes: nothing.
- Produces: `ChartReadout` component; exported types `ReadoutTitle = { text: string; color?: string }` and `ReadoutStat = { label: string; value: string }`. Tasks 2 and 7 render it.

- [ ] **Step 1: Write the failing test**

Create `src/components/ChartReadout.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ChartReadout } from './ChartReadout'

afterEach(cleanup)

describe('ChartReadout', () => {
  it('shows the hint and no stats when nothing is hovered', () => {
    render(
      <ChartReadout titles={[]} stats={[{ label: 'weight', value: '5' }]} hint="hover a bar" />,
    )
    expect(screen.getByText('hover a bar')).toBeDefined()
    expect(screen.queryByText('weight')).toBeNull()
  })

  it('renders one line per title, each in its own color', () => {
    render(
      <ChartReadout
        titles={[
          { text: 'joker5-maxwin', color: 'var(--series-2)' },
          { text: 'bonus4', color: 'var(--series-1)' },
        ]}
        stats={[]}
        hint="hover"
      />,
    )
    const lines = [...document.querySelectorAll('.readout-title')]
    expect(lines.map((el) => el.textContent)).toEqual(['joker5-maxwin', 'bonus4'])
    expect(lines[0].getAttribute('style')).toContain('--series-2')
    expect(lines[1].getAttribute('style')).toContain('--series-1')
  })

  it('renders every stat as a label/value pair', () => {
    render(
      <ChartReadout
        titles={[{ text: 'a' }]}
        stats={[
          { label: 'weight', value: '420' },
          { label: 'chance', value: '0.42%' },
        ]}
        hint="hover"
      />,
    )
    expect(screen.getByText('weight')).toBeDefined()
    expect(screen.getByText('420')).toBeDefined()
    expect(screen.getByText('chance')).toBeDefined()
    expect(screen.getByText('0.42%')).toBeDefined()
  })

  it('trims a long title list to three lines plus a count', () => {
    const titles = ['a', 'b', 'c', 'd', 'e'].map((text) => ({ text }))
    render(<ChartReadout titles={titles} stats={[]} hint="hover" />)
    expect([...document.querySelectorAll('.readout-title')].map((el) => el.textContent)).toEqual([
      'a',
      'b',
      'c',
    ])
    expect(screen.getByText('+2 more')).toBeDefined()
  })

  it('keeps four titles without trimming', () => {
    const titles = ['a', 'b', 'c', 'd'].map((text) => ({ text }))
    render(<ChartReadout titles={titles} stats={[]} hint="hover" />)
    expect(document.querySelectorAll('.readout-title').length).toBe(4)
    expect(screen.queryByText(/ more$/)).toBeNull()
  })

  it('stays mounted whether or not anything is hovered', () => {
    const { rerender } = render(<ChartReadout titles={[]} stats={[]} hint="hover" />)
    expect(document.querySelector('.chart-readout')).not.toBeNull()
    rerender(<ChartReadout titles={[{ text: 'a' }]} stats={[]} hint="hover" />)
    expect(document.querySelectorAll('.chart-readout').length).toBe(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/ChartReadout.test.tsx`
Expected: FAIL — `Failed to resolve import "./ChartReadout"`.

- [ ] **Step 3: Write the component**

Create `src/components/ChartReadout.tsx`:

```tsx
/**
 * The readout under a chart: whatever the pointer is on, spelled out.
 *
 * It sits below the plot in normal flow rather than floating over it, so it
 * can neither cover the marks being inspected nor be clipped at a panel edge —
 * the two failures of the tooltip it replaces. Its height is fixed and it is
 * always mounted, so moving between marks never reflows the page; with nothing
 * hovered it shows `hint`.
 */

export interface ReadoutTitle {
  text: string
  /** CSS color, e.g. 'var(--series-2)'. Omitted → the default text color. */
  color?: string
}

export interface ReadoutStat {
  label: string
  value: string
}

interface ChartReadoutProps {
  /** One line each. Empty → the hint is shown instead. */
  titles: ReadoutTitle[]
  stats: ReadoutStat[]
  hint: string
}

/** Past this the tail is folded into a "+N more" line, so the box stays fixed. */
const MAX_TITLES = 4

export function ChartReadout({ titles, stats, hint }: ChartReadoutProps) {
  const overflow = titles.length > MAX_TITLES ? titles.length - (MAX_TITLES - 1) : 0
  const shown = overflow > 0 ? titles.slice(0, MAX_TITLES - 1) : titles

  return (
    <div className="chart-readout">
      {titles.length === 0 ? (
        <span className="readout-hint">{hint}</span>
      ) : (
        <>
          <div className="readout-titles">
            {shown.map((t, i) => (
              <div key={i} className="readout-title" style={{ color: t.color }} title={t.text}>
                {t.text}
              </div>
            ))}
            {overflow > 0 && <div className="readout-more">+{overflow} more</div>}
          </div>
          <div className="readout-stats">
            {stats.map((s) => (
              <div key={s.label} className="readout-stat">
                <span>{s.label}</span>
                <b>{s.value}</b>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/ChartReadout.test.tsx`
Expected: PASS, 6 tests.

- [ ] **Step 5: Add the styles**

In `src/index.css`, immediately after the existing `.tt-row b { ... }` rule, add:

```css
/* The readout sits under the plot, never over it: it spans the panel so no
   edge can clip it, and its height is fixed so hovering never reflows. */
.chart-readout {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  height: 78px;
  margin: 2px 6px 0;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: var(--surface-alt);
  overflow: hidden;
  pointer-events: none;
}

.readout-hint {
  font-size: 12px;
  color: var(--text-faint);
}

.readout-titles {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.readout-title {
  font-size: 12px;
  font-weight: 600;
  line-height: 16px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.readout-more {
  font-size: 11px;
  line-height: 16px;
  color: var(--text-faint);
}

.readout-stats {
  display: grid;
  grid-template-columns: auto auto;
  gap: 2px 18px;
  flex: none;
}

.readout-stat {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
  color: var(--text-dim);
}

.readout-stat b {
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 6: Commit**

```bash
git add src/components/ChartReadout.tsx src/components/ChartReadout.test.tsx src/index.css
git commit -m "feat: chart readout strip that sits below the plot"
```

---

### Task 2: Distribution chart adopts the readout

**Files:**
- Modify: `src/components/DistributionChart.tsx` (imports; the tooltip JSX block at lines 588-612)
- Modify: `src/components/DistributionChart.test.tsx` (append a describe block)

**Interfaces:**
- Consumes: `ChartReadout`, `ReadoutTitle` from Task 1.
- Produces: nothing new. The chart's props are unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `src/components/DistributionChart.test.tsx`:

```tsx
/** The readout's label/value pairs, as a plain object. */
const readoutStats = (): Record<string, string> =>
  Object.fromEntries(
    [...document.querySelectorAll('.readout-stat')].map((el) => [
      el.querySelector('span')!.textContent,
      el.querySelector('b')!.textContent,
    ]),
  )

describe('DistributionChart readout', () => {
  it('shows the hint until a bar is hovered', () => {
    renderChart({ metric: 'weights' })
    expect(screen.getByText('hover a bar for its numbers')).toBeDefined()
    expect(document.querySelectorAll('.readout-title')).toHaveLength(0)
  })

  it('names the hovered bucket in its group color', () => {
    renderChart({ metric: 'weights' })
    // bars run in ascending payout: 0x, 0-1x, bonus3, bonus4
    fireEvent.mouseOver(document.querySelectorAll('.bar-hit')[2])
    const line = document.querySelector('.readout-title')!
    expect(line.textContent).toBe('bonus3')
    expect(line.getAttribute('style')).toContain('--series-1')
  })

  it('gives each bucket of an aggregated bar its own colored line', () => {
    const rows: BucketRow[] = [
      { uid: 'x', bucketId: 0, payout: 5, label: 'hp-fullscreen', weight: 100, locked: false },
      { uid: 'y', bucketId: 1, payout: 5, label: 'bonus9', weight: 100, locked: false },
    ]
    renderChart({ metric: 'weights', aggregate: true }, rows)
    fireEvent.mouseOver(document.querySelector('.bar-hit')!)
    const lines = [...document.querySelectorAll('.readout-title')]
    expect(lines.map((el) => el.textContent)).toEqual(['hp-fullscreen', 'bonus9'])
    expect(lines[0].getAttribute('style')).not.toBe(lines[1].getAttribute('style'))
  })

  it('reports payout, weight, chance and the weighted value', () => {
    renderChart({ metric: 'weights' })
    fireEvent.mouseOver(document.querySelectorAll('.bar-hit')[3]) // ×100, weight 50,000 of 1,000,000
    expect(readoutStats()).toEqual({
      payout: '×100',
      weight: '50,000',
      chance: '5%',
      weighted: '5.0000',
    })
  })

  it('no longer offers a drag row', () => {
    renderChart({ metric: 'weights' })
    fireEvent.mouseOver(document.querySelectorAll('.bar-hit')[3])
    expect(screen.queryByText('drag')).toBeNull()
    expect(screen.queryByText('↑↓')).toBeNull()
  })

  it('returns to the hint when the pointer leaves the bar', () => {
    renderChart({ metric: 'weights' })
    const hit = document.querySelectorAll('.bar-hit')[3]
    fireEvent.mouseOver(hit)
    expect(document.querySelectorAll('.readout-title')).toHaveLength(1)
    fireEvent.mouseOut(hit)
    expect(screen.getByText('hover a bar for its numbers')).toBeDefined()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/DistributionChart.test.tsx`
Expected: FAIL — `Unable to find an element with the text: hover a bar for its numbers`.

- [ ] **Step 3: Replace the tooltip with the readout**

In `src/components/DistributionChart.tsx`, add to the imports:

```tsx
import { ChartReadout, type ReadoutStat, type ReadoutTitle } from './ChartReadout'
```

Just below the existing `const hovered = ...` line, add the derivations:

```tsx
  /**
   * Labels are colored per bucket, not per bar segment: segments are merged by
   * group and reordered by rank, so an aggregated bar spanning two groups has
   * to look each bucket's color up by uid to keep line and color in step.
   */
  const readoutTitles: ReadoutTitle[] =
    hovered === null
      ? []
      : hovered.labels.map((text, i) => ({
          text,
          color: grouping.byUid.get(hovered.uids[i])?.color,
        }))

  const readoutStats: ReadoutStat[] =
    hovered === null
      ? []
      : [
          { label: 'payout', value: `×${fmtPayout(hovered.payout)}` },
          { label: 'weight', value: fmtWeight(hovered.weight) },
          { label: 'chance', value: fmtPct(hovered.chance, 4) },
          // The bar's slice of RTP — the table's Weighted Value column.
          { label: 'weighted', value: fmtRtp(hovered.payout * hovered.chance) },
        ]
```

Delete the entire `{hovered && hover !== null && ( ... )}` block (lines 588-612) and put in its place:

```tsx
            <ChartReadout
              titles={readoutTitles}
              stats={readoutStats}
              hint="hover a bar for its numbers"
            />
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components/DistributionChart.test.tsx`
Expected: PASS — the 6 new tests plus the 11 existing ones.

- [ ] **Step 5: Commit**

```bash
git add src/components/DistributionChart.tsx src/components/DistributionChart.test.tsx
git commit -m "feat: distribution readout replaces the overlaying tooltip"
```

---

### Task 3: Height ranges and clamping

**Files:**
- Modify: `src/components/chartUtils.ts`
- Modify: `src/components/chartUtils.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface HeightRange { min: number; max: number; fallback: number }`
  - `const DIST_HEIGHT: HeightRange` = `{ min: 220, max: 900, fallback: 340 }`
  - `const SIM_HEIGHT: HeightRange` = `{ min: 160, max: 800, fallback: 260 }`
  - `clampHeight(h: number, r: HeightRange): number` — rounds, then clamps.

  Tasks 4, 5, 6, 7 and 8 all import from here.

- [ ] **Step 1: Write the failing test**

Append to `src/components/chartUtils.test.ts`:

```ts
describe('clampHeight', () => {
  it('keeps a height inside the range', () => {
    expect(clampHeight(400, DIST_HEIGHT)).toBe(400)
  })

  it('clamps below the floor and above the ceiling', () => {
    expect(clampHeight(10, DIST_HEIGHT)).toBe(220)
    expect(clampHeight(99_999, DIST_HEIGHT)).toBe(900)
    expect(clampHeight(10, SIM_HEIGHT)).toBe(160)
    expect(clampHeight(99_999, SIM_HEIGHT)).toBe(800)
  })

  it('rounds fractional heights', () => {
    expect(clampHeight(340.6, DIST_HEIGHT)).toBe(341)
  })

  it('falls back inside its own range', () => {
    expect(clampHeight(DIST_HEIGHT.fallback, DIST_HEIGHT)).toBe(DIST_HEIGHT.fallback)
    expect(clampHeight(SIM_HEIGHT.fallback, SIM_HEIGHT)).toBe(SIM_HEIGHT.fallback)
  })
})
```

Add `clampHeight`, `DIST_HEIGHT` and `SIM_HEIGHT` to that file's existing import from `./chartUtils`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/chartUtils.test.ts`
Expected: FAIL — `clampHeight is not a function` / `DIST_HEIGHT is not defined`.

- [ ] **Step 3: Add the constants and the helper**

Append to `src/components/chartUtils.ts`:

```ts
/**
 * Chart height is user-set and persisted, so it arrives from localStorage
 * unvalidated. Clamping on the way in as well as on every drag keeps a
 * hand-edited workspace from producing a 5px or a 50,000px chart.
 */
export interface HeightRange {
  min: number
  max: number
  /** Restored by Home and by double-clicking the grip. */
  fallback: number
}

export const DIST_HEIGHT: HeightRange = { min: 220, max: 900, fallback: 340 }
export const SIM_HEIGHT: HeightRange = { min: 160, max: 800, fallback: 260 }

export function clampHeight(h: number, r: HeightRange): number {
  if (!Number.isFinite(h)) return r.fallback
  return Math.min(Math.max(Math.round(h), r.min), r.max)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/chartUtils.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/chartUtils.ts src/components/chartUtils.test.ts
git commit -m "feat: shared chart height ranges and clamping"
```

---

### Task 4: ChartResizeGrip component

**Files:**
- Create: `src/components/ChartResizeGrip.tsx`
- Create: `src/components/ChartResizeGrip.test.tsx`
- Modify: `src/index.css` (append after the `.readout-stat b` rule from Task 1)

**Interfaces:**
- Consumes: `HeightRange`, `clampHeight` from Task 3.
- Produces: `ChartResizeGrip` with props `{ height: number; range: HeightRange; label: string; onHeight: (h: number) => void }`. Tasks 6 and 8 render it.

- [ ] **Step 1: Write the failing test**

Create `src/components/ChartResizeGrip.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChartResizeGrip } from './ChartResizeGrip'
import { DIST_HEIGHT } from './chartUtils'

afterEach(cleanup)

function renderGrip(height: number) {
  const onHeight = vi.fn()
  render(
    <ChartResizeGrip
      height={height}
      range={DIST_HEIGHT}
      label="Resize chart"
      onHeight={onHeight}
    />,
  )
  return { grip: screen.getByRole('separator', { name: 'Resize chart' }), onHeight }
}

const last = (fn: ReturnType<typeof vi.fn>) =>
  fn.mock.calls[fn.mock.calls.length - 1][0] as number

describe('ChartResizeGrip', () => {
  it('grows the chart when dragged down and shrinks it when dragged up', () => {
    const { grip, onHeight } = renderGrip(300)
    fireEvent.pointerDown(grip, { pointerId: 1, clientY: 100 })
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 160 })
    expect(last(onHeight)).toBe(360)
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 60 })
    expect(last(onHeight)).toBe(260)
    fireEvent.pointerUp(grip, { pointerId: 1, clientY: 60 })
  })

  it('ignores pointer movement once the drag has ended', () => {
    const { grip, onHeight } = renderGrip(300)
    fireEvent.pointerDown(grip, { pointerId: 1, clientY: 100 })
    fireEvent.pointerUp(grip, { pointerId: 1, clientY: 100 })
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 400 })
    expect(onHeight).not.toHaveBeenCalled()
  })

  it('clamps a drag to the range', () => {
    const { grip, onHeight } = renderGrip(300)
    fireEvent.pointerDown(grip, { pointerId: 1, clientY: 100 })
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 5000 })
    expect(last(onHeight)).toBe(900)
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: -5000 })
    expect(last(onHeight)).toBe(220)
  })

  it('resizes from the keyboard', () => {
    const { grip, onHeight } = renderGrip(300)
    fireEvent.keyDown(grip, { key: 'ArrowDown' })
    expect(last(onHeight)).toBe(316)
    fireEvent.keyDown(grip, { key: 'ArrowUp' })
    expect(last(onHeight)).toBe(284)
    fireEvent.keyDown(grip, { key: 'PageDown' })
    expect(last(onHeight)).toBe(364)
    fireEvent.keyDown(grip, { key: 'PageUp' })
    expect(last(onHeight)).toBe(236)
  })

  it('clamps keyboard resizing at the floor', () => {
    const { grip, onHeight } = renderGrip(224)
    fireEvent.keyDown(grip, { key: 'ArrowUp' })
    expect(last(onHeight)).toBe(220)
  })

  it('restores the default on Home and on double-click', () => {
    const { grip, onHeight } = renderGrip(500)
    fireEvent.keyDown(grip, { key: 'Home' })
    expect(last(onHeight)).toBe(340)
    fireEvent.doubleClick(grip)
    expect(last(onHeight)).toBe(340)
  })

  it('exposes the current height to assistive tech', () => {
    const { grip } = renderGrip(412)
    expect(grip.getAttribute('aria-valuenow')).toBe('412')
    expect(grip.getAttribute('aria-valuemin')).toBe('220')
    expect(grip.getAttribute('aria-valuemax')).toBe('900')
    expect(grip.getAttribute('tabindex')).toBe('0')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/ChartResizeGrip.test.tsx`
Expected: FAIL — `Failed to resolve import "./ChartResizeGrip"`.

- [ ] **Step 3: Write the component**

Create `src/components/ChartResizeGrip.tsx`:

```tsx
import { useRef } from 'react'
import { clampHeight, type HeightRange } from './chartUtils'

/**
 * Drag handle under a chart: pull down to make it taller.
 *
 * The height itself belongs to the caller — it is persisted with the rest of
 * the view state — so the grip holds nothing but the live pointer session and
 * there is no local copy to drift out of step. A pointer-only resize would be
 * unreachable from the keyboard, so the grip is a focusable separator with
 * arrow, page and Home bindings as well.
 */

interface ChartResizeGripProps {
  height: number
  range: HeightRange
  label: string
  onHeight: (h: number) => void
}

const STEP = 16
const PAGE = 64

export function ChartResizeGrip({ height, range, label, onHeight }: ChartResizeGripProps) {
  const drag = useRef<{ startY: number; startHeight: number } | null>(null)

  const keyDelta = (key: string): number => {
    if (key === 'ArrowDown') return STEP
    if (key === 'ArrowUp') return -STEP
    if (key === 'PageDown') return PAGE
    if (key === 'PageUp') return -PAGE
    return 0
  }

  return (
    <div
      className="chart-grip"
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      aria-valuenow={height}
      aria-valuemin={range.min}
      aria-valuemax={range.max}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
        drag.current = { startY: e.clientY, startHeight: height }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (d === null) return
        onHeight(clampHeight(d.startHeight + (e.clientY - d.startY), range))
      }}
      onPointerUp={() => {
        drag.current = null
      }}
      onPointerCancel={() => {
        drag.current = null
      }}
      onDoubleClick={() => onHeight(range.fallback)}
      onKeyDown={(e) => {
        const delta = keyDelta(e.key)
        if (delta !== 0) {
          e.preventDefault()
          onHeight(clampHeight(height + delta, range))
        } else if (e.key === 'Home') {
          e.preventDefault()
          onHeight(range.fallback)
        }
      }}
    >
      <span className="chart-grip-bar" aria-hidden="true" />
    </div>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/ChartResizeGrip.test.tsx`
Expected: PASS, 7 tests.

- [ ] **Step 5: Add the styles**

In `src/index.css`, after the `.readout-stat b` rule, add:

```css
/* touch-action: none, or a touch drag scrolls the page instead of resizing. */
.chart-grip {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 12px;
  margin: 2px 6px 2px;
  border-radius: 4px;
  cursor: ns-resize;
  touch-action: none;
  outline: none;
}

.chart-grip-bar {
  width: 44px;
  height: 3px;
  border-radius: 2px;
  background: var(--line);
}

.chart-grip:hover .chart-grip-bar,
.chart-grip:focus-visible .chart-grip-bar {
  background: var(--line-strong);
}

.chart-grip:focus-visible {
  box-shadow: 0 0 0 2px var(--accent-soft);
}
```

- [ ] **Step 6: Commit**

```bash
git add src/components/ChartResizeGrip.tsx src/components/ChartResizeGrip.test.tsx src/index.css
git commit -m "feat: draggable, keyboard-operable chart resize grip"
```

---

### Task 5: Persist both chart heights

**Files:**
- Modify: `src/lib/storage.ts` (the `Workspace` interface and `isWorkspace`)
- Modify: `src/lib/storage.test.ts` (append two tests)

**Interfaces:**
- Consumes: nothing.
- Produces: `Workspace.chartHeight?: number` and `Workspace.simChartHeight?: number`. Tasks 6 and 8 read and write them from `App`.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe('storage', ...)` block in `src/lib/storage.test.ts`:

```ts
  it('round-trips both chart heights', () => {
    saveWorkspace({ ...workspace, chartHeight: 520, simChartHeight: 300 })
    const loaded = loadWorkspace()
    expect(loaded?.chartHeight).toBe(520)
    expect(loaded?.simChartHeight).toBe(300)
  })

  it('accepts a heightless workspace but rejects a non-numeric height', () => {
    saveWorkspace(workspace)
    expect(loadWorkspace()).toEqual(workspace)

    store.set(STORAGE_KEY, JSON.stringify({ ...workspace, chartHeight: 'tall' }))
    expect(loadWorkspace()).toBeNull()

    store.set(STORAGE_KEY, JSON.stringify({ ...workspace, simChartHeight: null }))
    expect(loadWorkspace()).toBeNull()
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/storage.test.ts`
Expected: FAIL — TypeScript rejects `chartHeight` as an unknown property, and the `'tall'` case loads instead of returning null.

- [ ] **Step 3: Extend the schema**

In `src/lib/storage.ts`, add to the `Workspace` interface after `weightStep`:

```ts
  /** Optional — absent in workspaces saved before charts could be resized. */
  chartHeight?: number
  simChartHeight?: number
```

And in `isWorkspace`, add two clauses before the closing paren:

```ts
    (v.chartHeight === undefined || isFiniteNumber(v.chartHeight)) &&
    (v.simChartHeight === undefined || isFiniteNumber(v.simChartHeight))
```

(The existing final clause is the `weightStep` check — append `&&` to it and add these after.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/storage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/storage.ts src/lib/storage.test.ts
git commit -m "feat: persist chart heights in the workspace"
```

---

### Task 6: Resizable distribution chart

**Files:**
- Modify: `src/components/DistributionChart.tsx` (drop `const HEIGHT = 340`, add props, render the grip)
- Modify: `src/components/DistributionChart.test.tsx` (the `renderChart` helper + one test)
- Modify: `src/App.tsx` (height state, persistence, prop wiring)

**Interfaces:**
- Consumes: `ChartResizeGrip` (Task 4), `DIST_HEIGHT` / `clampHeight` (Task 3), `Workspace.chartHeight` (Task 5).
- Produces: `DistributionChart` gains required props `height: number` and `onHeight: (h: number) => void`.

- [ ] **Step 1: Write the failing test**

In `src/components/DistributionChart.test.tsx`, change the `renderChart` helper to take and pass a height, and return `onHeight`:

```tsx
function renderChart(chart: Partial<ChartSettings>, rows = baseRows(), height = 340) {
  const onChart = vi.fn()
  const onPreview = vi.fn()
  const onCommit = vi.fn()
  const onDragBlocked = vi.fn()
  const onHeight = vi.fn()
  const total = rows.reduce((a, r) => a + r.weight, 0)
  render(
    <DistributionChart
      rows={rows}
      totalWeight={total}
      chart={{ ...DEFAULT_CHART, logY: false, aggregate: false, ...chart }}
      grouping={groupRows(rows)}
      weightStep={1}
      height={height}
      onChart={onChart}
      onPreview={onPreview}
      onCommit={onCommit}
      onDragBlocked={onDragBlocked}
      onHeight={onHeight}
    />,
  )
  return { onChart, onPreview, onCommit, onDragBlocked, onHeight, rows, total }
}
```

Then append:

```tsx
describe('DistributionChart height', () => {
  it('draws at the height it is given', () => {
    renderChart({ metric: 'weights' }, baseRows(), 500)
    expect(document.querySelector('svg')!.getAttribute('height')).toBe('500')
  })

  it('reports a new height when the grip is dragged', () => {
    const { onHeight } = renderChart({ metric: 'weights' }, baseRows(), 340)
    const grip = screen.getByRole('separator', { name: 'Resize the distribution chart' })
    fireEvent.pointerDown(grip, { pointerId: 1, clientY: 0 })
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 60 })
    expect(onHeight).toHaveBeenLastCalledWith(400)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/DistributionChart.test.tsx`
Expected: FAIL — the svg renders at 340 regardless, and no separator named "Resize the distribution chart" exists.

- [ ] **Step 3: Make the chart height a prop and add the grip**

In `src/components/DistributionChart.tsx`:

1. Add to the imports:

```tsx
import { ChartResizeGrip } from './ChartResizeGrip'
import { DIST_HEIGHT, linearBarWidth, logBarWidth, niceCeil, useContainerWidth } from './chartUtils'
```

(replacing the existing `chartUtils` import line).

2. Add to `DistributionChartProps`, after `weightStep`:

```tsx
  height: number
```

and after `onChart`:

```tsx
  onHeight: (h: number) => void
```

3. Delete `const HEIGHT = 340`.

4. Add `height` and `onHeight` to the destructured parameter list of `DistributionChart`.

5. Replace the three remaining uses of `HEIGHT` with `height`:

```tsx
  const plotH = height - MARGIN.top - MARGIN.bottom
```
```tsx
            <svg width={width} height={height} role="img" aria-label="Bucket distribution" ref={svgRef}>
```
```tsx
                    y={height - MARGIN.bottom + 18}
```
```tsx
                y={height - 8}
```

6. Directly after the `<ChartReadout ... />` element added in Task 2, add:

```tsx
            <ChartResizeGrip
              height={height}
              range={DIST_HEIGHT}
              label="Resize the distribution chart"
              onHeight={onHeight}
            />
```

- [ ] **Step 4: Wire it through App**

In `src/App.tsx`:

1. Add to the imports:

```tsx
import { clampHeight, DIST_HEIGHT } from './components/chartUtils'
```

2. After the `const [chart, setChart] = useState<ChartSettings>(...)` declaration, add:

```tsx
  // Clamped on the way in as well as on drag — the stored value is user data.
  const [chartHeight, setChartHeight] = useState(() =>
    clampHeight(saved?.chartHeight ?? DIST_HEIGHT.fallback, DIST_HEIGHT),
  )
```

3. In the `saveWorkspace({...})` call, add `chartHeight,` after `weightStep: doc.weightStep,`, and add `chartHeight` to that effect's dependency array.

4. On the `<DistributionChart .../>` element, add:

```tsx
            height={chartHeight}
            onHeight={setChartHeight}
```

- [ ] **Step 5: Run the full suite**

Run: `npm run test:run`
Expected: PASS — all files, including `App.test.tsx`.

- [ ] **Step 6: Typecheck and lint**

Run: `npm run build && npm run lint`
Expected: both succeed with no errors.

- [ ] **Step 7: Commit**

```bash
git add src/components/DistributionChart.tsx src/components/DistributionChart.test.tsx src/App.tsx
git commit -m "feat: drag the distribution chart taller, height persisted"
```

---

### Task 7: Simulation readout and block size

**Files:**
- Modify: `src/components/SimChart.tsx` (legend, hit rect class, tooltip → readout)
- Create: `src/components/SimChart.test.tsx`
- Modify: `src/index.css` (delete the now-dead `.chart-tooltip` / `.tt-*` rules)

**Interfaces:**
- Consumes: `ChartReadout`, `ReadoutStat` (Task 1).
- Produces: nothing new; `SimChart`'s props are unchanged in this task.

- [ ] **Step 1: Write the failing test**

Create `src/components/SimChart.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SimChart } from './SimChart'

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

afterEach(cleanup)

/** 1000 spins in blocks of 400 → the third block runs short at 200. */
function renderSim() {
  render(
    <SimChart points={[1.5, 0.5, 1.0]} blockSize={400} requestedSpins={1000} expectedRtp={0.95} />,
  )
}

const readoutStats = (): Record<string, string> =>
  Object.fromEntries(
    [...document.querySelectorAll('.readout-stat')].map((el) => [
      el.querySelector('span')!.textContent,
      el.querySelector('b')!.textContent,
    ]),
  )

/**
 * jsdom reports a zero-origin bounding rect, so clientX is the plot-local x.
 * plotW is 900 - 64 - 74 = 762, so x = 762 lands on the final block.
 */
const hoverAt = (clientX: number) =>
  fireEvent.mouseMove(document.querySelector('.sim-hit')!, { clientX })

describe('SimChart', () => {
  it('states the block size in the legend', () => {
    renderSim()
    expect(screen.getByText(/block avg · 400 spins each/)).toBeDefined()
  })

  it('shows the hint until the chart is hovered', () => {
    renderSim()
    expect(screen.getByText('hover the chart for block detail')).toBeDefined()
  })

  it('reports the hovered block, including a short final block', () => {
    renderSim()
    hoverAt(762)
    expect(document.querySelector('.readout-title')!.textContent).toBe('1,000 spins')
    expect(readoutStats()).toEqual({
      block: '200 spins',
      'block avg': '1.0000',
      'RTP so far': '1.0000',
      'table RTP': '0.9500',
    })
  })

  it('reports a full block at full size', () => {
    renderSim()
    hoverAt(300)
    expect(readoutStats().block).toBe('400 spins')
    expect(readoutStats()['block avg']).toBe('1.5000')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/SimChart.test.tsx`
Expected: FAIL — no `.sim-hit` element and no legend text matching `block avg · 400 spins each`.

- [ ] **Step 3: Update SimChart**

In `src/components/SimChart.tsx`:

1. Replace the import block with:

```tsx
import { useMemo, useState } from 'react'
import { ChartReadout, type ReadoutStat } from './ChartReadout'
import { fmtCompact, niceCeil, useContainerWidth } from './chartUtils'
import { fmtRtp, fmtWeight } from '../lib/format'
```

2. Change the noise legend item to name the block size:

```tsx
        <span className="legend-item">
          <span className="legend-line noise" /> block avg · {fmtWeight(blockSize)} spins each
        </span>
```

3. Give the hover target a class so tests and future styling can find it — on the trailing transparent `<rect>`:

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
```

4. Just before the `return (`, add the readout derivations:

```tsx
  const readoutStats: ReadoutStat[] =
    h === null
      ? []
      : [
          // The plan ceilings the block size, so the final block runs short —
          // report what this block actually covered, not the nominal size.
          { label: 'block', value: `${fmtWeight(spinsOf(h))} spins` },
          { label: 'block avg', value: fmtRtp(points[h]) },
          { label: 'RTP so far', value: fmtRtp(cumulative[h]) },
          { label: 'table RTP', value: fmtRtp(expectedRtp) },
        ]
```

5. Delete the entire `{h !== null && ( <div className="chart-tooltip" ...> ... )}` block after `</svg>` and put in its place:

```tsx
      <ChartReadout
        titles={h === null ? [] : [{ text: `${fmtWeight(spinsAt[h])} spins` }]}
        stats={readoutStats}
        hint="hover the chart for block detail"
      />
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/SimChart.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 5: Delete the dead tooltip styles**

In `src/index.css`, delete the `.chart-tooltip`, `.tt-payout`, `.tt-labels`, `.tt-row` and `.tt-row b` rules (the block that used to sit just before the readout styles). Confirm nothing still references them:

Run: `npx vitest run 2>/dev/null; grep -rn "chart-tooltip\|tt-payout\|tt-labels\|tt-row" src/`
Expected: no matches.

- [ ] **Step 6: Commit**

```bash
git add src/components/SimChart.tsx src/components/SimChart.test.tsx src/index.css
git commit -m "feat: simulation readout reports block size, replacing the tooltip"
```

---

### Task 8: Resizable simulation chart

**Files:**
- Modify: `src/components/SimChart.tsx` (drop `const HEIGHT = 260`, add props, render the grip)
- Modify: `src/components/SimChart.test.tsx` (helper + one test)
- Modify: `src/components/SimulationPanel.tsx` (thread the height through)
- Modify: `src/App.tsx` (state, persistence, prop wiring)

**Interfaces:**
- Consumes: `ChartResizeGrip` (Task 4), `SIM_HEIGHT` / `clampHeight` (Task 3), `Workspace.simChartHeight` (Task 5).
- Produces: `SimChart` gains required props `height: number` / `onHeight: (h: number) => void`; `SimulationPanel` gains required props `chartHeight: number` / `onChartHeight: (h: number) => void` and passes them straight down.

- [ ] **Step 1: Write the failing test**

In `src/components/SimChart.test.tsx`, change the helper to take a height and return the spy:

```tsx
function renderSim(height = 260) {
  const onHeight = vi.fn()
  render(
    <SimChart
      points={[1.5, 0.5, 1.0]}
      blockSize={400}
      requestedSpins={1000}
      expectedRtp={0.95}
      height={height}
      onHeight={onHeight}
    />,
  )
  return onHeight
}
```

Add `vi` to the `vitest` import. Then append:

```tsx
describe('SimChart height', () => {
  it('draws at the height it is given', () => {
    renderSim(420)
    expect(document.querySelector('svg')!.getAttribute('height')).toBe('420')
  })

  it('reports a new height when the grip is dragged', () => {
    const onHeight = renderSim(260)
    const grip = screen.getByRole('separator', { name: 'Resize the simulation chart' })
    fireEvent.pointerDown(grip, { pointerId: 1, clientY: 0 })
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 40 })
    expect(onHeight).toHaveBeenLastCalledWith(300)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/SimChart.test.tsx`
Expected: FAIL — the svg is 260 regardless, and no such separator exists.

- [ ] **Step 3: Make the sim chart height a prop and add the grip**

In `src/components/SimChart.tsx`:

1. Add to the imports:

```tsx
import { ChartResizeGrip } from './ChartResizeGrip'
import { fmtCompact, niceCeil, SIM_HEIGHT, useContainerWidth } from './chartUtils'
```

(replacing the existing `chartUtils` import line).

2. Add to `SimChartProps`:

```tsx
  height: number
  onHeight: (h: number) => void
```

3. Delete `const HEIGHT = 260` and add `height` and `onHeight` to the destructured parameters.

4. Replace the four uses of `HEIGHT` with `height`: `plotH`, the `<svg height=...>`, the x-tick label `y={height - MARGIN.bottom + 18}`, and the axis title `y={height - 8}`.

5. After the `<ChartReadout ... />` element, add:

```tsx
      <ChartResizeGrip
        height={height}
        range={SIM_HEIGHT}
        label="Resize the simulation chart"
        onHeight={onHeight}
      />
```

- [ ] **Step 4: Thread it through SimulationPanel**

In `src/components/SimulationPanel.tsx`, add to `SimulationPanelProps`:

```tsx
  /** Owned by App and persisted; the panel only passes it through. */
  chartHeight: number
  onChartHeight: (h: number) => void
```

Add `chartHeight` and `onChartHeight` to the destructured parameters, and pass them on:

```tsx
        <SimChart
          points={run.points}
          blockSize={run.blockSize}
          requestedSpins={run.requested}
          expectedRtp={run.expectedRtp}
          height={chartHeight}
          onHeight={onChartHeight}
        />
```

- [ ] **Step 5: Update the SimulationPanel test helper**

In `src/components/SimulationPanel.test.tsx`, add the two props to the `renderPanel` helper's `<SimulationPanel>`:

```tsx
      chartHeight={260}
      onChartHeight={vi.fn()}
```

- [ ] **Step 6: Wire it through App**

In `src/App.tsx`:

1. Extend the chartUtils import:

```tsx
import { clampHeight, DIST_HEIGHT, SIM_HEIGHT } from './components/chartUtils'
```

2. Below `chartHeight`, add:

```tsx
  const [simChartHeight, setSimChartHeight] = useState(() =>
    clampHeight(saved?.simChartHeight ?? SIM_HEIGHT.fallback, SIM_HEIGHT),
  )
```

3. Add `simChartHeight,` to the `saveWorkspace({...})` payload and to that effect's dependency array.

4. On `<SimulationPanel .../>`, add:

```tsx
              chartHeight={simChartHeight}
              onChartHeight={setSimChartHeight}
```

- [ ] **Step 7: Run the full suite, typecheck and lint**

Run: `npm run test:run && npm run build && npm run lint`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/components/SimChart.tsx src/components/SimChart.test.tsx src/components/SimulationPanel.tsx src/components/SimulationPanel.test.tsx src/App.tsx
git commit -m "feat: drag the simulation chart taller, height persisted"
```

---

### Task 9: Documentation

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the finished feature.
- Produces: nothing.

- [ ] **Step 1: Read the README's chart section**

Run: `grep -n "chart\|Chart\|tooltip\|hover" README.md`

Identify the section describing the distribution chart controls and the simulation panel.

- [ ] **Step 2: Update the prose**

In the distribution-chart section, replace any description of a hover tooltip with a description of the readout, and document the grip. Add text equivalent to:

> Hovering a bar fills the **readout** below the chart: every bucket in the bar
> on its own line in its group color, then the bar's payout, weight, chance and
> weighted value (its share of RTP). The readout sits under the plot rather
> than over it, so it never hides the bars it describes.
>
> Drag the **grip** below either chart to make it taller — or focus it and use
> ↑/↓, PageUp/PageDown, or Home to reset. Both heights are remembered with the
> rest of the workspace.

In the simulation section, note that the legend states the block size and the readout reports each block's actual spin count.

If the README has a table of contents, keep it consistent with any heading changes.

- [ ] **Step 3: Verify the whole build one last time**

Run: `npm run test:run && npm run build && npm run lint`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: readout strip, resizable charts and block size"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
| --- | --- |
| 1. Readout strip replaces the floating tooltip | 1 (component + CSS), 2 and 7 (adoption), 7 (dead CSS removed) |
| 2. Distribution readout content — colored per-bucket lines, four stats, no drag row | 2 |
| 3. Simulation block size — legend and per-block spin count | 7 |
| 4. Drag-to-resize — grip, pointer, keyboard, ranges, `HEIGHT` → prop | 3 (ranges), 4 (grip), 6 (distribution), 8 (simulation) |
| 5. State and persistence — App-owned, optional workspace fields, clamp on load | 5 (schema), 6 and 8 (App wiring + clamp on load) |
| Testing | every task; full-suite gates in 6, 8, 9 |
| Documentation | 9 |

**Placeholder scan:** none — every code step carries the literal code, every test step the literal test.

**Type consistency:** `HeightRange` / `clampHeight` / `DIST_HEIGHT` / `SIM_HEIGHT` are defined in Task 3 and used with those exact names in Tasks 4, 6 and 8. `ReadoutTitle` / `ReadoutStat` are defined in Task 1 and used in Tasks 2 and 7. `ChartResizeGrip` takes `range: HeightRange` (not separate `min`/`max`) in Task 4 and is called that way in Tasks 6 and 8. `SimulationPanel`'s pass-through props are `chartHeight` / `onChartHeight`; `SimChart`'s and `DistributionChart`'s are `height` / `onHeight` — deliberately different, since the panel owns neither.
