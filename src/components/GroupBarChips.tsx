import type { GroupInfo } from '../lib/groups'

/**
 * Which groups are drawn as a single bar.
 *
 * Doubles as the legend the distribution chart has never had: one colored chip
 * per group, so the bar colors are named even when nothing is collapsed.
 *
 * Chips come from the *drawn* groups, not the document's group list — an empty
 * group has no bar to collapse. `groupBars` may still name an id that is not
 * drawn; `buildBars` ignores it, so a group emptied and refilled comes back
 * collapsed exactly as it was left.
 */

interface GroupBarChipsProps {
  groups: GroupInfo[]
  groupBars: string[]
  onGroupBars: (ids: string[]) => void
}

export function GroupBarChips({ groups, groupBars, onGroupBars }: GroupBarChipsProps) {
  if (groups.length === 0) return null
  const collapsed = new Set(groupBars)

  const toggle = (id: string) => {
    onGroupBars(
      collapsed.has(id) ? groupBars.filter((g) => g !== id) : [...groupBars, id],
    )
  }

  return (
    <div className="group-bar-chips">
      <span className="field-label">Group bars</span>
      <button type="button" className="btn" onClick={() => onGroupBars(groups.map((g) => g.id))}>
        All
      </button>
      <button type="button" className="btn" onClick={() => onGroupBars([])}>
        None
      </button>
      {groups.map((g) => {
        const on = collapsed.has(g.id)
        return (
          <button
            key={g.id}
            type="button"
            className={`group-bar-chip ${on ? 'on' : ''}`}
            aria-pressed={on}
            title={on ? `Show ${g.name}'s buckets` : `Draw ${g.name} as one bar`}
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
