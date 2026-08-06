import {
  blockPlan,
  buildAlias,
  emptyAggregate,
  mulberry32,
  runBlock,
  type SimRunRequest,
  type SimWorkerMessage,
} from './sim'

/**
 * Thin scheduling shell around the pure core in sim.ts. Blocks run inside a
 * ~24ms timeslice, then yield through setTimeout so a terminate() from the
 * main thread (or a queued message) can land between slices. One message per
 * block feeds the realtime chart; the aggregate rides along so the stat tiles
 * stay live without a second channel.
 */

// The app tsconfig targets the DOM lib, so `self` types as Window here.
// The worker only needs these three members.
interface WorkerScope {
  onmessage: ((e: MessageEvent<SimRunRequest>) => void) | null
  postMessage(msg: SimWorkerMessage): void
  setTimeout(fn: () => void, ms: number): number
}

const scope = self as unknown as WorkerScope
const TIMESLICE_MS = 24

scope.onmessage = (e: MessageEvent<SimRunRequest>) => {
  const { payouts, weights, spins, seed } = e.data

  const table = buildAlias(payouts, weights)
  if (table === null) {
    scope.postMessage({ type: 'error', message: 'Every bucket has zero weight — nothing to simulate.' })
    return
  }

  const { blockSize, blockCount } = blockPlan(spins)
  const rand = mulberry32(seed)
  const agg = emptyAggregate()
  let block = 0

  const step = () => {
    const start = Date.now()
    while (block < blockCount && Date.now() - start < TIMESLICE_MS) {
      const spinsThisBlock = Math.min(blockSize, spins - block * blockSize)
      const blockMean = runBlock(table, rand, spinsThisBlock, agg)
      scope.postMessage({ type: 'block', blockIndex: block, blockMean, agg: { ...agg } })
      block += 1
    }
    if (block < blockCount) scope.setTimeout(step, 0)
    else scope.postMessage({ type: 'done', agg: { ...agg } })
  }

  step()
}
