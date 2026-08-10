/** One payout bucket. `payout` is a float — engine data carries 50.16, 0.33. */
export interface BucketRow {
  uid: string
  bucketId: number
  payout: number
  label: string
  weight: number
  /** Locked rows keep their weight through Auto-Distribute and rescaling. */
  locked: boolean
  /**
   * Which group this bucket belongs to. Seeded once from the label heuristics
   * at import and then owned by the user — never re-derived, so a hand-made
   * assignment sticks.
   */
  groupId: string
  /**
   * A free-text id the tool never interprets. Exported only when at least one
   * row carries one, so tables that do not use it keep their exact old shape.
   */
  weightId: string
}

/** A user-editable bucket group: a name and one of the palette colors. */
export interface GroupDef {
  id: string
  name: string
  /** 6-digit hex from `PASTEL_COLORS`. */
  color: string
}

/**
 * Volatility is the curvature `c` of the weight curve in log-log space:
 * `share ∝ exp(−γ·u − c·u²)` where `u = ln(payout) − ln(minPositivePayout)`.
 *
 * Local decay rate is `γ + 2c·u`, so `c` sets how fast the decay accelerates
 * up the payout ladder. `c = 0` is a pure power law — a straight line on a
 * log-log chart, big payouts stay relatively likely. Larger `c` bends the
 * curve down, crushing high payouts far harder than mid ones.
 *
 * These five values are a starting set: graded and well-behaved on real data,
 * but meant to be tuned. The curve field in the targets panel edits `c`
 * directly, which flips the preset to 'custom'.
 */
export type Volatility = 'very low' | 'low' | 'medium' | 'high' | 'very high' | 'custom'

export const VOLATILITY_STEPS: Exclude<Volatility, 'custom'>[] = [
  'very low',
  'low',
  'medium',
  'high',
  'very high',
]

export const CURVE_PRESETS: Record<Exclude<Volatility, 'custom'>, number> = {
  'very low': 0.32,
  low: 0.18,
  medium: 0.09,
  high: 0.035,
  'very high': 0,
}

/** Curve value → preset name, or 'custom' when it matches none. */
export function volatilityForCurve(curve: number): Volatility {
  for (const step of VOLATILITY_STEPS) {
    if (Math.abs(CURVE_PRESETS[step] - curve) < 1e-9) return step
  }
  return 'custom'
}

/**
 * Granularity of tool-distributed weights: every weight the tool computes
 * lands on a multiple of the step. 1 is "free". Manually typed weight cells
 * are never snapped.
 */
export type WeightStep = 1 | 10 | 100

export const WEIGHT_STEPS: WeightStep[] = [1, 10, 100]
export const DEFAULT_WEIGHT_STEP: WeightStep = 1

export interface Targets {
  /** Hard target. Fraction, so 0.95 means 95%. */
  rtp: number
  /** Preferred, satisfied within `tolerance`. Fraction of total weight. */
  hitChance: number
  /** Preferred, satisfied within `tolerance`. Buckets with payout > 1. */
  winChance: number
  /** Relative tolerance on the two chances, in percent. */
  tolerance: number
  /**
   * Off: the solver stops steering hit and win chance (and their tolerance)
   * and spends everything on RTP. The fields keep showing what the table
   * currently achieves — they just stop being goals.
   */
  useChances: boolean
  /** Off: the tail shape is left as a pure power law, c = 0. */
  useVolatility: boolean
}

export const DEFAULT_TARGETS: Targets = {
  rtp: 0.95,
  hitChance: 0.3,
  winChance: 0.12,
  tolerance: 3.5,
  useChances: true,
  useVolatility: true,
}

export type ColumnKey =
  | 'lock'
  | 'group'
  | 'id'
  | 'weightId'
  | 'payout'
  | 'label'
  | 'weight'
  | 'weightedValue'
  | 'chance'

export type RowPatch = Partial<
  Pick<BucketRow, 'bucketId' | 'payout' | 'label' | 'weight' | 'locked' | 'groupId' | 'weightId'>
>

export type SortKey = Exclude<ColumnKey, 'lock'>

export interface SortState {
  key: SortKey
  dir: 1 | -1
}

export interface ChartSettings {
  metric: 'weights' | 'chance'
  logY: boolean
  logX: boolean
  aggregate: boolean
  /**
   * Weights-mode drag behaviour: on, the grand total is preserved and other
   * buckets compensate; off, only the dragged bar moves. Chance-mode drags
   * are always relative — chances must sum to 1.
   */
  relative: boolean
  /**
   * Group ids drawn as a single aggregated bar instead of their buckets.
   * View state, so it is persisted but not undoable. Never mutated in place —
   * DEFAULT_CHART's empty array is shared by every fresh workspace.
   */
  groupBars: string[]
}

export const DEFAULT_CHART: ChartSettings = {
  metric: 'weights',
  logY: true,
  logX: false,
  aggregate: true,
  relative: true,
  groupBars: [],
}

export const DEFAULT_EXPORT_FILENAME = 'ref-weights-regular.tsv'

let uidCounter = 0

export function nextUid(): string {
  uidCounter += 1
  return `b${uidCounter}`
}

/** Which question the simulation panel is answering. */
export type SimMode = 'convergence' | 'bankroll'

export const DEFAULT_SIM_MODE: SimMode = 'convergence'

/** A bankroll run's inputs. Persisted with the workspace, like Targets. */
export interface BankrollConfig {
  /** Starting balance, in credits. */
  credits: number
  /** Stake per spin, in credits. */
  bet: number
  /** Every payout is multiplied by this before the alias table is built. */
  rtpMultiplier: number
}

export const DEFAULT_BANKROLL: BankrollConfig = {
  credits: 1_000_000,
  bet: 1,
  rtpMultiplier: 1,
}
