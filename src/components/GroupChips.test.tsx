// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { GroupChips } from './GroupChips'
import { groupRows } from '../lib/groups'
import type { BucketRow } from '../lib/types'

afterEach(cleanup)

const rows: BucketRow[] = [
  { uid: 'a', bucketId: 0, payout: 0, label: '0x', weight: 1, locked: false, groupId: 'zero', weightId: '' },
  { uid: 'b', bucketId: 1, payout: 0.6, label: '0-1x', weight: 1, locked: false, groupId: 'wins', weightId: '' },
  { uid: 'c', bucketId: 2, payout: 8, label: 'bonus3', weight: 1, locked: false, groupId: 'bonus', weightId: '' },
]

const renderChips = (selected: string[] = []) => {
  const onSelected = vi.fn()
  render(
    <GroupChips
      groups={groupRows(rows).groups}
      selected={selected}
      onSelected={onSelected}
      label="Group bars"
      titleOn={(n) => `Show ${n}'s buckets`}
      titleOff={(n) => `Draw ${n} as one bar`}
    />,
  )
  return { onSelected }
}

describe('GroupChips', () => {
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
    const { onSelected } = renderChips()
    fireEvent.click(screen.getByRole('button', { name: 'bonus' }))
    expect(onSelected).toHaveBeenCalledWith(['bonus'])
  })

  it('expands a collapsed group when its chip is clicked again', () => {
    const { onSelected } = renderChips(['wins', 'bonus'])
    fireEvent.click(screen.getByRole('button', { name: 'bonus' }))
    expect(onSelected).toHaveBeenCalledWith(['wins'])
  })

  it('collapses every drawn group from All', () => {
    const { onSelected } = renderChips()
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(onSelected).toHaveBeenCalledWith(['wins', 'bonus', 'zero'])
  })

  it('expands everything from None', () => {
    const { onSelected } = renderChips(['wins', 'bonus'])
    fireEvent.click(screen.getByRole('button', { name: 'None' }))
    expect(onSelected).toHaveBeenCalledWith([])
  })

  it('labels the row with whatever the caller calls it', () => {
    render(
      <GroupChips
        groups={groupRows(rows).groups}
        selected={[]}
        onSelected={vi.fn()}
        label="Collapse"
        titleOn={(n) => `Show ${n}'s buckets`}
        titleOff={(n) => `Collapse ${n} into one row`}
      />,
    )
    expect(screen.getByText('Collapse')).toBeDefined()
  })
})
