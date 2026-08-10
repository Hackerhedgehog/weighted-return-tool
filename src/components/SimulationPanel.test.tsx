// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SimulationPanel } from './SimulationPanel'
import { DEFAULT_BANKROLL, type BucketRow, type SimMode } from '../lib/types'

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
