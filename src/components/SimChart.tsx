import { useMemo, useState } from 'react'
import { ChartReadout, type ReadoutStat } from './ChartReadout'
import { ChartResizeGrip } from './ChartResizeGrip'
import { ChartScrollbar } from './ChartScrollbar'
import { ChartXAxisZoom } from './ChartXAxisZoom'
import { ChartYAxisZoom } from './ChartYAxisZoom'
import { fmtCompact, niceCeil, SIM_HEIGHT, useContainerWidth } from './chartUtils'
import { useChartAxes } from './useChartAxes'
import { useMiddleDragPan } from './useMiddleDragPan'
import { fmtRtp, fmtWeight } from '../lib/format'

/**
 * Realtime simulation results. Three series, one linear y-axis:
 *  - block means (one point per 0.1% of the run) — the noise, drawn thin;
 *  - cumulative RTP — the signal, drawn bold;
 *  - the table's expected RTP at run start — a dashed reference.
 *
 * Block means can spike far above everything else when a top payout lands in
 * a small block, so the y-ceiling sits at the 95th percentile of the means
 * (or comfortably above the reference, whichever is higher) and spikes are
 * pinned to the top edge; the axis note says how many. The crosshair tooltip
 * always reports true values.
 */

interface SimChartProps {
  /** Mean payout per finished block, in block order. */
  points: number[]
  blockSize: number
  requestedSpins: number
  expectedRtp: number
  height: number
  onHeight: (h: number) => void
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

const MARGIN = { top: 14, right: 82, bottom: 52, left: 64 }

export function SimChart({
  points,
  blockSize,
  requestedSpins,
  expectedRtp,
  height,
  onHeight,
  yZoom,
  onYZoom,
  yPan,
  onYPan,
  xZoom,
  onXZoom,
  xPan,
  onXPan,
}: SimChartProps) {
  const [containerRef, width] = useContainerWidth()
  const [hover, setHover] = useState<number | null>(null)

  const plotW = width - MARGIN.left - MARGIN.right
  const plotH = height - MARGIN.top - MARGIN.bottom

  /** Spins covered by block i (the last block may run short). */
  const spinsOf = (i: number) => Math.min(blockSize, requestedSpins - i * blockSize)

  const { cumulative, spinsAt } = useMemo(() => {
    const cum: number[] = new Array<number>(points.length)
    const at: number[] = new Array<number>(points.length)
    let sum = 0
    let spins = 0
    for (let i = 0; i < points.length; i++) {
      const s = spinsOf(i)
      sum += points[i] * s
      spins += s
      cum[i] = sum / spins
      at[i] = spins
    }
    return { cumulative: cum, spinsAt: at }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, blockSize, requestedSpins])

  /**
   * The ceiling before zoom: p95 of block means, cumulative max and expected
   * RTP, whichever is highest. Zoom (ChartYAxisZoom, below) multiplies this
   * rather than replacing it, so a live run's growing cumulative max keeps
   * the auto baseline moving under a zoomed-in view instead of leaving it
   * stale.
   */
  const autoYMax = useMemo(() => {
    if (points.length === 0) return niceCeil(expectedRtp * 1.5)
    const sorted = [...points].sort((a, b) => a - b)
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
    const cumMax = cumulative.length > 0 ? Math.max(...cumulative) : 0
    return niceCeil(Math.max(p95 * 1.15, cumMax * 1.15, expectedRtp * 1.3, 1e-9))
  }, [points, cumulative, expectedRtp])

  /** The real max across every series — ignores the p95 clip, drives Reset View and the pan bound. */
  const trueYMax = useMemo(() => {
    if (points.length === 0) return niceCeil(expectedRtp * 1.5)
    const dataMax = Math.max(...points, ...cumulative, expectedRtp)
    return niceCeil(Math.max(dataMax, 1e-9))
  }, [points, cumulative, expectedRtp])

  const { viewX, viewY, setXPan, setYPan, resetView, xScrollbar, yScrollbar } = useChartAxes({
    xExtent: requestedSpins,
    xZoom,
    onXZoom,
    xPan,
    onXPan,
    autoYMax,
    trueYMax,
    yZoom,
    onYZoom,
    yPan,
    onYPan,
  })

  const middleDragPan = useMiddleDragPan({
    xZoom,
    xPan,
    onXPan: setXPan,
    yZoom,
    yPan,
    onYPan: setYPan,
    plotW,
    plotH,
  })

  // Recomputed against the *effective* (zoomed+panned) ceiling: a block that
  // only clips once the user zooms/pans should count.
  const clipped = useMemo(() => points.filter((v) => v > viewY.max).length, [points, viewY.max])

  const x = (spins: number) =>
    MARGIN.left + ((spins - viewX.min) / Math.max(1e-9, viewX.max - viewX.min)) * plotW
  const y = (v: number) => {
    const clamped = Math.min(Math.max(v, viewY.min), viewY.max)
    return MARGIN.top + plotH * (1 - (clamped - viewY.min) / Math.max(1e-9, viewY.max - viewY.min))
  }

  const meanPath = useMemo(
    () => points.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(spinsAt[i]).toFixed(1)},${y(v).toFixed(1)}`).join(''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [points, spinsAt, viewX.min, viewX.max, viewY.min, viewY.max, plotW, plotH],
  )
  const cumPath = useMemo(
    () =>
      cumulative
        .map((v, i) => `${i === 0 ? 'M' : 'L'}${x(spinsAt[i]).toFixed(1)},${y(v).toFixed(1)}`)
        .join(''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cumulative, spinsAt, viewX.min, viewX.max, viewY.min, viewY.max, plotW, plotH],
  )

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
    y: MARGIN.top + plotH * (1 - t),
    label: fmtRtp(viewY.min + t * (viewY.max - viewY.min)),
  }))
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
    x: MARGIN.left + plotW * t,
    label: fmtCompact(viewX.min + t * (viewX.max - viewX.min)),
  }))

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    if (points.length === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    const spins = viewX.min + (px / Math.max(1, plotW)) * (viewX.max - viewX.min)
    let best = 0
    let bestDist = Infinity
    for (let i = 0; i < spinsAt.length; i++) {
      const d = Math.abs(spinsAt[i] - spins)
      if (d < bestDist) {
        bestDist = d
        best = i
      }
    }
    setHover(best)
  }

  const h = hover !== null && hover < points.length ? hover : null

  const readoutStats: ReadoutStat[] =
    h === null
      ? []
      : [
          // The plan ceilings the block size, so the final block runs short —
          // report what this block actually covered, not the nominal size.
          { label: 'block', value: `${fmtWeight(spinsOf(h))} spins` },
          { label: 'block avg', value: fmtRtp(points[h]) },
          { label: 'RTP so far', value: fmtRtp(cumulative[h]) },
          { label: 'table RTP', value: fmtRtp(expectedRtp) },
        ]

  return (
    <div className="chart-wrap" ref={containerRef}>
      <div className="sim-legend">
        <span className="legend-item">
          <span className="legend-line noise" /> block avg · {fmtWeight(blockSize)} spins each
        </span>
        <span className="legend-item">
          <span className="legend-line cumulative" /> RTP so far
        </span>
        <span className="legend-item">
          <span className="legend-line expected" /> table RTP
        </span>
        {clipped > 0 && (
          <span className="legend-note">
            {clipped} spike block{clipped > 1 ? 's' : ''} pinned to the top edge
          </span>
        )}
        <button type="button" className="btn chart-reset" onClick={resetView} title="Zoom out to fit all data, centered">
          Reset view
        </button>
      </div>

      <svg width={width} height={height} role="img" aria-label="Simulation results">
        <defs>
          <clipPath id="sim-chart-plot-clip">
            <rect x={MARGIN.left} y={MARGIN.top} width={Math.max(0, plotW)} height={Math.max(0, plotH)} />
          </clipPath>
        </defs>
        {yTicks.map((t, i) => (
          <g key={i}>
            <line className="grid-line" x1={MARGIN.left} x2={width - MARGIN.right} y1={t.y} y2={t.y} />
            <text className="axis-label" x={MARGIN.left - 8} y={t.y + 4} textAnchor="end">
              {t.label}
            </text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text key={i} className="axis-label" x={t.x} y={height - MARGIN.bottom + 18} textAnchor="middle">
            {t.label}
          </text>
        ))}
        <line
          className="axis-line"
          x1={MARGIN.left}
          x2={width - MARGIN.right}
          y1={MARGIN.top + plotH}
          y2={MARGIN.top + plotH}
        />

        {/* expected RTP reference */}
        <line
          className="sim-expected-line"
          x1={MARGIN.left}
          x2={width - MARGIN.right}
          y1={y(expectedRtp)}
          y2={y(expectedRtp)}
        />
        <text className="axis-label" x={width - MARGIN.right + 6} y={y(expectedRtp) + 4}>
          {fmtRtp(expectedRtp)}
        </text>

        <g clipPath="url(#sim-chart-plot-clip)">
          {points.length > 0 && <path className="sim-mean-path" d={meanPath} />}
          {cumulative.length > 0 && <path className="sim-cum-path" d={cumPath} />}
          {h !== null && (
            <line
              className="sim-crosshair"
              x1={x(spinsAt[h])}
              x2={x(spinsAt[h])}
              y1={MARGIN.top}
              y2={MARGIN.top + plotH}
            />
          )}
        </g>

        <text className="axis-title" x={width / 2} y={height - 8} textAnchor="middle">
          spins
        </text>

        <rect
          className="sim-hit"
          x={MARGIN.left}
          y={MARGIN.top}
          width={Math.max(0, plotW)}
          height={plotH}
          fill="transparent"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
          {...middleDragPan}
        />

        <ChartYAxisZoom
          zoom={yZoom}
          onZoom={onYZoom}
          x={0}
          y={MARGIN.top}
          width={MARGIN.left}
          height={plotH}
          label="Zoom the simulation chart's y-axis"
        />
        <ChartXAxisZoom
          zoom={xZoom}
          onZoom={onXZoom}
          x={MARGIN.left}
          y={height - MARGIN.bottom}
          width={plotW}
          height={MARGIN.bottom}
          label="Zoom the simulation chart's x-axis"
        />
        {xScrollbar !== null && (
          <ChartScrollbar
            orientation="x"
            x={MARGIN.left}
            y={height - 24}
            width={plotW}
            height={6}
            size={xScrollbar.size}
            start={xScrollbar.start}
            onScroll={xScrollbar.onScroll}
            label="Scroll the simulation chart horizontally"
          />
        )}
        {yScrollbar !== null && (
          <ChartScrollbar
            orientation="y"
            x={width - 10}
            y={MARGIN.top}
            width={6}
            height={plotH}
            size={yScrollbar.size}
            start={yScrollbar.start}
            onScroll={yScrollbar.onScroll}
            label="Scroll the simulation chart vertically"
          />
        )}
      </svg>

      <ChartReadout
        titles={h === null ? [] : [{ text: `${fmtWeight(spinsAt[h])} spins` }]}
        stats={readoutStats}
        anchor={h === null ? null : x(spinsAt[h])}
        width={width}
      />

      <ChartResizeGrip
        height={height}
        range={SIM_HEIGHT}
        label="Resize the simulation chart"
        onHeight={onHeight}
      />
    </div>
  )
}
