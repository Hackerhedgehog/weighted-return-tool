// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { ChartYAxisZoom } from './ChartYAxisZoom'
import { Y_ZOOM_RANGE } from './chartUtils'

afterEach(cleanup)

function ZoomTestWrapper({
  initialZoom,
  onZoomCall,
}: {
  initialZoom: number
  onZoomCall: (z: number) => void
}) {
  const [zoom, setZoom] = useState(initialZoom)
  return (
    <svg>
      <ChartYAxisZoom
        zoom={zoom}
        onZoom={(z) => {
          onZoomCall(z)
          setZoom(z)
        }}
        x={0}
        y={0}
        width={64}
        height={200}
        label="Zoom"
      />
    </svg>
  )
}

function renderZoom(zoom: number) {
  const onZoom = vi.fn()
  render(<ZoomTestWrapper initialZoom={zoom} onZoomCall={onZoom} />)
  return { handle: screen.getByRole('slider', { name: 'Zoom' }), onZoom }
}

const last = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls[fn.mock.calls.length - 1][0] as number

describe('ChartYAxisZoom', () => {
  it('zooms in on wheel-up and out on wheel-down', () => {
    const { handle, onZoom } = renderZoom(1)
    fireEvent.wheel(handle, { deltaY: -100 })
    expect(last(onZoom)).toBeCloseTo(1 / 1.1, 5)
    fireEvent.wheel(handle, { deltaY: 100 })
    expect(last(onZoom)).toBeCloseTo(1, 5)
  })

  it('clamps wheel zoom at the range', () => {
    const { handle, onZoom } = renderZoom(Y_ZOOM_RANGE.min)
    fireEvent.wheel(handle, { deltaY: -100 })
    expect(last(onZoom)).toBe(Y_ZOOM_RANGE.min)
  })

  it('zooms in when dragged up and out when dragged down', () => {
    const { handle, onZoom } = renderZoom(1)
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 100 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 0 })
    expect(last(onZoom)).toBeLessThan(1)
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 200 })
    expect(last(onZoom)).toBeGreaterThan(1)
  })

  it('ignores pointer movement once the drag has ended', () => {
    const { handle, onZoom } = renderZoom(1)
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 100 })
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 100 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 0 })
    expect(onZoom).not.toHaveBeenCalled()
  })

  it('resets to 1 on Home and on double-click', () => {
    const { handle, onZoom } = renderZoom(3)
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(last(onZoom)).toBe(1)
    fireEvent.doubleClick(handle)
    expect(last(onZoom)).toBe(1)
  })

  it('steps from the keyboard', () => {
    const { handle, onZoom } = renderZoom(1)
    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    expect(last(onZoom)).toBeCloseTo(1 / 1.1, 5)
    fireEvent.keyDown(handle, { key: 'ArrowDown' })
    expect(last(onZoom)).toBeCloseTo(1, 5)
  })

  it('exposes the current zoom to assistive tech', () => {
    const { handle } = renderZoom(2)
    expect(handle.getAttribute('aria-valuenow')).toBe('2')
    expect(handle.getAttribute('aria-valuemin')).toBe(String(Y_ZOOM_RANGE.min))
    expect(handle.getAttribute('aria-valuemax')).toBe(String(Y_ZOOM_RANGE.max))
    expect(handle.getAttribute('tabindex')).toBe('0')
  })
})
