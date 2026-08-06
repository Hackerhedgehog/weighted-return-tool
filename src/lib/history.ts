/**
 * Bounded undo/redo over whole-document snapshots.
 *
 * Snapshots rather than diffs: the document is one small object, and every
 * mutation already routes through a single commit point, so there is nothing
 * to gain from patch tracking and a lot of correctness to lose.
 *
 * Cells commit on Enter or blur rather than per keystroke, so one edit is
 * naturally one history entry — no debouncing or coalescing needed.
 */

export interface HistoryState<T> {
  past: T[]
  future: T[]
}

export const HISTORY_LIMIT = 20

export function emptyHistory<T>(): HistoryState<T> {
  return { past: [], future: [] }
}

/** Record the current document before replacing it. Discards any redo stack. */
export function pushHistory<T>(h: HistoryState<T>, present: T): HistoryState<T> {
  return { past: [...h.past, present].slice(-HISTORY_LIMIT), future: [] }
}

export function undo<T>(
  h: HistoryState<T>,
  present: T,
): { history: HistoryState<T>; present: T } | null {
  if (h.past.length === 0) return null
  return {
    history: {
      past: h.past.slice(0, -1),
      future: [present, ...h.future].slice(0, HISTORY_LIMIT),
    },
    present: h.past[h.past.length - 1],
  }
}

export function redo<T>(
  h: HistoryState<T>,
  present: T,
): { history: HistoryState<T>; present: T } | null {
  if (h.future.length === 0) return null
  return {
    history: {
      past: [...h.past, present].slice(-HISTORY_LIMIT),
      future: h.future.slice(1),
    },
    present: h.future[0],
  }
}
