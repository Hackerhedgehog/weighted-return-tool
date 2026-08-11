// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { BankrollSim, type BankrollWorkerLike } from './BankrollSim'
import {
  initialBankrollState,
  type BankrollMessage,
  type BankrollRequest,
  type BankrollState,
} from '../lib/bankroll'
import { DEFAULT_BANKROLL, type BankrollConfig, type BucketRow } from '../lib/types'

const rows: BucketRow[] = [
  { uid: 'a', bucketId: 0, payout: 0, label: '0x', weight: 700_000, locked: false, groupId: 'other', weightId: '' },
  { uid: 'b', bucketId: 1, payout: 2, label: '1-2x', weight: 300_000, locked: false, groupId: 'other', weightId: '' },
]

class FakeWorker implements BankrollWorkerLike {
  onmessage: ((e: MessageEvent<BankrollMessage>) => void) | null = null
  posted: BankrollRequest[] = []
  terminated = false
  postMessage(msg: BankrollRequest) {
    this.posted.push(msg)
  }
  terminate() {
    this.terminated = true
  }
}

const reply = (w: FakeWorker, msg: BankrollMessage) => {
  act(() => {
    w.onmessage?.({ data: msg } as MessageEvent<BankrollMessage>)
  })
}

const state = (over: Partial<BankrollState> = {}): BankrollState => ({
  ...initialBankrollState(1000),
  spins: 300,
  balance: 1200,
  peak: 1400,
  low: 800,
  sum: 285,
  maxWin: 12,
  ...over,
})

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

afterEach(cleanup)

function renderSim(
  worker?: FakeWorker,
  config: BankrollConfig = DEFAULT_BANKROLL,
  tableRtp = 0.95,
) {
  const onConfig = vi.fn()
  render(
    <BankrollSim
      rows={rows}
      totalWeight={1_000_000}
      tableRtp={tableRtp}
      config={config}
      onConfig={onConfig}
      chartHeight={260}
      onChartHeight={vi.fn()}
      yZoom={1}
      onYZoom={vi.fn()}
      createWorker={worker === undefined ? undefined : () => worker}
    />,
  )
  return onConfig
}

describe('BankrollSim fields', () => {
  it('shows the configured credits, bet and multiplier', () => {
    renderSim(new FakeWorker())
    expect(screen.getByDisplayValue('1,000,000')).toBeDefined()
    expect((screen.getByLabelText('Bet') as HTMLInputElement).value).toBe('1')
    expect((screen.getByLabelText('RTP multiplier') as HTMLInputElement).value).toBe('1')
  })

  it('commits shorthand credits on Enter', () => {
    const onConfig = renderSim(new FakeWorker())
    const input = screen.getByLabelText('Starting credits')
    fireEvent.change(input, { target: { value: '2m' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onConfig).toHaveBeenCalledWith({ ...DEFAULT_BANKROLL, credits: 2_000_000 })
  })

  it('keeps a fractional bet', () => {
    const onConfig = renderSim(new FakeWorker())
    const input = screen.getByLabelText('Bet')
    fireEvent.change(input, { target: { value: '0.5' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onConfig).toHaveBeenCalledWith({ ...DEFAULT_BANKROLL, bet: 0.5 })
  })

  it('reverts an unreadable entry on blur', () => {
    renderSim(new FakeWorker())
    const input = screen.getByLabelText('Bet')
    fireEvent.change(input, { target: { value: 'abc' } })
    fireEvent.blur(input)
    expect((input as HTMLInputElement).value).toBe('1')
  })
})

describe('BankrollSim guards', () => {
  it('disables Run when the bet exceeds the credits', () => {
    renderSim(new FakeWorker(), { credits: 10, bet: 50, rtpMultiplier: 1 })
    expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('disables Run when workers are unavailable', () => {
    renderSim(undefined)
    expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('warns at an effective RTP of 1 but still allows the run', () => {
    // 0.5 * 2 is exactly 1 in floating point — unlike 0.95 * (1 / 0.95),
    // which lands one ULP under 1 and never actually reaches the boundary
    // this test claims to pin.
    renderSim(new FakeWorker(), { ...DEFAULT_BANKROLL, rtpMultiplier: 2 }, 0.5)
    expect(screen.getByRole('status', { name: 'Bankroll warning' })).toBeDefined()
    expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('does not warn just below an effective RTP of 1', () => {
    renderSim(new FakeWorker(), { ...DEFAULT_BANKROLL, rtpMultiplier: 0.999 }, 1)
    expect(screen.queryByRole('status', { name: 'Bankroll warning' })).toBeNull()
  })

  it('does not warn below an effective RTP of 1', () => {
    renderSim(new FakeWorker(), DEFAULT_BANKROLL, 0.95)
    expect(screen.queryByRole('status', { name: 'Bankroll warning' })).toBeNull()
  })
})

describe('BankrollSim runs', () => {
  it('starts a run with scaled config and the raw table', () => {
    const w = new FakeWorker()
    renderSim(w)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))

    expect(w.posted).toHaveLength(1)
    const msg = w.posted[0]
    expect(msg.type).toBe('start')
    if (msg.type !== 'start') throw new Error('expected a start message')
    expect(msg.payouts).toEqual([0, 2])
    expect(msg.weights).toEqual([700_000, 300_000])
    expect(msg.config).toEqual(DEFAULT_BANKROLL)
  })

  it('streams the balance and the stat tiles', () => {
    const w = new FakeWorker()
    renderSim(w)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))

    reply(w, {
      type: 'progress',
      points: [{ spins: 100, balance: 1200 }],
      state: state(),
    })

    const tiles = within(document.querySelector('.sim-stats') as HTMLElement)
    expect(tiles.getByText('1,200')).toBeDefined() // balance
    expect(tiles.getByText('1,400')).toBeDefined() // peak
    expect(tiles.getByText('800')).toBeDefined() // lowest
  })

  it('offers Continue only when a chunk capped with credit left', () => {
    const w = new FakeWorker()
    renderSim(w)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))

    reply(w, {
      type: 'chunk-done',
      points: [{ spins: 10_000_000, balance: 1200 }],
      state: state({ spins: 10_000_000 }),
      capped: true,
    })
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(w.posted[1]).toEqual({ type: 'continue' })
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
  })

  it('clicking Run while a chunk is capped terminates the parked worker and starts a fresh one', () => {
    const workers: FakeWorker[] = []
    const createWorker = () => {
      const w = new FakeWorker()
      workers.push(w)
      return w
    }
    render(
      <BankrollSim
        rows={rows}
        totalWeight={1_000_000}
        tableRtp={0.95}
        config={DEFAULT_BANKROLL}
        onConfig={vi.fn()}
        chartHeight={260}
        onChartHeight={vi.fn()}
        yZoom={1}
        onYZoom={vi.fn()}
        createWorker={createWorker}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    const first = workers[0]

    reply(first, {
      type: 'chunk-done',
      points: [{ spins: 10_000_000, balance: 1200 }],
      state: state({ spins: 10_000_000 }),
      capped: true,
    })
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(first.terminated).toBe(true)
    expect(workers).toHaveLength(2)
    expect(workers[1].posted).toHaveLength(1)
    expect(workers[1].posted[0].type).toBe('start')
  })

  it('offers no Continue after a bust', () => {
    const w = new FakeWorker()
    renderSim(w)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))

    reply(w, {
      type: 'chunk-done',
      points: [{ spins: 4200, balance: 0 }],
      state: state({ spins: 4200, balance: 0, busted: true }),
      capped: false,
    })
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
    // scoped to the progress line — the chart legend also says "busted"
    expect(document.querySelector('.sim-progress-text')?.textContent).toBe(
      'busted after 4,200 spins',
    )
  })

  it('cancel terminates the worker, ends the run and keeps the line', () => {
    const w = new FakeWorker()
    renderSim(w)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    reply(w, { type: 'progress', points: [{ spins: 100, balance: 1200 }], state: state() })

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(w.terminated).toBe(true)
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
    expect(document.querySelector('.bankroll-path')).not.toBeNull()
  })

  it('surfaces a worker error', () => {
    const w = new FakeWorker()
    renderSim(w)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    reply(w, { type: 'error', message: 'Every bucket has zero weight — nothing to play.' })
    expect(screen.getByText(/zero weight/)).toBeDefined()
  })

  it('shows the y-axis zoom handle once a run has produced a chart', () => {
    const w = new FakeWorker()
    renderSim(w)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    reply(w, { type: 'progress', points: [{ spins: 100, balance: 1200 }], state: state() })
    expect(screen.getByRole('slider', { name: "Zoom the bankroll chart's y-axis" })).toBeDefined()
  })
})

describe('BankrollSim stat tiles snapshot the run', () => {
  it('scales Biggest Win by the run\'s own bet, not the default of 1', () => {
    const w = new FakeWorker()
    renderSim(w, { ...DEFAULT_BANKROLL, bet: 4 })
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))

    reply(w, { type: 'progress', points: [{ spins: 100, balance: 1200 }], state: state({ maxWin: 12 }) })

    const tiles = within(document.querySelector('.sim-stats') as HTMLElement)
    expect(tiles.getByText('48')).toBeDefined()
  })

  it('keeps the Biggest Win and RTP tiles pinned to the run after a live Bet edit', () => {
    const w = new FakeWorker()
    const onConfig = vi.fn()
    const props = (config: BankrollConfig) => ({
      rows,
      totalWeight: 1_000_000,
      tableRtp: 0.95,
      config,
      onConfig,
      chartHeight: 260,
      onChartHeight: vi.fn(),
      yZoom: 1,
      onYZoom: vi.fn(),
      createWorker: () => w,
    })
    const { rerender } = render(<BankrollSim {...props(DEFAULT_BANKROLL)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))

    reply(w, {
      type: 'chunk-done',
      points: [{ spins: 10_000_000, balance: 1200 }],
      state: state({ spins: 10_000_000, maxWin: 12 }),
      capped: true,
    })

    const tiles = () => within(document.querySelector('.sim-stats') as HTMLElement)
    expect(tiles().getByText('12')).toBeDefined()

    const input = screen.getByLabelText('Bet')
    fireEvent.change(input, { target: { value: '10' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onConfig).toHaveBeenCalledWith({ ...DEFAULT_BANKROLL, bet: 10 })

    // The parent applies the edit — `config` now carries the new bet — but a
    // chunk that already ran at bet 1 must not relabel itself as bet 10.
    rerender(<BankrollSim {...props({ ...DEFAULT_BANKROLL, bet: 10 })} />)
    expect(tiles().getByText('12')).toBeDefined()
    expect(tiles().queryByText('120')).toBeNull()
  })

  it('shows a fractional busted balance as a fraction, not rounded up to a whole credit', () => {
    // Bets can be fractional (BET.integer is false), so a run can bust
    // holding half a credit — fmtWeight would round that to "1", reading as
    // a lie right next to a legend that says there is no credit left to bet.
    const w = new FakeWorker()
    renderSim(w)
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))

    reply(w, {
      type: 'chunk-done',
      points: [{ spins: 10, balance: 0.5 }],
      state: state({ spins: 10, balance: 0.5, low: 0.5, busted: true }),
      capped: false,
    })

    const tiles = within(document.querySelector('.sim-stats') as HTMLElement)
    // Balance and Lowest both land on 0.5 — the run busted right there.
    expect(tiles.getAllByText('0.5')).toHaveLength(2)
    expect(tiles.queryByText('1')).toBeNull()
    expect(document.querySelector('.sim-progress-text')?.textContent).toBe(
      'busted after 10 spins',
    )
  })
})
