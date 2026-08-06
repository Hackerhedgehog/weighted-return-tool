# Weight step switch (free / 10 / 100) — Design

**Date:** 2026-08-06
**Status:** Approved

## Problem

The solver distributes integer weights at unit granularity, so buckets end up
with values like 107,421. Users sometimes want rounder weights. Add a switch
with three positions — **free**, **10**, **100** — so every weight the tool
computes lands on a multiple of the chosen step.

## Decisions made during brainstorming

1. **Scope:** every tool-computed weight respects the step — Auto-Distribute,
   the total-weight and total-RTP edits in the table footer, typed chance/value
   cells, and chart drags (bars and group handles). Weights typed directly into
   a weight cell are never snapped.
2. **Incompatible totals:** when an operation cannot produce all-on-step
   weights that sum to the required total, it **blocks with a warning** rather
   than snapping the total or letting one bucket land off-step.
3. **Approach:** step-aware allocation layer (approach A). The continuous math
   (curve, gamma bisection, band search) is untouched; only the integer
   allocation and repair layer learns about the step.

## UI

A segmented control labeled **Weight step** with options `free · 10 · 100`,
styled like the Volatility segments, in the second row of the targets panel
next to Curve c. Switching the step changes nothing immediately — it only
governs subsequent operations.

## State

- New type in `types.ts`: `WeightStep = 1 | 10 | 100`, with
  `DEFAULT_WEIGHT_STEP = 1`.
- Lives in the undoable `Doc` in `App.tsx` (alongside targets, volatility,
  curve) so undo/redo covers it.
- Persisted in the workspace. Workspaces saved before the field existed load
  with step 1 via the existing merge-over-defaults pattern in `App.tsx` /
  `storage.ts`.

## Engine changes (`src/lib/distribute.ts`)

The invariant everywhere: **unlocked weights produced by an operation are
multiples of the step; locked weights are never touched.** Only the free
budget (`total − lockedSum`) must divide by the step — a locked row holding
107,421 is fine in ×100 mode.

- `largestRemainder(weights, total, minOne, step = 1)`: allocates in units of
  `step` (internally divides the budget by `step`, runs the existing logic,
  multiplies back). `minOne` means "at least one step". Callers must pass a
  `total` divisible by `step`; entry points guarantee this.
- `solveWeights(rows, totalWeight, targets, curve, step)`: entry check — if
  `(totalWeight − lockedSum) % step !== 0`, return the current weights
  unchanged with a warning naming the nearest compatible totals. Otherwise
  solve as today, passing `step` into `allocate` (both `largestRemainder`
  calls) and into the RTP repair: `transfer` moves `step`-sized parcels, and
  the minimum-weight floor for a donor bucket becomes one step. RTP is
  therefore hit to step granularity — accuracy bottoms out at roughly
  `step × finestPayoutGap / (2 × total)` instead of unit granularity. The
  panel already reports the exact achieved RTP.
- `rescaleToTotal(rows, newTotal, step)`: returns null (blocked) when
  `(newTotal − lockedSum) % step !== 0`, in addition to the existing
  below-locked check. `App.tsx` distinguishes the two cases and shows the
  matching notice.
- `retargetRtp(rows, totalWeight, targetRtp, step)`: preserves each group's
  unlocked sum exactly, so its return type becomes `number[] | null` — null
  (blocked) when any group's unlocked sum is not a multiple of `step`.
  `App.tsx` shows a notice suggesting running Auto-Distribute first.
- `weightForChance` / `weightForValue`: round the solved weight to the nearest
  multiple of `step`. No blocking — the achieved chance/value simply lands as
  close as the step allows.

## Drag ops (`src/lib/interact.ts`)

`scaleSubset` and `setSubsetTotal` gain a `step` parameter:

- The requested subset total is snapped to the nearest multiple of `step`, so
  dragging feels like it moves in steps of 10/100.
- All internal allocation goes through the step-aware `largestRemainder`, so
  compensating buckets also land on the step.
- If the current table is incompatible (the relevant free sums are off-step),
  the ops return `null`; the chart leaves the bars in place and surfaces a
  short notice for the attempted drag.

## Warnings

Blocked operations use the existing notices mechanism (same as the
"total weight cannot be set below the locked weight" message) with actionable
text, e.g.:

> Free weight 1,048,155 is not divisible by 100 — set the total weight to
> 1,048,521 or 1,048,621.

## Testing

- `distribute.test.ts`: for steps 10 and 100 — all unlocked weights
  `% step === 0`; total preserved exactly; RTP within step granularity of the
  target; hit/win chance still within tolerance; blocking + warning when the
  free budget is off-step; odd *locked* weights still solvable when the free
  budget divides.
- `rescaleToTotal` / `retargetRtp`: same divisibility assertions plus the
  blocking cases.
- `interact.test.ts`: dragged and compensating weights on the step; snapping
  of the requested subset total; `null` on incompatible tables.
- App-level test: switch to ×100, Auto-Distribute, every unlocked weight
  divisible by 100; setting stays through undo/redo and reload.

## Out of scope

- Snapping manually typed weight-cell values.
- Auto-fixing an incompatible total on the user's behalf.
- Steps other than 10 and 100.
