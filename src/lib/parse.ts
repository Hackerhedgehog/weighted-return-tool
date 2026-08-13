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
  '0\t2000.00\tjackpot',
  '1\t500.00\tmega-win',
  '2\t100.00\tsuper-win',
  '3\t50.16\tbonus-big',
  '4\t20.00\tbonus-mid',
  '5\t10.13\tbonus-small',
  '6\t5.00\tbonus-tiny',
  '7\t0.00\tbonus-tease',
  '8\t0.00\tbonus2-tease',
  '9\t0.00\t0x',
  '10\t0.33\tgreen-two-only',
  '11\t0.60\t0-1x',
  '12\t1.20\t1-1.5x',
  '13\t1.80\t1.5-2x',
  '14\t2.61\t2-3x',
  '15\t3.57\t3-4x',
  '16\t4.94\t4-6x',
  '17\t7.57\t6-8x',
  '18\t10.26\t8-12x',
  '19\t11.93\t12-16x',
  '20\t18.70\t16-24x',
  '21\t20.54\t24-32x',
  '22\t32.00\t32-48x',
  '23\t41.38\t48-64x',
  '24\t60.00\t64-96x',
  '25\t87.86\t96-128x',
  '26\t150.00\t128-192x',
  '27\t200.82\t192-256x',
  '28\t300.00\t256-384x',
  '29\t395.31\t384-512x',
  '30\t500.00\t512-768x',
  '31\t650.75\t768-1024x',
  '32\t900.00\t1024-2048x',
].join('\n')
