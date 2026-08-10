// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { BankrollChart } from './BankrollChart'
import { initialBankrollState, type BankrollPoint, type BankrollState } from '../lib/bankroll'

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

afterEach(cleanup)

const points: BankrollPoint[] = [
  { spins: 100, balance: 1000 },
  { spins: 200, balance: 1200 },
  { spins: 300, balance: 600 },
]

const state = (over: Partial<BankrollState> = {}): BankrollState => ({
  ...initialBankrollState(1000),
  spins: 300,
  balance: 600,
  peak: 1200,
  low: 600,
  sum: 285,
  ...over,
})

function renderChart(over: { points?: BankrollPoint[]; state?: BankrollState } = {}) {
  render(
    <BankrollChart
      points={over.points ?? points}
      startCredits={1000}
      state={over.state ?? state()}
      height={260}
      onHeight={vi.fn()}
    />,
  )
}

describe('BankrollChart', () => {
  it('draws the balance line', () => {
    renderChart()
    expect(screen.getByRole('img', { name: 'Bankroll results' })).toBeDefined()
    const path = document.querySelector('.bankroll-path') as SVGPathElement
    expect(path).not.toBeNull()
    expect(path.getAttribute('d')?.startsWith('M')).toBe(true)
  })

  it('keeps zero on the axis, because busting is the point', () => {
    renderChart()
    const labels = [...document.querySelectorAll('.axis-label')].map((n) => n.textContent)
    expect(labels).toContain('0')
  })

  it('marks the starting credits so up and down read at a glance', () => {
    renderChart()
    // peak 1200 → yMax = niceCeil(1260) = 2000; plotH = 260 - 14 - 40 = 206
    // y(1000) = 14 + 206 * (1 - 1000/2000) = 117
    const line = document.querySelector('.bankroll-start-line') as SVGLineElement
    expect(line).not.toBeNull()
    expect(Number(line.getAttribute('y1'))).toBeCloseTo(117, 1)
  })

  it('shows a bust marker only once the run has busted', () => {
    renderChart()
    expect(document.querySelector('.bankroll-bust')).toBeNull()

    cleanup()
    renderChart({ state: state({ busted: true, balance: 0 }) })
    expect(document.querySelector('.bankroll-bust')).not.toBeNull()
  })

  it('reports the hovered point, and its change against the start', () => {
    renderChart()
    fireEvent.mouseMove(document.querySelector('.sim-hit') as Element, { clientX: 0 })
    expect(screen.getByText('balance')).toBeDefined()
    // leftmost point is spins 100, balance 1000 — level with the start
    expect(screen.getByText('100 spins')).toBeDefined()
  })

  it('renders nothing to hover when the run produced no points', () => {
    renderChart({ points: [], state: state({ spins: 0, balance: 1000 }) })
    expect(document.querySelector('.bankroll-path')).toBeNull()
    expect(screen.getByRole('img', { name: 'Bankroll results' })).toBeDefined()
  })
})
