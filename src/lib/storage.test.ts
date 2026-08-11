import { describe, it, expect, beforeEach } from 'vitest'
import { clearWorkspace, loadWorkspace, saveWorkspace, STORAGE_KEY, type Workspace } from './storage'
import { DEFAULT_BANKROLL, DEFAULT_CHART, DEFAULT_EXPORT_FILENAME, DEFAULT_TARGETS } from './types'

// vitest runs these in the node environment, which has no localStorage.
const store = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  },
})

const workspace: Workspace = {
  version: 1,
  rows: [{ uid: 'b1', bucketId: 0, payout: 50.16, label: 'bonus5', weight: 700, locked: true, groupId: 'other', weightId: '' }],
  targets: DEFAULT_TARGETS,
  volatility: 'medium',
  curve: 0.09,
  columnWidths: { weight: 120 },
  chart: DEFAULT_CHART,
  exportFilename: DEFAULT_EXPORT_FILENAME,
}

describe('storage', () => {
  beforeEach(() => store.clear())

  it('round-trips a workspace', () => {
    saveWorkspace(workspace)
    expect(loadWorkspace()).toEqual(workspace)
  })

  it('returns null when nothing is stored', () => {
    expect(loadWorkspace()).toBeNull()
  })

  it('discards malformed JSON instead of throwing', () => {
    store.set(STORAGE_KEY, '{not json')
    expect(loadWorkspace()).toBeNull()
    expect(store.has(STORAGE_KEY)).toBe(false)
  })

  it('rejects a workspace from a future schema version', () => {
    store.set(STORAGE_KEY, JSON.stringify({ ...workspace, version: 99 }))
    expect(loadWorkspace()).toBeNull()
  })

  it('rejects a wrong-shaped payload', () => {
    store.set(STORAGE_KEY, JSON.stringify({ version: 1, rows: 'nope' }))
    expect(loadWorkspace()).toBeNull()

    store.set(STORAGE_KEY, JSON.stringify({ ...workspace, targets: { rtp: 'high' } }))
    expect(loadWorkspace()).toBeNull()

    store.set(STORAGE_KEY, JSON.stringify({ ...workspace, rows: [{ label: 'no numbers' }] }))
    expect(loadWorkspace()).toBeNull()
  })

  it('clears', () => {
    saveWorkspace(workspace)
    clearWorkspace()
    expect(loadWorkspace()).toBeNull()
  })

  it('survives a storage backend that throws', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error('denied')
        },
        setItem: () => {
          throw new Error('quota')
        },
        removeItem: () => {
          throw new Error('denied')
        },
      },
    })

    expect(() => saveWorkspace(workspace)).not.toThrow()
    expect(loadWorkspace()).toBeNull()

    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    })
  })

  it('round-trips a workspace carrying a weight step', () => {
    saveWorkspace({ ...workspace, weightStep: 100 })
    expect(loadWorkspace()?.weightStep).toBe(100)
  })

  it('accepts a stepless workspace but rejects a bogus step', () => {
    saveWorkspace(workspace)
    expect(loadWorkspace()).toEqual(workspace)

    store.set(STORAGE_KEY, JSON.stringify({ ...workspace, weightStep: 7 }))
    expect(loadWorkspace()).toBeNull()
  })

  it('round-trips both chart heights', () => {
    saveWorkspace({ ...workspace, chartHeight: 520, simChartHeight: 300 })
    const loaded = loadWorkspace()
    expect(loaded?.chartHeight).toBe(520)
    expect(loaded?.simChartHeight).toBe(300)
  })

  it('accepts a heightless workspace but rejects a non-numeric height', () => {
    saveWorkspace(workspace)
    expect(loadWorkspace()).toEqual(workspace)

    store.set(STORAGE_KEY, JSON.stringify({ ...workspace, chartHeight: 'tall' }))
    expect(loadWorkspace()).toBeNull()

    store.set(STORAGE_KEY, JSON.stringify({ ...workspace, simChartHeight: null }))
    expect(loadWorkspace()).toBeNull()
  })

  it('round-trips the collapsed targets flag and rejects a non-boolean', () => {
    saveWorkspace({ ...workspace, targetsCollapsed: true })
    expect(loadWorkspace()?.targetsCollapsed).toBe(true)

    store.set(STORAGE_KEY, JSON.stringify({ ...workspace, targetsCollapsed: 'yes' }))
    expect(loadWorkspace()).toBeNull()
  })

  it('rejects a workspace whose groupBars is not a list of strings', () => {
    store.set(
      STORAGE_KEY,
      JSON.stringify({ ...workspace, chart: { ...DEFAULT_CHART, groupBars: 'bonus' } }),
    )
    expect(loadWorkspace()).toBeNull()
  })

  it('accepts a workspace saved before groupBars existed', () => {
    const chart: Record<string, unknown> = { ...DEFAULT_CHART }
    delete chart.groupBars
    store.set(STORAGE_KEY, JSON.stringify({ ...workspace, chart }))
    expect(loadWorkspace()).not.toBeNull()
  })

  it('round-trips the simulation mode and rejects an unknown one', () => {
    saveWorkspace({ ...workspace, simMode: 'bankroll' })
    expect(loadWorkspace()?.simMode).toBe('bankroll')

    store.set(STORAGE_KEY, JSON.stringify({ ...workspace, simMode: 'roulette' }))
    expect(loadWorkspace()).toBeNull()
  })

  it('round-trips the bankroll config and rejects a malformed one', () => {
    saveWorkspace({ ...workspace, bankroll: { credits: 500, bet: 0.5, rtpMultiplier: 0.9 } })
    expect(loadWorkspace()?.bankroll).toEqual({ credits: 500, bet: 0.5, rtpMultiplier: 0.9 })

    store.set(
      STORAGE_KEY,
      JSON.stringify({ ...workspace, bankroll: { ...DEFAULT_BANKROLL, bet: 'one' } }),
    )
    expect(loadWorkspace()).toBeNull()

    store.set(STORAGE_KEY, JSON.stringify({ ...workspace, bankroll: { credits: 500 } }))
    expect(loadWorkspace()).toBeNull()
  })

  it('round-trips the chart auto-height flag and rejects a non-boolean', () => {
    saveWorkspace({ ...workspace, chartHeightAuto: false })
    expect(loadWorkspace()?.chartHeightAuto).toBe(false)

    store.set(STORAGE_KEY, JSON.stringify({ ...workspace, chartHeightAuto: 'yes' }))
    expect(loadWorkspace()).toBeNull()
  })

  it('accepts a workspace saved before any of the new fields existed', () => {
    saveWorkspace(workspace)
    const loaded = loadWorkspace()
    expect(loaded).not.toBeNull()
    expect(loaded?.simMode).toBeUndefined()
    expect(loaded?.bankroll).toBeUndefined()
    expect(loaded?.chartHeightAuto).toBeUndefined()
  })

  it('round-trips both y-zoom factors and rejects a non-numeric one', () => {
    saveWorkspace({ ...workspace, simChartYZoom: 0.5, bankrollChartYZoom: 2 })
    const loaded = loadWorkspace()
    expect(loaded?.simChartYZoom).toBe(0.5)
    expect(loaded?.bankrollChartYZoom).toBe(2)

    store.set(STORAGE_KEY, JSON.stringify({ ...workspace, simChartYZoom: 'wide' }))
    expect(loadWorkspace()).toBeNull()
  })

  it('accepts a workspace saved before the y-zoom factors existed', () => {
    saveWorkspace(workspace)
    const loaded = loadWorkspace()
    expect(loaded?.simChartYZoom).toBeUndefined()
    expect(loaded?.bankrollChartYZoom).toBeUndefined()
  })

  it('round-trips forceStack and rejects a non-boolean', () => {
    saveWorkspace({ ...workspace, chart: { ...DEFAULT_CHART, forceStack: true } })
    expect(loadWorkspace()?.chart.forceStack).toBe(true)

    store.set(
      STORAGE_KEY,
      JSON.stringify({ ...workspace, chart: { ...DEFAULT_CHART, forceStack: 'yes' } }),
    )
    expect(loadWorkspace()).toBeNull()
  })

  it('accepts a workspace saved before forceStack existed', () => {
    const chart: Record<string, unknown> = { ...DEFAULT_CHART }
    delete chart.forceStack
    store.set(STORAGE_KEY, JSON.stringify({ ...workspace, chart }))
    expect(loadWorkspace()).not.toBeNull()
  })
})
