import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BucketRow,
  ChartSettings,
  RowPatch,
  SortKey,
  SortState,
  Targets,
  Volatility,
} from './lib/types'
import {
  CURVE_PRESETS,
  DEFAULT_CHART,
  DEFAULT_EXPORT_FILENAME,
  DEFAULT_TARGETS,
  volatilityForCurve,
} from './lib/types'
import { DEFAULT_WIDTHS, sortRows } from './lib/columns'
import { parseTsv, SAMPLE_TSV } from './lib/parse'
import { rescaleToTotal, retargetRtp, solveWeights, statsOf } from './lib/distribute'
import { buildTsv, copyTsv, downloadTsv } from './lib/exportTsv'
import { groupRows } from './lib/groups'
import { emptyHistory, pushHistory, redo, undo, type HistoryState } from './lib/history'
import { DEFAULT_SPINS } from './lib/sim'
import { clearWorkspace, loadWorkspace, saveWorkspace } from './lib/storage'
import { BucketTable } from './components/BucketTable'
import { DistributionChart } from './components/DistributionChart'
import { SimulationPanel } from './components/SimulationPanel'
import { TargetsPanel } from './components/TargetsPanel'

/** Used only when a fresh paste carries no weights of its own. */
const SEED_TOTAL_WEIGHT = 1_000_000
const SAVE_DEBOUNCE_MS = 300

/** Everything undo covers. View state deliberately lives outside. */
interface Doc {
  rows: BucketRow[]
  targets: Targets
  volatility: Volatility
  curve: number
}

const emptyDoc = (): Doc => ({
  rows: [],
  targets: DEFAULT_TARGETS,
  volatility: 'medium',
  curve: CURVE_PRESETS.medium,
})

export default function App() {
  // Read once, synchronously, as the initial state. Restoring inside an effect
  // instead would kick off a second render pass on every load.
  const [saved] = useState(loadWorkspace)

  const [doc, setDocState] = useState<Doc>(() =>
    saved === null
      ? emptyDoc()
      : { rows: saved.rows, targets: saved.targets, volatility: saved.volatility, curve: saved.curve },
  )
  const [history, setHistoryState] = useState<HistoryState<Doc>>(emptyHistory<Doc>)

  // Mirrors, so a handler can read the live value without re-subscribing.
  const docRef = useRef(doc)
  const historyRef = useRef(history)

  const setDoc = useCallback((d: Doc) => {
    docRef.current = d
    setDocState(d)
  }, [])

  const setHistory = useCallback((h: HistoryState<Doc>) => {
    historyRef.current = h
    setHistoryState(h)
  }, [])

  // view state — not undoable, but persisted
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() =>
    saved === null ? DEFAULT_WIDTHS : { ...DEFAULT_WIDTHS, ...saved.columnWidths },
  )
  // Merged over the defaults so a workspace saved before a setting existed
  // still loads — the new field just takes its default.
  const [chart, setChart] = useState<ChartSettings>(
    saved?.chart === undefined ? DEFAULT_CHART : { ...DEFAULT_CHART, ...saved.chart },
  )
  const [exportFilename, setExportFilename] = useState(
    saved?.exportFilename ?? DEFAULT_EXPORT_FILENAME,
  )
  const [simSpins, setSimSpins] = useState(saved?.simSpins ?? DEFAULT_SPINS)
  const [sort, setSort] = useState<SortState>({ key: 'id', dir: 1 })

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

  useEffect(() => {
    const t = window.setTimeout(() => {
      saveWorkspace({
        version: 1,
        rows: doc.rows,
        targets: doc.targets,
        volatility: doc.volatility,
        curve: doc.curve,
        columnWidths,
        chart,
        exportFilename,
        simSpins,
      })
    }, SAVE_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [doc, columnWidths, chart, exportFilename, simSpins])

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
  const grouping = useMemo(() => groupRows(viewRows), [viewRows])

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
        const res = solveWeights(rows, SEED_TOTAL_WEIGHT, docRef.current.targets, docRef.current.curve)
        rows = rows.map((r, i) => ({ ...r, weight: res.weights[i] }))
        setNotices(res.warnings)
      }

      commit((d) => ({ ...d, rows }))
      setPasteOpen(false)
      setPasteText('')
      setPasteError(null)
    },
    [commit],
  )

  const autoDistribute = useCallback(() => {
    const d = docRef.current
    if (d.rows.length === 0) return
    const total = totalWeight > 0 ? totalWeight : SEED_TOTAL_WEIGHT
    const res = solveWeights(d.rows, total, d.targets, d.curve)
    setNotices(res.warnings)
    commit({ ...d, rows: d.rows.map((r, i) => ({ ...r, weight: res.weights[i] })) })
  }, [commit, totalWeight])

  const patchRow = useCallback(
    (uid: string, patch: RowPatch) => {
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
      const scaled = rescaleToTotal(d.rows, next)
      if (scaled === null) {
        setNotices([
          `Total weight cannot be set below the locked weight (${d.rows
            .filter((r) => r.locked)
            .reduce((a, r) => a + r.weight, 0)
            .toLocaleString('en-US')}).`,
        ])
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
      const weights = retargetRtp(d.rows, totalWeight, next)
      setNotices([])
      commit({ ...d, rows: d.rows.map((r, i) => ({ ...r, weight: weights[i] })) })
    },
    [commit, totalWeight],
  )

  const handleSort = useCallback((key: SortKey) => {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 1 ? -1 : 1 } : { key, dir: 1 }))
  }, [])

  const handleDragCommit = useCallback(
    (rows: BucketRow[]) => {
      setPreview(null)
      commit((d) => ({ ...d, rows }))
    },
    [commit],
  )

  const exportText = useCallback(
    () => buildTsv(sortRows(docRef.current.rows, sort, totalWeight), totalWeight),
    [sort, totalWeight],
  )

  const handleCopy = useCallback(async () => {
    const ok = await copyTsv(exportText())
    setCopyState(ok ? 'ok' : 'fail')
    window.setTimeout(() => setCopyState('idle'), 1800)
  }, [exportText])

  const handleClear = useCallback(() => {
    if (!window.confirm('Clear the workspace? The table and its settings are deleted permanently.')) {
      return
    }
    clearWorkspace()
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
          <button type="button" className="btn" onClick={() => loadData(SAMPLE_TSV)}>
            Load sample
          </button>
          <button type="button" className="btn" onClick={() => setPasteOpen(true)}>
            Paste TSV data
          </button>
        </div>
      </header>

      {hasRows && (
        <main className="content">
          <TargetsPanel
            targets={doc.targets}
            volatility={doc.volatility}
            curve={doc.curve}
            achieved={achieved}
            warnings={notices}
            bucketCount={doc.rows.length}
            lockedCount={lockedCount}
            canUndo={history.past.length > 0}
            canRedo={history.future.length > 0}
            exportFilename={exportFilename}
            copyState={copyState}
            onTargets={(t) => commit((d) => ({ ...d, targets: t }))}
            onVolatility={(v) => commit((d) => ({ ...d, volatility: v, curve: CURVE_PRESETS[v] }))}
            onCurve={(c) => commit((d) => ({ ...d, curve: c, volatility: volatilityForCurve(c) }))}
            onAutoDistribute={autoDistribute}
            onUndo={doUndo}
            onRedo={doRedo}
            onCopy={handleCopy}
            onDownload={() => downloadTsv(exportText(), exportFilename)}
            onFilename={setExportFilename}
            onClear={handleClear}
          />

          <section className="panel">
            <div className="panel-head">
              <h2>Buckets</h2>
              <span className="panel-hint">
                Arrow keys to move · type an operator to adjust (200 then +500 → 700) · drag a header
                edge to resize
              </span>
            </div>
            <BucketTable
              rows={viewRows}
              totalWeight={totalWeight}
              sort={sort}
              columnWidths={columnWidths}
              onSort={handleSort}
              onPatch={patchRow}
              onWidths={setColumnWidths}
              onTotalWeight={changeTotalWeight}
              onTotalRtp={changeTotalRtp}
            />
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Distribution</h2>
            </div>
            <DistributionChart
              rows={viewRows}
              totalWeight={totalWeight}
              chart={chart}
              grouping={grouping}
              onChart={setChart}
              onPreview={setPreview}
              onCommit={handleDragCommit}
            />
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Simulation</h2>
              <span className="panel-hint">
                spins the current table with a fast Monte Carlo run — edits during a run don't
                change it
              </span>
            </div>
            <SimulationPanel
              rows={doc.rows}
              totalWeight={totalWeight}
              expectedRtp={achieved.rtp}
              spins={simSpins}
              onSpins={setSimSpins}
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
