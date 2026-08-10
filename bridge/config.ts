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
