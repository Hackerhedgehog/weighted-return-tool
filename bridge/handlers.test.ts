import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { sessionResult, saveResult } from './handlers'
import type { BridgeSession } from './config'

const made: string[] = []
function tempCfg(): BridgeSession {
  const dir = mkdtempSync(resolve(tmpdir(), 'bridge-'))
  made.push(dir)
  const file = resolve(dir, 'set-values-regular.tsv')
  writeFileSync(file, '0\t1000.00\tjoker5-maxwin\n', 'utf8')
  return {
    dir,
    file,
    exportName: 'ref-weights-regular.tsv',
    game: 'joker-stacks-magic',
    sessionId: 'cafe0123deadbeef',
    seq: 1,
    openAs: 'overwrite',
  }
}

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('sessionResult', () => {
  it('serves the source file, its metadata and the feed identity', () => {
    const cfg = tempCfg()
    const r = sessionResult(cfg)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({
      dir: cfg.dir,
      sourceFile: 'set-values-regular.tsv',
      filename: 'ref-weights-regular.tsv',
      game: 'joker-stacks-magic',
      sessionId: 'cafe0123deadbeef',
      seq: 1,
      openAs: 'overwrite',
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

import { mkdirSync } from 'node:fs'
import { switchResult } from './handlers'

describe('switchResult', () => {
  it('accepts a real tsv in a real directory', () => {
    const cfg = tempCfg()
    const { result, next } = switchResult(cfg, {
      dir: cfg.dir,
      file: cfg.file,
      exportName: 'ref-weights-buy-bonus.tsv',
      game: 'imperial-express',
    })
    expect(result.status).toBe(200)
    expect(next).toEqual({
      dir: cfg.dir,
      file: cfg.file,
      exportName: 'ref-weights-buy-bonus.tsv',
      game: 'imperial-express',
      sessionId: 'cafe0123deadbeef',
      seq: 2,
      openAs: 'overwrite',
    })
  })

  it('defaults the export name and the game', () => {
    const cfg = tempCfg()
    const { next } = switchResult(cfg, { dir: cfg.dir, file: cfg.file })
    expect(next?.exportName).toBe('ref-weights-regular.tsv')
    expect(next?.game).toBe('')
  })

  it('keeps the run id and bumps the seq on every acceptance', () => {
    const cfg = tempCfg()
    const first = switchResult(cfg, { dir: cfg.dir, file: cfg.file }).next
    const second = switchResult(first!, { dir: cfg.dir, file: cfg.file }).next
    expect(first?.sessionId).toBe(cfg.sessionId)
    expect(second?.sessionId).toBe(cfg.sessionId)
    expect(first?.seq).toBe(2)
    expect(second?.seq).toBe(3)
  })

  it('applies the requested openAs, and a later switch without one falls back to overwrite', () => {
    const cfg = tempCfg()
    const tab = switchResult(cfg, { dir: cfg.dir, file: cfg.file, openAs: 'new-tab' }).next
    expect(tab?.openAs).toBe('new-tab')
    // Absent means overwrite even when the previous feed opened a tab — the
    // choice belongs to each feed, it does not linger from the last one.
    expect(switchResult(tab!, { dir: cfg.dir, file: cfg.file }).next?.openAs).toBe('overwrite')
  })

  it("rejects an openAs that is neither 'overwrite' nor 'new-tab'", () => {
    const cfg = tempCfg()
    for (const openAs of ['both', '', 'NEW-TAB', true, 1]) {
      const { result, next } = switchResult(cfg, { dir: cfg.dir, file: cfg.file, openAs })
      expect(result.status).toBe(400)
      expect(result.body).toEqual({ error: "openAs must be 'overwrite' or 'new-tab'." })
      expect(next).toBeNull()
    }
  })

  it('rejects a body that is not an object', () => {
    const cfg = tempCfg()
    expect(switchResult(cfg, 'nope').result.status).toBe(400)
    expect(switchResult(cfg, null).result.status).toBe(400)
  })

  it('rejects a file that does not exist — and a refusal never bumps the seq', () => {
    const cfg = tempCfg()
    const { result, next } = switchResult(cfg, { dir: cfg.dir, file: resolve(cfg.dir, 'gone.tsv') })
    expect(result.status).toBe(400)
    // Null is the whole guarantee: the caller keeps its current session, so
    // seq and openAs cannot move on a refused switch.
    expect(next).toBeNull()
  })

  it('rejects a file that is not a tsv', () => {
    const cfg = tempCfg()
    const csv = resolve(cfg.dir, 'ScenarioSet0.csv')
    writeFileSync(csv, 'x', 'utf8')
    expect(switchResult(cfg, { dir: cfg.dir, file: csv }).result.status).toBe(400)
  })

  it('rejects a directory that is not a directory', () => {
    const cfg = tempCfg()
    expect(switchResult(cfg, { dir: cfg.file, file: cfg.file }).result.status).toBe(400)
  })

  it('rejects an export name that could escape the directory', () => {
    const cfg = tempCfg()
    const sub = resolve(cfg.dir, 'sub')
    mkdirSync(sub)
    expect(
      switchResult(cfg, { dir: cfg.dir, file: cfg.file, exportName: '../out.tsv' }).result.status,
    ).toBe(400)
  })
})
