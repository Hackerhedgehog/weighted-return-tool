import { useMemo, useState } from 'react'
import { ChartReadout, type ReadoutStat } from './ChartReadout'
import { ChartResizeGrip } from './ChartResizeGrip'
import { ChartScrollbar } from './ChartScrollbar'
import { ChartXAxisZoom } from './ChartXAxisZoom'
import { ChartYAxisZoom } from './ChartYAxisZoom'
import { fmtCompact, niceCeil, SIM_HEIGHT, useContainerWidth } from './chartUtils'
import { useChartAxes } from './useChartAxes'
import { useMiddleDragPan } from './useMiddleDragPan'
import { fmtCredits, fmtWeight } from '../lib/format'
import type { BankrollPoint, BankrollState } from '../lib/bankroll'

/**
 * The credit balance over a bankroll run.
 *
 * Not a variant of SimChart: that chart's three series, p95 ceiling and spike
 * clipping all exist to make an average legible, and none of it applies to a
 * single balance line.
 *
 * The y axis is linear with zero pinned to the bottom. Busting is the story, so
 * zero has to be on the chart — and a log axis cannot show the value the run is
 * heading for. The x axis grows with each Continue, so one run reads as one
 * unbroken curve however many chunks it took.
 */

interface BankrollChartProps {
  points: BankrollPoint[]
  /** Where the run started — the dashed reference line. */
  startCredits: number
  state: BankrollState
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

const MARGIN = { top: 14, right: 88, bottom: 52, left: 72 }

export function BankrollChart({
  points,
  startCredits,
  state,
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
}: BankrollChartProps) {
  const [containerRef, width] = useContainerWidth()
  const [hover, setHover] = useState<number | null>(null)

  const plotW = width - MARGIN.left - MARGIN.right
  const plotH = height - MARGIN.top - MARGIN.bottom
  const totalSpins = Math.max(1, state.spins)

  // Headroom above whichever is higher, so the reference line is never off the
  // top of a run that only ever lost money.
  const autoYMax = useMemo(
    () => niceCeil(Math.max(state.peak, startCredits, 1e-9) * 1.05),
    [state.peak, startCredits],
  )

  const trueYMax = autoYMax

  const { viewX, viewY, setXPan, setYPan, resetView, xScrollbar, yScrollbar } = useChartAxes({
    xExtent: totalSpins,
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
    keepZeroVisible: true,
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

  const x = (spins: number) =>
    MARGIN.left + ((spins - viewX.min) / Math.max(1e-9, viewX.max - viewX.min)) * plotW
  const y = (v: number) => {
    const clamped = Math.min(Math.max(v, viewY.min), viewY.max)
    return MARGIN.top + plotH * (1 - (clamped - viewY.min) / Math.max(1e-9, viewY.max - viewY.min))
  }

  const path = useMemo(
    () =>
      points
        .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.spins).toFixed(1)},${y(p.balance).toFixed(1)}`)
        .join(''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [points, viewX.min, viewX.max, viewY.min, viewY.max, plotW, plotH],
  )

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
    y: MARGIN.top + plotH * (1 - t),
    label: fmtCompact(viewY.min + t * (viewY.max - viewY.min)),
  }))
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
    x: MARGIN.left + plotW * t,
    label: fmtCompact(viewX.min + t * (viewX.max - viewX.min)),
  }))

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    if (points.length === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const spins = viewX.min + ((e.clientX - rect.left) / Math.max(1, plotW)) * (viewX.max - viewX.min)
    let best = 0
    let bestDist = Infinity
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(points[i].spins - spins)
      if (d < bestDist) {
        bestDist = d
        best = i
      }
    }
    setHover(best)
  }

  const h = hover !== null && hover < points.length ? hover : null
  const last = points[points.length - 1]

  const readoutStats: ReadoutStat[] =
    h === null
      ? []
      : [
          { label: 'balance', value: fmtCredits(points[h].balance) },
          { label: 'started', value: fmtCredits(startCredits) },
          {
            label: 'change',
            value: `${points[h].balance >= startCredits ? '+' : '−'}${fmtCredits(
              Math.abs(points[h].balance - startCredits),
            )}`,
          },
        ]

  return (
    <div className="chart-wrap" ref={containerRef}>
      <div className="sim-legend">
        <span className="legend-item">
          <span className="legend-line bankroll-balance" /> credit balance
        </span>
        <span className="legend-item">
          <span className="legend-line bankroll-start" /> started with {fmtCredits(startCredits)}
        </span>
        {state.busted && <span className="legend-note">busted — no credit left to bet</span>}
        <button type="button" className="btn chart-reset" onClick={resetView} title="Zoom out to fit all data, centered">
          Reset view
        </button>
      </div>

      <svg width={width} height={height} role="img" aria-label="Bankroll results">
        <defs>
          <clipPath id="bankroll-chart-plot-clip">
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

        {/* where the run started */}
        <line
          className="bankroll-start-line"
          x1={MARGIN.left}
          x2={width - MARGIN.right}
          y1={y(startCredits)}
          y2={y(startCredits)}
        />
        <text className="axis-label" x={width - MARGIN.right + 6} y={y(startCredits) + 4}>
          start
        </text>

        <g clipPath="url(#bankroll-chart-plot-clip)">
          {points.length > 0 && <path className="bankroll-path" d={path} />}

          {state.busted && last !== undefined && (
            <g className="bankroll-bust">
              <line x1={x(last.spins)} x2={x(last.spins)} y1={MARGIN.top} y2={MARGIN.top + plotH} />
              <circle cx={x(last.spins)} cy={y(last.balance)} r={3.5} />
            </g>
          )}

          {h !== null && (
            <line
              className="sim-crosshair"
              x1={x(points[h].spins)}
              x2={x(points[h].spins)}
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
          label="Zoom the bankroll chart's y-axis"
        />
        <ChartXAxisZoom
          zoom={xZoom}
          onZoom={onXZoom}
          x={MARGIN.left}
          y={height - MARGIN.bottom}
          width={plotW}
          height={MARGIN.bottom}
          label="Zoom the bankroll chart's x-axis"
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
            label="Scroll the bankroll chart horizontally"
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
            label="Scroll the bankroll chart vertically"
          />
        )}
      </svg>

      <ChartReadout
        titles={h === null ? [] : [{ text: `${fmtWeight(points[h].spins)} spins` }]}
        stats={readoutStats}
        anchor={h === null ? null : x(points[h].spins)}
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
