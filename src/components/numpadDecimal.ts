import type { KeyboardEvent } from 'react'

/**
 * The numpad decimal key emits ',' on many keyboard layouts, but every
 * numeric field here reads '.' as the decimal separator — and the expression
 * evaluator strips ',' as a thousands separator, so the slip is silent:
 * `1,5` becomes 15. Rewrite exactly that key to '.' at the caret.
 *
 * Returns true when the event was handled; controlled inputs then sync their
 * state from `e.currentTarget.value`. Identified by `code`, not `key`, so
 * layouts whose numpad already emits '.' pass through untouched.
 */
export function remapNumpadComma(e: KeyboardEvent<HTMLInputElement>): boolean {
  if (e.code !== 'NumpadDecimal' || e.key !== ',') return false
  e.preventDefault()

  const el = e.currentTarget
  const start = el.selectionStart ?? el.value.length
  const end = el.selectionEnd ?? start
  el.value = el.value.slice(0, start) + '.' + el.value.slice(end)
  el.setSelectionRange(start + 1, start + 1)
  return true
}
