import type {
  BankrollConfig,
  BucketRow,
  ChartSettings,
  GroupDef,
  SimMode,
  Targets,
  Volatility,
  WeightStep,
} from './types'
import { isHexColor } from './palette'
import { isDockLayout, type DockLayout } from './layout'

/**
 * One autosaved workspace. The key carries the schema version, and the payload
 * repeats it, so a future format change simply fails validation and starts
 * clean rather than crashing on data it cannot read.
 */
export const STORAGE_KEY = 'weighted-return-tool:workspace:v1'

export interface Workspace {
  version: 1
  rows: BucketRow[]
  /** Optional — absent in workspaces saved before groups became data. */
  groups?: GroupDef[]
  targets: Targets
  volatility: Volatility
  curve: number
  columnWidths: Record<string, number>
  chart: ChartSettings
  exportFilename: string
  /** Optional — absent in workspaces saved before the simulation existed. */
  simSpins?: number
  /** Optional — absent in workspaces saved before the weight step existed. */
  weightStep?: WeightStep
  /** Optional — absent in workspaces saved before charts could be resized. */
  chartHeight?: number
  simChartHeight?: number
  /** Optional — absent in workspaces saved before the panel could collapse. */
  targetsCollapsed?: boolean
  /** Optional — absent in workspaces saved before bankroll mode existed. */
  simMode?: SimMode
  bankroll?: BankrollConfig
  /** Optional — absent before the chart could fit itself to the table. */
  chartHeightAuto?: boolean
  /** Optional — absent in workspaces saved before the y-axis could be zoomed. */
  simChartYZoom?: number
  bankrollChartYZoom?: number
  /** Optional — absent in workspaces saved before x-axis zoom/pan and y-pan existed. */
  simChartXZoom?: number
  simChartXPan?: number
  simChartYPan?: number
  bankrollChartXZoom?: number
  bankrollChartXPan?: number
  bankrollChartYPan?: number
  /** Optional — absent in workspaces saved before table groups could collapse. */
  tableCollapsed?: string[]
  /** Optional — absent in workspaces saved before the distribution chart could be zoomed/panned. */
  distChartXZoom?: number
  distChartXPan?: number
  distChartYZoom?: number
  distChartYPan?: number
  /** Optional — absent in workspaces saved before the group distribution panel existed. */
  groupDistCollapsed?: boolean
  bucketsCollapsed?: boolean
  hiddenGroupColumns?: string[]
  /** Optional — absent in workspaces saved before bucket columns could hide. */
  hiddenBucketColumns?: string[]
  /**
   * Optional — absent in workspaces saved before the dock existed, which
   * instead migrate the legacy chart.swapped / chart.forceStack flags.
   */
  layout?: DockLayout
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function isRow(v: unknown): v is BucketRow {
  return (
    isObject(v) &&
    typeof v.uid === 'string' &&
    isFiniteNumber(v.bucketId) &&
    isFiniteNumber(v.payout) &&
    typeof v.label === 'string' &&
    isFiniteNumber(v.weight) &&
    typeof v.locked === 'boolean' &&
    // Both optional on disk: a workspace saved before these existed is
    // migrated on load rather than thrown away.
    (v.groupId === undefined || typeof v.groupId === 'string') &&
    (v.weightId === undefined || typeof v.weightId === 'string')
  )
}

function isGroup(v: unknown): v is GroupDef {
  return (
    isObject(v) &&
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    isHexColor(v.color) &&
    // All optional on disk: a workspace saved before group demands existed
    // simply has no demands.
    (v.totalLocked === undefined || typeof v.totalLocked === 'boolean') &&
    (v.prefChance === undefined || isFiniteNumber(v.prefChance)) &&
    (v.prefRtp === undefined || isFiniteNumber(v.prefRtp))
  )
}

function isTargets(v: unknown): v is Targets {
  return (
    isObject(v) &&
    isFiniteNumber(v.rtp) &&
    isFiniteNumber(v.hitChance) &&
    isFiniteNumber(v.winChance) &&
    isFiniteNumber(v.tolerance) &&
    // Optional: absent before the solver priority became configurable. Only
    // the shape is checked — unknown keys are normalized away on use.
    (v.priority === undefined ||
      (Array.isArray(v.priority) && v.priority.every((s) => typeof s === 'string')))
  )
}

function isChart(v: unknown): v is ChartSettings {
  return (
    isObject(v) &&
    (v.metric === 'weights' || v.metric === 'chance') &&
    typeof v.logY === 'boolean' &&
    typeof v.logX === 'boolean' &&
    typeof v.aggregate === 'boolean' &&
    // Optional: absent in workspaces saved before groups could be collapsed.
    (v.groupBars === undefined ||
      (Array.isArray(v.groupBars) && v.groupBars.every((s) => typeof s === 'string'))) &&
    // Optional: absent in workspaces saved before the x-axis options existed.
    (v.xOrder === undefined || v.xOrder === 'payout' || v.xOrder === 'group') &&
    (v.xLabels === undefined || v.xLabels === 'payout' || v.xLabels === 'label') &&
    // Optional: absent in workspaces saved before the chart could be force-stacked.
    (v.forceStack === undefined || typeof v.forceStack === 'boolean') &&
    // Optional: absent in workspaces saved before the panels could be swapped.
    (v.swapped === undefined || typeof v.swapped === 'boolean')
  )
}

function isBankroll(v: unknown): v is BankrollConfig {
  return (
    isObject(v) &&
    isFiniteNumber(v.credits) &&
    isFiniteNumber(v.bet) &&
    isFiniteNumber(v.rtpMultiplier)
  )
}

function isWorkspace(v: unknown): v is Workspace {
  return (
    isObject(v) &&
    v.version === 1 &&
    Array.isArray(v.rows) &&
    v.rows.every(isRow) &&
    (v.groups === undefined || (Array.isArray(v.groups) && v.groups.every(isGroup))) &&
    isTargets(v.targets) &&
    typeof v.volatility === 'string' &&
    isFiniteNumber(v.curve) &&
    isObject(v.columnWidths) &&
    isChart(v.chart) &&
    typeof v.exportFilename === 'string' &&
    (v.simSpins === undefined || isFiniteNumber(v.simSpins)) &&
    (v.weightStep === undefined ||
      v.weightStep === 1 ||
      v.weightStep === 10 ||
      v.weightStep === 100) &&
    (v.chartHeight === undefined || isFiniteNumber(v.chartHeight)) &&
    (v.simChartHeight === undefined || isFiniteNumber(v.simChartHeight)) &&
    (v.targetsCollapsed === undefined || typeof v.targetsCollapsed === 'boolean') &&
    (v.simMode === undefined || v.simMode === 'convergence' || v.simMode === 'bankroll') &&
    (v.bankroll === undefined || isBankroll(v.bankroll)) &&
    (v.chartHeightAuto === undefined || typeof v.chartHeightAuto === 'boolean') &&
    (v.simChartYZoom === undefined || isFiniteNumber(v.simChartYZoom)) &&
    (v.bankrollChartYZoom === undefined || isFiniteNumber(v.bankrollChartYZoom)) &&
    (v.simChartXZoom === undefined || isFiniteNumber(v.simChartXZoom)) &&
    (v.simChartXPan === undefined || isFiniteNumber(v.simChartXPan)) &&
    (v.simChartYPan === undefined || isFiniteNumber(v.simChartYPan)) &&
    (v.bankrollChartXZoom === undefined || isFiniteNumber(v.bankrollChartXZoom)) &&
    (v.bankrollChartXPan === undefined || isFiniteNumber(v.bankrollChartXPan)) &&
    (v.bankrollChartYPan === undefined || isFiniteNumber(v.bankrollChartYPan)) &&
    (v.tableCollapsed === undefined ||
      (Array.isArray(v.tableCollapsed) && v.tableCollapsed.every((s) => typeof s === 'string'))) &&
    (v.distChartXZoom === undefined || isFiniteNumber(v.distChartXZoom)) &&
    (v.distChartXPan === undefined || isFiniteNumber(v.distChartXPan)) &&
    (v.distChartYZoom === undefined || isFiniteNumber(v.distChartYZoom)) &&
    (v.distChartYPan === undefined || isFiniteNumber(v.distChartYPan)) &&
    (v.groupDistCollapsed === undefined || typeof v.groupDistCollapsed === 'boolean') &&
    (v.bucketsCollapsed === undefined || typeof v.bucketsCollapsed === 'boolean') &&
    (v.hiddenGroupColumns === undefined ||
      (Array.isArray(v.hiddenGroupColumns) &&
        v.hiddenGroupColumns.every((s) => typeof s === 'string'))) &&
    (v.hiddenBucketColumns === undefined ||
      (Array.isArray(v.hiddenBucketColumns) &&
        v.hiddenBucketColumns.every((s) => typeof s === 'string'))) &&
    (v.layout === undefined || isDockLayout(v.layout))
  )
}

/**
 * The multi-tab record. One entry per tab, each carrying a full Workspace (or
 * null for a tab that has not held data yet), plus which tab is active and
 * the identity of the last bridge feed already applied — so a page reload can
 * tell a fresh feed from one it has already loaded, instead of clobbering
 * in-progress tuning on every refresh.
 */
export const TABS_KEY = 'weighted-return-tool:tabs:v1'

export interface TabRecord {
  id: string
  name: string
  workspace: Workspace | null
}

export interface TabsState {
  version: 1
  active: string
  tabs: TabRecord[]
  lastBridge?: { sessionId: string; seq: number }
}

function isTab(v: unknown): v is TabRecord {
  return (
    isObject(v) &&
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    (v.workspace === null || isWorkspace(v.workspace))
  )
}

function isTabsState(v: unknown): v is TabsState {
  return (
    isObject(v) &&
    v.version === 1 &&
    typeof v.active === 'string' &&
    Array.isArray(v.tabs) &&
    v.tabs.length > 0 &&
    v.tabs.every(isTab) &&
    v.tabs.some((t) => (t as TabRecord).id === v.active) &&
    (v.lastBridge === undefined ||
      (isObject(v.lastBridge) &&
        typeof v.lastBridge.sessionId === 'string' &&
        isFiniteNumber(v.lastBridge.seq)))
  )
}

export function saveTabsState(s: TabsState): void {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify(s))
  } catch {
    // ignore — persistence is a convenience, not a guarantee
  }
}

/**
 * The stored tabs, or a single tab migrated from the legacy one-workspace
 * record, or null for a genuinely fresh start. The legacy record is left in
 * place: it costs nothing, and deleting user data on a migration that might
 * be running inside a broken build is not worth the tidiness.
 */
export function loadTabsState(): TabsState | null {
  let raw: string | null
  try {
    raw = localStorage.getItem(TABS_KEY)
  } catch {
    return null
  }

  if (raw !== null) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
    if (isTabsState(parsed)) return parsed
    try {
      localStorage.removeItem(TABS_KEY)
    } catch {
      // ignore
    }
  }

  const legacy = loadWorkspace()
  if (legacy === null) return null
  return { version: 1, active: 't1', tabs: [{ id: 't1', name: 'Table 1', workspace: legacy }] }
}

/** Best-effort: a full disk or a blocked storage API must not break editing. */
export function saveWorkspace(w: Workspace): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(w))
  } catch {
    // ignore — persistence is a convenience, not a guarantee
  }
}

export function loadWorkspace(): Workspace | null {
  let raw: string | null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
  if (raw === null) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    clearWorkspace()
    return null
  }

  if (!isWorkspace(parsed)) {
    clearWorkspace()
    return null
  }

  return parsed
}

export function clearWorkspace(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}
