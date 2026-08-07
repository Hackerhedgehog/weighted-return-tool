// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ChartReadout } from './ChartReadout'

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

afterEach(cleanup)

const bubble = () => document.querySelector('.chart-readout') as HTMLElement | null
const leftOf = () => parseFloat(bubble()!.style.left)

/** jsdom has no layout, so offsetWidth is 0 unless we define it. */
function withMeasuredBubble(px: number) {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() {
      return this.classList.contains('chart-readout') ? px : 0
    },
  })
}

afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, 'offsetWidth')
})

describe('ChartReadout', () => {
  it('draws nothing when there is no hover, but keeps the band', () => {
    render(<ChartReadout titles={[]} stats={[{ label: 'weight', value: '5' }]} anchor={null} width={900} />)
    expect(document.querySelector('.chart-readout-band')).not.toBeNull()
    expect(bubble()).toBeNull()
    expect(screen.queryByText('weight')).toBeNull()
  })

  it('renders one line per title, each in its own color', () => {
    render(
      <ChartReadout
        titles={[
          { text: 'joker5-maxwin', color: 'var(--series-2)' },
          { text: 'bonus4', color: 'var(--series-1)' },
        ]}
        stats={[]}
        anchor={400}
        width={900}
      />,
    )
    const lines = [...document.querySelectorAll('.readout-title')]
    expect(lines.map((el) => el.textContent)).toEqual(['joker5-maxwin', 'bonus4'])
    expect(lines[0].getAttribute('style')).toContain('--series-2')
    expect(lines[1].getAttribute('style')).toContain('--series-1')
  })

  it('renders every stat as a label/value pair', () => {
    render(
      <ChartReadout
        titles={[{ text: 'a' }]}
        stats={[
          { label: 'weight', value: '420' },
          { label: 'chance', value: '0.42%' },
        ]}
        anchor={400}
        width={900}
      />,
    )
    expect(screen.getByText('weight')).toBeDefined()
    expect(screen.getByText('420')).toBeDefined()
    expect(screen.getByText('0.42%')).toBeDefined()
  })

  it('lists every label, however many there are, and never truncates', () => {
    const titles = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((text) => ({ text }))
    render(<ChartReadout titles={titles} stats={[]} anchor={400} width={900} />)
    expect([...document.querySelectorAll('.readout-title')].map((el) => el.textContent)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
    ])
    expect(screen.queryByText(/ more$/)).toBeNull()
  })

  it('leaves a list that fits unanimated', () => {
    const titles = ['a', 'b'].map((text) => ({ text }))
    render(<ChartReadout titles={titles} stats={[]} anchor={400} width={900} />)
    expect(document.querySelector('.readout-list')!.className).not.toContain('scrolling')
  })

  it('auto-scrolls a list that overflows, pacing the cycle by the distance', () => {
    // jsdom has no layout: fake a list taller than its 80px clip.
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return this.classList.contains('readout-list') ? 200 : 0
      },
    })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() {
        return this.classList.contains('readout-titles') ? 80 : 0
      },
    })

    const titles = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((text) => ({ text }))
    render(<ChartReadout titles={titles} stats={[]} anchor={400} width={900} />)

    const list = document.querySelector('.readout-list') as HTMLElement
    expect(list.className).toContain('scrolling')
    expect(list.style.getPropertyValue('--scroll-dist')).toBe('120px')
    // 120px at 22px/s over a 76% duty cycle
    expect(parseFloat(list.style.getPropertyValue('--scroll-cycle'))).toBeCloseTo(7.18, 1)

    Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight')
    Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight')
  })

  it('puts the stats in a single column, so the bubble reads as two', () => {
    render(
      <ChartReadout
        titles={[{ text: 'a' }]}
        stats={[
          { label: 'payout', value: '×100' },
          { label: 'weight', value: '5' },
        ]}
        anchor={400}
        width={900}
      />,
    )
    const cols = document.querySelector('.chart-readout')!.children
    expect(cols).toHaveLength(2)
    expect(cols[0].className).toBe('readout-titles')
    expect(cols[1].className).toBe('readout-stats')
  })

  it('centres the bubble on the anchor when there is room', () => {
    withMeasuredBubble(200)
    render(<ChartReadout titles={[{ text: 'a' }]} stats={[]} anchor={450} width={900} />)
    expect(leftOf()).toBe(450)
  })

  it('never lets the bubble overhang the left edge', () => {
    withMeasuredBubble(200)
    render(<ChartReadout titles={[{ text: 'a' }]} stats={[]} anchor={10} width={900} />)
    // left is the centre; the bubble's own left edge is left - 100
    expect(leftOf() - 100).toBeGreaterThanOrEqual(0)
    expect(leftOf()).toBe(106)
  })

  it('never lets the bubble overhang the right edge', () => {
    withMeasuredBubble(200)
    render(<ChartReadout titles={[{ text: 'a' }]} stats={[]} anchor={890} width={900} />)
    expect(leftOf() + 100).toBeLessThanOrEqual(900)
    expect(leftOf()).toBe(794)
  })

  it('pins a bubble wider than its container rather than inverting the clamp', () => {
    withMeasuredBubble(400)
    render(<ChartReadout titles={[{ text: 'a' }]} stats={[]} anchor={100} width={200} />)
    expect(leftOf()).toBe(206)
  })
})
