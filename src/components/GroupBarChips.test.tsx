// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { GroupBarChips } from './GroupBarChips'
import { groupRows } from '../lib/groups'
import type { BucketRow } from '../lib/types'

afterEach(cleanup)

const rows: BucketRow[] = [
  { uid: 'a', bucketId: 0, payout: 0, label: '0x', weight: 1, locked: false, groupId: 'zero', weightId: '' },
  { uid: 'b', bucketId: 1, payout: 0.6, label: '0-1x', weight: 1, locked: false, groupId: 'wins', weightId: '' },
  { uid: 'c', bucketId: 2, payout: 8, label: 'bonus3', weight: 1, locked: false, groupId: 'bonus', weightId: '' },
]

const renderChips = (groupBars: string[] = []) => {
  const onGroupBars = vi.fn()
  render(
    <GroupBarChips
      groups={groupRows(rows).groups}
      groupBars={groupBars}
      onGroupBars={onGroupBars}
    />,
  )
  return { onGroupBars }
}

describe('GroupBarChips', () => {
  it('offers one chip per group that holds buckets', () => {
    renderChips()
    expect(screen.getAllByRole('button', { pressed: false }).map((b) => b.textContent)).toEqual([
      'wins',
      'bonus',
      '0x',
    ])
  })

  it('marks a collapsed group as pressed', () => {
    renderChips(['bonus'])
    expect(screen.getByRole('button', { name: 'bonus', pressed: true })).toBeDefined()
  })

  it('collapses a group when its chip is clicked', () => {
    const { onGroupBars } = renderChips()
    fireEvent.click(screen.getByRole('button', { name: 'bonus' }))
    expect(onGroupBars).toHaveBeenCalledWith(['bonus'])
  })

  it('expands a collapsed group when its chip is clicked again', () => {
    const { onGroupBars } = renderChips(['wins', 'bonus'])
    fireEvent.click(screen.getByRole('button', { name: 'bonus' }))
    expect(onGroupBars).toHaveBeenCalledWith(['wins'])
  })

  it('collapses every drawn group from All', () => {
    const { onGroupBars } = renderChips()
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(onGroupBars).toHaveBeenCalledWith(['wins', 'bonus', 'zero'])
  })

  it('expands everything from None', () => {
    const { onGroupBars } = renderChips(['wins', 'bonus'])
    fireEvent.click(screen.getByRole('button', { name: 'None' }))
    expect(onGroupBars).toHaveBeenCalledWith([])
  })
})
