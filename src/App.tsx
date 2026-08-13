import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BankrollConfig,
  BucketRow,
  ChartSettings,
  GroupDef,
  RowPatch,
  SimMode,
  SortKey,
  SortState,
  Targets,
  Volatility,
  WeightStep,
} from './lib/types'
import {
  CURVE_PRESETS,
  DEFAULT_BANKROLL,
  DEFAULT_CHART,
  DEFAULT_EXPORT_FILENAME,
  DEFAULT_SIM_MODE,
  DEFAULT_TARGETS,
  DEFAULT_WEIGHT_STEP,
  volatilityForCurve,
} from './lib/types'
import { clampBankrollConfig } from './lib/bankroll'
import { DEFAULT_WIDTHS, sortRows } from './lib/columns'
import { parseTsv, SAMPLE_TSV } from './lib/parse'
import {
  floorBlockWarning,
  rescaleToTotal,
  retargetRtp,
  solveWeights,
  statsOf,
  stepBlockWarning,
} from './lib/distribute'
import { buildTsv, copyTsv, downloadTsv, withTsvExtension } from './lib/exportTsv'
import { planGroupTargets, rebalanceWithinGroup } from './lib/groupTargets'
import { buildGrouping, groupLockState, nextGroupColor, nextGroupId, seedGroups, type LockState } from './lib/groups'
import { emptyHistory, pushHistory, redo, undo, type HistoryState } from './lib/history'
import { DEFAULT_SPINS } from './lib/sim'
import {
  loadTabsState,
  saveTabsState,
  type TabsState,
  type Workspace,
} from './lib/storage'
import { bridgeLoadPlan, feedTabName, freshTabsState, withNewTab, withoutTab } from './lib/tabs'
import { fetchSession, saveTsv, type BridgeSession } from './lib/bridge'
import { BucketTable } from './components/BucketTable'
import { clampHeight, DIST_HEIGHT, SIM_HEIGHT } from './components/chartUtils'
import { DistributionChart } from './components/DistributionChart'
import { GroupChips } from './components/GroupChips'
import { SettingsPanel } from './components/SettingsPanel'
import { TabStrip } from './components/TabStrip'
import { SimulationPanel } from './components/SimulationPanel'
import { TargetsPanel } from './components/TargetsPanel'

/** Used only when a fresh paste carries no weights of its own. */
const SEED_TOTAL_WEIGHT = 1_000_000
const SAVE_DEBOUNCE_MS = 300

const offStepNotice = (step: number) =>
  `The current weights are not multiples of ${step} — run Auto-Distribute first, or set the weight step to free.`

const pinnedNotice =
  'Every other unlocked bucket is locked — the grand total pins this weight where it is. Unlock something to move it.'

const groupPinnedNotice = (name: string) =>
  `The "${name}" group's total weight is locked: an edit must fit inside the group total and needs another unlocked member to absorb it.`

/** Everything undo covers. View state deliberately lives outside. */
interface Doc {
  rows: BucketRow[]
  /** Seeded from the labels at import, then owned by the user. */
  groups: GroupDef[]
  targets: Targets
  volatility: Volatility
  curve: number
  weightStep: WeightStep
}

/** Fills in groups and row fields absent from a pre-groups workspace. */
function migrateGroups(
  rows: BucketRow[],
  groups: GroupDef[] | undefined,
): { rows: BucketRow[]; groups: GroupDef[] } {
  const filled = rows.map((r) => ({ ...r, weightId: r.weightId ?? '', groupId: r.groupId ?? '' }))
  const known = new Set((groups ?? []).map((g) => g.id))
  if (groups !== undefined && groups.length > 0 && filled.every((r) => known.has(r.groupId))) {
    return { rows: filled, groups }
  }
  return seedGroups(filled)
}

const emptyDoc = (): Doc => ({
  rows: [],
  groups: [],
  targets: DEFAULT_TARGETS,
  volatility: 'medium',
  curve: CURVE_PRESETS.medium,
  weightStep: DEFAULT_WEIGHT_STEP,
})

/** A bridge feed waiting to be applied to one specific tab. */
interface PendingLoad {
  tabId: string
  tsv: string
  filename: string
}

interface WorkspaceViewProps {
  tabId: string
  /** This tab's persisted state; null for a tab that has never held data. */
  saved: Workspace | null
  session: BridgeSession | null
  pendingLoad: PendingLoad | null
  onLoadApplied: () => void
  onPersist: (w: Workspace) => void
  /** Undo history per tab, held above the remount a tab switch causes. */
  historyStore: Map<string, HistoryState<Doc>>
}

function WorkspaceView({
  tabId,
  saved,
  session,
  pendingLoad,
  onLoadApplied,
  onPersist,
  historyStore,
}: WorkspaceViewProps) {
  const [doc, setDocState] = useState<Doc>(() =>
    saved === null
      ? emptyDoc()
      : {
          // A workspace saved before groups were data carries neither a group
          // list nor row assignments — seed both once, exactly as an import
          // would, rather than dropping the user's table.
          ...migrateGroups(saved.rows, saved.groups),
          targets: { ...DEFAULT_TARGETS, ...saved.targets },
          volatility: saved.volatility,
          curve: saved.curve,
          weightStep: saved.weightStep ?? DEFAULT_WEIGHT_STEP,
        },
  )
  // Seeded from the per-tab store so switching tabs keeps each tab's undo
  // stack — the store outlives this component, the state does not.
  const [history, setHistoryState] = useState<HistoryState<Doc>>(
    () => historyStore.get(tabId) ?? emptyHistory<Doc>(),
  )

  // Mirrors, so a handler can read the live value without re-subscribing.
  const docRef = useRef(doc)
  const historyRef = useRef(history)

  const setDoc = useCallback((d: Doc) => {
    docRef.current = d
    setDocState(d)
  }, [])

  const setHistory = useCallback(
    (h: HistoryState<Doc>) => {
      historyRef.current = h
      historyStore.set(tabId, h)
      setHistoryState(h)
    },
    [historyStore, tabId],
  )

  // view state — not undoable, but persisted
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() =>
    saved === null ? DEFAULT_WIDTHS : { ...DEFAULT_WIDTHS, ...saved.columnWidths },
  )
  // Merged over the defaults so a workspace saved before a setting existed
  // still loads — the new field just takes its default.
  const [chart, setChart] = useState<ChartSettings>(
    saved?.chart === undefined ? DEFAULT_CHART : { ...DEFAULT_CHART, ...saved.chart },
  )
  // Clamped on the way in as well as on drag — the stored value is user data.
  const [chartHeight, setChartHeight] = useState(() =>
    clampHeight(saved?.chartHeight ?? DIST_HEIGHT.fallback, DIST_HEIGHT),
  )
  /**
   * Auto-fit defaults on, even for a workspace that already has a chartHeight:
   * that field is written on every save, not only on a manual resize, so its
   * presence says nothing about whether the user ever chose it.
   */
  const [chartHeightAuto, setChartHeightAuto] = useState(saved?.chartHeightAuto ?? true)
  const [tableHeight, setTableHeight] = useState<number | null>(null)
  /** The chart panel's own chrome (everything besides its SVG) — see rowRef. */
  const [chartChrome, setChartChrome] = useState(0)
  const [simChartHeight, setSimChartHeight] = useState(() =>
    clampHeight(saved?.simChartHeight ?? SIM_HEIGHT.fallback, SIM_HEIGHT),
  )
  const [simChartYZoom, setSimChartYZoom] = useState(saved?.simChartYZoom ?? 1)
  const [bankrollChartYZoom, setBankrollChartYZoom] = useState(saved?.bankrollChartYZoom ?? 1)
  const [simChartXZoom, setSimChartXZoom] = useState(saved?.simChartXZoom ?? 1)
  const [simChartXPan, setSimChartXPan] = useState(saved?.simChartXPan ?? 0)
  const [simChartYPan, setSimChartYPan] = useState(saved?.simChartYPan ?? 0)
  const [bankrollChartXZoom, setBankrollChartXZoom] = useState(saved?.bankrollChartXZoom ?? 1)
  const [bankrollChartXPan, setBankrollChartXPan] = useState(saved?.bankrollChartXPan ?? 0)
  const [bankrollChartYPan, setBankrollChartYPan] = useState(saved?.bankrollChartYPan ?? 0)
  const [exportFilename, setExportFilename] = useState(
    saved?.exportFilename ?? DEFAULT_EXPORT_FILENAME,
  )
  const [simSpins, setSimSpins] = useState(saved?.simSpins ?? DEFAULT_SPINS)
  const [simMode, setSimMode] = useState<SimMode>(saved?.simMode ?? DEFAULT_SIM_MODE)
  // Clamped on the way in, like chartHeight above: a hand-edited bet of 0
  // never busts and burns a full 10M-spin chunk per Continue, and a negative
  // multiplier pays out negative credits.
  const [bankroll, setBankroll] = useState<BankrollConfig>(() =>
    clampBankrollConfig(
      saved?.bankroll === undefined ? DEFAULT_BANKROLL : { ...DEFAULT_BANKROLL, ...saved.bankroll },
    ),
  )
  const [targetsCollapsed, setTargetsCollapsed] = useState(saved?.targetsCollapsed ?? false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sort, setSort] = useState<SortState>({ key: 'id', dir: 1 })
  // View state like chart.groupBars, and deliberately separate from it:
  // collapsing a group in the table does not change the chart.
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>(saved?.tableCollapsed ?? [])

  /**
   * The targets panel is sticky, and so are the grid header and the chart
   * panel — they have to clear it or they slide underneath. Its height moves
   * (collapse, row wrap, a warning appearing), so it is measured and published
   * as a custom property rather than hardcoded in the stylesheet. A callback
   * ref rather than an effect: this has to run when the panel mounts and
   * unmounts, which is exactly when the ref fires.
   */
  /**
   * Whether the chart has wrapped below the table. CSS cannot express "did
   * this flex line break?", and the answer decides how the table aligns, so it
   * is measured: two panels on the same line share an offsetTop.
   */
  const rowRef = useCallback((el: HTMLDivElement | null) => {
    if (el === null) return
    const check = () => {
      const table = el.querySelector<HTMLElement>('.panel.buckets')
      const chartPanel = el.querySelector<HTMLElement>('.panel.chart')
      if (table === null || chartPanel === null) return
      const stacked = table.offsetTop !== chartPanel.offsetTop
      if (el.classList.contains('stacked') !== stacked) el.classList.toggle('stacked', stacked)

      // The chart defaults to the table's height. Safe against a feedback loop:
      // the two panels are independent flex items under align-items: flex-start,
      // so the table's height never depends on the chart's — a chart resize
      // re-fires this, reads an unchanged table, and the update no-ops.
      const h = table.offsetHeight
      setTableHeight((prev) => (prev === null || Math.abs(prev - h) >= 1 ? h : prev))

      // The chart panel's chrome: everything in it besides the SVG itself —
      // panel-head, .chart-controls, the group chips row and the chart-wrap's
      // fixed readout band and grip. Fitting the *panels* to the same height
      // (rather than fitting the table to the chart's bare SVG) means
      // subtracting this from the table's height before it becomes the SVG's
      // height. This cannot feed back on itself: none of that chrome resizes
      // when the SVG does (they're independent siblings stacked in normal
      // block flow, not a layout that redistributes space by content), so
      // recomputing chrome after the SVG height changes yields the same
      // number — the `>= 1` guard below then skips the no-op update.
      //
      // The selector has to name the chart specifically rather than just
      // "svg": a positional match would find whatever SVG happens to be
      // first in the panel today, and if an icon svg is ever added above the
      // chart, `chrome` would silently start including that icon's height —
      // which *does* depend on nothing stable, and reintroduces the very
      // oscillation this measurement exists to avoid.
      //
      // getBoundingClientRect().height, not offsetHeight: offsetHeight is an
      // HTMLElement property that SVG elements don't have per spec (only
      // Chromium/WebKit expose it as a non-standard extension — Gecko
      // doesn't), and every other SVG measurement in this codebase already
      // uses getBoundingClientRect for exactly that reason.
      const svg = chartPanel.querySelector('svg[aria-label="Bucket distribution"]')
      if (svg !== null) {
        const chrome = chartPanel.offsetHeight - svg.getBoundingClientRect().height
        setChartChrome((prev) => (Math.abs(prev - chrome) >= 1 ? chrome : prev))
      }
    }
    check()
    const obs = new ResizeObserver(check)
    obs.observe(el)
    for (const child of el.children) obs.observe(child)
    return () => obs.disconnect()
  }, [])

  const effectiveChartHeight =
    chartHeightAuto && tableHeight !== null
      ? clampHeight(tableHeight - chartChrome, DIST_HEIGHT)
      : chartHeight

  const targetsRef = useCallback((el: HTMLElement | null) => {
    const root = document.documentElement
    if (el === null) {
      root.style.removeProperty('--targets-h')
      return
    }
    const publish = () => root.style.setProperty('--targets-h', `${el.offsetHeight}px`)
    publish()
    const obs = new ResizeObserver(publish)
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  /**
   * Live rows during a chart drag. Not undoable: previews stream while the
   * pointer moves, then the drag commits once. Everything visual renders
   * from `viewRows`; the document itself only changes on commit.
   */
  const [preview, setPreview] = useState<BucketRow[] | null>(null)

  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)
  const [notices, setNotices] = useState<string[]>([])
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'fail'>('idle')
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'conflict' | 'error'>(
    'idle',
  )
  const [saveMessage, setSaveMessage] = useState('')
  const [conflictName, setConflictName] = useState(session?.filename ?? '')

  /** Every document mutation goes through here, so undo can never miss one. */
  const commit = useCallback(
    (next: Doc | ((d: Doc) => Doc)) => {
      const prev = docRef.current
      const value = typeof next === 'function' ? next(prev) : next
      setHistory(pushHistory(historyRef.current, prev))
      setDoc(value)
    },
    [setDoc, setHistory],
  )

  const doUndo = useCallback(() => {
    const step = undo(historyRef.current, docRef.current)
    if (step === null) return
    setHistory(step.history)
    setDoc(step.present)
  }, [setDoc, setHistory])

  const doRedo = useCallback(() => {
    const step = redo(historyRef.current, docRef.current)
    if (step === null) return
    setHistory(step.history)
    setDoc(step.present)
  }, [setDoc, setHistory])

  // ---- persistence ----

  // The latest snapshot and the latest persist callback, so the unmount flush
  // below writes current data through the current callback — a tab switch
  // must not lose the sub-debounce tail of edits, nor write them to the tab
  // that is replacing this one.
  const snapshotRef = useRef<Workspace | null>(null)
  const onPersistRef = useRef(onPersist)
  useEffect(() => {
    onPersistRef.current = onPersist
  })

  useEffect(() => {
    const workspace: Workspace = {
      version: 1,
      rows: doc.rows,
      groups: doc.groups,
      targets: doc.targets,
      volatility: doc.volatility,
      curve: doc.curve,
      columnWidths,
      chart,
      exportFilename,
      simSpins,
      simMode,
      bankroll,
      weightStep: doc.weightStep,
      chartHeight,
      chartHeightAuto,
      simChartHeight,
      simChartYZoom,
      bankrollChartYZoom,
      simChartXZoom,
      simChartXPan,
      simChartYPan,
      bankrollChartXZoom,
      bankrollChartXPan,
      bankrollChartYPan,
      targetsCollapsed,
      tableCollapsed: collapsedGroups,
    }
    snapshotRef.current = workspace
    const t = window.setTimeout(() => onPersistRef.current(workspace), SAVE_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [
    doc,
    columnWidths,
    chart,
    exportFilename,
    simSpins,
    simMode,
    bankroll,
    chartHeight,
    chartHeightAuto,
    simChartHeight,
    simChartYZoom,
    bankrollChartYZoom,
    simChartXZoom,
    simChartXPan,
    simChartYPan,
    bankrollChartXZoom,
    bankrollChartXPan,
    bankrollChartYPan,
    targetsCollapsed,
    collapsedGroups,
  ])

  useEffect(
    () => () => {
      if (snapshotRef.current !== null) onPersistRef.current(snapshotRef.current)
    },
    [],
  )

  // ---- global keyboard ----

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      // Inside a text field, Ctrl+Z belongs to the field's own undo.
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return

      const k = e.key.toLowerCase()
      if (k === 'z') {
        e.preventDefault()
        if (e.shiftKey) doRedo()
        else doUndo()
      } else if (k === 'y') {
        e.preventDefault()
        doRedo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [doUndo, doRedo])

  // ---- derived ----

  const viewRows = preview ?? doc.rows
  const totalWeight = useMemo(() => viewRows.reduce((a, r) => a + r.weight, 0), [viewRows])
  const achieved = useMemo(() => statsOf(viewRows, totalWeight), [viewRows, totalWeight])
  const lockedCount = useMemo(() => doc.rows.filter((r) => r.locked).length, [doc.rows])
  const grouping = useMemo(() => buildGrouping(viewRows, doc.groups), [viewRows, doc.groups])
  const groupCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of doc.rows) m.set(r.groupId, (m.get(r.groupId) ?? 0) + 1)
    return m
  }, [doc.rows])
  const groupStats = useMemo(() => {
    const m = new Map<string, { chance: number; rtp: number }>()
    if (!(totalWeight > 0)) return m
    for (const r of viewRows) {
      const s = m.get(r.groupId) ?? { chance: 0, rtp: 0 }
      s.chance += r.weight / totalWeight
      s.rtp += (r.payout * r.weight) / totalWeight
      m.set(r.groupId, s)
    }
    return m
  }, [viewRows, totalWeight])
  /**
   * The chart handles soft-locked groups itself: their bars stay draggable,
   * compensating only against each other, while the group handle — the total,
   * the thing the lock pins — goes inert. It just needs to know which groups.
   */
  const softLockedGroups = useMemo(
    () => new Set(doc.groups.filter((g) => g.totalLocked === true).map((g) => g.id)),
    [doc.groups],
  )

  // ---- actions ----

  const loadData = useCallback(
    (text: string) => {
      const outcome = parseTsv(text)
      if (outcome.error !== undefined) {
        setPasteError(outcome.error)
        return
      }

      let rows = outcome.rows
      if (outcome.hasWeights) {
        setNotices([])
      } else {
        const res = solveWeights(
          rows,
          SEED_TOTAL_WEIGHT,
          docRef.current.targets,
          docRef.current.curve,
          docRef.current.weightStep,
        )
        rows = rows.map((r, i) => ({ ...r, weight: res.weights[i] }))
        setNotices(res.warnings)
      }

      const seeded = seedGroups(rows)
      commit((d) => ({ ...d, rows: seeded.rows, groups: seeded.groups }))
      // New data means new groups; a collapsed id from the old table would
      // either dangle or, worse, collapse an unrelated group of the same name.
      setChart((c) => ({ ...c, groupBars: [] }))
      setCollapsedGroups([])
      setPasteOpen(false)
      setPasteText('')
      setPasteError(null)
    },
    [commit],
  )

  /**
   * The tabs root fetched the session and decided which tab a feed lands in;
   * when it is this one, load the file as though it had been pasted. Applied
   * exactly once per feed — `onLoadApplied` clears it upstream.
   */
  useEffect(() => {
    if (pendingLoad === null || pendingLoad.tabId !== tabId) return
    // Deferred a tick so the state updates happen in a callback rather than
    // the effect body — same shape as the fetch-then-load this replaced.
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setExportFilename(pendingLoad.filename)
      setConflictName(pendingLoad.filename)
      loadData(pendingLoad.tsv)
      onLoadApplied()
    })
    return () => {
      cancelled = true
    }
  }, [pendingLoad, tabId, loadData, onLoadApplied])

  const autoDistribute = useCallback(() => {
    const d = docRef.current
    if (d.rows.length === 0) return
    const total = totalWeight > 0 ? totalWeight : SEED_TOTAL_WEIGHT
    // Group demands (locked totals, preferred chance/RTP) are decided first
    // and handed to the solver as locked rows — its rank-1 constraint — so it
    // steers the rest of the table around them without knowing about groups.
    const plan = planGroupTargets(d.rows, d.groups, total, d.weightStep)
    const solveRows =
      plan.pinned.size === 0
        ? d.rows
        : d.rows.map((r, i) =>
            plan.pinned.has(i) ? { ...r, weight: plan.pinned.get(i)!, locked: true } : r,
          )
    const res = solveWeights(solveRows, total, d.targets, d.curve, d.weightStep)
    setNotices([...plan.notes, ...res.warnings])
    commit({ ...d, rows: d.rows.map((r, i) => ({ ...r, weight: res.weights[i] })) })
  }, [commit, totalWeight])

  const patchRow = useCallback(
    (uid: string, patch: RowPatch) => {
      // A weight edit inside a total-locked group must not move the group's
      // total, so the difference lands on the group's other unlocked members.
      // Only bare weight edits reroute: lock toggles, label edits and group
      // moves are not weight changes, and a locked row's weight is not
      // editable in the first place.
      if (patch.weight !== undefined && Object.keys(patch).length === 1) {
        const d = docRef.current
        const row = d.rows.find((r) => r.uid === uid)
        const g = row === undefined ? undefined : d.groups.find((x) => x.id === row.groupId)
        if (row !== undefined && !row.locked && g?.totalLocked === true) {
          const rebalanced = rebalanceWithinGroup(d.rows, uid, patch.weight)
          if (rebalanced === null) {
            setNotices([groupPinnedNotice(g.name)])
            return
          }
          setNotices([])
          commit({ ...d, rows: d.rows.map((r, i) => ({ ...r, weight: rebalanced[i] })) })
          return
        }
      }
      commit((d) => ({
        ...d,
        rows: d.rows.map((r) => (r.uid === uid ? { ...r, ...patch } : r)),
      }))
    },
    [commit],
  )

  const changeTotalWeight = useCallback(
    (next: number) => {
      const d = docRef.current
      const scaled = rescaleToTotal(d.rows, next, d.weightStep)
      if (scaled === null) {
        const d2 = d
        const lockedSum = d2.rows.filter((r) => r.locked).reduce((a, r) => a + r.weight, 0)
        const budget = Math.round(next) - lockedSum
        if (d2.rows.every((r) => r.locked)) {
          setNotices([
            `Every row is locked — unlock something or set the total to exactly the locked weight (${lockedSum.toLocaleString('en-US')}).`,
          ])
        } else if (next < lockedSum) {
          setNotices([
            `Total weight cannot be set below the locked weight (${lockedSum.toLocaleString('en-US')}).`,
          ])
        } else if (budget % d2.weightStep !== 0) {
          setNotices([stepBlockWarning(budget, lockedSum, d2.weightStep)])
        } else {
          setNotices([floorBlockWarning(d2.rows, d2.weightStep, Math.round(next))])
        }
        return
      }
      setNotices([])
      commit({ ...d, rows: d.rows.map((r, i) => ({ ...r, weight: scaled[i] })) })
    },
    [commit],
  )

  const changeTotalRtp = useCallback(
    (next: number) => {
      const d = docRef.current
      if (d.rows.length === 0 || totalWeight <= 0) return
      const weights = retargetRtp(d.rows, totalWeight, next, d.weightStep)
      if (weights === null) {
        setNotices([offStepNotice(d.weightStep)])
        return
      }
      setNotices([])
      commit({ ...d, rows: d.rows.map((r, i) => ({ ...r, weight: weights[i] })) })
    },
    [commit, totalWeight],
  )

  const handleSort = useCallback((key: SortKey) => {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 1 ? -1 : 1 } : { key, dir: 1 }))
  }, [])

  // Chart callbacks hand back the rows they were given — which carry the
  // synthetic locks from `chartRows` — so only the weights are taken and
  // mapped onto the document's own rows. Flags must never leak into the doc.
  const handleDragPreview = useCallback(
    (rows: BucketRow[] | null) => {
      if (rows === null) {
        setPreview(null)
        return
      }
      const weightByUid = new Map(rows.map((r) => [r.uid, r.weight]))
      setPreview(
        docRef.current.rows.map((r) => ({ ...r, weight: weightByUid.get(r.uid) ?? r.weight })),
      )
    },
    [],
  )

  const handleDragCommit = useCallback(
    (rows: BucketRow[]) => {
      setPreview(null)
      setNotices([])
      const weightByUid = new Map(rows.map((r) => [r.uid, r.weight]))
      commit((d) => ({
        ...d,
        rows: d.rows.map((r) => ({ ...r, weight: weightByUid.get(r.uid) ?? r.weight })),
      }))
    },
    [commit],
  )

  const handleBlocked = useCallback((reason: 'off-step' | 'pinned') => {
    setNotices([reason === 'off-step' ? offStepNotice(docRef.current.weightStep) : pinnedNotice])
  }, [])

  // ---- groups ----

  const addGroup = useCallback(() => {
    commit((d) => ({
      ...d,
      groups: [
        ...d.groups,
        { id: nextGroupId(d.groups), name: `group ${d.groups.length + 1}`, color: nextGroupColor(d.groups) },
      ],
    }))
  }, [commit])

  const renameGroup = useCallback(
    (id: string, name: string) => {
      commit((d) => ({
        ...d,
        groups: d.groups.map((g) => (g.id === id ? { ...g, name } : g)),
      }))
    },
    [commit],
  )

  const recolorGroup = useCallback(
    (id: string, color: string) => {
      commit((d) => ({
        ...d,
        groups: d.groups.map((g) => (g.id === id ? { ...g, color } : g)),
      }))
    },
    [commit],
  )

  /** Deleting a group never deletes buckets — they move to the first survivor. */
  const deleteGroup = useCallback(
    (id: string) => {
      commit((d) => {
        if (d.groups.length <= 1) return d
        const groups = d.groups.filter((g) => g.id !== id)
        const fallback = groups[0].id
        return {
          ...d,
          groups,
          rows: d.rows.map((r) => (r.groupId === id ? { ...r, groupId: fallback } : r)),
        }
      })
      // A deleted id must not linger in view state — nextGroupId can reissue
      // it, and a brand-new group must never start out pre-collapsed.
      setChart((c) => ({ ...c, groupBars: c.groupBars.filter((g) => g !== id) }))
      setCollapsedGroups((prev) => prev.filter((g) => g !== id))
    },
    [commit],
  )

  /**
   * A group lock is just its rows' locks, set together — so undo, the solver
   * and the export need to know nothing about groups.
   */
  const setGroupLocked = useCallback(
    (id: string, locked: boolean) => {
      commit((d) => ({
        ...d,
        rows: d.rows.map((r) => (r.groupId === id ? { ...r, locked } : r)),
      }))
    },
    [commit],
  )

  /** Demand edits (total lock, preferred chance/RTP) are document data — undoable. */
  const patchGroup = useCallback(
    (id: string, patch: Partial<GroupDef>) => {
      commit((d) => ({
        ...d,
        groups: d.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)),
      }))
    },
    [commit],
  )

  const groupLockStates = useMemo(() => {
    const m = new Map<string, LockState>()
    for (const g of doc.groups) m.set(g.id, groupLockState(doc.rows, g.id))
    return m
  }, [doc.groups, doc.rows])

  const exportText = useCallback(
    () => buildTsv(sortRows(docRef.current.rows, sort, totalWeight, grouping.rank), totalWeight),
    [sort, totalWeight, grouping],
  )

  const handleCopy = useCallback(async () => {
    const ok = await copyTsv(exportText())
    setCopyState(ok ? 'ok' : 'fail')
    window.setTimeout(() => setCopyState('idle'), 1800)
  }, [exportText])

  const doSave = useCallback(
    async (filename: string, overwrite: boolean) => {
      setSaveState('saving')
      // Normalised the same way Download names its file, so the two adjacent
      // buttons (and the conflict row's Save as / Overwrite, which share this
      // function) agree on what a bare `myweights` turns into instead of one
      // succeeding as `myweights.tsv` and the other 400ing on the server.
      const outcome = await saveTsv(withTsvExtension(filename), exportText(), overwrite)

      if (outcome.kind === 'exists') {
        setConflictName(outcome.filename)
        setSaveState('conflict')
        return
      }
      if (outcome.kind === 'error') {
        setSaveMessage(outcome.message)
        setSaveState('error')
        return
      }
      setSaveState('saved')
      window.setTimeout(() => setSaveState('idle'), 1800)
    },
    [exportText],
  )

  const handleClear = useCallback(() => {
    if (!window.confirm('Clear this tab? Its table and settings are deleted permanently.')) {
      return
    }
    // The persistence effect writes the emptied state through, so no storage
    // call is needed here — and other tabs are untouched by design.
    setHistory(emptyHistory<Doc>())
    setDoc(emptyDoc())
    setNotices([])
    setPasteOpen(true)
  }, [setDoc, setHistory])

  const hasRows = doc.rows.length > 0

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>Weighted Return</h1>
          <span className="brand-sub">slot engine bucket weights</span>
        </div>
        <div className="topbar-actions">
          <div className="topbar-block">
            <span className="topbar-block-label">Import</span>
            <button type="button" className="btn" onClick={() => loadData(SAMPLE_TSV)}>
              Load sample
            </button>
            <button type="button" className="btn" onClick={() => setPasteOpen(true)}>
              Paste TSV data
            </button>
          </div>
          {hasRows && (
            <>
              <div className="topbar-block">
                <span className="topbar-block-label">Export</span>
                <input
                  className="filename-input"
                  value={exportFilename}
                  aria-label="Export filename"
                  spellCheck={false}
                  onChange={(e) => setExportFilename(e.target.value)}
                />
                <button type="button" className="btn" onClick={handleCopy}>
                  {copyState === 'ok' ? 'Copied ✓' : copyState === 'fail' ? 'Copy failed' : 'Copy TSV'}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => downloadTsv(exportText(), exportFilename)}
                >
                  Download .tsv
                </button>
                {/* Bridge controls join the Export block — saving to disk is an
                    export, and they only exist when the CLI launched us. */}
                {session !== null && saveState !== 'conflict' && (
                  <button
                    type="button"
                    className="btn primary"
                    disabled={saveState === 'saving'}
                    title={`Saves to ${session.dir}`}
                    onClick={() => void doSave(exportFilename, false)}
                  >
                    {saveState === 'saving'
                      ? 'Saving…'
                      : saveState === 'saved'
                        ? 'Saved ✓'
                        : saveState === 'error'
                          ? 'Save failed'
                          : 'Auto save data'}
                  </button>
                )}
                {session !== null && saveState === 'conflict' && (
                  <span className="bridge-conflict">
                    <span className="bridge-conflict-msg">already exists —</span>
                    <input
                      className="filename-input"
                      value={conflictName}
                      aria-label="Save as filename"
                      spellCheck={false}
                      onChange={(e) => setConflictName(e.target.value)}
                    />
                    <button type="button" className="btn danger" onClick={() => void doSave(conflictName, true)}>
                      Overwrite
                    </button>
                    <button type="button" className="btn" onClick={() => void doSave(conflictName, false)}>
                      Save as
                    </button>
                    <button type="button" className="btn" onClick={() => setSaveState('idle')}>
                      Cancel
                    </button>
                  </span>
                )}
                {session !== null && saveState === 'error' && (
                  <span className="bridge-hint bridge-error">{saveMessage}</span>
                )}
                {session !== null && saveState !== 'conflict' && saveState !== 'error' && (
                  <span className="bridge-hint">
                    {session.game === '' ? `→ ${session.dir}` : `${session.game} → ${session.dir}`}
                  </span>
                )}
              </div>
              {/* Destructive, so it stands apart from the two blocks rather
                  than sitting among the actions used constantly. */}
              <button type="button" className="btn danger" onClick={handleClear}>
                Clear workspace
              </button>
            </>
          )}
        </div>
      </header>

      {hasRows && (
        <main className="content">
          <TargetsPanel
            panelRef={targetsRef}
            collapsed={targetsCollapsed}
            onCollapsed={setTargetsCollapsed}
            targets={doc.targets}
            volatility={doc.volatility}
            curve={doc.curve}
            weightStep={doc.weightStep}
            achieved={achieved}
            warnings={notices}
            bucketCount={doc.rows.length}
            lockedCount={lockedCount}
            canUndo={history.past.length > 0}
            canRedo={history.future.length > 0}
            onTargets={(t) => commit((d) => ({ ...d, targets: t }))}
            onVolatility={(v) => commit((d) => ({ ...d, volatility: v, curve: CURVE_PRESETS[v] }))}
            onCurve={(c) => commit((d) => ({ ...d, curve: c, volatility: volatilityForCurve(c) }))}
            onAutoDistribute={autoDistribute}
            onUndo={doUndo}
            onRedo={doRedo}
            onSettings={() => setSettingsOpen((v) => !v)}
            settingsOpen={settingsOpen}
          />

          <SettingsPanel
            open={settingsOpen}
            targets={doc.targets}
            weightStep={doc.weightStep}
            groups={doc.groups}
            groupCounts={groupCounts}
            groupLockStates={groupLockStates}
            groupStats={groupStats}
            onTargets={(t) => commit((d) => ({ ...d, targets: t }))}
            onWeightStep={(s) => commit((d) => ({ ...d, weightStep: s }))}
            onGroupAdd={addGroup}
            onGroupRename={renameGroup}
            onGroupRecolor={recolorGroup}
            onGroupDelete={deleteGroup}
            onGroupLock={setGroupLocked}
            onGroupPatch={patchGroup}
            onClose={() => setSettingsOpen(false)}
          />

          <div className={`content-row${chart.forceStack ? ' force-stack' : ''}`} ref={rowRef}>
          <section className="panel buckets">
            <div className="panel-head">
              <h2>Buckets</h2>
              <span className="panel-hint">
                arrow keys to move · type +500 to add · drag a header edge to resize
              </span>
              <button
                type="button"
                className={`btn group-sort ${sort.key === 'group' ? 'primary' : ''}`}
                title="Order rows by bucket group — colors match the chart"
                onClick={() => handleSort('group')}
              >
                Group sort
              </button>
            </div>
            <GroupChips
              groups={grouping.groups}
              selected={collapsedGroups}
              onSelected={setCollapsedGroups}
              label="Collapse"
              titleOn={(n) => `Show ${n}'s buckets as rows`}
              titleOff={(n) => `Fold ${n} into one summary row`}
            />
            <BucketTable
              rows={viewRows}
              totalWeight={totalWeight}
              sort={sort}
              columnWidths={columnWidths}
              grouping={grouping}
              groups={doc.groups}
              weightStep={doc.weightStep}
              collapsed={collapsedGroups}
              onSort={handleSort}
              onPatch={patchRow}
              onWidths={setColumnWidths}
              onTotalWeight={changeTotalWeight}
              onTotalRtp={changeTotalRtp}
              onExpand={(id) => setCollapsedGroups((prev) => prev.filter((g) => g !== id))}
              onGroupLock={setGroupLocked}
            />
          </section>

          <section className="panel chart">
            <div className="panel-head">
              <h2>Distribution</h2>
              <button
                type="button"
                className={`btn ${chart.forceStack ? 'primary' : ''}`}
                aria-pressed={chart.forceStack}
                title="Always show the distribution chart below the table, even if there's room beside it"
                onClick={() => setChart({ ...chart, forceStack: !chart.forceStack })}
              >
                Stack below
              </button>
            </div>
            <DistributionChart
              rows={viewRows}
              totalWeight={totalWeight}
              chart={chart}
              grouping={grouping}
              weightStep={doc.weightStep}
              height={effectiveChartHeight}
              onChart={setChart}
              onHeight={(h) => {
                setChartHeight(h)
                setChartHeightAuto(false)
              }}
              onHeightReset={() => setChartHeightAuto(true)}
              onPreview={handleDragPreview}
              onCommit={handleDragCommit}
              onBlocked={handleBlocked}
              onGroupLock={setGroupLocked}
              softLocked={softLockedGroups}
              onGroupSoftLock={(id, locked) => patchGroup(id, { totalLocked: locked })}
            />
          </section>
          </div>

          <section className="panel full">
            <div className="panel-head">
              <h2>Simulation</h2>
              <span className="panel-hint">
                spins the current table with a fast Monte Carlo run — edits during a run don't
                change it
              </span>
            </div>
            <SimulationPanel
              mode={simMode}
              onMode={setSimMode}
              rows={doc.rows}
              totalWeight={totalWeight}
              expectedRtp={achieved.rtp}
              spins={simSpins}
              onSpins={setSimSpins}
              bankroll={bankroll}
              onBankroll={setBankroll}
              chartHeight={simChartHeight}
              onChartHeight={setSimChartHeight}
              simYZoom={simChartYZoom}
              onSimYZoom={setSimChartYZoom}
              bankrollYZoom={bankrollChartYZoom}
              onBankrollYZoom={setBankrollChartYZoom}
              simYPan={simChartYPan}
              onSimYPan={setSimChartYPan}
              simXZoom={simChartXZoom}
              onSimXZoom={setSimChartXZoom}
              simXPan={simChartXPan}
              onSimXPan={setSimChartXPan}
              bankrollYPan={bankrollChartYPan}
              onBankrollYPan={setBankrollChartYPan}
              bankrollXZoom={bankrollChartXZoom}
              onBankrollXZoom={setBankrollChartXZoom}
              bankrollXPan={bankrollChartXPan}
              onBankrollXPan={setBankrollChartXPan}
            />
          </section>
        </main>
      )}

      {(pasteOpen || !hasRows) && (
        <div
          className={hasRows ? 'paste-overlay' : 'paste-hero'}
          onClick={(e) => {
            if (hasRows && e.target === e.currentTarget) setPasteOpen(false)
          }}
        >
          <div className="paste-card">
            <h2>Paste bucket data</h2>
            <p className="paste-desc">
              Three tab-separated columns, no header needed: <b>ID</b> ⇥ <b>Avg Payout</b> ⇥{' '}
              <b>Label</b>. An exported <code>.tsv</code> from this tool can be pasted back too —
              its weights are picked up and the header and totals rows are ignored.
            </p>
            <textarea
              className="paste-area"
              spellCheck={false}
              placeholder={'0\t1000.00\tjoker5-maxwin\n1\t200.00\tjoker4-stacks\n2\t0.00\t0x\n…'}
              value={pasteText}
              onChange={(e) => {
                setPasteText(e.target.value)
                setPasteError(null)
              }}
              autoFocus
            />
            {pasteError !== null && <div className="paste-error">{pasteError}</div>}
            <div className="paste-actions">
              {hasRows && (
                <button type="button" className="btn" onClick={() => setPasteOpen(false)}>
                  Cancel
                </button>
              )}
              <button type="button" className="btn" onClick={() => loadData(SAMPLE_TSV)}>
                Use sample data
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={pasteText.trim() === ''}
                onClick={() => loadData(pasteText)}
              >
                Build table
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The tabs root. Each tab is a full workspace; the active one renders through
 * `WorkspaceView`, keyed by tab id so a switch remounts it and every piece of
 * its state re-initializes from that tab's own saved record. Undo history
 * lives up here (in a ref map) precisely because the remount would otherwise
 * discard it.
 *
 * The bridge session is fetched here, once per page load, because a feed has
 * to pick its tab before any tab can load it — and whether it loads at all
 * depends on identity this component stores (`bridgeLoadPlan`): a plain
 * refresh must never re-import the source file over in-progress tuning.
 */
export default function App() {
  const [tabsState, setTabsStateRaw] = useState<TabsState>(() => loadTabsState() ?? freshTabsState())
  const tabsRef = useRef(tabsState)
  const setTabs = useCallback((next: TabsState) => {
    tabsRef.current = next
    setTabsStateRaw(next)
    saveTabsState(next)
  }, [])

  const [session, setSession] = useState<BridgeSession | null>(null)
  const [pendingLoad, setPendingLoad] = useState<PendingLoad | null>(null)
  // useState, not useRef: the map itself is stable for the app's lifetime and
  // reading a ref's .current during render is off-limits.
  const [historyStore] = useState(() => new Map<string, HistoryState<Doc>>())

  useEffect(() => {
    // The bridge is a dev-server-only feature (the plugin itself is
    // `apply: 'serve'` and registers nothing in a production build) — gating
    // the probe here too means a production bundle never issues the
    // `GET /__bridge/session` request in the first place.
    if (!import.meta.env.DEV) return
    let cancelled = false
    void fetchSession().then((s) => {
      if (cancelled || s === null) return
      setSession(s)

      const cur = tabsRef.current
      const plan = bridgeLoadPlan(cur.lastBridge, s)
      if (plan === 'skip') return

      const lastBridge = { sessionId: s.sessionId, seq: s.seq }
      const name = feedTabName(s)
      if (plan === 'new-tab') {
        const added = withNewTab(cur, name)
        setTabs({ ...added.state, lastBridge })
        setPendingLoad({ tabId: added.id, tsv: s.tsv, filename: s.filename })
      } else {
        setTabs({
          ...cur,
          tabs: cur.tabs.map((t) => (t.id === cur.active ? { ...t, name } : t)),
          lastBridge,
        })
        setPendingLoad({ tabId: cur.active, tsv: s.tsv, filename: s.filename })
      }
    })
    return () => {
      cancelled = true
    }
  }, [setTabs])

  const active = tabsState.tabs.find((t) => t.id === tabsState.active) ?? tabsState.tabs[0]

  // Bound to the active tab's id, so the unmount flush a tab switch triggers
  // still writes through the OLD tab's callback — each WorkspaceView instance
  // holds the persist for the tab it was mounted for.
  const persistActive = useCallback(
    (w: Workspace) => {
      const cur = tabsRef.current
      setTabs({
        ...cur,
        tabs: cur.tabs.map((t) => (t.id === active.id ? { ...t, workspace: w } : t)),
      })
    },
    [active.id, setTabs],
  )

  const addTab = useCallback(() => {
    setTabs(withNewTab(tabsRef.current).state)
  }, [setTabs])

  const closeTab = useCallback(
    (id: string) => {
      const tab = tabsRef.current.tabs.find((t) => t.id === id)
      if (tab === undefined) return
      // The persisted record lags edits by the save debounce, so a tab whose
      // table was built moments ago can still read as empty — but any edit
      // leaves an undo entry immediately, and that is checked too.
      const holdsData =
        (tab.workspace?.rows.length ?? 0) > 0 ||
        (historyStore.get(id)?.past.length ?? 0) > 0
      if (
        holdsData &&
        !window.confirm(`Close "${tab.name}"? Its table and settings are deleted permanently.`)
      ) {
        return
      }
      historyStore.delete(id)
      setTabs(withoutTab(tabsRef.current, id))
    },
    [historyStore, setTabs],
  )

  return (
    <>
      <TabStrip
        tabs={tabsState.tabs}
        active={active.id}
        onSelect={(id) => setTabs({ ...tabsRef.current, active: id })}
        onAdd={addTab}
        onClose={closeTab}
      />
      <WorkspaceView
        key={active.id}
        tabId={active.id}
        saved={active.workspace}
        session={session}
        pendingLoad={pendingLoad}
        onLoadApplied={() => setPendingLoad(null)}
        onPersist={persistActive}
        historyStore={historyStore}
      />
    </>
  )
}
