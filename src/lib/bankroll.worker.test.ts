import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { BankrollMessage, BankrollRequest } from './bankroll'

/**
 * The scheduling shell has no coverage anywhere else: `bankroll.test.ts`
 * tests the pure arithmetic it wraps, `BankrollSim.test.tsx` tests the panel
 * that talks to it, and neither exercises `busy`, the `run !== r` abandonment
 * check, or the `want` calculation that keeps `samplePoint` inside its
 * documented precondition.
 *
 * `self` is stubbed and the module dynamically re-imported per test, with
 * `vi.resetModules()` first — `run` and `busy` are module-level state, so a
 * leftover from a previous test would silently make the next one pass for
 * the wrong reason instead of failing loudly.
 *
 * The worker yields between timeslices via `setTimeout(step, 0)`; the fake
 * `self.setTimeout` here queues the callback instead of scheduling it for
 * later, and `drain()` pumps the queue on the test's own schedule. That is
 * what keeps this deterministic — no real waiting, no fake-timer bookkeeping
 * to get wrong.
 */

interface FakeSelf {
  posted: BankrollMessage[]
  send: (msg: BankrollRequest) => void
  drain: () => void
}

function stubSelf(): FakeSelf {
  const queued: (() => void)[] = []
  const posted: BankrollMessage[] = []
  const scope = {
    onmessage: null as ((e: MessageEvent<BankrollRequest>) => void) | null,
    postMessage: (msg: BankrollMessage) => posted.push(msg),
    setTimeout: (fn: () => void) => {
      queued.push(fn)
      return 0
    },
  }
  vi.stubGlobal('self', scope)
  return {
    posted,
    send: (msg) => scope.onmessage?.({ data: msg } as MessageEvent<BankrollRequest>),
    drain: () => {
      while (queued.length > 0) queued.shift()!()
    },
  }
}

/**
 * Forces every `step()` call to process exactly one boundary-sized batch
 * before yielding, regardless of how fast the arithmetic actually runs —
 * real elapsed time for a few hundred spins is microseconds, nowhere near
 * the 24ms timeslice, so without this a whole chunk would just complete
 * synchronously in one call and there would be no mid-flight window to test.
 *
 * A constant 15ms step per `Date.now()` call does it: the read right after
 * `start` always sees one call's worth of elapsed time (15ms, under the
 * 24ms slice, so the first iteration runs), and the read after that sees two
 * calls' worth (30ms, over the slice, so the loop exits). This holds for any
 * number of iterations-per-slice the code might do, not just today's count —
 * it only assumes two `Date.now()` reads are involved in the decision to
 * keep looping, which is what makes it a timeslice at all.
 */
function mockSlicedTime(): () => void {
  let t = 0
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => (t += 15))
  return () => spy.mockRestore()
}

// Every spin loses the bet outright — no RNG outcome can avoid the bust, so
// the spin count a run busts at is exact and independent of the seed.
const DEAD_TABLE = { payouts: [0], weights: [1] }

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('bankroll.worker — the busy guard', () => {
  async function runAfterStart(continues: number) {
    // `run` and `busy` are module-level state, and this helper is called
    // twice per test — resetModules only in `beforeEach` would leave the
    // second call reusing the first call's already-bound module instance.
    vi.resetModules()
    const restore = mockSlicedTime()
    const self = stubSelf()
    await import('./bankroll.worker')

    self.send({
      type: 'start',
      payouts: DEAD_TABLE.payouts,
      weights: DEAD_TABLE.weights,
      config: { credits: 250, bet: 1, rtpMultiplier: 1 },
      seed: 7,
    })
    // `start`'s own chunk has only run its first sliced batch at this point —
    // busy is still true. This is the exact window a rapid Continue click (or,
    // as this test cares about, two of them back to back) can land in.
    for (let i = 0; i < continues; i++) self.send({ type: 'continue' })
    self.drain()
    restore()

    const done = self.posted.filter((m) => m.type === 'chunk-done')
    const last = done[done.length - 1]
    if (last === undefined) {
      throw new Error('expected the run to have finished with a chunk-done message')
    }
    return { state: last.state, doneCount: done.length }
  }

  it('two rapid continues while the chunk is mid-flight post exactly one chunk-done, same as one', async () => {
    const withTwo = await runAfterStart(2)
    const withOne = await runAfterStart(1)
    // The direct signal: an unguarded continue spawns its own `runChunk`
    // chain, and that chain notices the eventual bust independently of the
    // original one and posts its own chunk-done — so a second (or third)
    // overlapping continue means a second (or third) chunk-done, not zero
    // extra messages. Comparing final `state` alone would miss this: on a
    // table this deterministic, extra overlapping chains are idempotent
    // once the bust has already landed, so the last-posted state matches
    // regardless — only the message count tells the two scenarios apart.
    expect(withTwo.doneCount).toBe(1)
    expect(withOne.doneCount).toBe(1)
    expect(withTwo.state).toEqual(withOne.state)
    // Pin the shape too, so a change that breaks both sides identically
    // (and would otherwise pass the equality check above) still gets caught.
    expect(withTwo.state.busted).toBe(true)
    expect(withTwo.state.spins).toBe(250)
    expect(withTwo.state.balance).toBe(0)
  })

  it('a continue with no retained run posts an error and does not throw', async () => {
    const self = stubSelf()
    await import('./bankroll.worker')

    expect(() => self.send({ type: 'continue' })).not.toThrow()
    expect(self.posted).toEqual([
      { type: 'error', message: 'Nothing to continue — start a run first.' },
    ])
  })

  it('a start on an all-zero-weight table errors, and a later valid start still runs', async () => {
    const self = stubSelf()
    await import('./bankroll.worker')

    self.send({
      type: 'start',
      payouts: [0, 2],
      weights: [0, 0],
      config: { credits: 100, bet: 1, rtpMultiplier: 1 },
      seed: 1,
    })
    expect(self.posted).toEqual([
      { type: 'error', message: 'Every bucket has zero weight — nothing to play.' },
    ])

    self.send({
      type: 'start',
      payouts: DEAD_TABLE.payouts,
      weights: DEAD_TABLE.weights,
      config: { credits: 5, bet: 1, rtpMultiplier: 1 },
      seed: 2,
    })
    self.drain()

    const last = self.posted[self.posted.length - 1]
    expect(last.type).toBe('chunk-done')
    if (last.type === 'chunk-done') {
      expect(last.state.busted).toBe(true)
      expect(last.state.spins).toBe(5)
    }
  })
})
