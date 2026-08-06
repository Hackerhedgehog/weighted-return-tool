import { useCallback, useState } from 'react'

export interface CellPos {
  row: number
  col: number
}

/**
 * What an edit session starts with.
 *  - raw: the cell's underlying value (Enter, F2, double-click)
 *  - replace: a typed character wipes the cell, as in a spreadsheet
 *  - append: a typed operator extends the cell, so selecting 200 and typing
 *    "+500" gives "200+500". This is the whole point of the arithmetic
 *    feature — nudging a weight without retyping it.
 */
export type EditSeed =
  | { mode: 'raw' }
  | { mode: 'replace'; text: string }
  | { mode: 'append'; text: string }

interface Options {
  rowCount: number
  colCount: number
  /** Operators append on numeric cells; everything else replaces. */
  isNumericCol: (col: number) => boolean
  isLockCol: (col: number) => boolean
  /**
   * Read-only cells must never enter edit mode: the cell would render as idle
   * while the hook believed it was editing, and every subsequent key would be
   * swallowed.
   */
  isEditable: (pos: CellPos) => boolean
  onDelete: (pos: CellPos) => void
  onToggleLock: (row: number) => void
  pageSize?: number
}

export interface GridNav {
  sel: CellPos
  editing: boolean
  seed: EditSeed
  select: (pos: CellPos) => void
  startEdit: (seed: EditSeed) => void
  stopEdit: () => void
  navigate: (dr: number, dc: number) => void
  /** Attach to each idle cell; the editing input handles its own keys. */
  handleKeyDown: (e: React.KeyboardEvent) => void
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

export function useGridNavigation(opts: Options): GridNav {
  const {
    rowCount,
    colCount,
    isNumericCol,
    isLockCol,
    isEditable,
    onDelete,
    onToggleLock,
  } = opts
  const pageSize = opts.pageSize ?? 12

  const [sel, setSel] = useState<CellPos>({ row: 0, col: 0 })
  const [editing, setEditing] = useState(false)
  const [seed, setSeed] = useState<EditSeed>({ mode: 'raw' })

  const select = useCallback(
    (pos: CellPos) => {
      setSel({
        row: clamp(pos.row, 0, Math.max(0, rowCount - 1)),
        col: clamp(pos.col, 0, Math.max(0, colCount - 1)),
      })
    },
    [rowCount, colCount],
  )

  const navigate = useCallback(
    (dr: number, dc: number) => {
      setEditing(false)
      setSel((p) => ({
        row: clamp(p.row + dr, 0, Math.max(0, rowCount - 1)),
        col: clamp(p.col + dc, 0, Math.max(0, colCount - 1)),
      }))
    },
    [rowCount, colCount],
  )

  /** Tab moves in reading order, wrapping across row boundaries. */
  const step = useCallback(
    (delta: number) => {
      setEditing(false)
      setSel((p) => {
        const last = rowCount * colCount - 1
        if (last < 0) return p
        const idx = clamp(p.row * colCount + p.col + delta, 0, last)
        return { row: Math.floor(idx / colCount), col: idx % colCount }
      })
    },
    [rowCount, colCount],
  )

  const startEdit = useCallback((s: EditSeed) => {
    setSeed(s)
    setEditing(true)
  }, [])

  const stopEdit = useCallback(() => {
    setEditing(false)
    setSeed({ mode: 'raw' })
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (editing) return

      const k = e.key
      const mod = e.ctrlKey || e.metaKey

      // Undo/redo is handled once at the window level. Doing it here as well
      // would fire twice, since an idle cell is a div and the event bubbles.

      switch (k) {
        case 'ArrowUp':
          e.preventDefault()
          navigate(-1, 0)
          return
        case 'ArrowDown':
          e.preventDefault()
          navigate(1, 0)
          return
        case 'ArrowLeft':
          e.preventDefault()
          navigate(0, -1)
          return
        case 'ArrowRight':
          e.preventDefault()
          navigate(0, 1)
          return
        case 'Tab':
          e.preventDefault()
          step(e.shiftKey ? -1 : 1)
          return
        case 'PageUp':
          e.preventDefault()
          navigate(-pageSize, 0)
          return
        case 'PageDown':
          e.preventDefault()
          navigate(pageSize, 0)
          return
        case 'Home':
          e.preventDefault()
          if (mod) select({ row: 0, col: 0 })
          else setSel((p) => ({ ...p, col: 0 }))
          return
        case 'End':
          e.preventDefault()
          if (mod) select({ row: rowCount - 1, col: colCount - 1 })
          else setSel((p) => ({ ...p, col: colCount - 1 }))
          return
        case 'Enter':
        case 'F2':
          e.preventDefault()
          if (isLockCol(sel.col)) onToggleLock(sel.row)
          else if (isEditable(sel)) startEdit({ mode: 'raw' })
          return
        case 'Delete':
        case 'Backspace':
          e.preventDefault()
          if (isEditable(sel)) onDelete(sel)
          return
        case ' ':
          if (isLockCol(sel.col)) {
            e.preventDefault()
            onToggleLock(sel.row)
          }
          return
      }

      // Leave browser and OS shortcuts alone.
      if (mod || e.altKey || k.length !== 1) return
      if (isLockCol(sel.col) || !isEditable(sel)) return

      e.preventDefault()
      // The numpad decimal key emits ',' on many layouts; number cells read '.'.
      const ch = isNumericCol(sel.col) && k === ',' && e.code === 'NumpadDecimal' ? '.' : k
      if (isNumericCol(sel.col) && '+-*/('.includes(ch)) startEdit({ mode: 'append', text: ch })
      else startEdit({ mode: 'replace', text: ch })
    },
    [
      editing,
      navigate,
      step,
      select,
      startEdit,
      onDelete,
      onToggleLock,
      sel,
      rowCount,
      colCount,
      pageSize,
      isNumericCol,
      isLockCol,
      isEditable,
    ],
  )

  return { sel, editing, seed, select, startEdit, stopEdit, navigate, handleKeyDown }
}
