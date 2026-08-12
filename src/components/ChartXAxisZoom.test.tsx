// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { ChartXAxisZoom } from './ChartXAxisZoom'
import { X_ZOOM_RANGE } from './chartUtils'

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
      <ChartXAxisZoom
        zoom={zoom}
        onZoom={(z) => {
          onZoomCall(z)
          setZoom(z)
        }}
        x={0}
        y={0}
        width={200}
        height={64}
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

describe('ChartXAxisZoom', () => {
  it('zooms in on wheel-up and out on wheel-down', () => {
    const { handle, onZoom } = renderZoom(1)
    fireEvent.wheel(handle, { deltaY: -100 })
    expect(last(onZoom)).toBeCloseTo(1 / 1.1, 5)
    fireEvent.wheel(handle, { deltaY: 100 })
    expect(last(onZoom)).toBeCloseTo(1, 5)
  })

  it('clamps wheel zoom at the range', () => {
    const { handle, onZoom } = renderZoom(X_ZOOM_RANGE.max)
    fireEvent.wheel(handle, { deltaY: 100 })
    expect(last(onZoom)).toBe(X_ZOOM_RANGE.max)
  })

  it('zooms in when dragged right and out when dragged left', () => {
    const { handle, onZoom } = renderZoom(0.5)
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 200 })
    expect(last(onZoom)).toBeLessThan(0.5)
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 0 })
    expect(last(onZoom)).toBeGreaterThan(0.5)
  })

  it('ignores pointer movement once the drag has ended', () => {
    const { handle, onZoom } = renderZoom(1)
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100 })
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 100 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 0 })
    expect(onZoom).not.toHaveBeenCalled()
  })

  it('resets to 1 on Home and on double-click', () => {
    const { handle, onZoom } = renderZoom(0.3)
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(last(onZoom)).toBe(1)
    fireEvent.doubleClick(handle)
    expect(last(onZoom)).toBe(1)
  })

  it('steps from the keyboard', () => {
    const { handle, onZoom } = renderZoom(0.5)
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(last(onZoom)).toBeCloseTo(0.5 / 1.1, 5)
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(last(onZoom)).toBeCloseTo(0.5, 5)
  })

  it('exposes the current zoom to assistive tech', () => {
    const { handle } = renderZoom(0.5)
    expect(handle.getAttribute('aria-valuenow')).toBe('0.5')
    expect(handle.getAttribute('aria-valuemin')).toBe(String(X_ZOOM_RANGE.min))
    expect(handle.getAttribute('aria-valuemax')).toBe(String(X_ZOOM_RANGE.max))
    expect(handle.getAttribute('aria-orientation')).toBe('horizontal')
    expect(handle.getAttribute('tabindex')).toBe('0')
  })
})
