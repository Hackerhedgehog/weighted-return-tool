// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import App from './App'
import { readFileSync } from 'node:fs'

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
