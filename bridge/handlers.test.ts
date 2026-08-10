import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { sessionResult, saveResult } from './handlers'
import type { BridgeConfig } from './config'

const made: string[] = []
function tempCfg(): BridgeConfig {
  const dir = mkdtempSync(resolve(tmpdir(), 'bridge-'))
  made.push(dir)
  const file = resolve(dir, 'set-values-regular.tsv')
  writeFileSync(file, '0\t1000.00\tjoker5-maxwin\n', 'utf8')
  return { dir, file, exportName: 'ref-weights-regular.tsv', game: 'joker-stacks-magic' }
}

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('sessionResult', () => {
  it('serves the source file and its metadata', () => {
    const cfg = tempCfg()
    const r = sessionResult(cfg)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({
      dir: cfg.dir,
      sourceFile: 'set-values-regular.tsv',
      filename: 'ref-weights-regular.tsv',
      game: 'joker-stacks-magic',
      tsv: '0\t1000.00\tjoker5-maxwin\n',
    })
  })

  it('500s when the source file is gone', () => {
    const cfg = tempCfg()
    rmSync(cfg.file)
    expect(sessionResult(cfg).status).toBe(500)
  })
})

describe('saveResult', () => {
  it('writes a new file', () => {
    const cfg = tempCfg()
    const r = saveResult(cfg, { filename: 'ref-weights-regular.tsv', text: 'hello' })
    expect(r.status).toBe(200)
    expect(readFileSync(resolve(cfg.dir, 'ref-weights-regular.tsv'), 'utf8')).toBe('hello')
  })

  it('409s when the file exists and overwrite was not asked for', () => {
    const cfg = tempCfg()
    writeFileSync(resolve(cfg.dir, 'ref-weights-regular.tsv'), 'old', 'utf8')
    const r = saveResult(cfg, { filename: 'ref-weights-regular.tsv', text: 'new' })
    expect(r.status).toBe(409)
    expect(r.body).toEqual({ exists: true, filename: 'ref-weights-regular.tsv' })
    expect(readFileSync(resolve(cfg.dir, 'ref-weights-regular.tsv'), 'utf8')).toBe('old')
  })

  it('overwrites when asked', () => {
    const cfg = tempCfg()
    writeFileSync(resolve(cfg.dir, 'ref-weights-regular.tsv'), 'old', 'utf8')
    const r = saveResult(cfg, {
      filename: 'ref-weights-regular.tsv',
      text: 'new',
      overwrite: true,
    })
    expect(r.status).toBe(200)
    expect(readFileSync(resolve(cfg.dir, 'ref-weights-regular.tsv'), 'utf8')).toBe('new')
  })

  it('400s on a rejected filename', () => {
    const cfg = tempCfg()
    expect(saveResult(cfg, { filename: '../escape.tsv', text: 'x' }).status).toBe(400)
    expect(saveResult(cfg, { filename: 'no-extension', text: 'x' }).status).toBe(400)
  })

  it('400s on a malformed body', () => {
    const cfg = tempCfg()
    expect(saveResult(cfg, null).status).toBe(400)
    expect(saveResult(cfg, { filename: 'a.tsv' }).status).toBe(400)
    expect(saveResult(cfg, { filename: 5, text: 'x' }).status).toBe(400)
  })

  it('treats a non-true overwrite as false', () => {
    const cfg = tempCfg()
    writeFileSync(resolve(cfg.dir, 'ref-weights-regular.tsv'), 'old', 'utf8')
    expect(
      saveResult(cfg, { filename: 'ref-weights-regular.tsv', text: 'new', overwrite: 'yes' })
        .status,
    ).toBe(409)
  })
})
