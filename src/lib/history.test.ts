import { describe, it, expect } from 'vitest'
import { emptyHistory, HISTORY_LIMIT, pushHistory, redo, undo } from './history'

describe('history', () => {
  it('starts empty', () => {
    const h = emptyHistory<string>()
    expect(h.past).toHaveLength(0)
    expect(h.future).toHaveLength(0)
    expect(undo(h, 'x')).toBeNull()
    expect(redo(h, 'x')).toBeNull()
  })

  it('holds 100 steps, capping there and dropping the oldest entry', () => {
    expect(HISTORY_LIMIT).toBe(100)
    let h = emptyHistory<number>()
    for (let i = 0; i < 150; i++) h = pushHistory(h, i)
    expect(h.past).toHaveLength(100)
    expect(h.past[0]).toBe(50)
    expect(h.past.at(-1)).toBe(149)
  })

  it('round-trips undo and redo', () => {
    const h = pushHistory(emptyHistory<string>(), 'a')
    const back = undo(h, 'b')!
    expect(back.present).toBe('a')

    const forward = redo(back.history, back.present)!
    expect(forward.present).toBe('b')
  })

  it('walks back through several steps', () => {
    let h = emptyHistory<string>()
    h = pushHistory(h, 'a')
    h = pushHistory(h, 'b')

    const one = undo(h, 'c')!
    expect(one.present).toBe('b')
    const two = undo(one.history, one.present)!
    expect(two.present).toBe('a')
    expect(undo(two.history, two.present)).toBeNull()
  })

  it('clears the redo stack when a new mutation lands', () => {
    const back = undo(pushHistory(emptyHistory<string>(), 'a'), 'b')!
    expect(back.history.future).toHaveLength(1)
    expect(pushHistory(back.history, 'c').future).toHaveLength(0)
  })

  it('does not mutate the history it is given', () => {
    const h = pushHistory(emptyHistory<string>(), 'a')
    const snapshot = { past: [...h.past], future: [...h.future] }
    undo(h, 'b')
    pushHistory(h, 'c')
    expect(h).toEqual(snapshot)
  })
})
