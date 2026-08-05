const GAUGE_MIN = 0.8
const GAUGE_MAX = 1.1
const BAND_LO = 0.92
const BAND_HI = 0.98

/** Horizontal RTP gauge: 0.80–1.10 scale with the 0.92–0.98 target band. */
export function RtpGauge({ rtp }: { rtp: number }) {
  const clamp = (v: number) => Math.min(Math.max(v, GAUGE_MIN), GAUGE_MAX)
  const pos = (v: number) => ((clamp(v) - GAUGE_MIN) / (GAUGE_MAX - GAUGE_MIN)) * 100

  const inBand = rtp >= BAND_LO && rtp <= BAND_HI
  const markerPos = Number.isFinite(rtp) ? pos(rtp) : 0

  return (
    <div className="rtp-gauge" title={`Target band ${BAND_LO.toFixed(2)} – ${BAND_HI.toFixed(2)}`}>
      <div className="gauge-track">
        <div
          className="gauge-band"
          style={{ left: `${pos(BAND_LO)}%`, width: `${pos(BAND_HI) - pos(BAND_LO)}%` }}
        />
        {Number.isFinite(rtp) && (
          <div className={`gauge-marker ${inBand ? 'ok' : 'off'}`} style={{ left: `${markerPos}%` }} />
        )}
      </div>
      <div className="gauge-scale">
        <span>{GAUGE_MIN.toFixed(2)}</span>
        <span className="band-label">{BAND_LO.toFixed(2)}</span>
        <span className="band-label">{BAND_HI.toFixed(2)}</span>
        <span>{GAUGE_MAX.toFixed(2)}</span>
      </div>
    </div>
  )
}
