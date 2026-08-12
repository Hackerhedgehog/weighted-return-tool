import type { TabRecord } from '../lib/storage'

/**
 * The tab strip above the app. Each tab is one independent workspace — its
 * own table, targets and view state — so different games' weights can sit
 * side by side and be compared without a second browser profile.
 *
 * The close control is a span with the button role, not a nested button:
 * a button inside a button is invalid HTML and browsers un-nest it, which
 * would detach the handler from the tab it belongs to.
 */

interface TabStripProps {
  tabs: TabRecord[]
  active: string
  onSelect: (id: string) => void
  onAdd: () => void
  onClose: (id: string) => void
}

export function TabStrip({ tabs, active, onSelect, onAdd, onClose }: TabStripProps) {
  return (
    <div className="tab-strip" role="tablist" aria-label="Workspaces">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === active}
          className={`tab ${t.id === active ? 'active' : ''}`}
          title={t.name}
          onClick={() => onSelect(t.id)}
        >
          <span className="tab-name">{t.name}</span>
          <span
            role="button"
            tabIndex={0}
            className="tab-close"
            aria-label={`Close ${t.name}`}
            onClick={(e) => {
              e.stopPropagation()
              onClose(t.id)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                onClose(t.id)
              }
            }}
          >
            ×
          </span>
        </button>
      ))}
      <button type="button" className="tab-add" aria-label="New tab" title="Open a new empty tab" onClick={onAdd}>
        +
      </button>
    </div>
  )
}
