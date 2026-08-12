import { useRef } from 'react'

/**
 * A thin draggable track+thumb over a plot's edge, shown only while that
 * axis is zoomed in (its caller, useChartAxes, returns null otherwise).
 * `size`/`start` are 0..1 track fractions — the same units ChartYAxisZoom's
 * `zoom`/pan-derived center would produce, but this component knows nothing
 * about the chart's data units; that translation happens in useChartAxes.
 */

interface ChartScrollbarProps {
  orientation: 'x' | 'y'
  x: number
  y: number
  width: number
  height: number
  size: number
  start: number
  onScroll: (start: number) => void
  label: string
}

export function ChartScrollbar({
  orientation,
  x,
  y,
  width,
  height,
  size,
  start,
  onScroll,
  label,
}: ChartScrollbarProps) {
  const drag = useRef<{ startClient: number; startPos: number } | null>(null)
  const trackLength = orientation === 'x' ? width : height

  const thumbLength = Math.max(4, size * trackLength)
  // For the y-axis, "start" is defined in data terms (0 = bottom of the
  // data range = low values); a top-down screen track needs the opposite —
  // a high-value view (start near 1-size) drawn near the top (small pixel
  // offset). The x-axis has no such flip: screen-left already matches
  // "start of the data range."
  const thumbOffset =
    orientation === 'y' ? (1 - start - size) * trackLength : start * trackLength
  const thumbRect =
    orientation === 'x'
      ? { x: x + thumbOffset, y, width: thumbLength, height }
      : { x, y: y + thumbOffset, width, height: thumbLength }

  return (
    <g className="chart-scrollbar">
      <rect className="chart-scrollbar-track" x={x} y={y} width={Math.max(0, width)} height={Math.max(0, height)} />
      <rect
        {...thumbRect}
        className="chart-scrollbar-thumb"
        role="scrollbar"
        aria-label={label}
        aria-orientation={orientation === 'x' ? 'horizontal' : 'vertical'}
        aria-valuenow={Math.round(start * 1000) / 1000}
        aria-valuemin={0}
        aria-valuemax={Math.round((1 - size) * 1000) / 1000}
        tabIndex={0}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
          drag.current = {
            startClient: orientation === 'x' ? e.clientX : e.clientY,
            startPos: start,
          }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (d === null) return
          const client = orientation === 'x' ? e.clientX : e.clientY
          const delta = (client - d.startClient) / Math.max(1, trackLength)
          // Dragging down on screen must reveal lower data values (the
          // thumb "follows" the cursor) — since the y track is drawn
          // top-down while `start` increases toward the top of the data
          // range, a downward drag must DECREASE start, the opposite sign
          // from the x case.
          const signedDelta = orientation === 'y' ? -delta : delta
          onScroll(Math.min(1 - size, Math.max(0, d.startPos + signedDelta)))
        }}
        onPointerUp={() => {
          drag.current = null
        }}
        onPointerCancel={() => {
          drag.current = null
        }}
      />
    </g>
  )
}
