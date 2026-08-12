import type { BridgeSession } from './bridge'
import type { TabsState, TabRecord } from './storage'

/**
 * Pure tab-list operations and the bridge-feed decision, kept out of the
 * component so both are testable without a DOM or a dev server.
 */

export function freshTabsState(): TabsState {
  return { version: 1, active: 't1', tabs: [{ id: 't1', name: 'Table 1', workspace: null }] }
}

/** An id no current tab holds. Ids only need to be unique within the record. */
export function nextTabId(tabs: TabRecord[]): string {
  const taken = new Set(tabs.map((t) => t.id))
  let n = tabs.length + 1
  while (taken.has(`t${n}`)) n += 1
  return `t${n}`
}

/** What a bridge feed names its tab: the file, scoped by the game when known. */
export function feedTabName(session: Pick<BridgeSession, 'game' | 'sourceFile'>): string {
  return session.game === '' ? session.sourceFile : `${session.game} · ${session.sourceFile}`
}

export function withNewTab(
  state: TabsState,
  name?: string,
): { state: TabsState; id: string } {
  const id = nextTabId(state.tabs)
  const tab: TabRecord = { id, name: name ?? `Table ${state.tabs.length + 1}`, workspace: null }
  return { state: { ...state, tabs: [...state.tabs, tab], active: id }, id }
}

/**
 * Closing the last tab replaces it with a fresh one — the strip is never
 * empty. Closing the active tab activates its left neighbour (or the new
 * first tab), matching what browsers do.
 */
export function withoutTab(state: TabsState, id: string): TabsState {
  const idx = state.tabs.findIndex((t) => t.id === id)
  if (idx === -1) return state

  const tabs = state.tabs.filter((t) => t.id !== id)
  if (tabs.length === 0) {
    // The replacement's id is derived from the list that still contains the
    // closed tab, so it can never equal the closed id — the view is keyed by
    // tab id, and reusing it would keep the closed tab's mounted state alive.
    const freshId = nextTabId(state.tabs)
    return {
      version: 1,
      active: freshId,
      tabs: [{ id: freshId, name: 'Table 1', workspace: null }],
      lastBridge: state.lastBridge,
    }
  }
  const active =
    state.active === id ? tabs[Math.max(0, idx - 1)].id : state.active
  return { ...state, tabs, active }
}

export type LoadPlan = 'skip' | 'overwrite' | 'new-tab'

/**
 * What to do with the session a page load fetched.
 *
 * A sessionId this record has not seen is a fresh CLI launch, and a fresh
 * launch loads into the active tab — the long-standing behaviour. Within a
 * known session, only a seq newer than the last one applied loads at all;
 * anything else is a plain page refresh, and reloading the source file over
 * in-progress tuning is exactly the accident this function exists to prevent.
 * A new feed applies however the CLI asked: over the current tab, or in a
 * fresh one.
 */
export function bridgeLoadPlan(
  last: TabsState['lastBridge'],
  session: Pick<BridgeSession, 'sessionId' | 'seq' | 'openAs'>,
): LoadPlan {
  const fresh = last === undefined || last.sessionId !== session.sessionId
  if (fresh) return 'overwrite'
  if (session.seq <= last.seq) return 'skip'
  return session.openAs
}
