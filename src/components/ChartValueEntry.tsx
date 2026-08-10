import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { evaluateExpression } from '../lib/expr'
import { fmtWeight } from '../lib/format'
import { remapNumpadComma } from './numpadDecimal'

/**
 * Type an exact weight or chance for whatever was right-clicked in the
 * distribution chart.
 *
 * A drag cannot reliably land on 4,200, and the chart is a control surface now
 * — so the precise path is a popover at the pointer rather than a trip back to
 * the table. It commits through the same operations a drag commits through, so
 * the weight step, the locked rows and the grand-total invariant behave
 * identically either way.
 */

export interface ValueEntryTarget {
  /** What is being edited — a bucket label, a bar summary, or a group name. */
  title: string
  uids: string[]
  /** Current value in the chart's metric: a weight, or a percentage. */
  current: number
  unit: 'weight' | '%'
}

interface ChartValueEntryProps {
  target: ValueEntryTarget
  /** Pointer position inside the chart container, in px. */
  x: number
  y: number
  /** Container width, for the horizontal clamp. */
  width: number
  /** Container height, for the vertical clamp. */
  containerHeight: number
  weightStep: number
  /** Returns false when the commit was refused, which keeps the popover open. */
  onCommit: (value: number) => boolean
  onClose: () => void
}

/** Matches `.chart-entry`'s CSS width. Fixed content, so a constant is honest. */
const BOX_W = 200
const PAD = 6

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

export function ChartValueEntry({
  target,
  x,
  y,
  width,
  containerHeight,
  weightStep,
  onCommit,
  onClose,
}: ChartValueEntryProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [text, setText] = useState(() => String(target.current))
  const [top, setTop] = useState(() => Math.max(PAD, y))

  /**
   * `.panel`'s `overflow: hidden` ends flush with the chart container's own
   * bottom edge, so that edge is the real vertical budget — measuring the
   * popover's actual rendered height beats guessing at it, since the height
   * shifts slightly with its content (title length, step hint) and any of
   * the numbers that used to make this fit by coincidence (`MARGIN.bottom`,
   * the readout band's height) can change independently of this file.
   */
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    const maxTop = containerHeight - el.offsetHeight - PAD
    setTop(maxTop < PAD ? PAD : clamp(y, PAD, maxTop))
  }, [y, containerHeight])

  /**
   * A pointer press anywhere else dismisses. The contextmenu event that opened
   * this fires after its own pointerdown, so the opening press can never be
   * caught by the listener attached here.
   */
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [onClose])

  const commit = () => {
    const n = evaluateExpression(text)
    // Unreadable input reverts nothing and closes nothing — the field keeps
    // what was typed so a typo can be fixed rather than retyped.
    if (n === null || !Number.isFinite(n) || n < 0) return
    if (onCommit(n)) onClose()
  }

  const label = target.unit === 'weight' ? 'Weight' : 'Chance %'
  const now = target.unit === 'weight' ? fmtWeight(target.current) : `${target.current}%`

  // A box wider than its container cannot be placed legally; pin it left.
  const left = width < BOX_W + 2 * PAD ? PAD : clamp(x, PAD, width - BOX_W - PAD)

  return (
    <div
      ref={ref}
      className="chart-entry"
      role="dialog"
      aria-label={`Set ${label.toLowerCase()} for ${target.title}`}
      style={{ left, top }}
    >
      <div className="chart-entry-title">{target.title}</div>
      <label className="chart-entry-field">
        <span>{label}</span>
        <input
          className="panel-num"
          aria-label={label}
          value={text}
          spellCheck={false}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (remapNumpadComma(e)) {
              setText(e.currentTarget.value)
              return
            }
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') onClose()
          }}
        />
      </label>
      <div className="chart-entry-hint">
        now {now}
        {weightStep > 1 && ` · step ×${weightStep}`}
      </div>
      <div className="chart-entry-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn primary" onClick={commit}>
          Set
        </button>
      </div>
    </div>
  )
}
