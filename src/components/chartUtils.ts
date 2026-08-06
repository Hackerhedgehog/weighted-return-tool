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
