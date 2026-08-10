import { dirname, resolve } from 'node:path'

export type SavePath = { ok: true; path: string } | { ok: false; error: string }

/**
 * The dev server must never be talked into writing outside the one directory
 * the CLI nominated. Four checks, deliberately overlapping: the last one is a
 * backstop that holds even if a separator slips past the others.
 *
 * A colon is rejected alongside the separator check for the same reason: on
 * Windows it is not just a drive-letter delimiter (`C:out.tsv` is a
 * drive-relative path with no directory separator in it at all) but also the
 * NTFS alternate-data-stream delimiter (`name.tsv:stream.tsv` writes into a
 * hidden stream of `name.tsv`, silently creating a 0-byte `name.tsv` as a
 * side effect). Either way a colon lets the write escape "one plain file in
 * the nominated directory". C0 control characters, including NUL, are
 * rejected outright rather than trusted to fail safe downstream in whatever
 * happens to call this validator next.
 */
export function resolveSavePath(dir: string, filename: string): SavePath {
  const name = filename.trim()

  if (name === '') return { ok: false, error: 'Filename is empty.' }
  if (name.includes('/') || name.includes('\\')) {
    return { ok: false, error: 'Filename must not contain a path separator.' }
  }
  if (name.includes(':')) {
    return { ok: false, error: 'Filename must not contain a colon.' }
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(name)) {
    return { ok: false, error: 'Filename must not contain a control character.' }
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
