/** One payout bucket. `payout` is a float — engine data carries 50.16, 0.33. */
export interface BucketRow {
  uid: string
  bucketId: number
  payout: number
  label: string
  weight: number
  /** Locked rows keep their weight through Auto-Distribute and rescaling. */
  locked: boolean
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

export interface Targets {
  /** Hard target. Fraction, so 0.95 means 95%. */
  rtp: number
  /** Preferred, satisfied within `tolerance`. Fraction of total weight. */
  hitChance: number
  /** Preferred, satisfied within `tolerance`. Buckets with payout > 1. */
  winChance: number
  /** Relative tolerance on the two chances, in percent. */
  tolerance: number
}

export const DEFAULT_TARGETS: Targets = {
  rtp: 0.95,
  hitChance: 0.3,
  winChance: 0.12,
  tolerance: 3.5,
}

export type ColumnKey =
  | 'lock'
  | 'id'
  | 'payout'
  | 'label'
  | 'weight'
  | 'weightedValue'
  | 'chance'

export type RowPatch = Partial<
  Pick<BucketRow, 'bucketId' | 'payout' | 'label' | 'weight' | 'locked'>
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
}

export const DEFAULT_CHART: ChartSettings = {
  metric: 'weights',
  logY: true,
  logX: false,
  aggregate: true,
}

export const DEFAULT_EXPORT_FILENAME = 'ref-weights-regular.tsv'

let uidCounter = 0

export function nextUid(): string {
  uidCounter += 1
  return `b${uidCounter}`
}
