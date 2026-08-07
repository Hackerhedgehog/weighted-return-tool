import type { GroupDef } from '../lib/types'
import { PASTEL_COLORS } from '../lib/palette'

/**
 * Create, rename, recolor and delete bucket groups.
 *
 * Groups are seeded from the label heuristics once, when data is imported, and
 * are the user's from then on — this panel is where that ownership lives.
 * Deleting a group does not delete its buckets: they move to the group named
 * in `fallbackName`, so no row is ever left pointing at nothing.
 */

interface GroupSettingsProps {
  groups: GroupDef[]
  /** uid counts per group id, so a delete can say what it will move. */
  counts: Map<string, number>
  fallbackName: string
  onAdd: () => void
  onRename: (id: string, name: string) => void
  onRecolor: (id: string, color: string) => void
  onDelete: (id: string) => void
}

export function GroupSettings({
  groups,
  counts,
  fallbackName,
  onAdd,
  onRename,
  onRecolor,
  onDelete,
}: GroupSettingsProps) {
  return (
    <div className="group-settings">
      <div className="group-list">
        {groups.map((g) => {
          const n = counts.get(g.id) ?? 0
          return (
            <div className="group-row" key={g.id}>
              <span className="group-chip" style={{ background: g.color }} aria-hidden="true" />
              <input
                className="panel-num group-name"
                value={g.name}
                aria-label={`Name of group ${g.name}`}
                spellCheck={false}
                onChange={(e) => onRename(g.id, e.target.value)}
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
          Groups are detected from the labels when data is imported, then kept as you edit them.
        </span>
      </div>
    </div>
  )
}
