// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { GroupDistributionTable } from './GroupDistributionTable'
import { buildGrouping } from '../lib/groups'
import type { BucketRow, GroupDef } from '../lib/types'

const row = (uid: string, payout: number, weight: number, groupId: string): BucketRow => ({
  uid,
  bucketId: 0,
  payout,
  label: uid,
  weight,
  locked: false,
  groupId,
  weightId: '',
})

const groups: GroupDef[] = [{ id: 'a', name: 'alpha', color: '#aabbcc' }]
const rows = [row('r1', 10, 100, 'a'), row('r2', 2, 300, 'a')]

describe('GroupDistributionTable', () => {
  afterEach(cleanup)

  it('shows one row per group with 2dp chance and a full-precision tooltip', () => {
    render(
      <GroupDistributionTable
        rows={rows}
        grouping={buildGrouping(rows, groups)}
        totalWeight={400}
        hidden={[]}
      />,
    )
    expect(screen.getByText('alpha')).toBeTruthy()
    // Chance and RTP Share both read 100% here; the chance cell is the one
    // carrying the full-precision tooltip.
    const chance = screen.getAllByText('100%').find((el) => el.getAttribute('title') !== null)
    expect(chance?.getAttribute('title')).toContain('100')
    expect(screen.getByText('1/1')).toBeTruthy()
  })

  it('hides toggled-off columns', () => {
    render(
      <GroupDistributionTable
        rows={rows}
        grouping={buildGrouping(rows, groups)}
        totalWeight={400}
        hidden={['std', 'oneIn']}
      />,
    )
    expect(screen.queryByText('STD')).toBeNull()
    expect(screen.queryByText('One in')).toBeNull()
  })
})
