// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChartScrollbar } from './ChartScrollbar'

afterEach(cleanup)

function renderBar(orientation: 'x' | 'y', size: number, start: number) {
  const onScroll = vi.fn()
  render(
    <svg>
      <ChartScrollbar
        orientation={orientation}
        x={0}
        y={0}
        width={orientation === 'x' ? 200 : 6}
        height={orientation === 'x' ? 6 : 200}
        size={size}
        start={start}
        onScroll={onScroll}
        label="Scroll"
      />
    </svg>,
  )
  return { thumb: screen.getByRole('scrollbar', { name: 'Scroll' }), onScroll }
}

const last = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls[fn.mock.calls.length - 1][0] as number

describe('ChartScrollbar', () => {
  it('exposes size/start to assistive tech', () => {
    const { thumb } = renderBar('x', 0.4, 0.1)
    expect(thumb.getAttribute('aria-valuenow')).toBe('0.1')
    expect(thumb.getAttribute('aria-orientation')).toBe('horizontal')
  })

  it('dragging the x thumb right increases start, clamped to 1 - size', () => {
    const { thumb, onScroll } = renderBar('x', 0.4, 0.1)
    fireEvent.pointerDown(thumb, { pointerId: 1, clientX: 0 })
    fireEvent.pointerMove(thumb, { pointerId: 1, clientX: 400 }) // half the 200px-wide, size-0.4 track
    expect(last(onScroll)).toBeCloseTo(0.6, 1) // clamped at 1 - 0.4
  })

  it('dragging the y thumb down decreases start, clamped to 0', () => {
    const { thumb, onScroll } = renderBar('y', 0.5, 0.5)
    fireEvent.pointerDown(thumb, { pointerId: 1, clientY: 0 })
    fireEvent.pointerMove(thumb, { pointerId: 1, clientY: 1000 })
    expect(last(onScroll)).toBeCloseTo(0, 1) // clamped at 0
  })

  it('ignores movement once the drag has ended', () => {
    const { thumb, onScroll } = renderBar('x', 0.4, 0.1)
    fireEvent.pointerDown(thumb, { pointerId: 1, clientX: 0 })
    fireEvent.pointerUp(thumb, { pointerId: 1, clientX: 0 })
    fireEvent.pointerMove(thumb, { pointerId: 1, clientX: 400 })
    expect(onScroll).not.toHaveBeenCalled()
  })

  it('positions the y thumb near the top of the track when viewing high values (not inverted)', () => {
    // size=0.2, start=0.8 means viewing near the TOP of the data range.
    render(
      <svg>
        <ChartScrollbar orientation="y" x={0} y={0} width={6} height={200} size={0.2} start={0.8} onScroll={vi.fn()} label="Scroll" />
      </svg>,
    )
    const thumb = screen.getByRole('scrollbar', { name: 'Scroll' })
    expect(Number(thumb.getAttribute('y'))).toBeCloseTo(0, 1)
  })

  it('dragging the y thumb down decreases start (reveals lower values, not inverted)', () => {
    const onScroll = vi.fn()
    render(
      <svg>
        <ChartScrollbar orientation="y" x={0} y={0} width={6} height={200} size={0.2} start={0.5} onScroll={onScroll} label="Scroll" />
      </svg>,
    )
    const thumb = screen.getByRole('scrollbar', { name: 'Scroll' })
    fireEvent.pointerDown(thumb, { pointerId: 1, clientY: 0 })
    fireEvent.pointerMove(thumb, { pointerId: 1, clientY: 40 })
    const last = onScroll.mock.calls.at(-1)![0] as number
    expect(last).toBeLessThan(0.5)
  })
})
