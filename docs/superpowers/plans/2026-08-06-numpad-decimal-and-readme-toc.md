# Numpad Decimal Remap + README TOC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The numpad decimal key types `.` in every numeric input even on layouts where it emits `,`, and the README gets a table of contents plus coverage for undocumented features — per `docs/superpowers/specs/2026-08-06-numpad-decimal-and-readme-toc-design.md`.

**Architecture:** One shared helper, `remapNumpadComma(e)`, identifies the key by `KeyboardEvent.code === 'NumpadDecimal'` (layout-independent) and splices `.` at the caret; four call sites wire it into the grid cell editor, the grid's first-keystroke edit seeding, the panel number fields, and the spins input. The README work is pure docs.

**Tech Stack:** React 19 + TypeScript (strict), Vitest + Testing Library (jsdom), no new dependencies.

## Global Constraints

- Remap fires only when `e.code === 'NumpadDecimal' && e.key === ','` — layouts whose numpad already emits `.` are untouched.
- Main-row comma keeps its current behavior everywhere (ignored as a thousands separator by the expression evaluator); pasted text is unaffected.
- Text (label) cells are never remapped — only numeric inputs.
- All existing tests must keep passing; work continues on branch `worktree-weight-step-switch`.
- Match surrounding code style: no semicolons, single quotes, existing comment tone.

---

### Task 1: `remapNumpadComma` helper wired into all numeric inputs

**Files:**
- Create: `src/components/numpadDecimal.ts`
- Modify: `src/components/cells.tsx` (CellInput's `onKeyDown`, ~line 152)
- Modify: `src/components/useGridNavigation.ts:181-187` (printable-key seeding)
- Modify: `src/components/TargetsPanel.tsx` (PanelNumber's `onKeyDown`, ~line 77)
- Modify: `src/components/SimulationPanel.tsx` (spins input `onKeyDown`, ~line 203)
- Test: `src/App.test.tsx`

**Interfaces:**
- Consumes: existing components only.
- Produces: `remapNumpadComma(e: KeyboardEvent<HTMLInputElement>): boolean` from `src/components/numpadDecimal.ts` — true means the event was handled (defaulted-prevented, `.` spliced into `e.currentTarget.value` at the caret); controlled callers must then sync state from `e.currentTarget.value`.

- [ ] **Step 1: Write the failing tests**

Add to `src/App.test.tsx` (uses the existing `loadRealData` helper and imports; `screen`, `fireEvent` are already imported):

```tsx
describe('numpad decimal', () => {
  const numpadComma = { key: ',', code: 'NumpadDecimal' }

  it('types a dot into an open cell editor', () => {
    loadRealData()
    const cell = [...document.querySelectorAll('tbody .col-weight .gcell')][0]
    fireEvent.doubleClick(cell)
    const input = document.querySelector('input.gcell.editing') as HTMLInputElement
    input.setSelectionRange(input.value.length, input.value.length)
    const before = input.value
    fireEvent.keyDown(input, numpadComma)
    expect(input.value).toBe(`${before}.`)
  })

  it('seeds an edit with a dot when typed on a selected numeric cell', () => {
    loadRealData()
    const cell = [...document.querySelectorAll('tbody .col-weight .gcell')][0]
    fireEvent.mouseDown(cell)
    fireEvent.keyDown(cell, numpadComma)
    const input = document.querySelector('input.gcell.editing') as HTMLInputElement
    expect(input.value).toBe('.')
  })

  it('keeps the comma when typing into a label cell', () => {
    loadRealData()
    const cell = [...document.querySelectorAll('tbody .col-label .gcell')][0]
    fireEvent.mouseDown(cell)
    fireEvent.keyDown(cell, numpadComma)
    const input = document.querySelector('input.gcell.editing') as HTMLInputElement
    expect(input.value).toBe(',')
  })

  it('leaves a main-row comma alone in the cell editor', () => {
    loadRealData()
    const cell = [...document.querySelectorAll('tbody .col-weight .gcell')][0]
    fireEvent.doubleClick(cell)
    const input = document.querySelector('input.gcell.editing') as HTMLInputElement
    const before = input.value
    fireEvent.keyDown(input, { key: ',', code: 'Comma' })
    expect(input.value).toBe(before)
  })

  it('types a dot into a panel number field', () => {
    loadRealData()
    const rtp = screen.getByLabelText('Target RTP') as HTMLInputElement
    fireEvent.focus(rtp)
    rtp.setSelectionRange(rtp.value.length, rtp.value.length)
    fireEvent.keyDown(rtp, numpadComma)
    expect(rtp.value.endsWith('.')).toBe(true)
  })

  it('types a dot into the spins field', () => {
    loadRealData()
    const spins = screen.getByLabelText('Spins') as HTMLInputElement
    spins.setSelectionRange(spins.value.length, spins.value.length)
    fireEvent.keyDown(spins, numpadComma)
    expect(spins.value.endsWith('.')).toBe(true)
  })
})
```

Notes for the implementer:
- jsdom does not insert text on `keyDown`, so an unhandled comma leaves the value unchanged — that is what the two negative tests pin.
- The seed tests work because typing a printable character on a *selected* (idle) cell starts an edit whose input is seeded with that character.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/App.test.tsx`
Expected: FAIL — the four positive tests get no `.` (helper doesn't exist / isn't wired); the two negative tests may already pass.

- [ ] **Step 3: Create the helper**

Create `src/components/numpadDecimal.ts`:

```ts
import type { KeyboardEvent } from 'react'

/**
 * The numpad decimal key emits ',' on many keyboard layouts, but every
 * numeric field here reads '.' as the decimal separator — and the expression
 * evaluator strips ',' as a thousands separator, so the slip is silent:
 * `1,5` becomes 15. Rewrite exactly that key to '.' at the caret.
 *
 * Returns true when the event was handled; controlled inputs then sync their
 * state from `e.currentTarget.value`. Identified by `code`, not `key`, so
 * layouts whose numpad already emits '.' pass through untouched.
 */
export function remapNumpadComma(e: KeyboardEvent<HTMLInputElement>): boolean {
  if (e.code !== 'NumpadDecimal' || e.key !== ',') return false
  e.preventDefault()

  const el = e.currentTarget
  const start = el.selectionStart ?? el.value.length
  const end = el.selectionEnd ?? start
  el.value = el.value.slice(0, start) + '.' + el.value.slice(end)
  el.setSelectionRange(start + 1, start + 1)
  return true
}
```

- [ ] **Step 4: Wire the four call sites**

1. `src/components/cells.tsx` — import `import { remapNumpadComma } from './numpadDecimal'`. In `CellInput`'s `onKeyDown`, directly after the existing `e.stopPropagation()` line:

```ts
        if (numeric && remapNumpadComma(e)) return
```

(CellInput is uncontrolled — `defaultValue` — so no state sync is needed.)

2. `src/components/useGridNavigation.ts` — in `handleKeyDown`, replace the final block:

```ts
      e.preventDefault()
      if (isNumericCol(sel.col) && '+-*/('.includes(k)) startEdit({ mode: 'append', text: k })
      else startEdit({ mode: 'replace', text: k })
```

with:

```ts
      e.preventDefault()
      // The numpad decimal key emits ',' on many layouts; number cells read '.'.
      const ch = isNumericCol(sel.col) && k === ',' && e.code === 'NumpadDecimal' ? '.' : k
      if (isNumericCol(sel.col) && '+-*/('.includes(ch)) startEdit({ mode: 'append', text: ch })
      else startEdit({ mode: 'replace', text: ch })
```

3. `src/components/TargetsPanel.tsx` — import `import { remapNumpadComma } from './numpadDecimal'`. In `PanelNumber`'s `onKeyDown`, at the top of the handler body (before the Enter/Escape checks):

```ts
        if (remapNumpadComma(e)) {
          setDraft(e.currentTarget.value)
          return
        }
```

4. `src/components/SimulationPanel.tsx` — import `import { remapNumpadComma } from './numpadDecimal'`. In the spins input's `onKeyDown`, at the top of the handler body:

```ts
              if (remapNumpadComma(e)) {
                setSpinsText(e.currentTarget.value)
                return
              }
```

- [ ] **Step 5: Run tests to verify they pass, then the full gates**

Run: `npx vitest run src/App.test.tsx`
Expected: PASS (all six new tests).

Run: `npm run test:run` — expected: all files pass.
Run: `npm run build` — expected: clean.
Run: `npm run lint` — expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/numpadDecimal.ts src/components/cells.tsx src/components/useGridNavigation.ts src/components/TargetsPanel.tsx src/components/SimulationPanel.tsx src/App.test.tsx
git commit -m "feat: numpad decimal key types a dot in numeric inputs"
```

---

### Task 2: README table of contents and feature coverage

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the numpad behavior from Task 1 (documented here).
- Produces: docs only.

- [ ] **Step 1: Add the table of contents**

Insert after the intro paragraph (after line 5, before `## Requirements`):

```markdown
## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Usage](#usage)
- [Data formats](#data-formats)
  - [Input — what you paste](#input--what-you-paste)
  - [Output — what you export](#output--what-you-export)
- [Features](#features)
  - [Getting started](#getting-started)
  - [The solver](#the-solver)
  - [Tolerance](#tolerance)
  - [Volatility](#volatility)
  - [Weight step](#weight-step)
  - [The targets panel](#the-targets-panel)
  - [Locks](#locks)
  - [Keyboard](#keyboard)
  - [In-cell arithmetic](#in-cell-arithmetic)
  - [The totals row](#the-totals-row)
  - [Bucket groups](#bucket-groups)
  - [Dragging the distribution chart](#dragging-the-distribution-chart)
  - [Simulation](#simulation)
  - [Columns](#columns)
  - [Export](#export)
  - [Persistence](#persistence)
- [Project layout](#project-layout)
- [Tests](#tests)
```

(The `#input--what-you-paste` / `#output--what-you-export` double hyphens are correct — GitHub drops the em dash and turns each space into a hyphen.)

- [ ] **Step 2: Add the "Getting started" section**

Insert directly under the `## Features` heading, before `### The solver`:

```markdown
### Getting started

First launch opens the paste screen. `Load sample` builds the table from the
bundled 30-bucket reference data; `Paste TSV data` takes your own bucket list
and stays available in the top bar afterwards. `Clear workspace` in the
targets panel wipes everything and returns to the paste screen, after
confirming.
```

- [ ] **Step 3: Add the "The targets panel" section**

Insert between the `### Weight step` and `### Locks` sections:

```markdown
### The targets panel

Each target shows its achieved value beside it as a badge, flagged when the
solve could not keep it inside the band. The RTP field adds an exact "off by"
readout and a small gauge of achieved against target. The `= current` button
under each chance copies the achieved figure into the target — handy after
hand-editing weights, to adopt the current state as the new goal.
```

- [ ] **Step 4: Document the chart view toggles**

In `### Dragging the distribution chart`, insert a new paragraph directly after the first paragraph (the one ending "Chance mode is always relative."):

```markdown
The view has its own controls: **Weights / % Chance** switches the metric,
**Log Y** and **Log X** flip the axes to log scale, and **Aggregate equal
payouts** merges buckets sharing a payout into one bar (the reference data's
two 200x buckets, for instance).
```

- [ ] **Step 5: Document the numpad decimal behavior**

In `### In-cell arithmetic`, extend the final paragraph. Replace:

```markdown
A leading `=` is accepted, thousands separators are ignored, and invalid input
reverts the cell rather than silently becoming `0`.
```

with:

```markdown
A leading `=` is accepted, thousands separators are ignored, and invalid input
reverts the cell rather than silently becoming `0`. The numpad decimal key
always types `.`, even on layouts where it emits a comma — in every numeric
field, not just the grid.
```

- [ ] **Step 6: Add the new file to the project layout**

In the `## Project layout` code block, under `components/`, after the `cells.tsx` line, add:

```
    numpadDecimal.ts     numpad ',' → '.' remap shared by every numeric input
```

- [ ] **Step 7: Verify**

- Every TOC entry has a matching heading and every `##`/`###` heading has a TOC entry (check by eye against the rendered file).
- Run: `npm run test:run` — expected: all pass (docs-only change; proves nothing broke).

- [ ] **Step 8: Commit**

```bash
git add README.md
git commit -m "docs: README table of contents and feature coverage"
```
