import { randomBytes } from 'node:crypto'

export interface BridgeConfig {
  /** Directory the set-values file came from, and the only place saves may land. */
  dir: string
  /** Absolute path of the set-values file to serve. */
  file: string
  /** Default filename the tool exports under. */
  exportName: string
  /** Game directory name, shown in the tool's UI. */
  game: string
}

/** How the latest feed asked to be applied: replace the current tab or open a new one. */
export type OpenAs = 'overwrite' | 'new-tab'

/**
 * The config plus the feed's identity. The identity is what lets a page
 * reload tell "the CLI just fed a new file" from "same session, already
 * applied": the id names one dev-server run, the seq counts accepted feeds
 * within it, and openAs says how the latest one wanted to land.
 */
export interface BridgeSession extends BridgeConfig {
  /** Random hex, minted once per dev-server run — a new id means a fresh CLI launch. */
  sessionId: string
  /** 1 for the env-var launch feed, +1 on every accepted /__bridge/switch. */
  seq: number
  /** From the latest accepted switch; the launch feed always overwrites. */
  openAs: OpenAs
}

/**
 * Seeds the session for one dev-server run. The id is random rather than a
 * timestamp so two runs started in the same instant can never read as the
 * same run, and it is minted here — once — so every request the run answers
 * carries the same one.
 */
export function initialSession(cfg: BridgeConfig): BridgeSession {
  return { ...cfg, sessionId: randomBytes(8).toString('hex'), seq: 1, openAs: 'overwrite' }
}

/** Kept in sync with the tool's own DEFAULT_EXPORT_FILENAME. */
const FALLBACK_EXPORT_NAME = 'ref-weights-regular.tsv'

/**
 * Returns null unless the CLI nominated both a directory and a file. Null is
 * the normal case — it is what `npm run dev` sees, and it means no bridge
 * middleware is registered at all.
 */
export function bridgeConfigFromEnv(env: Record<string, string | undefined>): BridgeConfig | null {
  const dir = env.WRT_BRIDGE_DIR
  const file = env.WRT_BRIDGE_FILE
  if (dir === undefined || dir === '') return null
  if (file === undefined || file === '') return null

  return {
    dir,
    file,
    exportName:
      env.WRT_BRIDGE_EXPORT_NAME === undefined || env.WRT_BRIDGE_EXPORT_NAME === ''
        ? FALLBACK_EXPORT_NAME
        : env.WRT_BRIDGE_EXPORT_NAME,
    game: env.WRT_BRIDGE_GAME ?? '',
  }
}
