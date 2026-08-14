# Group Table, Dock Layout, Column Toggles & User Curve Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sixteen user features: a Group Distribution table, per-table column toggles with two new derived columns, hover usage hints, a chart gear menu with X-order/label options and diagonal labels, a drag-and-drop dock layout for the three main panels, a 100-step undo, a top-bar Settings button, drag-reorderable solver priority, and a "User curve" solve target the solver maintains and the chart draws.

**Architecture:** All work is inside the `tools/weighted-return-tool` submodule (React 19 + Vite + Vitest). New pure libs (`groupDistribution.ts`, `layout.ts`) carry the logic and get direct unit tests; components stay thin. The solver (`distribute.ts`) gains a user-curve regime where the saved shape replaces the exp-curve family. The TSV export path (`exportTsv.ts`) is untouched.

**Tech Stack:** TypeScript, React 19, Vite, Vitest + @testing-library/react (jsdom).

**Spec:** `docs/superpowers/specs/2026-08-14-group-table-layout-and-user-curve-design.md`

## Global Constraints

- Working directory for every command: the submodule root `tools/weighted-return-tool`.
- Export format must stay byte-identical — `buildTsv` and `EXPORT_HEADER` are never modified.
- All new Workspace fields are optional and validated in `storage.ts`; an old workspace must load with defaults, never crash or be discarded.
- Run `npx vitest run` (all tests) and commit at the end of every task. `npm run build` must pass at Task 8.
- Follow the codebase's comment style: comments state constraints the code can't show, never narrate the change.
- Windows shell: use PowerShell-compatible commands (`npx vitest run <file>`, `git add <paths>; git commit -m "..."`).

---

### Task 1: Group Distribution lib + panel, collapsible table panels

**Files:**
- Create: `src/lib/groupDistribution.ts`, `src/lib/groupDistribution.test.ts`
- Create: `src/components/GroupDistributionTable.tsx`, `src/components/GroupDistributionTable.test.tsx`
- Modify: `src/App.tsx` (new panel above the content row; collapse state for buckets + groupDist panels), `src/lib/storage.ts` (fields `groupDistCollapsed?: boolean`, `bucketsCollapsed?: boolean`, `hiddenGroupColumns?: string[]`), `src/index.css` (`.gdist-table`, `.panel-collapse` styles)

**Interfaces:**
- Consumes: `Grouping` from `src/lib/groups.ts`, `BucketRow` from `src/lib/types.ts`, `fmtPayout/fmtDecimal/fmtPct` from `src/lib/format.ts`.
- Produces:
  ```ts
  export interface GroupDistRow {
    id: string; name: string; color: string; count: number
    chance: number            // fraction of total weight; 0 when total <= 0
    oneIn: number | null      // 1 / chance; null when chance === 0
    payout: number            // weight-weighted mean payout; plain mean when weightless
    weightedValue: number     // Σ(p·w) / totalWeight
    rtpShare: number | null   // weightedValue / tableRtp; null when tableRtp <= 0
    std: number               // sqrt(Σw·p²/Σw − payout²), 0 when Σw === 0
  }
  export function groupDistribution(rows: BucketRow[], grouping: Grouping, totalWeight: number): GroupDistRow[]
  export const GROUP_DIST_COLUMNS: { key: string; label: string }[]  // keys: 'chance','oneIn','payout','weightedValue','rtpShare','std'
  ```
  Component: `<GroupDistributionTable rows grouping totalWeight hidden={string[]} />` renders `<table className="gdist-table">`.

- [ ] **Step 1: Write failing lib tests**

`src/lib/groupDistribution.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { groupDistribution } from './groupDistribution'
import { buildGrouping } from './groups'
import type { BucketRow, GroupDef } from './types'

const row = (uid: string, payout: number, weight: number, groupId: string): BucketRow => ({
  uid, bucketId: 0, payout, label: uid, weight, locked: false, groupId, weightId: '',
})
const groups: GroupDef[] = [
  { id: 'a', name: 'A', color: '#aabbcc' },
  { id: 'z', name: '0x', color: '#ccddee' },
]

describe('groupDistribution', () => {
  const rows = [row('r1', 10, 100, 'a'), row('r2', 2, 300, 'a'), row('r3', 0, 600, 'z')]
  const grouping = buildGrouping(rows, groups)
  const out = groupDistribution(rows, grouping, 1000)
  const a = out.find((g) => g.id === 'a')!
  const z = out.find((g) => g.id === 'z')!

  it('computes chance and oneIn', () => {
    expect(a.chance).toBeCloseTo(0.4, 12)
    expect(a.oneIn).toBeCloseTo(2.5, 12)
  })
  it('computes weight-weighted payout', () => {
    // (10·100 + 2·300) / 400 = 4
    expect(a.payout).toBeCloseTo(4, 12)
  })
  it('computes weighted value and rtp share', () => {
    // Σp·w/total = 1600/1000 = 1.6; table RTP is also 1.6 → share 1
    expect(a.weightedValue).toBeCloseTo(1.6, 12)
    expect(a.rtpShare).toBeCloseTo(1, 12)
    expect(z.rtpShare).toBeCloseTo(0, 12)
  })
  it('computes within-group weighted payout STD', () => {
    // E[p²] = (100·100 + 4·300)/400 = 28; mean 4 → var 12
    expect(a.std).toBeCloseTo(Math.sqrt(12), 12)
    expect(z.std).toBe(0)
  })
  it('handles zero total weight', () => {
    const empty = groupDistribution(rows.map((r) => ({ ...r, weight: 0 })), grouping, 0)
    const ga = empty.find((g) => g.id === 'a')!
    expect(ga.chance).toBe(0)
    expect(ga.oneIn).toBeNull()
    expect(ga.rtpShare).toBeNull()
    expect(ga.payout).toBeCloseTo(6, 12) // plain mean of 10 and 2
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib/groupDistribution.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `src/lib/groupDistribution.ts`**

```ts
import type { BucketRow } from './types'
import type { Grouping } from './groups'

export interface GroupDistRow {
  id: string
  name: string
  color: string
  count: number
  chance: number
  oneIn: number | null
  payout: number
  weightedValue: number
  rtpShare: number | null
  std: number
}

export const GROUP_DIST_COLUMNS = [
  { key: 'chance', label: 'Chance %' },
  { key: 'oneIn', label: 'One in' },
  { key: 'payout', label: 'Payout' },
  { key: 'weightedValue', label: 'Weighted Value' },
  { key: 'rtpShare', label: 'RTP Share' },
  { key: 'std', label: 'STD' },
] as const

export function groupDistribution(
  rows: BucketRow[],
  grouping: Grouping,
  totalWeight: number,
): GroupDistRow[] {
  const byUid = new Map(rows.map((r) => [r.uid, r]))
  const tableRtp =
    totalWeight > 0 ? rows.reduce((a, r) => a + (r.payout * r.weight) / totalWeight, 0) : 0

  return grouping.groups.map((g) => {
    const members = g.uids.map((u) => byUid.get(u)).filter((r): r is BucketRow => r !== undefined)
    const w = members.reduce((a, r) => a + r.weight, 0)
    const pw = members.reduce((a, r) => a + r.payout * r.weight, 0)
    const p2w = members.reduce((a, r) => a + r.payout * r.payout * r.weight, 0)
    const chance = totalWeight > 0 ? w / totalWeight : 0
    // Same placement rule as tableRows.ts aggregates and the chart's group bars.
    const payout =
      w > 0 ? pw / w : members.reduce((a, r) => a + r.payout, 0) / Math.max(1, members.length)
    const mean = w > 0 ? pw / w : 0
    const weightedValue = totalWeight > 0 ? pw / totalWeight : 0
    return {
      id: g.id,
      name: g.name,
      color: g.color,
      count: members.length,
      chance,
      oneIn: chance > 0 ? 1 / chance : null,
      payout,
      weightedValue,
      rtpShare: tableRtp > 0 ? weightedValue / tableRtp : null,
      std: w > 0 ? Math.sqrt(Math.max(0, p2w / w - mean * mean)) : 0,
    }
  })
}
```

- [ ] **Step 4: Run lib tests** — `npx vitest run src/lib/groupDistribution.test.ts` → PASS.

- [ ] **Step 5: Write failing component test**

`src/components/GroupDistributionTable.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { GroupDistributionTable } from './GroupDistributionTable'
import { buildGrouping } from '../lib/groups'
import type { BucketRow, GroupDef } from '../lib/types'

const row = (uid: string, payout: number, weight: number, groupId: string): BucketRow => ({
  uid, bucketId: 0, payout, label: uid, weight, locked: false, groupId, weightId: '',
})
const groups: GroupDef[] = [{ id: 'a', name: 'alpha', color: '#aabbcc' }]
const rows = [row('r1', 10, 100, 'a'), row('r2', 2, 300, 'a')]

describe('GroupDistributionTable', () => {
  it('shows one row per group with 2dp chance and a 10dp tooltip', () => {
    render(<GroupDistributionTable rows={rows} grouping={buildGrouping(rows, groups)} totalWeight={400} hidden={[]} />)
    expect(screen.getByText('alpha')).toBeTruthy()
    const chance = screen.getByText('100%')
    expect(chance.getAttribute('title')).toContain('100')
    expect(screen.getByText('1/1')).toBeTruthy()
  })
  it('hides toggled-off columns', () => {
    render(<GroupDistributionTable rows={rows} grouping={buildGrouping(rows, groups)} totalWeight={400} hidden={['std', 'oneIn']} />)
    expect(screen.queryByText('STD')).toBeNull()
    expect(screen.queryByText('One in')).toBeNull()
  })
})
```

- [ ] **Step 6: Run to verify failure**, then implement `src/components/GroupDistributionTable.tsx`

```tsx
import { useMemo } from 'react'
import type { BucketRow } from '../lib/types'
import type { Grouping } from '../lib/groups'
import { GROUP_DIST_COLUMNS, groupDistribution } from '../lib/groupDistribution'
import { fmtDecimal, fmtPayout, fmtPct } from '../lib/format'

interface GroupDistributionTableProps {
  rows: BucketRow[]
  grouping: Grouping
  totalWeight: number
  /** Column keys the gear menu has switched off. */
  hidden: string[]
}

export function GroupDistributionTable({ rows, grouping, totalWeight, hidden }: GroupDistributionTableProps) {
  const dist = useMemo(() => groupDistribution(rows, grouping, totalWeight), [rows, grouping, totalWeight])
  const off = new Set(hidden)
  const cols = GROUP_DIST_COLUMNS.filter((c) => !off.has(c.key))

  const cell = (g: (typeof dist)[number], key: string) => {
    switch (key) {
      case 'chance':
        return <td key={key} className="num" title={fmtPct(g.chance, 10)}>{fmtPct(g.chance, 2)}</td>
      case 'oneIn':
        return <td key={key} className="num">{g.oneIn === null ? '—' : `1/${fmtDecimal(g.oneIn, 2)}`}</td>
      case 'payout':
        return <td key={key} className="num">×{fmtPayout(Math.round(g.payout * 100) / 100)}</td>
      case 'weightedValue':
        return <td key={key} className="num">{fmtDecimal(g.weightedValue, 6)}</td>
      case 'rtpShare':
        return <td key={key} className="num">{g.rtpShare === null ? '—' : fmtPct(g.rtpShare, 2)}</td>
      case 'std':
        return <td key={key} className="num">{fmtDecimal(g.std, 2)}</td>
      default:
        return null
    }
  }

  return (
    <table className="gdist-table">
      <thead>
        <tr>
          <th>Group</th>
          {cols.map((c) => <th key={c.key} className="num">{c.label}</th>)}
        </tr>
      </thead>
      <tbody>
        {dist.map((g) => (
          <tr key={g.id}>
            <td>
              <span className="gdist-dot" style={{ background: g.color }} aria-hidden="true" />
              <span style={{ color: g.color }}>{g.name}</span>
              <span className="gdist-count"> · {g.count}</span>
            </td>
            {cols.map((c) => cell(g, c.key))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
```

CSS (`index.css`): `.gdist-table { border-collapse: collapse; font-variant-numeric: tabular-nums; width: 100%; } .gdist-table th, .gdist-table td { padding: 4px 12px; border-bottom: 1px solid var(--line); text-align: left; font-size: 12px; } .gdist-table .num { text-align: right; } .gdist-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }`

- [ ] **Step 7: Wire into App with collapse toggles**

In `App.tsx`:
- New view state: `const [groupDistCollapsed, setGroupDistCollapsed] = useState(saved?.groupDistCollapsed ?? false)`, `const [bucketsCollapsed, setBucketsCollapsed] = useState(saved?.bucketsCollapsed ?? false)`, `const [hiddenGroupColumns, setHiddenGroupColumns] = useState<string[]>(saved?.hiddenGroupColumns ?? [])` (the gear arrives in Task 2 — state lands now so persistence is complete). Add all three to the workspace snapshot object and the effect dep list.
- New section rendered directly above the `content-row` block:

```tsx
<section className="panel group-dist">
  <div className="panel-head">
    <button type="button" className="panel-collapse" aria-expanded={!groupDistCollapsed}
      onClick={() => setGroupDistCollapsed(!groupDistCollapsed)}
      title={groupDistCollapsed ? 'Show the group distribution' : 'Hide the group distribution'}>
      <span className="chev" aria-hidden="true">{groupDistCollapsed ? '▸' : '▾'}</span>
    </button>
    <h2>Group Distribution</h2>
  </div>
  {!groupDistCollapsed && (
    <GroupDistributionTable rows={viewRows} grouping={grouping} totalWeight={totalWeight} hidden={hiddenGroupColumns} />
  )}
</section>
```

- Buckets panel head gets the same `panel-collapse` button before its `<h2>`, guarding everything below the head (`GroupChips` + `BucketTable`) behind `{!bucketsCollapsed && (...)}`.
- CSS: `.panel-collapse { background: none; border: 0; color: var(--text-dim); cursor: pointer; padding: 2px 4px; } .panel-collapse:hover { color: var(--text); }` and `.panel-head h2 { margin-right: auto; }` so extras land right (adjust the existing `.panel.chart .panel-head .btn:first-of-type { margin-left:auto }` rule if it double-applies).

- [ ] **Step 8: storage fields** — In `storage.ts` `Workspace` add `groupDistCollapsed?: boolean`, `bucketsCollapsed?: boolean`, `hiddenGroupColumns?: string[]`; in `isWorkspace` add:

```ts
(v.groupDistCollapsed === undefined || typeof v.groupDistCollapsed === 'boolean') &&
(v.bucketsCollapsed === undefined || typeof v.bucketsCollapsed === 'boolean') &&
(v.hiddenGroupColumns === undefined ||
  (Array.isArray(v.hiddenGroupColumns) && v.hiddenGroupColumns.every((s) => typeof s === 'string'))) &&
```

Add a storage test: a workspace JSON carrying the three fields round-trips through `loadTabsState`.

- [ ] **Step 9: Run the full suite** — `npx vitest run` → PASS (fix any App smoke fallout: the smoke test may now also see the Group Distribution heading).

- [ ] **Step 10: Commit** — `git add -A; git commit -m "feat: group distribution panel with collapsible table panels"`

---

### Task 2: GearMenu, column visibility toggles, One in + RTP Share columns

**Files:**
- Create: `src/components/GearMenu.tsx`, `src/components/GearMenu.test.tsx`
- Modify: `src/lib/types.ts` (ColumnKey + 'oneIn' | 'rtpShare'), `src/lib/columns.ts` (two new COLUMNS entries + sort cases), `src/lib/tableRows.ts` (sort cases), `src/components/BucketTable.tsx` (visible-columns refactor), `src/components/GroupSummaryRow.tsx` (visible-columns + rtp prop), `src/App.tsx` (hiddenBucketColumns state + gear menus on both table panels), `src/lib/storage.ts` (`hiddenBucketColumns?: string[]`), `src/index.css` (`.gear-menu`, `.gear-pop`)
- Test: `src/components/BucketTable.test.tsx` (extend), `src/lib/columns.test.ts` (extend), `src/lib/exportTsv.test.ts` (export-invariance note test)

**Interfaces:**
- Consumes: `GROUP_DIST_COLUMNS` (Task 1), `COLUMNS`/`Column` from columns.ts.
- Produces:
  ```tsx
  // GearMenu.tsx — a ⚙ button opening a click-away popover
  export function GearMenu({ label, children }: { label: string; children: React.ReactNode }): JSX.Element
  ```
  `BucketTable` props gain `hidden: string[]` and `rtp` is computed internally as today. `GroupSummaryRow` props gain `visible: Column[]` and `rtp: number`.

- [ ] **Step 1: GearMenu with failing test**

`src/components/GearMenu.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { GearMenu } from './GearMenu'

describe('GearMenu', () => {
  it('opens on click, closes on outside pointerdown and Escape', () => {
    render(<div><GearMenu label="Table settings"><span>Inside</span></GearMenu><button>outside</button></div>)
    expect(screen.queryByText('Inside')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Table settings' }))
    expect(screen.getByText('Inside')).toBeTruthy()
    fireEvent.pointerDown(screen.getByText('outside'))
    expect(screen.queryByText('Inside')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Table settings' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByText('Inside')).toBeNull()
  })
})
```

Implementation:

```tsx
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

/** A ⚙ button opening a small click-away popover — column toggles, chart options. */
export function GearMenu({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="gear-menu" ref={ref}>
      <button type="button" className={`btn gear-btn ${open ? 'primary' : ''}`} aria-expanded={open}
        aria-label={label} title={label} onClick={() => setOpen((v) => !v)}>
        ⚙
      </button>
      {open && <div className="gear-pop">{children}</div>}
    </div>
  )
}
```

CSS: `.gear-menu { position: relative; margin-left: auto; } .gear-pop { position: absolute; right: 0; top: calc(100% + 4px); z-index: 30; background: var(--surface); border: 1px solid var(--line-strong); border-radius: 6px; padding: 8px 10px; min-width: 190px; display: flex; flex-direction: column; gap: 6px; box-shadow: 0 4px 16px rgba(0,0,0,.35); } .gear-pop .checkbox { font-size: 12px; }` (when the head already has `margin-left:auto` on another element, drop it from `.gear-menu` there).

- [ ] **Step 2: New columns in the model** — In `types.ts` extend `ColumnKey` with `'oneIn' | 'rtpShare'`. In `columns.ts` append after the chance entry:

```ts
{ key: 'oneIn', label: 'One in', sortable: true, numeric: true, width: 84 },
{ key: 'rtpShare', label: 'RTP Share', sortable: true, numeric: true, width: 92 },
```

In `sortRows` add cases: `'oneIn'` sorts with `'weight'`/`'chance'` (same comparator), `'rtpShare'` with `'weightedValue'`. Same two cases in `tableRows.ts` `sortUnits`. Extend `columns.test.ts`: sorting by `oneIn` equals sorting by weight; by `rtpShare` equals weightedValue.

- [ ] **Step 3: BucketTable visible-columns refactor (failing test first)**

Add to `BucketTable.test.tsx`:

```tsx
it('renders One in and RTP Share, and omits hidden columns', () => {
  // rows fixture as the existing tests build them; totalWeight 1000, one row weight 250 payout 2
  render(<BucketTable {...props} hidden={[]} />)
  expect(screen.getByText('One in')).toBeTruthy()
  expect(screen.getByText('RTP Share')).toBeTruthy()
  expect(screen.getByText('1/4')).toBeTruthy() // chance 0.25 → one in 4
  render(<BucketTable {...props} hidden={['weightId', 'oneIn']} />)
  expect(screen.queryByText('Weight ID')).toBeNull()
  expect(screen.queryByText('One in')).toBeNull()
})
```

Refactor `BucketTable.tsx`:
- Props gain `hidden: string[]`.
- `const visible = useMemo(() => COLUMNS.filter((c) => c.key === 'lock' || !hidden.includes(c.key)), [hidden])` — the lock column is the grid's keyboard anchor and is never hidden.
- Everything indexed by column becomes `visible`-relative: `useGridNavigation({ colCount: visible.length, isNumericCol: (c) => visible[c].numeric, isLockCol: (c) => visible[c].key === 'lock', ... })`; `clearCell`/`isEditable` read `visible[pos.col].key`; `colgroup`/`thead` map over `visible`.
- Body rows render through one switch:

```tsx
const renderBucketCell = (unit: Extract<TableRow, { kind: 'bucket' }>, rowIdx: number, c: Column, ci: number) => {
  const r = unit.row
  switch (c.key) {
    case 'lock': return <td key={c.key} className="col-lock"><LockCell state={r.locked ? 'all' : 'none'} selected={nav.sel.row === rowIdx && nav.sel.col === ci} onToggle={() => toggleLock(rowIdx)} onSelect={() => nav.select({ row: rowIdx, col: ci })} onKeyDown={nav.handleKeyDown} /></td>
    case 'group': return /* existing <select> td, keyed */
    case 'id': return /* existing GridCell with {...cellProps(rowIdx, ci)} */
    // ... weightId, payout, label, weight, weightedValue, chance — existing cells, indices replaced by ci
    case 'oneIn': {
      const ch = chanceOf(r)
      return <td key={c.key} className="col-oneIn"><GridCell {...cellProps(rowIdx, ci)} display={ch > 0 ? `1/${fmtDecimal(1 / ch, 2)}` : '—'} raw="" numeric editable={false} title="1 / chance — how many spins per hit of this bucket" /></td>
    }
    case 'rtpShare':
      return <td key={c.key} className="col-rtpShare"><GridCell {...cellProps(rowIdx, ci)} display={rtp > 0 ? fmtPct(valueOf(r) / rtp, 2) : '—'} raw="" numeric editable={false} title="This bucket's share of the table's RTP" /></td>
  }
}
```

- The totals row maps over `visible` the same way: `weight`/`weightedValue` keep their editable cells, `chance` shows `1`, `oneIn` shows `1/1`, `rtpShare` shows `100%`, everything else blank (label cell shows `Total`).
- `displayFor` gains `oneIn`/`rtpShare` cases (used by autoFit): same strings as above; for group units use `u.agg.chance` and `u.agg.value / rtp`.
- `GroupSummaryRow` takes `visible: Column[]` and `rtp: number`, maps over `visible` with its own switch (lock, group-expander, then read-only aggregate cells; `oneIn` from `agg.chance`, `rtpShare` from `agg.value / rtp`), replacing the nine hardcoded `<td>`s.
- `fmtPct` import is needed in both files.

- [ ] **Step 4: Run BucketTable + full table tests** — `npx vitest run src/components/BucketTable.test.tsx src/lib/columns.test.ts src/lib/tableRows.test.ts` → PASS.

- [ ] **Step 5: App wiring + persistence + gear menus**

- `App.tsx`: `const [hiddenBucketColumns, setHiddenBucketColumns] = useState<string[]>(saved?.hiddenBucketColumns ?? [])`, snapshot + deps, pass `hidden={hiddenBucketColumns}` to BucketTable.
- Buckets panel head gains `<GearMenu label="Buckets table columns">` listing every COLUMNS entry except `lock` as a checkbox:

```tsx
<GearMenu label="Buckets table columns">
  {COLUMNS.filter((c) => c.key !== 'lock').map((c) => (
    <label className="checkbox" key={c.key}>
      <input type="checkbox" checked={!hiddenBucketColumns.includes(c.key)}
        onChange={(e) => setHiddenBucketColumns(e.target.checked
          ? hiddenBucketColumns.filter((k) => k !== c.key)
          : [...hiddenBucketColumns, c.key])} />
      <span>{c.label}</span>
    </label>
  ))}
</GearMenu>
```

- Group Distribution panel head gains the same pattern over `GROUP_DIST_COLUMNS` writing `hiddenGroupColumns`.
- `storage.ts`: add `hiddenBucketColumns?: string[]` (same validation as hiddenGroupColumns).

- [ ] **Step 6: Export invariance test** — In `exportTsv.test.ts` add:

```ts
it('export is independent of table column visibility (columns are display-only)', () => {
  // buildTsv takes only rows + total; this test pins that contract so a future
  // refactor cannot thread column config into the export.
  const text = buildTsv(rows, total)
  expect(text.split('\r\n')[0]).toBe(EXPORT_HEADER)
})
```

- [ ] **Step 7: Run all, commit** — `npx vitest run` → PASS. `git add -A; git commit -m "feat: column visibility toggles and One in / RTP Share columns"`

---

### Task 3: Usage-hint tooltips on panel titles, remove Group sort button

**Files:**
- Modify: `src/App.tsx`, `src/index.css` (`.panel-head h2[title]` style), `src/App.test.tsx`

- [ ] **Step 1: Failing smoke assertions** — In `App.test.tsx` add: after loading sample data, `expect(screen.queryByRole('button', { name: /group sort/i })).toBeNull()` and `expect(screen.getByRole('heading', { name: 'Buckets' }).getAttribute('title')).toContain('arrow keys')`. Run → FAIL.

- [ ] **Step 2: Implement** — In `App.tsx`:
  - Delete the Group sort button from the buckets panel head (`handleSort` stays — the column header uses it).
  - Delete the `.panel-hint` spans from the buckets and simulation panel heads and the trailing hint in `DistributionChart`'s `chart-controls` row (`drag a bar or a group handle…`).
  - Set `title` on each heading:
    - Buckets `<h2 title="arrow keys to move · type +500 to add · shift+click selects rows · drag a header edge to resize · double-click an edge to fit · Space toggles a lock · Ctrl+Z / Ctrl+Shift+Z undo and redo">Buckets</h2>`
    - Distribution `<h2 title="drag a bar or group handle to reshape · right-click a bar for an exact value · shift+click selects several · scroll an axis to zoom · middle-drag pans · ⚙ for axis and drag options">Distribution</h2>`
    - Group Distribution `<h2 title="per-group chance, payout and RTP share — hover Chance for full precision · ⚙ chooses columns">Group Distribution</h2>`
    - Simulation `<h2 title="spins the current table with a fast Monte Carlo run — edits during a run don't change it">Simulation</h2>`
  - CSS: `.panel-head h2[title] { text-decoration: underline dotted var(--text-faint); text-underline-offset: 3px; cursor: help; }`

- [ ] **Step 3: Run all, commit** — `npx vitest run` → PASS. `git add -A; git commit -m "feat: usage hints as title tooltips, drop redundant Group sort button"`

---

### Task 4: Chart gear menu, X order/labels, diagonal tick labels

**Files:**
- Modify: `src/lib/types.ts` (ChartSettings `xOrder`, `xLabels`), `src/lib/storage.ts` (isChart), `src/lib/bars.ts` (+ group ordering), `src/lib/bars.test.ts`, `src/components/DistributionChart.tsx`, `src/components/DistributionChart.test.tsx`, `src/App.tsx` (gear menu in chart panel head), `src/index.css`

**Interfaces:**
- `ChartSettings` gains `xOrder: 'payout' | 'group'` and `xLabels: 'payout' | 'label'`; `DEFAULT_CHART` sets `xOrder: 'payout', xLabels: 'payout'`.
- `BuildBarsOptions` gains `xOrder: 'payout' | 'group'`; when `'group'` and `logX` is false, bars sort by `(min group rank of members, then payout)`.

- [ ] **Step 1: Failing bars test**

```ts
it('orders bars by group rank then payout when xOrder is group', () => {
  // two groups: g1 holds payouts 5 and 100, g2 holds payout 10
  const { bars } = buildBars(rows, grouping, total, { aggregate: false, groupBars: [], logX: false, xOrder: 'group' })
  expect(bars.map((b) => b.payout)).toEqual([5, 100, 10])
})
it('ignores xOrder under logX (positions are payout-derived)', () => {
  const { bars } = buildBars(rows, grouping, total, { aggregate: false, groupBars: [], logX: true, xOrder: 'group' })
  expect(bars.map((b) => b.payout)).toEqual([5, 10, 100])
})
```

- [ ] **Step 2: Implement in bars.ts** — add `xOrder` to `BuildBarsOptions` (default `'payout'` via `opts.xOrder ?? 'payout'` so existing callers/tests compile). Replace the final sort:

```ts
const groupRankOf = (b: ChartBar) => Math.min(...b.uids.map((u) => grouping.rank.get(u) ?? Number.MAX_SAFE_INTEGER))
if (opts.xOrder === 'group' && !opts.logX) {
  bars.sort((a, b) => groupRankOf(a) - groupRankOf(b) || a.payout - b.payout)
} else {
  bars.sort((a, b) => a.payout - b.payout)
}
```

Run bars tests → PASS.

- [ ] **Step 3: ChartSettings + storage** — types.ts: add the two fields + defaults. storage.ts `isChart`: `(v.xOrder === undefined || v.xOrder === 'payout' || v.xOrder === 'group') && (v.xLabels === undefined || v.xLabels === 'payout' || v.xLabels === 'label') &&`. App already merges `{ ...DEFAULT_CHART, ...saved.chart }` so old workspaces default cleanly.

- [ ] **Step 4: DistributionChart changes (test first)**

Add to `DistributionChart.test.tsx`:

```tsx
it('rotates x tick labels and can label by bucket name', () => {
  render(<DistributionChart {...props} chart={{ ...DEFAULT_CHART, xLabels: 'label' }} />)
  const tick = document.querySelector('text.axis-label.diag')!
  expect(tick.getAttribute('transform')).toContain('rotate(-45')
  expect(tick.textContent).toBe(rows[0].label)
})
```

Implement:
- `buildBars(..., { aggregate, groupBars, logX, xOrder })` from `chart.xOrder`.
- `MARGIN.bottom` 46 → 68; the tick `<text>` becomes:

```tsx
<text key={i} className="axis-label diag" x={centres[i]} y={height - MARGIN.bottom + 14}
  transform={`rotate(-45 ${centres[i]} ${height - MARGIN.bottom + 14})`} textAnchor="end">
  {tickLabel(b)}
</text>
```

with

```tsx
const tickLabel = (b: ChartBar) =>
  b.kind === 'group' ? b.name
  : chart.xLabels === 'label'
    ? (b.labels.length === 1 ? b.labels[0] : `${b.labels.length} × ${fmtPayout(b.payout)}`)
    : `×${fmtPayout(b.payout)}`
```

- `labelEvery` divisor 62 → 16 (diagonal pitch): `Math.floor(plotW / 16)`.
- Move the axis-title text to `y={height - 6}` and the x scrollbar to `y={height - MARGIN.bottom + 44}`; `ChartXAxisZoom` keeps `y={height - MARGIN.bottom}` `height={MARGIN.bottom}`.
- Remove the **Log Y** and **Relative drag** checkboxes from the `chart-controls` row (Log X, Aggregate, metric seg, Reset view stay).
- CSS: `.axis-label.diag { font-size: 10px; }`

- [ ] **Step 5: Gear menu in the chart panel head (App.tsx)** — inside `chartSection`'s panel-head, replacing the Swap sides/Stack below area is Task 5; for now add after the h2:

```tsx
<GearMenu label="Distribution chart settings">
  <label className="checkbox"><input type="checkbox" checked={chart.logY} onChange={(e) => setChart({ ...chart, logY: e.target.checked })} /><span>Log Y</span></label>
  <label className="checkbox" title="On: dragging a bar keeps the total weight — other unlocked buckets compensate.">
    <input type="checkbox" checked={chart.relative} disabled={chart.metric === 'chance'} onChange={(e) => setChart({ ...chart, relative: e.target.checked })} /><span>Relative drag</span>
  </label>
  <div className="gear-group">
    <span className="gear-group-label">X order</span>
    <label className="checkbox"><input type="radio" name="xorder" checked={chart.xOrder === 'payout'} onChange={() => setChart({ ...chart, xOrder: 'payout' })} /><span>payout</span></label>
    <label className="checkbox" title={chart.logX ? 'Log X positions bars by payout — switch it off to order by group' : undefined}>
      <input type="radio" name="xorder" disabled={chart.logX} checked={chart.xOrder === 'group'} onChange={() => setChart({ ...chart, xOrder: 'group' })} /><span>group</span>
    </label>
  </div>
  <div className="gear-group">
    <span className="gear-group-label">X labels</span>
    <label className="checkbox"><input type="radio" name="xlabels" checked={chart.xLabels === 'payout'} onChange={() => setChart({ ...chart, xLabels: 'payout' })} /><span>payout</span></label>
    <label className="checkbox"><input type="radio" name="xlabels" checked={chart.xLabels === 'label'} onChange={() => setChart({ ...chart, xLabels: 'label' })} /><span>bucket label</span></label>
  </div>
</GearMenu>
```

CSS: `.gear-group { display: flex; flex-direction: column; gap: 4px; border-top: 1px solid var(--line); padding-top: 6px; } .gear-group-label { font-size: 11px; color: var(--text-dim); }`

- [ ] **Step 6: Run all, commit** — `npx vitest run` → PASS. `git add -A; git commit -m "feat: chart gear menu, group x-order, bucket-label ticks, diagonal labels"`

---

### Task 5: Dock layout — drag panels, resize widths, persist

**Files:**
- Create: `src/lib/layout.ts`, `src/lib/layout.test.ts`, `src/components/PanelDock.tsx`, `src/components/PanelDock.test.tsx`
- Modify: `src/App.tsx` (layout state, PanelDock replaces the content-row block + groupDist section; Swap sides/Stack below buttons removed), `src/lib/types.ts` (ChartSettings loses `swapped`/`forceStack` from the type and DEFAULT_CHART), `src/lib/storage.ts` (`layout?: DockLayout`; isChart keeps accepting the two legacy booleans), `src/index.css` (`.dock-row`, `.dock-divider`, drop-indicator, sticky rules replacing `.content-row` rules), `src/App.test.tsx`

**Interfaces (produced by layout.ts):**

```ts
export type PanelId = 'groupDist' | 'buckets' | 'chart'
export interface DockPanel { id: PanelId; size: number }        // size: fraction of row, per-row sum = 1
export interface DockLayout { rows: { panels: DockPanel[] }[] }
export const MIN_SIZE = 0.15
export const DEFAULT_LAYOUT: DockLayout
export type DropTarget = { kind: 'beside'; row: number; index: number } | { kind: 'row'; index: number }
export function isDockLayout(v: unknown): v is DockLayout       // each PanelId exactly once, finite positive sizes
export function normalizeLayout(l: DockLayout): DockLayout      // drop empty rows, renormalize sizes, clamp to MIN_SIZE
export function movePanel(l: DockLayout, id: PanelId, target: DropTarget): DockLayout // target computed against l; no-op moves return an equal layout
export function resizePanels(l: DockLayout, row: number, index: number, delta: number): DockLayout // shift boundary between panels[index] and [index+1] by delta (fraction), clamped
export function migrateLayout(chart?: { swapped?: boolean; forceStack?: boolean }): DockLayout
```

- [ ] **Step 1: Failing layout lib tests**

`src/lib/layout.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_LAYOUT, isDockLayout, migrateLayout, movePanel, normalizeLayout, resizePanels } from './layout'

const ids = (l: ReturnType<typeof normalizeLayout>) => l.rows.map((r) => r.panels.map((p) => p.id))

describe('layout', () => {
  it('default is groupDist above buckets+chart', () => {
    expect(ids(DEFAULT_LAYOUT)).toEqual([['groupDist'], ['buckets', 'chart']])
  })
  it('validates: every panel exactly once', () => {
    expect(isDockLayout(DEFAULT_LAYOUT)).toBe(true)
    expect(isDockLayout({ rows: [{ panels: [{ id: 'buckets', size: 1 }] }] })).toBe(false)
    expect(isDockLayout({ rows: [{ panels: [{ id: 'buckets', size: 1 }, { id: 'buckets', size: 1 }, { id: 'chart', size: 1 }] }] })).toBe(false)
  })
  it('moves a panel beside another', () => {
    const next = movePanel(DEFAULT_LAYOUT, 'groupDist', { kind: 'beside', row: 1, index: 2 })
    expect(ids(next)).toEqual([['buckets', 'chart', 'groupDist']])
    expect(next.rows[0].panels.reduce((a, p) => a + p.size, 0)).toBeCloseTo(1, 9)
  })
  it('moves a panel into its own new row, dropping its empty source row', () => {
    const one = movePanel(DEFAULT_LAYOUT, 'groupDist', { kind: 'beside', row: 1, index: 0 })
    const next = movePanel(one, 'chart', { kind: 'row', index: 1 })
    expect(ids(next)).toEqual([['groupDist', 'buckets'], ['chart']])
  })
  it('a move onto its own position is identity', () => {
    const next = movePanel(DEFAULT_LAYOUT, 'buckets', { kind: 'beside', row: 1, index: 0 })
    expect(ids(next)).toEqual(ids(DEFAULT_LAYOUT))
  })
  it('resize shifts the shared boundary and respects MIN_SIZE', () => {
    const next = resizePanels(DEFAULT_LAYOUT, 1, 0, 0.2)
    expect(next.rows[1].panels[0].size).toBeCloseTo(0.7, 9)
    const clamped = resizePanels(DEFAULT_LAYOUT, 1, 0, -10)
    expect(clamped.rows[1].panels[0].size).toBeCloseTo(0.15, 9)
  })
  it('migrates legacy chart flags', () => {
    expect(ids(migrateLayout({ swapped: true }))).toEqual([['groupDist'], ['chart', 'buckets']])
    expect(ids(migrateLayout({ forceStack: true }))).toEqual([['groupDist'], ['buckets'], ['chart']])
    expect(ids(migrateLayout(undefined))).toEqual([['groupDist'], ['buckets', 'chart']])
  })
})
```

- [ ] **Step 2: Implement `src/lib/layout.ts`**

```ts
/** The dock: ordered rows of 1–3 panels. Sizes are fractions of the row. */
export type PanelId = 'groupDist' | 'buckets' | 'chart'
export interface DockPanel { id: PanelId; size: number }
export interface DockLayout { rows: { panels: DockPanel[] }[] }

export const PANEL_IDS: PanelId[] = ['groupDist', 'buckets', 'chart']
export const MIN_SIZE = 0.15

export const DEFAULT_LAYOUT: DockLayout = {
  rows: [
    { panels: [{ id: 'groupDist', size: 1 }] },
    { panels: [{ id: 'buckets', size: 0.5 }, { id: 'chart', size: 0.5 }] },
  ],
}

export type DropTarget =
  | { kind: 'beside'; row: number; index: number }
  | { kind: 'row'; index: number }

export function isDockLayout(v: unknown): v is DockLayout {
  if (typeof v !== 'object' || v === null || !Array.isArray((v as DockLayout).rows)) return false
  const seen = new Set<string>()
  for (const row of (v as DockLayout).rows) {
    if (typeof row !== 'object' || row === null || !Array.isArray(row.panels) || row.panels.length === 0) return false
    for (const p of row.panels) {
      if (typeof p !== 'object' || p === null) return false
      if (!(PANEL_IDS as string[]).includes(p.id) || seen.has(p.id)) return false
      if (typeof p.size !== 'number' || !Number.isFinite(p.size) || p.size <= 0) return false
      seen.add(p.id)
    }
  }
  return seen.size === PANEL_IDS.length
}

export function normalizeLayout(l: DockLayout): DockLayout {
  const rows = l.rows
    .filter((r) => r.panels.length > 0)
    .map((r) => {
      const sum = r.panels.reduce((a, p) => a + Math.max(MIN_SIZE, p.size), 0)
      return { panels: r.panels.map((p) => ({ ...p, size: Math.max(MIN_SIZE, p.size) / sum })) }
    })
  return { rows }
}

export function movePanel(l: DockLayout, id: PanelId, target: DropTarget): DockLayout {
  // Remove the panel, tracking how removal shifts the target's coordinates —
  // the caller computed them against the un-removed layout.
  const srcRow = l.rows.findIndex((r) => r.panels.some((p) => p.id === id))
  if (srcRow === -1) return l
  const srcIndex = l.rows[srcRow].panels.findIndex((p) => p.id === id)
  const rows = l.rows.map((r) => ({ panels: r.panels.filter((p) => p.id !== id) }))
  const emptied = rows[srcRow].panels.length === 0

  if (target.kind === 'beside') {
    let { row, index } = target
    if (row === srcRow && index > srcIndex) index -= 1
    if (emptied && row === srcRow) {
      // Dropping beside the only panel of its own row is a no-op.
      return normalizeLayout(l)
    }
    if (emptied && row > srcRow) row -= 1
    const kept = rows.filter((_, i) => !(emptied && i === srcRow))
    const dest = kept[row]
    if (dest === undefined) return normalizeLayout(l)
    dest.panels.splice(Math.min(index, dest.panels.length), 0, { id, size: 1 / (dest.panels.length + 1) })
    return normalizeLayout({ rows: kept })
  }

  let at = target.index
  if (emptied && at > srcRow) at -= 1
  const kept = rows.filter((_, i) => !(emptied && i === srcRow))
  // A panel already alone in a row dropped back next to itself is a no-op.
  if (emptied && at === srcRow) return normalizeLayout(l)
  kept.splice(Math.min(at, kept.length), 0, { panels: [{ id, size: 1 }] })
  return normalizeLayout({ rows: kept })
}

export function resizePanels(l: DockLayout, row: number, index: number, delta: number): DockLayout {
  const r = l.rows[row]
  if (r === undefined || r.panels[index] === undefined || r.panels[index + 1] === undefined) return l
  const a = r.panels[index].size
  const b = r.panels[index + 1].size
  const d = Math.max(MIN_SIZE - a, Math.min(delta, b - MIN_SIZE))
  const rows = l.rows.map((rr, i) =>
    i !== row
      ? rr
      : { panels: rr.panels.map((p, j) => (j === index ? { ...p, size: a + d } : j === index + 1 ? { ...p, size: b - d } : p)) },
  )
  return { rows }
}

/** A workspace saved before the dock existed derives its layout from the old chart flags. */
export function migrateLayout(chart?: { swapped?: boolean; forceStack?: boolean }): DockLayout {
  if (chart?.forceStack === true) {
    return { rows: [{ panels: [{ id: 'groupDist', size: 1 }] }, { panels: [{ id: 'buckets', size: 1 }] }, { panels: [{ id: 'chart', size: 1 }] }] }
  }
  if (chart?.swapped === true) {
    return { rows: [{ panels: [{ id: 'groupDist', size: 1 }] }, { panels: [{ id: 'chart', size: 0.5 }, { id: 'buckets', size: 0.5 }] }] }
  }
  return DEFAULT_LAYOUT
}
```

Run `npx vitest run src/lib/layout.test.ts` → PASS. (The `movePanel` no-op cases are subtle; if a test fails, fix the index arithmetic, not the test.)

- [ ] **Step 3: PanelDock component (failing test first)**

`src/components/PanelDock.test.tsx` — jsdom has no real geometry, so mock `getBoundingClientRect` on rows/panels:

```tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PanelDock } from './PanelDock'
import { DEFAULT_LAYOUT } from '../lib/layout'

const defs = {
  groupDist: { title: 'Group Distribution', hint: 'h', children: <div>GD</div> },
  buckets: { title: 'Buckets', hint: 'h', children: <div>BK</div> },
  chart: { title: 'Distribution', hint: 'h', children: <div>CH</div> },
}

describe('PanelDock', () => {
  it('renders rows and panels per layout with width styles', () => {
    render(<PanelDock layout={DEFAULT_LAYOUT} onLayout={() => {}} panels={defs} />)
    expect(document.querySelectorAll('.dock-row').length).toBe(2)
    expect(document.querySelectorAll('.dock-divider').length).toBe(1)
    expect(screen.getByText('BK')).toBeTruthy()
  })
  it('divider drag calls onLayout with resized fractions', () => {
    const onLayout = vi.fn()
    render(<PanelDock layout={DEFAULT_LAYOUT} onLayout={onLayout} panels={defs} />)
    const divider = document.querySelector('.dock-divider')!
    const rowEl = document.querySelectorAll('.dock-row')[1] as HTMLElement
    vi.spyOn(rowEl, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 1000, width: 1000, top: 0, bottom: 400, height: 400, x: 0, y: 0, toJSON: () => ({}) } as DOMRect)
    fireEvent.pointerDown(divider, { clientX: 500, button: 0, pointerId: 1 })
    fireEvent.pointerMove(divider, { clientX: 600, pointerId: 1 })
    fireEvent.pointerUp(divider, { pointerId: 1 })
    const arg = onLayout.mock.calls.at(-1)![0]
    expect(arg.rows[1].panels[0].size).toBeCloseTo(0.6, 6)
  })
  it('header drag commits a movePanel via onLayout', () => {
    const onLayout = vi.fn()
    render(<PanelDock layout={DEFAULT_LAYOUT} onLayout={onLayout} panels={defs} />)
    const rowEls = document.querySelectorAll('.dock-row')
    const rects = [
      { left: 0, right: 1000, top: 0, bottom: 100 },
      { left: 0, right: 1000, top: 110, bottom: 500 },
    ]
    rowEls.forEach((el, i) => vi.spyOn(el as HTMLElement, 'getBoundingClientRect').mockReturnValue({ ...rects[i], width: 1000, height: rects[i].bottom - rects[i].top, x: rects[i].left, y: rects[i].top, toJSON: () => ({}) } as DOMRect))
    const panelEls = document.querySelectorAll('.dock-panel')
    const prects = [
      { left: 0, right: 1000, top: 0, bottom: 100 },   // groupDist
      { left: 0, right: 500, top: 110, bottom: 500 },  // buckets
      { left: 500, right: 1000, top: 110, bottom: 500 }, // chart
    ]
    panelEls.forEach((el, i) => vi.spyOn(el as HTMLElement, 'getBoundingClientRect').mockReturnValue({ ...prects[i], width: prects[i].right - prects[i].left, height: prects[i].bottom - prects[i].top, x: prects[i].left, y: prects[i].top, toJSON: () => ({}) } as DOMRect))

    const head = document.querySelectorAll('.dock-panel .panel-head')[0] // groupDist's head
    fireEvent.pointerDown(head, { clientX: 50, clientY: 50, button: 0, pointerId: 2 })
    // past the threshold, into the middle of the chart panel's right half → beside chart, index 2
    fireEvent.pointerMove(head, { clientX: 900, clientY: 300, pointerId: 2 })
    fireEvent.pointerUp(head, { pointerId: 2 })
    const arg = onLayout.mock.calls.at(-1)![0]
    expect(arg.rows.map((r: { panels: { id: string }[] }) => r.panels.map((p) => p.id))).toEqual([['buckets', 'chart', 'groupDist']])
  })
})
```

- [ ] **Step 4: Implement `src/components/PanelDock.tsx`**

```tsx
import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { DockLayout, DropTarget, PanelId } from '../lib/layout'
import { movePanel, resizePanels } from '../lib/layout'

export interface DockPanelDef {
  title: string
  /** Usage hint shown as the title tooltip on the heading. */
  hint: string
  /** Right-aligned head content: gear menus, extra buttons. */
  headExtra?: ReactNode
  collapsed?: boolean
  onCollapsed?: (c: boolean) => void
  children: ReactNode
}

interface PanelDockProps {
  layout: DockLayout
  onLayout: (l: DockLayout) => void
  panels: Record<PanelId, DockPanelDef>
}

const DRAG_THRESHOLD = 6

interface RowRect { top: number; bottom: number; left: number; right: number }
interface PanelRect { row: number; index: number; left: number; right: number }

export function PanelDock({ layout, onLayout, panels }: PanelDockProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [dragId, setDragId] = useState<PanelId | null>(null)
  const [target, setTarget] = useState<DropTarget | null>(null)
  const drag = useRef<{ id: PanelId; startX: number; startY: number; live: boolean; rows: RowRect[]; panels: PanelRect[] } | null>(null)
  const resize = useRef<{ row: number; index: number; startX: number; rowWidth: number; base: DockLayout } | null>(null)

  const measure = () => {
    const root = rootRef.current
    const rows: RowRect[] = []
    const prects: PanelRect[] = []
    if (root === null) return { rows, panels: prects }
    root.querySelectorAll<HTMLElement>('.dock-row').forEach((rowEl, r) => {
      const rect = rowEl.getBoundingClientRect()
      rows.push({ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right })
      rowEl.querySelectorAll<HTMLElement>(':scope > .dock-panel').forEach((pEl, i) => {
        const pr = pEl.getBoundingClientRect()
        prects.push({ row: r, index: i, left: pr.left, right: pr.right })
      })
    })
    return { rows, panels: prects }
  }

  /** The drop this pointer position means: a new row in a row's outer fifths, beside a panel elsewhere. */
  const targetAt = (x: number, y: number, rows: RowRect[], prects: PanelRect[]): DropTarget | null => {
    if (rows.length === 0) return null
    if (y < rows[0].top) return { kind: 'row', index: 0 }
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r]
      if (y > row.bottom) continue
      const h = Math.max(1, row.bottom - row.top)
      if (y < row.top + h * 0.2) return { kind: 'row', index: r }
      if (y > row.bottom - h * 0.2) return { kind: 'row', index: r + 1 }
      const inRow = prects.filter((p) => p.row === r)
      for (const p of inRow) if (x <= (p.left + p.right) / 2) return { kind: 'beside', row: r, index: p.index }
      return { kind: 'beside', row: r, index: inRow.length }
    }
    return { kind: 'row', index: rows.length }
  }

  const onHeadPointerDown = (e: React.PointerEvent, id: PanelId) => {
    if (e.button !== 0) return
    // Buttons, inputs and menus in the head keep their own clicks.
    if ((e.target as HTMLElement).closest('button, input, select, label, a')) return
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    drag.current = { id, startX: e.clientX, startY: e.clientY, live: false, ...measure() }
  }

  const onHeadPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (d === null) return
    if (!d.live) {
      if (Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) < DRAG_THRESHOLD) return
      d.live = true
      setDragId(d.id)
    }
    setTarget(targetAt(e.clientX, e.clientY, d.rows, d.panels))
  }

  const onHeadPointerUp = () => {
    const d = drag.current
    drag.current = null
    setDragId(null)
    const t = target
    setTarget(null)
    if (d === null || !d.live || t === null) return
    onLayout(movePanel(layout, d.id, t))
  }

  const onDividerDown = (e: React.PointerEvent, row: number, index: number) => {
    if (e.button !== 0) return
    e.preventDefault()
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    const rowEl = rootRef.current?.querySelectorAll<HTMLElement>('.dock-row')[row]
    const width = rowEl?.getBoundingClientRect().width ?? 1
    resize.current = { row, index, startX: e.clientX, rowWidth: Math.max(1, width), base: layout }
  }

  const onDividerMove = (e: React.PointerEvent) => {
    const s = resize.current
    if (s === null) return
    onLayout(resizePanels(s.base, s.row, s.index, (e.clientX - s.startX) / s.rowWidth))
  }

  const onDividerUp = () => {
    resize.current = null
  }

  return (
    <div className="dock" ref={rootRef}>
      {layout.rows.map((row, r) => {
        const hasBuckets = row.panels.some((p) => p.id === 'buckets')
        return (
          <div className="dock-row" key={row.panels.map((p) => p.id).join('+')}>
            {row.panels.map((p, i) => {
              const def = panels[p.id]
              // Sticky is only useful (and safe) beside the tall buckets table.
              const sticky = p.id === 'chart' && hasBuckets && row.panels.length > 1
              return (
                <div key={p.id} className={`dock-cell ${dragId === p.id ? 'dragging' : ''}`} style={{ flexGrow: p.size, flexBasis: 0 }}>
                  {i > 0 && (
                    <div className="dock-divider" role="separator" aria-orientation="vertical"
                      title="Drag to resize"
                      onPointerDown={(e) => onDividerDown(e, r, i - 1)}
                      onPointerMove={onDividerMove}
                      onPointerUp={onDividerUp}
                      onPointerCancel={onDividerUp} />
                  )}
                  <section className={`panel dock-panel ${p.id === 'groupDist' ? 'group-dist' : p.id} ${sticky ? 'dock-sticky' : ''}`}>
                    <div className="panel-head dock-head"
                      onPointerDown={(e) => onHeadPointerDown(e, p.id)}
                      onPointerMove={onHeadPointerMove}
                      onPointerUp={onHeadPointerUp}
                      onPointerCancel={onHeadPointerUp}>
                      {def.onCollapsed !== undefined && (
                        <button type="button" className="panel-collapse" aria-expanded={!def.collapsed}
                          onClick={() => def.onCollapsed?.(!def.collapsed)}
                          title={def.collapsed ? `Show ${def.title}` : `Hide ${def.title}`}>
                          <span className="chev" aria-hidden="true">{def.collapsed ? '▸' : '▾'}</span>
                        </button>
                      )}
                      <h2 title={def.hint}>{def.title}</h2>
                      {def.headExtra}
                    </div>
                    {!def.collapsed && def.children}
                  </section>
                </div>
              )
            })}
          </div>
        )
      })}
      {/* drop indicator — positioned from the drag session's cached rects */}
      {dragId !== null && target !== null && <DropIndicator target={target} rootRef={rootRef} />}
    </div>
  )
}

function DropIndicator({ target, rootRef }: { target: DropTarget; rootRef: React.RefObject<HTMLDivElement | null> }) {
  const root = rootRef.current
  if (root === null) return null
  const rows = [...root.querySelectorAll<HTMLElement>('.dock-row')].map((el) => el.getBoundingClientRect())
  const rootRect = root.getBoundingClientRect()
  if (rows.length === 0) return null
  if (target.kind === 'row') {
    const y = target.index >= rows.length ? rows[rows.length - 1].bottom : rows[target.index].top
    return <div className="dock-drop-row" style={{ top: y - rootRect.top - 2 }} />
  }
  const rowEl = root.querySelectorAll<HTMLElement>('.dock-row')[target.row]
  if (rowEl === undefined) return null
  const cells = [...rowEl.querySelectorAll<HTMLElement>(':scope > .dock-cell')].map((el) => el.getBoundingClientRect())
  const rowRect = rows[target.row]
  const x = target.index >= cells.length ? rowRect.right : cells[target.index].left
  return <div className="dock-drop-beside" style={{ left: x - rootRect.left - 2, top: rowRect.top - rootRect.top, height: rowRect.bottom - rowRect.top }} />
}
```

CSS additions (replacing the `.content-row` block; keep `.grid-table` alignment simple — always `margin: 0 auto`):

```css
.dock { position: relative; display: flex; flex-direction: column; gap: 16px; }
.dock-row { display: flex; gap: 0; align-items: flex-start; }
.dock-cell { display: flex; align-items: stretch; min-width: 0; }
.dock-cell > .dock-panel { flex: 1 1 auto; min-width: 0; }
.dock-cell.dragging { opacity: 0.55; }
.dock-divider { flex: 0 0 10px; cursor: col-resize; align-self: stretch; position: relative; }
.dock-divider::after { content: ''; position: absolute; left: 4px; top: 0; bottom: 0; width: 2px; background: var(--line); }
.dock-divider:hover::after { background: var(--accent, #7aa2f7); }
.dock-head { cursor: grab; user-select: none; touch-action: none; }
.dock-panel.dock-sticky { position: sticky; top: calc(var(--targets-h, 0px) + 8px); }
.dock-drop-row { position: absolute; left: 0; right: 0; height: 4px; background: var(--accent, #7aa2f7); border-radius: 2px; z-index: 40; pointer-events: none; }
.dock-drop-beside { position: absolute; width: 4px; background: var(--accent, #7aa2f7); border-radius: 2px; z-index: 40; pointer-events: none; }
@media (max-width: 1200px) { .dock-row { flex-wrap: wrap; } .dock-cell { flex-basis: 100% !important; } .dock-divider { display: none; } .dock-panel.dock-sticky { position: static; } }
```

The buckets panel needs `min-width: min-content` dropped in the dock (the cell clamps with `min-width: 0` and the table overflows horizontally inside if squeezed — add `.dock-panel.buckets .grid-wrap { overflow-x: auto; }`).

- [ ] **Step 5: App integration**

- State: `const [layout, setLayout] = useState<DockLayout>(() => saved?.layout !== undefined && isDockLayout(saved.layout) ? normalizeLayout(saved.layout) : migrateLayout(saved?.chart as { swapped?: boolean; forceStack?: boolean } | undefined))` — snapshot + deps.
- `types.ts`: remove `swapped`/`forceStack` from `ChartSettings` and `DEFAULT_CHART`; `storage.ts` `isChart` keeps the two optional boolean checks (they exist on disk); add `layout?: DockLayout` to Workspace with `(v.layout === undefined || isDockLayout(v.layout))`.
- Replace the `content-row` IIFE and the Task-1 groupDist section with:

```tsx
<PanelDock
  layout={layout}
  onLayout={setLayout}
  panels={{
    groupDist: { title: 'Group Distribution', hint: GROUP_DIST_HINT, collapsed: groupDistCollapsed, onCollapsed: setGroupDistCollapsed, headExtra: groupDistGear, children: <GroupDistributionTable ... /> },
    buckets: { title: 'Buckets', hint: BUCKETS_HINT, collapsed: bucketsCollapsed, onCollapsed: setBucketsCollapsed, headExtra: bucketsGear, children: <>{groupChips}{bucketTable}</> },
    chart: { title: 'Distribution', hint: CHART_HINT, headExtra: chartGear, children: <>{distributionChart}</> },
  }}
/>
```

(the hint strings are the Task-3 tooltips, hoisted to constants; the gear nodes are the Task-2/4 `GearMenu`s.)
- Delete the Swap sides / Stack below buttons and all `chart.swapped` / `chart.forceStack` reads.
- Adapt the measurement callback (`rowRef` → attach to the dock root via a wrapper div ref): `stacked` is now derived, not measured — `const chartRow = layout.rows.find((r) => r.panels.some((p) => p.id === 'chart'))`; `const chartBesideBuckets = chartRow !== undefined && chartRow.panels.length > 1 && chartRow.panels.some((p) => p.id === 'buckets')`. The chart auto-fits to the buckets table height only when `chartBesideBuckets && !bucketsCollapsed`; the ResizeObserver logic keeps querying `.panel.buckets` / `svg[aria-label="Bucket distribution"]` inside the dock root and stays otherwise unchanged. When not beside the table, `effectiveChartHeight` falls back to `chartHeight`.
- Remove the now-dead `.content-row` CSS rules (`.content-row`, `.swapped`, `.stacked`, `.force-stack` variants) and the `.grid-table` margin rules (use `margin: 0 auto`).

- [ ] **Step 6: Update App smoke test** — assertions that Swap sides / Stack below are gone; the three dock panels render; `screen.getByRole('heading', { name: 'Distribution' })` exists once.

- [ ] **Step 7: Run all, commit** — `npx vitest run` → PASS. `git add -A; git commit -m "feat: drag-and-drop dock layout for table, chart and group panels"`

---

### Task 6: History 100, top-bar Settings, drag-reorder priority

**Files:**
- Modify: `src/lib/history.ts` (+ test), `src/components/TargetsPanel.tsx` (+ test), `src/App.tsx`, `src/components/SettingsPanel.tsx`, `src/index.css`, `README.md` keyboard table row (`Ctrl+Z / Ctrl+Y | undo / redo (100 steps)`)

- [ ] **Step 1: History limit (test first)** — In `history.test.ts` add:

```ts
it('keeps 100 steps', () => {
  let h = emptyHistory<number>()
  for (let i = 0; i < 150; i++) h = pushHistory(h, i)
  expect(h.past.length).toBe(100)
  expect(h.past[0]).toBe(50)
})
```

Run → FAIL. Change `HISTORY_LIMIT` to 100. Run → PASS.

- [ ] **Step 2: Remove Undo/Redo buttons** — In `TargetsPanel.tsx` delete the `btn-row` with Undo/Redo from `actions`, and drop the `canUndo/canRedo/onUndo/onRedo` props (and their App call-site args; `doUndo`/`doRedo` stay for the keyboard handler). Also remove the `⚙ Settings` button from `actions` here — it moves to the top bar next step. Update `TargetsPanel.test.tsx` accordingly (no Undo button; no Settings button in the panel).

- [ ] **Step 3: Settings in the top bar** — In `App.tsx` add to `topbar-actions`, before `Clear workspace` (only when `hasRows`):

```tsx
<button type="button" className={`btn ${settingsOpen ? 'primary' : ''}`} aria-expanded={settingsOpen}
  onClick={() => setSettingsOpen((v) => !v)} title="Bucket groups, solver priority order and weight step">
  ⚙ Settings
</button>
```

App smoke test: the Settings button lives in the top bar and still opens the drawer.

- [ ] **Step 4: Drag-reorder priority (test first)** — In a new `SettingsPanel.test.tsx` (or extend if one exists — there is none today):

```tsx
it('reorders priority by dragging a row handle', () => {
  const onTargets = vi.fn()
  render(<SettingsPanel open targets={DEFAULT_TARGETS} ...allProps onTargets={onTargets} />)
  const handles = screen.getAllByLabelText(/drag to reorder/i)
  const list = document.querySelector('.priority-list') as HTMLElement
  vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 150, left: 0, right: 200, height: 150, width: 200, x: 0, y: 0, toJSON: () => ({}) } as DOMRect)
  // 5 rows → 30px each; drag row 0 down past row 1's midpoint
  fireEvent.pointerDown(handles[0], { clientY: 15, button: 0, pointerId: 1 })
  fireEvent.pointerMove(handles[0], { clientY: 50, pointerId: 1 })
  fireEvent.pointerUp(handles[0], { pointerId: 1 })
  const next = onTargets.mock.calls.at(-1)![0].priority
  expect(next[1]).toBe(DEFAULT_TARGETS.priority![0])
})
it('has no arrow buttons', () => {
  render(<SettingsPanel open ...allProps />)
  expect(screen.queryByLabelText(/raise /i)).toBeNull()
})
```

Implementation in `SettingsPanel.tsx` — replace `move` and the two buttons with a pointer drag:

```tsx
const [dragFrom, setDragFrom] = useState<number | null>(null)
const [dragOver, setDragOver] = useState<number | null>(null)
const listRef = useRef<HTMLOListElement>(null)

const indexAt = (y: number) => {
  const el = listRef.current
  if (el === null) return null
  const rect = el.getBoundingClientRect()
  const rowH = (rect.bottom - rect.top) / priority.length
  return Math.max(0, Math.min(priority.length - 1, Math.floor((y - rect.top) / Math.max(1, rowH))))
}

const onHandleDown = (e: React.PointerEvent, i: number) => {
  if (e.button !== 0) return
  e.preventDefault()
  ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  setDragFrom(i)
  setDragOver(i)
}
const onHandleMove = (e: React.PointerEvent) => {
  if (dragFrom === null) return
  const i = indexAt(e.clientY)
  if (i !== null) setDragOver(i)
}
const onHandleUp = () => {
  if (dragFrom !== null && dragOver !== null && dragFrom !== dragOver) {
    const next = [...priority]
    const [moved] = next.splice(dragFrom, 1)
    next.splice(dragOver, 0, moved)
    onTargets({ ...targets, priority: next })
  }
  setDragFrom(null)
  setDragOver(null)
}
```

Row render (preview order while dragging: render `previewOrder = dragFrom === null ? priority : reordered copy`):

```tsx
<ol className="priority-list" ref={listRef}>
  {previewOrder.map((key, i) => (
    <li className={`priority-row ${dragFrom !== null && previewOrder[i] === priority[dragFrom] ? 'dragging' : ''}`} key={key}>
      <span className="priority-grip" role="button" aria-label={`Drag to reorder ${PRIORITY_LABELS[key]}`}
        onPointerDown={(e) => onHandleDown(e, priority.indexOf(key))}
        onPointerMove={onHandleMove} onPointerUp={onHandleUp} onPointerCancel={onHandleUp}>≡</span>
      <span className="priority-rank">{i + 1}</span>
      <span className="priority-label">{PRIORITY_LABELS[key]}</span>
    </li>
  ))}
</ol>
```

CSS: `.priority-grip { cursor: grab; user-select: none; touch-action: none; color: var(--text-dim); padding: 0 6px; } .priority-row.dragging { opacity: 0.55; }`

- [ ] **Step 5: Run all, commit** — `npx vitest run` → PASS. `git add -A; git commit -m "feat: 100-step undo, top-bar settings, drag-reorder solver priority"`

---

### Task 7: User curve — solver, chart line, UI

**Files:**
- Modify: `src/lib/types.ts` (PriorityKey `'usercurve'`, DEFAULT_PRIORITY order, PRIORITY_LABELS, `Targets.useUserCurve`, normalizePriority insertion), `src/lib/types.test.ts`-style tests live in existing lib tests — put normalizePriority tests in `src/lib/distribute.test.ts` or a new `src/lib/priority.test.ts`
- Modify: `src/lib/distribute.ts` (user-curve regime), `src/lib/distribute.test.ts`
- Modify: `src/App.tsx` (Doc.userCurve, Save curve plumbing, solver call), `src/lib/storage.ts` (`userCurve` field), `src/components/TargetsPanel.tsx` (User curve checkbox, volatility greying), `src/components/DistributionChart.tsx` (Save curve button + reference line), `src/components/DistributionChart.test.tsx`, `src/App.test.tsx`

**Interfaces:**
- `DEFAULT_PRIORITY = ['rtp', 'usercurve', 'ordering', 'volatility', 'hit', 'win']`; `PRIORITY_LABELS.usercurve = 'User curve'`.
- `Targets.useUserCurve: boolean` (DEFAULT_TARGETS: `true`).
- `solveWeights(rows, totalWeight, targets, curve, step?, absorbRemainder?, userCurve?: Record<string, number> | null)` — curve active iff `targets.useUserCurve && userCurve` holds at least one entry matching a row uid.
- `Doc.userCurve: Record<string, number> | null`; Workspace `userCurve?: Record<string, number> | null`.
- `DistributionChart` props gain `userCurve: Record<string, number> | null` and `onSaveCurve: () => void`.

- [ ] **Step 1: normalizePriority insertion (test first)**

```ts
it('inserts missing keys at their default-relative position', () => {
  // A pre-usercurve workspace: usercurve must land at rank 2, not be appended.
  expect(normalizePriority(['rtp', 'ordering', 'volatility', 'hit', 'win']))
    .toEqual(['rtp', 'usercurve', 'ordering', 'volatility', 'hit', 'win'])
  expect(normalizePriority(undefined)).toEqual(DEFAULT_PRIORITY)
  expect(normalizePriority(['win', 'rtp'])).toEqual(['win', 'rtp', 'usercurve', 'ordering', 'volatility', 'hit'])
})
```

Implementation in `types.ts` (replace the append loop):

```ts
for (const k of DEFAULT_PRIORITY) {
  if (seen.has(k)) continue
  // Insert before the first present key that follows k in the default order,
  // so a workspace saved before k existed gets it at its default rank.
  const later = DEFAULT_PRIORITY.slice(DEFAULT_PRIORITY.indexOf(k) + 1)
  const at = out.findIndex((x) => later.includes(x))
  out.splice(at === -1 ? out.length : at, 0, k)
  seen.add(k)
}
```

Check the `['win','rtp']` expectation against the code by hand: missing keys are inserted in default order — `usercurve` (later = ordering..win; 'win' present at 0 → wait, 'win' at index 0 IS in later → insert at 0?). That would give `['usercurve', 'win', 'rtp', ...]` — wrong for a user who deliberately ranked win first. Fix the rule: only consider keys that come AFTER k in the default order **and whose own position in `out` is after every key that precedes k in default order**… that is over-engineering. Use this simpler, correct-enough rule instead and adjust the test to it: insert before the first present key that follows k in default order **or at the end when none does** — and accept that a fully-inverted custom order places new keys conservatively early. The test above then expects `normalizePriority(['win','rtp'])` to equal `['usercurve','win','rtp','ordering','volatility','hit']`… that is surprising. DECISION: keep the simple rule but anchor on 'rtp' for usercurve specifically is worse. Final rule (implement exactly this): missing keys are inserted immediately after the **latest-positioned present key that precedes k in default order** (and at the front when none is present):

```ts
for (const k of DEFAULT_PRIORITY) {
  if (seen.has(k)) continue
  const earlier = DEFAULT_PRIORITY.slice(0, DEFAULT_PRIORITY.indexOf(k))
  let at = 0
  out.forEach((x, i) => { if (earlier.includes(x)) at = i + 1 })
  out.splice(at, 0, k)
  seen.add(k)
}
```

Hand-check: `['rtp','ordering','volatility','hit','win']` + usercurve → earlier = ['rtp'], last at index 0 → insert at 1 ✓. `['win','rtp']` → usercurve: earlier=['rtp'] at 1 → insert at 2 → `['win','rtp','usercurve']`; ordering: earlier includes rtp(1), usercurve(2) → insert at 3; etc → `['win','rtp','usercurve','ordering','volatility','hit']` ✓ (matches the original test). Fresh `undefined` → builds default order ✓. Use this version and the original test expectations.

- [ ] **Step 2: Run priority tests** → PASS. Also update any existing tests that assert the old DEFAULT_PRIORITY.

- [ ] **Step 3: Solver user-curve regime (tests first)**

Add to `distribute.test.ts` (reuse its row-builder helpers):

```ts
describe('user curve', () => {
  // 4 paying buckets + residual; a deliberate inversion: payout 1 is RARER than payout 2.
  const rows = [
    row(0, 0, '0x'), row(1, 1, '1x'), row(2, 2, '2x'), row(3, 10, '10x'), row(4, 100, '100x'),
  ]
  const shares: Record<string, number> = {
    [rows[0].uid]: 0.5, [rows[1].uid]: 0.08, [rows[2].uid]: 0.3, [rows[3].uid]: 0.1, [rows[4].uid]: 0.02,
  }
  const targets = { ...DEFAULT_TARGETS, rtp: 0.9, useChances: false }

  it('keeps the saved ordering (1x rarer than 2x) while hitting RTP', () => {
    const res = solveWeights(rows, 1_000_000, targets, 0.09, 1, true, shares)
    expect(res.achieved.rtp).toBeCloseTo(0.9, 6)
    const w = res.weights
    expect(w[1]).toBeLessThanOrEqual(w[2])   // saved order survives
    expect(w[2]).toBeLessThanOrEqual(w[0])   // residual still heaviest
  })
  it('with usercurve ranked above rtp the shape is exact and the miss is reported', () => {
    const t = { ...targets, priority: ['usercurve', 'rtp', 'ordering', 'volatility', 'hit', 'win'] as PriorityKey[] }
    const res = solveWeights(rows, 1_000_000, t, 0.09, 1, true, shares)
    for (const [i, uid] of rows.map((r, i) => [i, r.uid] as const)) {
      expect(res.weights[i] / 1_000_000).toBeCloseTo(shares[uid], 2)
    }
    expect(res.warnings.some((w) => /user curve outranks/i.test(w))).toBe(true)
  })
  it('with ordering ranked above usercurve the payout ladder wins and a notice says so', () => {
    const t = { ...targets, priority: ['rtp', 'ordering', 'usercurve', 'volatility', 'hit', 'win'] as PriorityKey[] }
    const res = solveWeights(rows, 1_000_000, t, 0.09, 1, true, shares)
    expect(res.weights[2]).toBeLessThanOrEqual(res.weights[1]) // payout order restored
    expect(res.warnings.some((w) => /yielded to payout ordering/i.test(w))).toBe(true)
  })
  it('is inert when useUserCurve is off or no share matches', () => {
    const off = solveWeights(rows, 1_000_000, { ...targets, useUserCurve: false }, 0.09, 1, true, shares)
    const none = solveWeights(rows, 1_000_000, targets, 0.09, 1, true, { nope: 0.5 })
    const plain = solveWeights(rows, 1_000_000, targets, 0.09)
    expect(off.weights).toEqual(plain.weights)
    expect(none.weights).toEqual(plain.weights)
  })
  it('band masses follow the saved curve when usercurve outranks the chances', () => {
    const t = { ...targets, useChances: true, hitChance: 0.3, winChance: 0.12 }
    const res = solveWeights(rows, 1_000_000, t, 0.09, 1, true, shares)
    // saved zero-band mass is 0.5 → hit chance lands ≈ 0.5, not 0.3
    expect(res.achieved.hitChance).toBeCloseTo(0.5, 2)
  })
})
```

- [ ] **Step 4: Implement the solver regime**

In `distribute.ts`:

1. `solveWeights` signature gains `userCurve?: Record<string, number> | null`. Right after the empty-guard:

```ts
const curveShares =
  targets.useUserCurve !== false && userCurve != null && rows.some((r) => userCurve[r.uid] !== undefined)
    ? rows.map((r) => {
        const s = userCurve[r.uid]
        // Rows added after the save fall back to their current share of the solve total.
        return s !== undefined ? Math.max(0, s) : Math.max(0, Math.round(r.weight)) / Math.max(1, totalWeight)
      })
    : null
```

Pass `curveShares` down by storing it on the ctx: `Ctx` gains `userShares: number[] | null` (set in `buildCtx` via a new parameter; the recursion for the step remainder passes `userCurve` through).

2. `continuousWeights`: when `ctx.userShares !== null`,
   - the zero band's `props` come from `idx.map((i) => ctx.userShares![i])` when their sum > 0 (falling back to the existing current-weight/zeroShares path when it is 0);
   - the paying bands use `logs = idx.map((i) => Math.log(Math.max(ctx.userShares![i], 1e-12)) - g * ctx.u[i])` with **no curvature term** and **no bandFloor** (`const g = ctx.ordered && ctx.userShares === null ? Math.max(gamma, bandFloor(ctx, idx)) : gamma`).

3. Ladders: generalize `enforceOrder` and `inOrder` to take a `keys: number[]` argument used in place of `ctx.payouts` for the "is this pair constrained" comparisons (`keys[hi] > keys[lo]`); every existing call passes `ctx.payouts`. When the curve is active and `above('usercurve', 'ordering')`, the solve's ladder is the unlocked paying rows sorted by saved share **descending**, with `keys = rows.map((_, i) => -ctx.userShares![i])` — so "weight never rises as saved share falls". When `above('ordering', 'usercurve')`, the payout ladder is used as today, and after allocation, if the saved-share ladder is violated (`!inOrder(ctx, weights, shareLadder, shareKeys)`), push: `'The saved user curve\'s ordering yielded to payout ordering.'`

4. RTP: when the curve is active and `above('usercurve', 'rtp')`: skip `solveGamma` (use `gamma = 0`), skip `repairRtp`, and when `Math.abs(achieved.rtp - targets.rtp) > 1e-6` push: `` `Target RTP ${targets.rtp} not solved — the user curve outranks it (achieved ${achieved.rtp.toFixed(6)}).` ``

5. Masses: when the curve is active and `targets.useChances`, compute `savedMasses = [0,1,2].map((g) => rows.reduce((a, r, i) => a + (groupOf(r.payout) === g ? curveShares[i] : 0), 0) * totalWeight)`. In `chooseBand`, when `above('usercurve', 'hit')` && `above('usercurve', 'win')`, skip the band search entirely and use `freeBudgets(c, savedMasses, step)` (like the pooled branch). For the mixed case (only one outranked), build hybrid masses: zero-band from `savedMasses` iff usercurve outranks hit, the paying split from `savedMasses` iff usercurve outranks win, remainder from `massesFor(targets, s, totalWeight)`, renormalized to `totalWeight`. When usercurve outranks a chance and the achieved value ends outside the band, replace that chance's `outOfBand` warning with: `` `Hit chance follows the saved curve — achieved ${achieved.hitChance.toFixed(3)} against a target of ${targets.hitChance}.` `` (same for win). When `useChances` is false, use `savedMasses` in place of `currentMasses`.

6. The two ordered-regime mass repairs (`raiseResidual`, `levelBoundary`, `restoreResidual`) stay gated exactly as today; with the curve active they operate on the curve-based budgets unchanged.

Run: `npx vitest run src/lib/distribute.test.ts` → all old + new PASS. The old tests must not change behavior (no `userCurve` argument → identical code path).

- [ ] **Step 5: Types/state/storage/UI plumbing**

- `types.ts`: `Targets.useUserCurve: boolean` (+ DEFAULT_TARGETS `useUserCurve: true`); `PRIORITY_LABELS.usercurve = 'User curve'`.
- `App.tsx`: `Doc` gains `userCurve: Record<string, number> | null` (emptyDoc: `null`; workspace load: `saved.userCurve ?? null`; snapshot writes it). `loadData`'s commit sets `userCurve: null`. `autoDistribute` (and the seed solve in `loadData`) pass `d.userCurve` as the new argument. New callback:

```ts
const saveCurve = useCallback(() => {
  const d = docRef.current
  const total = d.rows.reduce((a, r) => a + Math.max(0, r.weight), 0)
  if (!(total > 0)) return
  commit({ ...d, userCurve: Object.fromEntries(d.rows.map((r) => [r.uid, Math.max(0, r.weight) / total])) })
}, [commit])
```

Pass `userCurve={doc.userCurve}` and `onSaveCurve={saveCurve}` to `DistributionChart`; add a **Clear saved curve** action to the chart gear (`commit((d) => ({ ...d, userCurve: null }))`, rendered only when `doc.userCurve !== null`).
- `storage.ts`: `userCurve?: Record<string, number> | null` with `(v.userCurve === undefined || v.userCurve === null || (isObject(v.userCurve) && Object.values(v.userCurve).every(isFiniteNumber)))`.
- `TargetsPanel.tsx`: new prop `hasUserCurve: boolean`. In `solver-switches` add:

```tsx
<label className="checkbox" title={hasUserCurve ? 'On: Auto-Distribute keeps the saved curve\'s shape and ordering' : 'Save a curve first — the Save curve button on the distribution chart'}>
  <input type="checkbox" disabled={!hasUserCurve} checked={targets.useUserCurve && hasUserCurve}
    onChange={(e) => onTargets({ ...targets, useUserCurve: e.target.checked })} />
  <span>User curve</span>
</label>
```

The two volatility fields' `off` condition becomes `!targets.useVolatility || (hasUserCurve && targets.useUserCurve)` with title "The user curve owns the shape while it is active" (disable the preset buttons and the Curve c input the same way).

- [ ] **Step 6: Chart — Save curve button + reference line (test first)**

`DistributionChart.test.tsx`:

```tsx
it('draws the saved curve as a reference line and offers Save curve', () => {
  const onSaveCurve = vi.fn()
  const shares = Object.fromEntries(rows.map((r) => [r.uid, 0.5]))
  render(<DistributionChart {...props} userCurve={shares} onSaveCurve={onSaveCurve} />)
  expect(document.querySelector('.user-curve-line')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /save curve/i }))
  expect(onSaveCurve).toHaveBeenCalled()
})
it('draws no line when no curve is saved', () => {
  render(<DistributionChart {...props} userCurve={null} onSaveCurve={() => {}} />)
  expect(document.querySelector('.user-curve-line')).toBeNull()
})
```

Implementation: props `userCurve: Record<string, number> | null`, `onSaveCurve: () => void`. Button beside Reset view:

```tsx
<button type="button" className="btn" onClick={onSaveCurve}
  title="Snapshot the current distribution as the curve Auto-Distribute maintains (Solve for → User curve)">
  Save curve
</button>
```

Line, rendered inside the pan/zoom `<g>` after the bars:

```tsx
{userCurve !== null && (() => {
  const pts: string[] = []
  bars.forEach((b, i) => {
    if (!inView(i)) return
    const share = b.uids.reduce((a, u) => a + (userCurve[u] ?? NaN), 0)
    if (!Number.isFinite(share)) return
    const v = metric === 'weights' ? share * totalWeight : share
    pts.push(`${centres[i]},${yOf(v)}`)
  })
  return pts.length >= 2 ? (
    <polyline className="user-curve-line" points={pts.join(' ')} fill="none" pointerEvents="none" />
  ) : null
})()}
```

CSS: `.user-curve-line { stroke: var(--accent, #7aa2f7); stroke-width: 1.5; stroke-dasharray: 5 4; opacity: 0.9; }`

- [ ] **Step 7: Update App smoke** — save-curve → line appears; Solve for shows a User curve checkbox (disabled before a save).

- [ ] **Step 8: Run all, commit** — `npx vitest run` → PASS. `git add -A; git commit -m "feat: user curve — saveable target shape the solver maintains and the chart draws"`

---

### Task 8: README, lint, build, full verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: README** — update: the solver section (new default priority listing User curve at rank 2 and what it trades at each rank), the targets-panel section (Settings in the top bar, no Undo/Redo buttons), Columns (One in, RTP Share, the gear toggles), a new Group Distribution section, the distribution chart section (gear menu, X order/labels, diagonal labels, Save curve + line, Swap sides/Stack below replaced by dock dragging), Workspace → Layout rewritten for the dock (drag headers, dividers, persistence), keyboard table (undo 100 steps), Persistence list (new fields), Project layout tree (new files).

- [ ] **Step 2: Full verification** — `npx vitest run` → all PASS; `npm run build` → clean; `npm run lint` → clean. Fix anything that surfaces.

- [ ] **Step 3: Commit** — `git add -A; git commit -m "docs: README for group table, dock layout, column toggles and user curve"`

---

## Self-review notes

- Spec coverage: items 1 (Task 1), 2–5+7 (Task 2), 6 (Task 3), 8+12 (Task 4), 9–11 (Task 5), 13–15 (Task 6), 16 (Task 7); README/item-level docs (Task 8). Export invariance (item 5) is pinned by test in Task 2.
- Type consistency: `hidden: string[]` prop on both tables; `DockLayout/PanelId/DropTarget` defined once in layout.ts; solver's 7th arg `userCurve` matches App call sites; `GearMenu({ label, children })` used by Tasks 2, 4.
- Old-workspace safety: every new Workspace/ChartSettings/Targets field optional + defaulted; layout migrates from `swapped`/`forceStack`.
