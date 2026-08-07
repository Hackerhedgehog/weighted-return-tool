import { useLayoutEffect, useRef, useState } from 'react'

/**
 * The tooltip bubble for a chart hover.
 *
 * It floats in a reserved band *below* the plot, centred on whatever is being
 * hovered. Below is the only place it can sit without hiding data: anywhere
 * inside the plot covers either the bar it describes or that bar's taller
 * neighbours. The band has a fixed height and is always in the layout, so a
 * hover never reflows the page.
 *
 * Two columns: the bucket labels on the left, their numbers on the right. A
 * bar aggregating more labels than fit is not truncated — the list scrolls
 * itself, so everything in the bar is readable without interaction.
 *
 * The horizontal clamp measures the bubble instead of guessing at it — a
 * five-line tooltip is far wider than a two-line one, and the guess is what
 * used to let bars near an edge push their tooltip out of the panel.
 */

export interface ReadoutTitle {
  text: string
  /** The bucket's group color. Omitted → the default text color. */
  color?: string
}

export interface ReadoutStat {
  label: string
  value: string
}

interface ChartReadoutProps {
  /** One line each. Empty → nothing is drawn. */
  titles: ReadoutTitle[]
  stats: ReadoutStat[]
  /** x of the thing being hovered, in container pixels. */
  anchor: number | null
  /** Container width, for the clamp. */
  width: number
}

/** Breathing room between the bubble and the panel edge. */
const PAD = 6
/** Auto-scroll pace, px per second. Readable without being tedious. */
const SCROLL_SPEED = 22
/** Fraction of the cycle actually spent moving; the rest pauses at the ends. */
const SCROLL_DUTY = 0.76
const MIN_SCROLL_CYCLE = 4

export function ChartReadout({ titles, stats, anchor, width }: ChartReadoutProps) {
  const ref = useRef<HTMLDivElement>(null)
  const clipRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [bubbleW, setBubbleW] = useState(0)
  const [scroll, setScroll] = useState(0)

  const open = titles.length > 0 && anchor !== null

  /**
   * Width drives the clamp and overflow drives the scroll, so both are
   * measured rather than assumed, and re-measured whenever the content
   * resizes either box. A layout effect keeps the correction ahead of paint,
   * so the bubble never flashes in the wrong place.
   */
  useLayoutEffect(() => {
    const el = ref.current
    const clip = clipRef.current
    const list = listRef.current
    if (el === null || clip === null || list === null) return

    const measure = () => {
      setBubbleW(el.offsetWidth)
      setScroll(Math.max(0, list.scrollHeight - clip.clientHeight))
    }
    measure()

    const obs = new ResizeObserver(measure)
    obs.observe(el)
    obs.observe(list)
    return () => obs.disconnect()
  }, [open, titles.length])

  const half = bubbleW / 2
  const room = width - half - PAD
  // A bubble wider than its container cannot be centred anywhere legal; pin it
  // to the left edge rather than letting the clamp invert.
  const left = room < half + PAD ? half + PAD : Math.min(Math.max(anchor ?? 0, half + PAD), room)

  const cycle = Math.max(MIN_SCROLL_CYCLE, scroll / SCROLL_SPEED / SCROLL_DUTY)

  return (
    <div className="chart-readout-band">
      {open && (
        <div className="chart-readout" ref={ref} style={{ left }}>
          <div className="readout-titles" ref={clipRef}>
            <div
              className={scroll > 0 ? 'readout-list scrolling' : 'readout-list'}
              ref={listRef}
              style={
                scroll > 0
                  ? ({
                      '--scroll-dist': `${scroll}px`,
                      '--scroll-cycle': `${cycle}s`,
                    } as React.CSSProperties)
                  : undefined
              }
            >
              {titles.map((t, i) => (
                <div key={i} className="readout-title" style={{ color: t.color }} title={t.text}>
                  {t.text}
                </div>
              ))}
            </div>
          </div>
          <div className="readout-stats">
            {stats.map((s) => (
              <div key={s.label} className="readout-stat">
                <span>{s.label}</span>
                <b>{s.value}</b>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
