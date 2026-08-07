// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ChartReadout } from './ChartReadout'

afterEach(cleanup)

describe('ChartReadout', () => {
  it('shows the hint and no stats when nothing is hovered', () => {
    render(
      <ChartReadout titles={[]} stats={[{ label: 'weight', value: '5' }]} hint="hover a bar" />,
    )
    expect(screen.getByText('hover a bar')).toBeDefined()
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
        hint="hover"
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
        hint="hover"
      />,
    )
    expect(screen.getByText('weight')).toBeDefined()
    expect(screen.getByText('420')).toBeDefined()
    expect(screen.getByText('chance')).toBeDefined()
    expect(screen.getByText('0.42%')).toBeDefined()
  })

  it('trims a long title list to three lines plus a count', () => {
    const titles = ['a', 'b', 'c', 'd', 'e'].map((text) => ({ text }))
    render(<ChartReadout titles={titles} stats={[]} hint="hover" />)
    expect([...document.querySelectorAll('.readout-title')].map((el) => el.textContent)).toEqual([
      'a',
      'b',
      'c',
    ])
    expect(screen.getByText('+2 more')).toBeDefined()
  })

  it('keeps four titles without trimming', () => {
    const titles = ['a', 'b', 'c', 'd'].map((text) => ({ text }))
    render(<ChartReadout titles={titles} stats={[]} hint="hover" />)
    expect(document.querySelectorAll('.readout-title').length).toBe(4)
    expect(screen.queryByText(/ more$/)).toBeNull()
  })

  it('stays mounted whether or not anything is hovered', () => {
    const { rerender } = render(<ChartReadout titles={[]} stats={[]} hint="hover" />)
    expect(document.querySelector('.chart-readout')).not.toBeNull()
    rerender(<ChartReadout titles={[{ text: 'a' }]} stats={[]} hint="hover" />)
    expect(document.querySelectorAll('.chart-readout').length).toBe(1)
  })
})
