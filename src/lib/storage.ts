import type { BucketRow, ChartSettings, GroupDef, Targets, Volatility, WeightStep } from './types'
import { isHexColor } from './palette'

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
    isObject(v) && typeof v.id === 'string' && typeof v.name === 'string' && isHexColor(v.color)
  )
}

function isTargets(v: unknown): v is Targets {
  return (
    isObject(v) &&
    isFiniteNumber(v.rtp) &&
    isFiniteNumber(v.hitChance) &&
    isFiniteNumber(v.winChance) &&
    isFiniteNumber(v.tolerance)
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
      (Array.isArray(v.groupBars) && v.groupBars.every((s) => typeof s === 'string')))
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
    (v.targetsCollapsed === undefined || typeof v.targetsCollapsed === 'boolean')
  )
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
