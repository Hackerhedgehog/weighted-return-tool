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
 * The horizontal clamp measures the bubble instead of guessing at it — a
 * five-line tooltip is far wider than a two-line one, and the guess is what
 * used to let bars near an edge push their tooltip out of the panel.
 */

export interface ReadoutTitle {
  text: string
  /** CSS color, e.g. 'var(--series-2)'. Omitted → the default text color. */
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

/** Past this the tail is folded into a "+N more" line, so the box stays small. */
const MAX_TITLES = 4
/** Breathing room between the bubble and the panel edge. */
const PAD = 6

export function ChartReadout({ titles, stats, anchor, width }: ChartReadoutProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [bubbleW, setBubbleW] = useState(0)

  const shown = titles.length > MAX_TITLES ? titles.slice(0, MAX_TITLES - 1) : titles
  const overflow = titles.length > MAX_TITLES ? titles.length - (MAX_TITLES - 1) : 0
  const open = titles.length > 0 && anchor !== null

  // Measured after every content change: the width drives the clamp, so a
  // stale measurement would let the bubble hang off the edge for one frame.
  useLayoutEffect(() => {
    const w = ref.current?.offsetWidth ?? 0
    setBubbleW((prev) => (Math.abs(prev - w) < 0.5 ? prev : w))
  })

  const half = bubbleW / 2
  const room = width - half - PAD
  // A bubble wider than its container cannot be centred anywhere legal; pin it
  // to the left edge rather than letting the clamp invert.
  const left = room < half + PAD ? half + PAD : Math.min(Math.max(anchor ?? 0, half + PAD), room)

  return (
    <div className="chart-readout-band">
      {open && (
        <div className="chart-readout" ref={ref} style={{ left }}>
          <div className="readout-titles">
            {shown.map((t, i) => (
              <div key={i} className="readout-title" style={{ color: t.color }} title={t.text}>
                {t.text}
              </div>
            ))}
            {overflow > 0 && <div className="readout-more">+{overflow} more</div>}
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
