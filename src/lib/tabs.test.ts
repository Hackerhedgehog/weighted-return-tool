import { describe, it, expect } from 'vitest'
import type { TabsState } from './storage'
import {
  bridgeLoadPlan,
  feedTabName,
  freshTabsState,
  nextTabId,
  placeFeeds,
  withNewTab,
  withoutTab,
} from './tabs'

const state = (ids: string[], active = ids[0]): TabsState => ({
  version: 1,
  active,
  tabs: ids.map((id) => ({ id, name: id, workspace: null })),
})

describe('nextTabId', () => {
  it('skips ids already in use', () => {
    expect(nextTabId(state(['t1', 't2']).tabs)).toBe('t3')
    expect(nextTabId(state(['t1', 't3']).tabs)).toBe('t4')
    expect(nextTabId([])).toBe('t1')
  })
})

describe('feedTabName', () => {
  it('scopes the file by the game when one is known', () => {
    expect(feedTabName({ game: 'joker', sourceFile: 'set-values-regular.tsv' })).toBe(
      'joker · set-values-regular.tsv',
    )
    expect(feedTabName({ game: '', sourceFile: 'a.tsv' })).toBe('a.tsv')
  })
})

describe('withNewTab', () => {
  it('appends and activates the new tab', () => {
    const { state: next, id } = withNewTab(state(['t1']))
    expect(next.tabs.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(next.active).toBe(id)
  })

  it('names a feed tab after the feed', () => {
    const { state: next } = withNewTab(state(['t1']), 'game · file.tsv')
    expect(next.tabs[1].name).toBe('game · file.tsv')
  })
})

describe('withoutTab', () => {
  it('activates the left neighbour when the active tab closes', () => {
    const next = withoutTab(state(['t1', 't2', 't3'], 't2'), 't2')
    expect(next.tabs.map((t) => t.id)).toEqual(['t1', 't3'])
    expect(next.active).toBe('t1')
  })

  it('keeps the active tab when another closes', () => {
    const next = withoutTab(state(['t1', 't2'], 't1'), 't2')
    expect(next.active).toBe('t1')
  })

  it('replaces the last tab with a fresh one instead of an empty strip', () => {
    const next = withoutTab(
      { ...state(['t9'], 't9'), lastBridge: { sessionId: 's', seq: 2 } },
      't9',
    )
    expect(next.tabs).toHaveLength(1)
    expect(next.tabs[0].workspace).toBeNull()
    expect(next.active).toBe(next.tabs[0].id)
    // A reused id would keep the closed tab's mounted view alive — the view
    // is keyed by tab id and only a new key remounts it.
    expect(next.tabs[0].id).not.toBe('t9')
    // The feed bookkeeping survives — closing tabs is not a new CLI launch.
    expect(next.lastBridge).toEqual({ sessionId: 's', seq: 2 })
  })

  it('ignores an unknown id', () => {
    const s = state(['t1'])
    expect(withoutTab(s, 'nope')).toBe(s)
  })
})

describe('bridgeLoadPlan', () => {
  const session = { sessionId: 'abc', seq: 2, openAs: 'new-tab' as const }

  it('loads into the active tab on a fresh CLI launch', () => {
    expect(bridgeLoadPlan(undefined, session)).toBe('overwrite')
    expect(bridgeLoadPlan({ sessionId: 'other', seq: 99 }, session)).toBe('overwrite')
  })

  it('skips a seq it has already applied — a refresh must not clobber tuning', () => {
    expect(bridgeLoadPlan({ sessionId: 'abc', seq: 2 }, session)).toBe('skip')
    expect(bridgeLoadPlan({ sessionId: 'abc', seq: 5 }, session)).toBe('skip')
  })

  it('applies a new feed the way the CLI asked', () => {
    expect(bridgeLoadPlan({ sessionId: 'abc', seq: 1 }, session)).toBe('new-tab')
    expect(bridgeLoadPlan({ sessionId: 'abc', seq: 1 }, { ...session, openAs: 'overwrite' })).toBe(
      'overwrite',
    )
  })
})

describe('freshTabsState', () => {
  it('starts with one empty active tab', () => {
    const s = freshTabsState()
    expect(s.tabs).toHaveLength(1)
    expect(s.active).toBe(s.tabs[0].id)
    expect(s.tabs[0].workspace).toBeNull()
  })
})

describe('placeFeeds', () => {
  const feeds = [
    { game: 'imp', sourceFile: 'set-values-regular.tsv' },
    { game: 'imp', sourceFile: 'set-values-buy-bonus.tsv' },
    { game: 'imp', sourceFile: 'ref-weights-regular.tsv' },
  ]

  it('overwrite: first feed takes the active tab, the rest open new tabs', () => {
    const { state: next, placements } = placeFeeds(state(['t1', 't2'], 't2'), feeds, 'overwrite')
    expect(placements.map((p) => p.tabId)).toEqual(['t2', 't3', 't4'])
    expect(placements.map((p) => p.feedIndex)).toEqual([0, 1, 2])
    expect(next.tabs.map((t) => t.name)).toEqual([
      't1',
      'imp · set-values-regular.tsv',
      'imp · set-values-buy-bonus.tsv',
      'imp · ref-weights-regular.tsv',
    ])
  })

  it('new-tab: every feed opens a new tab, existing tabs untouched', () => {
    const { state: next, placements } = placeFeeds(state(['t1'], 't1'), feeds, 'new-tab')
    expect(placements.map((p) => p.tabId)).toEqual(['t2', 't3', 't4'])
    expect(next.tabs.map((t) => t.id)).toEqual(['t1', 't2', 't3', 't4'])
    expect(next.tabs[0].name).toBe('t1')
  })

  it('activates the first placement — feeds apply head-first through the active tab', () => {
    const over = placeFeeds(state(['t1', 't2'], 't2'), feeds, 'overwrite')
    expect(over.state.active).toBe('t2')
    const fresh = placeFeeds(state(['t1'], 't1'), feeds, 'new-tab')
    expect(fresh.state.active).toBe('t2')
  })

  it('a single feed behaves exactly like the old single-file paths', () => {
    const one = [feeds[0]]
    const over = placeFeeds(state(['t1'], 't1'), one, 'overwrite')
    expect(over.state.tabs.map((t) => t.id)).toEqual(['t1'])
    expect(over.state.tabs[0].name).toBe('imp · set-values-regular.tsv')
    expect(over.placements).toEqual([{ tabId: 't1', feedIndex: 0 }])

    const tab = placeFeeds(state(['t1'], 't1'), one, 'new-tab')
    expect(tab.state.tabs.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(tab.state.active).toBe('t2')
  })
})
