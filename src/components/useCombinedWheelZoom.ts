import { useEffect, useRef } from 'react'
import { clampZoom, X_ZOOM_RANGE, Y_ZOOM_RANGE } from './chartUtils'

/**
 * Scrolling on the plot itself (as opposed to either axis margin) zooms both
 * axes together by the same wheel notch, so the view stays centered on
 * whatever the pointer is already looking at rather than stretching in one
 * dimension. Scrolling on the X-axis strip or the Y-axis label column still
 * reaches ChartXAxisZoom/ChartYAxisZoom instead — those are separate elements
 * outside the ref this hook attaches to, so nothing double-fires.
 *
 * Manual `addEventListener` with `passive: false`, same reason as
 * ChartXAxisZoom/ChartYAxisZoom: React's own wheel handler is passive, and a
 * passive listener's preventDefault() is silently ignored, which would let
 * the page scroll under the pointer while the user is trying to zoom.
 */

interface UseCombinedWheelZoomArgs {
  xZoom: number
  onXZoom: (z: number) => void
  yZoom: number
  onYZoom: (z: number) => void
}

const WHEEL_FACTOR = 1.1

export function useCombinedWheelZoom<T extends Element>({
  xZoom,
  onXZoom,
  yZoom,
  onYZoom,
}: UseCombinedWheelZoomArgs) {
  const ref = useRef<T>(null)

  useEffect(() => {
    const el: EventTarget | null = ref.current
    if (el === null) return
    const onWheel = (e: Event) => {
      const wheel = e as WheelEvent
      wheel.preventDefault()
      const factor = wheel.deltaY < 0 ? 1 / WHEEL_FACTOR : WHEEL_FACTOR
      onXZoom(clampZoom(xZoom * factor, X_ZOOM_RANGE))
      onYZoom(clampZoom(yZoom * factor, Y_ZOOM_RANGE))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [xZoom, onXZoom, yZoom, onYZoom])

  return ref
}
