# Numpad decimal remap + README table of contents — Design

**Date:** 2026-08-06
**Status:** Approved
**Branch:** stacks on `worktree-weight-step-switch` (unmerged weight-step work).

## Problem

1. On keyboard layouts where the numpad decimal key emits `,`, typing a
   decimal in any numeric field inserts a comma. The expression evaluator
   strips commas as thousands separators, so `1,5` silently becomes `15` —
   wrong values, no error.
2. The README has grown to ~15 feature sections with no table of contents,
   and a few features are undocumented.

## Decisions made during brainstorming

- **Scope:** remap the numpad key only (`KeyboardEvent.code === 'NumpadDecimal'`),
  in **all** numeric inputs — grid cells, panel number fields, spins input.
  Main-row comma keeps its thousands-separator behavior; paste is unaffected.
- Layouts whose numpad already emits `.` are untouched: the remap fires only
  when the produced key is `,`.

## Part 1 — numpad comma → dot

New helper `src/components/numpadDecimal.ts`:

```ts
remapNumpadComma(e: React.KeyboardEvent<HTMLInputElement>): boolean
```

When `e.code === 'NumpadDecimal' && e.key === ','`: `preventDefault()`,
insert `.` at the caret via `setRangeText(..., 'end')` (replacing any
selection), return `true`. Returns `false` otherwise. Controlled callers
sync their state from `e.currentTarget.value` when it returns true;
uncontrolled callers need nothing more.

Wired into every place a number is typed:

1. **`CellInput`** (`src/components/cells.tsx`) — the grid cell editor.
   Uncontrolled input: call the helper at the top of its `onKeyDown`.
2. **Edit seeding** (`src/components/useGridNavigation.ts`) — typing a
   printable character on a selected cell starts an edit seeded with that
   character. A `,` whose `code` is `NumpadDecimal` seeds `.` instead.
3. **`PanelNumber`** (`src/components/TargetsPanel.tsx`) — controlled
   draft: if the helper returns true, `setDraft(e.currentTarget.value)`.
4. **Spins input** (`src/components/SimulationPanel.tsx`) — same pattern
   as its controlled implementation requires.

## Part 2 — README

- **Table of contents** after the intro paragraph, linking every `##` and
  `###` section with GitHub-style anchors.
- **Coverage additions**, matching the existing tone:
  - Getting started: the paste overlay and the `Load sample` button.
  - Targets panel details: achieved-value badges, the "off by" readout,
    the `= current` buttons, the RTP gauge.
  - Chart view toggles: `Log X`, `Log Y`, `Aggregate equal payouts`
    (Relative drag is already documented).
  - Numpad decimal note in the in-cell arithmetic section.

## Testing

- Component-level tests dispatch `keyDown` with
  `{ key: ',', code: 'NumpadDecimal' }` and assert:
  - the cell editor's value gains `.` (and commits the right number),
  - the first-keystroke seed on a selected numeric cell opens an edit
    seeded with `.`,
  - a panel field's draft gains `.`,
  - a plain `,` keydown (main row, `code: 'Comma'`) is NOT remapped.
- README: no automated test; reviewed by eye.

## Out of scope

- Changing how pasted text or main-row commas are parsed.
- Locale-aware number formatting anywhere else.
