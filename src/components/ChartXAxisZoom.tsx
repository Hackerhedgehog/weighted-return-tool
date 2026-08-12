import { useEffect, useRef } from 'react'
import { clampZoom, X_ZOOM_RANGE } from './chartUtils'

/**
 * Horizontal mirror of ChartYAxisZoom.tsx — see that file's doc for the
 * rationale (multiplicative zoom, passive:false wheel listener). Rendered
 * over a chart's x-axis label row: scroll or drag horizontally to zoom the
 * x-axis in or out. Dragging right zooms in, left zooms out — the
 * horizontal analogue of the y version's "drag up zooms in."
 */

interface ChartXAxisZoomProps {
  zoom: number
  onZoom: (z: number) => void
  x: number
  y: number
  width: number
  height: number
  label: string
}

const WHEEL_FACTOR = 1.1
const DRAG_HALF_LIFE = 115

export function ChartXAxisZoom({ zoom, onZoom, x, y, width, height, label }: ChartXAxisZoomProps) {
  const drag = useRef<{ startX: number; startZoom: number } | null>(null)
  const ref = useRef<SVGRectElement>(null)

  useEffect(() => {
    const el = ref.current
    if (el === null) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      onZoom(clampZoom(zoom * (e.deltaY < 0 ? 1 / WHEEL_FACTOR : WHEEL_FACTOR), X_ZOOM_RANGE))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoom, onZoom])

  return (
    <rect
      ref={ref}
      className="x-zoom-hit"
      x={x}
      y={y}
      width={Math.max(0, width)}
      height={Math.max(0, height)}
      fill="transparent"
      role="slider"
      aria-label={label}
      aria-orientation="horizontal"
      aria-valuenow={Math.round(zoom * 1000) / 1000}
      aria-valuemin={X_ZOOM_RANGE.min}
      aria-valuemax={X_ZOOM_RANGE.max}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
        drag.current = { startX: e.clientX, startZoom: zoom }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (d === null) return
        const dx = e.clientX - d.startX
        onZoom(clampZoom(d.startZoom * Math.exp((-dx * Math.LN2) / DRAG_HALF_LIFE), X_ZOOM_RANGE))
      }}
      onPointerUp={() => {
        drag.current = null
      }}
      onPointerCancel={() => {
        drag.current = null
      }}
      onDoubleClick={() => onZoom(1)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') {
          e.preventDefault()
          onZoom(clampZoom(zoom / WHEEL_FACTOR, X_ZOOM_RANGE))
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault()
          onZoom(clampZoom(zoom * WHEEL_FACTOR, X_ZOOM_RANGE))
        } else if (e.key === 'Home') {
          e.preventDefault()
          onZoom(1)
        }
      }}
    />
  )
}
