// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { parseTsv } from '../lib/parse'
import { buildGrouping, seedGroups } from '../lib/groups'
import { DEFAULT_WIDTHS } from '../lib/columns'
import { BucketTable } from './BucketTable'
import type { SortState } from '../lib/types'

// jsdom has no layout engine, so it implements neither of these. The
// initially-selected cell focuses and scrolls itself into view on mount, same
// as in App.test.tsx.
beforeEach(() => {
  Element.prototype.scrollIntoView = () => {}
})

afterEach(cleanup)

const seeded = seedGroups(parseTsv(readFileSync('example-output-data.tsv', 'utf8')).rows)
const rows = seeded.rows
const grouping = buildGrouping(rows, seeded.groups)
const T = rows.reduce((a, r) => a + r.weight, 0)
const sort: SortState = { key: 'id', dir: 1 }
const groupIdOf = (name: string) => grouping.groups.find((g) => g.name === name)!.id

const tableProps = (collapsed: string[], onExpand = vi.fn(), onGroupLock = vi.fn()) => ({
  rows,
  totalWeight: T,
  sort,
  columnWidths: DEFAULT_WIDTHS,
  grouping,
  groups: seeded.groups,
  weightStep: 1 as const,
  collapsed,
  hidden: [] as string[],
  onSort: vi.fn(),
  onPatch: vi.fn(),
  onGroupMany: vi.fn(),
  onWidths: vi.fn(),
  onTotalWeight: vi.fn(),
  onTotalRtp: vi.fn(),
  onExpand,
  onGroupLock,
})

const renderTable = (collapsed: string[] = []) => {
  const onExpand = vi.fn()
  const onGroupLock = vi.fn()
  const view = render(<BucketTable {...tableProps(collapsed, onExpand, onGroupLock)} />)
  return { onExpand, onGroupLock, rerender: view.rerender }
}

describe('BucketTable column visibility', () => {
  it('renders One in and RTP Share for a row', () => {
    renderTable()
    expect(screen.getByText('One in')).toBeTruthy()
    expect(screen.getByText('RTP Share')).toBeTruthy()
    // One row's derived cells: One in = 1/chance, RTP Share = value / table RTP.
    const r = rows[0]
    const chance = r.weight / T
    const expected = `1/${(1 / chance).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}`
    const cells = [...document.querySelectorAll('tbody .col-oneIn .gcell')]
    expect(cells.some((el) => el.textContent === expected)).toBe(true)
  })

  it('omits hidden columns from header and body', () => {
    const props = tableProps([])
    render(<BucketTable {...props} hidden={['weightId', 'oneIn']} />)
    expect(screen.queryByText('Weight ID')).toBeNull()
    expect(screen.queryByText('One in')).toBeNull()
    expect(document.querySelector('tbody .col-weightId')).toBeNull()
  })

  it('totals row shows 1/1 and 100% for the derived columns', () => {
    renderTable()
    const totals = document.querySelector('.totals-row')!
    expect(totals.querySelector('.col-oneIn .gcell')!.textContent).toBe('1/1')
    expect(totals.querySelector('.col-rtpShare .gcell')!.textContent).toBe('100%')
  })
})

describe('BucketTable with a collapsed group', () => {
  it('draws one row per bucket when nothing is collapsed', () => {
    renderTable()
    expect(document.querySelectorAll('tbody tr')).toHaveLength(rows.length)
    expect(document.querySelectorAll('.group-summary')).toHaveLength(0)
  })

  it('replaces the group with a summary row carrying its sums', () => {
    const id = groupIdOf('bonus')
    const members = rows.filter((r) => r.groupId === id)
    renderTable([id])

    expect(document.querySelectorAll('tbody tr')).toHaveLength(rows.length - members.length + 1)
    const summary = document.querySelector('.group-summary')!
    expect(summary.querySelector('.col-label .gcell')!.textContent).toBe(
      `${members.length} buckets`,
    )
    const shown = summary.querySelector('.col-weight .gcell')!.textContent
    expect(shown).toBe(members.reduce((a, r) => a + r.weight, 0).toLocaleString('en-US'))
  })

  it('expands from the summary row', () => {
    const id = groupIdOf('bonus')
    const { onExpand } = renderTable([id])
    fireEvent.click(screen.getByRole('button', { name: /Show bonus/ }))
    expect(onExpand).toHaveBeenCalledWith(id)
  })

  it('locks every member from the summary row', () => {
    const id = groupIdOf('bonus')
    const { onGroupLock } = renderTable([id])
    fireEvent.click(document.querySelector('.group-summary .gcell.lock')!)
    expect(onGroupLock).toHaveBeenCalledWith(id, true)
  })

  it('never opens an editor on a summary cell', () => {
    const id = groupIdOf('bonus')
    renderTable([id])
    fireEvent.doubleClick(document.querySelector('.group-summary .col-weight .gcell')!)
    expect(document.querySelector('.group-summary input')).toBeNull()
  })

  it('keeps a keyboard-focusable cell when a collapse shrinks the table', () => {
    // Only the selected cell carries tabIndex 0. Selecting a row near the
    // bottom and then collapsing a group above it used to leave `sel` past the
    // end, with no focusable cell left anywhere in the grid.
    const id = groupIdOf('bonus')
    const { rerender } = renderTable()
    const last = [...document.querySelectorAll('.grid-row')].at(-1)!
    fireEvent.mouseDown(last.querySelector('.col-weight .gcell')!)

    rerender(<BucketTable {...tableProps([id])} />)
    expect(document.querySelectorAll('.grid-table [tabindex="0"]').length).toBeGreaterThan(0)
  })
})
