import { useEffect, useRef, useState } from 'react'
import type { BucketRow } from '../lib/types'
import {
  blockPlan,
  emptyAggregate,
  parseSpinsInput,
  statsFromAggregate,
  type SimAggregate,
  type SimRunRequest,
  type SimWorkerMessage,
} from '../lib/sim'
import { fmtPayout, fmtPct, fmtRtp, fmtWeight } from '../lib/format'
import { SimChart } from './SimChart'

/**
 * Monte Carlo panel: spins input, Run/Cancel, live stat tiles and the
 * realtime chart. The run snapshots the table when Run is clicked — edits
 * made mid-run don't bend an in-flight simulation.
 *
 * Worker messages arrive far faster than React should render, so block data
 * lands in refs and is flushed to state at most every FLUSH_MS; terminal
 * messages flush immediately.
 */

/** What the panel needs from a worker — lets tests fake the platform edge. */
export interface SimWorkerLike {
  onmessage: ((e: MessageEvent<SimWorkerMessage>) => void) | null
  postMessage(msg: SimRunRequest): void
  terminate(): void
}

interface SimulationPanelProps {
  rows: BucketRow[]
  totalWeight: number
  /** The table's weighted return right now — the chart's reference line. */
  expectedRtp: number
  spins: number
  onSpins: (n: number) => void
  createWorker?: () => SimWorkerLike
}

interface Run {
  status: 'running' | 'done' | 'cancelled' | 'error'
  requested: number
  blockSize: number
  /** Expected RTP snapshotted at Run, so the reference matches what ran. */
  expectedRtp: number
  points: number[]
  agg: SimAggregate
  error?: string
}

const FLUSH_MS = 80

const defaultFactory = (): SimWorkerLike =>
  new Worker(new URL('../lib/sim.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as SimWorkerLike

export function SimulationPanel({
  rows,
  totalWeight,
  expectedRtp,
  spins,
  onSpins,
  createWorker,
}: SimulationPanelProps) {
  const [run, setRun] = useState<Run | null>(null)
  const [spinsText, setSpinsText] = useState(() => fmtWeight(spins))

  const workerRef = useRef<SimWorkerLike | null>(null)
  const pointsRef = useRef<number[]>([])
  const aggRef = useRef<SimAggregate>(emptyAggregate())
  const flushTimer = useRef<number | null>(null)
  const lastFlush = useRef(0)

  useEffect(() => {
    setSpinsText(fmtWeight(spins))
  }, [spins])

  // A leftover worker must not outlive the panel.
  useEffect(
    () => () => {
      workerRef.current?.terminate()
      if (flushTimer.current !== null) window.clearTimeout(flushTimer.current)
    },
    [],
  )

  const workersAvailable = createWorker !== undefined || typeof Worker !== 'undefined'
  const canRun = rows.length > 0 && totalWeight > 0 && workersAvailable

  const flush = (status?: Run['status'], error?: string) => {
    if (flushTimer.current !== null) {
      window.clearTimeout(flushTimer.current)
      flushTimer.current = null
    }
    lastFlush.current = Date.now()
    setRun((prev) =>
      prev === null
        ? prev
        : {
            ...prev,
            points: [...pointsRef.current],
            agg: aggRef.current,
            ...(status !== undefined ? { status } : {}),
            ...(error !== undefined ? { error } : {}),
          },
    )
  }

  const throttledFlush = () => {
    if (Date.now() - lastFlush.current >= FLUSH_MS) {
      flush()
    } else if (flushTimer.current === null) {
      flushTimer.current = window.setTimeout(() => {
        flushTimer.current = null
        flush()
      }, FLUSH_MS)
    }
  }

  const stopWorker = () => {
    workerRef.current?.terminate()
    workerRef.current = null
  }

  const handleMessage = (msg: SimWorkerMessage) => {
    if (msg.type === 'block') {
      pointsRef.current.push(msg.blockMean)
      aggRef.current = msg.agg
      throttledFlush()
    } else if (msg.type === 'done') {
      aggRef.current = msg.agg
      stopWorker()
      flush('done')
    } else {
      stopWorker()
      flush('error', msg.message)
    }
  }

  const start = () => {
    if (!canRun) return
    const factory = createWorker ?? defaultFactory
    pointsRef.current = []
    aggRef.current = emptyAggregate()

    const worker = factory()
    workerRef.current = worker
    worker.onmessage = (e) => handleMessage(e.data)
    worker.postMessage({
      payouts: rows.map((r) => r.payout),
      weights: rows.map((r) => Math.max(0, Math.round(r.weight))),
      spins,
      seed: (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0,
    })

    setRun({
      status: 'running',
      requested: spins,
      blockSize: blockPlan(spins).blockSize,
      expectedRtp,
      points: [],
      agg: emptyAggregate(),
    })
  }

  const cancel = () => {
    stopWorker()
    flush('cancelled')
  }

  const commitSpins = () => {
    const parsed = parseSpinsInput(spinsText)
    if (parsed === null) {
      setSpinsText(fmtWeight(spins))
      return
    }
    setSpinsText(fmtWeight(parsed))
    if (parsed !== spins) onSpins(parsed)
  }

  const stats = run !== null ? statsFromAggregate(run.agg) : null
  const running = run?.status === 'running'
  const progress = run !== null && run.requested > 0 ? run.agg.spins / run.requested : 0

  return (
    <>
      <div className="sim-controls">
        <label className="sim-field">
          <span>Spins</span>
          <input
            aria-label="Spins"
            className="panel-num sim-spins"
            value={spinsText}
            spellCheck={false}
            onChange={(e) => setSpinsText(e.target.value)}
            onBlur={commitSpins}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitSpins()
              if (e.key === 'Escape') setSpinsText(fmtWeight(spins))
            }}
            title="Plain number or shorthand: 100m, 250k, 1b"
          />
        </label>

        {running ? (
          <button type="button" className="btn" onClick={cancel}>
            Cancel
          </button>
        ) : (
          <button
            type="button"
            className="btn primary"
            disabled={!canRun}
            onClick={start}
            title={
              workersAvailable
                ? 'Simulate spins against the current table'
                : 'Web Workers are unavailable in this browser'
            }
          >
            Run
          </button>
        )}

        {run !== null && (
          <div className="sim-progress" role="status">
            <div className="sim-progress-track">
              <div className="sim-progress-fill" style={{ width: `${Math.min(100, progress * 100)}%` }} />
            </div>
            <span className="sim-progress-text">
              {running
                ? `${fmtPct(progress, 1)} · ${fmtWeight(run.agg.spins)} / ${fmtWeight(run.requested)} spins`
                : `${run.status === 'done' ? 'finished' : run.status} · ${fmtWeight(run.agg.spins)} spins`}
            </span>
          </div>
        )}

        {run?.error !== undefined && <div className="paste-error">{run.error}</div>}
      </div>

      {stats !== null && stats.spins > 0 && (
        <div className="sim-stats">
          <div className="sim-tile">
            <span className="sim-tile-value">{fmtRtp(stats.rtp)}</span>
            <span className="sim-tile-label">RTP · table {fmtRtp(run!.expectedRtp)}</span>
          </div>
          <div className="sim-tile">
            <span className="sim-tile-value">{fmtRtp(stats.stdDev)}</span>
            <span className="sim-tile-label">Std Deviation</span>
          </div>
          <div className="sim-tile">
            <span className="sim-tile-value">{fmtPct(stats.hitRate, 3)}</span>
            <span className="sim-tile-label">Hit Rate</span>
          </div>
          <div className="sim-tile">
            <span className="sim-tile-value">{fmtPct(stats.winRate, 3)}</span>
            <span className="sim-tile-label">Win Rate</span>
          </div>
          <div className="sim-tile">
            <span className="sim-tile-value">×{fmtPayout(stats.maxWin)}</span>
            <span className="sim-tile-label">Max Win × Bet</span>
          </div>
          <div className="sim-tile">
            <span className="sim-tile-value">{fmtWeight(stats.spins)}</span>
            <span className="sim-tile-label">Spins Simulated</span>
          </div>
        </div>
      )}

      {run !== null ? (
        <SimChart
          points={run.points}
          blockSize={run.blockSize}
          requestedSpins={run.requested}
          expectedRtp={run.expectedRtp}
        />
      ) : (
        <div className="chart-empty">
          Run a simulation to see the spin-by-spin results converge on the table's RTP.
        </div>
      )}
    </>
  )
}
