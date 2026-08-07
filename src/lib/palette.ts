/**
 * The group color palette.
 *
 * Twenty pastels, picked to stay distinguishable side by side as chart bars
 * while being light enough to tint a table row without drowning the text. The
 * last two are deliberately neutral: they are the defaults for the 0x and
 * "other" groups, which are "everything that isn't a feature" and should stay
 * recessive so the real groups read first.
 *
 * Colors are stored on the group as literal hex rather than as a CSS variable
 * name, because groups are user-editable now — a custom group needs a color
 * that survives into the saved workspace without a stylesheet to resolve it.
 */

export const PASTEL_COLORS = [
  '#6aa9e0',
  '#f0906a',
  '#5fc4a0',
  '#e8c05a',
  '#e58bb0',
  '#8f83d6',
  '#6cc4d8',
  '#b3c96a',
  '#e8846a',
  '#7fb069',
  '#d79ae0',
  '#5cb8c4',
  '#eaa94f',
  '#8fa8e0',
  '#c98fb0',
  '#9ac47f',
  '#e0b06a',
  '#7ac0b0',
  '#c2c6cc',
  '#9aa5b1',
] as const

export const DEFAULT_GROUP_COLOR = PASTEL_COLORS[0]

/** True for a color this tool is willing to store — a 6-digit hex. */
export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)
}

/**
 * The low-alpha companion used for table row backgrounds. Derived rather than
 * stored, so a recolored group's tint can never drift out of step with it.
 */
export function withAlpha(hex: string, alpha: number): string {
  if (!isHexColor(hex)) return `rgba(154, 165, 177, ${alpha})`
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

/** Row tint strength — visible as a band, still readable under body text. */
export const TINT_ALPHA = 0.22

/**
 * Row tint strength when the row is locked: the same group hue, one step
 * deeper. A locked row used to take a single yellow, which overwrote the group
 * color and made a green-grouped bucket impossible to place at a glance — the
 * 🔒 glyph already says "locked", so the row only has to say "and still mine".
 */
export const LOCK_TINT_ALPHA = 0.44

/** Stand-in hue for a row whose group has no color, so lock still reads. */
const NEUTRAL_TINT = '#9aa5b1'

/** Background for a table row: its group's tint, deepened while locked. */
export function rowTint(color: string | undefined, locked: boolean): string | undefined {
  if (color === undefined) {
    return locked ? withAlpha(NEUTRAL_TINT, LOCK_TINT_ALPHA - TINT_ALPHA) : undefined
  }
  return withAlpha(color, locked ? LOCK_TINT_ALPHA : TINT_ALPHA)
}
