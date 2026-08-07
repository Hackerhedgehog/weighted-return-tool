# Exact chart entry, relative drags, group locks and group bars

Date: 2026-08-07

Six changes, five of them to the distribution chart and the groups it draws.
The chart became a control surface in `2026-08-06-simulation-and-grouping-design.md`,
but it is a coarse one: a drag is the only way to set a value, and it teleports
the bar to the cursor. This spec makes the chart precise — type an exact number,
drag by movement rather than by position — and lets groups act as single objects:
lock a whole group, collapse a whole group into one bar. The sixth change
separates import from export in the top bar.

The play/balance simulation (start credits, bet, balance chart, RTP multiplier)
is a separate subsystem with its own worker protocol, and gets its own spec
after this one lands.

## 1. Right-click to set an exact value

A drag cannot reliably land on 4,200. Right-clicking any **bar** or any **group
handle** opens a small entry popover at the pointer, clamped inside the chart
panel:

```
┌───────────────────────────┐
│ joker                     │
│ weight  [    4,200      ] │
│ now 4,150 · step ×10      │
│             [Cancel] [Set]│
└───────────────────────────┘
```

The field is pre-filled with the subset's current value **in the chart's
current metric** — a plain weight in Weights mode, a percentage in % Chance
mode (`12.5`, matching what the axis labels and the handle read). It accepts
arithmetic (`4150+50`) through `evaluateExpression`, exactly as the grid cells
and the targets fields already do.

Committing goes through the same path a drag commits through:

```ts
const target = metric === 'chance' ? (value / 100) * baseTotal : value
const weights = relative || metric === 'chance'
  ? scaleSubset(rows, uids, target, weightStep)
  : setSubsetTotal(rows, uids, target, weightStep)
```

so weight-step snapping, locked rows, and the grand-total invariant behave
identically to dragging, and the change lands as **one undo step** via the
existing `onCommit`. A `null` from `scaleSubset` — the off-step table case —
raises the same notice a blocked drag raises, and the popover stays open.

Enter sets, Escape and click-away cancel. `onContextMenu` is prevented on the
chart's interactive elements only, so right-clicking the surrounding page still
gets the browser menu.

This is a new component, `ChartValueEntry.tsx`, because the positioning and
clamping logic is the same problem `ChartReadout` already solves and neither
should grow the other's concerns.

## 2. Drags move by delta, not to the cursor

`moveDrag` currently reads the pointer's absolute position, so pressing on a
bar jumps its value to wherever the pointer happens to be — you have to grab
the bar exactly at its top edge to avoid destroying its value on contact.

`beginDrag` gains the subset's own starting fraction, and the drag becomes
relative to where it started:

```ts
// pointer-down — currentValue is the subset's value in the chart's metric:
// valueOf(bar) for a bar, the group's weight or chance for a handle
startY    = e.clientY
startFrac = liveScale.frac(currentValue)

// pointer-move
frac  = clamp(d.startFrac + (d.startY - e.clientY) / plotH, 0, 1)
value = d.scale.invert(frac)
```

The scale is still the one frozen at pointer-down, so the axis cannot rescale
under the pointer and feed back into the drag — that property is why this works
at all, and it is unchanged.

Because the delta is measured in axis fractions, sensitivity keeps the meaning
the chart is already showing: on a log Y axis a given pixel movement is a
constant *multiplier* wherever you grabbed, and on a linear axis a constant
*amount*. The bar never jumps on press, so a bar can be grabbed anywhere along
its length.

`fracFromPointer` and its `getBoundingClientRect` call are deleted; the drag no
longer needs to know where the SVG is on screen.

## 3. Locking a whole group

**A group is locked when every member row is locked** — there is no group-level
lock flag. A second source of truth would have to be reconciled with row locks
in the solver, in `interact.ts`, in export and in storage, and would disagree
with them the moment a single row was toggled.

A helper in `groups.ts`:

```ts
export type LockState = 'none' | 'some' | 'all'
export function groupLockState(rows: BucketRow[], groupId: string): LockState
```

A group with no buckets has nothing to lock: it reports `'none'` and its
padlock is disabled, the way `Delete` is already disabled for the last group.

Toggling patches every member row's `locked` in one commit, so undo, the
solver, the table tints and the export all keep working untouched. A **partial**
group locks the rest; a fully locked group unlocks.

Two controls:

- **Group settings** — a padlock button in each group's row, beside the name
  and swatches, showing the three states.
- **The chart's group handle** — a padlock on the right-edge handle. The handle
  already disables its own drag when everything inside it is locked; now that
  state is something you can cause deliberately, right where you were dragging.

`App` owns the action as `setGroupLocked(groupId, locked)` and passes it to
both.

## 4. Collapsing groups into single bars

`ChartSettings` gains one field:

```ts
/** Group ids drawn as a single aggregated bar instead of their buckets. */
groupBars: string[]
```

Default `[]`. `App` already merges saved chart settings over `DEFAULT_CHART`,
so workspaces saved before this field exists load with it empty and behave
exactly as they do today.

### The control

A chip row under the existing chart controls, doubling as the legend the chart
has never had:

```
Group bars:  [All] [None]
  ■ joker   □ wins   ■ bonus   □ lw   □ 0x
```

One chip per group in `grouping.groups` order — the groups that actually hold
buckets, so an empty group offers no chip and `groupBars` can name an id that
is not currently drawn without breaking anything. Chips are colored with the
group color and filled when collapsed. Each is a toggle button carrying
`aria-pressed`; `All` and `None` set every drawn group at once.

### Bar construction

Collapsed groups are taken out first, then everything left aggregates by equal
payout exactly as it does now:

1. For each id in `groupBars`, its member rows become **one bar** — solid group
   color, no stacked segments, since by definition it is one group.
2. The remaining rows follow the existing path: aggregated by payout when
   `aggregate` is on, one bar each when it is off, with stacked segments where
   an equal-payout bar spans groups.

A group bar sits at the group's **weight-weighted mean payout**:

```
x = Σ(payout × weight) / Σ weight
```

so the bar is where the group's mass actually is, and its ordering against
loose bucket bars still means something on both linear and log X. With a group
total weight of zero the weighting is undefined, so it falls back to the plain
mean of the member payouts. A group whose mean is 0 — an all-zero group like
`0x` — is a zero-payout bar and is dropped under Log X alongside the others,
counted in the same "n zero-payout buckets omitted" note.

Group bars are always labelled on the payout axis with their **group name**
rather than a payout, and are exempt from the `labelEvery` thinning that
applies to bucket bars — there are few of them and they are the coarse
landmarks of the view.

### Interaction

A group bar drags and right-clicks exactly like that group's handle does: same
uid subset, same `scaleSubset` / `setSubsetTotal` commit path, same relative
delta from §2, disabled when the group is fully locked. The handle stays on the
right edge whether or not the group is collapsed — it still reports the group's
weighted value, which the bar does not.

Its hover readout lists the member labels in group color, then:

```
payout    ×0.50 – ×1000
avg       ×2.41
weight    4,200
chance    0.3500%
weighted  0.0084
```

### Where the code goes

Bar construction is currently a `useMemo` inside `DistributionChart.tsx`, which
is already 635 lines. With collapsed groups, mean-payout placement and the
zero-payout drop, it becomes real logic with real edge cases — so it moves out
into a pure `src/lib/bars.ts`:

```ts
export interface ChartBar {
  kind: 'buckets' | 'group'
  /** Group name for a group bar; absent for bucket bars. */
  name?: string
  /** Placement on the payout axis. */
  payout: number
  payoutRange?: [number, number]
  weight: number
  chance: number
  labels: string[]
  uids: string[]
  segments: Segment[]
  allLocked: boolean
}

export function buildBars(
  rows: BucketRow[],
  grouping: Grouping,
  totalWeight: number,
  opts: { aggregate: boolean; groupBars: string[]; logX: boolean },
): { bars: ChartBar[]; droppedZero: number }
```

Pure and unit-testable with the rest of `lib`, which is where the risk in this
feature lives.

## 5. Group settings moves into the targets panel

The `Group settings` toggle leaves the top bar and joins the targets panel
beside `Auto-Distribute`, in both the expanded row and the slim collapsed bar —
so it stays reachable from the bottom of a long table, like the other actions
there. The groups section itself still renders where it does now, below the
targets panel.

This also clears the top bar for §6.

## 6. Import and export as separate blocks

The top bar is one undifferentiated run of buttons divided by hairline
`.topbar-sep` rules, and the eye does not read a hairline as a boundary. The
actions become two labelled blocks carrying the targets panel's card treatment
— `1px solid var(--line)`, `border-radius: 6px`, `var(--surface)` background —
with a small uppercase caption in the type style `.targets-toggle` already
uses (11px, 600 weight, `0.04em` tracking, `--text-dim`):

```
┌ IMPORT ─────────────────┐  ┌ EXPORT ───────────────────────────────────┐
│ [Load sample] [Paste…]  │  │ [ref-weights-regular.tsv] [Copy TSV] [↓]  │  [Clear workspace]
└─────────────────────────┘  └───────────────────────────────────────────┘
```

`Clear workspace` sits outside both, at the far right: it belongs to neither
block, and a destructive action reads better with space around it than boxed in
with the ones you use constantly. `.topbar-sep` and its uses go away.

Each block wraps as a unit on a narrow viewport, which is better than today's
behaviour, where the separators can wrap away from what they were separating.

## Testing

- **`bars.test.ts`** — the new module carries the bulk of it: no collapsed
  groups reproduces today's bars exactly (equal-payout aggregation on and off,
  stacked segments across groups); collapsing a group replaces its buckets with
  one bar while leaving other groups' bars untouched; the group bar's placement
  equals the weight-weighted mean payout, and the plain mean when the group's
  weight is zero; an all-zero group's bar drops under Log X and is counted in
  `droppedZero`; ordering against loose bars is by placement.
- **Delta drag** — grabbing a bar at its base and at its top and moving the
  same number of pixels produces the same weights, which is the property the
  old absolute drag failed; a press with no movement commits nothing; the
  frozen scale still governs the move; Escape still cancels.
- **Value entry** — right-click opens the popover pre-filled with the current
  value; Enter commits one undo step with the typed weight; % Chance mode reads
  and writes percentages; an expression evaluates; an off-step table raises the
  notice and leaves the weights alone; Escape and click-away cancel.
- **Group locks** — `groupLockState` returns all/some/none; toggling a partial
  group locks every member in one commit and undo restores the exact prior lock
  set; a fully locked group's handle and bar are undraggable.
- **Group bars UI** — the chip row toggles a group in and out of `groupBars`,
  `All`/`None` set every group, the state survives a reload, and a group bar
  drag rescales exactly that group.
- **Layout** — the targets panel contains the group settings toggle in both
  collapsed and expanded states; the top bar renders an import block and an
  export block and no `.topbar-sep`.

## Out of scope

- The play/balance simulation — its own spec, next.
- A group-level `locked` flag in the data model; §3 explains why.
- Keyboard operation of the group handles and bars. They are pointer targets
  today and stay pointer targets; the value entry popover is the accessible
  path to an exact number.
- Reordering groups, which would change chart rank and the group sort.
- Zoom or pan on the distribution chart.
