// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChartResizeGrip } from './ChartResizeGrip'
import { DIST_HEIGHT } from './chartUtils'

afterEach(cleanup)

function renderGrip(height: number) {
  const onHeight = vi.fn()
  render(
    <ChartResizeGrip height={height} range={DIST_HEIGHT} label="Resize chart" onHeight={onHeight} />,
  )
  return { grip: screen.getByRole('separator', { name: 'Resize chart' }), onHeight }
}

const last = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls[fn.mock.calls.length - 1][0] as number

describe('ChartResizeGrip', () => {
  it('grows the chart when dragged down and shrinks it when dragged up', () => {
    const { grip, onHeight } = renderGrip(300)
    fireEvent.pointerDown(grip, { pointerId: 1, clientY: 100 })
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 160 })
    expect(last(onHeight)).toBe(360)
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 60 })
    expect(last(onHeight)).toBe(260)
    fireEvent.pointerUp(grip, { pointerId: 1, clientY: 60 })
  })

  it('ignores pointer movement once the drag has ended', () => {
    const { grip, onHeight } = renderGrip(300)
    fireEvent.pointerDown(grip, { pointerId: 1, clientY: 100 })
    fireEvent.pointerUp(grip, { pointerId: 1, clientY: 100 })
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 400 })
    expect(onHeight).not.toHaveBeenCalled()
  })

  it('clamps a drag to the range', () => {
    const { grip, onHeight } = renderGrip(300)
    fireEvent.pointerDown(grip, { pointerId: 1, clientY: 100 })
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: 5000 })
    expect(last(onHeight)).toBe(900)
    fireEvent.pointerMove(grip, { pointerId: 1, clientY: -5000 })
    expect(last(onHeight)).toBe(220)
  })

  it('resizes from the keyboard', () => {
    const { grip, onHeight } = renderGrip(300)
    fireEvent.keyDown(grip, { key: 'ArrowDown' })
    expect(last(onHeight)).toBe(316)
    fireEvent.keyDown(grip, { key: 'ArrowUp' })
    expect(last(onHeight)).toBe(284)
    fireEvent.keyDown(grip, { key: 'PageDown' })
    expect(last(onHeight)).toBe(364)
    fireEvent.keyDown(grip, { key: 'PageUp' })
    expect(last(onHeight)).toBe(236)
  })

  it('clamps keyboard resizing at the floor', () => {
    const { grip, onHeight } = renderGrip(224)
    fireEvent.keyDown(grip, { key: 'ArrowUp' })
    expect(last(onHeight)).toBe(220)
  })

  it('restores the default on Home and on double-click', () => {
    const { grip, onHeight } = renderGrip(500)
    fireEvent.keyDown(grip, { key: 'Home' })
    expect(last(onHeight)).toBe(340)
    fireEvent.doubleClick(grip)
    expect(last(onHeight)).toBe(340)
  })

  it('exposes the current height to assistive tech', () => {
    const { grip } = renderGrip(412)
    expect(grip.getAttribute('aria-valuenow')).toBe('412')
    expect(grip.getAttribute('aria-valuemin')).toBe('220')
    expect(grip.getAttribute('aria-valuemax')).toBe('900')
    expect(grip.getAttribute('tabindex')).toBe('0')
  })
})
