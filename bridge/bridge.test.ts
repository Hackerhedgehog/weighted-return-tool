import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { bridgeConfigFromEnv } from './config'
import { resolveSavePath } from './save'

const DIR = resolve('/tmp', 'scenarios')

describe('bridgeConfigFromEnv', () => {
  it('is null when nothing is set', () => {
    expect(bridgeConfigFromEnv({})).toBeNull()
  })

  it('is null when the directory is missing', () => {
    expect(bridgeConfigFromEnv({ WRT_BRIDGE_FILE: '/a/set-values-regular.tsv' })).toBeNull()
  })

  it('is null when the file is missing', () => {
    expect(bridgeConfigFromEnv({ WRT_BRIDGE_DIR: '/a' })).toBeNull()
  })

  it('is null for empty strings', () => {
    expect(bridgeConfigFromEnv({ WRT_BRIDGE_DIR: '', WRT_BRIDGE_FILE: '' })).toBeNull()
  })

  it('reads a full environment', () => {
    expect(
      bridgeConfigFromEnv({
        WRT_BRIDGE_DIR: '/a/scenarios',
        WRT_BRIDGE_FILE: '/a/scenarios/set-values-regular.tsv',
        WRT_BRIDGE_EXPORT_NAME: 'ref-weights-regular.tsv',
        WRT_BRIDGE_GAME: 'joker-stacks-magic',
      }),
    ).toEqual({
      dir: '/a/scenarios',
      file: '/a/scenarios/set-values-regular.tsv',
      exportName: 'ref-weights-regular.tsv',
      game: 'joker-stacks-magic',
    })
  })

  it('falls back to a default export name', () => {
    const cfg = bridgeConfigFromEnv({ WRT_BRIDGE_DIR: '/a', WRT_BRIDGE_FILE: '/a/x.tsv' })
    expect(cfg?.exportName).toBe('ref-weights-regular.tsv')
  })
})

describe('resolveSavePath', () => {
  it('accepts a plain tsv name', () => {
    expect(resolveSavePath(DIR, 'ref-weights-regular.tsv')).toEqual({
      ok: true,
      path: resolve(DIR, 'ref-weights-regular.tsv'),
    })
  })

  it('trims surrounding whitespace', () => {
    expect(resolveSavePath(DIR, '  ref-weights-regular.tsv  ')).toEqual({
      ok: true,
      path: resolve(DIR, 'ref-weights-regular.tsv'),
    })
  })

  it('accepts an uppercase extension', () => {
    expect(resolveSavePath(DIR, 'OUT.TSV').ok).toBe(true)
  })

  it('rejects an empty name', () => {
    expect(resolveSavePath(DIR, '   ')).toEqual({ ok: false, error: expect.stringMatching(/empty/i) })
  })

  it('rejects a missing .tsv extension', () => {
    expect(resolveSavePath(DIR, 'weights.csv').ok).toBe(false)
    expect(resolveSavePath(DIR, 'weights').ok).toBe(false)
  })

  it('rejects a forward-slash separator', () => {
    expect(resolveSavePath(DIR, 'sub/out.tsv')).toEqual({
      ok: false,
      error: expect.stringMatching(/separator/i),
    })
  })

  it('rejects a backslash separator', () => {
    expect(resolveSavePath(DIR, 'sub\\out.tsv')).toEqual({
      ok: false,
      error: expect.stringMatching(/separator/i),
    })
  })

  it('rejects traversal', () => {
    expect(resolveSavePath(DIR, '../out.tsv').ok).toBe(false)
    expect(resolveSavePath(DIR, '..\\out.tsv').ok).toBe(false)
  })

  it('rejects directory references', () => {
    expect(resolveSavePath(DIR, '.').ok).toBe(false)
    expect(resolveSavePath(DIR, '..').ok).toBe(false)
  })

  it('rejects an absolute path', () => {
    expect(resolveSavePath(DIR, '/etc/passwd.tsv').ok).toBe(false)
    expect(resolveSavePath(DIR, 'C:\\windows\\evil.tsv').ok).toBe(false)
  })

  it('never resolves outside the bridge directory', () => {
    for (const name of ['../out.tsv', '..\\out.tsv', 'a/../../out.tsv', '/x/out.tsv']) {
      const r = resolveSavePath(DIR, name)
      if (r.ok) throw new Error(`${name} should not have been accepted`)
    }
  })
})
