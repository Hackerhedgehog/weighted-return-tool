import { useMemo, useState } from 'react'
import { fmtCompact, niceCeil, useContainerWidth } from './chartUtils'
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
}

const HEIGHT = 260
const MARGIN = { top: 14, right: 74, bottom: 40, left: 64 }

export function SimChart({ points, blockSize, requestedSpins, expectedRtp }: SimChartProps) {
  const [containerRef, width] = useContainerWidth()
  const [hover, setHover] = useState<number | null>(null)

  const plotW = width - MARGIN.left - MARGIN.right
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom

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

  const { yMax, clipped } = useMemo(() => {
    if (points.length === 0) return { yMax: niceCeil(expectedRtp * 1.5), clipped: 0 }
    const sorted = [...points].sort((a, b) => a - b)
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
    const cumMax = cumulative.length > 0 ? Math.max(...cumulative) : 0
    const ceil = niceCeil(Math.max(p95 * 1.15, cumMax * 1.15, expectedRtp * 1.3, 1e-9))
    return { yMax: ceil, clipped: points.filter((v) => v > ceil).length }
  }, [points, cumulative, expectedRtp])

  const x = (spins: number) => MARGIN.left + (requestedSpins > 0 ? spins / requestedSpins : 0) * plotW
  const y = (v: number) => MARGIN.top + plotH * (1 - Math.min(v, yMax) / yMax)

  const meanPath = useMemo(
    () => points.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(spinsAt[i]).toFixed(1)},${y(v).toFixed(1)}`).join(''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [points, spinsAt, yMax, plotW, plotH, requestedSpins],
  )
  const cumPath = useMemo(
    () =>
      cumulative
        .map((v, i) => `${i === 0 ? 'M' : 'L'}${x(spinsAt[i]).toFixed(1)},${y(v).toFixed(1)}`)
        .join(''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cumulative, spinsAt, yMax, plotW, plotH, requestedSpins],
  )

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
    y: MARGIN.top + plotH * (1 - t),
    label: fmtRtp(t * yMax),
  }))
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
    x: MARGIN.left + plotW * t,
    label: fmtCompact(t * requestedSpins),
  }))

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    if (points.length === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    const spins = (px / Math.max(1, plotW)) * requestedSpins
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

  return (
    <div className="chart-wrap" ref={containerRef}>
      <div className="sim-legend">
        <span className="legend-item">
          <span className="legend-line noise" /> block avg
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
      </div>

      <svg width={width} height={HEIGHT} role="img" aria-label="Simulation results">
        {yTicks.map((t, i) => (
          <g key={i}>
            <line className="grid-line" x1={MARGIN.left} x2={width - MARGIN.right} y1={t.y} y2={t.y} />
            <text className="axis-label" x={MARGIN.left - 8} y={t.y + 4} textAnchor="end">
              {t.label}
            </text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text key={i} className="axis-label" x={t.x} y={HEIGHT - MARGIN.bottom + 18} textAnchor="middle">
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

        <text className="axis-title" x={width / 2} y={HEIGHT - 8} textAnchor="middle">
          spins
        </text>

        <rect
          x={MARGIN.left}
          y={MARGIN.top}
          width={Math.max(0, plotW)}
          height={plotH}
          fill="transparent"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        />
      </svg>

      {h !== null && (
        <div
          className="chart-tooltip"
          style={{ left: Math.min(Math.max(x(spinsAt[h]), 110), width - 120) }}
        >
          <div className="tt-payout">{fmtWeight(spinsAt[h])} spins</div>
          <div className="tt-row">
            <span>block avg</span>
            <b>{fmtRtp(points[h])}</b>
          </div>
          <div className="tt-row">
            <span>RTP so far</span>
            <b>{fmtRtp(cumulative[h])}</b>
          </div>
          <div className="tt-row">
            <span>table RTP</span>
            <b>{fmtRtp(expectedRtp)}</b>
          </div>
        </div>
      )}
    </div>
  )
}
