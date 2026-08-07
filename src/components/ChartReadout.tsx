/**
 * The readout under a chart: whatever the pointer is on, spelled out.
 *
 * It sits below the plot in normal flow rather than floating over it, so it
 * can neither cover the marks being inspected nor be clipped at a panel edge —
 * the two failures of the tooltip it replaces. Its height is fixed and it is
 * always mounted, so moving between marks never reflows the page; with nothing
 * hovered it shows `hint`.
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
  /** One line each. Empty → the hint is shown instead. */
  titles: ReadoutTitle[]
  stats: ReadoutStat[]
  hint: string
}

/** Past this the tail is folded into a "+N more" line, so the box stays fixed. */
const MAX_TITLES = 4

export function ChartReadout({ titles, stats, hint }: ChartReadoutProps) {
  const overflow = titles.length > MAX_TITLES ? titles.length - (MAX_TITLES - 1) : 0
  const shown = overflow > 0 ? titles.slice(0, MAX_TITLES - 1) : titles

  return (
    <div className="chart-readout">
      {titles.length === 0 ? (
        <span className="readout-hint">{hint}</span>
      ) : (
        <>
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
        </>
      )}
    </div>
  )
}
