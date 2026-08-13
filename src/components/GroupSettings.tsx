import { useState } from 'react'
import type { GroupDef } from '../lib/types'
import type { LockState } from '../lib/groups'
import { isSoftLocked } from '../lib/groupTargets'
import { evaluateExpression } from '../lib/expr'
import { PASTEL_COLORS } from '../lib/palette'
import { fmtPct } from '../lib/format'
import { remapNumpadComma } from './numpadDecimal'

/**
 * Create, rename, recolor and delete bucket groups, and edit each group's
 * demands on Auto-Distribute: a pinned chance (the same thing as the Σ soft
 * lock — hard rule) and a preferred weighted value (soft rule).
 *
 * Groups are seeded from the label heuristics once, when data is imported, and
 * are the user's from then on — this panel is where that ownership lives.
 * Auto-detect re-runs a *name* match on demand: unlocked buckets whose label
 * contains the group's name move into it. Deleting a group does not delete its
 * buckets: they move to the group named in `fallbackName`, so no row is ever
 * left pointing at nothing.
 */

export interface GroupStats {
  /** The group's share of total weight. */
  chance: number
  /** The group's RTP contribution: Σ payout·weight / total. */
  rtp: number
}

interface GroupSettingsProps {
  groups: GroupDef[]
  /** uid counts per group id, so a delete can say what it will move. */
  counts: Map<string, number>
  /** Per-group lock state, derived from the member rows' locks. */
  lockStates: Map<string, LockState>
  /** Achieved chance and RTP share per group id, for the demand fields' hints. */
  stats: Map<string, GroupStats>
  fallbackName: string
  onAdd: () => void
  onRename: (id: string, name: string) => void
  onRecolor: (id: string, color: string) => void
  onDelete: (id: string) => void
  onLock: (id: string, locked: boolean) => void
  /** The Σ toggle — pins the group's chance where it stands, or releases it. */
  onSoftLock: (id: string, locked: boolean) => void
  /** Chance demand — a fraction, or undefined to clear it (which also releases Σ). */
  onChance: (id: string, fraction: number | undefined) => void
  /** Weighted-value demand — a fraction of bet, or undefined to clear it. */
  onValue: (id: string, value: number | undefined) => void
  onAutoDetect: (id: string) => void
  onAutoDetectAll: () => void
}

/**
 * A labeled numeric field over an optional demand. Uncontrolled between
 * commits: typing must not push half-typed numbers into the document, and a
 * blank commit clears the demand rather than setting it to zero. Accepts the
 * same arithmetic every other numeric field does, comma-as-decimal included.
 */
function DemandField({
  label,
  value,
  scale,
  max,
  ariaLabel,
  title,
  placeholder,
  onCommit,
}: {
  label: string
  value: number | undefined
  /** 'percent' edits a fraction ×100 with a % unit; 'value' edits the number as it is stored. */
  scale: 'percent' | 'value'
  /** Upper bound on the edited scale — 100 for a chance, none for a value. */
  max?: number
  ariaLabel: string
  title: string
  placeholder: string
  onCommit: (v: number | undefined) => void
}) {
  // toPrecision keeps 0.3 editing as "30", never "30.000000000000004".
  const shown =
    value === undefined
      ? ''
      : String(Number((scale === 'percent' ? value * 100 : value).toPrecision(12)))
  const [text, setText] = useState(shown)
  // Re-sync when the committed value changes from outside (undo, another
  // field's clamp) — the adjust-during-render form, not an effect, so the
  // stale text never paints.
  const [lastShown, setLastShown] = useState(shown)
  if (shown !== lastShown) {
    setLastShown(shown)
    setText(shown)
  }

  const commit = () => {
    const raw = text.trim().replace(/%$/, '')
    if (raw === '') {
      onCommit(undefined)
      return
    }
    const n = evaluateExpression(raw)
    if (n === null || n < 0 || (max !== undefined && n > max)) {
      setText(shown)
      return
    }
    onCommit(scale === 'percent' ? n / 100 : n)
  }

  return (
    <label className="group-pref" title={title}>
      <span className="group-pref-label">{label}</span>
      <input
        className="panel-num group-pref-num"
        value={text}
        aria-label={ariaLabel}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (remapNumpadComma(e)) {
            setText(e.currentTarget.value)
            return
          }
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setText(shown)
        }}
      />
      {scale === 'percent' && <span className="group-pref-unit">%</span>}
    </label>
  )
}

export function GroupSettings({
  groups,
  counts,
  lockStates,
  stats,
  fallbackName,
  onAdd,
  onRename,
  onRecolor,
  onDelete,
  onLock,
  onSoftLock,
  onChance,
  onValue,
  onAutoDetect,
  onAutoDetectAll,
}: GroupSettingsProps) {
  return (
    <div className="group-settings">
      <div className="group-list">
        {groups.map((g) => {
          const n = counts.get(g.id) ?? 0
          const state = lockStates.get(g.id) ?? 'none'
          const s = stats.get(g.id)
          const soft = isSoftLocked(g)
          return (
            <div className="group-row" key={g.id}>
              <div className="group-row-main">
                <span className="group-chip" style={{ background: g.color }} aria-hidden="true" />
                <button
                  type="button"
                  className={`group-lock ${state === 'all' ? 'on' : ''} ${state === 'some' ? 'partial' : ''}`}
                  disabled={n === 0}
                  aria-label={`${state === 'all' ? 'Unlock' : 'Lock'} the ${g.name} group`}
                  title={
                    n === 0
                      ? 'No buckets to lock'
                      : state === 'all'
                        ? 'Unlock every bucket in this group'
                        : state === 'some'
                          ? 'Some buckets are locked — lock the rest'
                          : 'Lock every bucket in this group'
                  }
                  onClick={() => onLock(g.id, state !== 'all')}
                >
                  {state === 'all' ? '🔒' : '🔓'}
                </button>
                <button
                  type="button"
                  className={`group-lock group-total-lock ${soft ? 'on' : ''}`}
                  disabled={n === 0}
                  aria-pressed={soft}
                  aria-label={`${soft ? 'Release' : 'Soft-lock'} the ${g.name} group's chance`}
                  title={
                    n === 0
                      ? 'No buckets whose total could be locked'
                      : soft
                        ? 'Release the group — its chance demand is cleared and Auto-Distribute may move it again'
                        : 'Soft lock: pin the group at its current chance (fills the Chance field) while the weights inside stay editable'
                  }
                  onClick={() => onSoftLock(g.id, !soft)}
                >
                  Σ
                </button>
                <input
                  className="panel-num group-name"
                  value={g.name}
                  aria-label={`Name of group ${g.name}`}
                  spellCheck={false}
                  onChange={(e) => onRename(g.id, e.target.value)}
                />
                <button
                  type="button"
                  className="btn"
                  disabled={g.name.trim() === ''}
                  aria-label={`Auto-detect buckets for group ${g.name}`}
                  title={`Move unlocked buckets whose label contains "${g.name}" into this group`}
                  onClick={() => onAutoDetect(g.id)}
                >
                  Auto-detect
                </button>
                <div
                  className="swatches"
                  role="radiogroup"
                  aria-label={`Color of group ${g.name}`}
                >
                  {PASTEL_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      role="radio"
                      aria-checked={c.toLowerCase() === g.color.toLowerCase()}
                      aria-label={c}
                      className={`swatch ${c.toLowerCase() === g.color.toLowerCase() ? 'active' : ''}`}
                      style={{ background: c }}
                      onClick={() => onRecolor(g.id, c)}
                    />
                  ))}
                </div>
                <span className="field-hint group-count">
                  {n} bucket{n === 1 ? '' : 's'}
                </span>
                <button
                  type="button"
                  className="btn danger"
                  aria-label={`Delete group ${g.name}`}
                  disabled={groups.length <= 1}
                  title={
                    groups.length <= 1
                      ? 'The last group cannot be deleted'
                      : n > 0
                        ? `Moves ${n} bucket${n === 1 ? '' : 's'} to ${fallbackName}`
                        : 'Delete this group'
                  }
                  onClick={() => onDelete(g.id)}
                >
                  Delete
                </button>
              </div>
              <div className="group-row-demands">
                <DemandField
                  label="Chance"
                  value={g.prefChance}
                  scale="percent"
                  max={100}
                  ariaLabel={`Preferred chance of group ${g.name}`}
                  title={`The group's share of total weight — a hard rule Auto-Distribute meets exactly, and the same thing as the Σ soft lock. Blank = no demand.${s === undefined ? '' : ` Now ${fmtPct(s.chance, 2)}.`}`}
                  placeholder={s === undefined ? 'chance' : fmtPct(s.chance, 2).replace('%', '')}
                  onCommit={(v) => onChance(g.id, v)}
                />
                <DemandField
                  label="Weighted value"
                  value={g.prefRtp}
                  scale="value"
                  ariaLabel={`Preferred weighted value of group ${g.name}`}
                  title={`The group's weighted value (its RTP contribution) — a soft rule; Auto-Distribute warns when it cannot land within 0.001. Blank = no demand.${s === undefined ? '' : ` Now ${s.rtp.toFixed(4)}.`}`}
                  placeholder={s === undefined ? 'value' : s.rtp.toFixed(4)}
                  onCommit={(v) => onValue(g.id, v)}
                />
              </div>
            </div>
          )
        })}
      </div>

      <div className="group-actions">
        <button type="button" className="btn" onClick={onAdd}>
          + Add group
        </button>
        <button
          type="button"
          className="btn"
          title="Assign every unlocked bucket to the group whose name appears in its label — the longest matching name wins"
          onClick={onAutoDetectAll}
        >
          Auto-detect all
        </button>
        <span className="field-hint">
          Groups are detected from the labels when data is imported, then kept as you edit them.
          Setting a chance pins the group's share exactly (that is the Σ soft lock); the weighted
          value is a preference Auto-Distribute warns about when it cannot be met.
        </span>
      </div>
    </div>
  )
}
