import { useEffect, useRef } from 'react'
import { clampZoom, Y_ZOOM_RANGE } from './chartUtils'

/**
 * Invisible drag/scroll handle over a chart's y-axis label column: scroll or
 * drag vertically to zoom the y-axis in or out around the auto-fit range the
 * chart already computes. The zoom factor itself belongs to the caller — it
 * is persisted with the rest of the view state — so this component holds
 * nothing but the live pointer session.
 *
 * Zoom is multiplicative, like the log-axis drag in DistributionChart: a
 * constant relative amount per pixel dragged or per wheel notch, rather than
 * an absolute amount, so the same gesture feels the same whether the range is
 * currently wide or already tight.
 *
 * The wheel listener is attached manually with `passive: false` — React
 * attaches its own wheel listener as passive, and a passive listener's
 * preventDefault() is silently ignored, which would let the page scroll under
 * the pointer while the user is trying to zoom.
 */

interface ChartYAxisZoomProps {
  zoom: number
  onZoom: (z: number) => void
  /** Hit-region geometry — the y-axis label column. */
  x: number
  y: number
  width: number
  height: number
  label: string
}

/** Relative change per wheel notch or keypress. */
const WHEEL_FACTOR = 1.1
/** Pixels of drag that double or halve the zoom factor. */
const DRAG_HALF_LIFE = 115

export function ChartYAxisZoom({ zoom, onZoom, x, y, width, height, label }: ChartYAxisZoomProps) {
  const drag = useRef<{ startY: number; startZoom: number } | null>(null)
  const ref = useRef<SVGRectElement>(null)

  useEffect(() => {
    const el = ref.current
    if (el === null) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      onZoom(clampZoom(zoom * (e.deltaY < 0 ? 1 / WHEEL_FACTOR : WHEEL_FACTOR)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, onZoom])

  return (
    <rect
      ref={ref}
      className="y-zoom-hit"
      x={x}
      y={y}
      width={Math.max(0, width)}
      height={Math.max(0, height)}
      fill="transparent"
      role="slider"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuenow={Math.round(zoom * 1000) / 1000}
      aria-valuemin={Y_ZOOM_RANGE.min}
      aria-valuemax={Y_ZOOM_RANGE.max}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
        drag.current = { startY: e.clientY, startZoom: zoom }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (d === null) return
        const dy = d.startY - e.clientY
        onZoom(clampZoom(d.startZoom * Math.exp((-dy * Math.LN2) / DRAG_HALF_LIFE)))
      }}
      onPointerUp={() => {
        drag.current = null
      }}
      onPointerCancel={() => {
        drag.current = null
      }}
      onDoubleClick={() => onZoom(1)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          onZoom(clampZoom(zoom / WHEEL_FACTOR))
        } else if (e.key === 'ArrowDown') {
          e.preventDefault()
          onZoom(clampZoom(zoom * WHEEL_FACTOR))
        } else if (e.key === 'Home') {
          e.preventDefault()
          onZoom(1)
        }
      }}
    />
  )
}
