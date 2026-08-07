// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import App from './App'
import { readFileSync } from 'node:fs'
import { saveWorkspace } from './lib/storage'
import { DEFAULT_CHART, DEFAULT_TARGETS } from './lib/types'

const INPUT = readFileSync('example-input-data.tsv', 'utf8')

/**
 * A smoke test over the real app, not a substitute for looking at it. It
 * catches the failures that are invisible in unit tests — a bad hook, a
 * missing export, a crash on mount — and pins the behaviours the brief called
 * out: column order, full-precision chances, locking, and in-cell arithmetic.
 */

beforeEach(() => {
  localStorage.clear()
  // jsdom has no layout engine, so it implements neither of these.
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  Element.prototype.scrollIntoView = () => {}
})

afterEach(cleanup)

function loadRealData() {
  render(<App />)
  fireEvent.change(screen.getByPlaceholderText(/joker5-maxwin/), { target: { value: INPUT } })
  fireEvent.click(screen.getByRole('button', { name: 'Build table' }))
}

describe('App', () => {
  it('starts on the paste screen', () => {
    render(<App />)
    expect(screen.getByText('Paste bucket data')).toBeDefined()
  })

  it('builds a table from the real engine data', () => {
    loadRealData()
    expect(screen.getByText('joker5-maxwin')).toBeDefined()
    expect(screen.getByText('green-two-only')).toBeDefined()
    // 30 buckets + header + totals
    expect(document.querySelectorAll('.grid-row')).toHaveLength(30)
  })

  it('shows columns in the export order', () => {
    loadRealData()
    const headers = [...document.querySelectorAll('thead th')].map((th) => th.textContent?.trim())
    expect(headers).toEqual(['', 'ID▲', 'Avg Payout', 'Label', 'Weights', 'Weighted Value', 'Chance'])
  })

  it('keeps float payouts intact', () => {
    loadRealData()
    expect(screen.getByText('50.16')).toBeDefined()
    expect(screen.getByText('0.33')).toBeDefined()
  })

  it('renders chances in full decimal, never scientific notation', () => {
    loadRealData()
    const chances = [...document.querySelectorAll('.col-chance .gcell')].map((c) => c.textContent ?? '')
    const values = chances.filter((c) => c !== '' && c !== 'Chance')
    expect(values.length).toBeGreaterThan(20)
    for (const v of values) expect(v).not.toMatch(/e-?\d/i)
    // and at least one is small enough that the old formatter would have
    // rendered it as an exponent
    expect(values.some((v) => /^0\.0000\d/.test(v))).toBe(true)
  })

  it('has an editable totals row showing the weight sum and RTP', () => {
    loadRealData()
    const totals = document.querySelector('.totals-row')!
    expect(within(totals as HTMLElement).getByText('1,000,000')).toBeDefined()
    expect(within(totals as HTMLElement).getByText('1')).toBeDefined()
  })

  it('reports hit chance and win chance separately', () => {
    loadRealData()
    expect(screen.getByText('Preferred Hit Chance')).toBeDefined()
    expect(screen.getByText('Preferred Win Chance')).toBeDefined()
  })

  it('locks a row and leaves its weight alone through Auto-Distribute', () => {
    loadRealData()
    const firstRow = document.querySelector('.grid-row')!
    const weightBefore = firstRow.querySelector('.col-weight .gcell')!.textContent

    fireEvent.click(firstRow.querySelector('.gcell.lock')!)
    expect(document.querySelector('.grid-row.locked')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Auto-Distribute' }))

    const after = document.querySelector('.grid-row')!.querySelector('.col-weight .gcell')!
    expect(after.textContent).toBe(weightBefore)
  })

  it('shows a clear notice when every row is locked and the total is changed', () => {
    loadRealData()
    document.querySelectorAll('.grid-row .gcell.lock').forEach((el) => fireEvent.click(el))
    expect(document.querySelectorAll('.grid-row.locked')).toHaveLength(30)

    const cell = document.querySelector('.totals-row .col-weight .gcell') as HTMLElement
    fireEvent.mouseDown(cell)
    fireEvent.doubleClick(cell)
    const input = document.querySelector('.totals-row .col-weight input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '2000000' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(
      screen.getByText(
        'Every row is locked — unlock something or set the total to exactly the locked weight (1,000,000).',
      ),
    ).toBeDefined()
  })

  it('adds to a cell when an operator is typed on it', () => {
    loadRealData()
    const cell = document.querySelector('.grid-row .col-weight .gcell') as HTMLElement
    const before = Number(cell.textContent!.replace(/,/g, ''))

    fireEvent.mouseDown(cell)
    fireEvent.keyDown(cell, { key: '+' })

    const input = document.querySelector('.grid-row .col-weight input') as HTMLInputElement
    expect(input.value).toBe(`${before}+`)

    fireEvent.change(input, { target: { value: `${before}+500` } })
    fireEvent.keyDown(input, { key: 'Enter' })

    const after = document.querySelector('.grid-row .col-weight .gcell')!
    expect(Number(after.textContent!.replace(/,/g, ''))).toBe(before + 500)
  })

  it('undoes that edit with the toolbar button', () => {
    loadRealData()
    const cell = document.querySelector('.grid-row .col-weight .gcell') as HTMLElement
    const before = cell.textContent

    fireEvent.mouseDown(cell)
    fireEvent.keyDown(cell, { key: '+' })
    const input = document.querySelector('.grid-row .col-weight input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '999' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(document.querySelector('.grid-row .col-weight .gcell')!.textContent).not.toBe(before)

    fireEvent.click(screen.getByRole('button', { name: /Undo/ }))
    expect(document.querySelector('.grid-row .col-weight .gcell')!.textContent).toBe(before)
  })

  it('tints rows by bucket group without touching layout', () => {
    loadRealData()
    const styles = [...document.querySelectorAll('.grid-row')].map(
      (tr) => tr.getAttribute('style') ?? '',
    )
    expect(styles.some((s) => s.includes('--series-0-tint'))).toBe(true) // win ranges
    expect(styles.some((s) => s.includes('--series-1-tint'))).toBe(true) // bonus
    expect(styles.some((s) => s.includes('--series-6-tint'))).toBe(true) // 0x buckets
  })

  it('sorts by group when the Group sort button is clicked', () => {
    loadRealData()
    fireEvent.click(screen.getByRole('button', { name: 'Group sort' }))

    const labels = [...document.querySelectorAll('.grid-row .col-label .gcell')].map(
      (el) => el.textContent ?? '',
    )
    // win ranges lead, ordered by payout
    expect(labels[0]).toBe('0-1x')
    // every zero-payout bucket sits in one contiguous block
    const zeroBlock = ['joker2-tease', 'bonus-silent-tease', 'bonus1-tease', 'bonus2-tease', '0x']
      .map((l) => labels.indexOf(l))
      .sort((a, b) => a - b)
    expect(zeroBlock[0]).toBeGreaterThan(-1)
    expect(zeroBlock[4] - zeroBlock[0]).toBe(4)
  })

  it('shows the simulation panel below everything else', () => {
    loadRealData()
    expect(screen.getByText('Simulation')).toBeDefined()
    expect(screen.getByLabelText('Spins')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Run' })).toBeDefined()
  })

  it('restores the workspace after a reload', () => {
    loadRealData()
    const before = document.querySelector('.grid-row .col-weight .gcell')!.textContent

    // autosave is debounced; flush it by unmounting and remounting past the delay
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        cleanup()
        render(<App />)
        expect(screen.queryByText('Paste bucket data')).toBeNull()
        expect(document.querySelector('.grid-row .col-weight .gcell')!.textContent).toBe(before)
        resolve()
      }, 400)
    })
  })
})

describe('weight step', () => {
  it('snaps Auto-Distribute to the chosen step', () => {
    loadRealData()
    fireEvent.click(screen.getByRole('button', { name: '×100' }))
    fireEvent.click(screen.getByRole('button', { name: 'Auto-Distribute' }))

    const weights = [...document.querySelectorAll('tbody .col-weight .gcell')].map((c) =>
      Number((c.textContent ?? '').replace(/,/g, '')),
    )
    expect(weights).toHaveLength(30)
    expect(weights.every((w) => w % 100 === 0)).toBe(true)
  })

  it('is undoable', () => {
    loadRealData()
    fireEvent.click(screen.getByRole('button', { name: '×100' }))
    expect(screen.getByRole('button', { name: '×100' }).className).toContain('active')
    fireEvent.click(screen.getByRole('button', { name: /Undo/ }))
    expect(screen.getByRole('button', { name: 'free' }).className).toContain('active')
  })

  it('restores from a saved workspace', () => {
    saveWorkspace({
      version: 1,
      rows: [{ uid: 'b1', bucketId: 0, payout: 2, label: 'x', weight: 500, locked: false }],
      targets: DEFAULT_TARGETS,
      volatility: 'medium',
      curve: 0.09,
      columnWidths: {},
      chart: DEFAULT_CHART,
      exportFilename: 'f.tsv',
      weightStep: 100,
    })
    render(<App />)
    expect(screen.getByRole('button', { name: '×100' }).className).toContain('active')
  })

  it('never snaps a typed weight, even at step 100', () => {
    loadRealData()
    fireEvent.click(screen.getByRole('button', { name: '×100' }))

    const cell = document.querySelector('.grid-row .col-weight .gcell') as HTMLElement
    fireEvent.mouseDown(cell)
    fireEvent.doubleClick(cell)
    const input = document.querySelector('.grid-row .col-weight input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '12345' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(document.querySelector('.grid-row .col-weight .gcell')!.textContent).toBe('12,345')
  })

  it('restores the step on redo after undoing it', () => {
    loadRealData()
    fireEvent.click(screen.getByRole('button', { name: '×100' }))

    fireEvent.click(screen.getByRole('button', { name: /Undo/ }))
    expect(screen.getByRole('button', { name: 'free' }).className).toContain('active')

    fireEvent.click(screen.getByRole('button', { name: /Redo/ }))
    expect(screen.getByRole('button', { name: '×100' }).className).toContain('active')
  })
})

describe('numpad decimal', () => {
  const numpadComma = { key: ',', code: 'NumpadDecimal' }

  it('types a dot into an open cell editor', () => {
    loadRealData()
    const cell = [...document.querySelectorAll('tbody .col-weight .gcell')][0]
    fireEvent.mouseDown(cell)
    fireEvent.doubleClick(cell)
    const input = document.querySelector('input.gcell.editing') as HTMLInputElement
    input.setSelectionRange(input.value.length, input.value.length)
    const before = input.value
    fireEvent.keyDown(input, numpadComma)
    expect(input.value).toBe(`${before}.`)
  })

  it('seeds an edit with a dot when typed on a selected numeric cell', () => {
    loadRealData()
    const cell = [...document.querySelectorAll('tbody .col-weight .gcell')][0]
    fireEvent.mouseDown(cell)
    fireEvent.keyDown(cell, numpadComma)
    const input = document.querySelector('input.gcell.editing') as HTMLInputElement
    expect(input.value).toBe('.')
  })

  it('keeps the comma when typing into a label cell', () => {
    loadRealData()
    const cell = [...document.querySelectorAll('tbody .col-label .gcell')][0]
    fireEvent.mouseDown(cell)
    fireEvent.keyDown(cell, numpadComma)
    const input = document.querySelector('input.gcell.editing') as HTMLInputElement
    expect(input.value).toBe(',')
  })

  it('leaves a main-row comma alone in the cell editor', () => {
    loadRealData()
    const cell = [...document.querySelectorAll('tbody .col-weight .gcell')][0]
    fireEvent.mouseDown(cell)
    fireEvent.doubleClick(cell)
    const input = document.querySelector('input.gcell.editing') as HTMLInputElement
    const before = input.value
    fireEvent.keyDown(input, { key: ',', code: 'Comma' })
    expect(input.value).toBe(before)
  })

  it('types a dot into a panel number field', () => {
    loadRealData()
    const rtp = screen.getByLabelText('Target RTP') as HTMLInputElement
    fireEvent.focus(rtp)
    rtp.setSelectionRange(rtp.value.length, rtp.value.length)
    fireEvent.keyDown(rtp, numpadComma)
    expect(rtp.value.endsWith('.')).toBe(true)
  })

  it('types a dot into the spins field', () => {
    loadRealData()
    const spins = screen.getByLabelText('Spins') as HTMLInputElement
    spins.setSelectionRange(spins.value.length, spins.value.length)
    fireEvent.keyDown(spins, numpadComma)
    expect(spins.value.endsWith('.')).toBe(true)
  })
})

describe('page layout', () => {
  it('lays the table and the chart out side by side, in their own row', () => {
    loadRealData()
    const content = document.querySelector('.content')!
    expect([...content.children].map((el) => el.className)).toEqual([
      'targets',
      'content-row',
      'panel full',
    ])
    // The row is the sticky chart's containing block, so it cannot follow the
    // page past the bottom of the table.
    const row = document.querySelector('.content-row')!
    expect([...row.children].map((el) => el.className)).toEqual(['panel buckets', 'panel chart'])
  })
})

describe('targets panel layout', () => {
  it('keeps every setting, the weight step and the actions on one row', () => {
    loadRealData()
    const rows = document.querySelectorAll('.targets-row')
    expect(rows).toHaveLength(1)
    const row = rows[0] as HTMLElement

    for (const label of [
      'Target RTP',
      'Preferred Hit Chance',
      'Preferred Win Chance',
      'Chance tolerance',
      'Volatility',
      'Curve c',
      'Weight step',
    ]) {
      expect(within(row).getByText(label)).toBeDefined()
    }

    expect(within(row).getByRole('button', { name: 'Auto-Distribute' })).toBeDefined()
    expect(within(row).getByRole('button', { name: /Undo/ })).toBeDefined()
    expect(within(row).getByRole('button', { name: /Redo/ })).toBeDefined()
  })

  it('labels the weight steps as multipliers', () => {
    loadRealData()
    const step = [...document.querySelectorAll('.target-field')].find(
      (f) => f.querySelector('.field-label')?.textContent === 'Weight step',
    )!
    const names = [...step.querySelectorAll('.seg-btn')].map((b) => b.textContent)
    expect(names).toEqual(['free', '×10', '×100'])
  })
})

describe('targets panel collapse', () => {
  const toggle = () => screen.getByRole('button', { name: /Targets/ })

  it('starts expanded', () => {
    loadRealData()
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByLabelText('Target RTP')).toBeDefined()
  })

  it('hides the inputs but keeps the readouts and the actions', () => {
    loadRealData()
    fireEvent.click(toggle())

    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByLabelText('Target RTP')).toBeNull()
    expect(document.querySelectorAll('.targets-row')).toHaveLength(0)

    const summary = document.querySelector('.targets-summary') as HTMLElement
    const names = [...summary.querySelectorAll('dt')].map((el) => el.textContent)
    expect(names).toEqual(['RTP', 'Hit', 'Win', 'Tolerance', 'Volatility', 'Curve', 'Step'])
    expect(within(summary).getByText('3.5%')).toBeDefined()
    expect(within(summary).getByText('medium')).toBeDefined()
    expect(within(summary).getByText('free')).toBeDefined()

    const actions = document.querySelector('.targets-head-actions') as HTMLElement
    expect(within(actions).getByRole('button', { name: 'Auto-Distribute' })).toBeDefined()
    expect(within(actions).getByRole('button', { name: /Undo/ })).toBeDefined()
  })

  it('still distributes while collapsed', () => {
    loadRealData()
    const before = document.querySelector('.grid-row .col-weight .gcell')!.textContent
    fireEvent.click(toggle())
    fireEvent.click(screen.getByRole('button', { name: 'Auto-Distribute' }))
    expect(document.querySelector('.grid-row .col-weight .gcell')!.textContent).toBe(before)
    expect(screen.queryByLabelText('Target RTP')).toBeNull()
  })

  it('expands again', () => {
    loadRealData()
    fireEvent.click(toggle())
    fireEvent.click(toggle())
    expect(screen.getByLabelText('Target RTP')).toBeDefined()
  })

  it('remembers the collapsed state across a reload', () => {
    loadRealData()
    fireEvent.click(toggle())

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        cleanup()
        render(<App />)
        expect(screen.getByRole('button', { name: /Targets/ }).getAttribute('aria-expanded')).toBe(
          'false',
        )
        resolve()
      }, 400)
    })
  })
})

describe('header actions', () => {
  it('carries the export controls, not the targets panel', () => {
    loadRealData()
    const header = document.querySelector('.topbar') as HTMLElement

    expect(within(header).getByRole('button', { name: 'Load sample' })).toBeDefined()
    expect(within(header).getByRole('button', { name: 'Paste TSV data' })).toBeDefined()
    expect(within(header).getByRole('button', { name: 'Copy TSV' })).toBeDefined()
    expect(within(header).getByRole('button', { name: 'Download .tsv' })).toBeDefined()
    expect(within(header).getByLabelText('Export filename')).toBeDefined()
    expect(within(header).getByRole('button', { name: 'Clear workspace' })).toBeDefined()

    expect(document.querySelector('.targets .filename-input')).toBeNull()
  })

  it('shows only the load actions before a table exists', () => {
    render(<App />)
    const header = document.querySelector('.topbar') as HTMLElement
    expect(within(header).queryByRole('button', { name: 'Copy TSV' })).toBeNull()
    expect(within(header).getByRole('button', { name: 'Load sample' })).toBeDefined()
  })
})
