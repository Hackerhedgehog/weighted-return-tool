import { useMemo, useState } from 'react'
import { ChartReadout, type ReadoutStat } from './ChartReadout'
import { ChartResizeGrip } from './ChartResizeGrip'
import { fmtCompact, niceCeil, SIM_HEIGHT, useContainerWidth } from './chartUtils'
import { fmtWeight } from '../lib/format'
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
}

const MARGIN = { top: 14, right: 74, bottom: 40, left: 72 }

export function BankrollChart({
  points,
  startCredits,
  state,
  height,
  onHeight,
}: BankrollChartProps) {
  const [containerRef, width] = useContainerWidth()
  const [hover, setHover] = useState<number | null>(null)

  const plotW = width - MARGIN.left - MARGIN.right
  const plotH = height - MARGIN.top - MARGIN.bottom
  const totalSpins = Math.max(1, state.spins)

  // Headroom above whichever is higher, so the reference line is never off the
  // top of a run that only ever lost money.
  const yMax = useMemo(
    () => niceCeil(Math.max(state.peak, startCredits, 1e-9) * 1.05),
    [state.peak, startCredits],
  )

  const x = (spins: number) => MARGIN.left + (spins / totalSpins) * plotW
  const y = (v: number) => MARGIN.top + plotH * (1 - Math.min(Math.max(v, 0), yMax) / yMax)

  const path = useMemo(
    () =>
      points
        .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.spins).toFixed(1)},${y(p.balance).toFixed(1)}`)
        .join(''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [points, yMax, plotW, plotH, totalSpins],
  )

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
    y: MARGIN.top + plotH * (1 - t),
    label: fmtCompact(t * yMax),
  }))
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
    x: MARGIN.left + plotW * t,
    label: fmtCompact(t * totalSpins),
  }))

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    if (points.length === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const spins = ((e.clientX - rect.left) / Math.max(1, plotW)) * totalSpins
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
          { label: 'balance', value: fmtWeight(points[h].balance) },
          { label: 'started', value: fmtWeight(startCredits) },
          {
            label: 'change',
            value: `${points[h].balance >= startCredits ? '+' : '−'}${fmtWeight(
              Math.abs(points[h].balance - startCredits),
            )}`,
          },
        ]

  return (
    <div className="chart-wrap" ref={containerRef}>
      <div className="sim-legend">
        <span className="legend-item">
          <span className="legend-line cumulative" /> credit balance
        </span>
        <span className="legend-item">
          <span className="legend-line expected" /> started with {fmtWeight(startCredits)}
        </span>
        {state.busted && <span className="legend-note">busted — no credit left to bet</span>}
      </div>

      <svg width={width} height={height} role="img" aria-label="Bankroll results">
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
        />
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
