// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PanelDock } from './PanelDock'
import { DEFAULT_LAYOUT, type DockLayout, type DockNode } from '../lib/layout'

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

/** Leaf ids in document order, as a compact array — root children flattened. */
const leafOrder = () => [...document.querySelectorAll('.dock-leaf')].map((el) => el.getAttribute('data-panel-id'))

describe('PanelDock', () => {
  afterEach(cleanup)

  it('renders the tree — one row split for buckets+chart, one divider between them', () => {
    render(<PanelDock layout={DEFAULT_LAYOUT} onLayout={() => {}} panels={defs} />)
    expect(document.querySelectorAll('.dock-row')).toHaveLength(1)
    expect(document.querySelectorAll('.dock-divider')).toHaveLength(1)
    expect(screen.getByText('BK')).toBeTruthy()
    expect(screen.getByText('GD')).toBeTruthy()
    expect(screen.getByText('CH')).toBeTruthy()
    expect(leafOrder()).toEqual(['groupDist', 'buckets', 'chart'])
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
    const rowEl = document.querySelector('.dock-row') as HTMLElement
    vi.spyOn(rowEl, 'getBoundingClientRect').mockReturnValue(
      rect({ left: 0, right: 1000, top: 110, bottom: 500 }),
    )
    fireEvent.pointerDown(divider, { clientX: 500, button: 0, pointerId: 1 })
    fireEvent.pointerMove(divider, { clientX: 600, pointerId: 1 })
    fireEvent.pointerUp(divider, { pointerId: 1 })
    const arg = onLayout.mock.calls.at(-1)![0] as DockLayout
    const row = (arg.root as { children: DockNode[] }).children[1] as { children: DockNode[] }
    expect(row.children[0].size).toBeCloseTo(0.6, 6)
    expect(row.children[1].size).toBeCloseTo(0.4, 6)
  })

  it('header drag commits a movePanel via onLayout', () => {
    const onLayout = vi.fn()
    render(<PanelDock layout={DEFAULT_LAYOUT} onLayout={onLayout} panels={defs} />)
    const leafEls = document.querySelectorAll('.dock-leaf')
    const leafRects: Record<string, { left: number; right: number; top: number; bottom: number }> = {
      groupDist: { left: 0, right: 1000, top: 0, bottom: 100 },
      buckets: { left: 0, right: 500, top: 110, bottom: 500 },
      chart: { left: 500, right: 1000, top: 110, bottom: 500 },
    }
    leafEls.forEach((el) => {
      const id = el.getAttribute('data-panel-id')!
      vi.spyOn(el as HTMLElement, 'getBoundingClientRect').mockReturnValue(rect(leafRects[id]))
    })

    // groupDist's head, dragged into the right half of the chart panel — a
    // "beside chart, after" drop, landing at the end of the buckets+chart row.
    const head = document.querySelectorAll('.dock-leaf .panel-head')[0]
    fireEvent.pointerDown(head, { clientX: 50, clientY: 50, button: 0, pointerId: 2 })
    fireEvent.pointerMove(head, { clientX: 900, clientY: 300, pointerId: 2 })
    fireEvent.pointerUp(head, { pointerId: 2 })
    const arg = onLayout.mock.calls.at(-1)![0] as DockLayout
    const row = arg.root as { children: DockNode[] }
    expect(row.children.map((c) => (c.type === 'leaf' ? c.id : null))).toEqual(['buckets', 'chart', 'groupDist'])
  })

  it('a sub-threshold press never starts a drag', () => {
    const onLayout = vi.fn()
    render(<PanelDock layout={DEFAULT_LAYOUT} onLayout={onLayout} panels={defs} />)
    const head = document.querySelectorAll('.dock-leaf .panel-head')[0]
    fireEvent.pointerDown(head, { clientX: 50, clientY: 50, button: 0, pointerId: 3 })
    fireEvent.pointerMove(head, { clientX: 52, clientY: 51, pointerId: 3 })
    fireEvent.pointerUp(head, { pointerId: 3 })
    expect(onLayout).not.toHaveBeenCalled()
  })

  it('dragging above a leaf stacks the two into a nested split, on either side', () => {
    const onLayout = vi.fn()
    render(<PanelDock layout={DEFAULT_LAYOUT} onLayout={onLayout} panels={defs} />)
    const leafEls = document.querySelectorAll('.dock-leaf')
    const leafRects: Record<string, { left: number; right: number; top: number; bottom: number }> = {
      groupDist: { left: 0, right: 1000, top: 0, bottom: 100 },
      buckets: { left: 0, right: 500, top: 110, bottom: 500 },
      chart: { left: 500, right: 1000, top: 110, bottom: 500 },
    }
    leafEls.forEach((el) => {
      const id = el.getAttribute('data-panel-id')!
      vi.spyOn(el as HTMLElement, 'getBoundingClientRect').mockReturnValue(rect(leafRects[id]))
    })
    // groupDist dropped in buckets' top edge (col axis, before) — stacks groupDist above buckets.
    const head = document.querySelectorAll('.dock-leaf .panel-head')[0]
    fireEvent.pointerDown(head, { clientX: 50, clientY: 50, button: 0, pointerId: 4 })
    fireEvent.pointerMove(head, { clientX: 250, clientY: 115, pointerId: 4 })
    fireEvent.pointerUp(head, { pointerId: 4 })
    const arg = onLayout.mock.calls.at(-1)![0] as DockLayout
    const row = arg.root as { children: DockNode[] }
    const first = row.children[0] as { type: 'split'; dir: string; children: DockNode[] }
    expect(first.dir).toBe('col')
    expect(first.children.map((c) => (c.type === 'leaf' ? c.id : null))).toEqual(['groupDist', 'buckets'])
  })
})
