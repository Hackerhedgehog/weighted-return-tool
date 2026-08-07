# Chart readout, resizable charts, and simulation block size

Date: 2026-08-07

## Problem

Three complaints against the current charts:

1. **The distribution tooltip obscures the data.** `.chart-tooltip` is absolutely
   positioned at `top: 6px` inside `.chart-wrap`, so it floats over the bars —
   exactly over the region the user is inspecting. Its horizontal position is
   clamped with `Math.min(Math.max(centres[hover], 100), width - 110)`, which
   is a guess at the tooltip's own width; a bar near either edge still gets its
   tooltip partly cut off by the panel. The same defect exists in `SimChart`.
2. **The tooltip content is wrong.** Its title is the payout, the bucket labels
   are crammed onto one comma-joined line, and it wastes a row on a `drag ↑↓`
   affordance hint that the `ns-resize` cursor already conveys.
3. **Chart height is fixed.** `DistributionChart` hardcodes `HEIGHT = 340` and
   `SimChart` hardcodes `HEIGHT = 260`. A table with many buckets, or a
   simulation with a fine block plan, has no room to breathe.

Plus: the simulation chart labels its noise series "block avg" without ever
saying how many spins a block covers, so the reader cannot judge how much
smoothing the series carries.

## Design

### 1. Readout strip replaces the floating tooltip

New shared component `src/components/ChartReadout.tsx`. It renders **below** the
SVG, inside `.chart-wrap`, in normal document flow. Because it is not
positioned over the plot and spans the panel's full width, it is structurally
incapable of covering marks or being clipped at an edge — the `left: clamp(...)`
arithmetic disappears entirely rather than being tuned.

```ts
interface ReadoutTitle {
  text: string
  /** CSS color, e.g. 'var(--series-2)'. Omitted → default text color. */
  color?: string
}

interface ReadoutStat {
  label: string
  value: string
}

interface ChartReadoutProps {
  /** One line each. Empty → the idle hint is shown instead. */
  titles: ReadoutTitle[]
  stats: ReadoutStat[]
  /** Shown when `titles` is empty. */
  hint: string
}
```

Layout: a flex row — titles stacked in the left column, `stats` in a 2×2 grid on
the right. The strip has a **fixed height** so moving the pointer between bars,
or off the chart entirely, never shifts the page. It is always present; when
nothing is hovered it shows `hint` in the faint text color.

Bounding the height needs a cap on the title lines. At most four are rendered;
beyond that, three labels plus a `+N more` line. Long labels ellipsize and carry
a `title` attribute so the full text is still reachable.

The strip is presentational and non-interactive (`pointer-events: none` on the
text), so a pointer travelling below the axis cannot land on it and cancel the
hover.

CSS: `.chart-tooltip` / `.tt-payout` / `.tt-labels` / `.tt-row` are replaced by
`.chart-readout` and its children. Both charts share the one class.

### 2. Distribution readout content

Titles are the bucket labels, one per line, each in **its own group color**.
The color comes from `grouping.byUid.get(uid)`, looked up per bucket — not from
the bar's `segments`, which are merged per group and ordered by rank. A bar
aggregating two buckets from different groups therefore shows two lines in two
colors, which is the point of the request.

Stats, in order:

| label      | value                          | source                          |
| ---------- | ------------------------------ | ------------------------------- |
| `payout`   | `×1000`                        | `fmtPayout(bar.payout)`         |
| `weight`   | `420`                          | `fmtWeight(bar.weight)`         |
| `chance`   | `0.0042%`                      | `fmtPct(bar.chance, 4)`         |
| `weighted` | `0.0420`                       | `fmtRtp(bar.payout * bar.chance)` |

`weighted` is the bar's contribution to RTP — the same quantity as the table's
"Weighted Value" column and the `wv` line on the group handles, so the three
readouts agree.

The `drag` row (`↑↓` / `locked`) is removed.

Idle hint: `hover a bar for its numbers`.

`hover` state stays — it still drives the `.bar.hover` highlight — but is no
longer used for positioning.

### 3. Simulation chart: block size

`SimChart` already receives `blockSize`. It surfaces in two places:

- **Legend**, as a constant: `block avg · 100,000 spins each`, via `fmtWeight`.
- **Readout**, as the hovered block's *actual* spin count from the existing
  `spinsOf(i)` helper. The last block runs short (`blockPlan` ceilings the block
  size, and the worker trims the tail), so reporting `blockSize` there would be
  wrong for the final point.

Sim stats become: `block` (spins in this block), `block avg`, `RTP so far`,
`table RTP`. Title line stays `12,345,678 spins`, uncolored.

Idle hint: `hover the chart for block detail`.

### 4. Drag-to-resize

New `src/components/ChartResizeGrip.tsx` — a 10px-tall bar spanning the chart's
width, below the readout, with a short centered rule as the visual affordance
and `cursor: ns-resize`.

```ts
interface ChartResizeGripProps {
  height: number
  min: number
  max: number
  /** Restored by Home and by double-click. */
  fallback: number
  label: string
  onHeight: (h: number) => void
}
```

Pointer behavior: `pointerdown` captures the pointer and records
`{ startY, startHeight }`; `pointermove` emits `clamp(startHeight + (clientY -
startY), min, max)`; `pointerup` / `pointercancel` release. Dragging down makes
the chart taller. The drag state lives in a ref — height itself is owned by
`App`, so there is one source of truth and no local/prop divergence.

Keyboard, because a pointer-only resize is unreachable: the grip is
`role="separator"`, `aria-orientation="horizontal"`, `tabIndex={0}`, with
`aria-valuenow/min/max`. ↑/↓ adjust by 16px, PageUp/PageDown by 64px, Home
resets to `fallback`. Double-click also resets.

Ranges:

| chart        | min | max | default |
| ------------ | --- | --- | ------- |
| distribution | 220 | 900 | 340     |
| simulation   | 160 | 800 | 260     |

The `HEIGHT` constants become a `height` prop on each chart. Both already derive
every y-coordinate (`plotH`, axis title, x-axis labels) from that one number, so
this is a substitution, not a layout rewrite. The exported defaults
(`DEFAULT_CHART_HEIGHT`, `DEFAULT_SIM_CHART_HEIGHT`) and the clamp bounds live
next to the components that own them and are imported by `App` and `storage`.

The simulation grip renders only alongside a real `SimChart` — in the
pre-run empty state there is no chart to size.

### 5. State and persistence

Height is view state, like `chart` and `columnWidths`: it lives in `App`,
outside the undo `Doc`, and is persisted. Two independent values, so the two
charts size separately.

- `App` holds `chartHeight` and `simChartHeight`.
- `DistributionChart` gains `height` / `onHeight` props.
- `SimulationPanel` gains `chartHeight` / `onChartHeight` and passes them
  through to `SimChart` — the panel does not own the value, it only threads it.
- `Workspace` gains optional `chartHeight?: number` and `simChartHeight?:
  number`. Optional, so a workspace saved before this feature still validates
  and simply takes the defaults — the established pattern for `simSpins` and
  `weightStep`.
- `isWorkspace` accepts `undefined` or a finite number for each.
- Values are **clamped on load** as well as on drag, so a hand-edited or
  corrupted localStorage entry cannot produce a 5px or 50,000px chart.

## Testing

vitest + jsdom, in the style of the existing `DistributionChart.test.tsx`
(faked `ResizeObserver`, deterministic 900px container width).

`ChartReadout` / distribution readout:

- idle chart shows the hint and no stats
- hovering a bar shows its label, and the label carries that bucket's group color
- an aggregated bar spanning two groups renders two title lines in two colors
- the four stats are present with correct values; `weighted` equals payout × chance
- no `drag` row is rendered
- five buckets on one aggregated bar render three labels and `+2 more`
- the readout is present in the DOM whether or not a bar is hovered (fixed height)

`ChartResizeGrip`:

- a pointer drag downward reports a larger height, upward a smaller one
- the reported height clamps at `min` and at `max`
- ArrowUp / ArrowDown and PageUp / PageDown adjust and clamp
- Home and double-click restore `fallback`

`SimChart` / `SimulationPanel`:

- the legend states the block size
- the readout reports the hovered block's spin count, and the short final block
  reports its trimmed count, not `blockSize`

`storage`:

- a workspace round-trips both heights
- a workspace without them still loads (defaults applied)
- a non-numeric height is rejected by `isWorkspace`

## Documentation

README gains a short note on the readout strip and the resize grip, alongside
the existing description of the chart controls.

## Out of scope

- Resizing chart *width* — the two-column grid owns that.
- Persisting height per-workspace-file rather than per-browser; localStorage is
  where all view state already lives.
- Reworking the group handles or the drag interaction itself.
