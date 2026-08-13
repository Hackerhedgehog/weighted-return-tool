import type { KeyboardEvent } from 'react'

/**
 * The numpad decimal key emits ',' on many keyboard layouts. The expression
 * evaluator reads ',' as a decimal point too, but fields that don't parse
 * through it would still miss the intent — rewrite exactly that key to '.'
 * at the caret so what lands in the field is unambiguous.
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
