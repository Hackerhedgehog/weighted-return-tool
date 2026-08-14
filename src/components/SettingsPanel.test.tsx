// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsPanel } from './SettingsPanel'
import { DEFAULT_TARGETS, normalizePriority, type GroupDef, type Targets } from '../lib/types'
import type { LockState } from '../lib/groups'
import type { GroupStats } from './GroupSettings'

const groups: GroupDef[] = [{ id: 'g1', name: 'alpha', color: '#aabbcc' }]

const renderPanel = (onTargets = vi.fn(), targets: Targets = DEFAULT_TARGETS) => {
  render(
    <SettingsPanel
      open
      targets={targets}
      weightStep={1}
      groups={groups}
      groupCounts={new Map([['g1', 3]])}
      groupLockStates={new Map<string, LockState>([['g1', 'none']])}
      groupStats={new Map<string, GroupStats>()}
      onTargets={onTargets}
      onWeightStep={vi.fn()}
      onGroupAdd={vi.fn()}
      onGroupRename={vi.fn()}
      onGroupRecolor={vi.fn()}
      onGroupDelete={vi.fn()}
      onGroupLock={vi.fn()}
      onGroupSoftLock={vi.fn()}
      onGroupChance={vi.fn()}
      onGroupValue={vi.fn()}
      onGroupAutoDetect={vi.fn()}
      onGroupAutoDetectAll={vi.fn()}
      onClose={vi.fn()}
    />,
  )
  return onTargets
}

describe('SettingsPanel priority reorder', () => {
  afterEach(cleanup)

  it('has no arrow buttons', () => {
    renderPanel()
    expect(screen.queryByLabelText(/^Raise /)).toBeNull()
    expect(screen.queryByLabelText(/^Lower /)).toBeNull()
  })

  it('reorders priority by dragging a row grip', () => {
    const onTargets = renderPanel()
    const priority = normalizePriority(DEFAULT_TARGETS.priority)
    const grips = screen.getAllByLabelText(/drag to reorder/i)
    expect(grips).toHaveLength(priority.length)

    const list = document.querySelector('.priority-list') as HTMLElement
    const rowH = 30
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: rowH * priority.length,
      left: 0,
      right: 200,
      width: 200,
      height: rowH * priority.length,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect)

    // Drag the first row down past the second row's midpoint.
    fireEvent.pointerDown(grips[0], { clientY: 15, button: 0, pointerId: 1 })
    fireEvent.pointerMove(grips[0], { clientY: rowH + 20, pointerId: 1 })
    fireEvent.pointerUp(grips[0], { pointerId: 1 })

    const next = (onTargets.mock.calls.at(-1)![0] as Targets).priority!
    expect(next[1]).toBe(priority[0])
    expect(next[0]).toBe(priority[1])
    expect([...next].sort()).toEqual([...priority].sort())
  })

  it('a drag released where it started changes nothing', () => {
    const onTargets = renderPanel()
    const grips = screen.getAllByLabelText(/drag to reorder/i)
    fireEvent.pointerDown(grips[0], { clientY: 15, button: 0, pointerId: 2 })
    fireEvent.pointerUp(grips[0], { pointerId: 2 })
    expect(onTargets).not.toHaveBeenCalled()
  })
})
