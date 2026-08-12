/** How the latest feed asked to be applied to a running tool. */
export type BridgeOpenAs = 'overwrite' | 'new-tab'

export interface BridgeSession {
  /** Directory the data came from — also the only place a save can land. */
  dir: string
  sourceFile: string
  /** Default export filename, derived by the CLI from the source file. */
  filename: string
  game: string
  tsv: string
  /**
   * Identifies one dev-server run, so a page reload can tell "the CLI fed a
   * new file" from "the same session, already applied". A fresh id means a
   * fresh CLI launch, whatever the seq says.
   */
  sessionId: string
  /** Bumped on every accepted /__bridge/switch; 1 for the launch feed. */
  seq: number
  openAs: BridgeOpenAs
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

    return {
      ...(data as BridgeSession),
      // Defaulted rather than required: a bridge built before feeds carried
      // identity still yields a working session — it just reads as one fresh
      // launch, which is exactly what it is.
      sessionId: typeof data.sessionId === 'string' ? data.sessionId : '',
      seq: typeof data.seq === 'number' && Number.isFinite(data.seq) ? data.seq : 1,
      openAs: data.openAs === 'new-tab' ? 'new-tab' : 'overwrite',
    }
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
