import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { BridgeConfig } from './config.ts'
import { resolveSavePath } from './save.ts'

export interface JsonResult {
  status: number
  body: unknown
}

/**
 * Read the source fresh on every request rather than caching it at startup —
 * a re-run of the generator should be one browser refresh away.
 */
export function sessionResult(cfg: BridgeConfig): JsonResult {
  try {
    return {
      status: 200,
      body: {
        dir: cfg.dir,
        sourceFile: basename(cfg.file),
        filename: cfg.exportName,
        game: cfg.game,
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
