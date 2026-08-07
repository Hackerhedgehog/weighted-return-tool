import { nextUid, type BucketRow } from './types'

export interface ParseOutcome {
  rows: BucketRow[]
  /** Header rows, totals rows and anything unparseable, kept for diagnostics. */
  skippedLines: string[]
  /** True when the pasted data already carried a Weights column. */
  hasWeights: boolean
  error?: string
}

/**
 * Parse pasted engine data: `ID ⇥ Avg Payout ⇥ Label`.
 *
 * The tool's own export is also accepted, so you can export, edit in a
 * spreadsheet, and paste straight back: with 4+ fields the fourth is read as
 * the weight, and the header and totals rows are skipped automatically.
 *
 * Tolerates a header line, blank lines, CRLF, and comma or multi-space
 * separators for data pasted from non-TSV sources.
 */
export function parseTsv(text: string): ParseOutcome {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim().length > 0)

  if (lines.length === 0) {
    return { rows: [], skippedLines: [], hasWeights: false, error: 'No data found in the pasted text.' }
  }

  const rows: BucketRow[] = []
  const skippedLines: string[] = []
  let hasWeights = false

  for (const line of lines) {
    let parts = line.split('\t').map((p) => p.trim())
    if (parts.length < 3) {
      const commaParts = line.split(',').map((p) => p.trim())
      const spaceParts = line.split(/\s{2,}/).map((p) => p.trim())
      if (commaParts.length >= 3) parts = commaParts
      else if (spaceParts.length >= 3) parts = spaceParts
    }

    if (parts.length < 3) {
      skippedLines.push(line)
      continue
    }

    // A blank first field is the totals row of our own export; a non-numeric
    // one is a header. Note Number('') is 0, so the blank check must be
    // explicit rather than relying on isFinite.
    const idField = parts[0]
    const bucketId = Number(idField)
    if (idField === '' || !Number.isFinite(bucketId)) {
      skippedLines.push(line)
      continue
    }

    const payout = Number(parts[1])
    if (parts[1] === '' || !Number.isFinite(payout) || payout < 0) {
      skippedLines.push(line)
      continue
    }

    let weight = 0
    if (parts.length >= 4 && parts[3] !== '') {
      const w = Number(parts[3])
      if (Number.isFinite(w) && w >= 0) {
        weight = Math.round(w)
        hasWeights = true
      }
    }

    rows.push({
      uid: nextUid(),
      bucketId: Math.round(bucketId),
      payout,
      label: parts[2],
      weight,
      locked: false,
      // Seeded by seedGroups once the whole table is parsed.
      groupId: '',
      // Trailing column of our own export, present only when it was used.
      weightId: parts[6] ?? '',
    })
  }

  if (rows.length === 0) {
    return {
      rows: [],
      skippedLines,
      hasWeights: false,
      error: 'Could not parse any rows. Expected columns: ID ⇥ Avg Payout ⇥ Label.',
    }
  }

  return { rows, skippedLines, hasWeights }
}

/** Sample data in the real column order, for the "Use sample data" button. */
export const SAMPLE_TSV = [
  '0\t1000.00\tjackpot',
  '1\t200.00\tmega-win',
  '2\t50.16\tbonus-big',
  '3\t20.00\tbonus-mid',
  '4\t10.13\tbonus-small',
  '5\t0.00\tbonus-tease',
  '6\t0.00\t0x',
  '7\t0.33\tgreen-two-only',
  '8\t0.60\t0-1x',
  '9\t1.80\t1-2x',
  '10\t3.57\t2-4x',
  '11\t7.57\t4-8x',
  '12\t11.93\t8-16x',
  '13\t41.38\t32-64x',
].join('\n')
