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
  if (!open) return null
  const priority = normalizePriority(targets.priority)

  const move = (index: number, delta: -1 | 1) => {
    const next = [...priority]
    const j = index + delta
    if (j < 0 || j >= next.length) return
    ;[next[index], next[j]] = [next[j], next[index]]
    onTargets({ ...targets, priority: next })
  }

  return (
    <>
      {/* Click-away layer, like the paste overlay's backdrop dismissal. */}
      <div className="settings-backdrop" onClick={onClose} />
      <aside className="settings-drawer" role="dialog" aria-label="Settings">
        <div className="settings-head">
          <h2>Settings</h2>
          <button type="button" className="btn" onClick={onClose} aria-label="Close settings">
            ✕
          </button>
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
            everything.
          </p>
          <ol className="priority-list">
            {priority.map((key, i) => (
              <li className="priority-row" key={key}>
                <span className="priority-rank">{i + 1}</span>
                <span className="priority-label">{PRIORITY_LABELS[key]}</span>
                <button
                  type="button"
                  className="btn"
                  disabled={i === 0}
                  aria-label={`Raise ${PRIORITY_LABELS[key]}`}
                  onClick={() => move(i, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={i === priority.length - 1}
                  aria-label={`Lower ${PRIORITY_LABELS[key]}`}
                  onClick={() => move(i, 1)}
                >
                  ↓
                </button>
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
