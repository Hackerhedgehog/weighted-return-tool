import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { BucketRow, ChartSettings, GroupDef, WeightStep } from '../lib/types'
import type { Grouping } from '../lib/groups'
import { buildBars, type ChartBar, type Segment } from '../lib/bars'
import { scaleSubset, setSubsetTotal } from '../lib/interact'
import { fmtPayout, fmtPct, fmtRtp, fmtWeight } from '../lib/format'
import { ChartReadout, type ReadoutStat, type ReadoutTitle } from './ChartReadout'
import { ChartValueEntry, type ValueEntryTarget } from './ChartValueEntry'
import { ChartResizeGrip } from './ChartResizeGrip'
import { ChartScrollbar } from './ChartScrollbar'
import { ChartXAxisZoom } from './ChartXAxisZoom'
import { ChartYAxisZoom } from './ChartYAxisZoom'
import { DIST_HEIGHT, linearBarWidth, logBarWidth, niceCeil, useContainerWidth } from './chartUtils'
import { useChartAxes } from './useChartAxes'
import { useCombinedWheelZoom } from './useCombinedWheelZoom'
import { useMiddleDragPan } from './useMiddleDragPan'

/**
 * The distribution chart is now a control surface as well as a picture:
 *
 *  - bars are colored by bucket group (stacked segments when an aggregated
 *    bar spans groups) and can be dragged vertically to change a bucket's
 *    weight or chance. The chip row above the plot (`GroupChips`) doubles
 *    as a legend and lets any group collapse into one solid bar instead of
 *    its buckets;
 *  - each group gets a handle on the right edge at the height of its total
 *    (in the current metric and axis mode), draggable like a bar, and
 *    carrying two locks: the padlock hard-locks every bucket in the group at
 *    once, while Σ soft-locks only the group's total — its bars stay
 *    draggable, compensating against each other inside the group, so the
 *    group's chance holds while its internal shape is played with;
 *  - drags are relative by default — other unlocked buckets absorb the
 *    change so the grand total (and Σchance == 1) holds. Weights mode can
 *    switch that off; chance mode cannot;
 *  - right-clicking a bar or a handle opens `ChartValueEntry`, a popover for
 *    typing an exact weight or chance. It commits through the same
 *    `scaleSubset` / `setSubsetTotal` path a drag commits through, so the two
 *    ways of setting a value can never disagree;
 *  - shift+left-click toggles a bar or handle into a selection (a dashed
 *    outline marks a selected bar, a highlighted chip marks a selected
 *    handle); dragging any selected item then moves every selected item by
 *    the same absolute amount in the current metric, each keeping its own
 *    value, just shifted by the same delta. A plain click elsewhere, or
 *    outside the chart entirely, clears the selection. Shift+left-click on
 *    empty plot background instead drags out a rubber-band box; every bar it
 *    overlaps on release joins the selection, additively like a single toggle.
 *
 * During a drag the pointer math and the rendered axis both use the scale
 * captured at pointer-down: recomputing the scale per move would rescale the
 * axis under the pointer and feed back into the drag. Previews stream
 * through onPreview; one onCommit fires at pointer-up (or from the popover's
 * Set) so undo sees a single step. Escape cancels a live drag.
 *
 * X and Y both support the same zoom/pan the simulation charts have — an
 * axis-margin drag/scroll zooms just that axis, scrolling the plot itself
 * zooms both together, middle-drag pans, and Reset View returns to the
 * auto-fit. X's domain is the bar ladder itself (bar index, or log payout
 * position when Log X is on); Y's domain is the current metric's value, with
 * zero always kept in view on a linear axis the way BankrollChart keeps its
 * zero line in view.
 */

interface DistributionChartProps {
  rows: BucketRow[]
  totalWeight: number
  chart: ChartSettings
  grouping: Grouping
  weightStep: WeightStep
  height: number
  /** The saved user curve (uid → share), drawn as a reference line; null when none saved. */
  userCurve: Record<string, number> | null
  onHeight: (h: number) => void
  /** Reset gesture on the grip — restores auto-fit rather than a fixed height. */
  onHeightReset?: () => void
  onPreview: (rows: BucketRow[] | null) => void
  onCommit: (rows: BucketRow[]) => void
  /** 'off-step' when the table can't be partitioned on the step, 'pinned' when locks leave nothing free to move. */
  onBlocked: (reason: 'off-step' | 'pinned') => void
  onGroupLock: (id: string, locked: boolean) => void
  /** Group ids whose total weight is soft-locked (GroupDef.totalLocked). */
  softLocked: ReadonlySet<string>
  onGroupSoftLock: (id: string, locked: boolean) => void
  /** Multiplies the auto-fit ceiling; 1 is auto, <1 zooms in, >1 zooms out. */
  yZoom: number
  onYZoom: (z: number) => void
  /** Fraction of the auto-fit ceiling the view is centered away from default; see chartView.ts. */
  yPan: number
  onYPan: (p: number) => void
  xZoom: number
  onXZoom: (z: number) => void
  xPan: number
  onXPan: (p: number) => void
}

interface Scale {
  frac: (v: number) => number
  invert: (f: number) => number
  ticks: { frac: number; label: string }[]
}

/** One selected or dragged item, in the shape weightsForValue needs. */
interface DragItem {
  uids: string[]
  value: number
}

interface DragState {
  baseRows: BucketRow[]
  baseTotal: number
  /** The dragged item first, any other selected items after it. */
  items: DragItem[]
  scale: Scale
  /** Pointer y at press, and the anchor item's own position on the frozen axis. */
  startY: number
  startFrac: number
  moved: boolean
  lastRows: BucketRow[] | null
  blockedNotified: boolean
}

// Bottom holds a row of diagonal tick labels, so it is deeper than the rest.
const MARGIN = { top: 18, right: 150, bottom: 68, left: 64 }
const HANDLE_GAP = 30
const SEGMENT_GAP = 2

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

/** A scale over a plain linear window `[viewMin, viewMax]` — used for the linear metric axis. */
function buildLinearScale(viewMin: number, viewMax: number, label: (v: number) => string): Scale {
  const span = Math.max(1e-9, viewMax - viewMin)
  return {
    frac: (v) => clamp((v - viewMin) / span, 0, 1),
    invert: (f) => viewMin + Math.max(0, f) * span,
    ticks: [0, 0.25, 0.5, 0.75, 1].map((t) => ({ frac: t, label: label(viewMin + t * span) })),
  }
}

/** A scale over a window of decades `[uLo, uHi]` (both log10 exponents) — used for the log metric axis. */
function buildLogScale(uLo: number, uHi: number, label: (v: number) => string): Scale {
  const span = Math.max(1e-9, uHi - uLo)
  const ticks: { frac: number; label: string }[] = []
  for (let e = Math.ceil(uLo); e <= Math.floor(uHi); e++) {
    ticks.push({ frac: (e - uLo) / span, label: label(Math.pow(10, e)) })
  }
  return {
    frac: (v) => (v <= 0 ? 0 : clamp((Math.log10(v) - uLo) / span, 0.015, 1)),
    // Below the axis floor there is nothing to point at but zero.
    invert: (f) => (f <= 0.02 ? 0 : Math.pow(10, uLo + f * span)),
    ticks,
  }
}

/** Push overlapping handle labels apart, keeping them inside [lo, hi]. */
function spreadPositions(ys: number[], gap: number, lo: number, hi: number): number[] {
  const order = ys.map((y, i) => ({ y: clamp(y, lo, hi), i })).sort((a, b) => a.y - b.y)
  let prev = -Infinity
  for (const p of order) {
    p.y = Math.max(p.y, lo, prev + gap)
    prev = p.y
  }
  let bound = hi
  for (let k = order.length - 1; k >= 0; k--) {
    order[k].y = Math.min(order[k].y, bound)
    bound = order[k].y - gap
  }
  const out = new Array<number>(ys.length)
  for (const p of order) out[p.i] = p.y
  return out
}

/** Imperative surface for header controls App.tsx renders outside this component. */
export interface DistributionChartHandle {
  /** Restores the auto-fit view — the same reset the ⚙-less Reset view button always triggered. */
  resetView: () => void
}

export const DistributionChart = forwardRef<DistributionChartHandle, DistributionChartProps>(
  function DistributionChart(
    {
      rows,
      totalWeight,
      chart,
      grouping,
      weightStep,
      height,
      userCurve,
      onHeight,
      onHeightReset,
      onPreview,
      onCommit,
      onBlocked,
      onGroupLock,
      softLocked,
      onGroupSoftLock,
      yZoom,
      onYZoom,
      yPan,
      onYPan,
      xZoom,
      onXZoom,
      xPan,
      onXPan,
    },
    ref,
  ) {
  const [containerRef, width] = useContainerWidth()
  const [hover, setHover] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const dragRef = useRef<DragState | null>(null)
  /**
   * The scale frozen at pointer-down, in state because rendering uses it —
   * the pointer-session data itself stays in a ref for the handlers.
   * Non-null exactly while a drag is live.
   */
  const [dragScale, setDragScale] = useState<Scale | null>(null)
  /** Non-null while the exact-value popover is open. */
  const [entry, setEntry] = useState<
    { target: ValueEntryTarget; x: number; y: number; containerHeight: number } | null
  >(null)
  /** Bars/handles toggled on with shift+click; a drag on any of them moves them all. */
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  /**
   * Shift+drag on empty plot background: a rubber-band box, in svg-pixel
   * coordinates. Live state so it renders; the ref just tells pointer-move
   * whether a box is in progress without waiting for the render it triggers.
   */
  const [boxSel, setBoxSel] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(
    null,
  )

  const { metric, logY, logX, aggregate, relative, groupBars, xOrder, xLabels } = chart

  const clearSelection = () => setSelected((prev) => (prev.size === 0 ? prev : new Set()))
  const toggleSelected = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dragRef.current !== null) {
        dragRef.current = null
        setDragScale(null)
        onPreview(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onPreview])

  // "Left clicking outside of the chart" clears the selection, wherever
  // outside the chart that click lands — not just clicks the plot itself
  // catches. A plain click on the plot's own empty space is handled by the
  // background rect below; this is the wider net.
  useEffect(() => {
    const onPointerDownWindow = (e: PointerEvent) => {
      if (e.button !== 0) return
      const el = containerRef.current
      if (el !== null && !el.contains(e.target as Node)) clearSelection()
    }
    window.addEventListener('pointerdown', onPointerDownWindow)
    return () => window.removeEventListener('pointerdown', onPointerDownWindow)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const { bars, droppedZero } = useMemo(
    () => buildBars(rows, grouping, totalWeight, { aggregate, groupBars, logX, xOrder }),
    [rows, grouping, totalWeight, aggregate, groupBars, logX, xOrder],
  )

  const plotW = width - MARGIN.left - MARGIN.right
  const plotH = height - MARGIN.top - MARGIN.bottom
  const plotRight = width - MARGIN.right

  const valueOf = (b: ChartBar) => (metric === 'weights' ? b.weight : b.chance)

  /** Group totals drive the handles and stretch the axis to hold them. */
  const groupStats = useMemo(() => {
    const byUid = new Map(rows.map((r) => [r.uid, r]))
    return grouping.groups.map((g) => {
      let weight = 0
      let weightedValue = 0
      let allLocked = true
      let anyLocked = false
      for (const uid of g.uids) {
        const r = byUid.get(uid)
        if (r === undefined) continue
        weight += r.weight
        weightedValue += r.payout * r.weight
        if (!r.locked) allLocked = false
        if (r.locked) anyLocked = true
      }
      const chance = totalWeight > 0 ? weight / totalWeight : 0
      return {
        group: g,
        weight,
        chance,
        value: metric === 'weights' ? weight : chance,
        weightedValue: totalWeight > 0 ? weightedValue / totalWeight : 0,
        allLocked,
        anyLocked,
      }
    })
  }, [rows, grouping, totalWeight, metric])

  /**
   * The un-zoomed baseline for the Y axis: a nice linear ceiling, or (Log Y)
   * the decade span the data needs. `useChartAxes` multiplies/pans around
   * this exactly like SimChart/BankrollChart multiply/pan around autoYMax —
   * zoom=1, pan=0 reproduces it exactly, so the chart's default view is
   * unchanged from before zoom/pan existed.
   */
  const yBaseline = useMemo(() => {
    const values = [...bars.map(valueOf), ...groupStats.map((s) => s.value)]
    const positive = values.filter((v) => v > 0)
    const maxVal = positive.length > 0 ? Math.max(...positive) : 1
    if (logY) {
      const minVal = positive.length > 0 ? Math.min(...positive) : 1e-6
      const maxE = Math.ceil(Math.log10(maxVal))
      const minE = Math.min(Math.floor(Math.log10(minVal)), maxE - 1)
      const span = maxE - minE + 0.35
      return { kind: 'log' as const, span, baseMin: minE - 0.35 }
    }
    return { kind: 'linear' as const, niceMax: niceCeil(maxVal) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, groupStats, logY, metric])

  const n = bars.length

  /** Natural-log payout of every bar, for Log X placement — computed once regardless of logX. */
  const logsArr = useMemo(() => bars.map((b) => Math.log(b.payout)), [bars])

  /**
   * The un-zoomed baseline for the X axis: bar count on a linear ladder, or
   * (Log X) the natural-log payout span the bars occupy. Shifted to start at
   * 0 either way, so `useChartAxes`'s zero-based extent math applies exactly
   * as it does to SimChart/BankrollChart's spins domain.
   */
  const xBaseline = useMemo(() => {
    if (!logX) return { lo: 0, extent: Math.max(1, n) }
    const lo = logsArr.length > 0 ? Math.min(...logsArr) : 0
    const hi = logsArr.length > 0 ? Math.max(...logsArr) : 0
    return { lo, extent: Math.max(1e-9, hi - lo) }
  }, [logX, n, logsArr])

  const yAutoMax = yBaseline.kind === 'log' ? yBaseline.span : yBaseline.niceMax

  const axes = useChartAxes({
    xExtent: xBaseline.extent,
    xZoom,
    onXZoom,
    xPan,
    onXPan,
    autoYMax: yAutoMax,
    trueYMax: yAutoMax,
    yZoom,
    onYZoom,
    yPan,
    onYPan,
    // Zero is always somewhere on a linear metric axis (weight/chance can't
    // go negative) — keep it in view like BankrollChart does. A log axis has
    // no zero to keep visible; it just pans/zooms across decades.
    keepZeroVisible: yBaseline.kind === 'linear',
  })

  // Header controls (group bars, reset view, save/clear curve) live in
  // App.tsx's shared panel head, not in this component — resetView is the
  // one piece of that toolbar that only exists once the axes are built here.
  useImperativeHandle(ref, () => ({ resetView: axes.resetView }), [axes.resetView])

  const liveScale = useMemo(() => {
    const label = (v: number) => (metric === 'weights' ? fmtWeight(v) : fmtPct(v, 3))
    if (yBaseline.kind === 'log') {
      return buildLogScale(yBaseline.baseMin + axes.viewY.min, yBaseline.baseMin + axes.viewY.max, label)
    }
    return buildLinearScale(axes.viewY.min, axes.viewY.max, label)
  }, [yBaseline, axes.viewY.min, axes.viewY.max, metric])

  // While dragging, both the pointer math and the picture use the scale
  // captured at pointer-down.
  const scale = dragScale ?? liveScale
  const dragging = dragScale !== null

  const yOf = (v: number) => MARGIN.top + plotH * (1 - scale.frac(v))

  /** Bar centres: evenly spaced across the visible index window, or placed by log payout. */
  const domainValue = (i: number) => (logX ? logsArr[i] - xBaseline.lo : i + 0.5)
  const xSpan = Math.max(1e-9, axes.viewX.max - axes.viewX.min)
  const xOf = (dv: number) => MARGIN.left + ((dv - axes.viewX.min) / xSpan) * plotW

  const centres = useMemo(
    () => bars.map((_, i) => xOf(domainValue(i))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bars, logX, axes.viewX.min, axes.viewX.max, plotW, xBaseline, logsArr],
  )

  const pixelsPerUnit = plotW / xSpan

  const barW = useMemo(() => {
    if (!logX) return linearBarWidth(pixelsPerUnit)
    let gap = plotW
    for (let i = 1; i < centres.length; i++) gap = Math.min(gap, centres[i] - centres[i - 1])
    // A single bar leaves no gap to measure; logBarWidth falls back for 0.
    return logBarWidth(gap === plotW ? 0 : gap)
  }, [logX, pixelsPerUnit, centres, plotW])

  /** Bars fully outside the visible window are skipped, not just clipped — otherwise their hit-rects would still catch clicks meant for the margins. */
  const inView = (i: number) => centres[i] + barW / 2 >= MARGIN.left && centres[i] - barW / 2 <= plotRight

  // ---- pan / zoom ----

  const middleDragPan = useMiddleDragPan({
    xZoom,
    xPan: axes.xPan,
    onXPan: axes.setXPan,
    yZoom,
    yPan: axes.yPan,
    onYPan: axes.setYPan,
    plotW,
    plotH,
  })

  // Scrolling on the plot itself zooms both axes together; scrolling on
  // either axis's own margin (ChartXAxisZoom/ChartYAxisZoom below) still
  // zooms just that one axis — those are separate elements outside this ref.
  const wheelZoomRef = useCombinedWheelZoom<SVGGElement>({ xZoom, onXZoom, yZoom, onYZoom })

  // ---- dragging ----

  /** uid → soft-locked group id, for every member of a soft-locked group. */
  const softByUid = useMemo(() => {
    const m = new Map<string, string>()
    if (softLocked.size === 0) return m
    for (const g of grouping.groups) {
      if (!softLocked.has(g.id)) continue
      for (const uid of g.uids) m.set(uid, g.id)
    }
    return m
  }, [grouping, softLocked])

  /**
   * The soft-locked group that contains every dragged uid, as a pool for
   * `scaleSubset` — or null when the drag is not confined. A drag confined to
   * one soft-locked group exchanges weight only inside it; anything else
   * (a plain bar, another group's handle, an aggregated bar spanning groups)
   * must not touch a soft-locked group's members at all, which
   * `weightsForValue` handles by freezing them.
   */
  const poolFor = (uids: string[]): string[] | null => {
    if (uids.length === 0) return null
    const gid = softByUid.get(uids[0])
    if (gid === undefined) return null
    if (!uids.every((u) => softByUid.get(u) === gid)) return null
    return grouping.groups.find((g) => g.id === gid)?.uids ?? null
  }

  /**
   * The three-way rule that turns a value into a subset's weights: chance
   * mode scales to a fraction of the frozen total, weights mode scales
   * relatively when the toggle is on, and otherwise sets the subset's
   * absolute total. The drag and the typed-value popover both funnel through
   * this one rule, so they can never compute the result differently — the
   * caller supplies the row set and its total rather than this closing over
   * `rows`, since a drag operates on the rows frozen at pointer-down while the
   * popover operates on whatever is current.
   *
   * Soft locks refine it twice. A drag confined to one soft-locked group is
   * always the pool form, whatever the relativity toggle says — the absolute
   * form would move the group total, the very thing the lock pins. And in any
   * other drag, soft-locked members are frozen like locked rows, so neither a
   * dragged aggregate nor the relative compensation can leak weight across a
   * pinned group boundary.
   */
  const weightsForValue = (
    baseRows: BucketRow[],
    uids: string[],
    baseTotal: number,
    value: number,
  ): number[] | null => {
    const pool = poolFor(uids)
    if (pool !== null) {
      const target = metric === 'chance' ? clamp(value, 0, 1) * baseTotal : value
      return scaleSubset(baseRows, uids, target, weightStep, pool)
    }

    const eff =
      softByUid.size === 0
        ? baseRows
        : baseRows.map((r) => (softByUid.has(r.uid) && !r.locked ? { ...r, locked: true } : r))
    if (metric === 'chance') return scaleSubset(eff, uids, clamp(value, 0, 1) * baseTotal, weightStep)
    if (relative) return scaleSubset(eff, uids, value, weightStep)
    return setSubsetTotal(eff, uids, value, weightStep)
  }

  const barKey = (b: ChartBar) => `bar:${b.uids.join('|')}`
  const handleKey = (g: GroupDef) => `handle:${g.id}`

  /** Pointer position in the svg's own pixel coordinates — same space xOf/yOf render in. */
  const svgPoint = (e: React.PointerEvent) => {
    const r = svgRef.current?.getBoundingClientRect()
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) }
  }

  /** A bar's own rect in svg pixels, top/bottom regardless of which is numerically smaller. */
  const barRect = (b: ChartBar, i: number) => {
    const v = valueOf(b)
    const a = yOf(0)
    const c = yOf(v)
    return {
      left: centres[i] - barW / 2,
      right: centres[i] + barW / 2,
      top: Math.min(a, c),
      bottom: Math.max(a, c),
    }
  }

  /**
   * A shift+pointerdown is ambiguous until it either releases in place (a
   * plain toggle, `toggleKey`) or moves past the threshold (a rubber-band
   * box, `toggleKey` dropped). This is why shift+click on a single bar still
   * works even though bar-hit rects tile the entire plot — there is no empty
   * background behind them for a box-drag to start from otherwise, so the
   * same pointerdown that would toggle one item is also the one that can
   * grow into a box.
   */
  const MOVE_THRESHOLD = 4
  const shiftRef = useRef<{ x0: number; y0: number; moved: boolean; toggleKey: string | null } | null>(
    null,
  )

  const beginShift = (e: React.PointerEvent, toggleKey: string | null) => {
    if (e.button !== 0) return
    e.preventDefault()
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    const p = svgPoint(e)
    shiftRef.current = { x0: p.x, y0: p.y, moved: false, toggleKey }
    setBoxSel({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
  }

  const moveShift = (e: React.PointerEvent) => {
    const s = shiftRef.current
    if (s === null) return
    const p = svgPoint(e)
    if (!s.moved && Math.hypot(p.x - s.x0, p.y - s.y0) >= MOVE_THRESHOLD) s.moved = true
    setBoxSel({ x0: s.x0, y0: s.y0, x1: p.x, y1: p.y })
  }

  /** A bar/handle's move and up route to the live shift gesture when one is in progress, else to the ordinary value-drag. */
  const routeMove = (e: React.PointerEvent) => (shiftRef.current !== null ? moveShift(e) : moveDrag(e))
  const routeUp = () => (shiftRef.current !== null ? endShift() : endDrag())

  /** No movement: the plain single-item toggle. Moved past the threshold: every in-view bar the box overlaps joins the selection, additively. */
  const endShift = () => {
    const s = shiftRef.current
    shiftRef.current = null
    const box = boxSel
    setBoxSel(null)
    if (s === null) return
    if (!s.moved) {
      if (s.toggleKey !== null) toggleSelected(s.toggleKey)
      return
    }
    if (box === null) return
    const xLo = Math.min(box.x0, box.x1)
    const xHi = Math.max(box.x0, box.x1)
    const yLo = Math.min(box.y0, box.y1)
    const yHi = Math.max(box.y0, box.y1)
    setSelected((prev) => {
      const next = new Set(prev)
      bars.forEach((b, i) => {
        if (!inView(i) || b.allLocked) return
        const r = barRect(b, i)
        if (r.right >= xLo && r.left <= xHi && r.bottom >= yLo && r.top <= yHi) next.add(barKey(b))
      })
      return next
    })
  }

  /** Every selectable item's current uids/value/disabled state, keyed the same way selection is. */
  const itemsByKey = useMemo(() => {
    const m = new Map<string, { uids: string[]; value: number; disabled: boolean }>()
    for (const b of bars) m.set(barKey(b), { uids: b.uids, value: valueOf(b), disabled: b.allLocked })
    for (const s of groupStats) {
      const soft = softLocked.has(s.group.id)
      m.set(handleKey(s.group), { uids: s.group.uids, value: s.value, disabled: s.allLocked || soft })
    }
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, groupStats, metric, softLocked])

  /**
   * `currentValue` is the anchor's value in the chart's current metric. It is
   * what makes the drag relative: the value moves by the pointer's delta from
   * where it started, so pressing on a bar never changes it and a bar can be
   * grabbed anywhere along its length. `extraKeys` are the rest of a live
   * multi-selection — every other selected item moves by the same delta the
   * anchor does, each keeping its own starting value.
   */
  const beginDrag = (
    e: React.PointerEvent,
    uids: string[],
    disabled: boolean,
    currentValue: number,
    extraKeys: string[] = [],
  ) => {
    if (disabled || e.button !== 0) return
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    const extraItems: DragItem[] = extraKeys
      .map((k) => itemsByKey.get(k))
      .filter((it): it is { uids: string[]; value: number; disabled: boolean } => it !== undefined && !it.disabled)
      .map((it) => ({ uids: it.uids, value: it.value }))
    dragRef.current = {
      baseRows: rows,
      baseTotal: rows.reduce((a, r) => a + Math.max(0, Math.round(r.weight)), 0),
      items: [{ uids, value: currentValue }, ...extraItems],
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
    const anchorNewValue = d.scale.invert(f)
    // Every selected item (the anchor included) shifts by the same delta the
    // anchor moved, so each keeps whatever difference it started with.
    const delta = anchorNewValue - d.items[0].value

    let next = d.baseRows
    let anyBlocked = false
    for (const item of d.items) {
      const weights = weightsForValue(next, item.uids, d.baseTotal, item.value + delta)
      if (weights === null) {
        anyBlocked = true
        continue
      }
      next = next.map((r, i) => (r.weight === weights[i] ? r : { ...r, weight: weights[i] }))
    }

    if (anyBlocked && !d.blockedNotified) {
      d.blockedNotified = true
      onBlocked('off-step')
    }
    // A lone dragged item that cannot move leaves nothing to preview — the
    // same behaviour a single-item drag always had. A multi-selection
    // previews whatever subset of it could move.
    if (anyBlocked && d.items.length === 1) return

    d.moved = true
    d.lastRows = next
    onPreview(next)
  }

  const endDrag = () => {
    const d = dragRef.current
    dragRef.current = null
    setDragScale(null)
    if (d === null) return
    if (d.moved && d.lastRows !== null) onCommit(d.lastRows)
    else if (d.moved) onPreview(null)
  }

  /**
   * The typed-value path. Deliberately the same rule the drag uses, so the
   * weight step, the locked rows and the grand-total invariant cannot drift
   * apart between the two ways of setting a value.
   */
  const commitValue = (uids: string[], value: number): boolean => {
    const baseTotal = rows.reduce((a, r) => a + Math.max(0, Math.round(r.weight)), 0)
    const target = metric === 'chance' ? value / 100 : value
    const weights = weightsForValue(rows, uids, baseTotal, target)
    if (weights === null) {
      onBlocked('off-step')
      return false
    }
    // scaleSubset has a second refusal mode that isn't `null`: with no unlocked
    // row on one side of the subset, the grand-total invariant pins the total
    // exactly where it is and it hands back the weights unchanged. Compare with
    // the same normalisation interact.ts applies on the way in, so a fractional
    // stored weight can't read as a spurious change and mask a real refusal.
    const unchanged = rows.every((r, i) => Math.max(0, Math.round(r.weight)) === weights[i])
    if (unchanged) {
      onBlocked('pinned')
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
      containerHeight: rect?.height ?? 0,
    })
  }

  /** Plain click (no shift) on a bar/handle: drag the whole selection if this item is in it, else start a fresh single drag and drop the old selection. */
  const onItemPointerDown = (
    e: React.PointerEvent,
    key: string,
    uids: string[],
    disabled: boolean,
    value: number,
  ) => {
    if (e.button !== 0) return
    if (e.shiftKey) {
      beginShift(e, disabled ? null : key)
      return
    }
    if (!disabled && selected.has(key) && selected.size > 0) {
      beginDrag(e, uids, false, value, [...selected].filter((k) => k !== key))
      return
    }
    if (selected.size > 0) clearSelection()
    beginDrag(e, uids, disabled, value)
  }

  // ---- handle layout ----

  const handleYs = useMemo(() => {
    const raw = groupStats.map((s) => MARGIN.top + plotH * (1 - scale.frac(s.value)))
    return {
      raw,
      spread: spreadPositions(raw, HANDLE_GAP, MARGIN.top + 12, MARGIN.top + plotH - 12),
    }
  }, [groupStats, scale, plotH])

  // Diagonal labels pack far tighter than horizontal ones did — ~16px pitch.
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 16))))
  const hovered = hover !== null && hover < bars.length ? bars[hover] : null

  /** The x tick under a bar: group name, bucket label, or payout. */
  const tickLabel = (b: ChartBar) =>
    b.kind === 'group'
      ? b.name
      : xLabels === 'label'
        ? b.labels.length === 1
          ? b.labels[0]
          : `${b.labels.length} buckets`
        : `×${fmtPayout(b.payout)}`

  /** What the popover calls a bar: its label when there is one, else a summary. */
  const barTitle = (b: ChartBar) =>
    b.kind === 'group'
      ? b.name
      : b.labels.length === 1
        ? b.labels[0]
        : `${b.labels.length} buckets · ×${fmtPayout(b.payout)}`

  /**
   * Labels are colored per bucket, not per bar segment: segments are merged by
   * group and reordered by rank, so an aggregated bar spanning two groups has
   * to look each bucket's color up by uid to keep line and color in step.
   */
  const readoutTitles: ReadoutTitle[] =
    hovered === null
      ? []
      : hovered.labels.map((text, i) => ({
          text,
          color: grouping.byUid.get(hovered.uids[i])?.color,
        }))

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

  return (
    <>
      <div className="chart-wrap" ref={containerRef}>
        {n === 0 ? (
          <div className="chart-empty">No buckets to plot.</div>
        ) : (
          <>
            <svg width={width} height={height} role="img" aria-label="Bucket distribution" ref={svgRef}>
              {scale.ticks.map((t, i) => {
                const y = MARGIN.top + plotH * (1 - t.frac)
                return (
                  <g key={i}>
                    <line className="grid-line" x1={MARGIN.left} x2={plotRight} y1={y} y2={y} />
                    <text className="axis-label" x={MARGIN.left - 8} y={y + 4} textAnchor="end">
                      {t.label}
                    </text>
                  </g>
                )
              })}

              <line className="axis-line" x1={MARGIN.left} x2={plotRight} y1={yOf(0)} y2={yOf(0)} />

              {/* everything that reacts to pointer/wheel input over the plot, so a
                  middle-drag or a plot-wheel started anywhere in here (including
                  over a bar or handle) still reaches the pan/zoom handlers below */}
              <g ref={wheelZoomRef} {...middleDragPan}>
                {/* empty plot background — catches a plain click that lands on
                    nothing, to clear the selection */}
                <rect
                  className="dist-plot-bg"
                  x={MARGIN.left}
                  y={MARGIN.top}
                  width={Math.max(0, plotW)}
                  height={Math.max(0, plotH)}
                  fill="transparent"
                  onPointerDown={(e) => {
                    if (e.button !== 0) return
                    if (e.shiftKey) beginShift(e, null)
                    else clearSelection()
                  }}
                  onPointerMove={moveShift}
                  onPointerUp={endShift}
                  onPointerCancel={endShift}
                />

                {bars.map((b, i) => {
                  if (!inView(i)) return null
                  const v = valueOf(b)
                  const x0 = centres[i] - barW / 2
                  const y0 = yOf(0)
                  const rawHeight = y0 - yOf(v)
                  // v > 0 keeps at least a sliver, so tiny buckets stay visible
                  const barHeight = Math.max(rawHeight, v > 0 ? 1.5 : 0)
                  const selectedCls = selected.has(barKey(b)) ? 'selected' : ''

                  if (b.segments.length <= 1) {
                    return (
                      <rect
                        key={i}
                        className={`bar ${hover === i ? 'hover' : ''} ${selectedCls}`}
                        x={x0}
                        y={y0 - barHeight}
                        width={barW}
                        height={barHeight}
                        rx={1.5}
                        style={{ fill: b.segments[0]?.color ?? 'var(--bar)' }}
                      />
                    )
                  }

                  // Stacked segments: the bar's height shows the (possibly log)
                  // total; the interior split shows linear composition shares.
                  const segValue = (s: Segment) => (metric === 'weights' ? s.weight : s.chance)
                  const totalV = b.segments.reduce((a, s) => a + segValue(s), 0)
                  const gaps = SEGMENT_GAP * (b.segments.length - 1)
                  const avail = Math.max(0, barHeight - gaps)
                  let yCursor = y0
                  return (
                    <g key={i}>
                      {b.segments.map((s, k) => {
                        const hk = totalV > 0 ? (segValue(s) / totalV) * avail : 0
                        yCursor -= hk
                        const rect = (
                          <rect
                            key={k}
                            className={`bar ${hover === i ? 'hover' : ''} ${selectedCls}`}
                            x={x0}
                            y={yCursor}
                            width={barW}
                            height={Math.max(hk, 0)}
                            rx={1.5}
                            style={{ fill: s.color }}
                          />
                        )
                        yCursor -= SEGMENT_GAP
                        return rect
                      })}
                    </g>
                  )
                })}

                {/* The saved user curve, as a dashed reference line over the
                    bars — visible even when the solve deviates from it, which
                    is exactly when it is worth seeing. */}
                {userCurve !== null &&
                  (() => {
                    const pts: string[] = []
                    bars.forEach((b, i) => {
                      if (!inView(i)) return
                      const share = b.uids.reduce((a, u) => a + (userCurve[u] ?? NaN), 0)
                      if (!Number.isFinite(share)) return
                      const v = metric === 'weights' ? share * totalWeight : share
                      pts.push(`${centres[i]},${yOf(v)}`)
                    })
                    return pts.length >= 2 ? (
                      <polyline
                        className="user-curve-line"
                        points={pts.join(' ')}
                        fill="none"
                        pointerEvents="none"
                      />
                    ) : null
                  })()}

                {bars.map((b, i) =>
                  // Group bars are the coarse landmarks of the view and there are
                  // few of them, so they are never thinned out.
                  inView(i) && (b.kind === 'group' || i % labelEvery === 0) ? (
                    <text
                      key={i}
                      className="axis-label diag"
                      x={centres[i]}
                      y={height - MARGIN.bottom + 14}
                      transform={`rotate(-45 ${centres[i]} ${height - MARGIN.bottom + 14})`}
                      textAnchor="end"
                    >
                      {tickLabel(b)}
                    </text>
                  ) : null,
                )}

                {/* group handles, right edge */}
                {groupStats.map((s, gi) => {
                  const yExact = handleYs.raw[gi]
                  const yLabel = handleYs.spread[gi]
                  // A soft lock pins exactly what the handle drags — the group
                  // total — so the handle is inert while the bars stay live.
                  const soft = softLocked.has(s.group.id)
                  const pinned = s.allLocked || soft
                  const key = handleKey(s.group)
                  return (
                    <g
                      key={s.group.id}
                      className={`group-handle ${pinned ? 'disabled' : ''} ${selected.has(key) ? 'selected' : ''}`}
                      role="slider"
                      aria-label={`${s.group.name} group`}
                      aria-disabled={pinned || undefined}
                      aria-valuemin={0}
                      aria-valuemax={metric === 'weights' ? Math.round(totalWeight) : 100}
                      aria-valuenow={
                        metric === 'weights' ? Math.round(s.weight) : Math.round(s.chance * 1000) / 10
                      }
                      onPointerDown={(e) => onItemPointerDown(e, key, s.group.uids, pinned, s.value)}
                      onPointerMove={routeMove}
                      onPointerUp={routeUp}
                      onPointerCancel={routeUp}
                      onContextMenu={(e) => openEntry(e, s.group.name, s.group.uids, s.value, pinned)}
                    >
                      <line
                        className="handle-connector"
                        x1={plotRight}
                        y1={yExact}
                        x2={plotRight + 10}
                        y2={yLabel}
                      />
                      <rect
                        className="handle-chip"
                        x={plotRight + 10}
                        y={yLabel - 11}
                        width={8}
                        height={22}
                        rx={2}
                        style={{ fill: s.group.color }}
                      />
                      <text className="handle-name" x={plotRight + 24} y={yLabel - 1}>
                        {s.group.name} · {metric === 'weights' ? fmtWeight(s.weight) : fmtPct(s.chance, 2)}
                      </text>
                      <text className="handle-sub" x={plotRight + 24} y={yLabel + 11}>
                        wv {fmtRtp(s.weightedValue)}
                      </text>
                      <rect
                        className="handle-hit"
                        x={plotRight + 6}
                        y={yLabel - 15}
                        width={MARGIN.right - 10}
                        height={30}
                        fill="transparent"
                      />
                      <g
                        role="button"
                        tabIndex={0}
                        className={`handle-lock ${s.allLocked ? 'on' : ''} ${!s.allLocked && s.anyLocked ? 'partial' : ''}`}
                        aria-label={`${s.allLocked ? 'Unlock' : 'Hard-lock'} the ${s.group.name} group`}
                        // The padlock sits inside the handle's drag target, so
                        // its press must not also start a drag, and its own
                        // context menu must not also open the handle's popover.
                        onPointerDown={(e) => e.stopPropagation()}
                        onContextMenu={(e) => e.stopPropagation()}
                        onClick={() => onGroupLock(s.group.id, !s.allLocked)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') onGroupLock(s.group.id, !s.allLocked)
                          else if (e.key === ' ') {
                            e.preventDefault()
                            onGroupLock(s.group.id, !s.allLocked)
                          }
                        }}
                      >
                        <title>
                          {s.allLocked
                            ? 'Unlock every bucket in this group'
                            : 'Hard lock: freeze every bucket in this group'}
                        </title>
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
                      <g
                        role="button"
                        tabIndex={0}
                        className={`handle-lock handle-soft ${soft ? 'on' : ''}`}
                        aria-label={`${soft ? 'Release' : 'Soft-lock'} the ${s.group.name} group total`}
                        onPointerDown={(e) => e.stopPropagation()}
                        onContextMenu={(e) => e.stopPropagation()}
                        onClick={() => onGroupSoftLock(s.group.id, !soft)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') onGroupSoftLock(s.group.id, !soft)
                          else if (e.key === ' ') {
                            e.preventDefault()
                            onGroupSoftLock(s.group.id, !soft)
                          }
                        }}
                      >
                        <title>
                          {soft
                            ? 'Release the group total — the handle drags again'
                            : 'Soft lock: pin the group total, keep its buckets draggable against each other'}
                        </title>
                        <rect
                          x={plotRight + MARGIN.right - 48}
                          y={yLabel - 10}
                          width={20}
                          height={20}
                          rx={3}
                          fill="transparent"
                        />
                        <text
                          className="handle-soft-glyph"
                          x={plotRight + MARGIN.right - 38}
                          y={yLabel + 4}
                          textAnchor="middle"
                        >
                          Σ
                        </text>
                      </g>
                    </g>
                  )
                })}

                {/* hover + drag targets over the bars */}
                {bars.map((b, i) => {
                  if (!inView(i)) return null
                  const key = barKey(b)
                  return (
                    <rect
                      key={i}
                      className={`bar-hit ${selected.has(key) ? 'selected' : ''}`}
                      x={centres[i] - Math.max(barW, logX ? barW : pixelsPerUnit) / 2}
                      y={MARGIN.top}
                      width={Math.max(barW, logX ? barW : pixelsPerUnit)}
                      height={plotH}
                      fill="transparent"
                      style={{ cursor: b.allLocked ? 'default' : 'ns-resize' }}
                      onMouseEnter={() => {
                        if (!dragging) setHover(i)
                      }}
                      onMouseLeave={() => setHover(null)}
                      onPointerDown={(e) => onItemPointerDown(e, key, b.uids, b.allLocked, valueOf(b))}
                      onPointerMove={routeMove}
                      onPointerUp={routeUp}
                      onPointerCancel={routeUp}
                      onContextMenu={(e) => openEntry(e, barTitle(b), b.uids, valueOf(b), b.allLocked)}
                    />
                  )
                })}

                {/* the rubber-band box itself, drawn on top while shift+drag is live */}
                {boxSel !== null && (
                  <rect
                    className="dist-box-select"
                    x={Math.min(boxSel.x0, boxSel.x1)}
                    y={Math.min(boxSel.y0, boxSel.y1)}
                    width={Math.abs(boxSel.x1 - boxSel.x0)}
                    height={Math.abs(boxSel.y1 - boxSel.y0)}
                    pointerEvents="none"
                  />
                )}
              </g>

              <text
                className="axis-title"
                x={MARGIN.left + plotW / 2}
                y={height - 6}
                textAnchor="middle"
              >
                payout × bet{logX ? ' (logarithmic)' : ' (ascending)'}
                {droppedZero > 0 &&
                  ` — ${droppedZero} zero-payout bucket${droppedZero > 1 ? 's' : ''} omitted`}
              </text>

              <ChartYAxisZoom
                zoom={yZoom}
                onZoom={onYZoom}
                x={0}
                y={MARGIN.top}
                width={MARGIN.left}
                height={plotH}
                label="Zoom the distribution chart's y-axis"
              />
              <ChartXAxisZoom
                zoom={xZoom}
                onZoom={onXZoom}
                x={MARGIN.left}
                y={height - MARGIN.bottom}
                width={plotW}
                height={MARGIN.bottom}
                label="Zoom the distribution chart's x-axis"
              />
              {axes.xScrollbar !== null && (
                <ChartScrollbar
                  orientation="x"
                  x={MARGIN.left}
                  y={height - 24}
                  width={plotW}
                  height={6}
                  size={axes.xScrollbar.size}
                  start={axes.xScrollbar.start}
                  onScroll={axes.xScrollbar.onScroll}
                  label="Scroll the distribution chart horizontally"
                />
              )}
              {axes.yScrollbar !== null && (
                <ChartScrollbar
                  orientation="y"
                  x={plotRight + 2}
                  y={MARGIN.top}
                  width={6}
                  height={plotH}
                  size={axes.yScrollbar.size}
                  start={axes.yScrollbar.start}
                  onScroll={axes.yScrollbar.onScroll}
                  label="Scroll the distribution chart vertically"
                />
              )}
            </svg>

            <ChartReadout
              titles={readoutTitles}
              stats={readoutStats}
              anchor={hover !== null && hover < centres.length ? centres[hover] : null}
              width={width}
            />

            {entry !== null && (
              <ChartValueEntry
                target={entry.target}
                x={entry.x}
                y={entry.y}
                width={width}
                containerHeight={entry.containerHeight}
                weightStep={weightStep}
                onCommit={(v) => commitValue(entry.target.uids, v)}
                onClose={() => setEntry(null)}
              />
            )}

            <ChartResizeGrip
              height={height}
              range={DIST_HEIGHT}
              label="Resize the distribution chart"
              onHeight={onHeight}
              onReset={onHeightReset}
            />
          </>
        )}
      </div>
    </>
  )
  },
)

