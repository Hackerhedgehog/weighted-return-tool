import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseTsv } from './parse'
import { buildTsv, withTsvExtension, EXPORT_HEADER } from './exportTsv'
import { solveWeights, statsOf } from './distribute'
import { CURVE_PRESETS, DEFAULT_TARGETS } from './types'

/** The export's line separator, matching the reference file. */
const EOL = '\r\n'

const INPUT = readFileSync('example-input-data.tsv', 'utf8')
const OUTPUT = readFileSync('example-output-data.tsv', 'utf8')

describe('buildTsv acceptance', () => {
  it('reproduces example-output-data.tsv exactly, minus its totals row', () => {
    const input = parseTsv(INPUT)
    const reference = parseTsv(OUTPUT)

    // Take the buckets from the input file and the weights from the
    // reference output — everything else must be computed. The reference
    // file's own totals row is not part of what this tool exports.
    const rows = input.rows.map((r, i) => ({ ...r, weight: reference.rows[i].weight }))
    const total = rows.reduce((a, r) => a + r.weight, 0)

    expect(total).toBe(1200350)
    const withoutTotalsRow = OUTPUT.split(EOL).slice(0, -1).join(EOL)
    expect(buildTsv(rows, total)).toBe(withoutTotalsRow)
  })

  it('uses CRLF line endings with no trailing newline', () => {
    const rows = parseTsv(OUTPUT).rows
    const text = buildTsv(rows, 1200350)
    expect(text).toContain('\r\n')
    expect(text.endsWith('\n')).toBe(false)
    expect(text.split('\r\n')).toHaveLength(31) // header + 30 buckets, no totals row
  })

  it('writes the header with its trailing space after Avg Payout', () => {
    expect(EXPORT_HEADER).toBe('ID\tAvg Payout \tLabel\tWeights\tWeighted Value\tChance')
    expect(buildTsv([], 0).split('\r\n')[0]).toBe(EXPORT_HEADER)
  })

  it('is independent of table column visibility (columns are display-only)', () => {
    // buildTsv takes only rows + total; this pins that contract so a future
    // refactor cannot thread the ⚙ column toggles into the export. The header
    // and field count never change with what the table happens to show.
    const rows = parseTsv(OUTPUT).rows
    const lines = buildTsv(rows, 1200350).split('\r\n')
    expect(lines[0]).toBe(EXPORT_HEADER)
    expect(lines[1].split('\t')).toHaveLength(6)
  })

  it('carries no totals row', () => {
    const rows = parseTsv(OUTPUT).rows
    const lines = buildTsv(rows, 1200350).split('\r\n')
    expect(lines).toHaveLength(31)
    // the last line is the last bucket, not a blank-leading totals line
    expect(lines.at(-1)!.startsWith('\t\t\t')).toBe(false)
  })

  it('survives a zero total without emitting NaN', () => {
    const rows = parseTsv('0\t5\ta').rows
    const text = buildTsv(rows, 0)
    expect(text).not.toContain('NaN')
    expect(text.split('\r\n')[1]).toBe('0\t5\ta\t0\t0\t0')
  })

  it('trims payout trailing zeros the way the reference file does', () => {
    const rows = parseTsv('0\t1000.00\ta\n1\t18.70\tb\n2\t0.00\tc').rows
    const lines = buildTsv(rows, 0).split('\r\n')
    expect(lines[1].split('\t')[1]).toBe('1000')
    expect(lines[2].split('\t')[1]).toBe('18.7')
    expect(lines[3].split('\t')[1]).toBe('0')
  })
})

describe('end-to-end workflow', () => {
  it('paste raw data, auto-distribute, export, paste back, unchanged', () => {
    // 1. paste the engine's file
    const pasted = parseTsv(INPUT)
    expect(pasted.rows).toHaveLength(30)
    expect(pasted.hasWeights).toBe(false)

    // 2. auto-distribute at the default targets
    const solved = solveWeights(pasted.rows, 1_000_000, DEFAULT_TARGETS, CURVE_PRESETS.medium)
    const rows = pasted.rows.map((r, i) => ({ ...r, weight: solved.weights[i] }))
    const total = rows.reduce((a, r) => a + r.weight, 0)
    expect(total).toBe(1_000_000)

    const before = statsOf(rows, total)
    expect(before.rtp).toBeCloseTo(0.95, 5)

    // 3. export
    const text = buildTsv(rows, total)

    // 4. paste the export straight back in
    const round = parseTsv(text)
    expect(round.hasWeights).toBe(true)
    expect(round.rows).toHaveLength(30)

    // 5. nothing moved
    const roundTotal = round.rows.reduce((a, r) => a + r.weight, 0)
    expect(roundTotal).toBe(total)
    round.rows.forEach((r, i) => {
      expect(r.bucketId).toBe(rows[i].bucketId)
      expect(r.payout).toBe(rows[i].payout)
      expect(r.label).toBe(rows[i].label)
      expect(r.weight).toBe(rows[i].weight)
    })

    const after = statsOf(round.rows, roundTotal)
    expect(after.rtp).toBeCloseTo(before.rtp, 10)
    expect(after.hitChance).toBeCloseTo(before.hitChance, 10)
    expect(after.winChance).toBeCloseTo(before.winChance, 10)

    // and exporting the re-imported data is byte-identical
    expect(buildTsv(round.rows, roundTotal)).toBe(text)
  })
})

describe('withTsvExtension', () => {
  it('leaves a good filename alone', () => {
    expect(withTsvExtension('ref-weights-regular.tsv')).toBe('ref-weights-regular.tsv')
  })

  it('appends a missing extension', () => {
    expect(withTsvExtension('ref-weights-bonus')).toBe('ref-weights-bonus.tsv')
  })

  it('falls back when given nothing usable', () => {
    expect(withTsvExtension('   ')).toBe('ref-weights-regular.tsv')
  })
})

describe('weight id column', () => {
  const base = {
    uid: 'u1',
    bucketId: 0,
    payout: 2,
    label: 'x',
    weight: 100,
    locked: false,
    groupId: 'other',
    weightId: '',
  }

  it('is absent entirely when no row uses one', () => {
    const tsv = buildTsv([base], 100)
    expect(tsv.split(EOL)[0]).toBe(EXPORT_HEADER)
    expect(tsv).not.toContain('Weight ID')
  })

  it('rides as a trailing column as soon as one row has it', () => {
    const tsv = buildTsv([{ ...base, weightId: 'W-7' }, { ...base, uid: 'u2', bucketId: 1 }], 200)
    const lines = tsv.split(EOL)
    expect(lines[0]).toBe(`${EXPORT_HEADER}	Weight ID`)
    expect(lines[1].split('	')).toHaveLength(7)
    expect(lines[1].split('	')[6]).toBe('W-7')
    // the row without one still carries the field, empty
    expect(lines[2].split('	')[6]).toBe('')
    // no totals row, so there is nothing after the two bucket lines
    expect(lines).toHaveLength(3)
  })

  it('survives a round trip through the parser', () => {
    const tsv = buildTsv([{ ...base, weightId: 'W-7' }], 100)
    const back = parseTsv(tsv)
    expect(back.rows).toHaveLength(1)
    expect(back.rows[0].weightId).toBe('W-7')
  })
})
