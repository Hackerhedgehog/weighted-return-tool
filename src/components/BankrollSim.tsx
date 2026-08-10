import { useEffect, useRef, useState } from 'react'
import type { BankrollConfig, BucketRow } from '../lib/types'
import {
  BANKROLL_CHUNK_SPINS,
  effectiveRtp,
  initialBankrollState,
  realisedRtp,
  type BankrollMessage,
  type BankrollPoint,
  type BankrollRequest,
  type BankrollState,
} from '../lib/bankroll'
import { parseAmount } from '../lib/sim'
import { fmtDecimal, fmtRtp, fmtWeight } from '../lib/format'
import { BankrollChart } from './BankrollChart'
import { ChartResizeGrip } from './ChartResizeGrip'
import { SIM_HEIGHT } from './chartUtils'
import { remapNumpadComma } from './numpadDecimal'

/**
 * Play the table with a real balance: start with X credits, stake Y per spin,
 * and watch the balance until it busts or reaches the chunk cap.
 *
 * The worker retains its state between chunks, so `Continue` extends one run
 * rather than starting a new one — the panel just posts `continue` and keeps
 * appending to the same chart. Because the worker sends the whole point buffer
 * on every message, this panel needs no ref-buffer and no flush timer of its
 * own, unlike ConvergenceSim.
 */

/** What the panel needs from a worker — lets tests fake the platform edge. */
export interface BankrollWorkerLike {
  onmessage: ((e: MessageEvent<BankrollMessage>) => void) | null
  postMessage(msg: BankrollRequest): void
  terminate(): void
}

interface BankrollSimProps {
  rows: BucketRow[]
  totalWeight: number
  /** The table's weighted return right now, before the multiplier. */
  tableRtp: number
  config: BankrollConfig
  onConfig: (c: BankrollConfig) => void
  chartHeight: number
  onChartHeight: (h: number) => void
  createWorker?: () => BankrollWorkerLike
}

interface Run {
  status: 'running' | 'capped' | 'busted' | 'cancelled' | 'error'
  /** Snapshotted at Run, so the chart's reference matches what ran. */
  startCredits: number
  points: BankrollPoint[]
  state: BankrollState
  error?: string
}

const CREDITS = { min: 1, max: 1e12, integer: true }
const BET = { min: 1e-6, max: 1e12, integer: false }
const MULT = { min: 0, max: 1000, integer: false }

const defaultFactory = (): BankrollWorkerLike =>
  new Worker(new URL('../lib/bankroll.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as BankrollWorkerLike

export function BankrollSim({
  rows,
  totalWeight,
  tableRtp,
  config,
  onConfig,
  chartHeight,
  onChartHeight,
  createWorker,
}: BankrollSimProps) {
  const [run, setRun] = useState<Run | null>(null)
  const workerRef = useRef<BankrollWorkerLike | null>(null)

  // A leftover worker must not outlive the panel.
  useEffect(
    () => () => {
      workerRef.current?.terminate()
    },
    [],
  )

  const workersAvailable = createWorker !== undefined || typeof Worker !== 'undefined'
  const affordable = config.bet <= config.credits
  const canRun = rows.length > 0 && totalWeight > 0 && workersAvailable && affordable

  const effective = effectiveRtp(tableRtp, config.rtpMultiplier)
  const running = run?.status === 'running'

  const stopWorker = () => {
    workerRef.current?.terminate()
    workerRef.current = null
  }

  const handleMessage = (msg: BankrollMessage) => {
    if (msg.type === 'progress') {
      setRun((prev) =>
        prev === null ? prev : { ...prev, points: msg.points, state: msg.state },
      )
    } else if (msg.type === 'chunk-done') {
      // `capped` is already false on a bust, but read both rather than trusting
      // one to imply the other — a resumable run that cannot be resumed is the
      // one bug in here a user could not recover from without a reload.
      const resumable = msg.capped && !msg.state.busted
      setRun((prev) =>
        prev === null
          ? prev
          : {
              ...prev,
              points: msg.points,
              state: msg.state,
              status: resumable ? 'capped' : 'busted',
            },
      )
      // A resumable chunk keeps the worker alive so Continue can pick it up.
      if (!resumable) stopWorker()
    } else {
      stopWorker()
      setRun((prev) => (prev === null ? prev : { ...prev, status: 'error', error: msg.message }))
    }
  }

  const start = () => {
    if (!canRun) return
    // Run stays clickable on a capped chunk (so a stuck-but-solvent run can be
    // abandoned for a fresh one), but a capped chunk deliberately keeps its
    // worker alive for Continue — so this is the one place that has to tear
    // an existing worker down explicitly, or it runs on unreferenced.
    stopWorker()
    const worker = (createWorker ?? defaultFactory)()
    workerRef.current = worker
    worker.onmessage = (e) => handleMessage(e.data)
    worker.postMessage({
      type: 'start',
      payouts: rows.map((r) => r.payout),
      weights: rows.map((r) => Math.max(0, Math.round(r.weight))),
      config,
      seed: (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0,
    })
    setRun({
      status: 'running',
      startCredits: config.credits,
      points: [],
      state: initialBankrollState(config.credits),
    })
  }

  const resume = () => {
    if (workerRef.current === null) return
    workerRef.current.postMessage({ type: 'continue' })
    setRun((prev) => (prev === null ? prev : { ...prev, status: 'running' }))
  }

  const cancel = () => {
    stopWorker()
    setRun((prev) => (prev === null ? prev : { ...prev, status: 'cancelled' }))
  }

  const stats = run?.state ?? null
  // A chunk that reached the cap is 100% done, but `spins % CHUNK` is exactly 0
  // there — the modulo alone would snap a finished bar back to empty.
  const chunkProgress =
    run === null
      ? 0
      : run.status === 'capped'
        ? 1
        : (run.state.spins % BANKROLL_CHUNK_SPINS) / BANKROLL_CHUNK_SPINS

  const outcome = (): string => {
    if (run === null) return ''
    const spins = fmtWeight(run.state.spins)
    if (run.status === 'running') return `${spins} spins · ${fmtWeight(run.state.balance)} credits`
    if (run.status === 'busted') return `busted after ${spins} spins`
    if (run.status === 'cancelled') return `cancelled · ${spins} spins`
    if (run.status === 'error') return 'stopped'
    return `${spins} spins · ${fmtWeight(run.state.balance)} credits left`
  }

  // Float slop: `0.95 * (1 / 0.95)` lands one ULP under 1, not exactly at it —
  // the epsilon keeps the "1 or above" boundary honest to intent rather than
  // to double-precision multiplication.
  const showWarning = effective >= 1 - 1e-9

  return (
    <>
      {showWarning && (
        <div className="notice warn" role="status" aria-label="Bankroll warning">
          Effective RTP is {fmtRtp(effective)} — at 1 or above the balance drifts upward, so a bust
          becomes very unlikely and the run will usually just reach the spin cap.
        </div>
      )}

      <div className="sim-controls">
        <AmountField
          label="Credits"
          aria="Starting credits"
          value={config.credits}
          format={fmtWeight}
          opts={CREDITS}
          onCommit={(credits) => onConfig({ ...config, credits })}
          title="Plain number or shorthand: 1m, 250k"
        />
        <AmountField
          label="Bet"
          aria="Bet"
          value={config.bet}
          format={(n) => fmtDecimal(n, 6)}
          opts={BET}
          onCommit={(bet) => onConfig({ ...config, bet })}
          title="Credits staked per spin"
        />
        <AmountField
          label="RTP×"
          aria="RTP multiplier"
          value={config.rtpMultiplier}
          format={(n) => fmtDecimal(n, 6)}
          opts={MULT}
          onCommit={(rtpMultiplier) => onConfig({ ...config, rtpMultiplier })}
          title="Scales every payout — the table itself is not changed"
        />

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
              !workersAvailable
                ? 'Web Workers are unavailable in this browser'
                : !affordable
                  ? 'The bet is larger than the starting credits — the run would bust at zero spins'
                  : 'Play the current table until the credits run out'
            }
          >
            Run
          </button>
        )}

        {run?.status === 'capped' && (
          <button type="button" className="btn primary" onClick={resume}>
            Continue
          </button>
        )}

        {run !== null && (
          <div className="sim-progress" role="status">
            <div className="sim-progress-track">
              <div
                className="sim-progress-fill"
                style={{ width: `${Math.min(100, chunkProgress * 100)}%` }}
              />
            </div>
            <span className="sim-progress-text">{outcome()}</span>
          </div>
        )}

        {run?.error !== undefined && <div className="paste-error">{run.error}</div>}
      </div>

      {stats !== null && (
        <div className="sim-stats">
          <div className="sim-tile">
            <span className="sim-tile-value">{fmtWeight(stats.balance)}</span>
            <span className="sim-tile-label">Balance</span>
          </div>
          <div className="sim-tile">
            <span className="sim-tile-value">{fmtWeight(stats.spins)}</span>
            <span className="sim-tile-label">Spins Survived</span>
          </div>
          <div className="sim-tile">
            <span className="sim-tile-value">{fmtWeight(stats.peak)}</span>
            <span className="sim-tile-label">Peak</span>
          </div>
          <div className="sim-tile">
            <span className="sim-tile-value">{fmtWeight(stats.low)}</span>
            <span className="sim-tile-label">Lowest</span>
          </div>
          <div className="sim-tile">
            <span className="sim-tile-value">{fmtRtp(realisedRtp(stats))}</span>
            <span className="sim-tile-label">RTP · table {fmtRtp(effective)}</span>
          </div>
          <div className="sim-tile">
            <span className="sim-tile-value">{fmtWeight(stats.maxWin * config.bet)}</span>
            <span className="sim-tile-label">Biggest Win</span>
          </div>
        </div>
      )}

      {run !== null ? (
        <BankrollChart
          points={run.points}
          startCredits={run.startCredits}
          state={run.state}
          height={chartHeight}
          onHeight={onChartHeight}
        />
      ) : (
        <div className="chart-wrap">
          <div className="chart-empty" style={{ height: chartHeight }}>
            Run a bankroll to see how long {fmtWeight(config.credits)} credits last at a bet of{' '}
            {fmtDecimal(config.bet, 6)}.
          </div>
          <ChartResizeGrip
            height={chartHeight}
            range={SIM_HEIGHT}
            label="Resize the simulation chart"
            onHeight={onChartHeight}
          />
        </div>
      )}
    </>
  )
}

/**
 * One numeric field. Local text state so a half-typed value is not fought by
 * the parser, committed on Enter and blur — the same contract the spins field
 * uses, extracted because there are three of them here.
 */
function AmountField({
  label,
  aria,
  value,
  format,
  opts,
  onCommit,
  title,
}: {
  label: string
  aria: string
  value: number
  format: (n: number) => string
  opts: { min: number; max: number; integer: boolean }
  onCommit: (n: number) => void
  title: string
}) {
  const [text, setText] = useState(() => format(value))
  // Re-derive when the setting changes from outside — the render-time
  // adjustment pattern, not an effect.
  const [last, setLast] = useState(value)
  if (value !== last) {
    setLast(value)
    setText(format(value))
  }

  const commit = () => {
    const parsed = parseAmount(text, opts)
    if (parsed === null) {
      setText(format(value))
      return
    }
    setText(format(parsed))
    if (parsed !== value) onCommit(parsed)
  }

  return (
    <label className="sim-field">
      <span>{label}</span>
      <input
        aria-label={aria}
        className="panel-num sim-spins"
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (remapNumpadComma(e)) {
            setText(e.currentTarget.value)
            return
          }
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setText(format(value))
        }}
        title={title}
      />
    </label>
  )
}
