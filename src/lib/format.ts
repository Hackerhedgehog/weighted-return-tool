/**
 * Number formatting for the bucket grid and the TSV export.
 *
 * Two hard rules drive everything here:
 *  - Nothing shown in a cell or written to the export may use scientific
 *    notation. Chances routinely reach 1e-7 and a user reading "1.00e-4%"
 *    cannot copy that into an engine config.
 *  - The export must reproduce `example-output-data.tsv` exactly, which uses
 *    10 significant digits with trailing zeros trimmed.
 */

const EM_DASH = '—'

/** Strip trailing zeros (and a bare trailing point) from a fixed-point string. */
function trimZeros(s: string): string {
  if (!s.includes('.')) return s
  return s.replace(/0+$/, '').replace(/\.$/, '')
}

/**
 * Plain decimal with at most `maxDp` decimal places, trailing zeros trimmed.
 * `toFixed` is used deliberately: unlike `String`, it never emits an exponent
 * for small magnitudes. Values below 1e-`maxDp` collapse to "0".
 */
export function fmtDecimal(n: number, maxDp = 15): string {
  if (!Number.isFinite(n)) return EM_DASH
  if (n === 0) return '0'
  return trimZeros(n.toFixed(maxDp))
}

/**
 * Expand exponent notation into plain decimal digits.
 * `String(1e-8)` gives "1e-8"; this gives "0.00000001".
 */
export function toPlainDecimal(s: string): string {
  const m = /^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(s)
  if (!m) return s

  const [, sign, intPart, fracPart = '', expPart] = m
  const exp = Number(expPart)
  const digits = intPart + fracPart
  const pointPos = intPart.length + exp

  let out: string
  if (pointPos <= 0) {
    out = `0.${'0'.repeat(-pointPos)}${digits}`
  } else if (pointPos >= digits.length) {
    out = digits + '0'.repeat(pointPos - digits.length)
  } else {
    out = `${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`
  }

  return sign === '-' ? `-${out}` : out
}

/**
 * Export form: `sig` significant digits, trailing zeros trimmed, plain decimal.
 * Verified to reproduce all 60 computed cells of example-output-data.tsv.
 */
export function fmtSig(n: number, sig = 10): string {
  if (!Number.isFinite(n)) return ''
  if (n === 0) return '0'
  return toPlainDecimal(String(Number(n.toPrecision(sig))))
}

/** Avg Payout: shortest round-trip form, so 1000.00 reads as 1000 and 18.70 as 18.7. */
export function fmtPayout(n: number): string {
  return Number.isFinite(n) ? toPlainDecimal(String(n)) : EM_DASH
}

/** Weights: grouped integer for display. */
export function fmtWeight(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : EM_DASH
}

/**
 * Credits: grouped integer at 1000 and above, two decimal places below.
 *
 * Weights are always whole numbers, so `fmtWeight` rounding them to
 * integers loses nothing. Bankroll credits are not: `BET.integer` is
 * `false`, payouts are floats, and a run can easily bust holding a
 * fraction of a credit. Rounding that display to the nearest integer would
 * show "1" for a balance of 0.5 sitting right next to a legend that says
 * there is no credit left to bet — technically an integer, but a lie about
 * what actually happened. Below 1000 there's no grouping to lose anyway, so
 * the cents show through; at 1000 and above the grouped integer matches
 * every other large-number display in the tool, and a run that size was
 * never going to be read to the cent regardless.
 */
export function fmtCredits(n: number): string {
  if (!Number.isFinite(n)) return EM_DASH
  return Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-US') : fmtDecimal(n, 2)
}

export function fmtRtp(n: number): string {
  return Number.isFinite(n) ? n.toFixed(4) : EM_DASH
}

/** Percentages: the chart, and the targets panel's chance readouts and hints. */
export function fmtPct(fraction: number, dp = 4): string {
  if (!Number.isFinite(fraction)) return EM_DASH
  return `${trimZeros((fraction * 100).toFixed(dp))}%`
}
