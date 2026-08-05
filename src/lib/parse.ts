import { nextUid, type BucketRow } from './types'

export interface ParseOutcome {
  rows: BucketRow[]
  skippedLines: string[]
  error?: string
}

/**
 * Parse pasted TSV text: bucketId <tab> label <tab> payout multiplier.
 * Tolerates a header line, blank lines, CRLF, and comma / multi-space
 * separated fallbacks when no tabs are present.
 */
export function parseTsv(text: string): ParseOutcome {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim().length > 0)

  if (lines.length === 0) {
    return { rows: [], skippedLines: [], error: 'No data found in the pasted text.' }
  }

  const rows: BucketRow[] = []
  const skippedLines: string[] = []

  for (const line of lines) {
    let parts = line.split('\t').map((p) => p.trim())
    if (parts.length < 3) {
      // Fallbacks for people pasting from non-TSV sources.
      const commaParts = line.split(',').map((p) => p.trim())
      const spaceParts = line.split(/\s{2,}/).map((p) => p.trim())
      if (commaParts.length >= 3) parts = commaParts
      else if (spaceParts.length >= 3) parts = spaceParts
    }

    if (parts.length < 3) {
      skippedLines.push(line)
      continue
    }

    const bucketId = Number(parts[0])
    const payout = Number(parts[2])
    if (!Number.isFinite(bucketId) || !Number.isFinite(payout)) {
      // Most likely a header row; skip silently but record it.
      skippedLines.push(line)
      continue
    }

    rows.push({
      uid: nextUid(),
      bucketId: Math.round(bucketId),
      label: parts[1],
      payout: Math.round(payout),
      weight: 0,
      optionalId: parts[3] ?? '',
    })
  }

  if (rows.length === 0) {
    return {
      rows: [],
      skippedLines,
      error: 'Could not parse any rows. Expected: bucket ID ⇥ bucket label ⇥ payout multiplier.',
    }
  }

  return { rows, skippedLines }
}

export const SAMPLE_TSV = [
  'bucket_id\tbucket_label\tpayout_multiplier',
  '0\tNo Win\t0',
  '1\tPush\t1',
  '2\tTiny Win\t2',
  '3\tSmall Win\t3',
  '4\tDouble Line\t5',
  '5\tTriple Line\t8',
  '6\tScatter Pay\t10',
  '7\tFour of a Kind\t15',
  '8\tFive of a Kind\t25',
  '9\tBonus Round\t50',
  '10\tSuper Bonus\t100',
  '11\tWild Cascade\t250',
  '12\tMega Win\t1000',
  '13\tJackpot\t5000',
].join('\n')
