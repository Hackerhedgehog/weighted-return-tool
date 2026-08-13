# Swap Panel Sides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persisted "Swap sides" toggle that puts the distribution chart on the left and the buckets table on the right, with the table's column alignment flipping to match.

**Architecture:** One new boolean field (`swapped`) on the already-persisted `ChartSettings` object drives three things: which `<section>` renders first in `App.tsx`'s `.content-row`, a CSS class that flips `.grid-table`'s margin-based alignment, and (as a robustness fix) a switch from positional to class-based child lookup in the existing resize-observer callback that assumed DOM order.

**Tech Stack:** React + TypeScript, Vitest + React Testing Library, plain CSS.

## Global Constraints

- Match the existing `forceStack` pattern exactly for `swapped`: optional boolean in storage validation, default `false`, toggled via `setChart` (not `commit` — view state, not undoable).
- `.content-row.stacked .grid-table` (centering when panels wrap onto separate lines) must stay authoritative over the new swap alignment rule regardless of swap state.

---

### Task 1: Add `swapped` to `ChartSettings` and storage validation

**Files:**
- Modify: `src/lib/types.ts` (the `ChartSettings` interface and `DEFAULT_CHART`, near `forceStack` at lines 187-219)
- Modify: `src/lib/storage.ts` (`isChart`, lines 108-121)
- Test: `src/lib/storage.test.ts`

**Interfaces:**
- Produces: `ChartSettings.swapped: boolean`, `DEFAULT_CHART.swapped === false`. Later tasks read/write `chart.swapped` via the existing `chart`/`setChart` state in `App.tsx`.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/storage.test.ts`, right after the existing `forceStack` tests (after line 258):

```ts
  it('round-trips swapped and rejects a non-boolean', () => {
    saveWorkspace({ ...workspace, chart: { ...DEFAULT_CHART, swapped: true } })
    expect(loadWorkspace()?.chart.swapped).toBe(true)

    store.set(
      STORAGE_KEY,
      JSON.stringify({ ...workspace, chart: { ...DEFAULT_CHART, swapped: 'yes' } }),
    )
    expect(loadWorkspace()).toBeNull()
  })

  it('accepts a workspace saved before swapped existed', () => {
    const chart: Record<string, unknown> = { ...DEFAULT_CHART }
    delete chart.swapped
    store.set(STORAGE_KEY, JSON.stringify({ ...workspace, chart }))
    expect(loadWorkspace()).not.toBeNull()
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- storage.test.ts`
Expected: FAIL — `swapped` doesn't round-trip because `ChartSettings` has no such field yet (TypeScript will also complain about the extra property).

- [ ] **Step 3: Implement**

In `src/lib/types.ts`, add the field to the interface and default, right after `forceStack`:

```ts
  forceStack: boolean
  /**
   * Puts the distribution chart on the left and the buckets table on the
   * right (default: table left, chart right). The table's column alignment
   * follows — see `.content-row.swapped .grid-table` in index.css.
   */
  swapped: boolean
}

export const DEFAULT_CHART: ChartSettings = {
  metric: 'weights',
  logY: true,
  logX: false,
  aggregate: true,
  relative: true,
  groupBars: [],
  forceStack: false,
  swapped: false,
}
```

In `src/lib/storage.ts`, add to `isChart` right after the `forceStack` check (line 119):

```ts
    (v.forceStack === undefined || typeof v.forceStack === 'boolean') &&
    // Optional: absent in workspaces saved before the panels could be swapped.
    (v.swapped === undefined || typeof v.swapped === 'boolean')
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- storage.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/types.ts src/lib/storage.ts src/lib/storage.test.ts
git commit -m "feat: add swapped field to persisted chart settings"
```

---

### Task 2: Fix `rowRef`'s positional child lookup

**Files:**
- Modify: `src/App.tsx` (`rowRef` callback, around lines 236-241)

**Interfaces:**
- Consumes: nothing new — this only changes *how* `rowRef` finds the table/chart elements, not the callback's signature.
- Produces: `rowRef` becomes order-independent, so Task 3 can freely reorder the two `<section>` children.

This task has no new user-visible behavior on its own, so it's verified by the existing layout tests (Task 3 will extend them) rather than a new test. Do it first and confirm nothing breaks before touching JSX order.

- [ ] **Step 1: Make the change**

In `src/App.tsx`, replace:

```ts
      const [table, chartPanel] = [...el.children] as HTMLElement[]
      if (table === undefined || chartPanel === undefined) return
```

with:

```ts
      const table = el.querySelector<HTMLElement>('.panel.buckets')
      const chartPanel = el.querySelector<HTMLElement>('.panel.chart')
      if (table === null || chartPanel === null) return
```

- [ ] **Step 2: Run the existing layout tests to confirm no regression**

Run: `npm test -- App.test.tsx -t "page layout"`
Expected: PASS (same behavior as before, just found differently)

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "refactor: find table/chart panels by class, not DOM position"
```

---

### Task 3: "Swap sides" button, panel reorder, and column alignment CSS

**Files:**
- Modify: `src/App.tsx` (chart panel head around lines 988-1021; `.content-row` className around line 945)
- Modify: `src/index.css` (`.grid-table` and the `.content-row.stacked .grid-table` rule, lines 574-638)
- Test: `src/App.test.tsx`

**Interfaces:**
- Consumes: `ChartSettings.swapped` (Task 1), the fixed `rowRef` (Task 2).
- Produces: none consumed by further tasks — this is the last task.

- [ ] **Step 1: Write the failing tests**

Add to the `describe('page layout', ...)` block in `src/App.test.tsx`, after the existing `'forces the chart below the table...'` test (after line 683):

```tsx
  it('swaps the table and chart sides, and persists it', () => {
    loadRealData()
    const toggle = screen.getByRole('button', { name: 'Swap sides' })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(toggle)

    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    const row = document.querySelector('.content-row')!
    expect(row.className).toContain('swapped')
    expect([...row.children].map((el) => el.className)).toEqual(['panel chart', 'panel buckets'])

    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)!)
    expect(saved.chart.swapped).toBe(true)
  })
```

This needs `STORAGE_KEY` imported from `../lib/storage` (or `./lib/storage`, matching however `App.test.tsx` paths its other imports) — add it to the existing import from that module if one is already there, otherwise add a new import line: `import { STORAGE_KEY } from './lib/storage'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- App.test.tsx -t "swaps the table and chart"`
Expected: FAIL — no "Swap sides" button exists yet.

- [ ] **Step 3: Implement the button and panel reorder in `App.tsx`**

Replace the chart panel head (lines 988-1000) to add the new button next to "Stack below":

```tsx
          <section className="panel chart">
            <div className="panel-head">
              <h2>Distribution</h2>
              <button
                type="button"
                className={`btn ${chart.swapped ? 'primary' : ''}`}
                aria-pressed={chart.swapped}
                title="Put the distribution chart on the left and the table on the right"
                onClick={() => setChart({ ...chart, swapped: !chart.swapped })}
              >
                Swap sides
              </button>
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

Then wrap the two `<section>` panels (buckets section at lines 946-986, chart section at lines 988-1021 as now edited) so they render in swap order. Assign each section to a variable right before the `.content-row` div, then render them in order:

```tsx
          {(() => {
            const bucketsSection = (
              <section className="panel buckets">
                {/* ...unchanged contents... */}
              </section>
            )
            const chartSection = (
              <section className="panel chart">
                {/* ...unchanged contents, including the two buttons above... */}
              </section>
            )
            return (
              <div
                className={`content-row${chart.forceStack ? ' force-stack' : ''}${chart.swapped ? ' swapped' : ''}`}
                ref={rowRef}
              >
                {chart.swapped ? (
                  <>
                    {chartSection}
                    {bucketsSection}
                  </>
                ) : (
                  <>
                    {bucketsSection}
                    {chartSection}
                  </>
                )}
              </div>
            )
          })()}
```

Keep every existing prop and child of both sections exactly as they are today — only the wrapping/ordering changes.

- [ ] **Step 4: Add the CSS alignment rule in `src/index.css`**

The base `.grid-table` rule (around line 630) keeps its current default (`margin-left: auto; margin-right: 0` — hugs the right edge, for the default table-left/chart-right layout). Add a new rule for the swapped case immediately after it, and make sure the existing `.content-row.stacked .grid-table` rule (currently at line 574, i.e. textually *before* `.grid-table`) is moved to appear *after* this new rule, so it wins the tie in specificity when both `swapped` and `stacked` are present:

```css
/* Base default: table on the left, chart on the right — columns hug the
   right edge, next to the chart. */
.grid-table {
  border-collapse: separate;
  border-spacing: 0;
  table-layout: fixed;
  font-variant-numeric: tabular-nums;
  background: var(--surface);
  margin-left: auto;
  margin-right: 0;
}

/* Swapped: chart on the left, table on the right — columns hug the left
   edge, next to the chart. Same specificity as the .stacked rule below, so
   it must be declared first: the wrapped/centered rule needs to win the tie
   when both classes are present. */
.content-row.swapped .grid-table {
  margin-left: 0;
  margin-right: auto;
}

/* Wrapped onto its own line: neither edge is beside the chart anymore, so
   center regardless of swap state. Declared after .swapped above so it wins
   the specificity tie. */
.content-row.stacked .grid-table {
  margin-left: auto;
  margin-right: auto;
}
```

Remove the old `.content-row.stacked .grid-table` rule from its original location (around line 574) since it's now placed here instead.

- [ ] **Step 5: Update the pre-existing default-order layout test**

The test at `src/App.test.tsx:673` (`'lays the table and the chart out side by side...'`) already asserts `['panel buckets', 'panel chart']` for the default (unswapped) order — no change needed there; it continues to pass since `chart.swapped` defaults to `false`.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -- App.test.tsx -t "page layout"`
Expected: PASS for all three tests in the `describe('page layout', ...)` block.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: PASS (no regressions elsewhere)

- [ ] **Step 8: Commit**

```bash
git add src/App.tsx src/index.css src/App.test.tsx
git commit -m "feat: add Swap sides toggle for the buckets table and distribution chart"
```
