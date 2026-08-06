# Weighted Return Tool Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the tool ingest the real engine TSV, solve weight distributions against RTP / hit-chance / win-chance / volatility targets with lockable rows, and behave like a light-themed spreadsheet with keyboard navigation, in-cell arithmetic, undo, autosave and TSV export.

**Architecture:** Pure logic lives in `src/lib` (parse, format, expression eval, solver, export, history, storage) and is covered by Vitest. React components in `src/components` are thin: a grid with an explicit selection/edit state machine, a targets panel, and a chart. `App.tsx` owns document state and wires undo + persistence around it.

**Tech Stack:** React 19, TypeScript 6, Vite 8, Vitest (new dev dependency). No runtime dependencies added.

**Spec:** `docs/superpowers/specs/2026-08-06-weighted-return-tool-redesign-design.md`

## Global Constraints

- No new **runtime** dependencies. Vitest is a devDependency only.
- Chance and Weighted Value display: plain decimal, max 15 dp, trailing zeros trimmed, **never** scientific notation.
- Export precision: 10 significant digits, trailing zeros trimmed, plain decimal. **Verified** to reproduce all 60 computed cells of `example-output-data.tsv`.
- Export header is verbatim `ID\tAvg Payout \tLabel\tWeights\tWeighted Value\tChance` — note the trailing space after `Avg Payout`.
- Export has **no trailing newline** (verified: file is 32 lines, last is the totals row).
- Default export filename: `ref-weights-regular.tsv`.
- Payouts are floats and are **never** rounded.
- Weights are non-negative integers and always sum exactly to the total.
- Hit chance = Σ chance where payout > 0. Win chance = Σ chance where payout > 1.
- Chance tolerance is **relative**: `band(x) = [x·(1−τ), x·(1+τ)]`, default τ = 0.035.
- Hit/win chance display to exactly 3 dp in the targets panel.
- Undo history: 20 steps.
- localStorage key: `weighted-return-tool:workspace:v1`.
- Light spreadsheet theme; every cell bordered on all four sides.

---

### Task 1: Project hygiene — dead files, Vitest, fonts

**Files:**
- Delete: `src/assets/hero.png`, `src/assets/react.svg`, `src/assets/vite.svg`, `public/icons.svg`, and the now-empty `src/assets/`
- Keep: `public/favicon.svg` (referenced by `index.html:5`)
- Modify: `package.json`, `vite.config.ts`, `tsconfig.app.json`, `index.html`
- Test: `src/lib/smoke.test.ts` (temporary, deleted in Task 2)

**Interfaces:**
- Consumes: nothing
- Produces: `npm test` and `npm run test:run` work; `describe/it/expect` imported explicitly from `vitest`

- [ ] **Step 1: Confirm the dead files are genuinely unreferenced**

Already verified by grep: only `favicon.svg` (from `index.html`) and `index.css` (from `main.tsx`) are referenced. `hero.png`, `react.svg`, `vite.svg`, `icons.svg` have zero references.

- [ ] **Step 2: Delete them**

```bash
rm -f src/assets/hero.png src/assets/react.svg src/assets/vite.svg public/icons.svg
rmdir src/assets
```

- [ ] **Step 3: Install Vitest**

```bash
npm install -D vitest
```

- [ ] **Step 4: Add test scripts to `package.json`**

```json
"test": "vitest",
"test:run": "vitest run"
```

- [ ] **Step 5: Wire Vitest into `vite.config.ts`**

```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
```

- [ ] **Step 6: Allow node types for tests**

In `tsconfig.app.json`, change `"types": ["vite/client"]` to `"types": ["vite/client", "node"]`. Tests read the reference `.tsv` files with `node:fs`.

- [ ] **Step 7: Drop the display font from `index.html`**

The light theme drops Chakra Petch and keeps IBM Plex Mono. Replace the Google Fonts `href` with:

```
https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap
```

- [ ] **Step 8: Smoke test, then verify the toolchain**

```ts
// src/lib/smoke.test.ts
import { describe, it, expect } from 'vitest'
describe('toolchain', () => { it('runs', () => { expect(1 + 1).toBe(2) }) })
```

Run: `npm run test:run` → PASS. Then `npm run build` → succeeds.

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "chore: remove Vite scaffold leftovers, add Vitest"
```

---

### Task 2: `format.ts` — number formatting

**Files:**
- Rewrite: `src/lib/format.ts`
- Create: `src/lib/format.test.ts`
- Delete: `src/lib/smoke.test.ts`

**Interfaces:**
- Produces:
  - `fmtDecimal(n: number, maxDp?: number): string` — plain decimal, default 15 dp, trimmed, `'—'` if non-finite
  - `fmtPayout(n: number): string` — shortest round-trip
  - `fmtWeight(n: number): string` — grouped integer
  - `fmtFixed3(n: number): string` — exactly 3 dp
  - `fmtRtp(n: number): string` — 4 dp
  - `fmtPct(fraction: number, dp?: number): string` — chart/hint use only
  - `toPlainDecimal(s: string): string` — expands exponent notation
  - `fmtSig(n: number, sig?: number): string` — export form, default 10 sig digits

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { fmtDecimal, fmtSig, toPlainDecimal, fmtPayout, fmtWeight, fmtFixed3 } from './format'

describe('fmtDecimal', () => {
  it('never uses scientific notation', () => {
    expect(fmtDecimal(0.000166618069702)).toBe('0.000166618069702')
    expect(fmtDecimal(1e-8)).toBe('0.00000001')
  })
  it('caps at 15 decimal places', () => {
    expect(fmtDecimal(1 / 3).length).toBeLessThanOrEqual(17) // "0." + 15
    expect(fmtDecimal(1 / 3)).toBe('0.333333333333333')
  })
  it('trims trailing zeros and handles 0 / non-finite', () => {
    expect(fmtDecimal(0.5)).toBe('0.5')
    expect(fmtDecimal(0)).toBe('0')
    expect(fmtDecimal(NaN)).toBe('—')
  })
})

describe('toPlainDecimal', () => {
  it('expands exponent notation', () => {
    expect(toPlainDecimal('1e-8')).toBe('0.00000001')
    expect(toPlainDecimal('1.234e-7')).toBe('0.0000001234')
    expect(toPlainDecimal('0.5')).toBe('0.5')
  })
})

describe('fmtSig', () => {
  it('reproduces reference-file values at 10 significant digits', () => {
    expect(fmtSig(200000 / 1200350)).toBe('0.1666180697')
    expect(fmtSig(200 / 1200350)).toBe('0.0001666180697')
    expect(fmtSig(15000 / 1200350)).toBe('0.01249635523')
    expect(fmtSig(0)).toBe('0')
    expect(fmtSig(1)).toBe('1')
  })
  it('never emits an exponent', () => {
    expect(fmtSig(1.234e-9)).not.toContain('e')
  })
})

describe('misc formatters', () => {
  it('formats payouts, weights and 3dp', () => {
    expect(fmtPayout(1000)).toBe('1000')
    expect(fmtPayout(18.7)).toBe('18.7')
    expect(fmtPayout(0)).toBe('0')
    expect(fmtWeight(1200350)).toBe('1,200,350')
    expect(fmtFixed3(0.49033532)).toBe('0.490')
  })
})
```

- [ ] **Step 2: Run and confirm failure**

`npx vitest run src/lib/format.test.ts` → FAIL (module has no such exports)

- [ ] **Step 3: Implement**

Key details:
- `fmtDecimal` uses `toFixed(maxDp)` then strips trailing zeros and a trailing `.`. `toFixed` never emits exponents up to 100 dp.
- `fmtSig` = `toPlainDecimal(String(Number(n.toPrecision(sig))))`.
- `toPlainDecimal` parses `/^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/i` and shifts the point manually; returns input unchanged when there is no exponent.
- `fmtPayout` = `String(n)` for finite values (JS shortest round-trip gives `1000`, `18.7`, `0.33`).

- [ ] **Step 4: Run tests** → PASS. Delete `src/lib/smoke.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: plain-decimal and significant-digit formatters"
```

---

### Task 3: `expr.ts` — in-cell arithmetic

**Files:**
- Create: `src/lib/expr.ts`, `src/lib/expr.test.ts`

**Interfaces:**
- Produces: `evaluateExpression(input: string): number | null` — `null` means invalid; caller reverts the cell.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { evaluateExpression as ev } from './expr'

describe('evaluateExpression', () => {
  it('evaluates plain numbers', () => {
    expect(ev('200')).toBe(200)
    expect(ev('0.33')).toBe(0.33)
    expect(ev('.5')).toBe(0.5)
  })
  it('evaluates the append forms the grid produces', () => {
    expect(ev('200+500')).toBe(700)
    expect(ev('200-50')).toBe(150)
    expect(ev('200*2')).toBe(400)
    expect(ev('200/2')).toBe(100)
  })
  it('respects precedence and parentheses', () => {
    expect(ev('2+3*4')).toBe(14)
    expect(ev('(2+3)*4')).toBe(20)
  })
  it('handles unary minus and a leading = ', () => {
    expect(ev('-5')).toBe(-5)
    expect(ev('=200+5')).toBe(205)
    expect(ev('2*-3')).toBe(-6)
  })
  it('strips thousands separators and whitespace', () => {
    expect(ev('1,200,350')).toBe(1200350)
    expect(ev(' 200 + 5 ')).toBe(205)
  })
  it('rejects invalid input rather than returning 0', () => {
    expect(ev('')).toBeNull()
    expect(ev('   ')).toBeNull()
    expect(ev('200+')).toBeNull()
    expect(ev('abc')).toBeNull()
    expect(ev('1/0')).toBeNull()
    expect(ev('(2+3')).toBeNull()
    expect(ev('2++')).toBeNull()
  })
})
```

- [ ] **Step 2: Run and confirm failure**

- [ ] **Step 3: Implement a recursive-descent parser** (no `eval`)

Grammar from spec §5.4. Sanitize first: strip a leading `=`, then remove `[,\s_']`. Tokenize into numbers and single-char operators. Parse `expr → term (('+'|'-') term)*`, `term → factor (('*'|'/') factor)*`, `factor → ('+'|'-') factor | number | '(' expr ')'`. Return `null` on: leftover tokens, unexpected token, empty input, division by zero, or a non-finite result.

- [ ] **Step 4: Run tests** → PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: in-cell arithmetic expression evaluator"
```

---

### Task 4: `types.ts` + `parse.ts` — data model and parser

**Files:**
- Rewrite: `src/lib/types.ts`, `src/lib/parse.ts`
- Create: `src/lib/parse.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface BucketRow { uid: string; bucketId: number; payout: number; label: string; weight: number; locked: boolean }
  type Volatility = 'very low' | 'low' | 'medium' | 'high' | 'very high' | 'custom'
  interface Targets { rtp: number; hitChance: number; winChance: number; tolerance: number } // tolerance in percent
  type ColumnKey = 'lock' | 'id' | 'payout' | 'label' | 'weight' | 'weightedValue' | 'chance'
  interface ParseOutcome { rows: BucketRow[]; skippedLines: string[]; hasWeights: boolean; error?: string }
  function parseTsv(text: string): ParseOutcome
  function nextUid(): string
  ```
  Also `CURVE_PRESETS: Record<Exclude<Volatility,'custom'>, number>` = very low 0.32, low 0.18, medium 0.09, high 0.035, very high 0.
  Also `DEFAULT_TARGETS: Targets` = `{ rtp: 0.95, hitChance: 0.30, winChance: 0.12, tolerance: 3.5 }`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseTsv } from './parse'

const INPUT = readFileSync('example-input-data.tsv', 'utf8')
const OUTPUT = readFileSync('example-output-data.tsv', 'utf8')

describe('parseTsv on the real input file', () => {
  const out = parseTsv(INPUT)
  it('parses every bucket', () => {
    expect(out.error).toBeUndefined()
    expect(out.rows).toHaveLength(30)
    expect(out.hasWeights).toBe(false)
  })
  it('reads columns as ID, Avg Payout, Label', () => {
    expect(out.rows[0]).toMatchObject({ bucketId: 0, payout: 1000, label: 'joker5-maxwin' })
    expect(out.rows[29]).toMatchObject({ bucketId: 29, payout: 650.75, label: '512-1024x' })
  })
  it('never rounds payouts', () => {
    expect(out.rows.find(r => r.label === 'bonus5')!.payout).toBe(50.16)
    expect(out.rows.find(r => r.label === 'green-two-only')!.payout).toBe(0.33)
  })
  it('starts every row unlocked with zero weight', () => {
    expect(out.rows.every(r => r.weight === 0 && r.locked === false)).toBe(true)
  })
})

describe('parseTsv round-trips our own export', () => {
  const out = parseTsv(OUTPUT)
  it('skips the header and the totals row', () => {
    expect(out.rows).toHaveLength(30)
  })
  it('picks up the Weights column', () => {
    expect(out.hasWeights).toBe(true)
    expect(out.rows[0].weight).toBe(200)
    expect(out.rows.reduce((a, r) => a + r.weight, 0)).toBe(1200350)
  })
})

describe('parseTsv tolerance', () => {
  it('accepts comma-separated input', () => {
    expect(parseTsv('0,1000,maxwin').rows[0]).toMatchObject({ payout: 1000, label: 'maxwin' })
  })
  it('accepts multi-space input', () => {
    expect(parseTsv('0   1000   maxwin').rows[0]).toMatchObject({ payout: 1000, label: 'maxwin' })
  })
  it('errors on unusable input', () => {
    expect(parseTsv('').error).toBeTruthy()
    expect(parseTsv('nothing useful here').error).toBeTruthy()
  })
  it('tolerates blank lines and CRLF', () => {
    expect(parseTsv('0\t5\ta\r\n\r\n1\t6\tb\r\n').rows).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run and confirm failure**

- [ ] **Step 3: Implement per spec §2.1**

Skip a line when field 0 is blank or non-finite (covers header and totals rows). Require field 1 finite and `>= 0`. Field 2 is the label. If `parts.length >= 4` and `parts[3]` is a finite number `>= 0`, set `weight = Math.round(...)` and mark `hasWeights`.

- [ ] **Step 4: Run tests** → PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: parse ID/Avg Payout/Label TSV with float payouts and export round-trip"
```

---

### Task 5: `exportTsv.ts` — TSV output and the acceptance test

**Files:**
- Create: `src/lib/exportTsv.ts`, `src/lib/exportTsv.test.ts`

**Interfaces:**
- Consumes: `BucketRow` (Task 4), `fmtSig` (Task 2)
- Produces:
  - `buildTsv(rows: BucketRow[], totalWeight: number): string`
  - `downloadTsv(text: string, filename: string): void`
  - `copyTsv(text: string): Promise<boolean>`

- [ ] **Step 1: Write the failing acceptance test**

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseTsv } from './parse'
import { buildTsv } from './exportTsv'

const INPUT = readFileSync('example-input-data.tsv', 'utf8')
const OUTPUT = readFileSync('example-output-data.tsv', 'utf8')

describe('buildTsv acceptance', () => {
  it('reproduces example-output-data.tsv byte for byte', () => {
    const input = parseTsv(INPUT)
    const reference = parseTsv(OUTPUT)          // supplies the weights
    const rows = input.rows.map((r, i) => ({ ...r, weight: reference.rows[i].weight }))
    const total = rows.reduce((a, r) => a + r.weight, 0)
    expect(total).toBe(1200350)
    expect(buildTsv(rows, total)).toBe(OUTPUT.replace(/\n$/, ''))
  })
  it('writes the header with its trailing space', () => {
    expect(buildTsv([], 0).split('\n')[0]).toBe('ID\tAvg Payout \tLabel\tWeights\tWeighted Value\tChance')
  })
})
```

- [ ] **Step 2: Run and confirm failure**

- [ ] **Step 3: Implement**

```
line   = [id, fmtPayout(payout), label, String(weight), fmtSig(payout*weight/total), fmtSig(weight/total)]
totals = ['', '', '', String(total), fmtSig(Σ payout*weight/total), fmtSig(Σ weight/total)]
```

Join fields with `\t`, lines with `\n`, **no trailing newline**. Guard `total <= 0` by emitting `0` for computed columns. Full-precision sums for the totals row (verified to match the reference either way).

`copyTsv` uses `navigator.clipboard.writeText` with a hidden-`textarea` + `document.execCommand('copy')` fallback; returns success. `downloadTsv` builds a `Blob`, an object URL, clicks a synthetic `<a download>`, then revokes the URL.

- [ ] **Step 4: Run tests** → PASS. This is the "verify it works with this data" gate.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: TSV export reproducing the reference output exactly"
```

---

### Task 6: `distribute.ts` — the solver

**Files:**
- Rewrite: `src/lib/distribute.ts`
- Create: `src/lib/distribute.test.ts`

**Interfaces:**
- Consumes: `BucketRow`, `Targets`, `CURVE_PRESETS` (Task 4)
- Produces:
  ```ts
  interface SolveResult {
    weights: number[]
    achieved: { rtp: number; hitChance: number; winChance: number }
    bandUsed: number            // s in [-1,1]
    gamma: number
    warnings: string[]
  }
  function groupOf(payout: number): 0 | 1 | 2
  function solveWeights(rows: BucketRow[], totalWeight: number, targets: Targets, curve: number): SolveResult
  function rescaleToTotal(rows: BucketRow[], newTotal: number): number[] | null   // null when newTotal < Σ locked
  function retargetRtp(rows: BucketRow[], totalWeight: number, targetRtp: number): number[]
  function statsOf(rows: BucketRow[], totalWeight: number): { rtp: number; hitChance: number; winChance: number }
  ```

**Algorithm** (spec §4.2–4.5), validated numerically against the real ladder:

1. `groupOf`: `payout === 0 → 0`, `payout <= 1 → 1`, else `2`.
2. Band position `s ∈ [−1,1]` maps preferred chances to `hit·(1 + s·τ)`, `win·(1 + s·τ)`, clipped to `[0,1]` and `win <= hit`.
3. Masses: `M0 = (1−hit)·T`, `M1 = (hit−win)·T`, `M2 = win·T`.
4. Free budgets `F_g = M_g − L_g` (locked sums). Negative → lock conflict.
5. Shape for G1/G2: `u_i = ln(payout_i) − ln(pMin)`, `raw_i = exp(−γ·u_i − c·u_i²)`, max-subtracted before `exp`, normalized per group to `F_g`. G0 keeps existing relative unlocked weights, equal split if all zero.
6. Bisect `γ ∈ [−40, 40]` for target RTP (RTP is decreasing in γ). Clamp target into the reachable range.
7. If unreachable at `s = 0`, bisect `|s|` for the smallest slack that makes it reachable; lock conflicts take priority over RTP shortfall.
8. Integers: largest-remainder per group to hit `round(F_g)` exactly; min 1 per unlocked bucket only when `round(F_g) >= count`; push the residual onto the largest unlocked bucket.
9. RTP repair: move single units between the lowest- and highest-payout unlocked G2 buckets while `|achieved − target|` improves; cap iterations at 10000; skip when G2 has < 2 unlocked buckets.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseTsv } from './parse'
import { solveWeights, statsOf, rescaleToTotal, retargetRtp, groupOf } from './distribute'
import { CURVE_PRESETS, DEFAULT_TARGETS } from './types'

const rows = parseTsv(readFileSync('example-input-data.tsv', 'utf8')).rows
const T = 1200350
const withWeights = (w: number[]) => rows.map((r, i) => ({ ...r, weight: w[i] }))

describe('groupOf', () => {
  it('splits on 0 and 1', () => {
    expect(groupOf(0)).toBe(0); expect(groupOf(0.33)).toBe(1)
    expect(groupOf(1)).toBe(1); expect(groupOf(1.8)).toBe(2)
  })
})

describe('solveWeights', () => {
  const r = solveWeights(rows, T, DEFAULT_TARGETS, CURVE_PRESETS.medium)
  it('sums to the total exactly', () => {
    expect(r.weights.reduce((a, b) => a + b, 0)).toBe(T)
  })
  it('produces only non-negative integers', () => {
    expect(r.weights.every(w => Number.isInteger(w) && w >= 0)).toBe(true)
  })
  it('hits RTP', () => {
    expect(statsOf(withWeights(r.weights), T).rtp).toBeCloseTo(0.95, 6)
  })
  it('lands on the preferred chances without spending the band', () => {
    const s = statsOf(withWeights(r.weights), T)
    expect(s.hitChance).toBeCloseTo(0.30, 4)
    expect(s.winChance).toBeCloseTo(0.12, 4)
    expect(r.bandUsed).toBe(0)
    expect(r.warnings).toHaveLength(0)
  })
})

describe('volatility grading', () => {
  it('monotonically reduces the top bucket share as volatility falls', () => {
    const order = ['very high', 'high', 'medium', 'low', 'very low'] as const
    const top = rows.reduce((a, r, i) => (r.payout > rows[a].payout ? i : a), 0)
    const shares = order.map(v => {
      const r = solveWeights(rows, T, DEFAULT_TARGETS, CURVE_PRESETS[v])
      expect(statsOf(withWeights(r.weights), T).rtp).toBeCloseTo(0.95, 5)
      return r.weights[top] / T
    })
    for (let i = 1; i < shares.length; i++) expect(shares[i]).toBeLessThan(shares[i - 1])
  })
})

describe('locks', () => {
  it('never moves a locked weight', () => {
    const locked = rows.map((r, i) => (i === 0 ? { ...r, weight: 12345, locked: true } : r))
    const r = solveWeights(locked, T, DEFAULT_TARGETS, CURVE_PRESETS.medium)
    expect(r.weights[0]).toBe(12345)
    expect(r.weights.reduce((a, b) => a + b, 0)).toBe(T)
  })
  it('warns when a lock exceeds what the band can absorb', () => {
    const locked = rows.map((r, i) => (i === 0 ? { ...r, weight: T - 1000, locked: true } : r))
    const r = solveWeights(locked, T, DEFAULT_TARGETS, CURVE_PRESETS.medium)
    expect(r.weights[0]).toBe(T - 1000)
    expect(r.warnings.length).toBeGreaterThan(0)
  })
})

describe('band', () => {
  it('stays inside tolerance whenever it is spent', () => {
    const t = { ...DEFAULT_TARGETS, rtp: 40 }   // forces the band open
    const r = solveWeights(rows, T, t, CURVE_PRESETS.medium)
    expect(Math.abs(r.bandUsed)).toBeLessThanOrEqual(1)
    const s = statsOf(withWeights(r.weights), T)
    expect(s.hitChance).toBeLessThanOrEqual(0.30 * 1.035 + 1e-6)
    expect(s.hitChance).toBeGreaterThanOrEqual(0.30 * 0.965 - 1e-6)
  })
})

describe('rescaleToTotal', () => {
  it('scales to a new total and preserves locks', () => {
    const start = solveWeights(rows, T, DEFAULT_TARGETS, CURVE_PRESETS.medium).weights
    const src = withWeights(start).map((r, i) => (i === 3 ? { ...r, locked: true } : r))
    const out = rescaleToTotal(src, 600000)!
    expect(out.reduce((a, b) => a + b, 0)).toBe(600000)
    expect(out[3]).toBe(src[3].weight)
  })
  it('rejects a total below the locked sum', () => {
    const src = rows.map((r, i) => (i === 0 ? { ...r, weight: 5000, locked: true } : { ...r, weight: 10 }))
    expect(rescaleToTotal(src, 100)).toBeNull()
  })
})

describe('retargetRtp', () => {
  it('reaches a new RTP without moving hit or win chance', () => {
    const start = solveWeights(rows, T, DEFAULT_TARGETS, CURVE_PRESETS.medium).weights
    const before = statsOf(withWeights(start), T)
    const out = retargetRtp(withWeights(start), T, 1.05)
    const after = statsOf(withWeights(out), T)
    expect(out.reduce((a, b) => a + b, 0)).toBe(T)
    expect(after.rtp).toBeCloseTo(1.05, 4)
    expect(after.hitChance).toBeCloseTo(before.hitChance, 4)
    expect(after.winChance).toBeCloseTo(before.winChance, 4)
  })
})
```

- [ ] **Step 2: Run and confirm failure**

- [ ] **Step 3: Implement the algorithm above**

- [ ] **Step 4: Run tests** → PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: target-driven weight solver with volatility curve and locks"
```

---

### Task 7: `history.ts` + `storage.ts`

**Files:**
- Create: `src/lib/history.ts`, `src/lib/history.test.ts`, `src/lib/storage.ts`, `src/lib/storage.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface HistoryState<T> { past: T[]; future: T[] }
  const HISTORY_LIMIT = 20
  function pushHistory<T>(h: HistoryState<T>, present: T): HistoryState<T>
  function undo<T>(h: HistoryState<T>, present: T): { history: HistoryState<T>; present: T } | null
  function redo<T>(h: HistoryState<T>, present: T): { history: HistoryState<T>; present: T } | null

  interface Workspace { version: 1; rows: BucketRow[]; targets: Targets; volatility: Volatility;
                        curve: number; columnWidths: Record<string, number>;
                        chart: { metric: 'weights'|'chance'; logY: boolean; logX: boolean; aggregate: boolean };
                        exportFilename: string }
  const STORAGE_KEY = 'weighted-return-tool:workspace:v1'
  function saveWorkspace(w: Workspace): void
  function loadWorkspace(): Workspace | null
  function clearWorkspace(): void
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// history.test.ts
import { describe, it, expect } from 'vitest'
import { pushHistory, undo, redo, HISTORY_LIMIT } from './history'

const empty = { past: [], future: [] }

describe('history', () => {
  it('caps at 20 and drops the oldest', () => {
    let h = empty
    for (let i = 0; i < 25; i++) h = pushHistory(h, i)
    expect(h.past).toHaveLength(HISTORY_LIMIT)
    expect(h.past[0]).toBe(5)
  })
  it('round-trips undo and redo', () => {
    let h = pushHistory(empty, 'a')
    const u = undo(h, 'b')!
    expect(u.present).toBe('a')
    const r = redo(u.history, u.present)!
    expect(r.present).toBe('b')
  })
  it('clears the redo stack on a new push', () => {
    const u = undo(pushHistory(empty, 'a'), 'b')!
    expect(u.history.future).toHaveLength(1)
    expect(pushHistory(u.history, 'c').future).toHaveLength(0)
  })
  it('returns null when there is nothing to undo or redo', () => {
    expect(undo(empty, 'x')).toBeNull()
    expect(redo(empty, 'x')).toBeNull()
  })
})
```

```ts
// storage.test.ts — vitest environment 'node' has no localStorage; stub it
import { describe, it, expect, beforeEach } from 'vitest'
import { saveWorkspace, loadWorkspace, clearWorkspace, STORAGE_KEY } from './storage'

const store = new Map<string, string>()
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(), key: () => null, length: 0,
} as unknown as Storage

const ws = {
  version: 1 as const, rows: [], targets: { rtp: 0.95, hitChance: 0.3, winChance: 0.12, tolerance: 3.5 },
  volatility: 'medium' as const, curve: 0.09, columnWidths: {},
  chart: { metric: 'weights' as const, logY: true, logX: false, aggregate: true },
  exportFilename: 'ref-weights-regular.tsv',
}

describe('storage', () => {
  beforeEach(() => store.clear())
  it('round-trips a workspace', () => {
    saveWorkspace(ws)
    expect(loadWorkspace()).toEqual(ws)
  })
  it('returns null and clears on malformed JSON', () => {
    store.set(STORAGE_KEY, '{not json')
    expect(loadWorkspace()).toBeNull()
    expect(store.has(STORAGE_KEY)).toBe(false)
  })
  it('rejects a wrong version and a wrong shape without throwing', () => {
    store.set(STORAGE_KEY, JSON.stringify({ ...ws, version: 99 }))
    expect(loadWorkspace()).toBeNull()
    store.set(STORAGE_KEY, JSON.stringify({ version: 1, rows: 'nope' }))
    expect(loadWorkspace()).toBeNull()
  })
  it('clears', () => { saveWorkspace(ws); clearWorkspace(); expect(loadWorkspace()).toBeNull() })
})
```

- [ ] **Step 2: Run and confirm failure**

- [ ] **Step 3: Implement**

`saveWorkspace` wraps `JSON.stringify` in try/catch (quota errors must not break the app). `loadWorkspace` validates `version === 1`, `Array.isArray(rows)`, and that `targets` has four finite numbers; anything else → `clearWorkspace()` and return `null`.

- [ ] **Step 4: Run tests** → PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: bounded undo history and localStorage workspace"
```

---

### Task 8: Light spreadsheet theme

**Files:**
- Rewrite: `src/index.css`

**Interfaces:**
- Produces the class names Tasks 9–13 use: `.app`, `.topbar`, `.btn`, `.panel`, `.grid-wrap`, `.grid-table`, `.gcell`, `.gcell.selected`, `.gcell.editing`, `.gcell.invalid`, `.grid-row.locked`, `.totals-row`, `.col-resizer`, `.targets`, `.target-field`, `.seg`, `.seg-btn`, `.badge.ok`, `.badge.warn`, `.chart-*`.

- [ ] **Step 1: Replace the dark theme variables**

```css
:root {
  --bg: #f4f5f7;  --surface: #ffffff;  --surface-alt: #fafbfc;
  --header: #eceff3;  --line: #d0d7de;  --line-strong: #9aa5b1;
  --text: #1f2328;  --text-dim: #57606a;  --text-faint: #8c959f;
  --accent: #0969da;  --accent-soft: #ddf0ff;
  --ok: #1a7f37;  --warn: #9a6700;  --danger: #cf222e;
  --lock: #fff4d6;  --lock-line: #d4a72c;
  --font-mono: 'IBM Plex Mono', ui-monospace, monospace;
}
```

Remove: the two `radial-gradient`s on `body`, the `body::before` grain overlay, `--font-display` and every `font-family: var(--font-display)` use, `text-transform: uppercase` on headings and buttons, and the gold `--gold*` variables.

- [ ] **Step 2: Style the grid as a spreadsheet**

`.grid-table { border-collapse: separate; border-spacing: 0; table-layout: fixed }` so column widths are honoured. Every `td`/`th` gets `border-right: 1px solid var(--line); border-bottom: 1px solid var(--line)`, with the table carrying the matching top and left borders. Header sticky at `top: 0`, totals row sticky at `bottom: 0` with `border-top: 2px solid var(--line-strong)` and `font-weight: 600`. Alternating `.grid-row:nth-child(even) { background: var(--surface-alt) }`. `.gcell.selected { outline: 2px solid var(--accent); outline-offset: -2px }` so it never shifts layout. `.grid-row.locked { background: var(--lock) }`. `.gcell.invalid { color: var(--danger); box-shadow: inset 0 0 0 2px var(--danger) }`. Keep `font-variant-numeric: tabular-nums` on numeric cells.

- [ ] **Step 3: Verify visually**

Run `npm run dev`, load the sample data, confirm the grid reads as a spreadsheet and text is legible.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "style: light spreadsheet theme"
```

---

### Task 9: `useGridNavigation.ts` + `cells.tsx`

**Files:**
- Create: `src/components/useGridNavigation.ts`
- Rewrite: `src/components/cells.tsx`

**Interfaces:**
- Consumes: `evaluateExpression` (Task 3), `ColumnKey` (Task 4)
- Produces:
  ```ts
  interface CellPos { row: number; col: number }
  interface GridNav {
    sel: CellPos; editing: boolean; initialEdit: string | null
    setSel(p: CellPos): void
    startEdit(seed: string | null): void
    stopEdit(): void
    onGridKeyDown(e: React.KeyboardEvent): void
  }
  function useGridNavigation(rowCount: number, colCount: number, opts: {
    onDelete(p: CellPos): void; onToggleLock(row: number): void
    onUndo(): void; onRedo(): void
  }): GridNav
  ```
  `cells.tsx` exports `<GridCell>` (renders a `div` when idle, an `input` when editing) with props `{ display, rawValue, editable, numeric, selected, editing, initialEdit, onCommit(raw: string): void, onStartEdit(seed: string|null): void, onStopEdit(): void }`.

- [ ] **Step 1: Implement the state machine** per spec §5.2/§5.3

Key routing when **not** editing: arrows/Tab/Home/End/PageUp/PageDown move `sel`; `Enter`/`F2` → `startEdit(null)`; `Delete`/`Backspace` → `onDelete`; `Space` on the lock column → `onToggleLock`; `Ctrl+Z`/`Ctrl+Y`/`Ctrl+Shift+Z` → undo/redo; a digit or `.` → `startEdit(char)`; `+ - * / (` → `startEdit(APPEND)` (sentinel meaning "prefill with the current raw value then append the char"); `=` → `startEdit('=')`.

When **editing**, the `input` handles keys: `Enter` commits and moves down, `Tab` commits and moves right, `Up`/`Down` commit and move, `Escape` reverts, `blur` commits. `Ctrl+Z` is *not* intercepted while editing.

- [ ] **Step 2: Implement `GridCell`**

On entering edit mode, set the input value from the seed (replace / append / raw) and focus it, placing the caret at the end. On commit, run `evaluateExpression`; `null` → revert and flash `.invalid`; otherwise call `onCommit`.

- [ ] **Step 3: Verify in the browser**

`npm run dev`. Check: arrows move a visible outline; typing `5` replaces; selecting a `200` cell and typing `+500` then Enter yields `700`; Escape reverts; Tab wraps.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: spreadsheet keyboard navigation and arithmetic cells"
```

---

### Task 10: `BucketTable.tsx`

**Files:**
- Rewrite: `src/components/BucketTable.tsx`

**Interfaces:**
- Consumes: `GridCell`, `useGridNavigation` (Task 9); `fmtDecimal`, `fmtPayout`, `fmtWeight` (Task 2)
- Produces:
  ```ts
  type RowPatch = Partial<Pick<BucketRow, 'bucketId'|'payout'|'label'|'weight'|'locked'>>
  interface BucketTableProps {
    rows: BucketRow[]; totalWeight: number; sort: SortState
    columnWidths: Record<ColumnKey, number>
    onSort(k: SortKey): void
    onPatch(uid: string, p: RowPatch): void
    onWidths(w: Record<ColumnKey, number>): void
    onTotalWeight(n: number): void
    onTotalRtp(n: number): void
    onUndo(): void; onRedo(): void
  }
  ```

- [ ] **Step 1: Render columns in output order**

`lock · ID · Avg Payout · Label · Weights · Weighted Value · Chance`, driven by a `COLUMNS` array of `{ key, label, sortable, numeric, defaultWidth }`. Use `<colgroup>` with widths from `columnWidths`.

- [ ] **Step 2: Wire per-cell commits**

`weight` → `onPatch({ weight })`. `weightedValue` → `weight = round(v·total/payout)` (guard `payout > 0`). `chance` → `weight = round(v·total)` (chance is a **fraction**, not a percent).

- [ ] **Step 3: Add the resizer**

An absolutely-positioned `.col-resizer` on each header's right edge. `pointerdown` captures, `pointermove` sets width (min 48), `pointerup` releases. `dblclick` auto-fits by measuring the column's rendered strings with a module-level cached `CanvasRenderingContext2D` and the grid font, plus padding.

- [ ] **Step 4: Add the totals row**

A `<tfoot>` sticky to the bottom. Weight cell → `onTotalWeight`, Weighted Value cell → `onTotalRtp`, Chance cell renders a static `1`, first three cells empty. It is the last navigable grid row.

- [ ] **Step 5: Verify in the browser**

Columns in the right order, resizing works, totals row edits fire.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: spreadsheet bucket table with totals row and resizable columns"
```

---

### Task 11: `TargetsPanel.tsx`

**Files:**
- Create: `src/components/TargetsPanel.tsx`
- Modify: `src/components/RtpGauge.tsx`

**Interfaces:**
- Consumes: `Targets`, `Volatility`, `CURVE_PRESETS` (Task 4); `SolveResult` (Task 6); `fmtFixed3`, `fmtRtp` (Task 2)
- Produces:
  ```ts
  interface TargetsPanelProps {
    targets: Targets; volatility: Volatility; curve: number
    achieved: { rtp: number; hitChance: number; winChance: number }
    warnings: string[]; bucketCount: number
    canUndo: boolean; canRedo: boolean
    exportFilename: string
    onTargets(t: Targets): void
    onVolatility(v: Volatility): void
    onCurve(c: number): void
    onAutoDistribute(): void
    onUndo(): void; onRedo(): void
    onCopy(): void; onDownload(): void; onFilename(s: string): void
    onClear(): void
  }
  ```

- [ ] **Step 1: Build the controls** per spec §6

Volatility segmented control writes `CURVE_PRESETS[v]` into `curve`; editing `curve` directly sets `volatility = 'custom'`. Hit/win fields show achieved to 3 dp, the computed band, an in-band/out-of-band badge, and a `= current` button.

- [ ] **Step 2: Make the RTP gauge target-relative**

`RtpGauge` takes `{ rtp, target }`; the band becomes `target ± 3%` and the scale spans `target ± 20%` (clamped to `>= 0`).

- [ ] **Step 3: Guard destructive actions**

`Clear workspace` requires a `window.confirm` before wiping.

- [ ] **Step 4: Verify in the browser**

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: targets panel with volatility, tolerance and export controls"
```

---

### Task 12: `App.tsx` — state, undo, autosave

**Files:**
- Rewrite: `src/App.tsx`

- [ ] **Step 1: Define the document**

```ts
interface Doc { rows: BucketRow[]; targets: Targets; volatility: Volatility; curve: number }
```

`totalWeight` is **derived** — `Σ rows.weight` — never separate state. Delete the old `delta` / `absorbDelta` "fix" UI, which the always-equal model makes impossible.

- [ ] **Step 2: Route every mutation through one helper**

```ts
const commit = (next: Doc) => { setHistory(h => pushHistory(h, doc)); setDoc(next) }
```

so undo coverage cannot drift from the mutation list.

- [ ] **Step 3: Wire undo/redo, autosave and load**

`Ctrl+Z`/`Ctrl+Y`/`Ctrl+Shift+Z` at the window level, ignored while a cell is editing. Autosave the workspace on change, debounced 300ms. On mount, `loadWorkspace()`; if it returns rows, restore and skip the paste screen.

- [ ] **Step 4: Wire load, auto-distribute, totals edits and export**

On paste: if `hasWeights`, keep them; otherwise run `solveWeights`. `onTotalWeight` → `rescaleToTotal` (null → ignore and flag). `onTotalRtp` → `retargetRtp`. Export builds via `buildTsv` and hands off to `copyTsv` / `downloadTsv`.

- [ ] **Step 5: Update the paste dialog copy**

It currently says `bucket ID ⇥ bucket label ⇥ payout bet multiplier` — wrong order. Change to `ID ⇥ Avg Payout ⇥ Label`, and replace `SAMPLE_TSV` in `parse.ts` with real-shaped rows in that column order.

- [ ] **Step 6: Verify end to end**

Paste `example-input-data.tsv`, auto-distribute, lock rows, re-distribute, undo, reload the page, export.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: wire document state, undo and autosave"
```

---

### Task 13: Chart toggles

**Files:**
- Modify: `src/components/DistributionChart.tsx`

- [ ] **Step 1: Add the metric and log-X toggles**

Props gain `metric: 'weights' | 'chance'`, `logX: boolean`. Defaults set in `App.tsx`: `metric: 'weights'`, `logY: true`, `logX: false`, `aggregate: true`.

- [ ] **Step 2: Implement the X scale**

Linear keeps the existing equal-step bars. Logarithmic positions each bar at `ln(payout)` across the plot width, skipping `payout === 0` (undefined in log space) and noting the omission in the axis title. Bar width becomes the smaller of the default and the minimum neighbour gap.

- [ ] **Step 3: Implement the Y metric**

`weights` plots `row.weight` with `fmtWeight` tick labels; `chance` plots the fraction with `fmtPct` tick labels.

- [ ] **Step 4: Verify** that log-log makes very-high volatility look like a straight line

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: chart metric and log-X toggles"
```

---

### Task 14: README and final verification

**Files:**
- Rewrite: `README.md`

- [ ] **Step 1: Write the README**

Replace the Vite template boilerplate entirely. Sections: what the tool is; requirements (Node 20+); install (`npm install`); usage (`npm run dev`, `npm run build`, `npm run preview`, `npm test`); input format with a worked example; output format; features (solver and what each target does, volatility with the `c` table, locks, keyboard shortcut table, in-cell arithmetic, undo, autosave, export); a "tuning volatility" note pointing at `CURVE_PRESETS` in `src/lib/types.ts`; project layout.

- [ ] **Step 2: Run the full gate**

```bash
npm run test:run && npm run lint && npm run build
```

All three must pass. Fix anything that does not.

- [ ] **Step 3: Manual acceptance pass**

`npm run dev`, then confirm against the original request: paste the real TSV; column order matches the output file; Chance shows full decimals with no `e-4`; arrow-key navigation; lock + auto-distribute; win chance displayed; totals row editable; column resize; targets + volatility; `+500` arithmetic; light bordered theme; copy and download producing `ref-weights-regular.tsv`.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: README covering setup, usage and features"
```

---

## Self-Review

**Spec coverage** — §2.1 Task 4 · §2.2 Task 5 · §2.3 Task 10 · §3 Task 2 · §4.1 Tasks 4, 11 · §4.2–4.7 Task 6 · §5.1–5.4 Task 9 · §5.5–5.6 Task 10 · §5.7 Tasks 7, 12 · §6 Task 11 · §7 Task 13 · §8 Tasks 5, 11 · §9 Tasks 7, 12 · §10 Task 8 · §11 all · §12 Tasks 2–7 · §13 excluded by design. Extra scope from the user: dead files Task 1, README Task 14.

**Placeholders** — none; every code step carries real code or an exact algorithm.

**Type consistency** — `BucketRow`, `Targets`, `Volatility`, `ColumnKey`, `SolveResult`, `Workspace`, `CellPos` are defined once (Tasks 4, 6, 7, 9) and referenced with those names throughout. `solveWeights` / `rescaleToTotal` / `retargetRtp` / `statsOf` / `groupOf` keep identical signatures between Task 6's definition and their uses in Tasks 10 and 12.

**Deviation from spec, resolved:** §12 flagged the totals-row precision as an open risk. Probing the reference file settled it — full-precision and pre-rounded sums both yield `1.08819261`, and 10 significant digits reproduces all 60 computed cells. Task 5 uses full-precision sums.
