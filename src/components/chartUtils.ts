import { useLayoutEffect, useRef, useState } from 'react'

/** Track a container's width so SVG charts can fill it responsively. */
export function useContainerWidth(): [React.RefObject<HTMLDivElement | null>, number] {
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

/** Round up to a 1/2/2.5/5×10ⁿ ceiling, for tidy linear axes. */
export function niceCeil(v: number): number {
  if (v <= 0) return 1
  const exp = Math.floor(Math.log10(v))
  const base = Math.pow(10, exp)
  const m = v / base
  const nice = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10
  return nice * base
}

/**
 * Bar geometry. Slim bars with tight gaps: the distribution chart shares its
 * row with the table now, and a dense payout ladder has to stay readable in
 * half the width. Bars still spread across the whole plot — only the cap and
 * the gap shrink.
 */
const MAX_BAR_W = 16
const BAR_FILL = 0.86
const MAX_LOG_BAR_W = 12
const LOG_BAR_FILL = 0.85

/** Bar width on an evenly-spaced axis, given the per-bar slot width. */
export function linearBarWidth(slot: number): number {
  return Math.max(2, Math.min(MAX_BAR_W, slot * BAR_FILL))
}

/** Bar width on a log payout axis, given the tightest gap between centres. */
export function logBarWidth(minGap: number): number {
  return Math.max(2, Math.min(MAX_LOG_BAR_W, (minGap || 8) * LOG_BAR_FILL))
}

/**
 * Chart height is user-set and persisted, so it arrives from localStorage
 * unvalidated. Clamping on the way in as well as on every drag keeps a
 * hand-edited workspace from producing a 5px or a 50,000px chart.
 */
export interface HeightRange {
  min: number
  max: number
  /** Restored by Home and by double-clicking the grip. */
  fallback: number
}

export const DIST_HEIGHT: HeightRange = { min: 220, max: 900, fallback: 340 }
export const SIM_HEIGHT: HeightRange = { min: 160, max: 800, fallback: 260 }

export function clampHeight(h: number, r: HeightRange): number {
  if (!Number.isFinite(h)) return r.fallback
  return Math.min(Math.max(Math.round(h), r.min), r.max)
}

/**
 * Y-axis zoom is multiplicative and layered on top of each chart's own
 * auto-fit ceiling (see SimChart/BankrollChart): `effectiveYMax = autoYMax *
 * zoom`. Bounding the *factor* rather than the resulting pixel value keeps
 * the bounds meaningful however wide or narrow the auto range currently is.
 */
export interface YZoomRange {
  min: number
  max: number
}

export const Y_ZOOM_RANGE: YZoomRange = { min: 0.15, max: 6 }

export function clampZoom(z: number, range: YZoomRange = Y_ZOOM_RANGE): number {
  if (!Number.isFinite(z)) return 1
  return Math.min(Math.max(z, range.min), range.max)
}

/** 1500 → "1.5k", 100000000 → "100M" — x-axis ticks for spin counts. */
export function fmtCompact(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  const fmt = (v: number, suffix: string) => {
    const r = Math.round(v * 10) / 10
    return `${Number.isInteger(r) ? r.toFixed(0) : r}${suffix}`
  }
  if (abs >= 1e9) return fmt(n / 1e9, 'B')
  if (abs >= 1e6) return fmt(n / 1e6, 'M')
  if (abs >= 1e3) return fmt(n / 1e3, 'k')
  return String(Math.round(n))
}
