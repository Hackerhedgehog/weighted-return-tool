# Weight Step Switch (free / 10 / 100) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Weight step` switch (free · 10 · 100) so every tool-computed weight lands on a multiple of the chosen step, per `docs/superpowers/specs/2026-08-06-weight-step-design.md`.

**Architecture:** A `WeightStep` (1 | 10 | 100) value lives in the undoable `Doc` and is persisted in the workspace. The step threads into the integer-allocation layer of `src/lib/distribute.ts` (`largestRemainder`, RTP repair) and into the drag ops in `src/lib/interact.ts`; the continuous math (curve, gamma bisection, band search) is untouched. Operations that cannot produce all-on-step weights summing to the required total block and surface a notice.

**Tech Stack:** React 19 + TypeScript (strict), Vite, Vitest (`npm run test:run`), no new dependencies.

## Global Constraints

- Steps are exactly `1 | 10 | 100`. `1` renders as "free".
- Locked weights are never touched; only the *free* budget (`total − lockedSum`) must divide by the step. An off-step locked weight (e.g. 107,421) is legal in ×100 mode.
- Weights typed directly into a weight cell are never snapped.
- A blocked operation leaves all weights unchanged and surfaces a notice through the existing `notices` mechanism in `App.tsx`.
- All existing tests must keep passing; new params default to `1` so current call sites keep their behavior.
- Test data: `example-input-data.tsv` parsed at the top of `distribute.test.ts`; the existing total `T = 1200350` divides by 10 but **not** by 100 (useful for blocking tests). Use `1200300` for ×100 success tests.

---

### Task 1: `WeightStep` type and step-aware `largestRemainder`

**Files:**
- Modify: `src/lib/types.ts` (after the `Volatility` block, around line 49)
- Modify: `src/lib/distribute.ts:74-111` (`largestRemainder`)
- Test: `src/lib/distribute.test.ts`

**Interfaces:**
- Consumes: existing `largestRemainder(weights, total, minOne)`.
- Produces: `WeightStep`, `WEIGHT_STEPS`, `DEFAULT_WEIGHT_STEP` in `types.ts`; `largestRemainder(weights: number[], total: number, minOne: boolean, step = 1): number[]` — later tasks pass `step` through it.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/distribute.test.ts` (import `largestRemainder` alongside the existing imports from `./distribute`):

```ts
describe('largestRemainder with a step', () => {
  it('allocates only multiples of the step, exactly to the total', () => {
    const out = largestRemainder([3, 1, 1], 1000, false, 100)
    expect(out).toEqual([600, 200, 200])
  })

  it('minOne gives every entry at least one step', () => {
    const out = largestRemainder([1000, 1, 1], 300, true, 100)
    expect(out.every((v) => v >= 100 && v % 100 === 0)).toBe(true)
    expect(sum(out)).toBe(300)
  })

  it('defaults to unit granularity', () => {
    expect(sum(largestRemainder([1, 1, 1], 10, false))).toBe(10)
  })
})
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run src/lib/distribute.test.ts`
Expected: FAIL — the two step tests fail (extra argument is ignored, so allocations are not multiples of 100).

- [ ] **Step 3: Implement**

In `src/lib/types.ts`, after the `CURVE_PRESETS` block:

```ts
/**
 * Granularity of tool-distributed weights: every weight the tool computes
 * lands on a multiple of the step. 1 is "free". Manually typed weight cells
 * are never snapped.
 */
export type WeightStep = 1 | 10 | 100

export const WEIGHT_STEPS: WeightStep[] = [1, 10, 100]
export const DEFAULT_WEIGHT_STEP: WeightStep = 1
```

In `src/lib/distribute.ts`, change the head of `largestRemainder` (keep the existing body as the `step === 1` path, and extend the doc comment):

```ts
/**
 * Split `total` integer units across `weights` in proportion, exactly.
 * With `minOne`, every entry gets at least 1 — but only when the budget is
 * large enough to go round; otherwise zeros are allowed rather than
 * over-spending. With `step > 1` the split happens in units of `step`, so
 * every share is a multiple of it and `minOne` means "at least one step";
 * callers pass totals divisible by `step`. Exported for the
 * direct-manipulation ops in interact.ts.
 */
export function largestRemainder(
  weights: number[],
  total: number,
  minOne: boolean,
  step = 1,
): number[] {
  if (step > 1) {
    return largestRemainder(weights, Math.round(total / step), minOne, 1).map((v) => v * step)
  }
  // ... existing body unchanged ...
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/distribute.test.ts`
Expected: PASS (all existing tests too).

- [ ] **Step 5: Commit**

```bash
git add src/lib/types.ts src/lib/distribute.ts src/lib/distribute.test.ts
git commit -m "feat: WeightStep type and step-aware largestRemainder"
```

---

### Task 2: `solveWeights` honors the step and blocks off-step free budgets

**Files:**
- Modify: `src/lib/distribute.ts` (`solveWeights:372`, `allocate:264`, `repairRtp:361`, `transfer:323`)
- Test: `src/lib/distribute.test.ts`

**Interfaces:**
- Consumes: `largestRemainder(..., step)` from Task 1; `WeightStep` from `types.ts`.
- Produces: `solveWeights(rows: BucketRow[], totalWeight: number, targets: Targets, curve: number, step: WeightStep = 1): SolveResult` and `stepBlockWarning(free: number, lockedSum: number, step: number): string` (exported — `App.tsx` reuses it in Task 7). Internal: `allocate(ctx, cont, step)`, `repairRtp(ctx, w, target, step)`, `transfer(ctx, w, target, pair, step)`.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/distribute.test.ts`:

```ts
describe('solveWeights with a weight step', () => {
  // T = 1,200,350 divides by 10 but not by 100
  const T100 = 1200300

  it('lands every weight on a multiple of 10 and still sums exactly', () => {
    const r = solveWeights(rows, T, DEFAULT_TARGETS, CURVE_PRESETS.medium, 10)
    expect(r.weights.every((w) => w % 10 === 0)).toBe(true)
    expect(sum(r.weights)).toBe(T)
    expect(r.warnings).toHaveLength(0)
  })

  it('hits RTP to step granularity and keeps the chances in band', () => {
    const r = solveWeights(rows, T100, DEFAULT_TARGETS, CURVE_PRESETS.medium, 100)
    expect(r.weights.every((w) => w % 100 === 0)).toBe(true)
    expect(sum(r.weights)).toBe(T100)
    expect(Math.min(...r.weights)).toBeGreaterThanOrEqual(100)
    const s = statsOf(withWeights(r.weights), T100)
    expect(s.rtp).toBeCloseTo(0.95, 4)
    expect(s.hitChance).toBeCloseTo(0.3, 3)
    expect(s.winChance).toBeCloseTo(0.12, 3)
  })

  it('blocks with a warning when the free weight does not divide', () => {
    const r = solveWeights(rows, T, DEFAULT_TARGETS, CURVE_PRESETS.medium, 100)
    expect(r.weights).toEqual(rows.map((row) => Math.max(0, Math.round(row.weight))))
    expect(r.warnings.some((w) => w.includes('not divisible by 100'))).toBe(true)
    expect(r.warnings.some((w) => w.includes('1,200,300') && w.includes('1,200,400'))).toBe(true)
  })

  it('allows an off-step locked weight when the free budget still divides', () => {
    const zi = rows.findIndex((r) => r.payout === 0)
    const locked = rows.map((r, i) => (i === zi ? { ...r, weight: 107421, locked: true } : r))
    const total = 107421 + T100 // free budget stays a multiple of 100
    const r = solveWeights(locked, total, DEFAULT_TARGETS, CURVE_PRESETS.medium, 100)
    expect(r.weights[zi]).toBe(107421)
    expect(sum(r.weights)).toBe(total)
    locked.forEach((row, i) => {
      if (!row.locked) expect(r.weights[i] % 100).toBe(0)
    })
    expect(r.warnings).toHaveLength(0)
  })
})
```

Note the locked row deliberately sits on a **zero-payout** bucket: it contributes nothing to RTP, so the RTP target stays reachable and the warnings assertion holds.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/distribute.test.ts`
Expected: FAIL — `solveWeights` ignores the fifth argument, so weights are not multiples and no blocking warning appears.

- [ ] **Step 3: Implement**

In `src/lib/distribute.ts`:

1. Import the type: add `WeightStep` to the existing `import type { BucketRow, Targets } from './types'`.

2. Add the exported warning helper (near the top, after `GROUP_NAMES`):

```ts
/** Blocked-operation message naming the nearest totals that would divide. */
export function stepBlockWarning(free: number, lockedSum: number, step: number): string {
  const fmt = (n: number) => n.toLocaleString('en-US')
  const lo = lockedSum + Math.floor(free / step) * step
  return `Free weight ${fmt(free)} is not divisible by ${step} — set the total weight to ${fmt(lo)} or ${fmt(lo + step)}.`
}
```

3. `allocate` gains a `step` parameter and passes it to both `largestRemainder` calls:

```ts
function allocate(ctx: Ctx, cont: number[], step: number): number[] {
  // ... unchanged until:
  const groupBudgets = largestRemainder(groupSums, free, false, step)

  active.forEach((g, k) => {
    const idx = ctx.freeIdx[g]
    const alloc = largestRemainder(
      idx.map((i) => cont[i]),
      groupBudgets[k],
      true,
      step,
    )
    // ... unchanged
```

4. `transfer` moves `step`-sized parcels. The donor floor becomes one step, the initial jump is rounded to a step multiple (its clamp bounds are step multiples because allocated weights are), and the walk moves `step` per iteration:

```ts
function transfer(
  ctx: Ctx,
  w: number[],
  target: number,
  pair: [number, number] | null,
  step: number,
): void {
  if (pair === null) return
  const [lo, hi] = pair
  const span = ctx.payouts[hi] - ctx.payouts[lo]
  if (!(span > 0)) return

  const minLo = w[lo] >= step ? step : 0
  const minHi = w[hi] >= step ? step : 0
  const err = () => (target - rtpOf(ctx, w)) * ctx.total

  const d = clamp(Math.round(err() / span / step) * step, -(w[hi] - minHi), w[lo] - minLo)
  if (d !== 0) {
    w[lo] -= d
    w[hi] += d
  }

  for (let k = 0; k < 200; k++) {
    const before = Math.abs(err())
    if (before === 0) return
    const dir = err() > 0 ? 1 : -1
    if (dir === 1 && w[lo] - step < minLo) return
    if (dir === -1 && w[hi] - step < minHi) return
    w[lo] -= dir * step
    w[hi] += dir * step
    if (Math.abs(err()) >= before) {
      w[lo] += dir * step
      w[hi] -= dir * step
      return
    }
  }
}
```

5. `repairRtp` threads it through (update its doc comment: accuracy bottoms out at `step ×` the old figure):

```ts
function repairRtp(ctx: Ctx, w: number[], target: number, step: number): void {
  const idx = ctx.freeIdx[2]
  if (idx.length < 2) return

  const err = () => Math.abs(target - rtpOf(ctx, w)) * ctx.total
  for (const pair of payoutPairs(ctx, idx)) {
    if (err() < 1e-9) return
    transfer(ctx, w, target, pair, step)
  }
}
```

`retargetRtp` still calls `repairRtp(ctx, result, targetRtp)` — change that call to `repairRtp(ctx, result, targetRtp, 1)` for now; Task 3 threads the real step through.

6. `solveWeights` — new signature and entry check, placed right after the existing all-locked early return:

```ts
export function solveWeights(
  rows: BucketRow[],
  totalWeight: number,
  targets: Targets,
  curve: number,
  step: WeightStep = 1,
): SolveResult {
  // ... empty + buildCtx + all-locked check unchanged, then:

  const freeWeight = Math.round(ctx.total - ctx.totalLocked)
  if (freeWeight % step !== 0) {
    return { ...empty, warnings: [stepBlockWarning(freeWeight, ctx.totalLocked, step)] }
  }
```

and pass the step at the two call sites near the end:

```ts
  const weights = allocate(ctx, continuousWeights(ctx, chosen.budgets, gamma), step)
  repairRtp(ctx, weights, targets.rtp, step)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/distribute.test.ts`
Expected: PASS, including all pre-existing solver tests (step defaults to 1).

- [ ] **Step 5: Commit**

```bash
git add src/lib/distribute.ts src/lib/distribute.test.ts
git commit -m "feat: solveWeights distributes on the weight step, blocks off-step budgets"
```

---

### Task 3: `rescaleToTotal` and `retargetRtp` honor the step

**Files:**
- Modify: `src/lib/distribute.ts` (`rescaleToTotal:516`, `retargetRtp:545`)
- Test: `src/lib/distribute.test.ts` (new describe + `!` on three existing `retargetRtp` calls)

**Interfaces:**
- Consumes: `largestRemainder(..., step)`, `repairRtp(..., step)` from Tasks 1–2.
- Produces: `rescaleToTotal(rows: BucketRow[], newTotal: number, step: WeightStep = 1): number[] | null` (null now also means "free budget off the step"); `retargetRtp(rows: BucketRow[], totalWeight: number, targetRtp: number, step: WeightStep = 1): number[] | null` (**return type changes** — null means a group's unlocked sum is off the step; App handles it in Task 7).

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/distribute.test.ts`:

```ts
describe('weight steps on rescale and retarget', () => {
  const T100 = 1200300
  const start = solveWeights(rows, T100, DEFAULT_TARGETS, CURVE_PRESETS.medium, 100).weights

  it('rescales on the step', () => {
    const out = rescaleToTotal(withWeights(start), 600000, 100)!
    expect(out).not.toBeNull()
    expect(sum(out)).toBe(600000)
    expect(out.every((w) => w % 100 === 0)).toBe(true)
  })

  it('rejects a rescale whose free budget is off the step', () => {
    expect(rescaleToTotal(withWeights(start), 600050, 100)).toBeNull()
  })

  it('retargets RTP while keeping every weight on the step', () => {
    const out = retargetRtp(withWeights(start), T100, 1.05, 100)!
    expect(out).not.toBeNull()
    expect(sum(out)).toBe(T100)
    expect(out.every((w) => w % 100 === 0)).toBe(true)
    expect(statsOf(withWeights(out), T100).rtp).toBeCloseTo(1.05, 4)
  })

  it('refuses to retarget when the current weights sit off the step', () => {
    // the step-1 solve at T puts 144,042 in the win group — not a multiple of 100
    const offStep = solveWeights(rows, T, DEFAULT_TARGETS, CURVE_PRESETS.medium).weights
    expect(retargetRtp(withWeights(offStep), T, 1.05, 100)).toBeNull()
  })
})
```

Also update the three existing `retargetRtp` tests (`distribute.test.ts:242`, `:252`, `:259`) to non-null assert, e.g. `const out = retargetRtp(withWeights(start), T, 1.05)!` — the compiler requires it once the return type is nullable.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/distribute.test.ts`
Expected: FAIL — extra arguments ignored; weights come back off-step and nothing returns null.

- [ ] **Step 3: Implement**

`rescaleToTotal` — add the param, the divisibility check, and thread the step (note `budget` moves up so the check can use it):

```ts
export function rescaleToTotal(
  rows: BucketRow[],
  newTotal: number,
  step: WeightStep = 1,
): number[] | null {
  if (!Number.isFinite(newTotal) || newTotal < 0) return null

  const out = rows.map((r) => Math.max(0, Math.round(r.weight)))
  const lockedSum = rows.reduce((a, r, i) => (r.locked ? a + out[i] : a), 0)
  if (newTotal < lockedSum) return null

  const budget = Math.round(newTotal) - lockedSum
  if (budget % step !== 0) return null

  const freeIdx = rows.map((_, i) => i).filter((i) => !rows[i].locked)
  if (freeIdx.length === 0) return budget === 0 ? out : null

  const base = freeIdx.map((i) => out[i])
  const anyPositive = base.some((b) => b > 0)
  const alloc = largestRemainder(anyPositive ? base : base.map(() => 1), budget, false, step)
  freeIdx.forEach((i, k) => {
    out[i] = alloc[k]
  })

  return out
}
```

`retargetRtp` — add the param, return `null` when a redistributed group's sum is off-step, thread the step into `largestRemainder` and `repairRtp` (update the doc comment to mention the nullable return):

```ts
export function retargetRtp(
  rows: BucketRow[],
  totalWeight: number,
  targetRtp: number,
  step: WeightStep = 1,
): number[] | null {
  const out = rows.map((r) => Math.max(0, Math.round(r.weight)))
  if (rows.length === 0 || !(totalWeight > 0)) return out

  const ctx = buildCtx(rows, totalWeight, 0)
  const groups = [1, 2] as const
  const groupTotals = groups.map((g) => ctx.freeIdx[g].reduce((a, i) => a + out[i], 0))
  // Each group's unlocked sum is preserved exactly, so each must already sit
  // on the step — otherwise no on-step redistribution can reproduce it.
  if (groupTotals.some((t) => t % step !== 0)) return null

  // ... tilted() and the bisection unchanged ...

  groups.forEach((g, gi) => {
    const idx = ctx.freeIdx[g]
    if (idx.length === 0) return
    const alloc = largestRemainder(
      idx.map((i) => cont[i]),
      groupTotals[gi],
      true,
      step,
    )
    idx.forEach((i, k) => {
      result[i] = alloc[k]
    })
  })

  repairRtp(ctx, result, targetRtp, step)
  return result
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/distribute.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/distribute.ts src/lib/distribute.test.ts
git commit -m "feat: rescaleToTotal and retargetRtp honor the weight step"
```

---

### Task 4: chance/value cell solving rounds to the step

**Files:**
- Modify: `src/lib/distribute.ts` (`weightForChance:491`, `weightForValue:501`)
- Test: `src/lib/distribute.test.ts`

**Interfaces:**
- Produces: `weightForChance(currentWeight: number, totalWeight: number, chance: number, step: WeightStep = 1): number | null` and `weightForValue(currentWeight: number, totalWeight: number, payout: number, value: number, step: WeightStep = 1): number | null`. Null semantics unchanged; the solved weight is rounded to the nearest step multiple.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/distribute.test.ts`:

```ts
describe('single-cell solves with a weight step', () => {
  it('rounds the solved weight to the nearest step multiple', () => {
    // exact answer is 0.3·900/0.7 ≈ 385.7 → 400 on the 100-step
    expect(weightForChance(100, 1000, 0.3, 100)).toBe(400)
    // exact answer is 300 — already on the step
    expect(weightForValue(100, 1000, 2, 0.5, 100)).toBe(300)
  })

  it('keeps its refusals regardless of the step', () => {
    expect(weightForChance(100, 1000, 1, 100)).toBeNull()
    expect(weightForValue(100, 1000, 2, 5, 100)).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/distribute.test.ts`
Expected: FAIL — first test gets 386 instead of 400.

- [ ] **Step 3: Implement**

```ts
export function weightForChance(
  currentWeight: number,
  totalWeight: number,
  chance: number,
  step: WeightStep = 1,
): number | null {
  const other = totalWeight - currentWeight
  if (!(other > 0) || !(chance >= 0) || chance >= 1) return null
  return Math.round((chance * other) / (1 - chance) / step) * step
}

export function weightForValue(
  currentWeight: number,
  totalWeight: number,
  payout: number,
  value: number,
  step: WeightStep = 1,
): number | null {
  const other = totalWeight - currentWeight
  if (!(other > 0) || !(value >= 0) || !(payout > value)) return null
  return Math.round((value * other) / (payout - value) / step) * step
}
```

Extend the block comment above them with one line: solved weights land on the nearest multiple of `step`, so the typed figure is met as closely as the step allows.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/distribute.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/distribute.ts src/lib/distribute.test.ts
git commit -m "feat: chance/value cell solving rounds to the weight step"
```

---

### Task 5: drag ops snap to the step

**Files:**
- Modify: `src/lib/interact.ts`
- Test: `src/lib/interact.test.ts`

**Interfaces:**
- Consumes: `largestRemainder(..., step)` from Task 1; `WeightStep` from `types.ts`.
- Produces: `scaleSubset(rows: BucketRow[], subsetUids: Iterable<string>, newSubsetTotal: number, step: WeightStep = 1): number[] | null` (**return type changes** — null means the table's free weight is off the step; never null at step 1) and `setSubsetTotal(rows, subsetUids, newSubsetTotal, step: WeightStep = 1): number[]` (never blocks: the outside never moves, and the inside is fully reallocated onto the step). Internal `allocate(current, idx, budget, step)`.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/interact.test.ts`:

```ts
describe('weight steps', () => {
  it('scaleSubset snaps the drag and keeps every unlocked row on the step', () => {
    const rows = [row(100), row(300), row(600)]
    const w = scaleSubset(rows, [rows[0].uid], 240, 100)!
    expect(w[0]).toBe(200) // 240 snaps to the nearest hundred
    expect(total(w)).toBe(1000)
    expect(w.every((v) => v % 100 === 0)).toBe(true)
  })

  it('scaleSubset refuses when the free weight is off the step', () => {
    const rows = [row(150), row(300), row(600)] // free total 1050
    expect(scaleSubset(rows, [rows[0].uid], 200, 100)).toBeNull()
  })

  it('an off-step locked row outside the subset is fine', () => {
    const rows = [row(100), row(421, true), row(900)] // free total 1000
    const w = scaleSubset(rows, [rows[0].uid], 350, 100)!
    expect(w).toEqual([400, 421, 600])
  })

  it('setSubsetTotal snaps the subset and leaves the rest alone', () => {
    const rows = [row(100), row(300), row(600)]
    const w = setSubsetTotal(rows, uids(rows.slice(0, 2)), 445, 10)
    expect(w[0] + w[1]).toBe(450) // 445 snaps to the nearest ten
    expect(w[0] % 10).toBe(0)
    expect(w[1] % 10).toBe(0)
    expect(w[2]).toBe(600)
  })
})
```

Also non-null assert the existing `scaleSubset` results (its return type becomes nullable): append `!` at `interact.test.ts:21`, `:31`, `:40`, `:51`, `:60`, `:69`, `:75`, `:81`, `:90`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/interact.test.ts`
Expected: FAIL — no snapping, no null.

- [ ] **Step 3: Implement**

In `src/lib/interact.ts` — import the type (`import type { BucketRow, WeightStep } from './types'`), thread step through `allocate`, and rework the two ops. Extend the module comment: with a step, drags snap to step-sized parcels, and `scaleSubset` returns null when the table's free weight cannot be partitioned on the step.

```ts
/** Proportional integer split of `budget` over `idx`, equal when all-zero. */
function allocate(current: number[], idx: number[], budget: number, step: number): number[] {
  const base = idx.map((i) => current[i])
  const anyPositive = base.some((b) => b > 0)
  return largestRemainder(anyPositive ? base : base.map(() => 1), budget, false, step)
}

export function scaleSubset(
  rows: BucketRow[],
  subsetUids: Iterable<string>,
  newSubsetTotal: number,
  step: WeightStep = 1,
): number[] | null {
  const s = splitRows(rows, subsetUids)
  const out = s.current.slice()

  // With no unlocked rows on one side, the grand-total invariant pins the
  // subset total exactly where it is — the drag has nowhere to move.
  if (s.inside.length === 0 || s.outside.length === 0) return out

  // The grand total is invariant, so both sides must land on the step at
  // once — impossible unless the table's free weight is itself on the step.
  if ((s.grand - s.lockedIn - s.lockedOut) % step !== 0) return null

  const lo = s.lockedIn
  const hi = s.grand - s.lockedOut
  const snapped = s.lockedIn + Math.round((newSubsetTotal - s.lockedIn) / step) * step
  const target = Math.min(Math.max(snapped, lo), hi)
  if (!Number.isFinite(target)) return out

  const insideAlloc = allocate(s.current, s.inside, target - s.lockedIn, step)
  const outsideAlloc = allocate(s.current, s.outside, s.grand - target - s.lockedOut, step)

  s.inside.forEach((i, k) => {
    out[i] = insideAlloc[k]
  })
  s.outside.forEach((i, k) => {
    out[i] = outsideAlloc[k]
  })
  return out
}

export function setSubsetTotal(
  rows: BucketRow[],
  subsetUids: Iterable<string>,
  newSubsetTotal: number,
  step: WeightStep = 1,
): number[] {
  const s = splitRows(rows, subsetUids)
  const out = s.current.slice()
  if (s.inside.length === 0) return out

  const snapped = s.lockedIn + Math.round((newSubsetTotal - s.lockedIn) / step) * step
  const target = Math.max(snapped, s.lockedIn)
  if (!Number.isFinite(target)) return out

  const insideAlloc = allocate(s.current, s.inside, target - s.lockedIn, step)
  s.inside.forEach((i, k) => {
    out[i] = insideAlloc[k]
  })
  return out
}
```

Both clamp bounds preserve divisibility: `lo` makes the inside budget 0, `hi` makes it the whole free weight (a step multiple after the check), so a clamped target still yields step-multiple budgets on both sides.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/interact.test.ts`
Expected: PASS (all pre-existing drag tests too — step defaults to 1, and `% 1 === 0` always holds).

- [ ] **Step 5: Commit**

```bash
git add src/lib/interact.ts src/lib/interact.test.ts
git commit -m "feat: drag ops snap to the weight step"
```

---

### Task 6: persist the step in the workspace

**Files:**
- Modify: `src/lib/storage.ts` (`Workspace` interface + `isWorkspace`)
- Test: `src/lib/storage.test.ts`

**Interfaces:**
- Consumes: `WeightStep` from `types.ts`.
- Produces: `Workspace.weightStep?: WeightStep` — optional, exactly like `simSpins`. Task 7 reads it with `saved.weightStep ?? DEFAULT_WEIGHT_STEP` and writes it on every save.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/storage.test.ts`:

```ts
  it('round-trips a workspace carrying a weight step', () => {
    saveWorkspace({ ...workspace, weightStep: 100 })
    expect(loadWorkspace()?.weightStep).toBe(100)
  })

  it('accepts a stepless workspace but rejects a bogus step', () => {
    saveWorkspace(workspace)
    expect(loadWorkspace()).toEqual(workspace)

    store.set(STORAGE_KEY, JSON.stringify({ ...workspace, weightStep: 7 }))
    expect(loadWorkspace()).toBeNull()
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/storage.test.ts`
Expected: FAIL — `weightStep: 100` is a TS error on the `Workspace` literal (and the bogus-step payload loads instead of being rejected).

- [ ] **Step 3: Implement**

In `src/lib/storage.ts`, import the type (`import type { ..., WeightStep } from './types'`), add to `Workspace`:

```ts
  /** Optional — absent in workspaces saved before the weight step existed. */
  weightStep?: WeightStep
```

and add to the `isWorkspace` conjunction:

```ts
    (v.weightStep === undefined || v.weightStep === 1 || v.weightStep === 10 || v.weightStep === 100)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/storage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/storage.ts src/lib/storage.test.ts
git commit -m "feat: persist the weight step in the workspace"
```

---

### Task 7: UI wiring — switch, notices, and props

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/TargetsPanel.tsx`
- Modify: `src/components/BucketTable.tsx`
- Modify: `src/components/DistributionChart.tsx`
- Test: `src/App.test.tsx`

**Interfaces:**
- Consumes: everything above — `solveWeights(..., step)`, `rescaleToTotal(..., step): number[] | null`, `retargetRtp(..., step): number[] | null`, `weightForChance/weightForValue(..., step)`, `scaleSubset(..., step): number[] | null`, `setSubsetTotal(..., step)`, `stepBlockWarning`, `WEIGHT_STEPS`, `DEFAULT_WEIGHT_STEP`, `Workspace.weightStep`.
- Produces: `TargetsPanelProps` + `weightStep: WeightStep`, `onWeightStep: (s: WeightStep) => void`; `BucketTableProps` + `weightStep: WeightStep`; `DistributionChartProps` + `weightStep: WeightStep`, `onDragBlocked: () => void`.

- [ ] **Step 1: Write the failing tests**

Add to `src/App.test.tsx` (new imports: `import { saveWorkspace } from './lib/storage'` and `import { DEFAULT_CHART, DEFAULT_TARGETS } from './lib/types'`):

```ts
describe('weight step', () => {
  it('snaps Auto-Distribute to the chosen step', () => {
    loadRealData()
    fireEvent.click(screen.getByRole('button', { name: '×100' }))
    fireEvent.click(screen.getByRole('button', { name: 'Auto-Distribute' }))

    const weights = [...document.querySelectorAll('tbody .col-weight .gcell')].map((c) =>
      Number((c.textContent ?? '').replace(/,/g, '')),
    )
    expect(weights).toHaveLength(30)
    expect(weights.every((w) => w % 100 === 0)).toBe(true)
  })

  it('is undoable', () => {
    loadRealData()
    fireEvent.click(screen.getByRole('button', { name: '×100' }))
    expect(screen.getByRole('button', { name: '×100' }).className).toContain('active')
    fireEvent.click(screen.getByRole('button', { name: /Undo/ }))
    expect(screen.getByRole('button', { name: 'free' }).className).toContain('active')
  })

  it('restores from a saved workspace', () => {
    saveWorkspace({
      version: 1,
      rows: [{ uid: 'b1', bucketId: 0, payout: 2, label: 'x', weight: 500, locked: false }],
      targets: DEFAULT_TARGETS,
      volatility: 'medium',
      curve: 0.09,
      columnWidths: {},
      chart: DEFAULT_CHART,
      exportFilename: 'f.tsv',
      weightStep: 100,
    })
    render(<App />)
    expect(screen.getByRole('button', { name: '×100' }).className).toContain('active')
  })
})
```

(The paste seed loads at 1,000,000 total, which divides by 100, so Auto-Distribute is not blocked in the first test.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/App.test.tsx`
Expected: FAIL — no button named "×100" exists yet.

- [ ] **Step 3: Implement the TargetsPanel control**

In `src/components/TargetsPanel.tsx`:

1. Extend the types import: `import { CURVE_PRESETS, VOLATILITY_STEPS, WEIGHT_STEPS, type Targets, type Volatility, type WeightStep } from '../lib/types'`.
2. Add to `TargetsPanelProps`: `weightStep: WeightStep` and `onWeightStep: (s: WeightStep) => void` (destructure both in the component).
3. Insert this field as the **first** field of the second `targets-row`, before the actions field (Curve c has moved up to the first row — see `2026-08-07-compact-layout-design.md`):

```tsx
        <div className="target-field">
          <label className="field-label">Weight step</label>
          <div className="seg">
            {WEIGHT_STEPS.map((s) => (
              <button
                key={s}
                type="button"
                className={`seg-btn ${weightStep === s ? 'active' : ''}`}
                onClick={() => onWeightStep(s)}
                title={s === 1 ? 'Weights land on any integer' : `Distributed weights land on multiples of ${s}`}
              >
                {s === 1 ? 'free' : `×${s}`}
              </button>
            ))}
          </div>
          <div className="field-meta">
            <span className="field-hint">granularity of distributed weights — typed cells are never snapped</span>
          </div>
        </div>
```

- [ ] **Step 4: Implement the BucketTable and DistributionChart threading**

`src/components/BucketTable.tsx`:
1. Import the type: `import type { BucketRow, ColumnKey, RowPatch, SortKey, SortState, WeightStep } from '../lib/types'`.
2. Add `weightStep: WeightStep` to `BucketTableProps` and destructure it.
3. Pass it to the two cell solves:
   - `BucketTable.tsx:307` → `weightForValue(row.weight, totalWeight, row.payout, n, weightStep)`
   - `BucketTable.tsx:323` → `weightForChance(row.weight, totalWeight, n, weightStep)`

`src/components/DistributionChart.tsx`:
1. Import the type: `import type { BucketRow, ChartSettings, WeightStep } from '../lib/types'`.
2. Add to `DistributionChartProps`: `weightStep: WeightStep` and `onDragBlocked: () => void` (destructure both).
3. Add `blockedNotified: boolean` to `DragState`, initialized `false` in `beginDrag`.
4. Rework the middle of `moveDrag` (`DistributionChart.tsx:304-313`):

```ts
    let weights: number[] | null
    if (metric === 'chance') {
      weights = scaleSubset(d.baseRows, d.uids, clamp(value, 0, 1) * d.baseTotal, weightStep)
    } else if (relative) {
      weights = scaleSubset(d.baseRows, d.uids, value, weightStep)
    } else {
      weights = setSubsetTotal(d.baseRows, d.uids, value, weightStep)
    }

    if (weights === null) {
      // Off-step table: the drag has nowhere legal to move. Say so once.
      if (!d.blockedNotified) {
        d.blockedNotified = true
        onDragBlocked()
      }
      return
    }

    const next = d.baseRows.map((r, i) => (r.weight === weights[i] ? r : { ...r, weight: weights[i] }))
```

- [ ] **Step 5: Implement the App wiring**

In `src/App.tsx`:

1. Imports: add `WeightStep` to the type import; add `DEFAULT_WEIGHT_STEP` to the values imported from `./lib/types`; add `stepBlockWarning` to the import from `./lib/distribute`.
2. `Doc` gains `weightStep: WeightStep`; `emptyDoc()` sets `weightStep: DEFAULT_WEIGHT_STEP`; the restore branch sets `weightStep: saved.weightStep ?? DEFAULT_WEIGHT_STEP`.
3. The `saveWorkspace` effect payload gains `weightStep: doc.weightStep`.
4. Shared notice helper (module scope, next to `SEED_TOTAL_WEIGHT`):

```ts
const offStepNotice = (step: number) =>
  `The current weights are not multiples of ${step} — run Auto-Distribute first, or set the weight step to free.`
```

5. `loadData` seeding: `solveWeights(rows, SEED_TOTAL_WEIGHT, docRef.current.targets, docRef.current.curve, docRef.current.weightStep)`.
6. `autoDistribute`: `solveWeights(d.rows, total, d.targets, d.curve, d.weightStep)` (its blocking warning arrives through `res.warnings` and needs no extra handling).
7. `changeTotalWeight` — pass the step and split the null cases:

```ts
      const d = docRef.current
      const scaled = rescaleToTotal(d.rows, next, d.weightStep)
      if (scaled === null) {
        const lockedSum = d.rows
          .filter((r) => r.locked)
          .reduce((a, r) => a + r.weight, 0)
        if (next < lockedSum) {
          setNotices([
            `Total weight cannot be set below the locked weight (${lockedSum.toLocaleString('en-US')}).`,
          ])
        } else {
          setNotices([stepBlockWarning(Math.round(next) - lockedSum, lockedSum, d.weightStep)])
        }
        return
      }
```

8. `changeTotalRtp` — handle the new null:

```ts
      const weights = retargetRtp(d.rows, totalWeight, next, d.weightStep)
      if (weights === null) {
        setNotices([offStepNotice(d.weightStep)])
        return
      }
```

9. Drag-blocked callback:

```ts
  const handleDragBlocked = useCallback(() => {
    setNotices([offStepNotice(docRef.current.weightStep)])
  }, [])
```

10. New props at the render sites: `TargetsPanel` gets `weightStep={doc.weightStep}` and `onWeightStep={(s) => commit((d) => ({ ...d, weightStep: s }))}`; `BucketTable` gets `weightStep={doc.weightStep}`; `DistributionChart` gets `weightStep={doc.weightStep}` and `onDragBlocked={handleDragBlocked}`.

- [ ] **Step 6: Run the App tests, then the whole suite, build, and lint**

Run: `npx vitest run src/App.test.tsx`
Expected: PASS — all three new tests plus the existing App suite.

Run: `npm run test:run`
Expected: PASS across every test file.

Run: `npm run build`
Expected: clean TypeScript build, no errors.

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 7: Update README**

`README.md` documents the tool's features (it has sections on distribution, grouping, and chart dragging). Add a short paragraph under the distribution/targets documentation: the **Weight step** switch (free · 10 · 100) makes every tool-distributed weight land on a multiple of the step; typed weight cells are never snapped; operations that cannot keep the total on-step are blocked with a notice naming the nearest compatible totals. Match the surrounding tone and heading level.

- [ ] **Step 8: Commit**

```bash
git add src/App.tsx src/components/TargetsPanel.tsx src/components/BucketTable.tsx src/components/DistributionChart.tsx src/App.test.tsx README.md
git commit -m "feat: weight step switch in the targets panel, wired through all weight ops"
```
