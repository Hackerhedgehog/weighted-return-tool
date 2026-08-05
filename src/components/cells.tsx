import { useState } from 'react'

interface NumCellProps {
  value: number
  display: string
  /** Raw string shown while editing (defaults to String(value)). */
  editValue?: string
  onCommit: (n: number) => void
  validate?: (n: number) => boolean
  className?: string
}

/**
 * Numeric cell: shows a formatted value, switches to the raw value while
 * focused, and live-commits every keystroke that parses to a valid number.
 */
export function NumCell({ value, display, editValue, onCommit, validate, className }: NumCellProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const invalid = draft !== null && !isValid(draft, validate)

  return (
    <input
      className={`cell-input num ${invalid ? 'invalid' : ''} ${className ?? ''}`}
      inputMode="decimal"
      value={draft ?? display}
      onFocus={(e) => {
        setDraft(editValue ?? String(value))
        requestAnimationFrame(() => e.target.select())
      }}
      onChange={(e) => {
        const s = e.target.value
        setDraft(s)
        const n = Number(s.replace(/[,\s_']/g, ''))
        if (s.trim() !== '' && Number.isFinite(n) && (!validate || validate(n))) {
          onCommit(n)
        }
      }}
      onBlur={() => setDraft(null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
      }}
    />
  )
}

function isValid(s: string, validate?: (n: number) => boolean): boolean {
  const n = Number(s.replace(/[,\s_']/g, ''))
  return s.trim() !== '' && Number.isFinite(n) && (!validate || validate(n))
}

interface TextCellProps {
  value: string
  onCommit: (s: string) => void
  className?: string
  placeholder?: string
}

export function TextCell({ value, onCommit, className, placeholder }: TextCellProps) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <input
      className={`cell-input text ${className ?? ''}`}
      value={draft ?? value}
      placeholder={placeholder}
      onFocus={() => setDraft(value)}
      onChange={(e) => {
        setDraft(e.target.value)
        onCommit(e.target.value)
      }}
      onBlur={() => setDraft(null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
      }}
    />
  )
}
