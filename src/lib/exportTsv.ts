import { fmtPayout, fmtSig } from './format'
import { DEFAULT_EXPORT_FILENAME, type BucketRow } from './types'

/**
 * Header of the engine's reference export. The trailing space after
 * "Avg Payout" is present in the real file and is reproduced deliberately —
 * downstream tooling may match on the exact header string.
 */
export const EXPORT_HEADER = 'ID\tAvg Payout \tLabel\tWeights\tWeighted Value\tChance'

/**
 * Weight ID rides as a trailing column, and only when a table actually uses
 * one. Trailing keeps the positional parse of the first six fields intact, and
 * conditional keeps a table that ignores the field byte-identical to what this
 * tool has always produced.
 */
export const WEIGHT_ID_HEADER = 'Weight ID'

/** CRLF, matching the reference file and what Windows spreadsheets expect. */
const EOL = '\r\n'

/**
 * Render the table as TSV: header, one line per bucket, then a totals row
 * whose first three fields are empty.
 *
 * Computed columns use 10 significant digits, which reproduces
 * `example-output-data.tsv` byte for byte. There is no trailing newline —
 * also matching the reference.
 */
export function buildTsv(rows: BucketRow[], totalWeight: number): string {
  const safeTotal = totalWeight > 0 ? totalWeight : 0

  const valueOf = (r: BucketRow) => (safeTotal > 0 ? (r.payout * r.weight) / safeTotal : 0)
  const chanceOf = (r: BucketRow) => (safeTotal > 0 ? r.weight / safeTotal : 0)

  const withWeightId = rows.some((r) => r.weightId !== '')
  const lines = [withWeightId ? `${EXPORT_HEADER}\t${WEIGHT_ID_HEADER}` : EXPORT_HEADER]

  for (const r of rows) {
    const fields = [
      String(r.bucketId),
      fmtPayout(r.payout),
      r.label,
      String(Math.round(r.weight)),
      fmtSig(valueOf(r)),
      fmtSig(chanceOf(r)),
    ]
    if (withWeightId) fields.push(r.weightId)
    lines.push(fields.join('\t'))
  }

  // Sum at full precision, then round once. (Summing the already-rounded
  // column gives the same string for the reference data, but this is the
  // more defensible of the two.)
  const totalValue = rows.reduce((a, r) => a + valueOf(r), 0)
  const totalChance = rows.reduce((a, r) => a + chanceOf(r), 0)

  const totals = ['', '', '', String(Math.round(safeTotal)), fmtSig(totalValue), fmtSig(totalChance)]
  if (withWeightId) totals.push('')
  lines.push(totals.join('\t'))

  return lines.join(EOL)
}

/** Keep the download name sane without nagging the user about it. */
export function withTsvExtension(name: string): string {
  const trimmed = name.trim()
  if (trimmed === '') return DEFAULT_EXPORT_FILENAME
  return trimmed.toLowerCase().endsWith('.tsv') ? trimmed : `${trimmed}.tsv`
}

/**
 * Copy to the clipboard, falling back to a hidden textarea when the async
 * Clipboard API is unavailable (it needs a secure context, which a plain
 * http:// dev host is not).
 */
export async function copyTsv(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path
  }

  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

export function downloadTsv(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'text/tab-separated-values;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = withTsvExtension(filename)
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
