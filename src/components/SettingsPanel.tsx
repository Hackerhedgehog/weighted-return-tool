import { useRef, useState } from 'react'
import {
  normalizePriority,
  PRIORITY_LABELS,
  WEIGHT_STEPS,
  type GroupDef,
  type Targets,
  type WeightStep,
} from '../lib/types'
import type { LockState } from '../lib/groups'
import { GroupSettings, type GroupStats } from './GroupSettings'

/**
 * The settings drawer: bucket groups, the solver's conflict-priority ranking
 * and the weight step. A side panel rather than more fields in the targets
 * row — the row is for the numbers being tuned constantly, this is for how
 * the table and the solver behave, set up once per table and then left alone.
 */

interface SettingsPanelProps {
  open: boolean
  /** Docked beside the content instead of floating over it — see onLocked. */
  locked: boolean
  onLocked: (locked: boolean) => void
  targets: Targets
  weightStep: WeightStep
  groups: GroupDef[]
  groupCounts: Map<string, number>
  groupLockStates: Map<string, LockState>
  groupStats: Map<string, GroupStats>
  onTargets: (t: Targets) => void
  onWeightStep: (s: WeightStep) => void
  onGroupAdd: () => void
  onGroupRename: (id: string, name: string) => void
  onGroupRecolor: (id: string, color: string) => void
  onGroupDelete: (id: string) => void
  onGroupLock: (id: string, locked: boolean) => void
  onGroupSoftLock: (id: string, locked: boolean) => void
  onGroupChance: (id: string, fraction: number | undefined) => void
  onGroupValue: (id: string, value: number | undefined) => void
  onGroupAutoDetect: (id: string) => void
  onGroupAutoDetectAll: () => void
  onClose: () => void
}

export function SettingsPanel({
  open,
  locked,
  onLocked,
  targets,
  weightStep,
  groups,
  groupCounts,
  groupLockStates,
  groupStats,
  onTargets,
  onWeightStep,
  onGroupAdd,
  onGroupRename,
  onGroupRecolor,
  onGroupDelete,
  onGroupLock,
  onGroupSoftLock,
  onGroupChance,
  onGroupValue,
  onGroupAutoDetect,
  onGroupAutoDetectAll,
  onClose,
}: SettingsPanelProps) {
  return open ? (
    <SettingsPanelBody
      {...{
        locked,
        onLocked,
        targets,
        weightStep,
        groups,
        groupCounts,
        groupLockStates,
        groupStats,
        onTargets,
        onWeightStep,
        onGroupAdd,
        onGroupRename,
        onGroupRecolor,
        onGroupDelete,
        onGroupLock,
        onGroupSoftLock,
        onGroupChance,
        onGroupValue,
        onGroupAutoDetect,
        onGroupAutoDetectAll,
        onClose,
      }}
    />
  ) : null
}

function SettingsPanelBody({
  locked,
  onLocked,
  targets,
  weightStep,
  groups,
  groupCounts,
  groupLockStates,
  groupStats,
  onTargets,
  onWeightStep,
  onGroupAdd,
  onGroupRename,
  onGroupRecolor,
  onGroupDelete,
  onGroupLock,
  onGroupSoftLock,
  onGroupChance,
  onGroupValue,
  onGroupAutoDetect,
  onGroupAutoDetectAll,
  onClose,
}: Omit<SettingsPanelProps, 'open'>) {
  const priority = normalizePriority(targets.priority)

  // Pointer drag over the list reorders it: the grip anchors the gesture and
  // the row under the pointer (by even division of the list's height) is
  // where the dragged row would land. Committed once, on release.
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const listRef = useRef<HTMLOListElement>(null)

  const indexAt = (y: number): number | null => {
    const el = listRef.current
    if (el === null) return null
    const rect = el.getBoundingClientRect()
    const rowH = (rect.bottom - rect.top) / Math.max(1, priority.length)
    return Math.max(
      0,
      Math.min(priority.length - 1, Math.floor((y - rect.top) / Math.max(1, rowH))),
    )
  }

  const onGripDown = (e: React.PointerEvent, i: number) => {
    if (e.button !== 0) return
    e.preventDefault()
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    setDragFrom(i)
    setDragOver(i)
  }

  const onGripMove = (e: React.PointerEvent) => {
    if (dragFrom === null) return
    const i = indexAt(e.clientY)
    if (i !== null) setDragOver(i)
  }

  const onGripUp = () => {
    if (dragFrom !== null && dragOver !== null && dragFrom !== dragOver) {
      const next = [...priority]
      const [moved] = next.splice(dragFrom, 1)
      next.splice(dragOver, 0, moved)
      onTargets({ ...targets, priority: next })
    }
    setDragFrom(null)
    setDragOver(null)
  }

  // The list previews the drop while the pointer moves, so the user sees the
  // order they are about to commit rather than a static list plus a marker.
  const previewOrder = (() => {
    if (dragFrom === null || dragOver === null || dragFrom === dragOver) return priority
    const next = [...priority]
    const [moved] = next.splice(dragFrom, 1)
    next.splice(dragOver, 0, moved)
    return next
  })()

  return (
    <>
      {/* Click-away layer, like the paste overlay's backdrop dismissal — moot
          once the drawer is docked, since there is nothing left to click away
          from (the rest of the app has already moved aside for it). */}
      {!locked && <div className="settings-backdrop" onClick={onClose} />}
      <aside
        className={`settings-drawer ${locked ? 'docked' : ''}`}
        role="dialog"
        aria-label="Settings"
      >
        <div className="settings-head">
          <h2>Settings</h2>
          <div className="settings-head-actions">
            <button
              type="button"
              className={`btn gear-btn ${locked ? 'primary' : ''}`}
              aria-pressed={locked}
              onClick={() => onLocked(!locked)}
              title={
                locked ? 'Unpin — back to a floating panel' : 'Pin — dock this panel on the right, always visible'
              }
            >
              📌
            </button>
            <button type="button" className="btn" onClick={onClose} aria-label="Close settings">
              ✕
            </button>
          </div>
        </div>

        <div className="settings-section">
          <h3>Groups</h3>
          <p className="field-hint">colors drive the chart bars and the table row tints</p>
          <GroupSettings
            groups={groups}
            counts={groupCounts}
            lockStates={groupLockStates}
            stats={groupStats}
            fallbackName={groups[0]?.name ?? ''}
            onAdd={onGroupAdd}
            onRename={onGroupRename}
            onRecolor={onGroupRecolor}
            onDelete={onGroupDelete}
            onLock={onGroupLock}
            onSoftLock={onGroupSoftLock}
            onChance={onGroupChance}
            onValue={onGroupValue}
            onAutoDetect={onGroupAutoDetect}
            onAutoDetectAll={onGroupAutoDetectAll}
          />
        </div>

        <div className="settings-section">
          <h3>Priority order</h3>
          <p className="field-hint">
            When two targets cannot both hold, the lower one yields. Locks always outrank
            everything. Drag the ≡ grip to reorder.
          </p>
          <ol className="priority-list" ref={listRef}>
            {previewOrder.map((key, i) => (
              <li
                className={`priority-row ${dragFrom !== null && priority[dragFrom] === key ? 'dragging' : ''}`}
                key={key}
              >
                <span
                  className="priority-grip"
                  role="button"
                  tabIndex={0}
                  aria-label={`Drag to reorder ${PRIORITY_LABELS[key]}`}
                  title="Drag to reorder"
                  onPointerDown={(e) => onGripDown(e, priority.indexOf(key))}
                  onPointerMove={onGripMove}
                  onPointerUp={onGripUp}
                  onPointerCancel={onGripUp}
                >
                  ≡
                </span>
                <span className="priority-rank">{i + 1}</span>
                <span className="priority-label">{PRIORITY_LABELS[key]}</span>
              </li>
            ))}
          </ol>
          <button
            type="button"
            className="link-btn"
            onClick={() => onTargets({ ...targets, priority: normalizePriority(undefined) })}
          >
            Reset to default
          </button>
        </div>

        <div className="settings-section">
          <h3>Weight step</h3>
          <div className="seg small">
            {WEIGHT_STEPS.map((s) => (
              <button
                key={s}
                type="button"
                className={`seg-btn ${weightStep === s ? 'active' : ''}`}
                onClick={() => onWeightStep(s)}
                title={s === 1 ? 'Weights land on any integer' : `Distributed weights land on multiples of ${s}`}
              >
                {s === 1 ? 'free' : `×${s}`}
              </button>
            ))}
          </div>
          <p className="field-hint">typed cells are never snapped</p>
        </div>
      </aside>
    </>
  )
}
