import { useState } from 'react'
import type { GroupDef } from '../lib/types'
import type { LockState } from '../lib/groups'
import { PASTEL_COLORS } from '../lib/palette'
import { fmtPct } from '../lib/format'

/**
 * Create, rename, recolor and delete bucket groups, and edit each group's
 * demands on Auto-Distribute: a locked total, a preferred chance, a preferred
 * RTP share.
 *
 * Groups are seeded from the label heuristics once, when data is imported, and
 * are the user's from then on — this panel is where that ownership lives.
 * Deleting a group does not delete its buckets: they move to the group named
 * in `fallbackName`, so no row is ever left pointing at nothing.
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
  onPatch: (id: string, patch: Partial<GroupDef>) => void
}

/**
 * A percent-scale field over an optional fraction. Uncontrolled between
 * commits: typing must not push half-typed numbers into the document, and a
 * blank commit clears the demand rather than setting it to zero.
 */
function PercentField({
  value,
  max,
  ariaLabel,
  title,
  placeholder,
  onCommit,
}: {
  value: number | undefined
  /** Upper bound on the percent scale — 100 for a chance, none for RTP. */
  max?: number
  ariaLabel: string
  title: string
  placeholder: string
  onCommit: (fraction: number | undefined) => void
}) {
  // toPrecision keeps 0.3 editing as "30", never "30.000000000000004".
  const shown = value === undefined ? '' : String(Number((value * 100).toPrecision(12)))
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
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0 || (max !== undefined && n > max)) {
      setText(shown)
      return
    }
    onCommit(n / 100)
  }

  return (
    <span className="group-pref">
      <input
        className="panel-num group-pref-num"
        value={text}
        aria-label={ariaLabel}
        title={title}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setText(shown)
        }}
      />
      <span className="group-pref-unit">%</span>
    </span>
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
  onPatch,
}: GroupSettingsProps) {
  return (
    <div className="group-settings">
      <div className="group-list">
        {groups.map((g) => {
          const n = counts.get(g.id) ?? 0
          const state = lockStates.get(g.id) ?? 'none'
          const s = stats.get(g.id)
          return (
            <div className="group-row" key={g.id}>
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
                className={`group-lock group-total-lock ${g.totalLocked === true ? 'on' : ''}`}
                disabled={n === 0}
                aria-pressed={g.totalLocked === true}
                aria-label={`${g.totalLocked === true ? 'Unlock' : 'Lock'} the ${g.name} group's total weight`}
                title={
                  n === 0
                    ? 'No buckets whose total could be locked'
                    : g.totalLocked === true
                      ? 'Unlock the group total — Auto-Distribute and edits may move it again'
                      : 'Lock the group total: its chance stays fixed while the weights inside stay editable'
                }
                onClick={() => onPatch(g.id, { totalLocked: g.totalLocked !== true })}
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
              <PercentField
                value={g.prefChance}
                max={100}
                ariaLabel={`Preferred chance of group ${g.name}`}
                title={`Preferred share of total weight for this group — Auto-Distribute sets it exactly. Blank = no preference.${s === undefined ? '' : ` Now ${fmtPct(s.chance, 2)}.`}`}
                placeholder={s === undefined ? 'chance' : fmtPct(s.chance, 2).replace('%', '')}
                onCommit={(v) => onPatch(g.id, { prefChance: v })}
              />
              <PercentField
                value={g.prefRtp}
                ariaLabel={`Preferred RTP share of group ${g.name}`}
                title={`Preferred RTP contribution from this group — Auto-Distribute tilts its members toward it. Blank = no preference.${s === undefined ? '' : ` Now ${fmtPct(s.rtp, 2)}.`}`}
                placeholder={s === undefined ? 'rtp' : fmtPct(s.rtp, 2).replace('%', '')}
                onCommit={(v) => onPatch(g.id, { prefRtp: v })}
              />
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
          )
        })}
      </div>

      <div className="group-actions">
        <button type="button" className="btn" onClick={onAdd}>
          + Add group
        </button>
        <span className="field-hint">
          Groups are detected from the labels when data is imported, then kept as you edit them. Σ
          locks a group's total weight; the chance and RTP fields are preferences Auto-Distribute
          maintains.
        </span>
      </div>
    </div>
  )
}
