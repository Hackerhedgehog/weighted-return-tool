import type { GroupInfo } from '../lib/groups'

/**
 * A row of toggle chips, one per group, over a set of selected group ids.
 *
 * Doubles as the legend neither the chart nor the table has otherwise: one
 * colored chip per group, so the colors are named even when nothing is
 * selected. Chips come from the *drawn* groups, not the document's group list —
 * an empty group has nothing to collapse. The selection may still name an id
 * that is not drawn; consumers ignore it, so a group emptied and refilled comes
 * back exactly as it was left.
 */

interface GroupChipsProps {
  groups: GroupInfo[]
  selected: string[]
  onSelected: (ids: string[]) => void
  /** Row label — what selecting a chip means here. */
  label: string
  titleOn: (name: string) => string
  titleOff: (name: string) => string
}

export function GroupChips({
  groups,
  selected,
  onSelected,
  label,
  titleOn,
  titleOff,
}: GroupChipsProps) {
  if (groups.length === 0) return null
  const on = new Set(selected)

  const toggle = (id: string) => {
    onSelected(on.has(id) ? selected.filter((g) => g !== id) : [...selected, id])
  }

  return (
    <div className="group-bar-chips">
      <span className="field-label">{label}</span>
      <button type="button" className="btn" onClick={() => onSelected(groups.map((g) => g.id))}>
        All
      </button>
      <button type="button" className="btn" onClick={() => onSelected([])}>
        None
      </button>
      {groups.map((g) => {
        const active = on.has(g.id)
        return (
          <button
            key={g.id}
            type="button"
            className={`group-bar-chip ${active ? 'on' : ''}`}
            aria-pressed={active}
            title={active ? titleOn(g.name) : titleOff(g.name)}
            onClick={() => toggle(g.id)}
          >
            <span className="chip-swatch" style={{ background: g.color }} aria-hidden="true" />
            {g.name}
          </button>
        )
      })}
    </div>
  )
}
