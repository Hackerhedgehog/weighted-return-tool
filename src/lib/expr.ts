/**
 * Arithmetic for number cells.
 *
 * Select a cell showing 200, type "+500", press Enter, get 700. That append
 * behaviour is the point: it makes "nudge this weight" a two-keystroke action
 * instead of mental arithmetic.
 *
 * Hand-written recursive descent rather than `eval` — cell contents are user
 * input and must never reach a JS evaluator.
 *
 *   expr   := term (('+' | '-') term)*
 *   term   := factor (('*' | '/') factor)*
 *   factor := ('+' | '-') factor | number | '(' expr ')'
 *   number := digits ['.' digits] | '.' digits
 */

type Token = { kind: 'num'; value: number } | { kind: 'op'; value: string }

/** Thousands separators and whitespace, stripped before tokenizing. */
const NOISE = /[,\s_']/g

function tokenize(src: string): Token[] | null {
  const tokens: Token[] = []
  let i = 0

  while (i < src.length) {
    const ch = src[i]

    if (ch >= '0' && ch <= '9') {
      const start = i
      while (i < src.length && src[i] >= '0' && src[i] <= '9') i++
      if (src[i] === '.') {
        i++
        while (i < src.length && src[i] >= '0' && src[i] <= '9') i++
      }
      tokens.push({ kind: 'num', value: Number(src.slice(start, i)) })
      continue
    }

    if (ch === '.') {
      const start = i
      i++
      if (!(src[i] >= '0' && src[i] <= '9')) return null
      while (i < src.length && src[i] >= '0' && src[i] <= '9') i++
      tokens.push({ kind: 'num', value: Number(src.slice(start, i)) })
      continue
    }

    if ('+-*/()'.includes(ch)) {
      tokens.push({ kind: 'op', value: ch })
      i++
      continue
    }

    return null // anything else is not arithmetic
  }

  return tokens
}

/**
 * Evaluate a cell expression.
 * Returns `null` for anything invalid — empty, malformed, or division by zero.
 * Callers revert the cell on null; nothing silently becomes 0.
 */
export function evaluateExpression(input: string): number | null {
  let src = input.trim()
  if (src.startsWith('=')) src = src.slice(1)
  src = src.replace(NOISE, '')
  if (src === '') return null

  const tokens = tokenize(src)
  if (tokens === null) return null

  let pos = 0
  let failed = false

  const peek = (): Token | undefined => tokens[pos]
  const eatOp = (...ops: string[]): string | null => {
    const t = peek()
    if (t && t.kind === 'op' && ops.includes(t.value)) {
      pos++
      return t.value
    }
    return null
  }

  const parseFactor = (): number => {
    if (failed) return 0

    const unary = eatOp('+', '-')
    if (unary !== null) {
      const v = parseFactor()
      return unary === '-' ? -v : v
    }

    const t = peek()
    if (!t) {
      failed = true
      return 0
    }

    if (t.kind === 'num') {
      pos++
      return t.value
    }

    if (t.value === '(') {
      pos++
      const v = parseExpr()
      if (eatOp(')') === null) failed = true
      return v
    }

    failed = true
    return 0
  }

  const parseTerm = (): number => {
    let acc = parseFactor()
    for (;;) {
      const op = eatOp('*', '/')
      if (op === null) return acc
      const rhs = parseFactor()
      if (failed) return 0
      if (op === '/' && rhs === 0) {
        failed = true
        return 0
      }
      acc = op === '*' ? acc * rhs : acc / rhs
    }
  }

  const parseExpr = (): number => {
    let acc = parseTerm()
    for (;;) {
      const op = eatOp('+', '-')
      if (op === null) return acc
      const rhs = parseTerm()
      if (failed) return 0
      acc = op === '+' ? acc + rhs : acc - rhs
    }
  }

  const result = parseExpr()

  if (failed) return null
  if (pos !== tokens.length) return null // trailing junk, e.g. "2+3)"
  if (!Number.isFinite(result)) return null

  return result
}
