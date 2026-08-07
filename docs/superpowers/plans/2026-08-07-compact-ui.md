# Compact UI, Side-by-Side Layout and Numpad Decimals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the table and the chart side by side at 95vw with no scroll box on the table, compact the targets panel into one settings row, move the export controls into the header, thin the chart bars, and make the numpad decimal key type a decimal point — per `docs/superpowers/specs/2026-08-07-compact-layout-design.md`.

**Architecture:** Almost entirely presentational. `index.css` turns `.content` into a two-column grid and drops the table's scroll box; `App.tsx` gains the export controls in its header and hands the three panels layout classNames; `TargetsPanel.tsx` loses the export field and folds Volatility and Curve c into the first row. The one piece of logic is `src/lib/numpad.ts`, two small pure-ish helpers wired into every input where a number is typed.

**Tech Stack:** React 19 + TypeScript (strict), Vite, Vitest (`npm run test:run`), no new dependencies.

## Status — read before starting

Merging `worktree-weight-step-switch` on 2026-08-07 landed work this plan had
duplicated:

- **Tasks 1–3 are done.** The numpad remap already ships as
  `src/components/numpadDecimal.ts` (`remapNumpadComma`), wired into
  `cells.tsx`, `useGridNavigation.ts`, `TargetsPanel.tsx` and
  `SimulationPanel.tsx`, with tests in `src/App.test.tsx`. It keys on
  `e.code === 'NumpadDecimal' && e.key === ','`, equivalent in practice to the
  `applyNumpadDecimal` those tasks specified. **Skip them.** Read the module
  rather than re-creating `src/lib/numpad.ts`.
- **The whole weight step plan is done**, so Task 5's prerequisite is met.
  Its labels came in as `free · 10 · 100`; Task 5 restyles them to
  `free · ×10 · ×100`.

Start at Task 4.

## Global Constraints

- ~~**Run the weight step plan first.**~~ Done — merged 2026-08-07. Task 5
  rearranges the targets rows around the `Weight step` field it added.
- No new dependencies.
- `src/lib/expr.ts` is not modified. A comma reaching the expression parser stays a thousands separator, so `1,200,350` keeps parsing and the export acceptance test keeps passing.
- Saved workspaces keep their stored column widths — `App.tsx` already merges them over `DEFAULT_WIDTHS`, and that merge is not touched.
- All existing tests keep passing. `npm run test:run`, `npm run build` and `npm run lint` must all be clean at the end of every task.
- jsdom notes for tests: `useContainerWidth` starts at **900px** and the faked `ResizeObserver` never fires, so chart geometry is deterministic in component tests. `index.css` is imported by `main.tsx`, **not** by `App.tsx` — no test may assert on computed styles.

---

### Task 1: numpad decimal helpers

**Files:**
- Create: `src/lib/numpad.ts`
- Create: `src/lib/numpad.test.ts`

**Interfaces:**
- Produces: `numpadChar(e: { code: string; key: string }): string` and `applyNumpadDecimal(e: KeyboardEvent<HTMLInputElement>): boolean` (React's `KeyboardEvent` type). Tasks 2 and 3 call both.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/numpad.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { applyNumpadDecimal, numpadChar } from './numpad'

/** A React KeyboardEvent stand-in over a real input — the helper only reads these. */
function fakeEvent(
  input: HTMLInputElement,
  over: Partial<{ code: string; key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {},
) {
  const preventDefault = vi.fn()
  const e = {
    code: 'NumpadDecimal',
    key: ',',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    currentTarget: input,
    preventDefault,
    ...over,
  }
  return { e: e as unknown as ReactKeyboardEvent<HTMLInputElement>, preventDefault }
}

function inputWith(value: string, start: number, end = start): HTMLInputElement {
  const el = document.createElement('input')
  el.value = value
  document.body.append(el)
  el.setSelectionRange(start, end)
  return el
}

describe('numpadChar', () => {
  it('reads the numpad decimal key as a point whatever the layout emits', () => {
    expect(numpadChar({ code: 'NumpadDecimal', key: ',' })).toBe('.')
    expect(numpadChar({ code: 'NumpadDecimal', key: '.' })).toBe('.')
  })

  it('passes every other key through, including a main-row comma', () => {
    expect(numpadChar({ code: 'Comma', key: ',' })).toBe(',')
    expect(numpadChar({ code: 'Digit5', key: '5' })).toBe('5')
    expect(numpadChar({ code: 'NumpadAdd', key: '+' })).toBe('+')
  })
})

describe('applyNumpadDecimal', () => {
  it('inserts a point at the caret and reports that it handled the key', () => {
    const el = inputWith('25', 1)
    const { e, preventDefault } = fakeEvent(el)

    expect(applyNumpadDecimal(e)).toBe(true)
    expect(preventDefault).toHaveBeenCalled()
    expect(el.value).toBe('2.5')
    expect(el.selectionStart).toBe(2)
  })

  it('replaces the selection', () => {
    const el = inputWith('2500', 1, 3)
    applyNumpadDecimal(fakeEvent(el).e)
    expect(el.value).toBe('2.0')
  })

  it('declines when the key already produced a point', () => {
    const el = inputWith('25', 2)
    const { e, preventDefault } = fakeEvent(el, { key: '.' })

    expect(applyNumpadDecimal(e)).toBe(false)
    expect(preventDefault).not.toHaveBeenCalled()
    expect(el.value).toBe('25')
  })

  it('declines a main-row comma and any modified press', () => {
    const el = inputWith('1200', 4)
    expect(applyNumpadDecimal(fakeEvent(el, { code: 'Comma' }).e)).toBe(false)
    expect(applyNumpadDecimal(fakeEvent(el, { ctrlKey: true }).e)).toBe(false)
    expect(applyNumpadDecimal(fakeEvent(el, { altKey: true }).e)).toBe(false)
    expect(el.value).toBe('1200')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/numpad.test.ts`
Expected: FAIL — `./numpad` does not exist.

- [ ] **Step 3: Implement**

Create `src/lib/numpad.ts`:

```ts
import type { KeyboardEvent } from 'react'

/**
 * The numpad's decimal key emits whatever the OS layout says — a comma on
 * most European layouts. In a number field that is never what was meant: a
 * comma there reads as a thousands separator, so "2,5" commits as 25. Excel
 * types a decimal point on that key regardless of layout, and so do we.
 *
 * Only the numpad key is remapped. A comma typed on the main keyboard row
 * keeps its separator meaning, which is what lets a pasted 1,200,350 parse.
 */

/** The character a keypress contributes, with the numpad key read as a point. */
export function numpadChar(e: { code: string; key: string }): string {
  return e.code === 'NumpadDecimal' ? '.' : e.key
}

/**
 * Type a decimal point at the caret when the numpad decimal key produced
 * something else, replacing any selection. Returns true when it handled the
 * event, having already written to the input — controlled inputs must then
 * re-sync their state from `e.currentTarget.value`.
 */
export function applyNumpadDecimal(e: KeyboardEvent<HTMLInputElement>): boolean {
  if (e.code !== 'NumpadDecimal' || e.key === '.') return false
  if (e.ctrlKey || e.metaKey || e.altKey) return false

  e.preventDefault()
  const el = e.currentTarget
  const start = el.selectionStart ?? el.value.length
  const end = el.selectionEnd ?? start
  el.value = `${el.value.slice(0, start)}.${el.value.slice(end)}`
  el.setSelectionRange(start + 1, start + 1)
  return true
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/numpad.test.ts`
Expected: PASS (all 6).

- [ ] **Step 5: Commit**

```bash
git add src/lib/numpad.ts src/lib/numpad.test.ts
git commit -m "feat: numpad decimal key helpers"
```

---

### Task 2: the grid types a decimal point on numpad-comma

**Files:**
- Modify: `src/components/cells.tsx` (`CellInput` `onKeyDown`, around line 152)
- Modify: `src/components/useGridNavigation.ts:182-187` (the typed-character tail of `handleKeyDown`)
- Test: `src/App.test.tsx`

**Interfaces:**
- Consumes: `applyNumpadDecimal`, `numpadChar` from Task 1.
- Produces: no new exports. Behaviour: numpad-comma on a selected cell opens the editor seeded with `.`; inside an open editor it inserts `.` at the caret.

- [ ] **Step 1: Write the failing test**

Add to `src/App.test.tsx`, inside the existing `describe('App', ...)`:

```ts
  it('types a decimal point when the numpad decimal key sends a comma', () => {
    loadRealData()
    const cell = document.querySelector('.grid-row .col-payout .gcell') as HTMLElement

    // on a selected cell the typed character seeds the editor
    fireEvent.mouseDown(cell)
    fireEvent.keyDown(cell, { key: ',', code: 'NumpadDecimal' })
    const input = document.querySelector('.grid-row .col-payout input') as HTMLInputElement
    expect(input.value).toBe('.')

    // and inside the editor it inserts at the caret
    fireEvent.change(input, { target: { value: '2' } })
    input.setSelectionRange(1, 1)
    fireEvent.keyDown(input, { key: ',', code: 'NumpadDecimal' })
    expect(input.value).toBe('2.')

    fireEvent.change(input, { target: { value: '2.5' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(document.querySelector('.grid-row .col-payout .gcell')!.textContent).toBe('2.5')
  })

  it('still reads a main-row comma as a thousands separator', () => {
    loadRealData()
    const cell = document.querySelector('.grid-row .col-weight .gcell') as HTMLElement

    fireEvent.mouseDown(cell)
    fireEvent.keyDown(cell, { key: '1', code: 'Digit1' })
    const input = document.querySelector('.grid-row .col-weight input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '1,200,350' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(document.querySelector('.grid-row .col-weight .gcell')!.textContent).toBe('1,200,350')
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/App.test.tsx`
Expected: FAIL — the first test's editor opens seeded with `,`, so `input.value` is `','` not `'.'`.

- [ ] **Step 3: Implement**

In `src/components/cells.tsx`, add the import:

```ts
import { applyNumpadDecimal } from '../lib/numpad'
```

and, in `CellInput`'s `onKeyDown`, immediately after the existing `e.stopPropagation()` and before the `switch`:

```ts
        // The cell input is uncontrolled, so the helper's write to the DOM is
        // the whole edit — there is no React state to re-sync.
        if (applyNumpadDecimal(e)) return
```

In `src/components/useGridNavigation.ts`, add the import:

```ts
import { numpadChar } from '../lib/numpad'
```

and replace the tail of `handleKeyDown` (currently lines 181-187):

```ts
      // Leave browser and OS shortcuts alone.
      if (mod || e.altKey || k.length !== 1) return
      if (isLockCol(sel.col) || !isEditable(sel)) return

      const ch = numpadChar(e)
      e.preventDefault()
      if (isNumericCol(sel.col) && '+-*/('.includes(ch)) startEdit({ mode: 'append', text: ch })
      else startEdit({ mode: 'replace', text: ch })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/App.test.tsx`
Expected: PASS, including the whole pre-existing App suite.

- [ ] **Step 5: Commit**

```bash
git add src/components/cells.tsx src/components/useGridNavigation.ts src/App.test.tsx
git commit -m "feat: numpad decimal key types a point in grid cells"
```

---

### Task 3: the panel inputs accept the numpad decimal too

**Files:**
- Modify: `src/components/TargetsPanel.tsx` (`PanelNumber`'s `onKeyDown`, around line 77)
- Modify: `src/components/SimulationPanel.tsx:203-206` (the spins input's `onKeyDown`)
- Test: `src/App.test.tsx`

**Interfaces:**
- Consumes: `applyNumpadDecimal` from Task 1.
- Produces: no new exports. Both fields are **controlled**, so each call site re-syncs its own draft state from `e.currentTarget.value` after the helper runs.

- [ ] **Step 1: Write the failing test**

Add to `src/App.test.tsx`:

```ts
  it('accepts a numpad decimal in the targets fields', () => {
    loadRealData()
    const input = screen.getByLabelText('Target RTP') as HTMLInputElement

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '0' } })
    input.setSelectionRange(1, 1)
    fireEvent.keyDown(input, { key: ',', code: 'NumpadDecimal' })
    expect(input.value).toBe('0.')

    fireEvent.change(input, { target: { value: '0.9' } })
    fireEvent.blur(input)
    expect((screen.getByLabelText('Target RTP') as HTMLInputElement).value).toBe('0.9')
  })

  it('accepts a numpad decimal in the spins field', () => {
    loadRealData()
    const input = screen.getByLabelText('Spins') as HTMLInputElement

    fireEvent.change(input, { target: { value: '2' } })
    input.setSelectionRange(1, 1)
    fireEvent.keyDown(input, { key: ',', code: 'NumpadDecimal' })
    expect(input.value).toBe('2.')

    fireEvent.change(input, { target: { value: '2.5m' } })
    fireEvent.blur(input)
    expect((screen.getByLabelText('Spins') as HTMLInputElement).value).toBe('2,500,000')
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/App.test.tsx`
Expected: FAIL — both inputs keep the value they had; the keydown does nothing.

- [ ] **Step 3: Implement**

In `src/components/TargetsPanel.tsx`, add the import:

```ts
import { applyNumpadDecimal } from '../lib/numpad'
```

and extend `PanelNumber`'s `onKeyDown`, before the `Enter` check:

```ts
      onKeyDown={(e) => {
        // Controlled input: the helper wrote to the DOM, so pull the new text
        // into the draft. The strings match, so React leaves the caret alone.
        if (applyNumpadDecimal(e)) {
          setDraft(e.currentTarget.value)
          return
        }
        if (e.key === 'Enter') e.currentTarget.blur()
        else if (e.key === 'Escape') {
          setDraft(null)
          e.currentTarget.blur()
        }
      }}
```

In `src/components/SimulationPanel.tsx`, add the same import:

```ts
import { applyNumpadDecimal } from '../lib/numpad'
```

and rewrite the spins input's handler (lines 203-206):

```ts
            onKeyDown={(e) => {
              if (applyNumpadDecimal(e)) {
                setSpinsText(e.currentTarget.value)
                return
              }
              if (e.key === 'Enter') commitSpins()
              if (e.key === 'Escape') setSpinsText(fmtWeight(spins))
            }}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/App.test.tsx src/components/SimulationPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/TargetsPanel.tsx src/components/SimulationPanel.tsx src/App.test.tsx
git commit -m "feat: numpad decimal key types a point in the panel inputs"
```

---

### Task 4: export controls move into the header

**Files:**
- Modify: `src/App.tsx` (the `topbar` block at 293-306; the `TargetsPanel` render at 310-332)
- Modify: `src/components/TargetsPanel.tsx` (props interface 13-35, destructure 134-157, the export field 292-312)
- Modify: `src/index.css` (`.topbar` 77-85, `.topbar-actions` 105-108, `.filename-input` 251-253; add `.topbar-sep` and `.btn.danger`)
- Test: `src/App.test.tsx`

**Interfaces:**
- Produces: `TargetsPanelProps` **loses** `exportFilename`, `copyState`, `onCopy`, `onDownload`, `onFilename`, `onClear`. Everything else on that interface is unchanged. `App.tsx` keeps `handleCopy`, `handleClear`, `exportText`, `exportFilename`, `setExportFilename` and `copyState` exactly as they are — only the JSX that renders them moves.

- [ ] **Step 1: Write the failing test**

Add to `src/App.test.tsx`:

```ts
  it('puts the export controls in the header, not the targets panel', () => {
    loadRealData()
    const header = document.querySelector('.topbar') as HTMLElement

    expect(within(header).getByRole('button', { name: 'Copy TSV' })).toBeDefined()
    expect(within(header).getByRole('button', { name: 'Download .tsv' })).toBeDefined()
    expect(within(header).getByLabelText('Export filename')).toBeDefined()
    expect(within(header).getByRole('button', { name: 'Clear workspace' })).toBeDefined()
    expect(within(header).getByRole('button', { name: 'Load sample' })).toBeDefined()
    expect(within(header).getByRole('button', { name: 'Paste TSV data' })).toBeDefined()

    expect(document.querySelector('.targets .filename-input')).toBeNull()
  })
```

- [ ] **Step 2: Run tests to verify it fails**

Run: `npx vitest run src/App.test.tsx`
Expected: FAIL — the export buttons are inside `.targets`, not `.topbar`.

- [ ] **Step 3: Implement the header**

In `src/App.tsx`, replace the `topbar-actions` div with:

```tsx
        <div className="topbar-actions">
          <button type="button" className="btn" onClick={() => loadData(SAMPLE_TSV)}>
            Load sample
          </button>
          <button type="button" className="btn" onClick={() => setPasteOpen(true)}>
            Paste TSV data
          </button>
          {hasRows && (
            <>
              <span className="topbar-sep" aria-hidden="true" />
              <input
                className="filename-input"
                value={exportFilename}
                aria-label="Export filename"
                spellCheck={false}
                onChange={(e) => setExportFilename(e.target.value)}
              />
              <button type="button" className="btn" onClick={handleCopy}>
                {copyState === 'ok' ? 'Copied ✓' : copyState === 'fail' ? 'Copy failed' : 'Copy TSV'}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => downloadTsv(exportText(), exportFilename)}
              >
                Download .tsv
              </button>
              <span className="topbar-sep" aria-hidden="true" />
              <button type="button" className="btn danger" onClick={handleClear}>
                Clear workspace
              </button>
            </>
          )}
        </div>
```

`hasRows` is declared at line 289, *below* this JSX in source order but above the `return` — no change needed, it is already in scope.

Then drop these six props from the `<TargetsPanel …>` call: `exportFilename`, `copyState`, `onCopy`, `onDownload`, `onFilename`, `onClear`.

- [ ] **Step 4: Implement the TargetsPanel side**

In `src/components/TargetsPanel.tsx`:

1. Delete `exportFilename`, `copyState`, `onCopy`, `onDownload`, `onFilename` and `onClear` from `TargetsPanelProps` and from the destructuring block.
2. Delete the whole `<div className="target-field export">…</div>` block (lines 292-312).

- [ ] **Step 5: Implement the CSS**

In `src/index.css`:

```css
.topbar {
  display: flex;
  align-items: center;      /* was baseline — the row now holds an input */
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0 10px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 12px;
}
```

```css
.topbar-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

/* Thin rule grouping load · export · destructive actions. */
.topbar-sep {
  width: 1px;
  align-self: stretch;
  min-height: 20px;
  background: var(--line);
}
```

Split the shared `.panel-num, .filename-input` width rule so the filename field keeps a sensible size in the header:

```css
.filename-input {
  font-size: 12px;
  width: 200px;
}
```

(leave the shared block's other declarations alone; just remove `width: 100%` from it and give `.panel-num` its own width in Task 5).

Add next to the other button variants:

```css
.btn.danger {
  color: var(--danger);
  border-color: #f0b3ae;
}

.btn.danger:hover:not(:disabled) {
  background: var(--danger-soft);
  border-color: var(--danger);
}
```

- [ ] **Step 6: Run the tests, build and lint**

Run: `npm run test:run`
Expected: PASS.

Run: `npm run build`
Expected: clean — in particular no "declared but never read" errors from the removed props.

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx src/components/TargetsPanel.tsx src/index.css src/App.test.tsx
git commit -m "feat: export and clear controls move into the header"
```

---

### Task 5: one settings row in the targets panel

**Files:**
- Modify: `src/components/TargetsPanel.tsx` (`ChanceTarget` 88-132; the two `targets-row` blocks 171-290)
- Modify: `src/index.css` (`.targets` 176-215, `.panel-num` 237-249)
- Test: `src/App.test.tsx`

**Interfaces:**
- Consumes: the `Weight step` field added by `docs/superpowers/plans/2026-08-06-weight-step-switch.md` Task 7 — **that plan must already be complete.** This task moves Volatility and Curve c *out* of row 2 and leaves Weight step behind as its first field.
- Produces: no interface change. `TargetsPanelProps` is untouched.

- [ ] **Step 1: Write the failing test**

Add to `src/App.test.tsx`:

```ts
  it('keeps every target setting on one row', () => {
    loadRealData()
    const rows = document.querySelectorAll('.targets-row')
    const first = rows[0] as HTMLElement
    const second = rows[1] as HTMLElement

    for (const label of [
      'Target RTP',
      'Preferred Hit Chance',
      'Preferred Win Chance',
      'Chance tolerance',
      'Volatility',
      'Curve c',
    ]) {
      expect(within(first).getByText(label)).toBeDefined()
    }

    expect(within(second).getByText('Weight step')).toBeDefined()
    expect(within(second).getByRole('button', { name: 'Auto-Distribute' })).toBeDefined()
  })
```

- [ ] **Step 2: Run tests to verify it fails**

Run: `npx vitest run src/App.test.tsx`
Expected: FAIL — `Volatility` and `Curve c` are in the second row.

- [ ] **Step 3: Move Volatility and Curve c into the first row**

In `src/components/TargetsPanel.tsx`, cut the Volatility field and the Curve c field out of the second `targets-row` and paste them into the first, after the `Chance tolerance` field. While moving them, drop `wide` from the Volatility field's className, give its `seg` the `small` variant, and move Curve c's long hint into the input's tooltip:

```tsx
        <div className="target-field">
          <label className="field-label">Volatility</label>
          <div className="seg small">
            {VOLATILITY_STEPS.map((v) => (
              <button
                key={v}
                type="button"
                className={`seg-btn ${volatility === v ? 'active' : ''}`}
                onClick={() => onVolatility(v)}
                title={`curve c = ${CURVE_PRESETS[v]}`}
              >
                {v}
              </button>
            ))}
            <span className={`seg-btn custom ${volatility === 'custom' ? 'active' : ''}`}>custom</span>
          </div>
        </div>

        <div className="target-field">
          <label className="field-label">Curve c</label>
          <PanelNumber
            display={String(curve)}
            raw={String(curve)}
            ariaLabel="Curve curvature"
            title="0 = straight line on a log-log chart · higher bends the tail down"
            validate={(n) => n >= 0 && n <= 2}
            onCommit={onCurve}
          />
        </div>
```

The second row is then `Weight step` followed by the existing `target-field actions` block, unchanged.

- [ ] **Step 4: Compact the remaining fields**

Still in `src/components/TargetsPanel.tsx`:

1. `ChanceTarget` — the band moves into the badge tooltip, so the field is label + input + badge + `= current`. Replace its `field-meta` block:

```tsx
      <div className="field-meta">
        <span
          className={`badge ${inBand ? 'ok' : 'warn'}`}
          title={`${inBand ? 'Within' : 'Outside'} tolerance · ${fmtPct(achieved, 2)} · band ${fmtFixed3(lo)}–${fmtFixed3(hi)}`}
        >
          {fmtFixed3(achieved)}
        </span>
        <button
          type="button"
          className="link-btn"
          onClick={onUseCurrent}
          title="Copy the achieved value into the target"
        >
          = current
        </button>
      </div>
```

2. The Target RTP field — the `off by` figure moves into its badge tooltip:

```tsx
          <div className="field-meta">
            <span
              className={`badge ${Math.abs(rtpDelta) < 1e-6 ? 'ok' : 'warn'}`}
              title={
                Number.isFinite(rtpDelta) && Math.abs(rtpDelta) >= 1e-6
                  ? `off by ${rtpDelta > 0 ? '+' : ''}${rtpDelta.toFixed(6)}`
                  : 'on target'
              }
            >
              {fmtRtp(achieved.rtp)}
            </span>
            <span className="field-hint">{fmtPct(achieved.rtp, 2)}</span>
          </div>
```

3. The Chance tolerance field — long hint into the tooltip:

```tsx
        <div className="target-field">
          <label className="field-label">Chance tolerance</label>
          <PanelNumber
            display={`${targets.tolerance}%`}
            raw={String(targets.tolerance)}
            ariaLabel="Chance tolerance percent"
            title="Relative band on hit and win chance — spent only when RTP is otherwise out of reach"
            validate={(n) => n >= 0 && n <= 50}
            onCommit={(n) => onTargets({ ...targets, tolerance: n })}
          />
          <div className="field-meta">
            <span className="field-hint">relative</span>
          </div>
        </div>
```

Every one of `fmtFixed3`, `fmtPct` and `fmtRtp` is still used, so the imports stay.

- [ ] **Step 5: Compact the CSS**

In `src/index.css`, replace the targets-panel block:

```css
.targets {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 10px 14px;
  margin-bottom: 12px;
}

.targets-row {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: flex-start;
}

.targets-row + .targets-row {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--line);
}

.target-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 104px;
}

.target-field.rtp {
  min-width: 150px;
}

.target-field.actions {
  min-width: 190px;
}
```

That deletes the `.target-field.wide` and `.target-field.export` rules. Then give the number inputs a fixed width — five digits is the most any of them shows:

```css
.panel-num {
  width: 88px;
}
```

(and remove `width: 100%` from the shared `.panel-num, .filename-input` block, if Task 4 has not already).

`.sim-spins` keeps its own `width: 130px`, which still wins on specificity order — verify the spins field still looks right.

- [ ] **Step 6: Run the tests, build and lint**

Run: `npm run test:run`
Expected: PASS.

Run: `npm run build && npm run lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/components/TargetsPanel.tsx src/index.css src/App.test.tsx
git commit -m "feat: one compact settings row in the targets panel"
```

---

### Task 6: side-by-side layout and a table that grows instead of scrolling

**Files:**
- Modify: `src/App.tsx` (the three `<section className="panel">` tags at 334, 364, 379; the Buckets panel hint at 337-340)
- Modify: `src/index.css` (`.app` 69-73, `.content` 415-419, `.panel` 421-426, `.grid-wrap` 452-455, the media query at 1039-1048)
- Modify: `src/lib/columns.ts:16-25` (default widths)
- Create: `src/lib/columns.test.ts`
- Test: `src/App.test.tsx`, `src/lib/columns.test.ts`

**Interfaces:**
- Produces: layout classNames `panel buckets`, `panel chart`, `panel full` on the three sections — the CSS grid keys off them. `COLUMNS` keeps its shape; only four `width` numbers change.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/columns.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { COLUMNS, DEFAULT_WIDTHS } from './columns'

describe('default column widths', () => {
  it('fit inside half the content width on a 1440px screen', () => {
    // 95vw of 1440 is 1368; half, less the grid gap and the panel borders,
    // leaves roughly 670px of table.
    const total = COLUMNS.reduce((a, c) => a + c.width, 0)
    expect(total).toBeLessThanOrEqual(712)
  })

  it('still leaves the chance column wide enough to read', () => {
    expect(DEFAULT_WIDTHS.chance).toBeGreaterThanOrEqual(130)
  })

  it('mirrors every column into DEFAULT_WIDTHS', () => {
    expect(Object.keys(DEFAULT_WIDTHS)).toHaveLength(COLUMNS.length)
    for (const c of COLUMNS) expect(DEFAULT_WIDTHS[c.key]).toBe(c.width)
  })
})
```

Add to `src/App.test.tsx`:

```ts
  it('lays the table and the chart out side by side', () => {
    loadRealData()
    const content = document.querySelector('.content')!
    expect([...content.children].map((el) => el.className)).toEqual([
      'targets',
      'panel buckets',
      'panel chart',
      'panel full',
    ])
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/columns.test.ts src/App.test.tsx`
Expected: FAIL — widths total 866, and every panel's className is just `panel`.

- [ ] **Step 3: Trim the default column widths**

In `src/lib/columns.ts`, update four rows of `COLUMNS` (the comment on `chance` changes too):

```ts
export const COLUMNS: Column[] = [
  { key: 'lock', label: '', sortable: false, numeric: false, width: 34 },
  { key: 'id', label: 'ID', sortable: true, numeric: true, width: 62 },
  { key: 'payout', label: 'Avg Payout', sortable: true, numeric: true, width: 92 },
  { key: 'label', label: 'Label', sortable: true, numeric: false, width: 150 },
  { key: 'weight', label: 'Weights', sortable: true, numeric: true, width: 118 },
  { key: 'weightedValue', label: 'Weighted Value', sortable: true, numeric: true, width: 124 },
  // Sized so the whole table fits beside the chart. Chances run to 15 decimals
  // — double-click the header edge to fit the column to them on demand.
  { key: 'chance', label: 'Chance', sortable: true, numeric: true, width: 132 },
]
```

- [ ] **Step 4: Tag the panels**

In `src/App.tsx`:

- Buckets: `<section className="panel buckets">`
- Distribution: `<section className="panel chart">`
- Simulation: `<section className="panel full">`

and shorten the Buckets hint so it does not wrap three deep at half width:

```tsx
              <span className="panel-hint">arrow keys to move · type +500 to add · drag a header edge to resize</span>
```

- [ ] **Step 5: Implement the layout CSS**

In `src/index.css`:

```css
.app {
  width: 95vw;
  margin: 0 auto;
  padding: 0 0 48px;
}
```

```css
/* Table and chart share the width; targets and simulation span both. The
   chart sticks so it stays beside whichever rows are on screen. */
.content {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

.content > .targets,
.content > .panel.full {
  grid-column: 1 / -1;
}

.panel.chart {
  position: sticky;
  top: 8px;
  align-self: start;
}
```

The buckets panel must not clip a table the user has widened past its half:

```css
.panel.buckets {
  overflow: visible;
}
```

And the table stops being its own scroll box:

```css
/* No max-height and no scrolling: the table renders at full height and the
   page scrolls instead, which also promotes the sticky header row and totals
   row from a dead 620px window to the viewport itself. */
.grid-wrap {
  overflow: visible;
}
```

Finally, collapse to one column on anything narrower than 1200px — a half-width table would not fit — and drop the sticky with it:

```css
@media (max-width: 1200px) {
  .content {
    grid-template-columns: minmax(0, 1fr);
  }

  .panel.chart {
    position: static;
  }
}

@media (max-width: 900px) {
  .targets-row {
    gap: 14px;
  }

  .topbar {
    flex-direction: column;
    align-items: flex-start;
  }
}
```

- [ ] **Step 6: Run the tests, build and lint**

Run: `npm run test:run`
Expected: PASS — note the existing "shows columns in the export order" and totals-row tests are width-independent.

Run: `npm run build && npm run lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx src/index.css src/lib/columns.ts src/lib/columns.test.ts src/App.test.tsx
git commit -m "feat: table and chart side by side, table grows instead of scrolling"
```

---

### Task 7: thinner chart bars

**Files:**
- Modify: `src/components/chartUtils.ts` (add the two width helpers)
- Modify: `src/components/DistributionChart.tsx:71` (`MARGIN`) and `:269-274` (`barW`)
- Create: `src/components/chartUtils.test.ts`
- Test: `src/components/chartUtils.test.ts`, `src/components/DistributionChart.test.tsx`

**Interfaces:**
- Produces: `linearBarWidth(slot: number): number` and `logBarWidth(minGap: number): number` in `chartUtils.ts`. `DistributionChart` is their only caller.

- [ ] **Step 1: Write the failing tests**

Create `src/components/chartUtils.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { linearBarWidth, logBarWidth } from './chartUtils'

describe('bar widths', () => {
  it('caps a linear bar at 16px however much room there is', () => {
    expect(linearBarWidth(400)).toBe(16)
  })

  it('leaves a 14% gap when the slot is the constraint', () => {
    expect(linearBarWidth(10)).toBeCloseTo(8.6, 6)
  })

  it('never disappears', () => {
    expect(linearBarWidth(0.5)).toBe(2)
    expect(logBarWidth(0)).toBeCloseTo(6.8, 6) // no measurable gap → 8px fallback
  })

  it('caps a log-axis bar at 12px', () => {
    expect(logBarWidth(400)).toBe(12)
    expect(logBarWidth(10)).toBeCloseTo(8.5, 6)
  })
})
```

Add to `src/components/DistributionChart.test.tsx`, in the `describe('DistributionChart grouping', …)` block:

```ts
  it('draws slim bars', () => {
    // jsdom: the container width is the 900px default and ResizeObserver
    // never fires, so the geometry here is deterministic.
    renderChart({ metric: 'weights' })
    const widths = [...document.querySelectorAll('.bar')].map((el) => el.getAttribute('width'))
    expect(widths.every((w) => w === '16')).toBe(true)
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/chartUtils.test.ts src/components/DistributionChart.test.tsx`
Expected: FAIL — the helpers do not exist, and the rendered bars are 48px wide.

- [ ] **Step 3: Implement the helpers**

Append to `src/components/chartUtils.ts`:

```ts
/**
 * Bar geometry. Slim bars with tight gaps: the chart shares its row with the
 * table now, and a dense ladder has to stay readable in half the width. Bars
 * still spread across the whole plot — only the cap and the gap shrink.
 */
const MAX_BAR_W = 16
const BAR_FILL = 0.86
const MAX_LOG_BAR_W = 12
const LOG_BAR_FILL = 0.85

/** Bar width on an evenly-spaced axis, given the per-bar slot width. */
export function linearBarWidth(slot: number): number {
  return Math.max(2, Math.min(MAX_BAR_W, slot * BAR_FILL))
}

/** Bar width on a log payout axis, given the tightest gap between centres. */
export function logBarWidth(minGap: number): number {
  return Math.max(2, Math.min(MAX_LOG_BAR_W, (minGap || 8) * LOG_BAR_FILL))
}
```

- [ ] **Step 4: Use them in the chart**

In `src/components/DistributionChart.tsx`, extend the import:

```ts
import { linearBarWidth, logBarWidth, niceCeil, useContainerWidth } from './chartUtils'
```

trim the margins (line 71) so the narrower pane spends less on gutters:

```ts
const MARGIN = { top: 18, right: 128, bottom: 46, left: 64 }
```

and replace the `barW` memo:

```ts
  const barW = useMemo(() => {
    if (!logX) return linearBarWidth(step)
    let gap = plotW
    for (let i = 1; i < centres.length; i++) gap = Math.min(gap, centres[i] - centres[i - 1])
    return logBarWidth(gap === plotW ? 0 : gap)
  }, [logX, step, centres, plotW])
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/components/chartUtils.test.ts src/components/DistributionChart.test.tsx`
Expected: PASS, including the pre-existing drag tests — they assert weights, not pixels.

Run: `npm run test:run`
Expected: PASS across every file.

- [ ] **Step 6: Commit**

```bash
git add src/components/chartUtils.ts src/components/chartUtils.test.ts src/components/DistributionChart.tsx src/components/DistributionChart.test.tsx
git commit -m "feat: slim chart bars with tighter gaps"
```

---

### Task 8: README

**Files:**
- Modify: `README.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Update the feature documentation**

`README.md` documents the tool feature by feature. Make these edits, matching the surrounding tone and heading level (`###` under `## Features`):

1. **New `### Weight step` section**, after `### Volatility`: the switch offers `free · ×10 · ×100`; every weight the tool computes — Auto-Distribute, the totals-row weight and RTP edits, typed Chance and Weighted Value cells, chart drags — lands on a multiple of the step; weights typed straight into a Weights cell are never snapped; locked weights are never touched, so only the free weight (total minus locked) has to divide; an operation that cannot keep the total on-step is blocked with a notice naming the nearest compatible totals; RTP is then hit to step granularity rather than unit granularity. (Skip this item if the weight step plan has not been run yet — its own Task 7 Step 7 covers it.)

2. **New `### Layout` section**, near `### Columns`: the page runs at 95% of the viewport width with the table and the distribution chart side by side, the chart sticking beside the rows as you scroll; the bucket table has no scroll box of its own — it renders every row and the page scrolls, with the header row and the editable totals row pinned to the top and bottom of the viewport; below 1200px the two columns stack.

3. **`### Keyboard`** — add a row to the table: `Numpad . / ,` → `always types a decimal point, as in Excel`. Follow it with a sentence: a comma typed on the main keyboard row still reads as a thousands separator, so `1,200,350` pastes and parses as one number.

4. **`### Export`** — replace "the filename field next to the buttons" with the controls' new home: `Copy TSV`, `Download .tsv` and the editable filename field sit in the header next to `Load sample` and `Paste TSV data`, alongside `Clear workspace`.

5. **`### Persistence`** — `Clear workspace` is now described as sitting in the header; check the sentence still reads correctly.

6. **Project layout block** — add `numpad.ts   numpad decimal key handling` under `src/lib/` and note that `TargetsPanel.tsx` no longer carries export (its line currently reads `targets, volatility, export, undo` → `targets, volatility, weight step, undo`).

- [ ] **Step 2: Verify**

Run: `npm run test:run`
Expected: PASS — nothing in the docs is executable, but this is the last gate before the final commit.

Re-read the changed README sections against the running app (`npm run dev`) and confirm every claim is true: the export buttons really are in the header, the table really has no scrollbar, and numpad-comma really types a point.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README for the compact layout, weight step and numpad decimals"
```
