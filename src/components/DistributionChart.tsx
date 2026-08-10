import { useEffect, useMemo, useRef, useState } from 'react'
import type { BucketRow, ChartSettings, WeightStep } from '../lib/types'
import type { Grouping } from '../lib/groups'
import { buildBars, type ChartBar, type Segment } from '../lib/bars'
import { scaleSubset, setSubsetTotal } from '../lib/interact'
import { fmtPayout, fmtPct, fmtRtp, fmtWeight } from '../lib/format'
import { ChartReadout, type ReadoutStat, type ReadoutTitle } from './ChartReadout'
import { ChartValueEntry, type ValueEntryTarget } from './ChartValueEntry'
import { ChartResizeGrip } from './ChartResizeGrip'
import { GroupBarChips } from './GroupBarChips'
import { DIST_HEIGHT, linearBarWidth, logBarWidth, niceCeil, useContainerWidth } from './chartUtils'

/**
 * The distribution chart is now a control surface as well as a picture:
 *
 *  - bars are colored by bucket group (stacked segments when an aggregated
 *    bar spans groups) and can be dragged vertically to change a bucket's
 *    weight or chance. The chip row above the plot (`GroupBarChips`) doubles
 *    as a legend and lets any group collapse into one solid bar instead of
 *    its buckets;
 *  - each group gets a handle on the right edge at the height of its total
 *    (in the current metric and axis mode), draggable like a bar, and
 *    carrying a padlock that locks or unlocks every bucket in the group at
 *    once;
 *  - drags are relative by default — other unlocked buckets absorb the
 *    change so the grand total (and Σchance == 1) holds. Weights mode can
 *    switch that off; chance mode cannot;
 *  - right-clicking a bar or a handle opens `ChartValueEntry`, a popover for
 *    typing an exact weight or chance. It commits through the same
 *    `scaleSubset` / `setSubsetTotal` path a drag commits through, so the two
 *    ways of setting a value can never disagree.
 *
 * During a drag the pointer math and the rendered axis both use the scale
 * captured at pointer-down: recomputing the scale per move would rescale the
 * axis under the pointer and feed back into the drag. Previews stream
 * through onPreview; one onCommit fires at pointer-up (or from the popover's
 * Set) so undo sees a single step. Escape cancels a live drag.
 */

interface DistributionChartProps {
  rows: BucketRow[]
  totalWeight: number
  chart: ChartSettings
  grouping: Grouping
  weightStep: WeightStep
  height: number
  onChart: (c: ChartSettings) => void
  onHeight: (h: number) => void
  onPreview: (rows: BucketRow[] | null) => void
  onCommit: (rows: BucketRow[]) => void
  /** 'off-step' when the table can't be partitioned on the step, 'pinned' when locks leave nothing free to move. */
  onBlocked: (reason: 'off-step' | 'pinned') => void
  onGroupLock: (id: string, locked: boolean) => void
}

interface Scale {
  frac: (v: number) => number
  invert: (f: number) => number
  ticks: { frac: number; label: string }[]
}

interface DragState {
  baseRows: BucketRow[]
  baseTotal: number
  uids: string[]
  scale: Scale
  /** Pointer y at press, and the subset's own position on the frozen axis. */
  startY: number
  startFrac: number
  moved: boolean
  lastRows: BucketRow[] | null
  blockedNotified: boolean
}

const MARGIN = { top: 18, right: 150, bottom: 46, left: 64 }
const HANDLE_GAP = 30
const SEGMENT_GAP = 2

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

function buildScale(values: number[], logY: boolean, label: (v: number) => string): Scale {
  const positive = values.filter((v) => v > 0)
  const maxVal = positive.length > 0 ? Math.max(...positive) : 1

  if (logY) {
    const minVal = positive.length > 0 ? Math.min(...positive) : 1e-6
    const maxE = Math.ceil(Math.log10(maxVal))
    const minE = Math.min(Math.floor(Math.log10(minVal)), maxE - 1)
    const span = maxE - minE + 0.35
    const ticks: { frac: number; label: string }[] = []
    for (let e = minE; e <= maxE; e++) {
      ticks.push({ frac: (e - minE + 0.35) / span, label: label(Math.pow(10, e)) })
    }
    return {
      frac: (v) => (v <= 0 ? 0 : clamp((Math.log10(v) - minE + 0.35) / span, 0.015, 1)),
      // Below the axis floor there is nothing to point at but zero.
      invert: (f) => (f <= 0.02 ? 0 : Math.pow(10, f * span + minE - 0.35)),
      ticks,
    }
  }

  const niceMax = niceCeil(maxVal)
  return {
    frac: (v) => (niceMax > 0 ? clamp(v / niceMax, 0, 1) : 0),
    invert: (f) => Math.max(0, f) * niceMax,
    ticks: [0, 0.25, 0.5, 0.75, 1].map((t) => ({ frac: t, label: label(t * niceMax) })),
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

export function DistributionChart({
  rows,
  totalWeight,
  chart,
  grouping,
  weightStep,
  height,
  onChart,
  onHeight,
  onPreview,
  onCommit,
  onBlocked,
  onGroupLock,
}: DistributionChartProps) {
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

  const { metric, logY, logX, aggregate, relative, groupBars } = chart
  const set = (patch: Partial<ChartSettings>) => onChart({ ...chart, ...patch })

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

  const { bars, droppedZero } = useMemo(
    () => buildBars(rows, grouping, totalWeight, { aggregate, groupBars, logX }),
    [rows, grouping, totalWeight, aggregate, groupBars, logX],
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

  const liveScale = useMemo(() => {
    const label = (v: number) => (metric === 'weights' ? fmtWeight(v) : fmtPct(v, 3))
    return buildScale(
      [...bars.map(valueOf), ...groupStats.map((s) => s.value)],
      logY,
      label,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, groupStats, logY, metric])

  // While dragging, both the pointer math and the picture use the scale
  // captured at pointer-down.
  const scale = dragScale ?? liveScale
  const dragging = dragScale !== null

  const n = bars.length
  const step = n > 0 ? plotW / n : plotW

  /** Bar centres: evenly spaced, or placed by log payout. */
  const centres = useMemo(() => {
    if (!logX) return bars.map((_, i) => MARGIN.left + i * step + step / 2)
    const logs = bars.map((b) => Math.log(b.payout))
    const lo = Math.min(...logs)
    const hi = Math.max(...logs)
    const spread = hi - lo || 1
    return logs.map((l) => MARGIN.left + ((l - lo) / spread) * plotW)
  }, [bars, logX, step, plotW])

  const barW = useMemo(() => {
    if (!logX) return linearBarWidth(step)
    let gap = plotW
    for (let i = 1; i < centres.length; i++) gap = Math.min(gap, centres[i] - centres[i - 1])
    // A single bar leaves no gap to measure; logBarWidth falls back for 0.
    return logBarWidth(gap === plotW ? 0 : gap)
  }, [logX, step, centres, plotW])

  // ---- dragging ----

  /**
   * The three-way rule that turns a value into a subset's weights: chance
   * mode scales to a fraction of the frozen total, weights mode scales
   * relatively when the toggle is on, and otherwise sets the subset's
   * absolute total. The drag and the typed-value popover both funnel through
   * this one rule, so they can never compute the result differently — the
   * caller supplies the row set and its total rather than this closing over
   * `rows`, since a drag operates on the rows frozen at pointer-down while the
   * popover operates on whatever is current.
   */
  const weightsForValue = (
    baseRows: BucketRow[],
    uids: string[],
    baseTotal: number,
    value: number,
  ): number[] | null => {
    if (metric === 'chance') return scaleSubset(baseRows, uids, clamp(value, 0, 1) * baseTotal, weightStep)
    if (relative) return scaleSubset(baseRows, uids, value, weightStep)
    return setSubsetTotal(baseRows, uids, value, weightStep)
  }

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
    const weights = weightsForValue(d.baseRows, d.uids, d.baseTotal, value)

    if (weights === null) {
      // Off-step table: the drag has nowhere legal to move. Say so once.
      if (!d.blockedNotified) {
        d.blockedNotified = true
        onBlocked('off-step')
      }
      return
    }

    const next = d.baseRows.map((r, i) => (r.weight === weights[i] ? r : { ...r, weight: weights[i] }))
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

  // ---- handle layout ----

  const handleYs = useMemo(() => {
    const raw = groupStats.map((s) => MARGIN.top + plotH * (1 - scale.frac(s.value)))
    return {
      raw,
      spread: spreadPositions(raw, HANDLE_GAP, MARGIN.top + 12, MARGIN.top + plotH - 12),
    }
  }, [groupStats, scale, plotH])

  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 62))))
  const hovered = hover !== null && hover < bars.length ? bars[hover] : null

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
      <div className="chart-controls">
        <div className="seg small">
          <button
            type="button"
            className={`seg-btn ${metric === 'weights' ? 'active' : ''}`}
            onClick={() => set({ metric: 'weights' })}
          >
            Weights
          </button>
          <button
            type="button"
            className={`seg-btn ${metric === 'chance' ? 'active' : ''}`}
            onClick={() => set({ metric: 'chance' })}
          >
            % Chance
          </button>
        </div>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={aggregate}
            onChange={(e) => set({ aggregate: e.target.checked })}
          />
          <span>Aggregate equal payouts</span>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={logY} onChange={(e) => set({ logY: e.target.checked })} />
          <span>Log Y</span>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={logX} onChange={(e) => set({ logX: e.target.checked })} />
          <span>Log X</span>
        </label>
        {metric === 'weights' && (
          <label className="checkbox" title="On: dragging a bar keeps the total weight — other unlocked buckets compensate. Off: only the dragged bar moves.">
            <input
              type="checkbox"
              checked={relative}
              onChange={(e) => set({ relative: e.target.checked })}
            />
            <span>Relative drag</span>
          </label>
        )}
        <span className="panel-hint">drag a bar or a group handle to reshape</span>
      </div>

      <GroupBarChips
        groups={grouping.groups}
        groupBars={groupBars}
        onGroupBars={(ids) => set({ groupBars: ids })}
      />

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

              <line
                className="axis-line"
                x1={MARGIN.left}
                x2={plotRight}
                y1={MARGIN.top + plotH}
                y2={MARGIN.top + plotH}
              />

              {bars.map((b, i) => {
                const v = valueOf(b)
                const h = plotH * scale.frac(v)
                const x0 = centres[i] - barW / 2
                const bottom = MARGIN.top + plotH
                // v > 0 keeps at least a sliver, so tiny buckets stay visible
                const height = Math.max(h, v > 0 ? 1.5 : 0)

                if (b.segments.length <= 1) {
                  return (
                    <rect
                      key={i}
                      className={`bar ${hover === i ? 'hover' : ''}`}
                      x={x0}
                      y={bottom - height}
                      width={barW}
                      height={height}
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
                const avail = Math.max(0, height - gaps)
                let yCursor = bottom
                return (
                  <g key={i}>
                    {b.segments.map((s, k) => {
                      const hk = totalV > 0 ? (segValue(s) / totalV) * avail : 0
                      yCursor -= hk
                      const rect = (
                        <rect
                          key={k}
                          className={`bar ${hover === i ? 'hover' : ''}`}
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

              <text
                className="axis-title"
                x={MARGIN.left + plotW / 2}
                y={height - 8}
                textAnchor="middle"
              >
                payout × bet{logX ? ' (logarithmic)' : ' (ascending)'}
                {droppedZero > 0 &&
                  ` — ${droppedZero} zero-payout bucket${droppedZero > 1 ? 's' : ''} omitted`}
              </text>

              {/* group handles, right edge */}
              {groupStats.map((s, gi) => {
                const yExact = handleYs.raw[gi]
                const yLabel = handleYs.spread[gi]
                return (
                  <g
                    key={s.group.id}
                    className={`group-handle ${s.allLocked ? 'disabled' : ''}`}
                    role="slider"
                    aria-label={`${s.group.name} group`}
                    aria-disabled={s.allLocked || undefined}
                    aria-valuemin={0}
                    aria-valuemax={metric === 'weights' ? Math.round(totalWeight) : 100}
                    aria-valuenow={
                      metric === 'weights' ? Math.round(s.weight) : Math.round(s.chance * 1000) / 10
                    }
                    onPointerDown={(e) => beginDrag(e, s.group.uids, s.allLocked, s.value)}
                    onPointerMove={moveDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                    onContextMenu={(e) => openEntry(e, s.group.name, s.group.uids, s.value, s.allLocked)}
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
                      aria-label={`${s.allLocked ? 'Unlock' : 'Lock'} the ${s.group.name} group`}
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
                  </g>
                )
              })}

              {/* hover + drag targets over the bars */}
              {bars.map((b, i) => (
                <rect
                  key={i}
                  className="bar-hit"
                  x={centres[i] - Math.max(barW, logX ? barW : step) / 2}
                  y={MARGIN.top}
                  width={Math.max(barW, logX ? barW : step)}
                  height={plotH}
                  fill="transparent"
                  style={{ cursor: b.allLocked ? 'default' : 'ns-resize' }}
                  onMouseEnter={() => {
                    if (!dragging) setHover(i)
                  }}
                  onMouseLeave={() => setHover(null)}
                  onPointerDown={(e) => beginDrag(e, b.uids, b.allLocked, valueOf(b))}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  onContextMenu={(e) => openEntry(e, barTitle(b), b.uids, valueOf(b), b.allLocked)}
                />
              ))}
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
            />
          </>
        )}
      </div>
    </>
  )
}
