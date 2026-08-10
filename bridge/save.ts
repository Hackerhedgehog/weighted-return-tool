import { dirname, resolve } from 'node:path'

export type SavePath = { ok: true; path: string } | { ok: false; error: string }

/**
 * The dev server must never be talked into writing outside the one directory
 * the CLI nominated. Four checks, deliberately overlapping: the last one is a
 * backstop that holds even if a separator slips past the others.
 */
export function resolveSavePath(dir: string, filename: string): SavePath {
  const name = filename.trim()

  if (name === '') return { ok: false, error: 'Filename is empty.' }
  if (name.includes('/') || name.includes('\\')) {
    return { ok: false, error: 'Filename must not contain a path separator.' }
  }
  if (name === '.' || name === '..') {
    return { ok: false, error: 'Filename must not be a directory reference.' }
  }
  if (!name.toLowerCase().endsWith('.tsv')) {
    return { ok: false, error: 'Filename must end with .tsv' }
  }

  const target = resolve(dir, name)
  if (dirname(target) !== resolve(dir)) {
    return { ok: false, error: 'Filename must resolve inside the bridge directory.' }
  }

  return { ok: true, path: target }
}
