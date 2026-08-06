import { describe, it, expect, beforeEach } from 'vitest'
import { clearWorkspace, loadWorkspace, saveWorkspace, STORAGE_KEY, type Workspace } from './storage'
import { DEFAULT_CHART, DEFAULT_EXPORT_FILENAME, DEFAULT_TARGETS } from './types'

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
  rows: [{ uid: 'b1', bucketId: 0, payout: 50.16, label: 'bonus5', weight: 700, locked: true }],
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
})
