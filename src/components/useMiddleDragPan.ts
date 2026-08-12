import { useRef } from 'react'

/**
 * Middle-mouse-button drag-to-pan for a chart's hit-rect. Converts a pixel
 * delta into a pan-fraction delta using the plot's own pixel dimensions and
 * the axis's current zoom — dragging by one plot-width at zoom=1 pans by
 * exactly one full autoMax; at a tighter zoom the same pixel drag covers
 * proportionally less of the (now zoomed-in) data, matching how the
 * scrollbar thumb and the axis-zoom drag handles already scale with zoom.
 *
 * `preventDefault()` on pointerdown stops the browser's native middle-click
 * autoscroll cursor from appearing over the plot.
 */

interface UseMiddleDragPanArgs {
  xZoom: number
  xPan: number
  onXPan: (p: number) => void
  yZoom: number
  yPan: number
  onYPan: (p: number) => void
  plotW: number
  plotH: number
}

export function useMiddleDragPan({
  xZoom,
  xPan,
  onXPan,
  yZoom,
  yPan,
  onYPan,
  plotW,
  plotH,
}: UseMiddleDragPanArgs) {
  const drag = useRef<{
    startX: number
    startY: number
    startXPan: number
    startYPan: number
  } | null>(null)

  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 1) return
      e.preventDefault()
      ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
      drag.current = { startX: e.clientX, startY: e.clientY, startXPan: xPan, startYPan: yPan }
    },
    onPointerMove: (e: React.PointerEvent) => {
      const d = drag.current
      if (d === null) return
      const dx = e.clientX - d.startX
      const dy = e.clientY - d.startY
      onXPan(d.startXPan - xZoom * (dx / Math.max(1, plotW)))
      onYPan(d.startYPan + yZoom * (dy / Math.max(1, plotH)))
    },
    onPointerUp: (_e: React.PointerEvent) => {
      drag.current = null
    },
    onPointerCancel: (_e: React.PointerEvent) => {
      drag.current = null
    },
  }
}
