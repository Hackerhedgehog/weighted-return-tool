import { useMemo, useState } from 'react'
import type { BucketRow, ChartSettings } from '../lib/types'
import { fmtPayout, fmtPct, fmtWeight } from '../lib/format'
import { niceCeil, useContainerWidth } from './chartUtils'

interface DistributionChartProps {
  rows: BucketRow[]
  totalWeight: number
  chart: ChartSettings
  onChart: (c: ChartSettings) => void
}

interface Bar {
  payout: number
  chance: number
  weight: number
  labels: string[]
}

const HEIGHT = 340
const MARGIN = { top: 18, right: 16, bottom: 46, left: 76 }

export function DistributionChart({ rows, totalWeight, chart, onChart }: DistributionChartProps) {
  const [containerRef, width] = useContainerWidth()
  const [hover, setHover] = useState<number | null>(null)

  const { metric, logY, logX, aggregate } = chart
  const set = (patch: Partial<ChartSettings>) => onChart({ ...chart, ...patch })

  const allBars: Bar[] = useMemo(() => {
    const chanceOf = (w: number) => (totalWeight > 0 ? w / totalWeight : 0)

    if (aggregate) {
      const byPayout = new Map<number, Bar>()
      for (const r of rows) {
        const existing = byPayout.get(r.payout)
        if (existing) {
          existing.weight += r.weight
          existing.chance += chanceOf(r.weight)
          existing.labels.push(r.label)
        } else {
          byPayout.set(r.payout, {
            payout: r.payout,
            weight: r.weight,
            chance: chanceOf(r.weight),
            labels: [r.label],
          })
        }
      }
      return [...byPayout.values()].sort((a, b) => a.payout - b.payout)
    }

    return [...rows]
      .sort((a, b) => a.payout - b.payout || a.bucketId - b.bucketId)
      .map((r) => ({
        payout: r.payout,
        weight: r.weight,
        chance: chanceOf(r.weight),
        labels: [r.label],
      }))
  }, [rows, totalWeight, aggregate])

  // A logarithmic payout axis has nowhere to put a 0x bucket.
  const bars = useMemo(() => (logX ? allBars.filter((b) => b.payout > 0) : allBars), [allBars, logX])
  const droppedZero = logX ? allBars.length - bars.length : 0

  const plotW = width - MARGIN.left - MARGIN.right
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom

  const valueOf = (b: Bar) => (metric === 'weights' ? b.weight : b.chance)

  const { yFrac, ticks } = useMemo(() => {
    const pick = (b: Bar) => (metric === 'weights' ? b.weight : b.chance)
    const label = (v: number) => (metric === 'weights' ? fmtWeight(v) : fmtPct(v, 3))
    const positive = bars.map(pick).filter((v) => v > 0)
    const maxVal = positive.length ? Math.max(...positive) : 1

    if (logY) {
      const minVal = positive.length ? Math.min(...positive) : 1e-6
      const maxE = Math.ceil(Math.log10(maxVal))
      const minE = Math.min(Math.floor(Math.log10(minVal)), maxE - 1)
      const span = maxE - minE + 0.35
      const frac = (v: number) =>
        v <= 0 ? 0 : Math.min(1, Math.max(0.015, (Math.log10(v) - minE + 0.35) / span))
      const tks: { frac: number; label: string }[] = []
      for (let e = minE; e <= maxE; e++) {
        tks.push({ frac: (e - minE + 0.35) / span, label: label(Math.pow(10, e)) })
      }
      return { yFrac: frac, ticks: tks }
    }

    const niceMax = niceCeil(maxVal)
    const frac = (v: number) => (niceMax > 0 ? Math.min(1, v / niceMax) : 0)
    const tks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({ frac: t, label: label(t * niceMax) }))
    return { yFrac: frac, ticks: tks }
  }, [bars, logY, metric])

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
    if (!logX) return Math.max(2, Math.min(48, step * 0.72))
    let gap = plotW
    for (let i = 1; i < centres.length; i++) gap = Math.min(gap, centres[i] - centres[i - 1])
    return Math.max(2, Math.min(36, gap * 0.7 || 8))
  }, [logX, step, centres, plotW])

  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 62))))
  const hovered = hover !== null ? bars[hover] : null

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
      </div>

      <div className="chart-wrap" ref={containerRef}>
        {n === 0 ? (
          <div className="chart-empty">No buckets to plot.</div>
        ) : (
          <>
            <svg width={width} height={HEIGHT} role="img" aria-label="Bucket distribution">
              {ticks.map((t, i) => {
                const y = MARGIN.top + plotH * (1 - t.frac)
                return (
                  <g key={i}>
                    <line
                      className="grid-line"
                      x1={MARGIN.left}
                      x2={width - MARGIN.right}
                      y1={y}
                      y2={y}
                    />
                    <text className="axis-label" x={MARGIN.left - 8} y={y + 4} textAnchor="end">
                      {t.label}
                    </text>
                  </g>
                )
              })}

              <line
                className="axis-line"
                x1={MARGIN.left}
                x2={width - MARGIN.right}
                y1={MARGIN.top + plotH}
                y2={MARGIN.top + plotH}
              />

              {bars.map((b, i) => {
                const v = valueOf(b)
                const h = plotH * yFrac(v)
                return (
                  <rect
                    key={i}
                    className={`bar ${hover === i ? 'hover' : ''}`}
                    x={centres[i] - barW / 2}
                    y={MARGIN.top + plotH - h}
                    width={barW}
                    height={Math.max(h, v > 0 ? 1.5 : 0)}
                    rx={1.5}
                  />
                )
              })}

              {bars.map((b, i) =>
                i % labelEvery === 0 ? (
                  <text
                    key={i}
                    className="axis-label"
                    x={centres[i]}
                    y={HEIGHT - MARGIN.bottom + 18}
                    textAnchor="middle"
                  >
                    ×{fmtPayout(b.payout)}
                  </text>
                ) : null,
              )}

              <text className="axis-title" x={width / 2} y={HEIGHT - 8} textAnchor="middle">
                payout × bet{logX ? ' (logarithmic)' : ' (ascending)'}
                {droppedZero > 0 &&
                  ` — ${droppedZero} zero-payout bucket${droppedZero > 1 ? 's' : ''} omitted`}
              </text>

              {bars.map((_, i) => (
                <rect
                  key={i}
                  x={centres[i] - Math.max(barW, logX ? barW : step) / 2}
                  y={MARGIN.top}
                  width={Math.max(barW, logX ? barW : step)}
                  height={plotH}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                />
              ))}
            </svg>

            {hovered && hover !== null && (
              <div
                className="chart-tooltip"
                style={{ left: Math.min(Math.max(centres[hover], 100), width - 110) }}
              >
                <div className="tt-payout">×{fmtPayout(hovered.payout)}</div>
                <div className="tt-labels">
                  {hovered.labels.length > 3
                    ? `${hovered.labels.slice(0, 3).join(', ')} +${hovered.labels.length - 3}`
                    : hovered.labels.join(', ')}
                </div>
                <div className="tt-row">
                  <span>weight</span>
                  <b>{fmtWeight(hovered.weight)}</b>
                </div>
                <div className="tt-row">
                  <span>chance</span>
                  <b>{fmtPct(hovered.chance, 4)}</b>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}
