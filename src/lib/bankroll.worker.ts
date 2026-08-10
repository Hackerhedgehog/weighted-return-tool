import { buildAlias, mulberry32, type AliasTable } from './sim'
import {
  BANKROLL_CHUNK_SPINS,
  emptyPointBuffer,
  initialBankrollState,
  runBankrollBlock,
  samplePoint,
  scalePayouts,
  sealPoint,
  type BankrollMessage,
  type BankrollRequest,
  type BankrollState,
  type PointBuffer,
} from './bankroll'

/**
 * Scheduling shell around the pure core in bankroll.ts. Blocks run inside a
 * ~24ms timeslice, then yield through setTimeout so a terminate() from the
 * main thread can land between slices.
 *
 * Unlike sim.worker.ts this shell is stateful: `run` outlives the message that
 * created it, so a `continue` resumes the same balance and the same PRNG. That
 * retention is the whole reason this is a separate worker rather than a mode
 * inside the other one.
 *
 * Progress messages carry the *whole* point buffer rather than the new points.
 * It costs a little bandwidth and buys two things: decimation stays in exactly
 * one place, and the panel needs no buffer or flush timer of its own.
 */

// The app tsconfig targets the DOM lib, so `self` types as Window here.
interface WorkerScope {
  onmessage: ((e: MessageEvent<BankrollRequest>) => void) | null
  postMessage(msg: BankrollMessage): void
  setTimeout(fn: () => void, ms: number): number
}

const scope = self as unknown as WorkerScope
const TIMESLICE_MS = 24
const EMIT_MS = 100

interface Run {
  table: AliasTable
  rand: () => number
  bet: number
  state: BankrollState
  buf: PointBuffer
}

let run: Run | null = null
/**
 * True while a `runChunk` chain is actually mid-flight for `run`. This guards
 * something the identity check below cannot: `continue` calls `runChunk` on
 * the *same* `run` object, so `run !== r` never trips for a second `continue`
 * dispatched while the first chunk is still running — a chunk is up to 10M
 * spins over many 24ms slices, so that overlap is the normal case, not an
 * edge case. `busy` closes that gap by making a second `continue` a no-op
 * instead of a second concurrent loop drawing from the same PRNG.
 */
let busy = false

function runChunk(r: Run): void {
  let chunkSpins = 0
  let lastEmit = Date.now()
  busy = true

  const step = () => {
    // A newer `start` has replaced this run — abandon the old timeslice chain.
    // (This says nothing about `continue`; that overlap is `busy`'s job.)
    if (run !== r) return

    const start = Date.now()
    while (chunkSpins < BANKROLL_CHUNK_SPINS && Date.now() - start < TIMESLICE_MS) {
      // Run exactly up to the next sample boundary, so short runs still get
      // their fine-grained points. The boundary widens as the buffer decimates,
      // so this call's overhead shrinks as the run lengthens.
      const want = Math.min(
        BANKROLL_CHUNK_SPINS - chunkSpins,
        Math.max(1, r.buf.nextAt - r.state.spins),
      )
      chunkSpins += runBankrollBlock(r.table, r.rand, want, r.bet, r.state)
      samplePoint(r.buf, r.state)
      if (r.state.busted) break
    }

    if (r.state.busted || chunkSpins >= BANKROLL_CHUNK_SPINS) {
      // Clear before posting: by the time the panel could react to
      // `chunk-done` with another `continue`, this chain must already read
      // as free, not as still owning the run.
      busy = false
      sealPoint(r.buf, r.state)
      scope.postMessage({
        type: 'chunk-done',
        points: r.buf.points,
        state: { ...r.state },
        capped: !r.state.busted,
      })
      return
    }

    if (Date.now() - lastEmit >= EMIT_MS) {
      lastEmit = Date.now()
      scope.postMessage({ type: 'progress', points: r.buf.points, state: { ...r.state } })
    }
    scope.setTimeout(step, 0)
  }

  step()
}

scope.onmessage = (e: MessageEvent<BankrollRequest>) => {
  const msg = e.data

  if (msg.type === 'start') {
    const table = buildAlias(scalePayouts(msg.payouts, msg.config.rtpMultiplier), msg.weights)
    if (table === null) {
      run = null
      busy = false
      scope.postMessage({
        type: 'error',
        message: 'Every bucket has zero weight — nothing to play.',
      })
      return
    }
    run = {
      table,
      rand: mulberry32(msg.seed),
      bet: msg.config.bet,
      state: initialBankrollState(msg.config.credits),
      buf: emptyPointBuffer(),
    }
    runChunk(run)
    return
  }

  if (run === null) {
    scope.postMessage({ type: 'error', message: 'Nothing to continue — start a run first.' })
    return
  }
  // A chunk is already mid-flight for this run — the caller's request to
  // continue it is already satisfied, not an error and not a second chain.
  if (busy) return
  runChunk(run)
}
