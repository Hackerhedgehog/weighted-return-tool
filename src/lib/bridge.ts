export interface BridgeSession {
  /** Directory the data came from — also the only place a save can land. */
  dir: string
  sourceFile: string
  /** Default export filename, derived by the CLI from the source file. */
  filename: string
  game: string
  tsv: string
}

export type SaveOutcome =
  | { kind: 'saved'; path: string }
  | { kind: 'exists'; filename: string }
  | { kind: 'error'; message: string }

const SESSION_URL = '/__bridge/session'
const SAVE_URL = '/__bridge/save'

/**
 * Null means "no bridge", and every failure mode collapses to it: a 404, the
 * SPA fallback serving HTML, a malformed payload, or no server at all. A tool
 * opened without the CLI must degrade in silence, not show an error.
 */
export async function fetchSession(): Promise<BridgeSession | null> {
  try {
    const res = await fetch(SESSION_URL)
    if (!res.ok) return null
    if (!(res.headers.get('content-type') ?? '').includes('application/json')) return null

    const data = (await res.json()) as Partial<BridgeSession>
    if (typeof data.tsv !== 'string' || typeof data.dir !== 'string') return null
    if (typeof data.filename !== 'string') return null

    return data as BridgeSession
  } catch {
    return null
  }
}

export async function saveTsv(
  filename: string,
  text: string,
  overwrite: boolean,
): Promise<SaveOutcome> {
  try {
    const res = await fetch(SAVE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename, text, overwrite }),
    })
    const data = (await res.json().catch(() => null)) as {
      path?: string
      error?: string
      filename?: string
    } | null

    if (res.status === 409) return { kind: 'exists', filename: data?.filename ?? filename }
    if (!res.ok) return { kind: 'error', message: data?.error ?? `Save failed (${res.status})` }
    return { kind: 'saved', path: data?.path ?? filename }
  } catch (err) {
    return { kind: 'error', message: (err as Error).message }
  }
}
