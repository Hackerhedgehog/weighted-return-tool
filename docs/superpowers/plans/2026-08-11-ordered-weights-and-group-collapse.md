# Weight Floor, Payout-Ordered Weights, and Collapsible Table Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-Distribute never leaves a bucket on zero weight, always produces weights that fall as payout rises, and the buckets table can collapse a group into one aggregate row.

**Architecture:** Three independent strands. The solver work all lands in `src/lib/distribute.ts` — a weight floor reserved before the chance-driven group masses are split, a per-band slope floor that makes the weight curve non-increasing by construction, a fixed-point loop that shifts group mass when ordering and the chance targets disagree, and an order-preserving integer stage. The table work adds a display-row model (`src/lib/tableRows.ts`) that mirrors the chart's existing `buildBars`, plus a summary-row renderer and a generalized chip row. Nothing touches the export.

**Tech Stack:** TypeScript, React 19, Vite 8, vitest 4 (node environment by default; `// @vitest-environment jsdom` per file for component tests), `@testing-library/react`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-11-ordered-weights-and-group-collapse-design.md`. Read it before starting.
- Target ranking, most important to maintain first: **locks → target RTP → payout ordering → volatility → hit chance → win chance**. Every time a target yields, push a named warning onto `SolveResult.warnings`.
- Ordering invariant, over **unlocked rows with `payout > 0`** sorted by payout ascending: weight never rises. Equal payouts are unconstrained against each other. Locked rows are never moved or reordered.
- Residual invariant: if a residual bucket exists it holds the largest weight in the table. Zero-payout buckets other than the residual are exempt from ordering.
- The weight floor applies to **unlocked** rows only. A locked 0 stays 0.
- Run `npm run test:run` and `npm run lint` before every commit. Both must be clean.
- Comments explain *why*, never *what* — match the existing density in `distribute.ts`. No comment restates the line below it.
- Never edit `example-input-data.tsv` or `example-output-data.tsv`. They are the engine's reference files.
- The exported TSV must not change. `buildTsv` and `sortRows` are not touched by any task.

---

### Task 1: Residual bucket detection and the zero-payout split

**Files:**
- Modify: `src/lib/distribute.ts`
- Test: `src/lib/distribute.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export function residualIndex(rows: BucketRow[]): number` — index of the zero-payout catch-all row, or `-1`. `Ctx` gains a `residual: number` field. Later tasks read `ctx.residual`.

**Background:** `continuousWeights` splits the zero-payout group's mass in proportion to the weights those buckets already carry. On a fresh paste they carry none, so it falls back to an even split and the `0x` bucket ties with the four tease buckets at 14% of the table each. `currentMasses` (the `useChances: false` path) has the same problem one level up: with no weights to measure it sizes the three groups by *member count*, handing the zero group 5/30 of the table.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/distribute.test.ts`. Import `residualIndex` from `./distribute` alongside the existing imports.

```ts
describe('the zero-payout residual', () => {
  it('picks the bucket labelled 0x', () => {
    expect(rows[residualIndex(rows)].label).toBe('0x')
  })

  it('ignores payout labels that merely contain the characters', () => {
    const table = [
      { ...rows[0], payout: 0, label: '1000x' },
      { ...rows[1], payout: 0, label: '100x' },
    ]
    expect(residualIndex(table)).toBe(-1)
  })

  it('accepts 0x as a token inside a longer label', () => {
    expect(residualIndex([{ ...rows[0], payout: 0, label: 'lose-0x-total' }])).toBe(0)
  })

  it('never picks a paying bucket', () => {
    expect(residualIndex([{ ...rows[0], payout: 2, label: '0x' }])).toBe(-1)
  })

  it('gives the residual the bulk of the zero mass on a weightless table', () => {
    const r = solveWeights(rows, T, DEFAULT_TARGETS, CURVE_PRESETS.medium)
    const zeros = rows.map((_, i) => i).filter((i) => rows[i].payout === 0)
    const zeroSum = zeros.reduce((a, i) => a + r.weights[i], 0)
    expect(r.weights[residualIndex(rows)] / zeroSum).toBeCloseTo(0.8, 2)
  })

  it('splits evenly when no bucket names itself the residual', () => {
    const anon = rows.map((r) => (r.payout === 0 ? { ...r, label: `dud-${r.bucketId}` } : r))
    const r = solveWeights(anon, T, DEFAULT_TARGETS, CURVE_PRESETS.medium)
    const got = anon.map((_, i) => i).filter((i) => anon[i].payout === 0).map((i) => r.weights[i])
    expect(Math.max(...got) - Math.min(...got)).toBeLessThanOrEqual(1)
  })

  it('preserves an existing zero balance rather than reshaping it', () => {
    const seeded = solveWeights(rows, T, DEFAULT_TARGETS, CURVE_PRESETS.medium).weights
    const hand = withWeights(seeded).map((r) => (r.payout === 0 ? { ...r, weight: 100_000 } : r))
    const total = hand.reduce((a, r) => a + r.weight, 0)
    const again = solveWeights(hand, total, DEFAULT_TARGETS, CURVE_PRESETS.medium)
    const got = hand.map((_, i) => i).filter((i) => hand[i].payout === 0).map((i) => again.weights[i])
    expect(Math.max(...got) - Math.min(...got)).toBeLessThanOrEqual(1)
  })

  it('sizes the zero group by mass, not member count, with chances off', () => {
    const off = { ...DEFAULT_TARGETS, useChances: false }
    const r = solveWeights(rows, T, off, CURVE_PRESETS.medium)
    expect(statsOf(withWeights(r.weights), T).hitChance).toBeCloseTo(0.3, 2)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/distribute.test.ts -t "the zero-payout residual"`
Expected: FAIL — `residualIndex is not a function`, and once that is added, the 0.8 split and the chances-off hit chance (0.833, not 0.3) still fail.

- [ ] **Step 3: Add `residualIndex` and the split rule**

In `src/lib/distribute.ts`, add directly below `groupOf`:

```ts
/**
 * The residual loss bucket: the zero-payout row a table uses as its catch-all.
 *
 * Matched by label rather than by weight, because the whole point is to seed a
 * table that has no weights yet. An exact `0x` wins outright; failing that a
 * label carrying `0x` as a whole token — so `100x` and `1000x`, which contain
 * the characters but name a payout, never match.
 *
 * Returns -1 when no zero-payout row names itself, in which case the group has
 * no residual and splits evenly, exactly as it always has.
 */
const RESIDUAL_TOKEN_RE = /(^|[^0-9a-z])0x([^0-9a-z]|$)/i

export function residualIndex(rows: BucketRow[]): number {
  let token = -1
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].payout > 0) continue
    if (rows[i].label.trim().toLowerCase() === '0x') return i
    if (token === -1 && RESIDUAL_TOKEN_RE.test(rows[i].label)) token = i
  }
  return token
}

/**
 * How a zero-payout group with no weights of its own divides its mass.
 *
 * An even split leaves the residual tied with the teases — the table's most
 * common outcome indistinguishable from its rarest. The residual takes the
 * bulk instead; a locked residual is not in `idx` at all, so its weight stands.
 */
const ZERO_RESIDUAL_SHARE = 0.8

function zeroShares(idx: number[], residual: number): number[] {
  const at = idx.indexOf(residual)
  if (at === -1 || idx.length === 1) return idx.map(() => 1 / idx.length)
  const rest = (1 - ZERO_RESIDUAL_SHARE) / (idx.length - 1)
  return idx.map((_, k) => (k === at ? ZERO_RESIDUAL_SHARE : rest))
}
```

In the `Ctx` interface add `residual: number` after `curve: number`. In `buildCtx`, return it:

```ts
  return {
    n, payouts, locked, current, u, freeIdx, lockedSum, totalLocked, total, curve,
    residual: residualIndex(rows),
  }
```

In `continuousWeights`' zero-payout branch, replace the `props` line:

```ts
      const props = sum > 0 ? base.map((b) => b / sum) : zeroShares(idx, ctx.residual)
```

Change `currentMasses` to take the targets and drop the count fallback:

```ts
function currentMasses(ctx: Ctx, targets: Targets): number[] {
  const sums = [0, 1, 2].map(
    (g) => ctx.lockedSum[g] + ctx.freeIdx[g].reduce((a, i) => a + ctx.current[i], 0),
  )
  const tot = sums.reduce((a, b) => a + b, 0)
  // Nothing to preserve. Sizing by member count would hand the zero group a
  // share with no relation to mass, so fall back to the chance targets' own
  // split even though they are switched off.
  if (!(tot > 0)) return massesFor(targets, 0, ctx.total)
  return sums.map((s) => (s / tot) * ctx.total)
}
```

At its call site in `solveWeights`, pass the targets: `freeBudgets(ctx, currentMasses(ctx, targets))`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:run`
Expected: PASS, including the whole existing suite. If `lets the curve span the whole ladder once the groups are unpinned` fails, the two solves have converged — report it rather than weakening the assertion.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/lib/distribute.ts src/lib/distribute.test.ts
git commit -m "feat: give the 0x residual bucket the bulk of the zero-payout mass"
```

---

### Task 2: Minimum weight floor in the solver

**Files:**
- Modify: `src/lib/distribute.ts`
- Test: `src/lib/distribute.test.ts`

**Interfaces:**
- Consumes: `Ctx.residual` from Task 1 (untouched here).
- Produces: `export function minTotalWeight(rows: BucketRow[], step: WeightStep): number` and `export function floorBlockWarning(rows: BucketRow[], step: WeightStep, total: number): string`. Task 3 calls both from `App.tsx`. `freeBudgets` gains a third parameter `step: number`.

**Background:** the floor lives inside `allocate`, per group, via `largestRemainder(..., minOne: true, step)`. `minOne` silently does nothing when the group's budget cannot give every member one step. Two cases hit it: a group the chance targets leave with zero mass (hit chance = win chance wipes out the `0 < payout <= 1` group), and a step too coarse for the total.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/distribute.test.ts`, importing `minTotalWeight` from `./distribute`:

```ts
describe('the minimum weight floor', () => {
  it('leaves no unlocked bucket on zero when a group has no mass', () => {
    const flat = { ...DEFAULT_TARGETS, hitChance: 0.12, winChance: 0.12 }
    const r = solveWeights(rows, T, flat, CURVE_PRESETS.medium)
    expect(Math.min(...r.weights)).toBeGreaterThanOrEqual(1)
    expect(sum(r.weights)).toBe(T)
  })

  it('gives every unlocked bucket a full step when the step is coarse', () => {
    const r = solveWeights(rows, 10_000, DEFAULT_TARGETS, CURVE_PRESETS.medium, 100)
    expect(Math.min(...r.weights)).toBeGreaterThanOrEqual(100)
    expect(sum(r.weights)).toBe(10_000)
  })

  it('refuses, naming a workable total, when the step cannot go round', () => {
    const r = solveWeights(rows, 1_000, DEFAULT_TARGETS, CURVE_PRESETS.medium, 100)
    expect(r.weights).toEqual(rows.map(() => 0))
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toContain('30 unlocked buckets')
    expect(r.warnings[0]).toContain('3,000')
  })

  it('counts locked weight towards the workable total', () => {
    const locked = rows.map((r, i) => (i === 0 ? { ...r, weight: 5_000, locked: true } : r))
    expect(minTotalWeight(locked, 100)).toBe(5_000 + 29 * 100)
    expect(minTotalWeight(rows, 1)).toBe(30)
  })

  it('leaves a locked zero weight on zero', () => {
    const locked = rows.map((r, i) => (i === 0 ? { ...r, weight: 0, locked: true } : r))
    const r = solveWeights(locked, T, DEFAULT_TARGETS, CURVE_PRESETS.medium)
    expect(r.weights[0]).toBe(0)
    expect(sum(r.weights)).toBe(T)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/distribute.test.ts -t "the minimum weight floor"`
Expected: FAIL — `minTotalWeight is not a function`; the hit=win case reports `0` as the minimum weight; the coarse-step case reports `0`.

- [ ] **Step 3: Reserve the floor before the masses are split**

In `src/lib/distribute.ts`, add beside `stepBlockWarning`:

```ts
/** Smallest total that holds the locks and still floors every unlocked row. */
export function minTotalWeight(rows: BucketRow[], step: WeightStep = 1): number {
  let locked = 0
  let free = 0
  for (const r of rows) {
    if (r.locked) locked += Math.max(0, Math.round(r.weight))
    else free += 1
  }
  return locked + free * step
}

/** Refusal naming the total that would fund one step per unlocked bucket. */
export function floorBlockWarning(rows: BucketRow[], step: WeightStep, total: number): string {
  const fmt = (n: number) => n.toLocaleString('en-US')
  const free = rows.filter((r) => !r.locked).length
  return `Total weight ${fmt(total)} cannot give all ${fmt(free)} unlocked buckets a weight of at least ${fmt(step)} — raise the total to at least ${fmt(minTotalWeight(rows, step))}, or lower the weight step.`
}
```

Replace `freeBudgets` entirely:

```ts
/**
 * Turn group masses into budgets for the unlocked buckets.
 *
 * Locked weight is subtracted first; a group whose locks already overrun its
 * mass is clamped to zero and flagged. Every unlocked bucket is then owed one
 * step, so a group the chance targets leave empty still cannot starve its
 * members — the floor has to be applied *to* the split rather than inside it,
 * because a group with no mass gets no split to apply it in.
 *
 * The floor is a minimum, not a tax. A group already clearing one step per
 * bucket keeps its mass share untouched, which is the normal case and what
 * keeps the chance targets landing exactly; only a group that cannot fund its
 * own floor takes anything, and it comes from the slack of the groups that
 * can. Reserving a flat `count x step` off the top instead would shift mass
 * toward whichever group has the most buckets per unit of mass — on the
 * reference table at step 100 that is the 23-bucket win group, and it drags
 * hit chance from 0.300 to 0.301 for no reason at all.
 */
function freeBudgets(
  ctx: Ctx,
  masses: number[],
  step: number,
): { budgets: number[]; conflict: boolean } {
  const free = Math.max(0, ctx.total - ctx.totalLocked)
  const raw = [0, 1, 2].map((g) => masses[g] - ctx.lockedSum[g])
  const conflict = raw.some((v) => v < -0.5)

  const counts = [0, 1, 2].map((g) => ctx.freeIdx[g].length)
  const totalCount = counts.reduce((a, b) => a + b, 0)
  if (totalCount === 0) return { budgets: [0, 0, 0], conflict }

  const shares = raw.map((v, g) => (counts[g] === 0 ? 0 : Math.max(0, v)))
  const sum = shares.reduce((a, b) => a + b, 0)
  // No group can take weight by mass. Spread by unlocked bucket count so the
  // total still balances.
  const base =
    sum > 0 ? shares.map((v) => (v / sum) * free) : counts.map((c) => (free * c) / totalCount)

  const reserve = counts.map((c) => c * step)
  const need = base.map((b, g) => Math.max(0, reserve[g] - b))
  const shortfall = need.reduce((a, b) => a + b, 0)
  if (shortfall <= 0) return { budgets: base, conflict }

  const slack = base.map((b, g) => Math.max(0, b - reserve[g]))
  const totalSlack = slack.reduce((a, b) => a + b, 0)
  // `solveWeights` refuses before reaching here when the free weight cannot
  // cover every reserve, which is exactly the condition that guarantees
  // `totalSlack >= shortfall`.
  if (!(totalSlack > 0)) return { budgets: reserve, conflict }
  return {
    budgets: base.map((b, g) => b + need[g] - (slack[g] / totalSlack) * shortfall),
    conflict,
  }
}
```

The budgets still sum to exactly `free`: `base` does, and the correction adds `shortfall` and takes `shortfall` back. A group with a shortfall lands on exactly its reserve (`base + need === reserve`, and its slack is 0 so it gives nothing back); a group with slack keeps at least its own reserve, because `shortfall <= totalSlack`.

Add a sixth test to the suite above, pinning the property this formula exists to preserve — the floor must cost the chance targets nothing when it does not bind:

```ts
  it('costs the chance targets nothing when every group clears its floor', () => {
    const r = solveWeights(rows, 1_200_300, DEFAULT_TARGETS, CURVE_PRESETS.medium, 100)
    const s = statsOf(withWeights(r.weights), 1_200_300)
    expect(s.hitChance).toBeCloseTo(0.3, 4)
    expect(s.winChance).toBeCloseTo(0.12, 4)
  })
```

Pass `step` as the third argument at all three `freeBudgets(...)` call sites in `solveWeights` — the pooled branch, the band-candidate loop, and the no-candidate fallback.

In `allocate`, after `const groupBudgets = largestRemainder(groupSums, free, false, step)`, add:

```ts
  // Rounding to the step can shave a group below the reserve it was budgeted
  // for. Top it back up from whichever group still has slack — `freeBudgets`
  // guarantees the free weight covers every reserve, so one does.
  const need = active.map((g) => ctx.freeIdx[g].length * step)
  for (let k = 0; k < active.length; k++) {
    for (let j = 0; j < active.length && groupBudgets[k] < need[k]; j++) {
      if (j === k) continue
      const take = Math.min(need[k] - groupBudgets[k], Math.max(0, groupBudgets[j] - need[j]))
      groupBudgets[j] -= take
      groupBudgets[k] += take
    }
  }
```

In `solveWeights`, move the existing `const freeWeight = Math.round(ctx.total - ctx.totalLocked)` up to sit immediately after the all-rows-locked guard, and add the refusal below it:

```ts
  const freeWeight = Math.round(ctx.total - ctx.totalLocked)
  const freeCount = ctx.freeIdx.reduce((a, g) => a + g.length, 0)
  // An indivisible remainder is parked on one bucket *on top of* its floor, so
  // it is the divisible part that has to fund them all.
  if (freeWeight - (freeWeight % step) < freeCount * step) {
    return { ...empty, warnings: [floorBlockWarning(rows, step, Math.round(totalWeight))] }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:run`
Expected: PASS. Watch `hits RTP to step granularity and keeps the chances in band` and `lands every weight on a multiple of 10 and still sums exactly` — both already assert an empty `warnings` array and a minimum weight, and both must stay green.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/lib/distribute.ts src/lib/distribute.test.ts
git commit -m "feat: reserve one weight step per unlocked bucket before splitting mass"
```

---

### Task 3: The floor on rescale, and the notice that explains it

**Files:**
- Modify: `src/lib/distribute.ts` (`rescaleToTotal`)
- Modify: `src/App.tsx` (`changeTotalWeight`, around line 450)
- Test: `src/lib/distribute.test.ts`, `src/App.test.tsx`

**Interfaces:**
- Consumes: `minTotalWeight`, `floorBlockWarning` from Task 2.
- Produces: nothing new.

**Background:** `rescaleToTotal` passes `minOne: false`, so scaling a table down can zero a bucket. `App.changeTotalWeight` reconstructs *why* a rescale returned `null` from the row data; without a branch for the floor it would report a new floor failure as a step-divisibility problem.

`retargetRtp` is deliberately **not** changed: it preserves each group's unlocked sum exactly, so when a group's own sum cannot fund one step per member the floor is unenforceable there, and inventing a refusal on an RTP-cell edit would be worse than leaving today's behaviour.

- [ ] **Step 1: Write the failing tests**

Add to the existing `describe('rescaleToTotal', ...)` block in `src/lib/distribute.test.ts`:

```ts
  it('keeps every unlocked bucket above zero when scaling down', () => {
    const out = rescaleToTotal(withWeights(start), 60)!
    expect(out).not.toBeNull()
    expect(Math.min(...out)).toBeGreaterThanOrEqual(1)
    expect(sum(out)).toBe(60)
  })

  it('refuses a total that cannot floor every unlocked bucket', () => {
    expect(rescaleToTotal(withWeights(start), 20)).toBeNull()
    expect(rescaleToTotal(withWeights(start), 2_000, 100)).toBeNull()
  })
```

Add to `src/App.test.tsx`, directly after `shows a clear notice when every row is locked and the total is changed` (around line 111). It uses the same four-event pattern that test already uses to edit the totals weight cell:

```tsx
  it('explains a total too small to floor every bucket', () => {
    loadRealData()
    const cell = document.querySelector('.totals-row .col-weight .gcell') as HTMLElement
    fireEvent.mouseDown(cell)
    fireEvent.doubleClick(cell)
    const input = document.querySelector('.totals-row .col-weight input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '20' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(screen.getByText(/cannot give all 30 unlocked buckets/)).toBeDefined()
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/distribute.test.ts src/App.test.tsx -t "floor"`
Expected: FAIL — `rescaleToTotal(..., 20)` returns an array containing zeros instead of `null`; the App shows the step-divisibility message instead of the floor one.

- [ ] **Step 3: Add the floor to `rescaleToTotal` and the branch to `App`**

In `src/lib/distribute.ts`, inside `rescaleToTotal`, after the `freeIdx.length === 0` guard:

```ts
  // Scaling down must not silently delete a bucket, so refuse rather than
  // return a table with holes in it.
  if (budget < freeIdx.length * step) return null
```

and change the allocation call's `minOne` argument from `false` to `true`:

```ts
  const alloc = largestRemainder(anyPositive ? base : base.map(() => 1), budget, true, step)
```

In `src/App.tsx`, import `floorBlockWarning` and `minTotalWeight` from `./lib/distribute` alongside the existing imports, then replace the body of the `if (scaled === null)` block in `changeTotalWeight`:

```ts
      if (scaled === null) {
        const d2 = d
        const lockedSum = d2.rows.filter((r) => r.locked).reduce((a, r) => a + r.weight, 0)
        const budget = Math.round(next) - lockedSum
        if (d2.rows.every((r) => r.locked)) {
          setNotices([
            `Every row is locked — unlock something or set the total to exactly the locked weight (${lockedSum.toLocaleString('en-US')}).`,
          ])
        } else if (next < lockedSum) {
          setNotices([
            `Total weight cannot be set below the locked weight (${lockedSum.toLocaleString('en-US')}).`,
          ])
        } else if (budget % d2.weightStep !== 0) {
          setNotices([stepBlockWarning(budget, lockedSum, d2.weightStep)])
        } else {
          setNotices([floorBlockWarning(d2.rows, d2.weightStep, Math.round(next))])
        }
        return
      }
```

If `minTotalWeight` ends up unused in `App.tsx`, drop it from the import rather than leaving a dead binding — `floorBlockWarning` calls it internally.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:run`
Expected: PASS, including `rejects a total below the locked sum`, `spreads the budget when every unlocked weight is zero` and `rejects a rescale whose free budget is off the step`.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/lib/distribute.ts src/lib/distribute.test.ts src/App.tsx src/App.test.tsx
git commit -m "feat: keep every unlocked bucket above zero when rescaling the total"
```

---

### Task 4: Per-band slope floor

**Files:**
- Modify: `src/lib/distribute.ts`
- Test: `src/lib/distribute.test.ts`

**Interfaces:**
- Consumes: `Ctx` from Task 1.
- Produces: `Ctx` gains `ordered: boolean`. Tasks 5 and 6 read it, and construct `{ ...ctx, ordered: false }` for the unordered fallback. `SolveResult` gains `curveUsed: number`. The `chooseBand(c: Ctx): Candidate` helper inside `solveWeights` — Task 5 keeps calling it. No test helpers: this task's tests index the ladder directly, and Tasks 5 and 6 define the helpers they need.

**Background:** `solveGamma` bisects over `[-40, 40]`. Reaching the RTP target under heavy curvature drives `gamma` negative and `exp(-gamma*u - c*u^2)` then rises with payout — `0.33x:73,864` against `0.6x:142,199` at `very low` volatility.

The fix is **not** a blanket `gamma >= 0`. Ordering is a condition between consecutive buckets, and for `u_i < u_j` it rearranges to `gamma >= -c * (u_i + u_j)`. Every consecutive pair must hold, so the binding bound is the largest of them — which, because `-c * (u_i + u_j)` is least negative where the pair sits lowest, is the band's **bottom** rung. Band 2's lowest pair is 1.8x and 2x (`u` 1.695 and 1.802) rather than band 1's `u = 0`, so its floor is far looser. Measured on the reference table: a blanket floor of 0 puts RTP 0.95 out of reach at both `low` and `very low`, whereas the per-band floor keeps four of the five presets untouched and needs to flatten only `very low`, leaving the tail graded 878 / 764 / 581 / 328 / 172.

- [ ] **Step 1: Write the failing tests**

Add this helper near the top of `src/lib/distribute.test.ts`, below `const sum = ...`. Task 5 uses it too; Task 6 adds a second helper beside it.

```ts
/** The payout ladder, lowest payout first. */
const ladderOf = (rs: BucketRow[], w: number[]) =>
  rs
    .map((r, i) => ({ p: r.payout, label: r.label, w: w[i] }))
    .filter((e) => e.p > 0)
    .sort((a, b) => a.p - b.p)
```

Then add the suite:

```ts
describe('the per-band slope floor', () => {
  it('stops the curve rising at very low volatility', () => {
    const r = solveWeights(rows, T, DEFAULT_TARGETS, CURVE_PRESETS['very low'])
    const at = (payout: number) => r.weights[rows.findIndex((row) => row.payout === payout)]
    // every pair the unclamped curve used to invert, in ladder order. Checking
    // one pair would pass on a solve that still rises three rungs higher up.
    expect(at(0.33)).toBeGreaterThanOrEqual(at(0.6))
    expect(at(1.8)).toBeGreaterThanOrEqual(at(2))
    expect(at(2)).toBeGreaterThanOrEqual(at(2.12))
    expect(at(2.12)).toBeGreaterThanOrEqual(at(2.61))
    expect(statsOf(withWeights(r.weights), T).rtp).toBeCloseTo(0.95, 6)
  })

  it('keeps every volatility preset hitting RTP 0.95', () => {
    for (const v of VOLATILITY_STEPS) {
      const r = solveWeights(rows, T, DEFAULT_TARGETS, CURVE_PRESETS[v])
      expect({ v, rtp: statsOf(withWeights(r.weights), T).rtp.toFixed(6) }).toEqual({
        v,
        rtp: '0.950000',
      })
    }
  })

  it('flattens only the preset whose ordered ceiling falls short', () => {
    for (const v of VOLATILITY_STEPS) {
      const r = solveWeights(rows, T, DEFAULT_TARGETS, CURVE_PRESETS[v])
      expect({
        v,
        flattened: r.curveUsed < CURVE_PRESETS[v] - 1e-9,
        warned: r.warnings.some((w) => w.includes('Volatility flattened')),
      }).toEqual({ v, flattened: v === 'very low', warned: v === 'very low' })
    }
  })

  it('lets ordering go rather than miss the RTP target', () => {
    const r = solveWeights(rows, T, { ...DEFAULT_TARGETS, rtp: 50 }, CURVE_PRESETS.medium)
    expect(statsOf(withWeights(r.weights), T).rtp).toBeCloseTo(50, 4)
    expect(r.warnings.some((w) => w.includes('ordering yielded'))).toBe(true)
    // flattening bought nothing there, so the user's curvature comes back
    expect(r.curveUsed).toBe(CURVE_PRESETS.medium)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/distribute.test.ts -t "the per-band slope floor"`
Expected: FAIL — `very low` reports `0.33x` below `0.6x`, and the RTP 50 solve carries no `ordering yielded` warning.

- [ ] **Step 3: Clamp the slope per band**

In `src/lib/distribute.ts`, rename the constant and add the floor:

```ts
const GAMMA_HI = 40
/** Only reached when the RTP target is out of reach with the ladder in order. */
const GAMMA_UNORDERED = -40
```

Delete the old `GAMMA_LO` declaration and replace its two uses (`reachRange` and `solveGamma`) with `GAMMA_UNORDERED`. The bisection range stays as wide as it ever was; the clamp below is what narrows it.

Add above `continuousWeights`:

```ts
/**
 * Smallest slope that keeps a band non-increasing, given the curvature.
 *
 * Ordering is a condition between *consecutive* buckets, not on the curve's
 * derivative: for u_i < u_j the shape needs
 *
 *   -γ·u_i - c·u_i²  ≥  -γ·u_j - c·u_j²   ⟺   γ ≥ -c·(u_i + u_j)
 *
 * Every consecutive pair has to hold, so the binding bound is the largest of
 * them — and `-c·(u_i + u_j)` is least negative where the pair sits lowest.
 * The bottom rung of a band constrains it; the rest follow.
 *
 * A band that starts well up the ladder therefore tolerates a far flatter
 * slope than one starting at u = 0: band 2's lowest pair is 1.8x and 2x, five
 * times further up than band 1's. That gap is why a blanket floor of 0 — which
 * would put RTP 0.95 out of reach at the two lowest presets — is stricter than
 * ordering actually needs.
 */
function bandFloor(ctx: Ctx, idx: number[]): number {
  const order = [...idx].sort((a, b) => ctx.u[a] - ctx.u[b])
  let lowestPair = Infinity
  for (let k = 1; k < order.length; k++) {
    const a = ctx.u[order[k - 1]]
    const b = ctx.u[order[k]]
    if (b > a) lowestPair = Math.min(lowestPair, a + b)
  }
  return Number.isFinite(lowestPair) ? -ctx.curve * lowestPair : 0
}
```

Note carefully: `Math.min` here picks the band's **lowest pair sum**, which then becomes the **largest** (least negative) bound once negated. Minimising the negated bound directly would pick the band's top pair — the loosest bound in the set — and leave a 23-member band effectively unclamped.

And, beside it, the lever that yields when that floor is not enough:

```ts
/**
 * The steepest curvature no greater than the user's that still reaches the RTP
 * target with the ladder in order, or null when even a straight line cannot.
 *
 * The slope floor is proportional to the curvature, so a heavy curve works
 * against itself twice: it bends the tail down *and* pins the slope further
 * from flat. Past a point the two together put the target out of ordered
 * reach. Volatility ranks below ordering, so it is what gives — on the
 * reference table only `very low` needs it, flattening 0.32 to 0.265.
 */
function fitCurve(ctx: Ctx, budgets: number[], target: number, pooled: boolean): number | null {
  const reaches = (c: number) => {
    const [min, max] = reachRange({ ...ctx, curve: c }, budgets, pooled)
    return target >= min - 1e-12 && target <= max + 1e-12
  }
  if (reaches(ctx.curve)) return ctx.curve
  if (!reaches(0)) return null

  let lo = 0
  let hi = ctx.curve
  for (let k = 0; k < BISECTION_STEPS; k++) {
    const mid = (lo + hi) / 2
    if (reaches(mid)) lo = mid
    else hi = mid
  }
  return lo
}
```

In `continuousWeights`, clamp inside the band loop:

```ts
  for (const [idx, budget] of curveBands(ctx, budgets, pooled)) {
    if (idx.length === 0 || !(budget > 0)) continue
    const g = ctx.ordered ? Math.max(gamma, bandFloor(ctx, idx)) : gamma
    const logs = idx.map((i) => -g * ctx.u[i] - ctx.curve * ctx.u[i] * ctx.u[i])
    const maxLog = Math.max(...logs)
    const raw = logs.map((l) => Math.exp(l - maxLog))
    const sum = raw.reduce((a, b) => a + b, 0)
    idx.forEach((i, k) => {
      w[i] = (raw[k] / sum) * budget
    })
  }
```

Add `ordered: boolean` to the `Ctx` interface and `ordered: true` to `buildCtx`'s return.

The band-position search must now run **once per ordering regime**, because the two regimes have different ceilings: a position that reaches the target with the ladder in order is rarely the position that reaches it without. Picking a position under the ordered ceiling and then solving unordered at that frozen position leaves the tolerance band unspent when it would have helped.

Replace the whole band-search block in `solveWeights` — the `Candidate` interface stays; the `let chosen` / `let fallback` declarations, the `if (pooled)` block, the `for (const s of ...)` loop and the `if (chosen === null)` block all collapse into one reusable function:

```ts
  /**
   * The band position to solve at: the least tolerance spent that puts the RTP
   * target in reach, or — when nothing does — the first lock-clean position.
   *
   * Ordering outranks the chance preferences, so the ordered pass gets first
   * refusal on the band; only when no position reaches the target in order
   * does the caller run this again unordered, which is the pre-ordering search
   * exactly.
   */
  const chooseBand = (c: Ctx): Candidate => {
    const reaches = (budgets: number[]) => {
      const [min, max] = reachRange(c, budgets, pooled)
      return targets.rtp >= min - 1e-12 && targets.rtp <= max + 1e-12
    }

    if (pooled) {
      // Nothing to search: with no chance targets there is no band to spend.
      const { budgets, conflict } = freeBudgets(c, currentMasses(c, targets), step)
      return { s: 0, budgets, conflict, reachable: reaches(budgets) }
    }

    let fallback: Candidate | null = null
    for (const s of bandCandidates()) {
      const { budgets, conflict } = freeBudgets(c, massesFor(targets, s, totalWeight), step)
      const candidate: Candidate = { s, budgets, conflict, reachable: reaches(budgets) }
      if (!conflict && candidate.reachable) return candidate
      // Locks are hard, so a lock-clean position beats an RTP-reachable one.
      if (!conflict && fallback === null) fallback = candidate
    }
    if (fallback !== null) return fallback

    const { budgets, conflict } = freeBudgets(c, massesFor(targets, 0, totalWeight), step)
    return { s: 0, budgets, conflict, reachable: reaches(budgets) }
  }

  // The ranking decides what gives when the target is out of ordered reach:
  // volatility ranks below ordering, so the curve flattens first; only when
  // even a straight line cannot reach the target does the ladder itself yield,
  // and then the user's curvature comes back, since flattening it bought
  // nothing.
  let solveCtx = ctx
  let chosen = chooseBand(ctx)
  let curveUsed = ctx.curve
  let orderYielded = false

  if (!chosen.reachable) {
    const flat = fitCurve(ctx, chosen.budgets, targets.rtp, pooled)
    const flattened = flat === null ? null : chooseBand({ ...ctx, curve: flat })
    if (flat !== null && flattened !== null && flattened.reachable) {
      solveCtx = { ...ctx, curve: flat }
      chosen = flattened
      curveUsed = flat
    } else {
      solveCtx = { ...ctx, ordered: false }
      chosen = chooseBand(solveCtx)
      orderYielded = true
    }
  }
```

Use `solveCtx` for the `solveGamma`, `continuousWeights`, `allocate` and `repairRtp` calls that follow. Add `curveUsed: number` to the `SolveResult` interface, return it from `solveWeights`, and give the `empty` result `curveUsed: targets.useVolatility ? curve : 0` so every return path carries it.

Add both warnings beside the existing reachability one:

```ts
  if (curveUsed < ctx.curve - 1e-9) {
    warnings.push(
      `Volatility flattened (curve ${ctx.curve} → ${curveUsed.toFixed(3)}) to keep weights ordered by payout while hitting RTP ${targets.rtp}.`,
    )
  }
  if (orderYielded) {
    warnings.push(
      `Weights could not be kept in payout order at RTP ${targets.rtp} — ordering yielded to the RTP target.`,
    )
  }
```

Recompute the final reachability warning against `solveCtx` rather than `chosen.reachable`, so an ordered-but-unreachable solve is not reported twice:

```ts
  const [min, max] = reachRange(solveCtx, chosen.budgets, pooled)
  if (!(targets.rtp >= min - 1e-12 && targets.rtp <= max + 1e-12)) {
    warnings.push(
      `Target RTP ${targets.rtp} is out of reach at these chances — achieved ${achieved.rtp.toFixed(6)}.`,
    )
  }
```

`Candidate.reachable` is now only used by the band search; leave it there.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:run`
Expected: PASS. Two existing tests are load-bearing here and neither may be weakened:

- `volatility` → `monotonically thins the big-payout tail as volatility falls` keeps its strict `toBeLessThan` — the measured tails are 878 / 764 / 581 / 328 / 172. If it fails, the clamp is landing on the wrong band, or `bandFloor` is picking the band's top pair instead of its bottom one.
- `the tolerance band` → `opens only when the target is otherwise unreachable` is why `chooseBand` runs twice. With `winChance: 0.0005` the ordered ceiling never reaches RTP 0.7–0.82 at any band position, so the ordered pass finds nothing; the unordered re-run is what re-opens the band at `s = 0.86`. A single pass that froze the ordered pass's `s = 0` budgets would fail this test.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/lib/distribute.ts src/lib/distribute.test.ts
git commit -m "feat: floor the weight curve's slope per band so it never rises"
```

---

### Task 5: Shift group mass when ordering and the chance targets disagree

**Files:**
- Modify: `src/lib/distribute.ts`
- Test: `src/lib/distribute.test.ts`

**Interfaces:**
- Consumes: `Ctx.residual` (Task 1), `Ctx.ordered` and the `chooseBand` helper (Task 4).
- Produces: the `ladderOf` test helper, added in Step 1 below. Task 6 builds `inversions` on top of it.

**Background:** the two positive bands are normalized to independent budgets, so the boundary at 1x can jump *upward* — `0.6x:0` against `1.8x:21,452` when hit chance equals win chance. Separately the residual can fall below the top of the ladder when hit chance is set very high. Both are fixed by moving group mass, which is exactly what the chance targets are, and both rank below ordering.

- [ ] **Step 1: Write the failing tests**

Add this helper near the top of `src/lib/distribute.test.ts`, below `const sum = ...`. Task 6 builds `inversions` on top of it.

```ts
/** The payout ladder, lowest payout first. */
const ladderOf = (rs: BucketRow[], w: number[]) =>
  rs
    .map((r, i) => ({ p: r.payout, label: r.label, w: w[i] }))
    .filter((e) => e.p > 0)
    .sort((a, b) => a.p - b.p)
```

Then add the suite:

```ts
describe('ordering against the chance targets', () => {
  const flat = { ...DEFAULT_TARGETS, hitChance: 0.12, winChance: 0.12 }

  it('does not let the win band tower over the small-win band', () => {
    const r = solveWeights(rows, T, flat, CURVE_PRESETS.medium)
    const l = ladderOf(rows, r.weights)
    // The step at 1x specifically — the rest of the ladder is Task 6's job.
    const lastSmall = l.filter((e) => e.p <= 1).at(-1)!
    const firstWin = l.find((e) => e.p > 1)!
    expect(lastSmall.w).toBeGreaterThanOrEqual(firstWin.w)
    expect(sum(r.weights)).toBe(T)
  })

  it('names win chance as the thing that gave way', () => {
    const r = solveWeights(rows, T, flat, CURVE_PRESETS.medium)
    expect(r.warnings.some((w) => w.includes('Win chance yielded'))).toBe(true)
    // the generic band warning would only repeat it
    expect(r.warnings.filter((w) => w.includes('Achieved win chance'))).toHaveLength(0)
  })

  it('keeps the residual the largest weight at a high hit chance', () => {
    const greedy = { ...DEFAULT_TARGETS, hitChance: 0.9, winChance: 0.85 }
    const r = solveWeights(rows, T, greedy, CURVE_PRESETS.medium)
    const res = residualIndex(rows)
    expect(r.weights[res]).toBeGreaterThan(Math.max(...r.weights.filter((_, i) => i !== res)))
    expect(r.warnings.some((w) => w.includes('Hit chance yielded'))).toBe(true)
    expect(sum(r.weights)).toBe(T)
  })

  it('keeps the residual dominant through the integer stage, not just the solve', () => {
    // A low win chance leaves the residual and the top of the ladder nearly
    // tied, so a margin that survives the solve but not the rounding shows up
    // here and nowhere else. Nothing downstream would catch it: the ordering
    // sweep walks the positive ladder, and the residual pays 0.
    for (const hitChance of [0.75, 0.9, 0.95]) {
      const r = solveWeights(rows, T, { ...DEFAULT_TARGETS, hitChance, winChance: 0.02 }, CURVE_PRESETS.medium)
      const res = residualIndex(rows)
      const top = Math.max(...r.weights.filter((_, i) => i !== res))
      expect({ hitChance, dominant: r.weights[res] >= top }).toEqual({ hitChance, dominant: true })
    }
  })

  it('does not report a chance target it was never steering', () => {
    const off = { ...DEFAULT_TARGETS, hitChance: 0.9, winChance: 0.85, useChances: false }
    const r = solveWeights(rows, T, off, CURVE_PRESETS.medium)
    expect(r.warnings.filter((w) => w.includes('chance'))).toEqual([])
  })

  it('leaves the ladder alone once ordering has yielded', () => {
    // Ordering gave way to reach this target, so the solve is deliberately
    // piling mass on the top of the ladder. Forcing the residual back above it
    // would take that mass straight off again, and repairRtp cannot pull it
    // back out of the zero band.
    const steep = { ...DEFAULT_TARGETS, hitChance: 0.9, winChance: 0.85, rtp: 700 }
    const r = solveWeights(rows, T, steep, CURVE_PRESETS.medium)
    expect(r.warnings.some((w) => w.includes('ordering yielded'))).toBe(true)
    expect(Math.abs(statsOf(withWeights(r.weights), T).rtp - 700)).toBeLessThan(1)
  })

  it('does not claim RTP was out of reach when it landed on target', () => {
    const greedy = { ...DEFAULT_TARGETS, hitChance: 0.9, winChance: 0.85 }
    const r = solveWeights(rows, T, greedy, CURVE_PRESETS.medium)
    const achieved = statsOf(withWeights(r.weights), T).rtp
    if (Math.abs(achieved - 0.95) < 1e-4) {
      expect(r.warnings.some((w) => w.includes('out of reach'))).toBe(false)
    }
  })

  it('shifts nothing, and warns about nothing, on a table that needs neither', () => {
    const r = solveWeights(rows, T, DEFAULT_TARGETS, CURVE_PRESETS.medium)
    expect(r.warnings).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/distribute.test.ts -t "ordering against the chance targets"`
Expected: FAIL — the flat-chance solve reports `0.6x=1 < 1.8x=…` as an inversion and carries no `Win chance yielded` warning; the greedy solve leaves the residual below the 0.33x bucket.

- [ ] **Step 3: Only spend ordering when it buys something**

Task 4 left the ordering-yield decision unconditional: when the target is out of ordered reach, it drops to the unordered regime whatever happens next. But the unordered regime is not always any better. Setting hit chance 0.9 and win chance 0.85 forces 85% of the weight into a band whose lowest payout is 1.8x, so RTP cannot fall below ≈1.549 at *any* curve or slope — the default target of 0.95 is unreachable ordered **and** unordered. Yielding there gives up the ladder and gets nothing for it, and the mass-shifting loop below is skipped into the bargain.

In `solveWeights`, replace the `else` branch of the `!chosen.reachable` block:

```ts
    } else {
      const unordered = { ...ctx, ordered: false }
      const relaxed = chooseBand(unordered)
      // Ordering only gives way when giving way actually brings the target
      // into reach. When it is out of reach either way, the ladder is the one
      // constraint still worth honouring — and the RTP warning below reports
      // the miss regardless.
      if (relaxed.reachable) {
        solveCtx = unordered
        chosen = relaxed
        orderYielded = true
      }
    }
```

`curveUsed` stays at `ctx.curve` on both paths, as before.

- [ ] **Step 4: Add the fixed-point loop**

In `src/lib/distribute.ts`, add above `solveWeights`:

```ts
/** How many mass shifts a solve will attempt before giving up and saying so. */
const ORDER_ROUNDS = 12

/** How far the residual falls short of being the table's largest weight. */
function dominanceGap(ctx: Ctx, w: number[]): number {
  const r = ctx.residual
  if (r === -1 || ctx.locked[r]) return 0
  const ladder = [...ctx.freeIdx[1], ...ctx.freeIdx[2]]
  if (ladder.length === 0) return 0
  return Math.max(...ladder.map((i) => w[i])) - w[r]
}

/**
 * Move the smallest mass from the win band to the small-win band that turns an
 * upward step at 1x into a downward one.
 *
 * A downward step there is legitimate — it is what lets the win band be rare
 * without crushing the tail — so only a rising boundary is repaired. Solved
 * against the current shapes and overshot by one step, so the integer stage
 * cannot round the fix back out; the caller re-solves γ and comes back, which
 * is what makes the approximation converge.
 */
function levelBoundary(ctx: Ctx, budgets: number[], w: number[], step: number): number {
  const a = ctx.freeIdx[1]
  const b = ctx.freeIdx[2]
  if (a.length === 0 || b.length === 0 || !(budgets[1] > 0) || !(budgets[2] > 0)) return 0
  const lowest = Math.min(...a.map((i) => w[i]))
  const highest = Math.max(...b.map((i) => w[i]))
  if (highest <= lowest) return 0

  const room = Math.max(0, budgets[2] - b.length * step)
  const rate = highest / budgets[2] + lowest / budgets[1]
  const d = Math.min((highest - lowest + step) / Math.max(rate, 1e-9), room)
  if (!(d > 0)) return 0
  budgets[1] += d
  budgets[2] -= d
  return d
}

/**
 * Move the smallest mass from the paying bands to the zero band that makes the
 * residual the table's largest weight. The zero band's mass is hit chance, so
 * this is hit chance yielding to ordering.
 */
function raiseResidual(ctx: Ctx, budgets: number[], w: number[], step: number): number {
  const gap = dominanceGap(ctx, w)
  // Clear the ladder by a full step rather than merely tie it. The caller
  // re-solves gamma after every shift, so a margin sized against the
  // pre-re-solve shapes can collapse back to nothing — and `allocate` then
  // rounds the repair away, leaving the residual a unit or two short of a
  // bucket it is supposed to dominate. Nothing downstream catches that:
  // Task 6's `enforceOrder` walks the positive ladder only, and the residual
  // pays 0.
  if (gap <= -step) return 0
  const paying = budgets[1] + budgets[2]
  if (!(paying > 0) || !(budgets[0] > 0)) return 0

  const share = w[ctx.residual] / budgets[0]
  const top = w[ctx.residual] + gap
  const members = ctx.freeIdx[1].length + ctx.freeIdx[2].length
  const room = Math.max(0, paying - members * step)
  const d = Math.min((gap + 2 * step) / Math.max(share + top / paying, 1e-9), room)
  if (!(d > 0)) return 0

  const keep = (paying - d) / paying
  budgets[0] += d
  budgets[1] *= keep
  budgets[2] *= keep
  return d
}
```

In `solveWeights`, replace the single `solveGamma` / `continuousWeights` pair with the loop:

```ts
  const budgets = chosen.budgets.slice()
  let gamma = 0
  let cont: number[] = []
  let yieldedWin = false
  let yieldedHit = false
  let settled = false

  for (let round = 0; round < ORDER_ROUNDS; round++) {
    gamma = solveGamma(solveCtx, budgets, targets.rtp, pooled)
    cont = continuousWeights(solveCtx, budgets, gamma, pooled)
    if (!solveCtx.ordered) {
      settled = true
      break
    }
    if (raiseResidual(solveCtx, budgets, cont, step) > 0) {
      yieldedHit = true
      continue
    }
    if (levelBoundary(solveCtx, budgets, cont, step) > 0) {
      yieldedWin = true
      continue
    }
    settled = true
    break
  }

  const weights = allocate(solveCtx, cont, step)
  if (solveCtx.ordered) restoreResidual(solveCtx, weights, step)
  repairRtp(solveCtx, weights, targets.rtp, step)
```

The guard matters as much as the call. Residual dominance is an *ordering* rule, and once ordering has yielded the solve is deliberately concentrating mass on the ladder's top bucket to reach the RTP target. Repairing the residual there would siphon weight straight back off that bucket, and `repairRtp` cannot undo it — it only reshuffles within the win band, never pulls weight back out of the zero band. The result is a solve tens of percent below its target with nothing said about it. The continuous-stage helpers are already skipped in that regime by the loop's `if (!solveCtx.ordered) break`; this is the same rule applied to the integer stage.

`restoreResidual` is the last piece, and it goes beside the two shift helpers:

```ts
/**
 * Give the residual back whatever the integer split took off it.
 *
 * The continuous solve leaves it clear of the ladder, but `allocate` divides
 * the zero-payout group with a one-step-per-bucket floor, which costs the
 * residual roughly its share of that floor — about three units on the
 * reference table's five-bucket group. Sizing the continuous cushion to absorb
 * that would spend hit chance the table does not need, and the size of the
 * loss depends on the group's bucket count, so a fixed cushion is the wrong
 * shape. Moving the units back afterwards is exact.
 *
 * The weight comes off the top of the ladder, which is the lowest-paying
 * bucket there is, so this is the cheapest repair available in RTP terms — and
 * `repairRtp` runs afterwards to take back what little it costs.
 */
function restoreResidual(ctx: Ctx, w: number[], step: number): void {
  const r = ctx.residual
  if (r === -1 || ctx.locked[r]) return
  const ladder = [...ctx.freeIdx[1], ...ctx.freeIdx[2]]
  if (ladder.length === 0) return

  // Closing the gap against one bucket can leave another on top; each pass
  // fixes the current highest, so the ladder's length bounds the work.
  for (let pass = 0; pass < ladder.length; pass++) {
    let top = ladder[0]
    for (const i of ladder) if (w[i] > w[top]) top = i
    if (w[top] <= w[r]) return
    const give = Math.min(
      Math.ceil((w[top] - w[r]) / 2 / step) * step,
      Math.max(0, w[top] - step),
    )
    if (give <= 0) return
    w[top] -= give
    w[r] += give
  }
}
```

Replace the `outOfBand` calls at the end so a chance that yielded reports once, not twice. Both yield warnings name a *target*, so both belong inside the existing `targets.useChances` guard — with the chance targets switched off there is no target to have missed, and `currentMasses` deliberately holds the zero-payout share wherever the user left it:

```ts
  if (!settled) {
    warnings.push('Weights could not be brought into payout order within the solver’s iteration limit.')
  }

  // Nothing to report against when the chances are not being steered.
  if (targets.useChances) {
    if (yieldedHit) {
      warnings.push(
        `Hit chance yielded to payout ordering — achieved ${achieved.hitChance.toFixed(3)} against a target of ${targets.hitChance}.`,
      )
    } else {
      outOfBand('hit chance', achieved.hitChance, targets.hitChance)
    }
    if (yieldedWin) {
      warnings.push(
        `Win chance yielded to payout ordering — achieved ${achieved.winChance.toFixed(3)} against a target of ${targets.winChance}.`,
      )
    } else {
      outOfBand('win chance', achieved.winChance, targets.winChance)
    }
  }
```

Note the existing `outOfBand` helper writes `Achieved hit chance …` / `Achieved win chance …`; leave its text alone.

The RTP reachability warning further down currently reads `reachRange(solveCtx, chosen.budgets, pooled)`. Point it at the post-loop `budgets` instead:

```ts
  const [min, max] = reachRange(solveCtx, budgets, pooled)
```

`chosen.budgets` is the range the solve *would* have had before any mass moved. Shifting mass out of the win band lowers the RTP floor, so a target the pre-shift range called unreachable is often hit exactly — at hit 0.9 / win 0.85 the solve lands on 0.950000 and then reports that 0.95 was out of reach. Reading the budgets the solve actually used closes that, and the mirror case where a shift lowers the ceiling under a target that *was* reachable.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test:run`
Expected: PASS.

`keeps the residual the largest weight at a high hit chance` is the test that needs Step 3. At hit 0.9 / win 0.85 the RTP target is unreachable in both regimes, so without Step 3 the solve drops to unordered, skips the loop entirely, and leaves the residual buried. With Step 3 it stays ordered, `raiseResidual` moves mass into the zero band until the residual clears the ladder, and hit chance is what gives. That solve also emits the RTP-out-of-reach warning, which is correct and expected alongside the hit-chance one.

These existing tests exercise the band search the loop wraps, and must stay green:

- `the tolerance band` → `never leaves the band, whatever the RTP target` — at RTP 200 nothing is reachable in either regime, so Step 3 now keeps that solve ordered. Hit chance must still land on 0.3 (no shift is needed there: the residual holds 56% of the table against a ladder top near 9%).
- `the tolerance band` → `opens only when the target is otherwise unreachable`
- `the tolerance band` → `warns when even the band cannot reach the target`
- `solveWeights at the default targets` → `lands on the preferred chances without spending the band`

- [ ] **Step 6: Lint and commit**

```bash
npm run lint
git add src/lib/distribute.ts src/lib/distribute.test.ts
git commit -m "feat: shift group mass so payout ordering outranks the chance targets"
```

---

### Task 6: Order-preserving integer stage

**Files:**
- Modify: `src/lib/distribute.ts`
- Test: `src/lib/distribute.test.ts`

**Interfaces:**
- Consumes: `Ctx.ordered` (Task 4), the loop and the `ladderOf` test helper (Task 5).
- Produces: the `inversions` test helper, added in Step 1 below. This task closes the ordering invariant.

**Background:** `largestRemainder`'s fractional tiebreak and `repairRtp`'s pairwise transfers are both blind to the ladder, so buckets a hair apart in payout come out inverted by a unit or two — `50.11x:2,055` against `50.16x:2,056` at step 1, and `50.11x:300` against `50.16x:400` at step 100.

- [ ] **Step 1: Write the failing tests**

Add this helper beside `ladderOf` in `src/lib/distribute.test.ts` — this task is its first use:

```ts
/** Every place a higher payout carries more weight than a lower one. */
const inversions = (rs: BucketRow[], w: number[]): string[] => {
  const l = ladderOf(rs, w)
  const bad: string[] = []
  for (let k = 1; k < l.length; k++) {
    if (l[k].p > l[k - 1].p && l[k].w > l[k - 1].w) {
      bad.push(`${l[k - 1].p}x=${l[k - 1].w} < ${l[k].p}x=${l[k].w}`)
    }
  }
  return bad
}
```

Then add the suite:

```ts
describe('the ladder stays in order', () => {
  it('has no inversions anywhere in the settings matrix', () => {
    for (const v of VOLATILITY_STEPS) {
      for (const rtp of [0.5, 0.95, 1.2, 2]) {
        for (const [total, step] of [
          [T, 1],
          [T, 10],
          [1_200_300, 100],
        ] as const) {
          const r = solveWeights(rows, total, { ...DEFAULT_TARGETS, rtp }, CURVE_PRESETS[v], step)
          const bad = inversions(rows, r.weights)
          expect({ v, rtp, step, bad }).toEqual({ v, rtp, step, bad: [] })
        }
      }
    }
  })

  it('still hits RTP exactly while doing it', () => {
    const r = solveWeights(rows, T, DEFAULT_TARGETS, CURVE_PRESETS.medium)
    expect(statsOf(withWeights(r.weights), T).rtp).toBeCloseTo(0.95, 6)
    expect(sum(r.weights)).toBe(T)
  })

  it('keeps the ladder ordered through an RTP-cell retarget', () => {
    const start = solveWeights(rows, T, DEFAULT_TARGETS, CURVE_PRESETS.medium).weights
    const before = statsOf(withWeights(start), T)
    for (const rtp of [0.8, 1.05, 1.4]) {
      const out = retargetRtp(withWeights(start), T, rtp)!
      const after = statsOf(withWeights(out), T)
      expect({ rtp, bad: inversions(rows, out) }).toEqual({ rtp, bad: [] })
      expect(sum(out)).toBe(T)
      // the whole point of the RTP cell: the chances do not budge
      expect(after.hitChance).toBeCloseTo(before.hitChance, 5)
      expect(after.winChance).toBeCloseTo(before.winChance, 5)
    }
  })

  it('reports a lock that sits out of payout order instead of moving it', () => {
    const top = rows.findIndex((r) => r.payout === 1000)
    const locked = rows.map((r, i) => (i === top ? { ...r, weight: 400_000, locked: true } : r))
    const r = solveWeights(locked, T, DEFAULT_TARGETS, CURVE_PRESETS.medium)
    expect(r.weights[top]).toBe(400_000)
    expect(r.warnings.some((w) => w.includes('locked weights are never reordered'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/distribute.test.ts -t "the ladder stays in order"`
Expected: FAIL — the matrix reports `50.11x=… < 50.16x=…` at several cells, and no locked-order warning exists.

- [ ] **Step 3: Guard the integer stage**

In `src/lib/distribute.ts`, add above `repairRtp`:

```ts
/** Unlocked positive-payout rows, lowest payout first. */
function ladderIdx(ctx: Ctx): number[] {
  return [...ctx.freeIdx[1], ...ctx.freeIdx[2]].sort(
    (a, b) => ctx.payouts[a] - ctx.payouts[b] || a - b,
  )
}

/** True when no higher payout carries more weight than a lower one. */
function inOrder(ctx: Ctx, w: number[], ladder: number[]): boolean {
  for (let k = 1; k < ladder.length; k++) {
    const lo = ladder[k - 1]
    const hi = ladder[k]
    if (ctx.payouts[hi] > ctx.payouts[lo] && w[hi] > w[lo]) return false
  }
  return true
}

/**
 * Integer sweep that puts the ladder back in order.
 *
 * Every fix is a transfer, so the total never moves, and weight only ever
 * travels *down* the ladder — the pairs being repaired are adjacent in payout,
 * so RTP falls by at most step × the payout gap over the total (4e-6 at step
 * 100 on the reference table). Lifting a bucket can break the pair below it,
 * hence the repeated passes; a single pair settles in one transfer, so the
 * bound is far looser than it needs to be.
 */
function enforceOrder(ctx: Ctx, w: number[], step: number, ladder: number[]): void {
  for (let pass = 0; pass < ladder.length; pass++) {
    let moved = false
    for (let k = 1; k < ladder.length; k++) {
      const lo = ladder[k - 1]
      const hi = ladder[k]
      if (ctx.payouts[hi] <= ctx.payouts[lo]) continue
      const excess = w[hi] - w[lo]
      if (excess <= 0) continue
      const give = Math.min(Math.ceil(excess / 2 / step) * step, Math.max(0, w[hi] - step))
      if (give <= 0) continue
      w[hi] -= give
      w[lo] += give
      moved = true
    }
    if (!moved) return
  }
}

/**
 * Locks are rank 1 and sit wherever the user put them, so a locked weight that
 * breaks the ladder is reported rather than moved.
 */
function lockedOrderNote(ctx: Ctx, rows: BucketRow[], w: number[]): string | null {
  const all = rows
    .map((_, i) => i)
    .filter((i) => ctx.payouts[i] > 0)
    .sort((a, b) => ctx.payouts[a] - ctx.payouts[b] || a - b)
  for (let k = 1; k < all.length; k++) {
    const lo = all[k - 1]
    const hi = all[k]
    if (ctx.payouts[hi] <= ctx.payouts[lo] || w[hi] <= w[lo]) continue
    const culprit = ctx.locked[hi] ? hi : ctx.locked[lo] ? lo : -1
    if (culprit === -1) continue
    const other = culprit === hi ? lo : hi
    return `"${rows[culprit].label}" is locked at ${w[culprit].toLocaleString('en-US')}, out of payout order with "${rows[other].label}" — locked weights are never reordered.`
  }
  return null
}
```

Thread the ladder through the repair. `transfer` gains a `ladder: number[]` parameter, its `minLo` / `minHi` locals become the floor, and every candidate move is reverted when it would invert the ladder:

```ts
function transfer(
  ctx: Ctx,
  w: number[],
  target: number,
  pair: [number, number] | null,
  step: number,
  ladder: number[],
): void {
  if (pair === null) return
  const [lo, hi] = pair
  const span = ctx.payouts[hi] - ctx.payouts[lo]
  if (!(span > 0)) return

  const err = () => (target - rtpOf(ctx, w)) * ctx.total

  const d = clamp(Math.round(err() / span / step) * step, -(w[hi] - step), w[lo] - step)
  if (d !== 0) {
    w[lo] -= d
    w[hi] += d
    if (!inOrder(ctx, w, ladder)) {
      w[lo] += d
      w[hi] -= d
    }
  }

  for (let k = 0; k < 200; k++) {
    const before = Math.abs(err())
    if (before === 0) return
    const dir = err() > 0 ? 1 : -1
    if (dir === 1 && w[lo] - step < step) return
    if (dir === -1 && w[hi] - step < step) return
    w[lo] -= dir * step
    w[hi] += dir * step
    if (Math.abs(err()) >= before || !inOrder(ctx, w, ladder)) {
      w[lo] += dir * step
      w[hi] -= dir * step
      return
    }
  }
}
```

`repairRtp` gains the same parameter and passes it on:

```ts
function repairRtp(ctx: Ctx, w: number[], target: number, step: number, ladder: number[]): void {
  const idx = ctx.freeIdx[2]
  if (idx.length < 2) return

  const err = () => Math.abs(target - rtpOf(ctx, w)) * ctx.total
  for (const pair of payoutPairs(ctx, idx)) {
    if (err() < 1e-9) return
    transfer(ctx, w, target, pair, step, ladder)
  }
}
```

Extend the comment above `repairRtp`'s accuracy note with the caveat that the guard can leave a residue when every RTP-improving move is blocked.

In `solveWeights`, replace the allocate/repair pair from Task 5 with:

```ts
  const ladder = ladderIdx(solveCtx)
  const weights = allocate(solveCtx, cont, step)
  if (solveCtx.ordered) enforceOrder(solveCtx, weights, step, ladder)
  restoreResidual(solveCtx, weights, step)
  repairRtp(solveCtx, weights, targets.rtp, step, ladder)
```

Note the order: `restoreResidual` moves **after** `enforceOrder`, not before it. `enforceOrder` pushes weight down the ladder, so it can lift the lowest-paying bucket back above the residual — running the residual repair first would leave that undone.

and add the locked note beside the other warnings, after `achieved` is computed:

```ts
  const lockNote = lockedOrderNote(solveCtx, rows, weights)
  if (lockNote !== null) warnings.push(lockNote)
```

`retargetRtp` also needs both. It promises to preserve each group's unlocked sum exactly, so it must order the two bands **separately** — `enforceOrder` only ever moves weight inside the index list it is handed, so a per-band call keeps each sum intact while a whole-ladder call would not. Add before its existing `repairRtp` call:

```ts
  // Each band on its own: the tilt above preserves every group's unlocked sum,
  // and a cross-band transfer here would undo that.
  const ladder = ladderIdx(ctx)
  for (const g of [1, 2] as const) {
    enforceOrder(ctx, result, step, ladder.filter((i) => groupOf(ctx.payouts[i]) === g))
  }
  repairRtp(ctx, result, targetRtp, step, ladder)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:run`
Expected: PASS, the whole suite. `refuses to retarget when the current weights sit off the step` depends on the step-1 solve leaving the win group off a multiple of 100 — if the new weights happen to land on one, pick a different total in that test rather than deleting it, and say so in the commit message.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/lib/distribute.ts src/lib/distribute.test.ts
git commit -m "feat: keep the payout ladder in order through rounding and RTP repair"
```

---

### Task 7: Document the solver's new contract

**Files:**
- Modify: `src/lib/distribute.ts` (header comment only)
- Modify: `README.md` (`### The solver`, `### Tolerance`, `### Volatility`)

**Interfaces:**
- Consumes: everything from Tasks 1–6. No code changes.
- Produces: nothing.

- [ ] **Step 1: Rewrite the header comment in `distribute.ts`**

Replace the existing block comment at the top of the file (the one beginning `Weight distribution solver.`) with:

```ts
/**
 * Weight distribution solver.
 *
 * The targets are over-constrained, so they are resolved by rank — most
 * important to maintain first:
 *
 *  1. Locked weights are absolute — never touched, never reordered, and a lock
 *     that breaks the payout ladder is reported rather than moved.
 *  2. RTP is hit exactly (to integer-weight granularity) by solving the slope
 *     of the weight curve.
 *  3. Ordering: every unlocked bucket holds at least one weight step, weight
 *     never rises as payout rises, and the residual `0x` bucket is the largest
 *     weight in the table. Equal payouts are unconstrained against each other,
 *     which is what keeps the tease buckets free to sit below the ladder.
 *  4. Volatility shapes whatever freedom is left, as curvature of that curve.
 *  5. Hit chance, then 6. win chance, are satisfied *structurally*, by deciding
 *     how much total weight each payout group receives. They are preferences
 *     with a relative tolerance band; the band is spent when the RTP target is
 *     otherwise unreachable, and the masses themselves are overridden when
 *     ordering demands it.
 *
 * Steps 2 and 4 do not collide because slope and curvature are different basis
 * functions: `share ∝ exp(−γ·u − c·u²)` with `u = ln(payout) − ln(pMin)`.
 * Solving γ for RTP leaves c — and therefore the volatility setting — intact.
 *
 * Nor do 3 and 4, which is less obvious. Ordering constrains γ from below, and
 * that floor is `−c·(u_i + u_j)` per band — proportional to the curvature. A
 * heavier curve therefore permits a *flatter* band and reaches a higher RTP, so
 * volatility never has to yield to ordering and there is no mechanism for it
 * to. See `bandFloor`.
 */
```

- [ ] **Step 2: Rewrite the README's solver section**

In `README.md`, replace the four numbered controls under `### The solver` with the six-rank list, matching the header comment's wording. Add, after the group-mass code fence in that section:

```markdown
Every unlocked bucket keeps at least one weight step, so Auto-Distribute never
leaves a hole in the table. When the total cannot fund that — 30 buckets at a
step of 100 needs 3,000 — the solve is refused and the notice names a total
that works.

Weights also come out ordered: walking up the payout ladder, weight never
rises. Ordering outranks both chance targets, so a table whose targets cannot
be met in order has its chances moved instead, and the notice says which one
gave way. It does *not* outrank RTP: an RTP target beyond what an ordered
ladder can reach is still met, with a notice that ordering was spent.

Zero-payout buckets are exempt from ordering against each other, which is what
lets a tease bucket sit below the top paying bucket. The one exception is the
residual — the bucket labelled `0x` — which always holds the table's largest
weight. On a table with no weights yet it takes 80% of the zero-payout mass and
the teases split the rest; once those buckets carry weights of their own,
Auto-Distribute preserves their balance instead.
```

Under `### Volatility`, add a closing paragraph:

```markdown
Volatility never has to be given up to keep weights ordered. The ordering
constraint puts a floor under the curve's slope, and that floor is proportional
to the curvature — so a heavier curve permits a flatter band and reaches a
*higher* RTP, not a lower one. All five presets remain usable at any reachable
RTP target.
```

- [ ] **Step 3: Verify the docs match the code**

Run: `npm run test:run && npm run lint`
Expected: PASS — no code changed, so this only confirms nothing was broken by an editing slip.

Re-read the two rank lists side by side. They must agree on the order and on which targets can yield.

- [ ] **Step 4: Commit**

```bash
git add src/lib/distribute.ts README.md
git commit -m "docs: record the solver's new target ranking and ordering rules"
```

---

### Task 8: Display-row model for the table

**Files:**
- Create: `src/lib/tableRows.ts`
- Create: `src/lib/tableRows.test.ts`

**Interfaces:**
- Consumes: `Grouping`, `GroupInfo`, `LockState`, `groupLockState` from `src/lib/groups.ts`; `BucketRow`, `SortState` from `src/lib/types.ts`.
- Produces:
  - `export interface GroupAggregate { payout: number; weight: number; value: number; chance: number; count: number; lock: LockState }`
  - `export type TableRow = { kind: 'bucket'; uid: string; row: BucketRow } | { kind: 'group'; uid: string; group: GroupInfo; members: BucketRow[]; agg: GroupAggregate }`
  - `export function buildTableRows(rows: BucketRow[], grouping: Grouping, collapsed: string[], sort: SortState, totalWeight: number): TableRow[]`

  Tasks 10 and 11 consume all three.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/tableRows.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseTsv } from './parse'
import { buildGrouping, seedGroups } from './groups'
import { buildTableRows } from './tableRows'
import type { SortState } from './types'

const parsed = parseTsv(readFileSync('example-output-data.tsv', 'utf8')).rows
const seeded = seedGroups(parsed)
const rows = seeded.rows
const grouping = buildGrouping(rows, seeded.groups)
const T = rows.reduce((a, r) => a + r.weight, 0)
const byId: SortState = { key: 'id', dir: 1 }

const groupIdOf = (name: string) => grouping.groups.find((g) => g.name === name)!.id

describe('buildTableRows', () => {
  it('leaves every bucket loose when nothing is collapsed', () => {
    const out = buildTableRows(rows, grouping, [], byId, T)
    expect(out).toHaveLength(rows.length)
    expect(out.every((u) => u.kind === 'bucket')).toBe(true)
  })

  it('replaces a collapsed group with one row carrying its member sums', () => {
    const id = groupIdOf('bonus')
    const members = rows.filter((r) => r.groupId === id)
    const out = buildTableRows(rows, grouping, [id], byId, T)

    expect(out).toHaveLength(rows.length - members.length + 1)
    const unit = out.find((u) => u.kind === 'group')!
    if (unit.kind !== 'group') throw new Error('expected a group row')

    expect(unit.agg.count).toBe(members.length)
    expect(unit.agg.weight).toBe(members.reduce((a, r) => a + r.weight, 0))
    expect(unit.agg.chance).toBeCloseTo(unit.agg.weight / T, 12)
    expect(unit.agg.value).toBeCloseTo(
      members.reduce((a, r) => a + r.payout * r.weight, 0) / T,
      12,
    )
    expect(unit.agg.payout).toBeCloseTo(
      members.reduce((a, r) => a + r.payout * r.weight, 0) / unit.agg.weight,
      9,
    )
  })

  it('falls back to the plain mean payout when a group holds no weight', () => {
    const id = groupIdOf('bonus')
    const zeroed = rows.map((r) => (r.groupId === id ? { ...r, weight: 0 } : r))
    const members = zeroed.filter((r) => r.groupId === id)
    const out = buildTableRows(zeroed, buildGrouping(zeroed, seeded.groups), [id], byId, T)
    const unit = out.find((u) => u.kind === 'group')!
    if (unit.kind !== 'group') throw new Error('expected a group row')
    expect(unit.agg.payout).toBeCloseTo(
      members.reduce((a, r) => a + r.payout, 0) / members.length,
      9,
    )
  })

  it('sorts a collapsed group by its aggregate, alongside the loose rows', () => {
    const id = groupIdOf('bonus')
    const out = buildTableRows(rows, grouping, [id], { key: 'weight', dir: -1 }, T)
    const weights = out.map((u) => (u.kind === 'group' ? u.agg.weight : u.row.weight))
    expect(weights).toEqual([...weights].sort((a, b) => b - a))
  })

  it('leaves the uncollapsed remainder in the order it would have had', () => {
    const id = groupIdOf('bonus')
    const loose = buildTableRows(rows, grouping, [id], byId, T)
      .filter((u) => u.kind === 'bucket')
      .map((u) => (u.kind === 'bucket' ? u.row.uid : ''))
    const all = buildTableRows(rows, grouping, [], byId, T).map((u) =>
      u.kind === 'bucket' ? u.row.uid : '',
    )
    expect(loose).toEqual(all.filter((uid) => loose.includes(uid)))
  })

  it('reports the group lock state', () => {
    const id = groupIdOf('bonus')
    const none = buildTableRows(rows, grouping, [id], byId, T).find((u) => u.kind === 'group')!
    if (none.kind !== 'group') throw new Error('expected a group row')
    expect(none.agg.lock).toBe('none')

    const some = rows.map((r) => (r.groupId === id && r.bucketId === 5 ? { ...r, locked: true } : r))
    const partial = buildTableRows(some, buildGrouping(some, seeded.groups), [id], byId, T).find(
      (u) => u.kind === 'group',
    )!
    if (partial.kind !== 'group') throw new Error('expected a group row')
    expect(partial.agg.lock).toBe('some')

    const every = rows.map((r) => (r.groupId === id ? { ...r, locked: true } : r))
    const all = buildTableRows(every, buildGrouping(every, seeded.groups), [id], byId, T).find(
      (u) => u.kind === 'group',
    )!
    if (all.kind !== 'group') throw new Error('expected a group row')
    expect(all.agg.lock).toBe('all')
  })

  it('ignores a collapsed id no group answers to', () => {
    const out = buildTableRows(rows, grouping, ['nonesuch'], byId, T)
    expect(out).toHaveLength(rows.length)
  })
})
```

`example-output-data.tsv` parses to exactly 30 buckets — `parseTsv` skips its trailing totals line, which has a blank first field. `seedGroups` puts nine of them in a group named `bonus` (bonus3/4/5 and the six `bonuspaid-*` rows); the three zero-payout `bonus*-tease` rows go to the `0x` group instead, because the zero rule outranks the label rule.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/tableRows.test.ts`
Expected: FAIL — `Cannot find module './tableRows'`.

- [ ] **Step 3: Write the module**

Create `src/lib/tableRows.ts`:

```ts
import type { BucketRow, SortState } from './types'
import { groupLockState, type GroupInfo, type Grouping, type LockState } from './groups'

/**
 * What the buckets table draws, worked out away from the table itself.
 *
 * Deliberately the same shape as `bars.ts`: collapse the groups the user has
 * asked for, then deal with whatever is left. Collapsing first is what keeps
 * the two composable — a bucket inside a collapsed group is gone before the
 * loose pass runs, so it can never appear twice.
 *
 * Sorting then happens over the *display units* rather than over buckets, so a
 * collapsed group is ranked by its own aggregate. That makes collapse work
 * under every sort, not only under Group sort.
 */

export interface GroupAggregate {
  /** Weight-weighted mean; the plain mean when the group holds no weight. */
  payout: number
  weight: number
  /** Share of the grand total's RTP, not of the group's own. */
  value: number
  chance: number
  count: number
  lock: LockState
}

export type TableRow =
  | { kind: 'bucket'; uid: string; row: BucketRow }
  | { kind: 'group'; uid: string; group: GroupInfo; members: BucketRow[]; agg: GroupAggregate }

function aggregate(
  rows: BucketRow[],
  members: BucketRow[],
  groupId: string,
  totalWeight: number,
): GroupAggregate {
  const weight = members.reduce((a, r) => a + r.weight, 0)
  const value = members.reduce((a, r) => a + r.payout * r.weight, 0)
  return {
    // The same rule the chart's collapsed bar uses, so the two views place a
    // group at the same payout. With no weight there is nothing to weight by.
    payout: weight > 0 ? value / weight : members.reduce((a, r) => a + r.payout, 0) / members.length,
    weight,
    value: totalWeight > 0 ? value / totalWeight : 0,
    chance: totalWeight > 0 ? weight / totalWeight : 0,
    count: members.length,
    lock: groupLockState(rows, groupId),
  }
}

function sortUnits(
  units: TableRow[],
  sort: SortState,
  grouping: Grouping,
  totalWeight: number,
): TableRow[] {
  const dir = sort.dir
  const payout = (u: TableRow) => (u.kind === 'group' ? u.agg.payout : u.row.payout)
  const weight = (u: TableRow) => (u.kind === 'group' ? u.agg.weight : u.row.weight)
  const value = (u: TableRow) =>
    u.kind === 'group'
      ? u.agg.value
      : totalWeight > 0
        ? (u.row.payout * u.row.weight) / totalWeight
        : 0
  // A group has no id of its own; its lowest member's is the one a reader
  // would look for it under.
  const id = (u: TableRow) =>
    u.kind === 'group' ? Math.min(...u.members.map((r) => r.bucketId)) : u.row.bucketId
  const text = (u: TableRow, key: 'label' | 'weightId') =>
    u.kind === 'group' ? u.group.name : u.row[key]
  const rank = (u: TableRow) =>
    u.kind === 'group'
      ? grouping.groups.findIndex((g) => g.id === u.group.id)
      : (grouping.rank.get(u.row.uid) ?? 0)
  const compare = (a: string, b: string) =>
    a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })

  return [...units].sort((a, b) => {
    switch (sort.key) {
      case 'group':
        return dir * (rank(a) - rank(b)) || payout(a) - payout(b) || id(a) - id(b)
      case 'label':
        return dir * compare(text(a, 'label'), text(b, 'label'))
      case 'weightId':
        return dir * compare(text(a, 'weightId'), text(b, 'weightId'))
      case 'payout':
        return dir * (payout(a) - payout(b))
      case 'weight':
      case 'chance':
        return dir * (weight(a) - weight(b))
      case 'weightedValue':
        return dir * (value(a) - value(b))
      case 'id':
      default:
        return dir * (id(a) - id(b))
    }
  })
}

export function buildTableRows(
  rows: BucketRow[],
  grouping: Grouping,
  collapsed: string[],
  sort: SortState,
  totalWeight: number,
): TableRow[] {
  const hidden = new Set(collapsed)
  const byUid = new Map(rows.map((r) => [r.uid, r]))
  const units: TableRow[] = []

  for (const g of grouping.groups) {
    if (!hidden.has(g.id)) continue
    const members = g.uids.map((u) => byUid.get(u)).filter((r): r is BucketRow => r !== undefined)
    if (members.length === 0) continue
    units.push({
      kind: 'group',
      uid: `group:${g.id}`,
      group: g,
      members,
      agg: aggregate(rows, members, g.id, totalWeight),
    })
  }

  for (const r of rows) {
    const id = grouping.byUid.get(r.uid)?.id
    if (id !== undefined && hidden.has(id)) continue
    units.push({ kind: 'bucket', uid: r.uid, row: r })
  }

  return sortUnits(units, sort, grouping, totalWeight)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/tableRows.test.ts`
Expected: PASS, all eight cases.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/lib/tableRows.ts src/lib/tableRows.test.ts
git commit -m "feat: add a display-row model that can collapse a bucket group"
```

---

### Task 9: Generalize the chip row

**Files:**
- Create: `src/components/GroupChips.tsx`
- Delete: `src/components/GroupBarChips.tsx`
- Modify: `src/components/DistributionChart.tsx` (import and usage around line 489)
- Rename: `src/components/GroupBarChips.test.tsx` → `src/components/GroupChips.test.tsx`

**Interfaces:**
- Consumes: `GroupInfo` from `src/lib/groups.ts`.
- Produces: `export function GroupChips(props: { groups: GroupInfo[]; selected: string[]; onSelected: (ids: string[]) => void; label: string; titleOn: (name: string) => string; titleOff: (name: string) => string })`. Task 11 renders a second instance of it.

- [ ] **Step 1: Move and generalize the test**

```bash
git mv src/components/GroupBarChips.test.tsx src/components/GroupChips.test.tsx
```

In the renamed file, change the import to `import { GroupChips } from './GroupChips'`, rename the `describe` to `'GroupChips'`, and rewrite `renderChips` to the new props:

```tsx
const renderChips = (selected: string[] = []) => {
  const onSelected = vi.fn()
  render(
    <GroupChips
      groups={groupRows(rows).groups}
      selected={selected}
      onSelected={onSelected}
      label="Group bars"
      titleOn={(n) => `Show ${n}'s buckets`}
      titleOff={(n) => `Draw ${n} as one bar`}
    />,
  )
  return { onSelected }
}
```

Update every `onGroupBars` reference in the file's assertions to `onSelected`. Add one case:

```tsx
  it('labels the row with whatever the caller calls it', () => {
    render(
      <GroupChips
        groups={groupRows(rows).groups}
        selected={[]}
        onSelected={vi.fn()}
        label="Collapse"
        titleOn={(n) => `Show ${n}'s buckets`}
        titleOff={(n) => `Collapse ${n} into one row`}
      />,
    )
    expect(screen.getByText('Collapse')).toBeDefined()
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/GroupChips.test.tsx`
Expected: FAIL — `Cannot find module './GroupChips'`.

- [ ] **Step 3: Write the component and rewire the chart**

Create `src/components/GroupChips.tsx`:

```tsx
import type { GroupInfo } from '../lib/groups'

/**
 * A row of toggle chips, one per group, over a set of selected group ids.
 *
 * Doubles as the legend neither the chart nor the table has otherwise: one
 * colored chip per group, so the colors are named even when nothing is
 * selected. Chips come from the *drawn* groups, not the document's group list —
 * an empty group has nothing to collapse. The selection may still name an id
 * that is not drawn; consumers ignore it, so a group emptied and refilled comes
 * back exactly as it was left.
 */

interface GroupChipsProps {
  groups: GroupInfo[]
  selected: string[]
  onSelected: (ids: string[]) => void
  /** Row label — what selecting a chip means here. */
  label: string
  titleOn: (name: string) => string
  titleOff: (name: string) => string
}

export function GroupChips({
  groups,
  selected,
  onSelected,
  label,
  titleOn,
  titleOff,
}: GroupChipsProps) {
  if (groups.length === 0) return null
  const on = new Set(selected)

  const toggle = (id: string) => {
    onSelected(on.has(id) ? selected.filter((g) => g !== id) : [...selected, id])
  }

  return (
    <div className="group-bar-chips">
      <span className="field-label">{label}</span>
      <button type="button" className="btn" onClick={() => onSelected(groups.map((g) => g.id))}>
        All
      </button>
      <button type="button" className="btn" onClick={() => onSelected([])}>
        None
      </button>
      {groups.map((g) => {
        const active = on.has(g.id)
        return (
          <button
            key={g.id}
            type="button"
            className={`group-bar-chip ${active ? 'on' : ''}`}
            aria-pressed={active}
            title={active ? titleOn(g.name) : titleOff(g.name)}
            onClick={() => toggle(g.id)}
          >
            <span className="chip-swatch" style={{ background: g.color }} aria-hidden="true" />
            {g.name}
          </button>
        )
      })}
    </div>
  )
}
```

```bash
git rm src/components/GroupBarChips.tsx
```

In `src/components/DistributionChart.tsx`, change the import to `import { GroupChips } from './GroupChips'` and the usage to:

```tsx
      <GroupChips
        groups={grouping.groups}
        selected={groupBars}
        onSelected={(ids) => set({ groupBars: ids })}
        label="Group bars"
        titleOn={(n) => `Show ${n}'s buckets`}
        titleOff={(n) => `Draw ${n} as one bar`}
      />
```

Update the file's header comment where it names `GroupBarChips` to name `GroupChips`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:run`
Expected: PASS, including `DistributionChart.test.tsx` and `App.test.tsx` — the rendered markup and the `Group bars` label are unchanged, so nothing that targets them should move.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add -A src/components
git commit -m "refactor: generalize the group chip row so the table can reuse it"
```

---

### Task 10: Render collapsed groups in the buckets table

**Files:**
- Modify: `src/components/cells.tsx` (export `CellNavProps`, tri-state `LockCell`)
- Create: `src/components/GroupSummaryRow.tsx`
- Modify: `src/components/BucketTable.tsx`
- Modify: `src/index.css`
- Test: `src/components/BucketTable.test.tsx` (create)

**Interfaces:**
- Consumes: `buildTableRows`, `TableRow` (Task 8); `LockState` from `src/lib/groups.ts`.
- Produces:
  - `cells.tsx` exports `interface CellNavProps { selected: boolean; editing: boolean; seed: EditSeed; onSelect: () => void; onStartEdit: (seed: EditSeed) => void; onStopEdit: () => void; onNavigate: (dr: number, dc: number) => void; onKeyDown: (e: React.KeyboardEvent) => void }`, and `LockCell` takes `state: LockState` instead of `locked: boolean`.
  - `BucketTable` gains props `collapsed: string[]`, `onExpand: (groupId: string) => void`, `onGroupLock: (groupId: string, locked: boolean) => void`. Task 11 supplies all three.

- [ ] **Step 1: Write the failing test**

Create `src/components/BucketTable.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { parseTsv } from '../lib/parse'
import { buildGrouping, seedGroups } from '../lib/groups'
import { DEFAULT_WIDTHS } from '../lib/columns'
import { BucketTable } from './BucketTable'
import type { SortState } from '../lib/types'

afterEach(cleanup)

const seeded = seedGroups(parseTsv(readFileSync('example-output-data.tsv', 'utf8')).rows)
const rows = seeded.rows
const grouping = buildGrouping(rows, seeded.groups)
const T = rows.reduce((a, r) => a + r.weight, 0)
const sort: SortState = { key: 'id', dir: 1 }
const groupIdOf = (name: string) => grouping.groups.find((g) => g.name === name)!.id

const renderTable = (collapsed: string[] = []) => {
  const onExpand = vi.fn()
  const onGroupLock = vi.fn()
  render(
    <BucketTable
      rows={rows}
      totalWeight={T}
      sort={sort}
      columnWidths={DEFAULT_WIDTHS}
      grouping={grouping}
      groups={seeded.groups}
      weightStep={1}
      collapsed={collapsed}
      onSort={vi.fn()}
      onPatch={vi.fn()}
      onWidths={vi.fn()}
      onTotalWeight={vi.fn()}
      onTotalRtp={vi.fn()}
      onExpand={onExpand}
      onGroupLock={onGroupLock}
    />,
  )
  return { onExpand, onGroupLock }
}

describe('BucketTable with a collapsed group', () => {
  it('draws one row per bucket when nothing is collapsed', () => {
    renderTable()
    expect(document.querySelectorAll('tbody tr')).toHaveLength(rows.length)
    expect(document.querySelectorAll('.group-summary')).toHaveLength(0)
  })

  it('replaces the group with a summary row carrying its sums', () => {
    const id = groupIdOf('bonus')
    const members = rows.filter((r) => r.groupId === id)
    renderTable([id])

    expect(document.querySelectorAll('tbody tr')).toHaveLength(rows.length - members.length + 1)
    const summary = document.querySelector('.group-summary')!
    expect(summary.querySelector('.col-label .gcell')!.textContent).toBe(
      `${members.length} buckets`,
    )
    const shown = summary.querySelector('.col-weight .gcell')!.textContent
    expect(shown).toBe(members.reduce((a, r) => a + r.weight, 0).toLocaleString('en-US'))
  })

  it('expands from the summary row', () => {
    const id = groupIdOf('bonus')
    const { onExpand } = renderTable([id])
    fireEvent.click(screen.getByRole('button', { name: /Show bonus/ }))
    expect(onExpand).toHaveBeenCalledWith(id)
  })

  it('locks every member from the summary row', () => {
    const id = groupIdOf('bonus')
    const { onGroupLock } = renderTable([id])
    fireEvent.click(document.querySelector('.group-summary .gcell.lock')!)
    expect(onGroupLock).toHaveBeenCalledWith(id, true)
  })

  it('never opens an editor on a summary cell', () => {
    const id = groupIdOf('bonus')
    renderTable([id])
    fireEvent.doubleClick(document.querySelector('.group-summary .col-weight .gcell')!)
    expect(document.querySelector('.group-summary input')).toBeNull()
  })
})
```

`fmtWeight` is `Math.round(n).toLocaleString('en-US')`, so the grouped-integer assertion above matches it exactly.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/BucketTable.test.tsx`
Expected: FAIL — `BucketTable` has no `collapsed` prop, so nothing collapses and the summary-row selectors find nothing.

- [ ] **Step 3: Export the shared cell props and make `LockCell` tri-state**

In `src/components/cells.tsx`, add above `GridCellProps` and import `LockState`:

```ts
import type { LockState } from '../lib/groups'

/** The navigation wiring every grid cell shares, whatever it renders. */
export interface CellNavProps {
  selected: boolean
  editing: boolean
  seed: EditSeed
  onSelect: () => void
  onStartEdit: (seed: EditSeed) => void
  onStopEdit: () => void
  onNavigate: (dr: number, dc: number) => void
  onKeyDown: (e: React.KeyboardEvent) => void
}
```

Change `GridCellProps` to `interface GridCellProps extends CellNavProps { ... }`, deleting the eight duplicated members from its body.

Replace `LockCell` with a tri-state version — a group is locked only when every member is, so `some` needs its own glyph:

```tsx
/** Lock toggle in the leftmost column. Not exported to TSV. */
export function LockCell({
  state,
  selected,
  onToggle,
  onSelect,
  onKeyDown,
}: {
  state: LockState
  selected: boolean
  onToggle: () => void
  onSelect: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (selected) {
      ref.current?.focus({ preventScroll: true })
      ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }, [selected])

  const label =
    state === 'all'
      ? 'Locked — Auto-Distribute will not change this weight'
      : state === 'some'
        ? 'Partly locked — click to lock the rest'
        : 'Unlocked'

  return (
    <div
      ref={ref}
      className={`gcell lock ${selected ? 'selected' : ''} ${state === 'all' ? 'on' : ''} ${
        state === 'some' ? 'partial' : ''
      }`}
      tabIndex={selected ? 0 : -1}
      role="gridcell"
      aria-label={label}
      title={state === 'none' ? 'Click to lock' : label}
      onMouseDown={onSelect}
      onClick={onToggle}
      onKeyDown={onKeyDown}
    >
      {state === 'none' ? '　' : state === 'all' ? '🔒' : '🔓'}
    </div>
  )
}
```

- [ ] **Step 4: Write the summary row**

Create `src/components/GroupSummaryRow.tsx`:

```tsx
import type { TableRow } from '../lib/tableRows'
import { fmtDecimal, fmtPayout, fmtWeight } from '../lib/format'
import { rowTint } from '../lib/palette'
import { GridCell, LockCell, type CellNavProps } from './cells'

/**
 * One collapsed bucket group, as a single grid row.
 *
 * Weights, weighted value and chance are sums, so the columns still foot to
 * the totals row; payout is the weight-weighted mean, which is the same figure
 * the distribution chart puts a collapsed group bar at. Every cell is
 * read-only — an aggregate has no single row to write back to — except the
 * lock, which sets every member at once.
 */

interface GroupSummaryRowProps {
  unit: Extract<TableRow, { kind: 'group' }>
  rowIdx: number
  cellProps: (rowIdx: number, colIdx: number) => CellNavProps
  lockSelected: boolean
  onExpand: () => void
  onToggleLock: () => void
  onSelectLock: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
}

export function GroupSummaryRow({
  unit,
  rowIdx,
  cellProps,
  lockSelected,
  onExpand,
  onToggleLock,
  onSelectLock,
  onKeyDown,
}: GroupSummaryRowProps) {
  const { group, agg } = unit

  return (
    <tr
      className="grid-row group-summary"
      style={{ background: rowTint(group.color, agg.lock === 'all') }}
    >
      <td className="col-lock">
        <LockCell
          state={agg.lock}
          selected={lockSelected}
          onToggle={onToggleLock}
          onSelect={onSelectLock}
          onKeyDown={onKeyDown}
        />
      </td>

      <td className="col-group">
        {/* The visible text is just the group name, which collides with the
            chip of the same name; the label disambiguates them and still
            carries the visible text, as WCAG's label-in-name rule wants. */}
        <button
          type="button"
          className="group-expander"
          style={{ color: group.color }}
          aria-label={`Show ${group.name}'s buckets`}
          title={`Show ${group.name}'s buckets`}
          onClick={onExpand}
        >
          <span aria-hidden="true">▸</span>
          {group.name}
        </button>
      </td>

      <td className="col-id">
        <GridCell {...cellProps(rowIdx, 2)} display="—" raw="" numeric editable={false} />
      </td>
      <td className="col-weightId">
        <GridCell {...cellProps(rowIdx, 3)} display="—" raw="" numeric={false} editable={false} />
      </td>
      <td className="col-payout">
        <GridCell
          {...cellProps(rowIdx, 4)}
          display={fmtPayout(agg.payout)}
          raw=""
          numeric
          editable={false}
          title="Weight-weighted mean payout across the group"
        />
      </td>
      <td className="col-label">
        <GridCell
          {...cellProps(rowIdx, 5)}
          display={`${agg.count} bucket${agg.count === 1 ? '' : 's'}`}
          raw=""
          numeric={false}
          editable={false}
        />
      </td>
      <td className="col-weight">
        <GridCell
          {...cellProps(rowIdx, 6)}
          display={fmtWeight(agg.weight)}
          raw=""
          numeric
          editable={false}
        />
      </td>
      <td className="col-weightedValue">
        <GridCell
          {...cellProps(rowIdx, 7)}
          display={fmtDecimal(agg.value)}
          raw=""
          numeric
          editable={false}
        />
      </td>
      <td className="col-chance">
        <GridCell
          {...cellProps(rowIdx, 8)}
          display={fmtDecimal(agg.chance)}
          raw=""
          numeric
          editable={false}
        />
      </td>
    </tr>
  )
}
```

- [ ] **Step 5: Switch `BucketTable` onto the display model**

In `src/components/BucketTable.tsx`:

Add to the imports:

```ts
import { buildTableRows, type TableRow } from '../lib/tableRows'
import { GridCell, LockCell, type CellNavProps } from './cells'
import { GroupSummaryRow } from './GroupSummaryRow'
```

Add to `BucketTableProps`, after `weightStep`:

```ts
  /** Group ids drawn as one aggregate row instead of their buckets. */
  collapsed: string[]
```

and after `onTotalRtp`:

```ts
  onExpand: (groupId: string) => void
  onGroupLock: (groupId: string, locked: boolean) => void
```

Destructure the three new props in the component signature.

Replace the `sorted` memo:

```ts
  const display = useMemo(
    () => buildTableRows(rows, grouping, collapsed, sort, totalWeight),
    [rows, grouping, collapsed, sort, totalWeight],
  )
```

Replace `const totalsRowIndex = sorted.length` with `const totalsRowIndex = display.length`, and the `rtp` reduce's `sorted` with `rows` — the RTP of the table does not depend on what is collapsed.

Rewrite `displayFor`, `toggleLock`, `clearCell` and `isEditable` against the display model:

```ts
  const displayFor = useCallback(
    (u: TableRow, key: ColumnKey): string => {
      const total = totalWeight
      if (u.kind === 'group') {
        switch (key) {
          case 'payout':
            return fmtPayout(u.agg.payout)
          case 'label':
            return `${u.agg.count} bucket${u.agg.count === 1 ? '' : 's'}`
          case 'weight':
            return fmtWeight(u.agg.weight)
          case 'weightedValue':
            return fmtDecimal(u.agg.value)
          case 'chance':
            return fmtDecimal(u.agg.chance)
          default:
            return ''
        }
      }
      const r = u.row
      switch (key) {
        case 'id':
          return String(r.bucketId)
        case 'weightId':
          return r.weightId
        case 'payout':
          return fmtPayout(r.payout)
        case 'label':
          return r.label
        case 'weight':
          return fmtWeight(r.weight)
        case 'weightedValue':
          return fmtDecimal(total > 0 ? (r.payout * r.weight) / total : 0)
        case 'chance':
          return fmtDecimal(total > 0 ? r.weight / total : 0)
        default:
          return ''
      }
    },
    [totalWeight],
  )

  const toggleLock = useCallback(
    (rowIdx: number) => {
      const u = display[rowIdx]
      if (u === undefined) return
      if (u.kind === 'group') onGroupLock(u.group.id, u.agg.lock !== 'all')
      else onPatch(u.row.uid, { locked: !u.row.locked })
    },
    [display, onPatch, onGroupLock],
  )

  const clearCell = useCallback(
    (pos: CellPos) => {
      const u = display[pos.row]
      if (u === undefined || u.kind === 'group') return
      const key = COLUMNS[pos.col].key
      if (key === 'label') onPatch(u.row.uid, { label: '' })
      else if (key === 'id') onPatch(u.row.uid, { bucketId: 0 })
      else if (key === 'payout') onPatch(u.row.uid, { payout: 0 })
      else if (key === 'weight' || key === 'weightedValue' || key === 'chance') {
        onPatch(u.row.uid, { weight: 0 })
      }
    },
    [display, onPatch],
  )

  const isEditable = useCallback(
    (pos: CellPos) => {
      const key = COLUMNS[pos.col]?.key
      // Group is a dropdown, not a text cell — it has its own edit affordance.
      if (key === undefined || key === 'lock' || key === 'group') return false
      if (pos.row === display.length) return key === 'weight' || key === 'weightedValue'
      const u = display[pos.row]
      // A collapsed group's cells are aggregates: there is no single row to
      // write back to.
      if (u === undefined || u.kind === 'group') return false
      if (key === 'weightedValue') return u.row.payout > 0
      return true
    },
    [display],
  )
```

Change `useGridNavigation`'s `rowCount` to `display.length + 1`, and `autoFit`'s loop to `for (const u of display) widest = Math.max(widest, textWidth(displayFor(u, col.key), font))`.

Give `cellProps` the explicit return type:

```ts
  const cellProps = (rowIdx: number, colIdx: number): CellNavProps => ({
```

Replace the `<tbody>` body:

```tsx
        <tbody>
          {display.map((unit, rowIdx) =>
            unit.kind === 'group' ? (
              <GroupSummaryRow
                key={unit.uid}
                unit={unit}
                rowIdx={rowIdx}
                cellProps={cellProps}
                lockSelected={nav.sel.row === rowIdx && nav.sel.col === 0}
                onExpand={() => onExpand(unit.group.id)}
                onToggleLock={() => toggleLock(rowIdx)}
                onSelectLock={() => nav.select({ row: rowIdx, col: 0 })}
                onKeyDown={nav.handleKeyDown}
              />
            ) : (
              <tr
                key={unit.uid}
                className={`grid-row ${unit.row.locked ? 'locked' : ''}`}
                style={{ background: rowTint(grouping.byUid.get(unit.row.uid)?.color, unit.row.locked) }}
              >
                {/* the nine existing <td> blocks, unchanged */}
              </tr>
            ),
          )}
        </tbody>
```

Move the nine existing `<td>` blocks — `col-lock`, `col-group`, `col-id`, `col-weightId`, `col-payout`, `col-label`, `col-weight`, `col-weightedValue`, `col-chance` — into that `<tr>` unchanged except for one mechanical rename: every `row.` becomes `unit.row.` (`row.uid`, `row.bucketId`, `row.weightId`, `row.payout`, `row.label`, `row.weight`, `row.locked`). Do not touch the `cellProps(rowIdx, N)` column indices, the `validate` predicates, the `title` strings, or the `weightForValue` / `weightForChance` handlers.

Change the bucket lock cell to the tri-state prop:

```tsx
                <LockCell
                  state={unit.row.locked ? 'all' : 'none'}
                  selected={nav.sel.row === rowIdx && nav.sel.col === 0}
                  onToggle={() => toggleLock(rowIdx)}
                  onSelect={() => nav.select({ row: rowIdx, col: 0 })}
                  onKeyDown={nav.handleKeyDown}
                />
```

Keep the existing comment above the bucket row's `style` prop — it still explains why only the background changes.

- [ ] **Step 6: Add the styles**

In `src/index.css`, after the `.gcell.lock` rule:

```css
.gcell.lock.partial {
  opacity: 0.55;
}

.grid-row.group-summary .gcell {
  font-weight: 600;
}

.group-expander {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 6px;
  border: 0;
  background: none;
  font: inherit;
  font-weight: 600;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.group-expander:hover {
  text-decoration: underline;
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run test:run`
Expected: PASS. Vitest does not type-check, so `App.test.tsx` still runs — `<BucketTable>` is simply missing three props there until Task 11 supplies them. `npm run build` (which runs `tsc -b`) **will** fail on those three until then, which is why this task's commit step runs only `npm run lint`. Do **not** give the props defaults to paper over it.

- [ ] **Step 8: Lint and commit**

```bash
npm run lint
git add src/components/cells.tsx src/components/GroupSummaryRow.tsx src/components/BucketTable.tsx src/components/BucketTable.test.tsx src/index.css
git commit -m "feat: render a collapsed bucket group as one summary row"
```

---

### Task 11: Wire collapse into the app and persist it

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/lib/storage.ts`
- Test: `src/App.test.tsx`, `src/lib/storage.test.ts`

**Interfaces:**
- Consumes: `GroupChips` (Task 9), `BucketTable`'s `collapsed` / `onExpand` / `onGroupLock` props (Task 10).
- Produces: `Workspace` gains `tableCollapsed?: string[]`.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/storage.test.ts`, inside the existing `describe('storage', ...)`. The file already has a module-level `const workspace: Workspace` fixture and a `store` Map standing in for `localStorage`; use both rather than adding new ones.

```ts
  it('round-trips the collapsed table groups', () => {
    saveWorkspace({ ...workspace, tableCollapsed: ['bonus', 'wins'] })
    expect(loadWorkspace()?.tableCollapsed).toEqual(['bonus', 'wins'])
  })

  it('loads a workspace saved before table collapse existed', () => {
    saveWorkspace(workspace)
    expect(loadWorkspace()?.tableCollapsed).toBeUndefined()
  })

  it('rejects a tableCollapsed that is not a list of ids', () => {
    store.set(STORAGE_KEY, JSON.stringify({ ...workspace, tableCollapsed: [1, 2] }))
    expect(loadWorkspace()).toBeNull()
  })
```

Add to `src/App.test.tsx`, in the buckets-table suite:

```ts
  it('collapses a group into one row and expands it again', () => {
    loadRealData()
    const before = document.querySelectorAll('.grid-row').length
    const chip = within(document.querySelector('.panel.buckets')!).getByRole('button', {
      name: /bonus/,
    })
    fireEvent.click(chip)

    expect(document.querySelectorAll('.group-summary')).toHaveLength(1)
    expect(document.querySelectorAll('.grid-row').length).toBeLessThan(before)

    fireEvent.click(screen.getByRole('button', { name: /Show bonus/ }))
    expect(document.querySelectorAll('.grid-row')).toHaveLength(before)
  })

  it('keeps the chart's group bars independent of the table's collapse', () => {
    loadRealData()
    fireEvent.click(
      within(document.querySelector('.panel.buckets')!).getByRole('button', { name: /bonus/ }),
    )
    const chartChips = within(document.querySelector('.panel.chart')!).getAllByRole('button', {
      pressed: true,
    })
    expect(chartChips).toHaveLength(0)
  })

  it('exports the same rows whether a group is collapsed or not', async () => {
    // `copyTsv` reaches for navigator.clipboard.writeText first, and jsdom
    // provides no clipboard at all — so this stub is what makes the payload
    // observable, not a convenience.
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

    loadRealData()
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    const before = writeText.mock.calls[0][0]

    fireEvent.click(
      within(document.querySelector('.panel.buckets')!).getByRole('button', { name: /bonus/ }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))
    expect(writeText.mock.calls[1][0]).toBe(before)
  })
```

If the Copy button's accessible name is not exactly `Copy`, read it off the rendered markup and use what is actually there — `git grep -n "Copy" src/App.tsx`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/App.test.tsx src/lib/storage.test.ts`
Expected: FAIL — `BucketTable` is missing its three required props (a type error), there is no chip row in the buckets panel, and `tableCollapsed` is not persisted.

- [ ] **Step 3: Persist the field**

In `src/lib/storage.ts`, add to `Workspace` after `chartHeightAuto`:

```ts
  /** Optional — absent in workspaces saved before the table could collapse. */
  tableCollapsed?: string[]
```

and to `isWorkspace`, beside the `simChartYZoom` clause:

```ts
    (v.tableCollapsed === undefined ||
      (Array.isArray(v.tableCollapsed) && v.tableCollapsed.every((s) => typeof s === 'string'))) &&
```

- [ ] **Step 4: Wire the app**

In `src/App.tsx`:

Add the import: `import { GroupChips } from './components/GroupChips'`.

Add the state beside `chart`, with the same comment style as the other view state:

```ts
  /** Groups drawn as one aggregate row in the table. View state, like groupBars. */
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>(saved?.tableCollapsed ?? [])
```

Add `tableCollapsed: collapsedGroups` to the `saveWorkspace` payload and `collapsedGroups` to that effect's dependency array.

In `loadData`, beside the existing `setChart((c) => ({ ...c, groupBars: [] }))`:

```ts
      setCollapsedGroups([])
```

In `deleteGroup`, beside the existing `groupBars` cleanup:

```ts
      setCollapsedGroups((ids) => ids.filter((g) => g !== id))
```

In the Buckets panel, add the chip row between `.panel-head` and `<BucketTable>`:

```tsx
            <GroupChips
              groups={grouping.groups}
              selected={collapsedGroups}
              onSelected={setCollapsedGroups}
              label="Collapse"
              titleOn={(n) => `Show ${n}'s buckets`}
              titleOff={(n) => `Collapse ${n} into one row`}
            />
```

and pass the three new props to `BucketTable`:

```tsx
              collapsed={collapsedGroups}
              onExpand={(id) => setCollapsedGroups(collapsedGroups.filter((g) => g !== id))}
              onGroupLock={setGroupLocked}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test:run`
Expected: PASS, the whole suite.

- [ ] **Step 6: Lint, build and commit**

```bash
npm run lint
npm run build
git add src/App.tsx src/App.test.tsx src/lib/storage.ts src/lib/storage.test.ts
git commit -m "feat: collapse bucket groups in the table, and remember which"
```

---

### Task 12: Document table collapse

**Files:**
- Modify: `README.md` (`## Contents`, `### Bucket groups`, `## Project layout`)

**Interfaces:**
- Consumes: Tasks 8–11. No code changes.
- Produces: nothing.

- [ ] **Step 1: Add the section**

In `README.md`, add a new `#### Collapsing a group` subsection at the end of `### Bucket groups`:

```markdown
#### Collapsing a group

The `Collapse` chips above the table fold any group into a single row. The row
shows the group's total weight, total weighted value and total chance — so the
columns still add up to the totals row and to 1 — against its weight-weighted
mean payout, which is the same figure the distribution chart uses to place a
collapsed group bar. `▸` on the row expands it again.

A collapsed group sorts as one unit, ranked by whichever aggregate the active
column shows, so it works under every sort rather than only under Group sort.
Its lock cell reports the group's state — locked, partly locked, or unlocked —
and sets every member at once.

This is a view, not an edit: collapsing changes nothing about the data, and the
export always writes one line per bucket. The table's chips and the chart's
`Group bars` chips are independent — collapsing a group in one leaves the other
alone.
```

Add the matching entry to `## Contents`, under `Bucket groups`, mirroring how `Group locks` and `Group bars` are already nested:

```markdown
    - [Collapsing a group](#collapsing-a-group)
```

- [ ] **Step 2: Add the new files to the project layout**

In `## Project layout`, add entries for `src/lib/tableRows.ts`, `src/components/GroupSummaryRow.tsx` and `src/components/GroupChips.tsx`, and rename the existing `GroupBarChips.tsx` entry. Match the one-line description style already used there.

- [ ] **Step 3: Check the anchors**

Run: `git grep -n "^- \[\|^  - \[\|^    - \[" README.md | head -50`
Expected: every Contents entry has a matching heading. Confirm `#collapsing-a-group` matches the new `#### Collapsing a group` heading, and that the `GroupBarChips` name appears nowhere in the file.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document collapsing a bucket group in the table"
```

---

## Self-review notes

Checked against the spec:

- Floor → Tasks 2 and 3 (solver, `rescaleToTotal`, the App notice). `retargetRtp` gets no floor guarantee, with the reason recorded in Task 3 — but it *does* get ordering in Task 6, applied per band so its group-sum promise survives.
- Ordering mechanism A (per-band slope floor) → Task 4; B (boundary jump) and C (residual dominance) → Task 5; D (integer stage) → Task 6; the locked-row note → Task 6.
- Residual detection and the 80/20 zero split, plus the `currentMasses` count fallback → Task 1.
- Ranking documentation → Task 7.
- Display-row model → Task 8; chip extraction → Task 9; rendering → Task 10; state, persistence and app wiring → Task 11; docs → Task 12.

Names used consistently across tasks: `residualIndex`, `minTotalWeight`, `floorBlockWarning`, `bandFloor`, `ladderIdx`, `inOrder`, `enforceOrder`, `lockedOrderNote`, `dominanceGap`, `levelBoundary`, `raiseResidual`, `buildTableRows`, `TableRow`, `GroupAggregate`, `CellNavProps`, `GroupChips`, `GroupSummaryRow`, `tableCollapsed`, `collapsedGroups`.

Existing tests flagged as at risk, each with an instruction not to weaken them:
`monotonically thins the big-payout tail as volatility falls` (Task 4),
`refuses to retarget when the current weights sit off the step` (Task 6),
`lets the curve span the whole ladder once the groups are unpinned` (Task 1).
