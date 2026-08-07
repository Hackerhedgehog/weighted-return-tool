# Anchored tooltip, layout rework, and step remainders

Date: 2026-08-07

Follows `2026-08-07-chart-readout-and-resize-design.md`, which replaced both
charts' floating tooltips with a full-width readout strip. That fixed the
occlusion but lost the connection between the pointer and the numbers: the
strip is the same shape wherever you hover, so nothing ties the reading to the
bar it came from. This spec restores the bubble and anchors it under its bar,
then works through six further UI requests.

## 1. Anchored tooltip bubble

The readout goes back to being a floating bubble, positioned **at the hovered
bar's x, in the band below the plot**.

The two constraints are "Y position is right below the bar" and "the tooltip
cannot cover any of the bars in the chart". Only one position satisfies both:
below the bar's *base*, i.e. under the axis. Anywhere higher covers the bar it
describes (or, for a short bar, its taller neighbours). So the bubble lives in
a reserved band beneath the SVG — the same band the strip occupies now — but
sized to its content and centred on the bar rather than spanning the panel.

Horizontal clamping keeps it whole: `left` is the bar centre, clamped to
`[w/2 + PAD, containerWidth - w/2 - PAD]` where `w` is the bubble's own
measured width. Measurement is real, not assumed — a `useLayoutEffect` reads
`offsetWidth` off a ref and stores it, so a two-line tooltip and a five-line
tooltip each clamp against their true width. This is what the previous
implementation got wrong: it clamped against a hardcoded 110px guess, so wide
tooltips near an edge still overhung the panel.

The band keeps a fixed height so hovering never reflows the page, and is empty
when nothing is hovered — the permanent hint line goes away with the strip.

`ChartReadout` gains an optional `anchor?: number`. With it, the component
renders the bubble; without it, nothing. Both charts pass an anchor: the
distribution chart the bar centre, the simulation chart the crosshair x. The
simulation chart had a floating tooltip before this series of changes too, so
both go back to the same behaviour.

Content is unchanged: colored per-bucket title lines, then payout / weight /
chance / weighted for the distribution chart, block / block avg / RTP so far /
table RTP for the simulation chart.

## 2. Simulation chart resize in the empty state

The grip already exists but only renders alongside a real `SimChart`, so
before the first run there is nothing to drag — which reads as the feature
being missing. The pre-run placeholder gets the same height and the same grip,
so the panel can be sized before running anything.

## 3. Bucket table aligned right

The table's columns have fixed widths and the panel is a grid half, so when
the panel is wider than the columns the slack currently sits on the right,
leaving the table floating away from the chart it is read against. The table
moves to the right edge of its panel and the slack moves to the left:
`margin-left: auto` on `.grid-table`.

## 4. Auto-Distribute absorbs the step remainder

Today `solveWeights` refuses outright when the free weight is not divisible by
the step:

```ts
const freeWeight = Math.round(ctx.total - ctx.totalLocked)
if (freeWeight % step !== 0) {
  return { ...empty, warnings: [stepBlockWarning(freeWeight, ctx.totalLocked, step)] }
}
```

Instead it distributes `floor(freeWeight / step) * step` on-step as usual, then
adds the remainder `freeWeight % step` to a single bucket, so the grand total
is preserved exactly and every other weight stays a clean multiple of the step.

The remainder goes to the **lowest-payout unlocked bucket**. A bucket's
contribution to RTP is `payout × weight / total`, so the cheapest bucket
disturbs the solved RTP least — and with a 0x bucket present, which these
tables normally have, it disturbs it not at all. Ties break on the largest
weight, then on bucket id, so the choice is deterministic.

The blocking warning is replaced by an informational one naming the bucket and
the amount, since a weight that is deliberately off-step is worth knowing
about even though the operation now succeeds:

> Free weight 1,000,005 is not a multiple of 100 — distributed 1,000,000 on
> step and added the remaining 5 to `0x`.

`stepBlockWarning` stays: the totals-row and RTP-retarget paths still block,
and still need it. Only Auto-Distribute learns to continue.

## 5. One settings row

The targets panel's second row disappears. Weight step, Auto-Distribute and
Undo/Redo join Target RTP, the two chance targets, tolerance, volatility and
curve on a single wrapping row. The row already wraps (`flex-wrap: wrap`), so
a narrow viewport still degrades gracefully — this only removes the hard break
and the dashed separator.

## 6. Dynamic stacking

`.content` is a two-column grid with a 1200px media query. The table's default
columns total 712px, so below roughly 1500px the table is wider than its grid
track and — because `.panel.buckets` sets `overflow: visible` so a widened
table is not clipped out of reach — it overlaps the chart instead of stacking.
A fixed breakpoint cannot fix this properly, because column widths are
user-resizable and persisted: any threshold is wrong for some column layout.

So the grid becomes a **wrapping flex row**:

```css
.content { display: flex; flex-wrap: wrap; align-items: flex-start; }
.content > .targets,
.content > .panel.full { flex: 1 0 100%; }
.panel.buckets { flex: 1 1 auto; min-width: min-content; }
.panel.chart   { flex: 1 1 420px; min-width: 0; }
```

`min-width: min-content` on the table panel is what makes it dynamic: flex
refuses to shrink the panel below its table's real width, so the chart wraps
to the next line the moment the two no longer fit — at whatever width the
user's current columns imply. The 1200px query keeps its job of unsticking the
chart panel.

## 7. Sticky, collapsible targets

The targets panel becomes `position: sticky; top: 0`, so the settings stay
reachable down a long table, and collapsible so they can be got out of the way.

- Expanded: the settings row from §5, as now.
- Collapsed: a slim bar keeping the achieved RTP / hit chance / win chance
  badges and the Auto-Distribute, Undo and Redo buttons. Editing needs an
  expand; acting does not.

The toggle is a `<button aria-expanded>` at the left of the panel in both
states. Collapsed state persists in the workspace as an optional
`targetsCollapsed?: boolean`, default expanded.

**Sticky offsets have to agree.** Two other things are already sticky: the
grid's `thead th` at `top: 0` and `.panel.chart` at `top: 8px`. With a sticky
targets panel above them, both would slide underneath it. `App` measures the
targets panel with a `ResizeObserver` and publishes its height as a
`--targets-h` custom property on the app root; the two existing sticky offsets
become `calc(var(--targets-h, 0px) + …)`. Measuring rather than hardcoding is
required because the panel's height changes when it collapses, when the row
wraps, and when warnings appear.

## Testing

- **Tooltip:** bubble carries an anchored `left`; a bar at the left edge clamps
  its left edge to ≥ 0 and one at the right edge clamps to ≤ container width;
  the bubble is absent when nothing is hovered; content assertions from the
  previous spec still hold.
- **Empty simulation state:** the grip is present before a run and reports a
  height.
- **Remainder:** at step 100 with an off-step free weight, Auto-Distribute
  changes the weights, preserves the grand total exactly, leaves every bucket
  but one a multiple of 100, puts the remainder on the lowest-payout unlocked
  bucket, and warns without blocking. Locked rows keep their weights.
  A divisible total still produces all-on-step weights and no such warning.
- **Layout:** `.content` children order unchanged; the table panel carries
  `min-width: min-content`; the targets panel has one settings row containing
  weight step and Auto-Distribute.
- **Collapse:** toggling hides the inputs, keeps the badges and the action
  buttons, flips `aria-expanded`, and survives a reload.

## Out of scope

- Rewriting the solver's allocation to spread the remainder across several
  buckets — one bucket keeps the invariant simple and the warning honest.
- Making the chart panel collapsible too.
- Touching the totals-row and RTP-retarget step blocks; those still refuse.
