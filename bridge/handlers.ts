import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { BridgeConfig, BridgeSession, FeedRef } from './config.ts'
import { resolveSavePath } from './save.ts'

export interface JsonResult {
  status: number
  body: unknown
}

/**
 * Read the sources fresh on every request rather than caching them at startup
 * — a re-run of the generator should be one browser refresh away.
 *
 * The flat fields mirror `feeds[0]` for clients built before batches existed;
 * the `feeds` array is the whole story. One unreadable file fails the whole
 * payload: a batch that silently arrived short would read as "the tool lost
 * my file".
 */
export function sessionResult(cfg: BridgeSession): JsonResult {
  let current = cfg.file
  try {
    const feeds = cfg.feeds.map((f) => {
      current = f.file
      return {
        sourceFile: basename(f.file),
        filename: f.exportName,
        game: f.game,
        tsv: readFileSync(f.file, 'utf8'),
      }
    })
    return {
      status: 200,
      body: {
        dir: cfg.dir,
        sourceFile: feeds[0].sourceFile,
        filename: feeds[0].filename,
        game: feeds[0].game,
        sessionId: cfg.sessionId,
        seq: cfg.seq,
        openAs: cfg.openAs,
        tsv: feeds[0].tsv,
        feeds,
      },
    }
  } catch (err) {
    return {
      status: 500,
      body: { error: `Could not read ${current}: ${(err as Error).message}` },
    }
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

interface FileEntry {
  file?: unknown
  exportName?: unknown
  game?: unknown
}

/**
 * One file of a switch body, validated into a FeedRef. `where` names the
 * entry in refusals so a bad file in a batch is findable; null keeps the
 * single-file wording batches replaced.
 */
function validateFeed(
  dir: string,
  entry: FileEntry,
  fallbackGame: string,
  where: string | null,
): { ok: true; feed: FeedRef } | { ok: false; error: string } {
  const label = (msg: string) => (where === null ? msg : `${where}: ${msg}`)

  if (typeof entry.file !== 'string' || entry.file === '') {
    return { ok: false, error: label('file must be a non-empty string.') }
  }
  if (entry.exportName !== undefined && typeof entry.exportName !== 'string') {
    return { ok: false, error: label('exportName must be a string.') }
  }
  if (entry.game !== undefined && typeof entry.game !== 'string') {
    return { ok: false, error: label('game must be a string.') }
  }

  if (!existsSync(entry.file) || !statSync(entry.file).isFile()) {
    return { ok: false, error: `Not a file: ${entry.file}` }
  }
  if (!entry.file.toLowerCase().endsWith('.tsv')) {
    return { ok: false, error: label('file must be a .tsv') }
  }

  const exportName =
    entry.exportName === undefined || entry.exportName === ''
      ? FALLBACK_EXPORT_NAME
      : entry.exportName
  const save = resolveSavePath(dir, exportName)
  if (!save.ok) return { ok: false, error: save.error }

  return { ok: true, feed: { file: entry.file, exportName, game: entry.game ?? fallbackGame } }
}

/**
 * Re-points the session at another file — or a batch of files, each destined
 * for its own tab — so a running tool can be fed the next bet mode, every bet
 * mode at once, or another game entirely without restarting the dev server.
 *
 * Everything is validated here rather than trusted from the caller: the CLI is
 * the only intended client, but this is an open port on the dev machine.
 * `resolveSavePath` is reused for the export names so a switch can never widen
 * what a later save is allowed to write. A batch is accepted whole or not at
 * all — a partial feed would read as the tool losing files.
 *
 * The current session comes in so the feed identity can carry across: the id
 * names the dev-server run and survives every switch — the bumped seq is what
 * marks the feed as new, and one batch is one bump. Every refusal returns no
 * next session, so a refused switch can never bump the seq or change how the
 * tab opens.
 */
export function switchResult(
  session: BridgeSession,
  body: unknown,
): { result: JsonResult; next: BridgeSession | null } {
  const bad = (error: string) => ({ result: { status: 400, body: { error } }, next: null })
  const b = body as {
    dir?: unknown
    file?: unknown
    files?: unknown
    exportName?: unknown
    game?: unknown
    openAs?: unknown
  } | null

  if (b === null || typeof b !== 'object') return bad('Body must be a JSON object.')
  if (typeof b.dir !== 'string' || b.dir === '') return bad('dir must be a non-empty string.')
  if (b.game !== undefined && typeof b.game !== 'string') return bad('game must be a string.')
  if (b.openAs !== undefined && b.openAs !== 'overwrite' && b.openAs !== 'new-tab') {
    return bad("openAs must be 'overwrite' or 'new-tab'.")
  }
  if (!existsSync(b.dir) || !statSync(b.dir).isDirectory()) return bad(`Not a directory: ${b.dir}`)

  const fallbackGame = b.game ?? ''

  let entries: { entry: FileEntry; where: string | null }[]
  if (b.files !== undefined) {
    if (!Array.isArray(b.files) || b.files.length === 0) {
      return bad('files must be a non-empty array.')
    }
    const nonObject = b.files.findIndex((f) => f === null || typeof f !== 'object')
    if (nonObject !== -1) return bad(`files[${nonObject}] must be an object.`)
    entries = (b.files as FileEntry[]).map((entry, i) => ({ entry, where: `files[${i}]` }))
  } else {
    entries = [{ entry: { file: b.file, exportName: b.exportName, game: b.game }, where: null }]
  }

  const feeds: FeedRef[] = []
  for (const { entry, where } of entries) {
    const checked = validateFeed(b.dir, entry, fallbackGame, where)
    if (!checked.ok) return bad(checked.error)
    feeds.push(checked.feed)
  }

  const next: BridgeSession = {
    dir: b.dir,
    file: feeds[0].file,
    exportName: feeds[0].exportName,
    game: feeds[0].game,
    sessionId: session.sessionId,
    seq: session.seq + 1,
    openAs: b.openAs ?? 'overwrite',
    feeds,
  }
  return {
    result: {
      status: 200,
      body: { ok: true, dir: next.dir, file: next.file, files: feeds.map((f) => f.file) },
    },
    next,
  }
}
