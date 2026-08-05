import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { BucketRow } from '../lib/types'
import { fmtInt, fmtPct } from '../lib/format'

interface DistributionChartProps {
  rows: BucketRow[]
  totalWeight: number
  aggregate: boolean
  logScale: boolean
}

interface Bar {
  payout: number
  chance: number
  weight: number
  labels: string[]
}

const HEIGHT = 340
const MARGIN = { top: 18, right: 16, bottom: 42, left: 64 }

function useContainerWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(900)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const obs = new ResizeObserver((entries) => {
      setWidth(Math.max(320, entries[0].contentRect.width))
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])
  return [ref, width]
}

export function DistributionChart({ rows, totalWeight, aggregate, logScale }: DistributionChartProps) {
  const [containerRef, width] = useContainerWidth()
  const [hover, setHover] = useState<number | null>(null)

  const bars: Bar[] = useMemo(() => {
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
      .map((r) => ({ payout: r.payout, weight: r.weight, chance: chanceOf(r.weight), labels: [r.label] }))
  }, [rows, totalWeight, aggregate])

  const plotW = width - MARGIN.left - MARGIN.right
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom

  const { yFrac, ticks } = useMemo(() => {
    const positive = bars.map((b) => b.chance).filter((c) => c > 0)
    const maxChance = positive.length ? Math.max(...positive) : 1

    if (logScale) {
      const minChance = positive.length ? Math.min(...positive) : 0.000001
      const maxE = Math.ceil(Math.log10(maxChance))
      const minE = Math.min(Math.floor(Math.log10(minChance)), maxE - 1)
      const span = maxE - minE + 0.35 // small headroom below the lowest decade
      const frac = (c: number) =>
        c <= 0 ? 0 : Math.min(1, Math.max(0.015, (Math.log10(c) - minE + 0.35) / span))
      const tks: { frac: number; label: string }[] = []
      for (let e = minE; e <= maxE; e++) {
        tks.push({ frac: (e - minE + 0.35) / span, label: fmtPct(Math.pow(10, e)) })
      }
      return { yFrac: frac, ticks: tks }
    }

    const niceMax = niceCeil(maxChance)
    const frac = (c: number) => (niceMax > 0 ? Math.min(1, c / niceMax) : 0)
    const tks = [0, 0.25, 0.5, 0.75, 1].map((t) => ({ frac: t, label: fmtPct(t * niceMax) }))
    return { yFrac: frac, ticks: tks }
  }, [bars, logScale])

  const n = bars.length
  const step = n > 0 ? plotW / n : plotW
  const barW = Math.max(2, Math.min(48, step * 0.72))
  const labelEvery = Math.max(1, Math.ceil(n / Math.floor(plotW / 56)))

  const hovered = hover !== null ? bars[hover] : null
  const hoverX = hover !== null ? MARGIN.left + hover * step + step / 2 : 0

  return (
    <div className="chart-wrap" ref={containerRef}>
      {n === 0 ? (
        <div className="chart-empty">No buckets to plot.</div>
      ) : (
        <>
          <svg width={width} height={HEIGHT} role="img" aria-label="Bucket chance distribution">
            {/* gridlines + y labels */}
            {ticks.map((t, i) => {
              const y = MARGIN.top + plotH * (1 - t.frac)
              return (
                <g key={i}>
                  <line className="grid-line" x1={MARGIN.left} x2={width - MARGIN.right} y1={y} y2={y} />
                  <text className="axis-label y" x={MARGIN.left - 8} y={y + 4} textAnchor="end">
                    {t.label}
                  </text>
                </g>
              )
            })}

            {/* baseline */}
            <line
              className="axis-line"
              x1={MARGIN.left}
              x2={width - MARGIN.right}
              y1={MARGIN.top + plotH}
              y2={MARGIN.top + plotH}
            />

            {/* bars */}
            {bars.map((b, i) => {
              const h = plotH * yFrac(b.chance)
              const x = MARGIN.left + i * step + (step - barW) / 2
              return (
                <rect
                  key={i}
                  className={`bar ${hover === i ? 'hover' : ''}`}
                  x={x}
                  y={MARGIN.top + plotH - h}
                  width={barW}
                  height={Math.max(h, b.chance > 0 ? 1.5 : 0)}
                  rx={1.5}
                />
              )
            })}

            {/* x labels */}
            {bars.map((b, i) =>
              i % labelEvery === 0 ? (
                <text
                  key={i}
                  className="axis-label x"
                  x={MARGIN.left + i * step + step / 2}
                  y={HEIGHT - MARGIN.bottom + 18}
                  textAnchor="middle"
                >
                  ×{fmtInt(b.payout)}
                </text>
              ) : null,
            )}
            <text className="axis-title" x={width / 2} y={HEIGHT - 6} textAnchor="middle">
              payout × bet (ascending)
            </text>

            {/* hover hit areas */}
            {bars.map((_, i) => (
              <rect
                key={i}
                x={MARGIN.left + i * step}
                y={MARGIN.top}
                width={step}
                height={plotH}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              />
            ))}
          </svg>

          {hovered && (
            <div
              className="chart-tooltip"
              style={{
                left: Math.min(Math.max(hoverX, 90), width - 110),
              }}
            >
              <div className="tt-payout">×{fmtInt(hovered.payout)}</div>
              <div className="tt-labels">
                {hovered.labels.length > 3
                  ? `${hovered.labels.slice(0, 3).join(', ')} +${hovered.labels.length - 3}`
                  : hovered.labels.join(', ')}
              </div>
              <div className="tt-row">
                <span>chance</span>
                <b>{fmtPct(hovered.chance)}</b>
              </div>
              <div className="tt-row">
                <span>weight</span>
                <b>{fmtInt(hovered.weight)}</b>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function niceCeil(v: number): number {
  if (v <= 0) return 1
  const exp = Math.floor(Math.log10(v))
  const base = Math.pow(10, exp)
  const m = v / base
  const nice = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10
  return nice * base
}
