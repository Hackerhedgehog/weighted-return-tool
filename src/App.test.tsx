// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import App from './App'
import { readFileSync } from 'node:fs'
import { saveTabsState, saveWorkspace } from './lib/storage'
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
    expect(headers).toEqual([
      '',
      'Group',
      'ID▲',
      'Weight ID',
      'Avg Payout',
      'Label',
      'Weights',
      'Weighted Value',
      'Chance',
    ])
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

  it('explains a total too small to floor every bucket', () => {
    loadRealData()
    const cell = document.querySelector('.totals-row .col-weight .gcell') as HTMLElement
    fireEvent.mouseDown(cell)
    fireEvent.doubleClick(cell)
    const input = document.querySelector('.totals-row .col-weight input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '20' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(screen.getByText(/cannot give all 30 unlocked buckets/)).toBeDefined()
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
    const tints = new Set(styles.filter((s) => s.includes('rgba')))
    // wins, bonus, joker and 0x at least — each its own pastel tint
    expect(tints.size).toBeGreaterThanOrEqual(4)
    for (const s of styles) expect(s).not.toContain('--series-')
  })

  it('keeps a locked row on its group color, only deeper', () => {
    loadRealData()
    const row = document.querySelector('.grid-row')!
    const rgb = (el: Element) => /rgba\((\d+, \d+, \d+)/.exec(el.getAttribute('style') ?? '')?.[1]
    const hue = rgb(row)
    const alphaOf = (el: Element) => Number(/rgba\([\d, ]+, ([\d.]+)\)/.exec(el.getAttribute('style')!)![1])
    const before = alphaOf(row)

    fireEvent.click(row.querySelector('.gcell.lock')!)

    const locked = document.querySelector('.grid-row.locked')!
    expect(rgb(locked)).toBe(hue)
    expect(alphaOf(locked)).toBeGreaterThan(before)
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

  it('shows no auto-save button when there is no bridge', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('no bridge'))
    vi.stubGlobal('fetch', fetchMock)
    try {
      loadRealData()
      // The negative case has no observable DOM change to wait on — session
      // stays null and no button ever appears, with or without a bug. So
      // instead of asserting immediately (which would pass even if the
      // feature were entirely missing), wait for the mocked fetch to have
      // been invoked and then flush the microtask queue past fetchSession's
      // own try/catch and the effect's `.then`, so the session probe has
      // definitively settled before the assertion runs.
      await waitFor(() => expect(fetchMock).toHaveBeenCalled())
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(screen.queryByRole('button', { name: 'Auto save data' })).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('shows the auto-save button and destination when a bridge session exists', async () => {
    const session = {
      dir: '/game/scenarios',
      sourceFile: 'set-values-regular.tsv',
      filename: 'ref-weights-regular.tsv',
      game: 'joker-stacks-magic',
      tsv: '0\t1000.00\tjoker5-maxwin\n',
    }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => session,
      }),
    )
    try {
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Auto save data' })).toBeDefined()
      })
      expect(screen.getByText(`${session.game} → ${session.dir}`)).toBeDefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('omits the game separator when the bridge session carries no game name', async () => {
    const session = {
      dir: '/game/scenarios',
      sourceFile: 'set-values-regular.tsv',
      filename: 'ref-weights-regular.tsv',
      game: '',
      tsv: '0\t1000.00\tjoker5-maxwin\n',
    }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => session,
      }),
    )
    try {
      render(<App />)
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Auto save data' })).toBeDefined()
      })
      expect(screen.getByText(`→ ${session.dir}`)).toBeDefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('normalises a bare export filename before auto-saving, same as Download', async () => {
    const session = {
      dir: '/game/scenarios',
      sourceFile: 'set-values-regular.tsv',
      filename: 'ref-weights-regular.tsv',
      game: 'joker-stacks-magic',
      tsv: '0\t1000.00\tjoker5-maxwin\n',
    }
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (url === '/__bridge/session') {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => session,
        })
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ path: '/game/scenarios/myweights.tsv' }),
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      render(<App />)
      await waitFor(() => screen.getByRole('button', { name: 'Auto save data' }))

      fireEvent.change(screen.getByLabelText('Export filename'), {
        target: { value: 'myweights' },
      })
      fireEvent.click(screen.getByRole('button', { name: 'Auto save data' }))

      await waitFor(() => {
        expect(fetchMock.mock.calls.some(([url]) => url === '/__bridge/save')).toBe(true)
      })
      const saveCall = fetchMock.mock.calls.find(([url]) => url === '/__bridge/save')!
      const body = JSON.parse((saveCall[1] as RequestInit).body as string) as { filename: string }
      expect(body.filename).toBe('myweights.tsv')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('feeds with openAs new-tab into a fresh tab, keeping the old one', async () => {
    saveTabsState({
      version: 1,
      active: 't1',
      tabs: [{ id: 't1', name: 'Table 1', workspace: null }],
      lastBridge: { sessionId: 's1', seq: 1 },
    })
    const session = {
      dir: '/game/scenarios',
      sourceFile: 'set-values-buy.tsv',
      filename: 'ref-weights-buy.tsv',
      game: 'joker',
      tsv: '0\t2.00\talpha-win\n1\t0.00\t0x\n',
      sessionId: 's1',
      seq: 2,
      openAs: 'new-tab',
    }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => session,
      }),
    )
    try {
      render(<App />)
      await waitFor(() => expect(screen.getByText('alpha-win')).toBeDefined())
      const tabs = screen.getAllByRole('tab')
      expect(tabs.map((t) => t.textContent)).toEqual([
        'Table 1×',
        'joker · set-values-buy.tsv×',
      ])
      expect(tabs[1].getAttribute('aria-selected')).toBe('true')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('applies a batch feed one tab per file, chaining through the queue', async () => {
    saveTabsState({
      version: 1,
      active: 't1',
      tabs: [{ id: 't1', name: 'Table 1', workspace: null }],
      lastBridge: { sessionId: 's1', seq: 1 },
    })
    const session = {
      dir: '/game/scenarios',
      sourceFile: 'set-values-regular.tsv',
      filename: 'ref-weights-regular.tsv',
      game: 'imp',
      tsv: '0\t2.00\tregular-row\n',
      sessionId: 's1',
      seq: 2,
      openAs: 'new-tab',
      feeds: [
        {
          sourceFile: 'set-values-regular.tsv',
          filename: 'ref-weights-regular.tsv',
          game: 'imp',
          tsv: '0\t2.00\tregular-row\n',
        },
        {
          sourceFile: 'set-values-buy.tsv',
          filename: 'ref-weights-buy.tsv',
          game: 'imp',
          tsv: '0\t9.00\tbuy-row\n',
        },
      ],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => session,
      }),
    )
    try {
      render(<App />)
      // The queue drains head-first, so the batch is done when the LAST
      // feed's content is on screen.
      await waitFor(() => expect(screen.getByText('buy-row')).toBeDefined())
      const tabs = screen.getAllByRole('tab')
      expect(tabs.map((t) => t.textContent)).toEqual([
        'Table 1×',
        'imp · set-values-regular.tsv×',
        'imp · set-values-buy.tsv×',
      ])
      expect(tabs[2].getAttribute('aria-selected')).toBe('true')

      // The first feed landed in its own tab and survived the chain — the
      // unmount flush persisted it before the next tab took the stage.
      fireEvent.click(tabs[1])
      await waitFor(() => expect(screen.getByText('regular-row')).toBeDefined())
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('skips a feed it has already applied, so a refresh cannot clobber tuning', async () => {
    const workspace = {
      version: 1 as const,
      rows: [
        { uid: 'b1', bucketId: 0, payout: 2, label: 'tuned-row', weight: 500, locked: false, groupId: 'other', weightId: '' },
      ],
      groups: [{ id: 'other', name: 'other', color: '#a8d8ea' }],
      targets: DEFAULT_TARGETS,
      volatility: 'medium' as const,
      curve: 0.09,
      columnWidths: {},
      chart: DEFAULT_CHART,
      exportFilename: 'f.tsv',
    }
    saveTabsState({
      version: 1,
      active: 't1',
      tabs: [{ id: 't1', name: 'Table 1', workspace }],
      lastBridge: { sessionId: 's1', seq: 2 },
    })
    const session = {
      dir: '/game/scenarios',
      sourceFile: 'set-values-regular.tsv',
      filename: 'ref-weights-regular.tsv',
      game: 'joker',
      tsv: '0\t9.00\tfed-row\n',
      sessionId: 's1',
      seq: 2,
      openAs: 'overwrite',
    }
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => session,
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      render(<App />)
      await waitFor(() => expect(fetchMock).toHaveBeenCalled())
      // The tuned table stands; the already-applied feed was not re-imported.
      expect(screen.getByText('tuned-row')).toBeDefined()
      expect(screen.queryByText('fed-row')).toBeNull()
      expect(screen.getAllByRole('tab')).toHaveLength(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('never probes the bridge outside a dev server', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const wasDev = import.meta.env.DEV
    import.meta.env.DEV = false
    try {
      render(<App />)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      import.meta.env.DEV = wasDev
      vi.unstubAllGlobals()
    }
  })
})

describe('tabs', () => {
  const SECOND = '0\t2.00\tsecond-tab-row\n1\t0.00\t0x\n'

  it('keeps each tab its own table across switches', () => {
    loadRealData()
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }))

    // A fresh tab starts on the paste screen, exactly like a fresh app.
    expect(screen.getByText('Paste bucket data')).toBeDefined()
    fireEvent.change(screen.getByPlaceholderText(/joker5-maxwin/), { target: { value: SECOND } })
    fireEvent.click(screen.getByRole('button', { name: 'Build table' }))
    expect(screen.getByText('second-tab-row')).toBeDefined()
    expect(screen.queryByText('joker5-maxwin')).toBeNull()

    const [first, second] = screen.getAllByRole('tab')
    fireEvent.click(first)
    expect(screen.getByText('joker5-maxwin')).toBeDefined()
    expect(screen.queryByText('second-tab-row')).toBeNull()

    fireEvent.click(second)
    expect(screen.getByText('second-tab-row')).toBeDefined()
  })

  it('confirms before closing a tab that holds data, and never empties the strip', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    try {
      loadRealData()
      expect(screen.getAllByRole('tab')).toHaveLength(1)
      fireEvent.click(screen.getByLabelText(/^Close /))
      expect(confirm).toHaveBeenCalled()
      // The last tab closing leaves a fresh empty one, not an empty strip.
      expect(screen.getAllByRole('tab')).toHaveLength(1)
      expect(screen.getByText('Paste bucket data')).toBeDefined()
    } finally {
      confirm.mockRestore()
    }
  })

  it('closes an empty tab without asking', () => {
    const confirm = vi.spyOn(window, 'confirm')
    try {
      loadRealData()
      fireEvent.click(screen.getByRole('button', { name: 'New tab' }))
      expect(screen.getAllByRole('tab')).toHaveLength(2)

      const closes = screen.getAllByLabelText(/^Close /)
      fireEvent.click(closes[1])
      expect(confirm).not.toHaveBeenCalled()
      expect(screen.getAllByRole('tab')).toHaveLength(1)
      expect(screen.getByText('joker5-maxwin')).toBeDefined()
    } finally {
      confirm.mockRestore()
    }
  })
})

describe('weight step', () => {
  // The step control lives in the settings drawer now.
  const openSettings = () => fireEvent.click(screen.getByRole('button', { name: /Settings/ }))

  it('snaps Auto-Distribute to the chosen step', () => {
    loadRealData()
    openSettings()
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
    openSettings()
    fireEvent.click(screen.getByRole('button', { name: '×100' }))
    expect(screen.getByRole('button', { name: '×100' }).className).toContain('active')
    fireEvent.click(screen.getByRole('button', { name: /Undo/ }))
    expect(screen.getByRole('button', { name: 'free' }).className).toContain('active')
  })

  it('restores from a saved workspace', () => {
    saveWorkspace({
      version: 1,
      rows: [{ uid: 'b1', bucketId: 0, payout: 2, label: 'x', weight: 500, locked: false, groupId: 'other', weightId: '' }],
      targets: DEFAULT_TARGETS,
      volatility: 'medium',
      curve: 0.09,
      columnWidths: {},
      chart: DEFAULT_CHART,
      exportFilename: 'f.tsv',
      weightStep: 100,
    })
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /Settings/ }))
    expect(screen.getByRole('button', { name: '×100' }).className).toContain('active')
  })

  it('never snaps a typed weight, even at step 100', () => {
    loadRealData()
    openSettings()
    fireEvent.click(screen.getByRole('button', { name: '×100' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }))

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
    openSettings()
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

  it('forces the chart below the table when the toggle is pressed', () => {
    loadRealData()
    const toggle = screen.getByRole('button', { name: 'Stack below' })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('.content-row')!.className).toContain('force-stack')
  })
})

describe('targets panel layout', () => {
  it('keeps every setting and the actions on one row', () => {
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
    ]) {
      expect(within(row).getByText(label)).toBeDefined()
    }

    expect(within(row).getByRole('button', { name: 'Auto-Distribute' })).toBeDefined()
    expect(within(row).getByRole('button', { name: /Undo/ })).toBeDefined()
    expect(within(row).getByRole('button', { name: /Redo/ })).toBeDefined()
  })

  it('labels the weight steps as multipliers, in the settings drawer', () => {
    loadRealData()
    fireEvent.click(screen.getByRole('button', { name: /Settings/ }))
    const drawer = document.querySelector('.settings-drawer') as HTMLElement
    const names = [...drawer.querySelectorAll('.seg-btn')].map((b) => b.textContent)
    expect(names).toEqual(['free', '×10', '×100'])
  })
})

describe('solver settings drawer', () => {
  it('reorders the priority list, undoably', () => {
    loadRealData()
    fireEvent.click(screen.getByRole('button', { name: /Settings/ }))

    const labels = () =>
      [...document.querySelectorAll('.priority-label')].map((el) => el.textContent)
    expect(labels()[0]).toBe('Target RTP')

    fireEvent.click(screen.getByRole('button', { name: 'Lower Target RTP' }))
    expect(labels()[0]).toBe('Ordering / weighted value')
    expect(labels()[1]).toBe('Target RTP')

    fireEvent.click(screen.getByRole('button', { name: /Undo/ }))
    expect(labels()[0]).toBe('Target RTP')
  })

  it('closes on the backdrop and keeps the chosen order', () => {
    loadRealData()
    fireEvent.click(screen.getByRole('button', { name: /Settings/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Raise Pref hit chance' }))
    fireEvent.click(document.querySelector('.settings-backdrop')!)
    expect(document.querySelector('.settings-drawer')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Settings/ }))
    const labels = [...document.querySelectorAll('.priority-label')].map((el) => el.textContent)
    expect(labels[2]).toBe('Pref hit chance')
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

describe('groups', () => {
  // Group settings live in the settings drawer now.
  const openSettings = () => fireEvent.click(screen.getByRole('button', { name: /Settings/ }))

  it('detects families named by a bare prefix, not just alpha+digits', () => {
    render(<App />)
    fireEvent.change(screen.getByPlaceholderText(/joker5-maxwin/), {
      target: {
        value: [
          ['0', '8', 'lw-8-16'],
          ['1', '16', 'lw-16-32'],
          ['2', '16', 'fs-16-32'],
          ['3', '32', 'fs-32-64'],
        ]
          .map((r) => r.join('\t'))
          .join('\n'),
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Build table' }))

    const picked = [...document.querySelectorAll('.col-group select')].map(
      (el) => (el as HTMLSelectElement).selectedOptions[0].textContent,
    )
    expect(picked).toEqual(['lw', 'lw', 'fs', 'fs'])
  })

  it('moves a bucket to another group from the table dropdown', () => {
    loadRealData()
    const select = document.querySelector('.col-group select') as HTMLSelectElement
    const before = select.value
    const other = [...select.options].map((o) => o.value).find((v) => v !== before)!

    fireEvent.change(select, { target: { value: other } })
    expect((document.querySelector('.col-group select') as HTMLSelectElement).value).toBe(other)
  })

  it('keeps a hand-made assignment through an Auto-Distribute', () => {
    loadRealData()
    const select = document.querySelector('.col-group select') as HTMLSelectElement
    const other = [...select.options].map((o) => o.value).find((v) => v !== select.value)!
    fireEvent.change(select, { target: { value: other } })

    fireEvent.click(screen.getByRole('button', { name: 'Auto-Distribute' }))
    expect((document.querySelector('.col-group select') as HTMLSelectElement).value).toBe(other)
  })

  it('hides group settings until the button is pressed', () => {
    loadRealData()
    expect(document.querySelector('.group-settings')).toBeNull()
    openSettings()
    expect(document.querySelector('.group-settings')).not.toBeNull()
    openSettings()
    expect(document.querySelector('.group-settings')).toBeNull()
  })

  it('renames a group, and the table dropdown follows', () => {
    loadRealData()
    openSettings()
    const name = document.querySelector('.group-name') as HTMLInputElement
    fireEvent.change(name, { target: { value: 'renamed' } })

    const options = [...document.querySelectorAll('.col-group select option')].map(
      (o) => o.textContent,
    )
    expect(options).toContain('renamed')
  })

  it('offers twenty pastel swatches and recolors on click', () => {
    loadRealData()
    openSettings()
    const row = document.querySelector('.group-row') as HTMLElement
    const swatches = row.querySelectorAll('.swatch')
    expect(swatches).toHaveLength(20)

    fireEvent.click(swatches[7])
    expect(swatches[7].getAttribute('aria-checked')).toBe('true')
  })

  it('adds a group', () => {
    loadRealData()
    openSettings()
    const before = document.querySelectorAll('.group-row').length
    fireEvent.click(screen.getByRole('button', { name: '+ Add group' }))
    expect(document.querySelectorAll('.group-row')).toHaveLength(before + 1)
  })

  it('deleting a group moves its buckets rather than losing them', () => {
    loadRealData()
    const rowsBefore = document.querySelectorAll('.grid-row').length
    openSettings()

    const first = document.querySelector('.group-row') as HTMLElement
    const label = (first.querySelector('.group-name') as HTMLInputElement).value
    fireEvent.click(within(first).getByRole('button', { name: `Delete group ${label}` }))

    expect(document.querySelectorAll('.grid-row')).toHaveLength(rowsBefore)
    const options = [...document.querySelectorAll('.col-group select option')].map(
      (o) => o.textContent,
    )
    expect(options).not.toContain(label)
  })

  it('locks every bucket in a group and undoes it in one step', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Load sample' }))
    fireEvent.click(screen.getByRole('button', { name: /Settings/ }))

    const lockedRows = () => document.querySelectorAll('.gcell.lock.on').length
    const before = lockedRows()

    // Both the settings row and the chart handle carry this label, so scope it.
    const settings = within(document.querySelector('.group-settings') as HTMLElement)
    fireEvent.click(settings.getByRole('button', { name: 'Lock the bonus group' }))
    expect(lockedRows()).toBeGreaterThan(before)

    fireEvent.click(screen.getByRole('button', { name: '↶ Undo' }))
    expect(lockedRows()).toBe(before)
  })

  it('drives one soft lock from both the chart handle and the drawer', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Load sample' }))

    // Toggle from the chart's Σ control…
    fireEvent.click(screen.getByRole('button', { name: 'Soft-lock the bonus group total' }))
    // …the handle goes inert…
    expect(
      screen.getByRole('slider', { name: 'bonus group' }).getAttribute('aria-disabled'),
    ).toBe('true')
    // …no row gained a hard lock…
    expect(document.querySelectorAll('.gcell.lock.on')).toHaveLength(0)

    // …and the drawer's Σ shows the same state and can release it.
    fireEvent.click(screen.getByRole('button', { name: /Settings/ }))
    const settings = within(document.querySelector('.group-settings') as HTMLElement)
    const sigma = settings.getByRole('button', { name: "Unlock the bonus group's total weight" })
    expect(sigma.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(sigma)
    expect(
      screen.getByRole('slider', { name: 'bonus group' }).getAttribute('aria-disabled'),
    ).toBeNull()
  })
})

describe('weight id', () => {
  it('is an editable free-text column', () => {
    loadRealData()
    const cell = document.querySelector('.grid-row .col-weightId .gcell') as HTMLElement
    expect(cell.textContent).toBe('')

    fireEvent.mouseDown(cell)
    fireEvent.doubleClick(cell)
    const input = document.querySelector('.grid-row .col-weightId input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'W-42' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(document.querySelector('.grid-row .col-weightId .gcell')!.textContent).toBe('W-42')
  })
})

describe('solver switches', () => {
  it('greys the chance targets out and stops them blocking', () => {
    loadRealData()
    const toggle = screen.getByRole('checkbox', { name: 'Chance targets' }) as HTMLInputElement
    expect(toggle.checked).toBe(true)

    fireEvent.click(toggle)
    expect((screen.getByLabelText('Preferred Hit Chance') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('Chance tolerance percent') as HTMLInputElement).disabled).toBe(
      true,
    )
    // still reports what the table achieves
    expect(screen.getByLabelText('Preferred Win Chance')).toBeDefined()
  })

  it('greys volatility out on its own switch', () => {
    loadRealData()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Volatility curve' }))
    expect((screen.getByLabelText('Curve curvature') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'medium' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('still distributes to RTP with both switched off', () => {
    loadRealData()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Chance targets' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Volatility curve' }))
    fireEvent.click(screen.getByRole('button', { name: 'Auto-Distribute' }))

    const rtp = document.querySelector('.totals-row .col-weightedValue .gcell')!.textContent!
    expect(Number(rtp)).toBeCloseTo(0.95, 4)
  })
})

describe('group bars', () => {
  it('collapses a group into one bar from the chip row', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Load sample' }))

    // The table's Collapse row renders a chip named "bonus" too, so the
    // chart's chip is picked out by its title rather than its name.
    const before = document.querySelectorAll('.bar').length
    fireEvent.click(screen.getByTitle('Draw bonus as one bar'))

    expect(document.querySelectorAll('.bar').length).toBeLessThan(before)
    expect(screen.getByTitle("Show bonus's buckets").getAttribute('aria-pressed')).toBe('true')
  })

  it('restores collapsed groups from a saved workspace', () => {
    saveWorkspace({
      version: 1,
      rows: [
        { uid: 'b1', bucketId: 0, payout: 2, label: 'bonus3', weight: 500, locked: false, groupId: 'bonus', weightId: '' },
        { uid: 'b2', bucketId: 1, payout: 8, label: 'bonus4', weight: 500, locked: false, groupId: 'bonus', weightId: '' },
      ],
      groups: [{ id: 'bonus', name: 'bonus', color: '#a8d8ea' }],
      targets: DEFAULT_TARGETS,
      volatility: 'medium',
      curve: 0.09,
      columnWidths: {},
      chart: { ...DEFAULT_CHART, groupBars: ['bonus'] },
      exportFilename: 'f.tsv',
    })
    render(<App />)
    expect(screen.getByRole('button', { name: 'bonus', pressed: true })).toBeDefined()
    expect(document.querySelectorAll('.bar')).toHaveLength(1)
  })
})

describe('chrome layout', () => {
  it('opens group settings inside the settings drawer', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Load sample' }))
    const targets = document.querySelector('.targets')!
    const btn = screen.getByRole('button', { name: /Settings/ })
    expect(targets.contains(btn)).toBe(true)
    fireEvent.click(btn)
    expect(screen.getByRole('heading', { name: 'Groups' })).toBeDefined()
    expect(document.querySelector('.settings-drawer .group-settings')).not.toBeNull()
  })

  it('keeps the settings drawer reachable when the targets panel is collapsed', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Load sample' }))
    fireEvent.click(screen.getByRole('button', { name: /Targets/ }))
    expect(screen.getByRole('button', { name: /Settings/ })).toBeDefined()
  })

  it('separates import from export in the top bar', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Load sample' }))

    const blocks = [...document.querySelectorAll('.topbar-block')]
    expect(blocks.map((b) => b.querySelector('.topbar-block-label')!.textContent)).toEqual([
      'Import',
      'Export',
    ])
    expect(blocks[0].contains(screen.getByRole('button', { name: 'Paste TSV data' }))).toBe(true)
    expect(blocks[1].contains(screen.getByRole('button', { name: 'Copy TSV' }))).toBe(true)
    expect(blocks[1].contains(screen.getByLabelText('Export filename'))).toBe(true)

    // Destructive, and deliberately outside both blocks.
    const clear = screen.getByRole('button', { name: 'Clear workspace' })
    expect(blocks.some((b) => b.contains(clear))).toBe(false)
    expect(document.querySelector('.topbar-sep')).toBeNull()
  })
})

describe('simulation modes', () => {
  it('opens on convergence and switches to bankroll', () => {
    loadRealData()
    expect(screen.getByLabelText('Spins')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Bankroll' }))
    expect(screen.getByLabelText('Starting credits')).toBeDefined()
    expect(screen.getByLabelText('Bet')).toBeDefined()
    expect(screen.getByLabelText('RTP multiplier')).toBeDefined()
    expect(screen.queryByLabelText('Spins')).toBeNull()
  })

  it('defaults the bankroll to a million credits at a bet of one', () => {
    loadRealData()
    fireEvent.click(screen.getByRole('button', { name: 'Bankroll' }))
    expect((screen.getByLabelText('Starting credits') as HTMLInputElement).value).toBe('1,000,000')
    expect((screen.getByLabelText('Bet') as HTMLInputElement).value).toBe('1')
  })

  it('remembers the mode and the credits across a reload', () => {
    loadRealData()
    fireEvent.click(screen.getByRole('button', { name: 'Bankroll' }))
    const credits = screen.getByLabelText('Starting credits')
    fireEvent.change(credits, { target: { value: '250k' } })
    fireEvent.keyDown(credits, { key: 'Enter' })

    // autosave is debounced by 300ms; flush it the way the other reload tests do
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        cleanup()
        render(<App />)
        expect(
          screen.getByRole('button', { name: 'Bankroll' }).getAttribute('aria-pressed'),
        ).toBe('true')
        expect((screen.getByLabelText('Starting credits') as HTMLInputElement).value).toBe(
          '250,000',
        )
        resolve()
      }, 400)
    })
  })

  it('clamps a hand-edited out-of-range bankroll config instead of trusting it', () => {
    saveWorkspace({
      version: 1,
      rows: [
        { uid: 'b1', bucketId: 0, payout: 2, label: 'x', weight: 500, locked: false, groupId: 'other', weightId: '' },
      ],
      targets: DEFAULT_TARGETS,
      volatility: 'medium',
      curve: 0.09,
      columnWidths: {},
      chart: DEFAULT_CHART,
      exportFilename: 'f.tsv',
      // A bet of 0 never busts and burns a full 10M-spin chunk on Continue; a
      // negative multiplier would pay out negative credits.
      bankroll: { credits: 5000, bet: 0, rtpMultiplier: -1 },
    })
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Bankroll' }))

    expect((screen.getByLabelText('Bet') as HTMLInputElement).value).toBe('0.000001')
    expect((screen.getByLabelText('RTP multiplier') as HTMLInputElement).value).toBe('0')
    expect((screen.getByLabelText('Starting credits') as HTMLInputElement).value).toBe('5,000')
  })
})

describe('distribution chart height', () => {
  // jsdom implements no layout at all: offsetHeight is always 0 (nothing for
  // the observer to read) and getBoundingClientRect always returns zeros
  // (real browsers compute both from actual layout). Stub offsetHeight for
  // the table panel and the chart panel, and getBoundingClientRect for the
  // chart svg specifically (the app reads the svg's height that way, not via
  // offsetHeight — SVG elements have no offsetHeight per spec, it's a
  // Chromium/WebKit-only extension that Gecko doesn't implement). Put both
  // back after — ChartReadout and the targets panel measure themselves
  // through offsetHeight too, and other code calls getBoundingClientRect on
  // other elements (e.g. the value-entry popover's positioning).
  const REAL_OFFSET_HEIGHT = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'offsetHeight',
  )!
  const REAL_GET_BOUNDING_CLIENT_RECT = Element.prototype.getBoundingClientRect

  // An arbitrary fixed panel height: only its distance from the svg height
  // below (the `chrome`) is meaningful, since the app derives chrome as
  // panelHeight - svgHeight.
  const CHART_PANEL_PX = 1000

  /**
   * `chrome` stands in for everything the real chart panel has besides its
   * SVG — panel-head, .chart-controls, the group chips row, the fixed
   * readout band, the grip. Both stubs return fixed numbers regardless of
   * what the app renders, so there is nothing here that could oscillate; the
   * app's own oscillation-safety is what Important 2 is about, not this stub.
   */
  const withTableHeight = (tablePx: number, chrome = 150) => {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.classList.contains('buckets')) return tablePx
        if (this.classList.contains('chart')) return CHART_PANEL_PX
        return 0
      },
    })
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.getAttribute('aria-label') === 'Bucket distribution') {
        return { height: CHART_PANEL_PX - chrome } as unknown as DOMRect
      }
      return REAL_GET_BOUNDING_CLIENT_RECT.call(this)
    }
  }

  afterEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', REAL_OFFSET_HEIGHT)
    Element.prototype.getBoundingClientRect = REAL_GET_BOUNDING_CLIENT_RECT
  })

  const chart = () => screen.getByRole('img', { name: 'Bucket distribution' })

  it('fits the table minus the chart panel’s own chrome, clamped to the chart range', () => {
    withTableHeight(500, 150)
    loadRealData()
    expect(Number(chart().getAttribute('height'))).toBe(350)
  })

  it('clamps a table taller than the chart ceiling', () => {
    withTableHeight(5000, 150)
    loadRealData()
    expect(Number(chart().getAttribute('height'))).toBe(900)
  })

  it('clamps a table shorter than the chart floor', () => {
    withTableHeight(80, 150)
    loadRealData()
    expect(Number(chart().getAttribute('height'))).toBe(220)
  })

  it('stops fitting once the grip has been dragged, and fits again after a reset', () => {
    withTableHeight(700, 150)
    loadRealData()
    const grip = screen.getByRole('separator', { name: 'Resize the distribution chart' })
    // Auto-fit height is 700 (table) - 150 (chrome) = 550.
    expect(Number(chart().getAttribute('height'))).toBe(550)

    fireEvent.pointerDown(grip, { button: 0, clientY: 0 })
    fireEvent.pointerMove(grip, { clientY: -200 })
    fireEvent.pointerUp(grip)
    expect(Number(chart().getAttribute('height'))).toBe(350)

    fireEvent.doubleClick(grip)
    expect(Number(chart().getAttribute('height'))).toBe(550)
  })
})
