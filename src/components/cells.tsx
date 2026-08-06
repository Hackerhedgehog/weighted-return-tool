import { useEffect, useRef, useState } from 'react'
import { evaluateExpression } from '../lib/expr'
import type { EditSeed } from './useGridNavigation'

const FLASH_MS = 700

interface GridCellProps {
  /** Formatted text shown when the cell is idle. */
  display: string
  /** Underlying value an edit starts from — unformatted, no separators. */
  raw: string
  numeric: boolean
  editable: boolean
  selected: boolean
  editing: boolean
  seed: EditSeed
  /** Numeric cells: called with the evaluated number. */
  onCommitValue?: (n: number) => void
  /** Text cells: called with the raw string. */
  onCommitText?: (s: string) => void
  validate?: (n: number) => boolean
  onSelect: () => void
  onStartEdit: (seed: EditSeed) => void
  onStopEdit: () => void
  onNavigate: (dr: number, dc: number) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  className?: string
  title?: string
}

export function GridCell({
  display,
  raw,
  numeric,
  editable,
  selected,
  editing,
  seed,
  onCommitValue,
  onCommitText,
  validate,
  onSelect,
  onStartEdit,
  onStopEdit,
  onNavigate,
  onKeyDown,
  className,
  title,
}: GridCellProps) {
  const idleRef = useRef<HTMLDivElement>(null)
  const [invalid, setInvalid] = useState(false)

  // Keep DOM focus on the selected cell so the grid keeps receiving keys, and
  // keep it on screen when arrowing through a long table.
  useEffect(() => {
    if (selected && !editing) {
      idleRef.current?.focus({ preventScroll: true })
      idleRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }, [selected, editing])

  const flashInvalid = () => {
    setInvalid(true)
    window.setTimeout(() => setInvalid(false), FLASH_MS)
  }

  const commit = (text: string) => {
    onStopEdit()

    if (!numeric) {
      onCommitText?.(text)
      return
    }

    const n = evaluateExpression(text)
    if (n === null || (validate && !validate(n))) {
      flashInvalid()
      return
    }
    onCommitValue?.(n)
  }

  if (editing && editable) {
    const initial =
      seed.mode === 'replace' ? seed.text : seed.mode === 'append' ? raw + seed.text : raw
    return (
      <CellInput
        initial={initial}
        numeric={numeric}
        onCommit={commit}
        onCancel={onStopEdit}
        onNavigate={onNavigate}
      />
    )
  }

  return (
    <div
      ref={idleRef}
      className={`gcell ${numeric ? 'num' : 'text'} ${selected ? 'selected' : ''} ${
        invalid ? 'invalid' : ''
      } ${editable ? '' : 'readonly'} ${className ?? ''}`}
      tabIndex={selected ? 0 : -1}
      role="gridcell"
      title={title}
      onMouseDown={onSelect}
      onDoubleClick={() => editable && onStartEdit({ mode: 'raw' })}
      onKeyDown={onKeyDown}
    >
      {display}
    </div>
  )
}

interface CellInputProps {
  initial: string
  numeric: boolean
  onCommit: (text: string) => void
  onCancel: () => void
  onNavigate: (dr: number, dc: number) => void
}

function CellInput({ initial, numeric, onCommit, onCancel, onNavigate }: CellInputProps) {
  const ref = useRef<HTMLInputElement>(null)
  // Enter both commits and unmounts the input, which also fires blur. Without
  // this guard the value would be committed twice.
  const settled = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    const end = el.value.length
    el.setSelectionRange(end, end)
  }, [])

  const finish = (save: boolean) => {
    if (settled.current) return
    settled.current = true
    if (save) onCommit(ref.current?.value ?? '')
    else onCancel()
  }

  return (
    <input
      ref={ref}
      className={`gcell editing ${numeric ? 'num' : 'text'}`}
      defaultValue={initial}
      spellCheck={false}
      inputMode={numeric ? 'text' : undefined}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        // Ctrl+Z inside an open cell belongs to the text field, not the grid.
        e.stopPropagation()

        switch (e.key) {
          case 'Enter':
            e.preventDefault()
            finish(true)
            onNavigate(1, 0)
            break
          case 'Escape':
            e.preventDefault()
            finish(false)
            break
          case 'Tab':
            e.preventDefault()
            finish(true)
            onNavigate(0, e.shiftKey ? -1 : 1)
            break
          case 'ArrowUp':
            e.preventDefault()
            finish(true)
            onNavigate(-1, 0)
            break
          case 'ArrowDown':
            e.preventDefault()
            finish(true)
            onNavigate(1, 0)
            break
        }
      }}
    />
  )
}

/** Lock toggle in the leftmost column. Not exported to TSV. */
export function LockCell({
  locked,
  selected,
  onToggle,
  onSelect,
  onKeyDown,
}: {
  locked: boolean
  selected: boolean
  onToggle: () => void
  onSelect: () => void
  onKeyDown: (e: React.KeyboardEvent) => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (selected) {
      ref.current?.focus({ preventScroll: true })
      ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }, [selected])

  return (
    <div
      ref={ref}
      className={`gcell lock ${selected ? 'selected' : ''} ${locked ? 'on' : ''}`}
      tabIndex={selected ? 0 : -1}
      role="gridcell"
      aria-label={locked ? 'Locked — Auto-Distribute will not change this weight' : 'Unlocked'}
      title={locked ? 'Locked — Auto-Distribute will not change this weight' : 'Click to lock'}
      onMouseDown={onSelect}
      onClick={onToggle}
      onKeyDown={onKeyDown}
    >
      {locked ? '🔒' : '　'}
    </div>
  )
}
