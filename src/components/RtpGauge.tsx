const BAND = 0.03
const SPAN = 0.2

/**
 * RTP gauge, scaled around the user's target rather than a fixed band —
 * a hardcoded 0.92–0.98 window contradicts a target the user sets themselves.
 */
export function RtpGauge({ rtp, target }: { rtp: number; target: number }) {
  const safeTarget = Number.isFinite(target) && target > 0 ? target : 1
  const min = Math.max(0, safeTarget - SPAN)
  const max = safeTarget + SPAN

  const pos = (v: number) => ((Math.min(Math.max(v, min), max) - min) / (max - min)) * 100

  const lo = Math.max(min, safeTarget - BAND)
  const hi = Math.min(max, safeTarget + BAND)
  const inBand = rtp >= lo && rtp <= hi

  return (
    <div className="rtp-gauge" title={`Target ${safeTarget} ±${BAND}`}>
      <div className="gauge-track">
        <div
          className="gauge-band"
          style={{ left: `${pos(lo)}%`, width: `${pos(hi) - pos(lo)}%` }}
        />
        {Number.isFinite(rtp) && (
          <div
            className={`gauge-marker ${inBand ? 'ok' : 'off'}`}
            style={{ left: `${pos(rtp)}%` }}
          />
        )}
      </div>
      <div className="gauge-scale">
        <span>{min.toFixed(2)}</span>
        <span className="band-label">{safeTarget.toFixed(2)}</span>
        <span>{max.toFixed(2)}</span>
      </div>
    </div>
  )
}
