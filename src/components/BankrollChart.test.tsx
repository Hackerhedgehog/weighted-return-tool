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

function renderChart(
  over: {
    points?: BankrollPoint[]
    state?: BankrollState
    startCredits?: number
    yZoom?: number
    onYZoom?: (z: number) => void
    yPan?: number
    onYPan?: (p: number) => void
    xZoom?: number
    onXZoom?: (z: number) => void
    xPan?: number
    onXPan?: (p: number) => void
  } = {},
) {
  render(
    <BankrollChart
      points={over.points ?? points}
      startCredits={over.startCredits ?? 1000}
      state={over.state ?? state()}
      height={260}
      onHeight={vi.fn()}
      yZoom={over.yZoom ?? 1}
      onYZoom={over.onYZoom ?? vi.fn()}
      yPan={over.yPan ?? 0}
      onYPan={over.onYPan ?? vi.fn()}
      xZoom={over.xZoom ?? 1}
      onXZoom={over.onXZoom ?? vi.fn()}
      xPan={over.xPan ?? 0}
      onXPan={over.onXPan ?? vi.fn()}
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
    // peak 1200 → yMax = niceCeil(1260) = 2000; plotH = 260 - 14 - 52 = 194
    // y(1000) = 14 + 194 * (1 - 1000/2000) = 111
    const line = document.querySelector('.bankroll-start-line') as SVGLineElement
    expect(line).not.toBeNull()
    expect(Number(line.getAttribute('y1'))).toBeCloseTo(111, 1)
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

  it('shows a fractional busted balance as a fraction, not rounded up to a whole credit', () => {
    // Bets can be fractional, so a run can bust holding, say, half a credit —
    // fmtWeight would round that to "1", reading as a lie next to "no credit
    // left to bet".
    renderChart({
      points: [{ spins: 100, balance: 0.5 }],
      state: state({ spins: 100, balance: 0.5, busted: true }),
    })
    expect(screen.queryByText('1')).toBeNull()
    fireEvent.mouseMove(document.querySelector('.sim-hit') as Element, { clientX: 0 })
    expect(screen.getByText('0.5')).toBeDefined()
  })

  it('shows a fractional starting balance in the legend, not rounded up', () => {
    renderChart({ startCredits: 0.75, points: [{ spins: 0, balance: 0.75 }] })
    expect(screen.getByText(/started with 0\.75/)).toBeDefined()
  })

  it('legend swatches are its own classes, not the convergence chart\'s mismatched ones', () => {
    renderChart()
    // .cumulative/.expected bind to --series-0/--text-dim for SimChart's own
    // lines; .bankroll-path and .bankroll-start-line stroke --accent and
    // --line-strong instead, so this chart needs swatches bound to those.
    expect(document.querySelector('.legend-line.cumulative')).toBeNull()
    expect(document.querySelector('.legend-line.expected')).toBeNull()
    expect(document.querySelector('.legend-line.bankroll-balance')).not.toBeNull()
    expect(document.querySelector('.legend-line.bankroll-start')).not.toBeNull()
  })

  it('renders a y-axis zoom handle', () => {
    renderChart()
    expect(screen.getByRole('slider', { name: "Zoom the bankroll chart's y-axis" })).toBeDefined()
  })

  it('scales the tick labels when zoomed', () => {
    // peak 1200 → autoYMax = niceCeil(1260) = 2000, so the top tick reads "2k".
    renderChart()
    expect([...document.querySelectorAll('.axis-label')].map((n) => n.textContent)).toContain('2k')

    cleanup()
    // zoomed to 0.5 → effective yMax 1000, so the same top tick now reads "1k".
    renderChart({ yZoom: 0.5 })
    expect([...document.querySelectorAll('.axis-label')].map((n) => n.textContent)).toContain('1k')
  })
})

describe('BankrollChart pan and x-zoom', () => {
  it('renders an x-axis zoom handle', () => {
    renderChart()
    expect(screen.getByRole('slider', { name: "Zoom the bankroll chart's x-axis" })).toBeDefined()
  })

  it('keeps 0 visible however far the y-axis is panned', () => {
    // Zoomed tight (yZoom 0.2), then middle-drag far down — per
    // useMiddleDragPan's convention, dragging down raises the visible
    // range, which is exactly the direction that would hide 0 above the
    // view if BankrollChart's zero-visible clamp weren't wired in.
    renderChart({ yZoom: 0.2 })
    const hit = document.querySelector('.sim-hit')!
    fireEvent.pointerDown(hit, { pointerId: 1, button: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(hit, { pointerId: 1, clientX: 0, clientY: 10_000 })
    const labels = [...document.querySelectorAll('.axis-label')].map((n) => n.textContent)
    expect(labels).toContain('0')
  })

  it('renders a reset view button', () => {
    renderChart()
    expect(screen.getByRole('button', { name: /reset/i })).toBeDefined()
  })
})
