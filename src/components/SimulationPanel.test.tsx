// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SimulationPanel } from './SimulationPanel'
import { DEFAULT_BANKROLL, type BucketRow, type SimMode } from '../lib/types'
import type { SimWorkerMessage } from '../lib/sim'
import type { BankrollMessage } from '../lib/bankroll'

const rows: BucketRow[] = [
  { uid: 'a', bucketId: 0, payout: 0, label: '0x', weight: 700_000, locked: false, groupId: 'other', weightId: '' },
  { uid: 'b', bucketId: 1, payout: 2, label: '1-2x', weight: 300_000, locked: false, groupId: 'other', weightId: '' },
]

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

afterEach(cleanup)

function renderPanel(mode: SimMode) {
  const onMode = vi.fn()
  render(
    <SimulationPanel
      mode={mode}
      onMode={onMode}
      rows={rows}
      totalWeight={1_000_000}
      expectedRtp={0.95}
      spins={1000}
      onSpins={vi.fn()}
      bankroll={DEFAULT_BANKROLL}
      onBankroll={vi.fn()}
      chartHeight={260}
      onChartHeight={vi.fn()}
      simYZoom={1}
      onSimYZoom={vi.fn()}
      bankrollYZoom={1}
      onBankrollYZoom={vi.fn()}
    />,
  )
  return onMode
}

describe('SimulationPanel', () => {
  it('shows the convergence controls in convergence mode', () => {
    renderPanel('convergence')
    expect(screen.getByLabelText('Spins')).toBeDefined()
    expect(screen.queryByLabelText('Starting credits')).toBeNull()
  })

  it('shows the bankroll controls in bankroll mode', () => {
    renderPanel('bankroll')
    expect(screen.getByLabelText('Starting credits')).toBeDefined()
    expect(screen.getByLabelText('Bet')).toBeDefined()
    expect(screen.queryByLabelText('Spins')).toBeNull()
  })

  it('marks the active mode for assistive tech', () => {
    renderPanel('bankroll')
    expect(screen.getByRole('button', { name: 'Bankroll' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Convergence' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('switches mode when the other button is pressed', () => {
    const onMode = renderPanel('convergence')
    fireEvent.click(screen.getByRole('button', { name: 'Bankroll' }))
    expect(onMode).toHaveBeenCalledWith('bankroll')
  })
})

describe('SimulationPanel y-zoom independence', () => {
  it("threads the convergence chart's own zoom, not the bankroll chart's", () => {
    const worker = {
      onmessage: null as ((e: MessageEvent<SimWorkerMessage>) => void) | null,
      postMessage: () => {},
      terminate: () => {},
    }
    render(
      <SimulationPanel
        mode="convergence"
        onMode={vi.fn()}
        rows={rows}
        totalWeight={1_000_000}
        expectedRtp={0.95}
        spins={1000}
        onSpins={vi.fn()}
        bankroll={DEFAULT_BANKROLL}
        onBankroll={vi.fn()}
        chartHeight={260}
        onChartHeight={vi.fn()}
        simYZoom={0.5}
        onSimYZoom={vi.fn()}
        bankrollYZoom={3}
        onBankrollYZoom={vi.fn()}
        createWorker={() => worker}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    act(() => {
      worker.onmessage?.({
        data: {
          type: 'done',
          agg: { spins: 1000, sum: 950, sumSq: 1805, hits: 250, wins: 250, maxWin: 2 },
        },
      } as MessageEvent<SimWorkerMessage>)
    })
    const slider = screen.getByRole('slider', { name: "Zoom the simulation chart's y-axis" })
    expect(slider.getAttribute('aria-valuenow')).toBe('0.5')
  })

  it("threads the bankroll chart's own zoom, not the convergence chart's", () => {
    const worker = {
      onmessage: null as ((e: MessageEvent<BankrollMessage>) => void) | null,
      postMessage: () => {},
      terminate: () => {},
    }
    render(
      <SimulationPanel
        mode="bankroll"
        onMode={vi.fn()}
        rows={rows}
        totalWeight={1_000_000}
        expectedRtp={0.95}
        spins={1000}
        onSpins={vi.fn()}
        bankroll={DEFAULT_BANKROLL}
        onBankroll={vi.fn()}
        chartHeight={260}
        onChartHeight={vi.fn()}
        simYZoom={0.5}
        onSimYZoom={vi.fn()}
        bankrollYZoom={3}
        onBankrollYZoom={vi.fn()}
        createBankrollWorker={() => worker}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    act(() => {
      worker.onmessage?.({
        data: {
          type: 'progress',
          points: [{ spins: 100, balance: 1000 }],
          state: {
            balance: 1000,
            spins: 100,
            peak: 1000,
            low: 1000,
            sum: 100,
            hits: 0,
            wins: 0,
            maxWin: 0,
            busted: false,
          },
        },
      } as MessageEvent<BankrollMessage>)
    })
    const slider = screen.getByRole('slider', { name: "Zoom the bankroll chart's y-axis" })
    expect(slider.getAttribute('aria-valuenow')).toBe('3')
  })
})
