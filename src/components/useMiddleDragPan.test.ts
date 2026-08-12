// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useMiddleDragPan } from './useMiddleDragPan'

function fakePointerEvent(overrides: Partial<React.PointerEvent>): React.PointerEvent {
  return {
    button: 1,
    clientX: 0,
    clientY: 0,
    pointerId: 1,
    preventDefault: () => {},
    currentTarget: { setPointerCapture: () => {} },
    ...overrides,
  } as unknown as React.PointerEvent
}

describe('useMiddleDragPan', () => {
  it('ignores non-middle buttons', () => {
    const onXPan = vi.fn()
    const onYPan = vi.fn()
    const { result } = renderHook(() =>
      useMiddleDragPan({ xZoom: 1, xPan: 0, onXPan, yZoom: 1, yPan: 0, onYPan, plotW: 100, plotH: 100 }),
    )
    act(() => result.current.onPointerDown(fakePointerEvent({ button: 0 })))
    act(() => result.current.onPointerMove(fakePointerEvent({ clientX: 50 })))
    expect(onXPan).not.toHaveBeenCalled()
  })

  it('dragging right pans x backward (reveals earlier data)', () => {
    const onXPan = vi.fn()
    const onYPan = vi.fn()
    const { result } = renderHook(() =>
      useMiddleDragPan({ xZoom: 1, xPan: 0, onXPan, yZoom: 1, yPan: 0, onYPan, plotW: 100, plotH: 100 }),
    )
    act(() => result.current.onPointerDown(fakePointerEvent({ clientX: 0, clientY: 0 })))
    act(() => result.current.onPointerMove(fakePointerEvent({ clientX: 50, clientY: 0 })))
    expect(onXPan.mock.calls.at(-1)![0]).toBeLessThan(0)
  })

  it('dragging down pans y forward (reveals higher values)', () => {
    const onXPan = vi.fn()
    const onYPan = vi.fn()
    const { result } = renderHook(() =>
      useMiddleDragPan({ xZoom: 1, xPan: 0, onXPan, yZoom: 1, yPan: 0, onYPan, plotW: 100, plotH: 100 }),
    )
    act(() => result.current.onPointerDown(fakePointerEvent({ clientX: 0, clientY: 0 })))
    act(() => result.current.onPointerMove(fakePointerEvent({ clientX: 0, clientY: 50 })))
    expect(onYPan.mock.calls.at(-1)![0]).toBeGreaterThan(0)
  })

  it('stops updating after pointer up', () => {
    const onXPan = vi.fn()
    const onYPan = vi.fn()
    const { result } = renderHook(() =>
      useMiddleDragPan({ xZoom: 1, xPan: 0, onXPan, yZoom: 1, yPan: 0, onYPan, plotW: 100, plotH: 100 }),
    )
    act(() => result.current.onPointerDown(fakePointerEvent({ clientX: 0 })))
    act(() => result.current.onPointerUp(fakePointerEvent({ clientX: 0 })))
    act(() => result.current.onPointerMove(fakePointerEvent({ clientX: 50 })))
    expect(onXPan).not.toHaveBeenCalled()
  })
})
