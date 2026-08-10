# Exact Chart Entry, Relative Drags, Group Locks and Group Bars — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the distribution chart precise (type an exact value, drag by movement not position) and let bucket groups act as single objects (lock a whole group, collapse a whole group into one bar), then separate import from export in the top bar.

**Architecture:** Bar construction moves out of `DistributionChart.tsx` into a pure, unit-tested `src/lib/bars.ts` that also handles group collapse and mean-payout placement. Dragging keeps its frozen-at-pointer-down scale but reads a pixel delta instead of an absolute position. A whole-group lock is derived from row locks — no new data model. A new `ChartValueEntry` popover and a new `GroupBarChips` strip are separate small components so `DistributionChart.tsx` does not grow.

**Tech Stack:** React 19 + TypeScript, Vite 8, Vitest + @testing-library/react (jsdom), plain CSS in `src/index.css`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-07-chart-interaction-and-groups-design.md`.
- **The play/balance simulation is out of scope.** It gets its own spec after this lands. Do not touch `sim.ts`, `sim.worker.ts`, `SimulationPanel.tsx` or `SimChart.tsx`.
- Every weight the tool computes must land on a multiple of the current `WeightStep`. All new value-setting paths go through `scaleSubset` / `setSubsetTotal` in `src/lib/interact.ts`, which already enforce this — never write weights directly.
- Locked rows never move. This is enforced inside `interact.ts`; do not add a second check.
- Every document mutation goes through `App`'s `commit()` so undo cannot miss one. Chart drags and popover commits fire `onCommit` exactly once, on release/Enter.
- Chart *view* state (`ChartSettings`) is persisted but **not** undoable. Group membership and locks are document state and **are** undoable.
- Existing behaviour must not regress: `npm run test:run` passes at the end of every task.
- No new dependencies.
- Comments explain *why*, not *what* — match the density and voice of the surrounding files.

---

### Task 1: `src/lib/bars.ts` — pure bar construction

Extracts the `allBars` `useMemo` from `DistributionChart.tsx:169-217` into a pure module, and teaches it to collapse groups. Nothing is wired up yet; this task delivers a tested module only.

**Files:**
- Create: `src/lib/bars.ts`
- Test: `src/lib/bars.test.ts`

**Interfaces:**
- Consumes: `BucketRow` from `src/lib/types.ts`; `Grouping`, `GroupInfo` from `src/lib/groups.ts`.
- Produces: `Segment`, `BucketBar`, `GroupBar`, `ChartBar`, `BuildBarsOptions`, `BuiltBars`, and `buildBars(rows, grouping, totalWeight, opts): BuiltBars`. Tasks 2, 3, 4 and 5 all consume these.

- [ ] **Step 1: Write the failing test**

Create `src/lib/bars.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildBars } from './bars'
import { groupRows } from './groups'
import type { BucketRow } from './types'

/**
 * Four buckets in three detected groups: '0-1x' is a pure range → wins,
 * 'bonus3'/'bonus4' → bonus, '0x' pays nothing → the 0x group.
 */
const rows = (): BucketRow[] => [
  { uid: 'a', bucketId: 0, payout: 0, label: '0x', weight: 500_000, locked: false, groupId: 'zero', weightId: '' },
  { uid: 'b', bucketId: 1, payout: 0.6, label: '0-1x', weight: 300_000, locked: false, groupId: 'wins', weightId: '' },
  { uid: 'c', bucketId: 2, payout: 8, label: 'bonus3', weight: 150_000, locked: false, groupId: 'bonus', weightId: '' },
  { uid: 'd', bucketId: 3, payout: 100, label: 'bonus4', weight: 50_000, locked: false, groupId: 'bonus', weightId: '' },
]

const TOTAL = 1_000_000

const build = (rs: BucketRow[], opts: Partial<Parameters<typeof buildBars>[3]> = {}) =>
  buildBars(rs, groupRows(rs), rs.reduce((a, r) => a + r.weight, 0), {
    aggregate: false,
    groupBars: [],
    logX: false,
    ...opts,
  })

describe('buildBars — bucket bars', () => {
  it('makes one bar per bucket, ascending by payout', () => {
    const { bars, droppedZero } = build(rows())
    expect(bars.map((b) => b.payout)).toEqual([0, 0.6, 8, 100])
    expect(bars.every((b) => b.kind === 'buckets')).toBe(true)
    expect(droppedZero).toBe(0)
  })

  it('reports each bar’s weight and its chance of the grand total', () => {
    const { bars } = build(rows())
    expect(bars.map((b) => b.weight)).toEqual([500_000, 300_000, 150_000, 50_000])
    expect(bars[3].chance).toBeCloseTo(0.05, 12)
  })

  it('merges equal payouts into one bar when aggregating', () => {
    const rs = rows()
    rs.push({ uid: 'e', bucketId: 4, payout: 8, label: 'bonus7', weight: 100_000, locked: false, groupId: 'bonus', weightId: '' })
    const { bars } = build(rs, { aggregate: true })
    const at8 = bars.find((b) => b.payout === 8)!
    expect(at8.uids).toEqual(['c', 'e'])
    expect(at8.weight).toBe(250_000)
  })

  it('splits an aggregated bar into one segment per group, in rank order', () => {
    const rs: BucketRow[] = [
      { uid: 'x', bucketId: 0, payout: 5, label: 'hp-fullscreen', weight: 100, locked: false, groupId: 'other', weightId: '' },
      { uid: 'y', bucketId: 1, payout: 5, label: 'bonus9', weight: 300, locked: false, groupId: 'bonus', weightId: '' },
    ]
    const { bars } = build(rs, { aggregate: true })
    expect(bars).toHaveLength(1)
    expect(bars[0].segments.map((s) => s.weight)).toEqual([300, 100])
  })

  it('marks a bar locked only when every bucket in it is locked', () => {
    const rs = rows().map((r) => (r.uid === 'a' ? { ...r, locked: true } : r))
    const { bars } = build(rs)
    expect(bars[0].allLocked).toBe(true)
    expect(bars[1].allLocked).toBe(false)
  })

  it('drops zero-payout bars under a log payout axis and counts them', () => {
    const { bars, droppedZero } = build(rows(), { logX: true })
    expect(bars.map((b) => b.payout)).toEqual([0.6, 8, 100])
    expect(droppedZero).toBe(1)
  })
})

describe('buildBars — collapsed groups', () => {
  it('replaces a group’s buckets with a single bar', () => {
    const { bars } = build(rows(), { groupBars: ['bonus'] })
    expect(bars).toHaveLength(3)
    const bonus = bars.find((b) => b.kind === 'group')!
    expect(bonus.name).toBe('bonus')
    expect(bonus.uids).toEqual(['c', 'd'])
    expect(bonus.weight).toBe(200_000)
    // one solid group-colored segment, never a stack
    expect(bonus.segments).toHaveLength(1)
  })

  it('places a group bar at its weight-weighted mean payout', () => {
    const { bars } = build(rows(), { groupBars: ['bonus'] })
    const bonus = bars.find((b) => b.kind === 'group')!
    // (8 × 150,000 + 100 × 50,000) / 200,000 = 31
    expect(bonus.payout).toBeCloseTo(31, 9)
    expect(bonus.payoutRange).toEqual([8, 100])
  })

  it('falls back to the plain mean payout when the group has no weight', () => {
    const rs = rows().map((r) => (r.groupId === 'bonus' ? { ...r, weight: 0 } : r))
    const { bars } = build(rs, { groupBars: ['bonus'] })
    const bonus = bars.find((b) => b.kind === 'group')!
    expect(bonus.payout).toBeCloseTo(54, 9) // (8 + 100) / 2
  })

  it('sorts a group bar among the loose bars by its placement', () => {
    const { bars } = build(rows(), { groupBars: ['bonus'] })
    expect(bars.map((b) => b.payout)).toEqual([0, 0.6, 31])
  })

  it('leaves other groups untouched and still aggregates them by payout', () => {
    const rs = rows()
    rs.push({ uid: 'e', bucketId: 4, payout: 0.6, label: '0-1x', weight: 100_000, locked: false, groupId: 'wins', weightId: '' })
    const { bars } = build(rs, { aggregate: true, groupBars: ['bonus'] })
    expect(bars.filter((b) => b.kind === 'group')).toHaveLength(1)
    const wins = bars.find((b) => b.payout === 0.6)!
    expect(wins.kind).toBe('buckets')
    expect(wins.weight).toBe(400_000)
  })

  it('drops an all-zero collapsed group under a log axis', () => {
    const { bars, droppedZero } = build(rows(), { groupBars: ['zero'], logX: true })
    expect(bars.every((b) => b.payout > 0)).toBe(true)
    expect(droppedZero).toBe(1)
  })

  it('marks a collapsed group locked only when every member is locked', () => {
    const all = rows().map((r) => (r.groupId === 'bonus' ? { ...r, locked: true } : r))
    expect(build(all, { groupBars: ['bonus'] }).bars.find((b) => b.kind === 'group')!.allLocked).toBe(true)
    const some = rows().map((r) => (r.uid === 'c' ? { ...r, locked: true } : r))
    expect(build(some, { groupBars: ['bonus'] }).bars.find((b) => b.kind === 'group')!.allLocked).toBe(false)
  })

  it('ignores a group id that no longer exists', () => {
    const { bars } = build(rows(), { groupBars: ['gone'] })
    expect(bars).toHaveLength(4)
    expect(bars.every((b) => b.kind === 'buckets')).toBe(true)
  })

  it('reports chances against the grand total, not the group', () => {
    const { bars } = build(rows(), { groupBars: ['bonus'] })
    const bonus = bars.find((b) => b.kind === 'group')!
    expect(bonus.chance).toBeCloseTo(200_000 / TOTAL, 12)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/bars.test.ts`
Expected: FAIL — `Failed to resolve import "./bars"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/bars.ts`:

```ts
import type { BucketRow } from './types'
import type { GroupInfo, Grouping } from './groups'

/**
 * What the distribution chart draws, worked out away from the chart itself.
 *
 * Two independent aggregations land here, and the order between them is the
 * whole design:
 *
 *  1. A group the user has collapsed becomes exactly one bar, whatever payouts
 *     its buckets span.
 *  2. Whatever is left over aggregates by equal payout, as it always has.
 *
 * Collapsing first is what makes the two composable: a collapsed group is gone
 * before the payout pass runs, so a bucket can never appear both inside a group
 * bar and inside an equal-payout bar.
 */

export interface Segment {
  color: string
  weight: number
  chance: number
}

interface BarBase {
  /** Where the bar sits on the payout axis. */
  payout: number
  weight: number
  /** Share of the grand total — never of the bar's own group. */
  chance: number
  labels: string[]
  uids: string[]
  /** One per group present in the bar, in group rank order — stacked bottom-up. */
  segments: Segment[]
  allLocked: boolean
}

export interface BucketBar extends BarBase {
  kind: 'buckets'
}

export interface GroupBar extends BarBase {
  kind: 'group'
  groupId: string
  name: string
  /** Lowest and highest member payout, for the readout. */
  payoutRange: [number, number]
}

export type ChartBar = BucketBar | GroupBar

export interface BuildBarsOptions {
  /** Merge loose buckets that share a payout into one bar. */
  aggregate: boolean
  /** Group ids drawn as a single bar instead of their buckets. */
  groupBars: string[]
  /** A log payout axis has nowhere to put a zero-payout bar. */
  logX: boolean
}

export interface BuiltBars {
  bars: ChartBar[]
  /** Bars a log axis had to omit, for the axis title's note. */
  droppedZero: number
}

export function buildBars(
  rows: BucketRow[],
  grouping: Grouping,
  totalWeight: number,
  opts: BuildBarsOptions,
): BuiltBars {
  const chanceOf = (w: number) => (totalWeight > 0 ? w / totalWeight : 0)
  const rankOf = (uid: string) => grouping.rank.get(uid) ?? Number.MAX_SAFE_INTEGER
  const colorOf = (uid: string) => grouping.byUid.get(uid)?.color ?? 'var(--bar)'

  const collapsed = new Set(opts.groupBars)

  const bucketBar = (members: BucketRow[]): BucketBar => {
    const byRank = new Map<number, Segment>()
    for (const r of [...members].sort((a, b) => rankOf(a.uid) - rankOf(b.uid))) {
      const seg = byRank.get(rankOf(r.uid))
      if (seg) {
        seg.weight += r.weight
        seg.chance += chanceOf(r.weight)
      } else {
        byRank.set(rankOf(r.uid), {
          color: colorOf(r.uid),
          weight: r.weight,
          chance: chanceOf(r.weight),
        })
      }
    }
    const weight = members.reduce((a, r) => a + r.weight, 0)
    return {
      kind: 'buckets',
      payout: members[0].payout,
      weight,
      chance: chanceOf(weight),
      labels: members.map((r) => r.label),
      uids: members.map((r) => r.uid),
      segments: [...byRank.values()],
      allLocked: members.every((r) => r.locked),
    }
  }

  const groupBar = (g: GroupInfo, members: BucketRow[]): GroupBar => {
    const weight = members.reduce((a, r) => a + r.weight, 0)
    // The bar goes where the group's mass is, so its position against the
    // loose bars still means something. With no weight there is nothing to
    // weight by, and the plain mean is the only honest answer left.
    const payout =
      weight > 0
        ? members.reduce((a, r) => a + r.payout * r.weight, 0) / weight
        : members.reduce((a, r) => a + r.payout, 0) / members.length
    const payouts = members.map((r) => r.payout)
    return {
      kind: 'group',
      groupId: g.id,
      name: g.name,
      payout,
      payoutRange: [Math.min(...payouts), Math.max(...payouts)],
      weight,
      chance: chanceOf(weight),
      labels: members.map((r) => r.label),
      uids: members.map((r) => r.uid),
      // One group, so one solid segment — never a stack.
      segments: [{ color: g.color, weight, chance: chanceOf(weight) }],
      allLocked: members.every((r) => r.locked),
    }
  }

  const byUid = new Map(rows.map((r) => [r.uid, r]))
  const bars: ChartBar[] = []

  for (const g of grouping.groups) {
    if (!collapsed.has(g.id)) continue
    const members = g.uids
      .map((uid) => byUid.get(uid))
      .filter((r): r is BucketRow => r !== undefined)
    if (members.length > 0) bars.push(groupBar(g, members))
  }

  const loose = rows.filter((r) => {
    const id = grouping.byUid.get(r.uid)?.id
    return id === undefined || !collapsed.has(id)
  })

  if (opts.aggregate) {
    const byPayout = new Map<number, BucketRow[]>()
    for (const r of loose) {
      const list = byPayout.get(r.payout)
      if (list === undefined) byPayout.set(r.payout, [r])
      else list.push(r)
    }
    for (const members of byPayout.values()) bars.push(bucketBar(members))
  } else {
    const ordered = [...loose].sort((a, b) => a.payout - b.payout || a.bucketId - b.bucketId)
    for (const r of ordered) bars.push(bucketBar([r]))
  }

  // Stable, so the bucketId tiebreak above survives and a group bar tying with
  // a loose bar keeps the order they were pushed in.
  bars.sort((a, b) => a.payout - b.payout)

  if (!opts.logX) return { bars, droppedZero: 0 }
  const kept = bars.filter((b) => b.payout > 0)
  return { bars: kept, droppedZero: bars.length - kept.length }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/bars.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Run lint and the full suite**

Run: `npm run lint && npm run test:run`
Expected: clean; nothing else imports `bars.ts` yet so nothing else changes.

- [ ] **Step 6: Commit**

```bash
git add src/lib/bars.ts src/lib/bars.test.ts
git commit -m "feat: pure bar construction with collapsible groups"
```

---

### Task 2: Wire the chart to `buildBars`, add `groupBars` to chart settings

Swaps `DistributionChart`'s inline bar building for `buildBars`, adds the `groupBars` setting so it can be passed in, and renders group bars (name on the axis, range in the readout). The chip row that *sets* `groupBars` comes in Task 5 — here it arrives through props, which is what the tests drive.

**Files:**
- Modify: `src/lib/types.ts` — `ChartSettings`, `DEFAULT_CHART`
- Modify: `src/lib/storage.ts:70-78` — `isChart`
- Modify: `src/components/DistributionChart.tsx` — remove the `Bar`/`Segment` interfaces and the `allBars` memo, render from `ChartBar`
- Modify: `src/App.tsx` — reset `groupBars` on import
- Test: `src/components/DistributionChart.test.tsx` (append), `src/lib/storage.test.ts` (append)

**Interfaces:**
- Consumes: `buildBars`, `ChartBar`, `Segment` from Task 1.
- Produces: `ChartSettings.groupBars: string[]`, default `[]`. Task 5 renders the control that writes it.

- [ ] **Step 1: Write the failing tests**

Append to `src/components/DistributionChart.test.tsx`:

```ts
describe('DistributionChart group bars', () => {
  it('draws one bar for a collapsed group and none for its buckets', () => {
    renderChart({ metric: 'weights', groupBars: ['bonus'] })
    // 0x, 0-1x and the collapsed bonus group
    expect(document.querySelectorAll('.bar')).toHaveLength(3)
  })

  it('labels a group bar with the group name instead of a payout', () => {
    renderChart({ metric: 'weights', groupBars: ['bonus'] })
    const labels = [...document.querySelectorAll('.axis-label')].map((el) => el.textContent)
    expect(labels).toContain('bonus')
  })

  it('reports the payout range and the mean in the readout', () => {
    renderChart({ metric: 'weights', groupBars: ['bonus'] })
    // bars ascend: 0x, 0-1x, then bonus at its weighted mean of ×31
    fireEvent.mouseOver(document.querySelectorAll('.bar-hit')[2])
    const stats = readoutStats()
    expect(stats.payout).toBe('×8 – ×100')
    expect(stats.avg).toBe('×31')
    expect(stats.weight).toBe('200,000')
    // Σ(payout × weight) / total = (8×150,000 + 100×50,000) / 1,000,000
    expect(stats.weighted).toBe('6.2000')
  })

  it('names every bucket of a collapsed group in the readout', () => {
    renderChart({ metric: 'weights', groupBars: ['bonus'] })
    fireEvent.mouseOver(document.querySelectorAll('.bar-hit')[2])
    const lines = [...document.querySelectorAll('.readout-title')].map((el) => el.textContent)
    expect(lines).toEqual(['bonus3', 'bonus4'])
  })

  it('rescales the whole group when its bar is dragged', () => {
    const { onPreview, onCommit } = renderChart({ metric: 'weights', groupBars: ['bonus'] })
    const hit = document.querySelectorAll('.bar-hit')[2]

    fireEvent.pointerDown(hit, { pointerId: 1, clientY: 250 })
    fireEvent.pointerMove(hit, { pointerId: 1, clientY: 150 })

    const preview = lastRows(onPreview)
    expect(sum(weightsOf(preview))).toBe(1_000_000)
    expect(preview[2].weight + preview[3].weight).not.toBe(200_000)
    // in-group proportions hold at ≈ 3:1
    expect(preview[2].weight / preview[3].weight).toBeGreaterThan(2.7)
    expect(preview[2].weight / preview[3].weight).toBeLessThan(3.3)

    fireEvent.pointerUp(hit, { pointerId: 1, clientY: 150 })
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('still draws the group handle for a collapsed group', () => {
    renderChart({ metric: 'weights', groupBars: ['bonus'] })
    expect(screen.getByRole('slider', { name: 'bonus group' })).toBeDefined()
  })
})
```

Append to `src/lib/storage.test.ts`, inside the existing `describe('storage', …)`. It already has a module-level `workspace` fixture and a `store` Map standing in for `localStorage`:

```ts
  it('rejects a workspace whose groupBars is not a list of strings', () => {
    store.set(
      STORAGE_KEY,
      JSON.stringify({ ...workspace, chart: { ...DEFAULT_CHART, groupBars: 'bonus' } }),
    )
    expect(loadWorkspace()).toBeNull()
  })

  it('accepts a workspace saved before groupBars existed', () => {
    const chart: Record<string, unknown> = { ...DEFAULT_CHART }
    delete chart.groupBars
    store.set(STORAGE_KEY, JSON.stringify({ ...workspace, chart }))
    expect(loadWorkspace()).not.toBeNull()
  })
```

The file's existing `round-trips a workspace` test uses `DEFAULT_CHART` directly, so it keeps passing once `groupBars: []` is part of it.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/DistributionChart.test.tsx src/lib/storage.test.ts`
Expected: FAIL — `groupBars` is not a known property of `ChartSettings`, and no group bars render.

- [ ] **Step 3: Add the setting**

In `src/lib/types.ts`, inside `ChartSettings` after `relative`:

```ts
  /**
   * Group ids drawn as a single aggregated bar instead of their buckets.
   * View state, so it is persisted but not undoable. Never mutated in place —
   * DEFAULT_CHART's empty array is shared by every fresh workspace.
   */
  groupBars: string[]
```

and in `DEFAULT_CHART`:

```ts
  groupBars: [],
```

In `src/lib/storage.ts`, extend `isChart`'s return expression with a final clause:

```ts
    typeof v.aggregate === 'boolean' &&
    // Optional: absent in workspaces saved before groups could be collapsed.
    (v.groupBars === undefined ||
      (Array.isArray(v.groupBars) && v.groupBars.every((s) => typeof s === 'string')))
```

- [ ] **Step 4: Rewire the chart**

In `src/components/DistributionChart.tsx`:

1. Delete the local `Segment` and `Bar` interfaces (lines 44-59) and import from the new module instead:

```ts
import { buildBars, type ChartBar, type Segment } from '../lib/bars'
```

2. Replace the `allBars` memo, the `bars` memo and the `droppedZero` line (lines 169-217) with:

```ts
  const { bars, droppedZero } = useMemo(
    () => buildBars(rows, grouping, totalWeight, { aggregate, groupBars, logX }),
    [rows, grouping, totalWeight, aggregate, groupBars, logX],
  )
```

3. Destructure `groupBars` alongside the other settings:

```ts
  const { metric, logY, logX, aggregate, relative, groupBars } = chart
```

4. Change `valueOf`'s parameter type from `Bar` to `ChartBar`.

5. Give group bars their name on the payout axis. Replace the axis-label map (lines 514-526) with:

```ts
              {bars.map((b, i) =>
                // Group bars are the coarse landmarks of the view and there are
                // few of them, so they are never thinned out.
                b.kind === 'group' || i % labelEvery === 0 ? (
                  <text
                    key={i}
                    className="axis-label"
                    x={centres[i]}
                    y={height - MARGIN.bottom + 18}
                    textAnchor="middle"
                  >
                    {b.kind === 'group' ? b.name : `×${fmtPayout(b.payout)}`}
                  </text>
                ) : null,
              )}
```

6. Give group bars a range and a mean in the readout. Replace `readoutStats` (lines 375-384) with:

```ts
  const readoutStats: ReadoutStat[] =
    hovered === null
      ? []
      : [
          hovered.kind === 'group'
            ? {
                label: 'payout',
                value: `×${fmtPayout(hovered.payoutRange[0])} – ×${fmtPayout(hovered.payoutRange[1])}`,
              }
            : { label: 'payout', value: `×${fmtPayout(hovered.payout)}` },
          ...(hovered.kind === 'group'
            ? [{ label: 'avg', value: `×${fmtPayout(Math.round(hovered.payout * 100) / 100)}` }]
            : []),
          { label: 'weight', value: fmtWeight(hovered.weight) },
          { label: 'chance', value: fmtPct(hovered.chance, 4) },
          // payout × chance is Σ(payout × weight) / total either way: a group
          // bar's payout is already weight-weighted, so the product still lands
          // on the group's true slice of RTP.
          { label: 'weighted', value: fmtRtp(hovered.payout * hovered.chance) },
        ]
```

- [ ] **Step 5: Reset collapsed groups on import**

In `src/App.tsx`, inside `loadData`, right after `commit((d) => ({ ...d, rows: seeded.rows, groups: seeded.groups }))`:

```ts
      // New data means new groups; a collapsed id from the old table would
      // either dangle or, worse, collapse an unrelated group of the same name.
      setChart((c) => ({ ...c, groupBars: [] }))
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/components/DistributionChart.test.tsx src/lib/storage.test.ts`
Expected: PASS. The pre-existing chart tests must pass unchanged — with `groupBars: []` the output is identical to before.

- [ ] **Step 7: Run lint, typecheck and the full suite**

Run: `npm run lint && npm run build && npm run test:run`
Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add src/lib/types.ts src/lib/storage.ts src/lib/storage.test.ts src/components/DistributionChart.tsx src/components/DistributionChart.test.tsx src/App.tsx
git commit -m "feat: chart draws collapsed groups as single bars"
```

---

### Task 3: Drags move by delta, not to the cursor

**Files:**
- Modify: `src/components/DistributionChart.tsx` — `DragState`, `beginDrag`, `moveDrag`; delete `fracFromPointer`
- Test: `src/components/DistributionChart.test.tsx` (append)

**Interfaces:**
- Consumes: `ChartBar` from Task 1, the `valueOf` helper already in the component.
- Produces: `beginDrag(e, uids, disabled, currentValue)` — the fourth parameter is new and every call site must pass it.

- [ ] **Step 1: Write the failing tests**

Append to `src/components/DistributionChart.test.tsx`:

```ts
describe('DistributionChart delta dragging', () => {
  it('does not move a bar when the pointer is pressed and not moved', () => {
    // The regression this feature exists for: the old drag jumped the bar to
    // wherever the pointer happened to land, destroying its value on contact.
    const { onPreview } = renderChart({ metric: 'weights', relative: true })
    const hit = document.querySelectorAll('.bar-hit')[1]

    fireEvent.pointerDown(hit, { pointerId: 1, clientY: 250 })
    fireEvent.pointerMove(hit, { pointerId: 1, clientY: 250 })

    expect(weightsOf(lastRows(onPreview))).toEqual([500_000, 300_000, 150_000, 50_000])
  })

  it('gives the same result for the same delta from different grab points', () => {
    const low = renderChart({ metric: 'weights', relative: true })
    const lowHit = document.querySelectorAll('.bar-hit')[1]
    fireEvent.pointerDown(lowHit, { pointerId: 1, clientY: 300 })
    fireEvent.pointerMove(lowHit, { pointerId: 1, clientY: 260 })
    const fromLow = weightsOf(lastRows(low.onPreview))
    cleanup()

    const high = renderChart({ metric: 'weights', relative: true })
    const highHit = document.querySelectorAll('.bar-hit')[1]
    fireEvent.pointerDown(highHit, { pointerId: 1, clientY: 120 })
    fireEvent.pointerMove(highHit, { pointerId: 1, clientY: 80 })

    expect(weightsOf(lastRows(high.onPreview))).toEqual(fromLow)
  })

  it('raises the value when the pointer moves up and lowers it when it moves down', () => {
    const { onPreview } = renderChart({ metric: 'weights', relative: true })
    const hit = document.querySelectorAll('.bar-hit')[1]

    fireEvent.pointerDown(hit, { pointerId: 1, clientY: 200 })
    fireEvent.pointerMove(hit, { pointerId: 1, clientY: 160 })
    expect(lastRows(onPreview)[1].weight).toBeGreaterThan(300_000)

    fireEvent.pointerMove(hit, { pointerId: 1, clientY: 240 })
    expect(lastRows(onPreview)[1].weight).toBeLessThan(300_000)
  })

  it('starts a group handle drag from the group’s own value', () => {
    const { onPreview } = renderChart({ metric: 'weights', relative: true })
    const handle = screen.getByRole('slider', { name: 'bonus group' })

    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 200 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 200 })

    expect(weightsOf(lastRows(onPreview))).toEqual([500_000, 300_000, 150_000, 50_000])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/DistributionChart.test.tsx -t "delta dragging"`
Expected: FAIL — a zero-delta move currently rewrites the weights, because the value comes from the absolute pointer position.

- [ ] **Step 3: Implement the delta drag**

In `src/components/DistributionChart.tsx`:

1. Add two fields to `DragState` (lines 67-75), after `scale`:

```ts
  /** Pointer y at press, and the subset's own position on the frozen axis. */
  startY: number
  startFrac: number
```

2. Delete `fracFromPointer` (lines 289-293) entirely — the drag no longer needs to know where the SVG sits on screen.

3. Replace `beginDrag` and the value line of `moveDrag`:

```ts
  /**
   * `currentValue` is the subset's value in the chart's current metric. It is
   * what makes the drag relative: the value moves by the pointer's delta from
   * where it started, so pressing on a bar never changes it and a bar can be
   * grabbed anywhere along its length.
   */
  const beginDrag = (
    e: React.PointerEvent,
    uids: string[],
    disabled: boolean,
    currentValue: number,
  ) => {
    if (disabled || e.button !== 0) return
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    dragRef.current = {
      baseRows: rows,
      baseTotal: rows.reduce((a, r) => a + Math.max(0, Math.round(r.weight)), 0),
      uids,
      scale: liveScale,
      startY: e.clientY,
      startFrac: liveScale.frac(currentValue),
      moved: false,
      lastRows: null,
      blockedNotified: false,
    }
    setDragScale(liveScale)
  }

  const moveDrag = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (d === null) return
    // Measured in axis fractions, so sensitivity keeps the meaning the chart is
    // already showing: a constant multiplier per pixel on a log axis, a
    // constant amount on a linear one.
    const f = clamp(d.startFrac + (d.startY - e.clientY) / plotH, 0, 1)
    const value = d.scale.invert(f)
```

The rest of `moveDrag` from `let weights: number[] | null` onward is unchanged.

4. Update the two call sites. The group handle (line 555):

```ts
                    onPointerDown={(e) => beginDrag(e, s.group.uids, s.allLocked, s.value)}
```

The bar hit rect (line 609):

```ts
                  onPointerDown={(e) => beginDrag(e, b.uids, b.allLocked, valueOf(b))}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components/DistributionChart.test.tsx`
Expected: PASS, including the pre-existing drag tests — they assert "sum preserved" and "value changed", both of which still hold under a delta drag.

- [ ] **Step 5: Run lint, typecheck and the full suite**

Run: `npm run lint && npm run build && npm run test:run`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/DistributionChart.tsx src/components/DistributionChart.test.tsx
git commit -m "feat: chart drags move by pointer delta instead of jumping to the cursor"
```

---

### Task 4: Right-click to type an exact value

**Files:**
- Create: `src/components/ChartValueEntry.tsx`
- Create: `src/components/ChartValueEntry.test.tsx`
- Modify: `src/components/DistributionChart.tsx` — open on `onContextMenu`, commit through `interact.ts`
- Modify: `src/index.css` — `.chart-entry` and its parts
- Test: `src/components/DistributionChart.test.tsx` (append)

**Interfaces:**
- Consumes: `evaluateExpression` from `src/lib/expr.ts` (`(text: string) => number | null`), `remapNumpadComma` from `src/components/numpadDecimal.ts` (`(e: React.KeyboardEvent) => boolean`), `scaleSubset` / `setSubsetTotal` from `src/lib/interact.ts`.
- Produces: `ChartValueEntry` and `ValueEntryTarget` — used only by `DistributionChart`.

- [ ] **Step 1: Write the failing tests**

Create `src/components/ChartValueEntry.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChartValueEntry } from './ChartValueEntry'

afterEach(cleanup)

const renderEntry = (over: Partial<React.ComponentProps<typeof ChartValueEntry>> = {}) => {
  const onCommit = vi.fn(() => true)
  const onClose = vi.fn()
  render(
    <ChartValueEntry
      target={{ title: 'bonus', uids: ['c', 'd'], current: 200_000, unit: 'weight' }}
      x={200}
      y={80}
      width={900}
      weightStep={1}
      onCommit={onCommit}
      onClose={onClose}
      {...over}
    />,
  )
  return { onCommit, onClose }
}

describe('ChartValueEntry', () => {
  it('names its target and pre-fills the current value', () => {
    renderEntry()
    expect(screen.getByText('bonus')).toBeDefined()
    expect((screen.getByLabelText('Weight') as HTMLInputElement).value).toBe('200000')
  })

  it('commits the typed value on Enter', () => {
    const { onCommit, onClose } = renderEntry()
    const input = screen.getByLabelText('Weight')
    fireEvent.change(input, { target: { value: '250000' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledWith(250_000)
    expect(onClose).toHaveBeenCalled()
  })

  it('commits from the Set button too', () => {
    const { onCommit } = renderEntry()
    fireEvent.change(screen.getByLabelText('Weight'), { target: { value: '1234' } })
    fireEvent.click(screen.getByRole('button', { name: 'Set' }))
    expect(onCommit).toHaveBeenCalledWith(1234)
  })

  it('evaluates arithmetic the way the grid cells do', () => {
    const { onCommit } = renderEntry()
    fireEvent.change(screen.getByLabelText('Weight'), { target: { value: '200000+50000' } })
    fireEvent.keyDown(screen.getByLabelText('Weight'), { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledWith(250_000)
  })

  it('reads and writes percentages in chance mode', () => {
    const { onCommit } = renderEntry({
      target: { title: 'bonus', uids: ['c'], current: 20, unit: '%' },
    })
    const input = screen.getByLabelText('Chance %')
    expect((input as HTMLInputElement).value).toBe('20')
    fireEvent.change(input, { target: { value: '12.5' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledWith(12.5)
  })

  it('rejects unreadable input without committing or closing', () => {
    const { onCommit, onClose } = renderEntry()
    fireEvent.change(screen.getByLabelText('Weight'), { target: { value: 'abc' } })
    fireEvent.keyDown(screen.getByLabelText('Weight'), { key: 'Enter' })
    expect(onCommit).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('stays open when the commit is blocked by the weight step', () => {
    const onCommit = vi.fn(() => false)
    const onClose = vi.fn()
    renderEntry({ onCommit, onClose })
    fireEvent.change(screen.getByLabelText('Weight'), { target: { value: '250000' } })
    fireEvent.keyDown(screen.getByLabelText('Weight'), { key: 'Enter' })
    expect(onCommit).toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes on Escape and on Cancel', () => {
    const { onClose } = renderEntry()
    fireEvent.keyDown(screen.getByLabelText('Weight'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('closes when the pointer goes down outside it', () => {
    const { onClose } = renderEntry()
    fireEvent.pointerDown(document.body)
    expect(onClose).toHaveBeenCalled()
  })

  it('names the weight step when there is one', () => {
    renderEntry({ weightStep: 10 })
    expect(screen.getByText(/step ×10/)).toBeDefined()
  })

  it('keeps itself inside the container near the right edge', () => {
    renderEntry({ x: 890, width: 900 })
    const box = document.querySelector('.chart-entry') as HTMLElement
    expect(parseFloat(box.style.left)).toBeLessThanOrEqual(900 - 200 - 6)
  })
})
```

Append to `src/components/DistributionChart.test.tsx`:

```ts
describe('DistributionChart value entry', () => {
  it('opens a pre-filled popover when a bar is right-clicked', () => {
    renderChart({ metric: 'weights' })
    fireEvent.contextMenu(document.querySelectorAll('.bar-hit')[1], { clientX: 200, clientY: 150 })
    expect(screen.getByRole('dialog')).toBeDefined()
    expect((screen.getByLabelText('Weight') as HTMLInputElement).value).toBe('300000')
  })

  it('opens from a group handle with the group total', () => {
    renderChart({ metric: 'weights' })
    fireEvent.contextMenu(screen.getByRole('slider', { name: 'bonus group' }), {
      clientX: 800,
      clientY: 100,
    })
    expect((screen.getByLabelText('Weight') as HTMLInputElement).value).toBe('200000')
  })

  it('commits a typed weight as one undo step, preserving the grand total', () => {
    const { onCommit } = renderChart({ metric: 'weights', relative: true })
    fireEvent.contextMenu(document.querySelectorAll('.bar-hit')[1], { clientX: 200, clientY: 150 })
    fireEvent.change(screen.getByLabelText('Weight'), { target: { value: '250000' } })
    fireEvent.keyDown(screen.getByLabelText('Weight'), { key: 'Enter' })

    expect(onCommit).toHaveBeenCalledTimes(1)
    const rows = lastRows(onCommit)
    expect(rows[1].weight).toBe(250_000)
    expect(sum(weightsOf(rows))).toBe(1_000_000)
  })

  it('commits a typed percentage in chance mode', () => {
    const { onCommit } = renderChart({ metric: 'chance' })
    fireEvent.contextMenu(document.querySelectorAll('.bar-hit')[1], { clientX: 200, clientY: 150 })
    fireEvent.change(screen.getByLabelText('Chance %'), { target: { value: '25' } })
    fireEvent.keyDown(screen.getByLabelText('Chance %'), { key: 'Enter' })
    expect(lastRows(onCommit)[1].weight).toBe(250_000)
  })

  it('reports a step-blocked entry and keeps the weights', () => {
    // 1,000,005 free weight cannot be partitioned on a step of 10.
    const rows = baseRows().map((r) => (r.uid === 'a' ? { ...r, weight: 500_005 } : r))
    const { onCommit, onDragBlocked } = renderChart({ metric: 'weights', relative: true }, rows)
    fireEvent.contextMenu(document.querySelectorAll('.bar-hit')[1], { clientX: 200, clientY: 150 })
    fireEvent.change(screen.getByLabelText('Weight'), { target: { value: '250000' } })
    fireEvent.keyDown(screen.getByLabelText('Weight'), { key: 'Enter' })
    expect(onDragBlocked).toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('does not open on a locked bar', () => {
    const rows = baseRows().map((r) => (r.uid === 'a' ? { ...r, locked: true } : r))
    renderChart({ metric: 'weights' }, rows)
    fireEvent.contextMenu(document.querySelectorAll('.bar-hit')[0], { clientX: 100, clientY: 150 })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
```

The step-blocked test needs a weight step of 10, so extend `renderChart` to take one:

```ts
function renderChart(chart: Partial<ChartSettings>, rows = baseRows(), height = 340, weightStep: 1 | 10 | 100 = 1) {
```

and pass `weightStep={weightStep}` to the component. Update that one call to `renderChart(..., ..., 340, 10)`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/ChartValueEntry.test.tsx src/components/DistributionChart.test.tsx`
Expected: FAIL — `Failed to resolve import "./ChartValueEntry"`, and no dialog opens.

- [ ] **Step 3: Write the popover**

Create `src/components/ChartValueEntry.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react'
import { evaluateExpression } from '../lib/expr'
import { fmtWeight } from '../lib/format'
import { remapNumpadComma } from './numpadDecimal'

/**
 * Type an exact weight or chance for whatever was right-clicked in the
 * distribution chart.
 *
 * A drag cannot reliably land on 4,200, and the chart is a control surface now
 * — so the precise path is a popover at the pointer rather than a trip back to
 * the table. It commits through the same operations a drag commits through, so
 * the weight step, the locked rows and the grand-total invariant behave
 * identically either way.
 */

export interface ValueEntryTarget {
  /** What is being edited — a bucket label, a bar summary, or a group name. */
  title: string
  uids: string[]
  /** Current value in the chart's metric: a weight, or a percentage. */
  current: number
  unit: 'weight' | '%'
}

interface ChartValueEntryProps {
  target: ValueEntryTarget
  /** Pointer position inside the chart container, in px. */
  x: number
  y: number
  /** Container width, for the horizontal clamp. */
  width: number
  weightStep: number
  /** Returns false when the commit was refused, which keeps the popover open. */
  onCommit: (value: number) => boolean
  onClose: () => void
}

/** Matches `.chart-entry`'s CSS width. Fixed content, so a constant is honest. */
const BOX_W = 200
const PAD = 6

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

export function ChartValueEntry({
  target,
  x,
  y,
  width,
  weightStep,
  onCommit,
  onClose,
}: ChartValueEntryProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [text, setText] = useState(() => String(target.current))

  /**
   * A pointer press anywhere else dismisses. The contextmenu event that opened
   * this fires after its own pointerdown, so the opening press can never be
   * caught by the listener attached here.
   */
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [onClose])

  const commit = () => {
    const n = evaluateExpression(text)
    // Unreadable input reverts nothing and closes nothing — the field keeps
    // what was typed so a typo can be fixed rather than retyped.
    if (n === null || !Number.isFinite(n) || n < 0) return
    if (onCommit(n)) onClose()
  }

  const label = target.unit === 'weight' ? 'Weight' : 'Chance %'
  const now = target.unit === 'weight' ? fmtWeight(target.current) : `${target.current}%`

  // A box wider than its container cannot be placed legally; pin it left.
  const left = width < BOX_W + 2 * PAD ? PAD : clamp(x, PAD, width - BOX_W - PAD)

  return (
    <div
      ref={ref}
      className="chart-entry"
      role="dialog"
      aria-label={`Set ${label.toLowerCase()} for ${target.title}`}
      style={{ left, top: Math.max(PAD, y) }}
    >
      <div className="chart-entry-title">{target.title}</div>
      <label className="chart-entry-field">
        <span>{label}</span>
        <input
          className="panel-num"
          aria-label={label}
          value={text}
          spellCheck={false}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (remapNumpadComma(e)) {
              setText(e.currentTarget.value)
              return
            }
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') onClose()
          }}
        />
      </label>
      <div className="chart-entry-hint">
        now {now}
        {weightStep > 1 && ` · step ×${weightStep}`}
      </div>
      <div className="chart-entry-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn primary" onClick={commit}>
          Set
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Style it**

Append to `src/index.css`, after the `.chart-readout` block:

```css
/* Exact-value entry, opened by right-clicking a bar or a group handle. */
.chart-entry {
  position: absolute;
  z-index: 8;
  width: 200px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 9px 11px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 5px;
  background: var(--surface);
  box-shadow: 0 6px 18px rgba(31, 35, 40, 0.18);
}

.chart-entry-title {
  font-size: 12px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chart-entry-field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: var(--text-dim);
}

.chart-entry-field .panel-num {
  width: 108px;
}

.chart-entry-hint {
  font-size: 11px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.chart-entry-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
```

- [ ] **Step 5: Wire it into the chart**

In `src/components/DistributionChart.tsx`:

1. Import it and `fmtPayout` is already imported:

```ts
import { ChartValueEntry, type ValueEntryTarget } from './ChartValueEntry'
```

2. Add state beside the other hooks:

```ts
  /** Non-null while the exact-value popover is open. */
  const [entry, setEntry] = useState<{ target: ValueEntryTarget; x: number; y: number } | null>(null)
```

3. Add the commit path and the opener, after `endDrag`:

```ts
  /**
   * The typed-value path. Deliberately the same two operations the drag uses,
   * so the weight step, the locked rows and the grand-total invariant cannot
   * drift apart between the two ways of setting a value.
   */
  const commitValue = (uids: string[], value: number): boolean => {
    const baseTotal = rows.reduce((a, r) => a + Math.max(0, Math.round(r.weight)), 0)
    const target = metric === 'chance' ? clamp(value / 100, 0, 1) * baseTotal : value
    const weights =
      metric === 'chance' || relative
        ? scaleSubset(rows, uids, target, weightStep)
        : setSubsetTotal(rows, uids, target, weightStep)
    if (weights === null) {
      onDragBlocked()
      return false
    }
    onCommit(rows.map((r, i) => (r.weight === weights[i] ? r : { ...r, weight: weights[i] })))
    return true
  }

  const openEntry = (
    e: React.MouseEvent,
    title: string,
    uids: string[],
    value: number,
    disabled: boolean,
  ) => {
    e.preventDefault()
    if (disabled) return
    const rect = containerRef.current?.getBoundingClientRect()
    setEntry({
      target: {
        title,
        uids,
        current: metric === 'chance' ? Math.round(value * 1e6) / 1e4 : Math.round(value),
        unit: metric === 'chance' ? '%' : 'weight',
      },
      x: e.clientX - (rect?.left ?? 0),
      y: e.clientY - (rect?.top ?? 0),
    })
  }
```

4. Add a title helper next to `readoutTitles`:

```ts
  /** What the popover calls a bar: its label when there is one, else a summary. */
  const barTitle = (b: ChartBar) =>
    b.kind === 'group'
      ? b.name
      : b.labels.length === 1
        ? b.labels[0]
        : `${b.labels.length} buckets · ×${fmtPayout(b.payout)}`
```

5. Add `onContextMenu` to the group handle `<g>` (beside its `onPointerDown`):

```ts
                    onContextMenu={(e) => openEntry(e, s.group.name, s.group.uids, s.value, s.allLocked)}
```

and to the bar hit rect:

```ts
                  onContextMenu={(e) => openEntry(e, barTitle(b), b.uids, valueOf(b), b.allLocked)}
```

6. Render it, immediately after `<ChartReadout … />`:

```tsx
            {entry !== null && (
              <ChartValueEntry
                target={entry.target}
                x={entry.x}
                y={entry.y}
                width={width}
                weightStep={weightStep}
                onCommit={(v) => commitValue(entry.target.uids, v)}
                onClose={() => setEntry(null)}
              />
            )}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/components/ChartValueEntry.test.tsx src/components/DistributionChart.test.tsx`
Expected: PASS.

- [ ] **Step 7: Run lint, typecheck and the full suite**

Run: `npm run lint && npm run build && npm run test:run`
Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add src/components/ChartValueEntry.tsx src/components/ChartValueEntry.test.tsx src/components/DistributionChart.tsx src/components/DistributionChart.test.tsx src/index.css
git commit -m "feat: right-click a bar or group handle to type an exact value"
```

---

### Task 5: The group-bars chip row

**Files:**
- Create: `src/components/GroupBarChips.tsx`
- Create: `src/components/GroupBarChips.test.tsx`
- Modify: `src/components/DistributionChart.tsx` — render the chips under the controls
- Modify: `src/index.css` — `.group-bar-chips`
- Test: `src/App.test.tsx` (append)

**Interfaces:**
- Consumes: `GroupInfo` from `src/lib/groups.ts`, `ChartSettings.groupBars` from Task 2.
- Produces: `GroupBarChips` — used only by `DistributionChart`.

- [ ] **Step 1: Write the failing tests**

Create `src/components/GroupBarChips.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { GroupBarChips } from './GroupBarChips'
import { groupRows } from '../lib/groups'
import type { BucketRow } from '../lib/types'

afterEach(cleanup)

const rows: BucketRow[] = [
  { uid: 'a', bucketId: 0, payout: 0, label: '0x', weight: 1, locked: false, groupId: 'zero', weightId: '' },
  { uid: 'b', bucketId: 1, payout: 0.6, label: '0-1x', weight: 1, locked: false, groupId: 'wins', weightId: '' },
  { uid: 'c', bucketId: 2, payout: 8, label: 'bonus3', weight: 1, locked: false, groupId: 'bonus', weightId: '' },
]

const renderChips = (groupBars: string[] = []) => {
  const onGroupBars = vi.fn()
  render(
    <GroupBarChips
      groups={groupRows(rows).groups}
      groupBars={groupBars}
      onGroupBars={onGroupBars}
    />,
  )
  return { onGroupBars }
}

describe('GroupBarChips', () => {
  it('offers one chip per group that holds buckets', () => {
    renderChips()
    expect(screen.getAllByRole('button', { pressed: false }).map((b) => b.textContent)).toEqual([
      'wins',
      'bonus',
      '0x',
    ])
  })

  it('marks a collapsed group as pressed', () => {
    renderChips(['bonus'])
    expect(screen.getByRole('button', { name: 'bonus', pressed: true })).toBeDefined()
  })

  it('collapses a group when its chip is clicked', () => {
    const { onGroupBars } = renderChips()
    fireEvent.click(screen.getByRole('button', { name: 'bonus' }))
    expect(onGroupBars).toHaveBeenCalledWith(['bonus'])
  })

  it('expands a collapsed group when its chip is clicked again', () => {
    const { onGroupBars } = renderChips(['wins', 'bonus'])
    fireEvent.click(screen.getByRole('button', { name: 'bonus' }))
    expect(onGroupBars).toHaveBeenCalledWith(['wins'])
  })

  it('collapses every drawn group from All', () => {
    const { onGroupBars } = renderChips()
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(onGroupBars).toHaveBeenCalledWith(['wins', 'bonus', 'zero'])
  })

  it('expands everything from None', () => {
    const { onGroupBars } = renderChips(['wins', 'bonus'])
    fireEvent.click(screen.getByRole('button', { name: 'None' }))
    expect(onGroupBars).toHaveBeenCalledWith([])
  })
})
```

Append to `src/App.test.tsx` as a new `describe`. `Load sample` builds groups named `wins`, `bonus`, `0x` and `other`; the persistence half seeds a workspace directly, which is how the file's other restore tests work — autosave is debounced and there is no settling helper:

```tsx
describe('group bars', () => {
  it('collapses a group into one bar from the chip row', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Load sample' }))

    const before = document.querySelectorAll('.bar').length
    fireEvent.click(screen.getByRole('button', { name: 'bonus' }))

    expect(document.querySelectorAll('.bar').length).toBeLessThan(before)
    expect(screen.getByRole('button', { name: 'bonus', pressed: true })).toBeDefined()
  })

  it('restores collapsed groups from a saved workspace', () => {
    saveWorkspace({
      version: 1,
      rows: [
        { uid: 'b1', bucketId: 0, payout: 2, label: 'bonus3', weight: 500, locked: false, groupId: 'bonus', weightId: '' },
        { uid: 'b2', bucketId: 1, payout: 8, label: 'bonus4', weight: 500, locked: false, groupId: 'bonus', weightId: '' },
      ],
      groups: [{ id: 'bonus', name: 'bonus', color: '#a8d8ea' }],
      targets: DEFAULT_TARGETS,
      volatility: 'medium',
      curve: 0.09,
      columnWidths: {},
      chart: { ...DEFAULT_CHART, groupBars: ['bonus'] },
      exportFilename: 'f.tsv',
    })
    render(<App />)
    expect(screen.getByRole('button', { name: 'bonus', pressed: true })).toBeDefined()
    expect(document.querySelectorAll('.bar')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/GroupBarChips.test.tsx`
Expected: FAIL — `Failed to resolve import "./GroupBarChips"`.

- [ ] **Step 3: Write the component**

Create `src/components/GroupBarChips.tsx`:

```tsx
import type { GroupInfo } from '../lib/groups'

/**
 * Which groups are drawn as a single bar.
 *
 * Doubles as the legend the distribution chart has never had: one colored chip
 * per group, so the bar colors are named even when nothing is collapsed.
 *
 * Chips come from the *drawn* groups, not the document's group list — an empty
 * group has no bar to collapse. `groupBars` may still name an id that is not
 * drawn; `buildBars` ignores it, so a group emptied and refilled comes back
 * collapsed exactly as it was left.
 */

interface GroupBarChipsProps {
  groups: GroupInfo[]
  groupBars: string[]
  onGroupBars: (ids: string[]) => void
}

export function GroupBarChips({ groups, groupBars, onGroupBars }: GroupBarChipsProps) {
  if (groups.length === 0) return null
  const collapsed = new Set(groupBars)

  const toggle = (id: string) => {
    onGroupBars(
      collapsed.has(id) ? groupBars.filter((g) => g !== id) : [...groupBars, id],
    )
  }

  return (
    <div className="group-bar-chips">
      <span className="field-label">Group bars</span>
      <button type="button" className="btn" onClick={() => onGroupBars(groups.map((g) => g.id))}>
        All
      </button>
      <button type="button" className="btn" onClick={() => onGroupBars([])}>
        None
      </button>
      {groups.map((g) => {
        const on = collapsed.has(g.id)
        return (
          <button
            key={g.id}
            type="button"
            className={`group-bar-chip ${on ? 'on' : ''}`}
            aria-pressed={on}
            title={on ? `Show ${g.name}'s buckets` : `Draw ${g.name} as one bar`}
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

- [ ] **Step 4: Style it**

Append to `src/index.css`, after the `.chart-controls` block:

```css
.group-bar-chips {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 8px 14px;
  border-bottom: 1px solid var(--line);
}

.group-bar-chips .field-label {
  margin-right: 2px;
}

.group-bar-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: inherit;
  font-size: 12px;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 3px 8px;
  cursor: pointer;
}

.group-bar-chip:hover {
  border-color: var(--line-strong);
}

.group-bar-chip.on {
  border-color: var(--accent);
  background: var(--accent-soft);
  font-weight: 600;
}

.chip-swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  flex: none;
  /* Hollow until collapsed, so the chip's own state reads at a glance. */
  box-shadow: inset 0 0 0 1px rgba(31, 35, 40, 0.18);
}
```

- [ ] **Step 5: Render it in the chart**

In `src/components/DistributionChart.tsx`, import it:

```ts
import { GroupBarChips } from './GroupBarChips'
```

and add it immediately after the closing `</div>` of `.chart-controls`:

```tsx
      <GroupBarChips
        groups={grouping.groups}
        groupBars={groupBars}
        onGroupBars={(ids) => set({ groupBars: ids })}
      />
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/components/GroupBarChips.test.tsx src/App.test.tsx`
Expected: PASS.

- [ ] **Step 7: Run lint, typecheck and the full suite**

Run: `npm run lint && npm run build && npm run test:run`
Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add src/components/GroupBarChips.tsx src/components/GroupBarChips.test.tsx src/components/DistributionChart.tsx src/App.test.tsx src/index.css
git commit -m "feat: chip row collapses groups into single bars"
```

---

### Task 6: Lock a whole group

**Files:**
- Modify: `src/lib/groups.ts` — add `LockState` and `groupLockState`
- Modify: `src/App.tsx` — `setGroupLocked`, pass to both consumers
- Modify: `src/components/GroupSettings.tsx` — padlock per group row
- Modify: `src/components/DistributionChart.tsx` — padlock on the group handle
- Modify: `src/index.css` — `.group-lock`, `.handle-lock`
- Test: `src/lib/groups.test.ts`, `src/App.test.tsx`, `src/components/DistributionChart.test.tsx` (all append)

**Interfaces:**
- Consumes: `BucketRow` from `src/lib/types.ts`.
- Produces: `LockState = 'none' | 'some' | 'all'`; `groupLockState(rows: BucketRow[], groupId: string): LockState`; `GroupSettings` gains `lockStates: Map<string, LockState>` and `onLock: (id: string, locked: boolean) => void`; `DistributionChart` gains `onGroupLock: (id: string, locked: boolean) => void`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/groups.test.ts`:

```ts
import { groupLockState } from './groups'

describe('groupLockState', () => {
  const rows = (locks: boolean[]): BucketRow[] =>
    locks.map((locked, i) => ({
      uid: `u${i}`,
      bucketId: i,
      payout: i,
      label: `l${i}`,
      weight: 100,
      locked,
      groupId: i === 0 ? 'other' : 'g1',
      weightId: '',
    }))

  it('reports none when no member is locked', () => {
    expect(groupLockState(rows([false, false, false]), 'g1')).toBe('none')
  })

  it('reports some when only part of the group is locked', () => {
    expect(groupLockState(rows([false, true, false]), 'g1')).toBe('some')
  })

  it('reports all when every member is locked', () => {
    expect(groupLockState(rows([false, true, true]), 'g1')).toBe('all')
  })

  it('ignores rows outside the group', () => {
    expect(groupLockState(rows([true, false, false]), 'g1')).toBe('none')
  })

  it('reports none for a group with no buckets', () => {
    expect(groupLockState(rows([false, false, false]), 'empty')).toBe('none')
  })
})
```

Append to `src/components/DistributionChart.test.tsx`:

```ts
describe('DistributionChart group locks', () => {
  it('locks an unlocked group from its handle', () => {
    const onGroupLock = vi.fn()
    renderChart({ metric: 'weights' }, baseRows(), 340, 1, { onGroupLock })
    fireEvent.click(screen.getByRole('button', { name: 'Lock the bonus group' }))
    expect(onGroupLock).toHaveBeenCalledWith('bonus', true)
  })

  it('unlocks a fully locked group from its handle', () => {
    const onGroupLock = vi.fn()
    const rows = baseRows().map((r) => (r.payout >= 8 ? { ...r, locked: true } : r))
    renderChart({ metric: 'weights' }, rows, 340, 1, { onGroupLock })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock the bonus group' }))
    expect(onGroupLock).toHaveBeenCalledWith('bonus', false)
  })

  it('locks the rest of a partly locked group', () => {
    const onGroupLock = vi.fn()
    const rows = baseRows().map((r) => (r.uid === 'c' ? { ...r, locked: true } : r))
    renderChart({ metric: 'weights' }, rows, 340, 1, { onGroupLock })
    fireEvent.click(screen.getByRole('button', { name: 'Lock the bonus group' }))
    expect(onGroupLock).toHaveBeenCalledWith('bonus', true)
  })

  it('does not start a drag when the padlock is pressed', () => {
    const { onPreview } = renderChart({ metric: 'weights' }, baseRows(), 340, 1, {
      onGroupLock: vi.fn(),
    })
    const lock = screen.getByRole('button', { name: 'Lock the bonus group' })
    fireEvent.pointerDown(lock, { pointerId: 1, clientY: 250 })
    fireEvent.pointerMove(lock, { pointerId: 1, clientY: 100 })
    expect(onPreview).not.toHaveBeenCalled()
  })
})
```

Extend `renderChart` with a fifth parameter for extra props:

```ts
function renderChart(
  chart: Partial<ChartSettings>,
  rows = baseRows(),
  height = 340,
  weightStep: 1 | 10 | 100 = 1,
  extra: Partial<React.ComponentProps<typeof DistributionChart>> = {},
) {
```

pass `onGroupLock={vi.fn()}` by default and spread `{...extra}` last onto the component.

Append to `src/App.test.tsx`:

```ts
it('locks every bucket in a group and undoes it in one step', () => {
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: 'Load sample' }))
  fireEvent.click(screen.getByRole('button', { name: 'Group settings' }))

  const lockedRows = () => document.querySelectorAll('.gcell.lock.on').length
  const before = lockedRows()

  // Both the settings row and the chart handle carry this label, so scope it.
  const settings = within(document.querySelector('.group-settings') as HTMLElement)
  fireEvent.click(settings.getByRole('button', { name: 'Lock the bonus group' }))
  expect(lockedRows()).toBeGreaterThan(before)

  fireEvent.click(screen.getByRole('button', { name: '↶ Undo' }))
  expect(lockedRows()).toBe(before)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/groups.test.ts src/components/DistributionChart.test.tsx src/App.test.tsx`
Expected: FAIL — `groupLockState` is not exported and no padlock exists.

- [ ] **Step 3: Add the helper**

Append to `src/lib/groups.ts`:

```ts
/**
 * How much of a group is locked. A group has no lock of its own: it is locked
 * when every one of its buckets is, which keeps row locks the single source of
 * truth for the solver, for `interact.ts` and for the export.
 */
export type LockState = 'none' | 'some' | 'all'

export function groupLockState(rows: BucketRow[], groupId: string): LockState {
  let members = 0
  let locked = 0
  for (const r of rows) {
    if (r.groupId !== groupId) continue
    members += 1
    if (r.locked) locked += 1
  }
  if (members === 0 || locked === 0) return 'none'
  return locked === members ? 'all' : 'some'
}
```

- [ ] **Step 4: Add the action in `App`**

In `src/App.tsx`, import `groupLockState` and `type LockState` from `./lib/groups`, then add beside the other group actions:

```ts
  /**
   * A group lock is just its rows' locks, set together — so undo, the solver
   * and the export need to know nothing about groups.
   */
  const setGroupLocked = useCallback(
    (id: string, locked: boolean) => {
      commit((d) => ({
        ...d,
        rows: d.rows.map((r) => (r.groupId === id ? { ...r, locked } : r)),
      }))
    },
    [commit],
  )

  const groupLockStates = useMemo(() => {
    const m = new Map<string, LockState>()
    for (const g of doc.groups) m.set(g.id, groupLockState(doc.rows, g.id))
    return m
  }, [doc.groups, doc.rows])
```

Pass `lockStates={groupLockStates}` and `onLock={setGroupLocked}` to `<GroupSettings>`, and `onGroupLock={setGroupLocked}` to `<DistributionChart>`.

- [ ] **Step 5: Add the padlock to `GroupSettings`**

In `src/components/GroupSettings.tsx`, add to the props interface:

```ts
  /** Per-group lock state, derived from the member rows' locks. */
  lockStates: Map<string, LockState>
  onLock: (id: string, locked: boolean) => void
```

import `type LockState` from `../lib/groups`, destructure `lockStates` and `onLock`, and insert this button immediately after the `group-chip` span:

```tsx
              <button
                type="button"
                className={`group-lock ${state === 'all' ? 'on' : ''} ${state === 'some' ? 'partial' : ''}`}
                disabled={n === 0}
                aria-label={`${state === 'all' ? 'Unlock' : 'Lock'} the ${g.name} group`}
                title={
                  n === 0
                    ? 'No buckets to lock'
                    : state === 'all'
                      ? 'Unlock every bucket in this group'
                      : state === 'some'
                        ? 'Some buckets are locked — lock the rest'
                        : 'Lock every bucket in this group'
                }
                onClick={() => onLock(g.id, state !== 'all')}
              >
                {state === 'all' ? '🔒' : '🔓'}
              </button>
```

with `const state = lockStates.get(g.id) ?? 'none'` beside the existing `const n = counts.get(g.id) ?? 0`.

- [ ] **Step 6: Add the padlock to the chart handle**

In `src/components/DistributionChart.tsx`:

1. Add to props: `onGroupLock: (id: string, locked: boolean) => void`, and destructure it.

2. `groupStats` currently computes `allLocked`. Add `anyLocked` alongside it — set `anyLocked = true` inside the loop whenever `r.locked`, initialised `false`, and return it.

3. Inside the handle `<g>`, **after** the `handle-hit` rect so it sits on top:

```tsx
                    <g
                      role="button"
                      className={`handle-lock ${s.allLocked ? 'on' : ''} ${!s.allLocked && s.anyLocked ? 'partial' : ''}`}
                      aria-label={`${s.allLocked ? 'Unlock' : 'Lock'} the ${s.group.name} group`}
                      // The padlock sits inside the handle's drag target, so
                      // its press must not also start a drag.
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => onGroupLock(s.group.id, !s.allLocked)}
                    >
                      <rect
                        x={plotRight + MARGIN.right - 26}
                        y={yLabel - 10}
                        width={20}
                        height={20}
                        rx={3}
                        fill="transparent"
                      />
                      <text x={plotRight + MARGIN.right - 16} y={yLabel + 4} textAnchor="middle">
                        {s.allLocked ? '🔒' : '🔓'}
                      </text>
                    </g>
```

- [ ] **Step 7: Style the padlocks**

Append to `src/index.css`:

```css
.group-lock {
  font-family: inherit;
  font-size: 13px;
  line-height: 1;
  padding: 3px 5px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: none;
  cursor: pointer;
  opacity: 0.45;
}

.group-lock:hover:not(:disabled) {
  opacity: 1;
  border-color: var(--line);
}

.group-lock.on,
.group-lock.partial {
  opacity: 1;
}

.group-lock.partial {
  opacity: 0.7;
}

.group-lock:disabled {
  cursor: default;
  opacity: 0.2;
}

.handle-lock {
  cursor: pointer;
  font-size: 11px;
  opacity: 0.35;
}

.handle-lock:hover,
.handle-lock.on {
  opacity: 1;
}

.handle-lock.partial {
  opacity: 0.65;
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run src/lib/groups.test.ts src/components/DistributionChart.test.tsx src/App.test.tsx`
Expected: PASS.

- [ ] **Step 9: Run lint, typecheck and the full suite**

Run: `npm run lint && npm run build && npm run test:run`
Expected: all clean.

- [ ] **Step 10: Commit**

```bash
git add src/lib/groups.ts src/lib/groups.test.ts src/App.tsx src/App.test.tsx src/components/GroupSettings.tsx src/components/DistributionChart.tsx src/components/DistributionChart.test.tsx src/index.css
git commit -m "feat: lock a whole group from settings or from its chart handle"
```

---

### Task 7: Group settings into the targets panel, import/export as blocks

**Files:**
- Modify: `src/components/TargetsPanel.tsx` — a `Group settings` button in `actions`
- Modify: `src/App.tsx` — move the button out of the top bar, restructure the top bar
- Modify: `src/index.css` — `.topbar-block`, `.topbar-block-label`; delete `.topbar-sep`
- Test: `src/App.test.tsx` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: `TargetsPanel` gains `groupsOpen: boolean` and `onGroupSettings: () => void`.

- [ ] **Step 1: Write the failing tests**

Append to `src/App.test.tsx`:

```ts
describe('chrome layout', () => {
  it('opens group settings from the targets panel', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Load sample' }))
    const targets = document.querySelector('.targets')!
    const btn = screen.getByRole('button', { name: 'Group settings' })
    expect(targets.contains(btn)).toBe(true)
    fireEvent.click(btn)
    expect(screen.getByRole('heading', { name: 'Groups' })).toBeDefined()
  })

  it('keeps group settings reachable when the targets panel is collapsed', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Load sample' }))
    fireEvent.click(screen.getByRole('button', { name: /Targets/ }))
    expect(screen.getByRole('button', { name: 'Group settings' })).toBeDefined()
  })

  it('separates import from export in the top bar', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Load sample' }))

    const blocks = [...document.querySelectorAll('.topbar-block')]
    expect(blocks.map((b) => b.querySelector('.topbar-block-label')!.textContent)).toEqual([
      'Import',
      'Export',
    ])
    expect(blocks[0].contains(screen.getByRole('button', { name: 'Paste TSV data' }))).toBe(true)
    expect(blocks[1].contains(screen.getByRole('button', { name: 'Copy TSV' }))).toBe(true)
    expect(blocks[1].contains(screen.getByLabelText('Export filename'))).toBe(true)

    // Destructive, and deliberately outside both blocks.
    const clear = screen.getByRole('button', { name: 'Clear workspace' })
    expect(blocks.some((b) => b.contains(clear))).toBe(false)
    expect(document.querySelector('.topbar-sep')).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/App.test.tsx -t "chrome layout"`
Expected: FAIL — the group settings button is in the top bar and there are no blocks.

- [ ] **Step 3: Add the button to `TargetsPanel`**

In `src/components/TargetsPanel.tsx`, add to `TargetsPanelProps`:

```ts
  groupsOpen: boolean
  onGroupSettings: () => void
```

destructure both, and add to the `actions` fragment, after the Auto-Distribute button and before the `btn-row`:

```tsx
      <button
        type="button"
        className={`btn ${groupsOpen ? 'primary' : ''}`}
        aria-expanded={groupsOpen}
        onClick={onGroupSettings}
        title="Add, rename, recolor, lock or delete bucket groups"
      >
        Group settings
      </button>
```

`actions` is rendered in exactly one place at a time — the settings row when expanded, the head bar when collapsed — so this needs no second copy.

- [ ] **Step 4: Restructure the top bar**

In `src/App.tsx`, pass the two new props to `<TargetsPanel>`:

```tsx
            groupsOpen={groupsOpen}
            onGroupSettings={() => setGroupsOpen((v) => !v)}
```

and replace the whole `.topbar-actions` body with:

```tsx
        <div className="topbar-actions">
          <div className="topbar-block">
            <span className="topbar-block-label">Import</span>
            <button type="button" className="btn" onClick={() => loadData(SAMPLE_TSV)}>
              Load sample
            </button>
            <button type="button" className="btn" onClick={() => setPasteOpen(true)}>
              Paste TSV data
            </button>
          </div>
          {hasRows && (
            <>
              <div className="topbar-block">
                <span className="topbar-block-label">Export</span>
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
              </div>
              {/* Destructive, so it stands apart from the two blocks rather
                  than sitting among the actions used constantly. */}
              <button type="button" className="btn danger" onClick={handleClear}>
                Clear workspace
              </button>
            </>
          )}
        </div>
```

- [ ] **Step 5: Style the blocks**

In `src/index.css`, delete the `.topbar-sep` rule and its comment (lines 92-98), and add:

```css
/* Import and export read as two things, which a hairline rule never conveyed.
   Same card treatment as the targets panel. */
.topbar-block {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface);
}

.topbar-block-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-dim);
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/App.test.tsx`
Expected: PASS. Any pre-existing test that finds `Group settings` still finds it — it moved, it did not change its name.

- [ ] **Step 7: Run lint, typecheck and the full suite**

Run: `npm run lint && npm run build && npm run test:run`
Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add src/App.tsx src/App.test.tsx src/components/TargetsPanel.tsx src/index.css
git commit -m "feat: group settings joins the targets panel, top bar splits import from export"
```

---

### Task 8: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the feature sections**

1. **Contents** — after `- [Locks](#locks)` add `  - [Group locks](#group-locks)`; rename the `Dragging the distribution chart` entry to `- [Dragging and setting values on the chart](#dragging-and-setting-values-on-the-chart)` and add `  - [Group bars](#group-bars)` under it.

2. **Locks** — append a `#### Group locks` subsection:

> Whole groups lock too. A group is locked when every bucket in it is, and the padlock — in **Group settings** beside each group's name, and on the group's handle at the chart's right edge — locks or unlocks all of them in one undoable step. A group with some buckets locked shows a half-lit padlock; clicking it locks the rest. There is no separate group-level lock: row locks stay the single thing the solver, the export and the chart all read.

3. **Dragging the distribution chart** — retitle to `### Dragging and setting values on the chart` and replace the first paragraph with:

> Bars and group handles are draggable: press and move vertically to change the bucket's weight (weights mode) or chance (% mode). **Drags move by how far the pointer moves, not to where it is** — the bar never jumps on press, so it can be grabbed anywhere along its length, and a given pixel distance means the same thing wherever you grabbed: a constant multiplier on a log Y axis, a constant amount on a linear one. Escape cancels a drag in flight; a drag previews live in the table and commits as one undo step on release.
>
> **Right-click a bar or a handle to type an exact value** — a drag cannot land on 4,200 reliably. The popover pre-fills with the current weight, or the current percentage in % Chance mode, and accepts arithmetic like the grid cells do (`4150+50`). It commits through the same machinery a drag does, so locked rows, the weight step and the grand-total invariant behave identically, and it lands as one undo step. Enter sets, Escape and click-away cancel.

Keep the existing paragraphs about Relative drag, the view controls and the group handles.

4. Add a `#### Group bars` subsection after the group-handle paragraph:

> Any group can be **collapsed into a single bar**. The chip row under the chart controls has one chip per group — click to collapse or expand it, or use `All` / `None`. Collapsed groups are taken out first and each becomes one solid bar; whatever is left still aggregates by equal payout as before, so the two never double-count a bucket.
>
> A group bar sits at the group's **weight-weighted mean payout**, `Σ(payout × weight) / Σ weight`, so it is placed where the group's mass actually is and its position against the loose bars still means something. It is labelled with the group name rather than a payout, and drags and right-clicks exactly like that group's handle. Its tooltip gives the payout range, the mean, and the group's weight, chance and weighted value. The chip row doubles as the chart's legend. Which groups are collapsed is remembered with the workspace, and reset when new data is imported.

5. **The targets panel** — add to the list of what sits on the row: `Group settings` now lives there, in both the expanded row and the collapsed bar.

6. **Export** — replace the paragraph with:

> The top bar carries two blocks. **Import** holds `Load sample` and `Paste TSV data`; **Export** holds the editable filename, `Copy TSV` and `Download .tsv`. `Copy TSV` puts the document on the clipboard; `Download .tsv` saves it, named `ref-weights-regular.tsv` by default. `Clear workspace` sits outside both, at the far right, since it destroys the table.

7. **Persistence** — add "which groups are collapsed into bars" to the list of persisted settings.

8. **Project layout** — add the three new files:

```
    bars.ts         chart bar construction, including collapsed groups
```
under `lib/`, and under `components/`:
```
    ChartValueEntry.tsx  right-click popover for an exact weight or chance
    GroupBarChips.tsx    which groups are drawn as a single bar
```

9. **Tests** — add a sentence: "`bars.ts` carries the chart's construction rules and is tested directly: group collapse, mean-payout placement, the log-axis zero drop and the interaction with equal-payout aggregation."

- [ ] **Step 2: Verify the anchors resolve**

Read the Contents list against the headings you changed and confirm every anchor matches its heading's slug (lowercase, spaces to hyphens, punctuation dropped).

- [ ] **Step 3: Run the full suite one last time**

Run: `npm run lint && npm run build && npm run test:run`
Expected: all clean.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: exact value entry, delta drags, group locks and group bars"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §1 Right-click exact value | 4 |
| §2 Delta dragging | 3 |
| §3 Group locks | 6 |
| §4 Group collapse — `groupBars`, chip row, mean-payout placement, `bars.ts` | 1, 2, 5 |
| §5 Group settings into targets panel | 7 |
| §6 Import/export blocks | 7 |
| Testing section | folded into each task |

**Type consistency:** `buildBars` / `ChartBar` / `BucketBar` / `GroupBar` / `Segment` defined in Task 1 and consumed under those names in 2, 3, 4, 5. `beginDrag`'s new fourth parameter (Task 3) is passed at both call sites, including the group-bar case introduced in Task 2. `LockState` / `groupLockState` defined in Task 6 and used under those names in `App`, `GroupSettings` and the tests. `ChartSettings.groupBars` added in Task 2, read in Task 2, written in Task 5. `ChartValueEntry`'s `onCommit` returns `boolean` in both its own tests and the `DistributionChart` wiring.

**Ordering note:** Task 3 changes `beginDrag`'s signature, which Task 2 already calls at the bar hit rect. Tasks must run in order.
