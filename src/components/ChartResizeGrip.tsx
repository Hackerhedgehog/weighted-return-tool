import { useRef } from 'react'
import { clampHeight, type HeightRange } from './chartUtils'

/**
 * Drag handle under a chart: pull down to make it taller.
 *
 * The height itself belongs to the caller — it is persisted with the rest of
 * the view state — so the grip holds nothing but the live pointer session and
 * there is no local copy to drift out of step. A pointer-only resize would be
 * unreachable from the keyboard, so the grip is a focusable separator with
 * arrow, page and Home bindings as well.
 */

interface ChartResizeGripProps {
  height: number
  range: HeightRange
  label: string
  onHeight: (h: number) => void
  /**
   * What the reset gesture means. Without one, reset restores `range.fallback`;
   * with one, the caller decides — the distribution chart uses it to go back to
   * fitting the table rather than to a fixed number.
   */
  onReset?: () => void
}

const STEP = 16
const PAGE = 64

export function ChartResizeGrip({ height, range, label, onHeight, onReset }: ChartResizeGripProps) {
  const drag = useRef<{ startY: number; startHeight: number } | null>(null)

  const reset = () => (onReset === undefined ? onHeight(range.fallback) : onReset())

  const keyDelta = (key: string): number => {
    if (key === 'ArrowDown') return STEP
    if (key === 'ArrowUp') return -STEP
    if (key === 'PageDown') return PAGE
    if (key === 'PageUp') return -PAGE
    return 0
  }

  return (
    <div
      className="chart-grip"
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      aria-valuenow={height}
      aria-valuemin={range.min}
      aria-valuemax={range.max}
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
        drag.current = { startY: e.clientY, startHeight: height }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (d === null) return
        onHeight(clampHeight(d.startHeight + (e.clientY - d.startY), range))
      }}
      onPointerUp={() => {
        drag.current = null
      }}
      onPointerCancel={() => {
        drag.current = null
      }}
      onDoubleClick={reset}
      onKeyDown={(e) => {
        const delta = keyDelta(e.key)
        if (delta !== 0) {
          e.preventDefault()
          onHeight(clampHeight(height + delta, range))
        } else if (e.key === 'Home') {
          e.preventDefault()
          reset()
        }
      }}
    >
      <span className="chart-grip-bar" aria-hidden="true" />
    </div>
  )
}
