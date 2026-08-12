import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { BridgeConfig, BridgeSession } from './config.ts'
import { resolveSavePath } from './save.ts'

export interface JsonResult {
  status: number
  body: unknown
}

/**
 * Read the source fresh on every request rather than caching it at startup —
 * a re-run of the generator should be one browser refresh away.
 */
export function sessionResult(cfg: BridgeSession): JsonResult {
  try {
    return {
      status: 200,
      body: {
        dir: cfg.dir,
        sourceFile: basename(cfg.file),
        filename: cfg.exportName,
        game: cfg.game,
        sessionId: cfg.sessionId,
        seq: cfg.seq,
        openAs: cfg.openAs,
        tsv: readFileSync(cfg.file, 'utf8'),
      },
    }
  } catch (err) {
    return { status: 500, body: { error: `Could not read ${cfg.file}: ${(err as Error).message}` } }
  }
}

export function saveResult(cfg: BridgeConfig, body: unknown): JsonResult {
  const b = body as { filename?: unknown; text?: unknown; overwrite?: unknown } | null

  if (b === null || typeof b !== 'object') {
    return { status: 400, body: { error: 'Body must be a JSON object.' } }
  }
  if (typeof b.filename !== 'string') {
    return { status: 400, body: { error: 'filename must be a string.' } }
  }
  if (typeof b.text !== 'string') {
    return { status: 400, body: { error: 'text must be a string.' } }
  }

  const target = resolveSavePath(cfg.dir, b.filename)
  if (!target.ok) return { status: 400, body: { error: target.error } }

  // Anything other than a literal true is a refusal, so a truthy-but-wrong
  // value can never destroy a file.
  if (b.overwrite !== true && existsSync(target.path)) {
    return { status: 409, body: { exists: true, filename: b.filename.trim() } }
  }

  try {
    writeFileSync(target.path, b.text, 'utf8')
    console.log(`[bridge] wrote ${target.path}`)
    return { status: 200, body: { path: target.path } }
  } catch (err) {
    return { status: 500, body: { error: (err as Error).message } }
  }
}

const FALLBACK_EXPORT_NAME = 'ref-weights-regular.tsv'

/**
 * Re-points the session at another file, so a running tool can be fed the next
 * bet mode — or another game entirely — without restarting the dev server.
 *
 * Everything is validated here rather than trusted from the caller: the CLI is
 * the only intended client, but this is an open port on the dev machine.
 * `resolveSavePath` is reused for the export name so a switch can never widen
 * what a later save is allowed to write.
 *
 * The current session comes in so the feed identity can carry across: the id
 * names the dev-server run and survives every switch — the bumped seq is what
 * marks the feed as new. Every refusal returns no next session, so a refused
 * switch can never bump the seq or change how the tab opens.
 */
export function switchResult(
  session: BridgeSession,
  body: unknown,
): { result: JsonResult; next: BridgeSession | null } {
  const bad = (error: string) => ({ result: { status: 400, body: { error } }, next: null })
  const b = body as {
    dir?: unknown
    file?: unknown
    exportName?: unknown
    game?: unknown
    openAs?: unknown
  } | null

  if (b === null || typeof b !== 'object') return bad('Body must be a JSON object.')
  if (typeof b.dir !== 'string' || b.dir === '') return bad('dir must be a non-empty string.')
  if (typeof b.file !== 'string' || b.file === '') return bad('file must be a non-empty string.')
  if (b.exportName !== undefined && typeof b.exportName !== 'string') {
    return bad('exportName must be a string.')
  }
  if (b.game !== undefined && typeof b.game !== 'string') return bad('game must be a string.')
  if (b.openAs !== undefined && b.openAs !== 'overwrite' && b.openAs !== 'new-tab') {
    return bad("openAs must be 'overwrite' or 'new-tab'.")
  }

  if (!existsSync(b.dir) || !statSync(b.dir).isDirectory()) return bad(`Not a directory: ${b.dir}`)
  if (!existsSync(b.file) || !statSync(b.file).isFile()) return bad(`Not a file: ${b.file}`)
  if (!b.file.toLowerCase().endsWith('.tsv')) return bad('file must be a .tsv')

  const exportName = b.exportName === undefined || b.exportName === '' ? FALLBACK_EXPORT_NAME : b.exportName
  const save = resolveSavePath(b.dir, exportName)
  if (!save.ok) return bad(save.error)

  const next: BridgeSession = {
    dir: b.dir,
    file: b.file,
    exportName,
    game: b.game ?? '',
    sessionId: session.sessionId,
    seq: session.seq + 1,
    openAs: b.openAs ?? 'overwrite',
  }
  return { result: { status: 200, body: { ok: true, dir: next.dir, file: next.file } }, next }
}
