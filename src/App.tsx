import { useCallback, useMemo, useState } from 'react'
import type { BucketRow, SortKey, SortState } from './lib/types'
import { parseTsv, SAMPLE_TSV } from './lib/parse'
import { distributeWeights, rescaleWeights } from './lib/distribute'
import { fmtInt, fmtRtp } from './lib/format'
import { BucketTable, type RowPatch } from './components/BucketTable'
import { DistributionChart } from './components/DistributionChart'
import { RtpGauge } from './components/RtpGauge'
import { NumCell } from './components/cells'

const DEFAULT_TOTAL_WEIGHT = 1_000_000
const DEFAULT_TARGET_RTP = 0.95
const RTP_BAND: [number, number] = [0.92, 0.98]

export default function App() {
  const [rows, setRows] = useState<BucketRow[]>([])
  const [totalWeight, setTotalWeight] = useState(DEFAULT_TOTAL_WEIGHT)
  const [targetRtp, setTargetRtp] = useState(DEFAULT_TARGET_RTP)
  const [sort, setSort] = useState<SortState>({ key: 'bucketId', dir: 1 })
  const [pasteOpen, setPasteOpen] = useState(true)
  const [pasteText, setPasteText] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)
  const [aggregate, setAggregate] = useState(false)
  const [logScale, setLogScale] = useState(false)

  const loadData = useCallback(
    (text: string) => {
      const outcome = parseTsv(text)
      if (outcome.error) {
        setPasteError(outcome.error)
        return
      }
      const weights = distributeWeights(
        outcome.rows.map((r) => r.payout),
        totalWeight,
        targetRtp,
      )
      setRows(outcome.rows.map((r, i) => ({ ...r, weight: weights[i] })))
      setPasteError(null)
      setPasteOpen(false)
      setPasteText('')
    },
    [totalWeight, targetRtp],
  )

  const autoDistribute = useCallback(() => {
    setRows((prev) => {
      const weights = distributeWeights(prev.map((r) => r.payout), totalWeight, targetRtp)
      return prev.map((r, i) => ({ ...r, weight: weights[i] }))
    })
  }, [totalWeight, targetRtp])

  const changeTotalWeight = useCallback((newTotal: number) => {
    setTotalWeight(newTotal)
    // Rescale existing weights proportionally so RTP and chances are preserved.
    setRows((prev) => {
      const scaled = rescaleWeights(prev.map((r) => r.weight), newTotal)
      return prev.map((r, i) => ({ ...r, weight: scaled[i] }))
    })
  }, [])

  const patchRow = useCallback((uid: string, patch: RowPatch) => {
    setRows((prev) => prev.map((r) => (r.uid === uid ? { ...r, ...patch } : r)))
  }, [])

  const handleSort = useCallback((key: SortKey) => {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 1 ? -1 : 1 } : { key, dir: 1 }))
  }, [])

  const stats = useMemo(() => {
    const sumWeights = rows.reduce((a, r) => a + r.weight, 0)
    const rtp = totalWeight > 0 ? rows.reduce((a, r) => a + (r.payout * r.weight) / totalWeight, 0) : NaN
    const hitChance =
      totalWeight > 0 ? rows.filter((r) => r.payout > 0).reduce((a, r) => a + r.weight / totalWeight, 0) : NaN
    return { sumWeights, rtp, hitChance, delta: totalWeight - sumWeights }
  }, [rows, totalWeight])

  const rtpStatus = !Number.isFinite(stats.rtp)
    ? 'na'
    : stats.rtp >= RTP_BAND[0] && stats.rtp <= RTP_BAND[1]
      ? 'ok'
      : 'off'

  const absorbDelta = useCallback(() => {
    setRows((prev) => {
      if (prev.length === 0) return prev
      let biggest = 0
      for (let i = 1; i < prev.length; i++) {
        if (prev[i].weight > prev[biggest].weight) biggest = i
      }
      const sum = prev.reduce((a, r) => a + r.weight, 0)
      const delta = totalWeight - sum
      return prev.map((r, i) =>
        i === biggest ? { ...r, weight: Math.max(0, r.weight + delta) } : r,
      )
    })
  }, [totalWeight])

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◆</span>
          <h1>
            Weighted Return <span className="brand-sub">/ slot engine calculator</span>
          </h1>
        </div>
        <div className="topbar-actions">
          <button type="button" className="btn ghost" onClick={() => loadData(SAMPLE_TSV)}>
            Load sample
          </button>
          <button type="button" className="btn" onClick={() => setPasteOpen(true)}>
            Paste TSV data
          </button>
        </div>
      </header>

      {rows.length > 0 && (
        <>
          <section className="stats-strip">
            <div className={`stat rtp ${rtpStatus}`}>
              <span className="stat-label">Total RTP</span>
              <span className="stat-value">{fmtRtp(stats.rtp)}</span>
              <RtpGauge rtp={stats.rtp} />
              <span className="stat-hint">
                target band {RTP_BAND[0].toFixed(2)} – {RTP_BAND[1].toFixed(2)}
              </span>
            </div>

            <div className="stat">
              <span className="stat-label">Total weight</span>
              <NumCell
                className="stat-input"
                value={totalWeight}
                display={fmtInt(totalWeight)}
                validate={(n) => Number.isInteger(n) && n > 0}
                onCommit={(n) => changeTotalWeight(Math.round(n))}
              />
              <span className={`stat-hint ${stats.delta !== 0 ? 'warn' : ''}`}>
                Σ weights {fmtInt(stats.sumWeights)}
                {stats.delta !== 0 && (
                  <>
                    {' '}
                    (Δ {stats.delta > 0 ? '+' : ''}
                    {fmtInt(stats.delta)}){' '}
                    <button type="button" className="link-btn" onClick={absorbDelta}>
                      fix
                    </button>
                  </>
                )}
              </span>
            </div>

            <div className="stat">
              <span className="stat-label">Target RTP</span>
              <NumCell
                className="stat-input"
                value={targetRtp}
                display={targetRtp.toFixed(2)}
                validate={(n) => n > 0 && n < 5}
                onCommit={(n) => setTargetRtp(n)}
              />
              <button type="button" className="btn small" onClick={autoDistribute}>
                Auto-distribute
              </button>
            </div>

            <div className="stat">
              <span className="stat-label">Buckets</span>
              <span className="stat-value small">{rows.length}</span>
              <span className="stat-label" style={{ marginTop: 6 }}>
                Hit chance
              </span>
              <span className="stat-value small">
                {Number.isFinite(stats.hitChance) ? `${(stats.hitChance * 100).toFixed(2)}%` : '—'}
              </span>
            </div>
          </section>

          <main className="content">
            <section className="panel">
              <div className="panel-head">
                <h2>Buckets</h2>
                <span className="panel-hint">Click a header to sort · edit any cell, everything recalculates live</span>
              </div>
              <BucketTable
                rows={rows}
                totalWeight={totalWeight}
                sort={sort}
                onSort={handleSort}
                onPatch={patchRow}
              />
            </section>

            <section className="panel">
              <div className="panel-head">
                <h2>Chance distribution</h2>
                <div className="chart-controls">
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={aggregate}
                      onChange={(e) => setAggregate(e.target.checked)}
                    />
                    <span>Aggregate equal payouts</span>
                  </label>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={logScale}
                      onChange={(e) => setLogScale(e.target.checked)}
                    />
                    <span className="switch-track" aria-hidden="true" />
                    <span>Logarithmic Y</span>
                  </label>
                </div>
              </div>
              <DistributionChart
                rows={rows}
                totalWeight={totalWeight}
                aggregate={aggregate}
                logScale={logScale}
              />
            </section>
          </main>
        </>
      )}

      {(pasteOpen || rows.length === 0) && (
        <div className={rows.length === 0 ? 'paste-hero' : 'paste-overlay'} onClick={(e) => {
          if (rows.length > 0 && e.target === e.currentTarget) setPasteOpen(false)
        }}>
          <div className="paste-card">
            <h2>Paste bucket data</h2>
            <p className="paste-desc">
              Copy the contents of your engine&rsquo;s <code>.tsv</code> file and paste it below.
              Expected columns: <b>bucket ID</b> ⇥ <b>bucket label</b> ⇥ <b>payout bet multiplier</b>.
            </p>
            <textarea
              className="paste-area"
              spellCheck={false}
              placeholder={'0\tNo Win\t0\n1\tSmall Win\t2\n2\tBig Win\t50\n…'}
              value={pasteText}
              onChange={(e) => {
                setPasteText(e.target.value)
                setPasteError(null)
              }}
              autoFocus
            />
            {pasteError && <div className="paste-error">{pasteError}</div>}
            <div className="paste-actions">
              {rows.length > 0 && (
                <button type="button" className="btn ghost" onClick={() => setPasteOpen(false)}>
                  Cancel
                </button>
              )}
              <button type="button" className="btn ghost" onClick={() => loadData(SAMPLE_TSV)}>
                Use sample data
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={pasteText.trim() === ''}
                onClick={() => loadData(pasteText)}
              >
                Build table
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
