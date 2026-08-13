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
  /**
   * The group's total weight is held where it is: Auto-Distribute pins the
   * members' combined mass, and a member's weight edit rebalances the other
   * unlocked members instead of moving the total. Unlike locking every row,
   * the weights *inside* the group stay editable — fix "bonus triggers 10% of
   * the time", then play with the individual bonus buckets. One state with
   * `prefChance` (see groupTargets.ts's isSoftLocked): the Σ toggle records
   * the chance it pinned, and typing a chance sets the toggle. Optional —
   * absent in workspaces saved before group demands existed.
   */
  totalLocked?: boolean
  /**
   * Pinned share of total weight (fraction). A hard rule: Auto-Distribute
   * meets it to 0.0001%, reporting even the weight step's rounding. Setting it
   * is the same act as soft-locking the group; clearing it releases Σ.
   */
  prefChance?: number
  /**
   * Preferred weighted value — the group's RTP contribution as a fraction of
   * bet. A soft rule: Auto-Distribute tilts the group's members toward it and
   * warns when it cannot land within 0.001.
   */
  prefRtp?: number
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

/**
 * The solver's over-constrained dimensions, ranked by the user. When two
 * cannot both hold, the one ranked lower yields — see distribute.ts's header
 * for what "yielding" means per dimension. Row locks are not listed: they are
 * absolute and outrank everything by design.
 */
export type PriorityKey = 'rtp' | 'ordering' | 'volatility' | 'hit' | 'win'

/** The solver's long-standing fixed ranking, now merely the default. */
export const DEFAULT_PRIORITY: PriorityKey[] = ['rtp', 'ordering', 'volatility', 'hit', 'win']

export const PRIORITY_LABELS: Record<PriorityKey, string> = {
  rtp: 'Target RTP',
  ordering: 'Ordering / weighted value',
  volatility: 'Volatility curve',
  hit: 'Pref hit chance',
  win: 'Pref win chance',
}

/**
 * A priority list from storage or an older workspace, made safe to rank by:
 * unknown keys dropped, duplicates collapsed, missing keys appended in default
 * order. Total by construction, so `indexOf` on the result never misses.
 */
export function normalizePriority(p: readonly string[] | undefined): PriorityKey[] {
  const seen = new Set<PriorityKey>()
  const out: PriorityKey[] = []
  for (const k of p ?? []) {
    if ((DEFAULT_PRIORITY as string[]).includes(k) && !seen.has(k as PriorityKey)) {
      seen.add(k as PriorityKey)
      out.push(k as PriorityKey)
    }
  }
  for (const k of DEFAULT_PRIORITY) if (!seen.has(k)) out.push(k)
  return out
}

export interface Targets {
  /** Hard target. Fraction, so 0.95 means 95%. */
  rtp: number
  /**
   * Preferred, satisfied within `tolerance`. Fraction of total weight — the
   * targets panel edits it in percent, converting at the input boundary only,
   * so saved workspaces and the solver always see the fraction.
   */
  hitChance: number
  /** Preferred, satisfied within `tolerance`. Buckets with payout > 1; a fraction like `hitChance`. */
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
  /** Conflict-resolution ranking. Optional — absent in older workspaces, meaning the default. */
  priority?: PriorityKey[]
}

export const DEFAULT_TARGETS: Targets = {
  rtp: 0.95,
  hitChance: 0.3,
  winChance: 0.12,
  tolerance: 3.5,
  useChances: true,
  useVolatility: true,
  priority: DEFAULT_PRIORITY,
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
  /**
   * Forces the distribution chart onto its own line below the buckets table,
   * even when the viewport is wide enough to fit both side by side.
   */
  forceStack: boolean
  /**
   * Puts the distribution chart on the left and the buckets table on the
   * right (default: table left, chart right). The table's column alignment
   * follows — see `.content-row.swapped .grid-table` in index.css.
   */
  swapped: boolean
}

export const DEFAULT_CHART: ChartSettings = {
  metric: 'weights',
  logY: true,
  logX: false,
  aggregate: true,
  relative: true,
  groupBars: [],
  forceStack: false,
  swapped: false,
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
