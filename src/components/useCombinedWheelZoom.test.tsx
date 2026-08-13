// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { useCombinedWheelZoom } from './useCombinedWheelZoom'
import { X_ZOOM_RANGE, Y_ZOOM_RANGE } from './chartUtils'

afterEach(cleanup)

function Wrapper({ onX, onY }: { onX: (z: number) => void; onY: (z: number) => void }) {
  const [xZoom, setXZoom] = useState(1)
  const [yZoom, setYZoom] = useState(1)
  const ref = useCombinedWheelZoom<SVGRectElement>({
    xZoom,
    onXZoom: (z) => {
      onX(z)
      setXZoom(z)
    },
    yZoom,
    onYZoom: (z) => {
      onY(z)
      setYZoom(z)
    },
  })
  return (
    <svg>
      <rect ref={ref} data-testid="plot" x={0} y={0} width={100} height={100} />
    </svg>
  )
}

function renderWrapper() {
  const onX = vi.fn()
  const onY = vi.fn()
  const { getByTestId } = render(<Wrapper onX={onX} onY={onY} />)
  return { plot: getByTestId('plot'), onX, onY }
}

const last = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls[fn.mock.calls.length - 1][0] as number

describe('useCombinedWheelZoom', () => {
  it('zooms both axes together on wheel-up and wheel-down', () => {
    const { plot, onX, onY } = renderWrapper()
    fireEvent.wheel(plot, { deltaY: -100 })
    expect(last(onX)).toBeCloseTo(1 / 1.1, 5)
    expect(last(onY)).toBeCloseTo(1 / 1.1, 5)
    fireEvent.wheel(plot, { deltaY: 100 })
    expect(last(onX)).toBeCloseTo(1, 5)
    expect(last(onY)).toBeCloseTo(1, 5)
  })

  it('clamps each axis at its own range', () => {
    const { plot, onX, onY } = renderWrapper()
    for (let i = 0; i < 50; i++) fireEvent.wheel(plot, { deltaY: 100 })
    expect(last(onX)).toBe(X_ZOOM_RANGE.max)
    expect(last(onY)).toBe(Y_ZOOM_RANGE.max)
  })
})
