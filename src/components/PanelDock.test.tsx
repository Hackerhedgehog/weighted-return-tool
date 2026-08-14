// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PanelDock } from './PanelDock'
import { DEFAULT_LAYOUT, type DockLayout } from '../lib/layout'

const defs = {
  groupDist: { title: 'Group Distribution', hint: 'h', children: <div>GD</div> },
  buckets: { title: 'Buckets', hint: 'h', children: <div>BK</div> },
  chart: { title: 'Distribution', hint: 'h', children: <div>CH</div> },
}

const rect = (r: { left: number; right: number; top: number; bottom: number }): DOMRect =>
  ({
    ...r,
    width: r.right - r.left,
    height: r.bottom - r.top,
    x: r.left,
    y: r.top,
    toJSON: () => ({}),
  }) as DOMRect

describe('PanelDock', () => {
  afterEach(cleanup)

  it('renders rows and panels per layout, with one divider between siblings', () => {
    render(<PanelDock layout={DEFAULT_LAYOUT} onLayout={() => {}} panels={defs} />)
    expect(document.querySelectorAll('.dock-row')).toHaveLength(2)
    expect(document.querySelectorAll('.dock-divider')).toHaveLength(1)
    expect(screen.getByText('BK')).toBeTruthy()
    expect(screen.getByText('GD')).toBeTruthy()
    expect(screen.getByText('CH')).toBeTruthy()
  })

  it('collapses a panel through its head toggle', () => {
    const onCollapsed = vi.fn()
    render(
      <PanelDock
        layout={DEFAULT_LAYOUT}
        onLayout={() => {}}
        panels={{ ...defs, groupDist: { ...defs.groupDist, collapsed: false, onCollapsed } }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Hide Group Distribution' }))
    expect(onCollapsed).toHaveBeenCalledWith(true)
  })

  it('divider drag calls onLayout with resized fractions', () => {
    const onLayout = vi.fn()
    render(<PanelDock layout={DEFAULT_LAYOUT} onLayout={onLayout} panels={defs} />)
    const divider = document.querySelector('.dock-divider')!
    const rowEl = document.querySelectorAll('.dock-row')[1] as HTMLElement
    vi.spyOn(rowEl, 'getBoundingClientRect').mockReturnValue(
      rect({ left: 0, right: 1000, top: 110, bottom: 500 }),
    )
    fireEvent.pointerDown(divider, { clientX: 500, button: 0, pointerId: 1 })
    fireEvent.pointerMove(divider, { clientX: 600, pointerId: 1 })
    fireEvent.pointerUp(divider, { pointerId: 1 })
    const arg = onLayout.mock.calls.at(-1)![0] as DockLayout
    expect(arg.rows[1].panels[0].size).toBeCloseTo(0.6, 6)
    expect(arg.rows[1].panels[1].size).toBeCloseTo(0.4, 6)
  })

  it('header drag commits a movePanel via onLayout', () => {
    const onLayout = vi.fn()
    render(<PanelDock layout={DEFAULT_LAYOUT} onLayout={onLayout} panels={defs} />)
    const rowEls = document.querySelectorAll('.dock-row')
    const rowRects = [
      { left: 0, right: 1000, top: 0, bottom: 100 },
      { left: 0, right: 1000, top: 110, bottom: 500 },
    ]
    rowEls.forEach((el, i) =>
      vi.spyOn(el as HTMLElement, 'getBoundingClientRect').mockReturnValue(rect(rowRects[i])),
    )
    const panelEls = document.querySelectorAll('.dock-panel')
    const prects = [
      { left: 0, right: 1000, top: 0, bottom: 100 }, // groupDist
      { left: 0, right: 500, top: 110, bottom: 500 }, // buckets
      { left: 500, right: 1000, top: 110, bottom: 500 }, // chart
    ]
    panelEls.forEach((el, i) =>
      vi.spyOn(el as HTMLElement, 'getBoundingClientRect').mockReturnValue(rect(prects[i])),
    )

    // groupDist's head, dragged into the right half of the chart panel — a
    // "beside chart, index 2" drop in the second row's vertical middle.
    const head = document.querySelectorAll('.dock-panel .panel-head')[0]
    fireEvent.pointerDown(head, { clientX: 50, clientY: 50, button: 0, pointerId: 2 })
    fireEvent.pointerMove(head, { clientX: 900, clientY: 300, pointerId: 2 })
    fireEvent.pointerUp(head, { pointerId: 2 })
    const arg = onLayout.mock.calls.at(-1)![0] as DockLayout
    expect(arg.rows.map((r) => r.panels.map((p) => p.id))).toEqual([
      ['buckets', 'chart', 'groupDist'],
    ])
  })

  it('a sub-threshold press never starts a drag', () => {
    const onLayout = vi.fn()
    render(<PanelDock layout={DEFAULT_LAYOUT} onLayout={onLayout} panels={defs} />)
    const head = document.querySelectorAll('.dock-panel .panel-head')[0]
    fireEvent.pointerDown(head, { clientX: 50, clientY: 50, button: 0, pointerId: 3 })
    fireEvent.pointerMove(head, { clientX: 52, clientY: 51, pointerId: 3 })
    fireEvent.pointerUp(head, { pointerId: 3 })
    expect(onLayout).not.toHaveBeenCalled()
  })
})
