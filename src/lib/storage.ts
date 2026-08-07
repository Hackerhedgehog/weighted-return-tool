import type { BucketRow, ChartSettings, Targets, Volatility, WeightStep } from './types'

/**
 * One autosaved workspace. The key carries the schema version, and the payload
 * repeats it, so a future format change simply fails validation and starts
 * clean rather than crashing on data it cannot read.
 */
export const STORAGE_KEY = 'weighted-return-tool:workspace:v1'

export interface Workspace {
  version: 1
  rows: BucketRow[]
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
    typeof v.locked === 'boolean'
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
    typeof v.aggregate === 'boolean'
  )
}

function isWorkspace(v: unknown): v is Workspace {
  return (
    isObject(v) &&
    v.version === 1 &&
    Array.isArray(v.rows) &&
    v.rows.every(isRow) &&
    isTargets(v.targets) &&
    typeof v.volatility === 'string' &&
    isFiniteNumber(v.curve) &&
    isObject(v.columnWidths) &&
    isChart(v.chart) &&
    typeof v.exportFilename === 'string' &&
    (v.simSpins === undefined || isFiniteNumber(v.simSpins)) &&
    (v.weightStep === undefined || v.weightStep === 1 || v.weightStep === 10 || v.weightStep === 100)
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
