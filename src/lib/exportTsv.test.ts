import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseTsv } from './parse'
import { buildTsv, withTsvExtension, EXPORT_HEADER } from './exportTsv'

const INPUT = readFileSync('example-input-data.tsv', 'utf8')
const OUTPUT = readFileSync('example-output-data.tsv', 'utf8')

describe('buildTsv acceptance', () => {
  it('reproduces example-output-data.tsv exactly', () => {
    const input = parseTsv(INPUT)
    const reference = parseTsv(OUTPUT)

    // Take the buckets from the input file and the weights from the
    // reference output — everything else must be computed.
    const rows = input.rows.map((r, i) => ({ ...r, weight: reference.rows[i].weight }))
    const total = rows.reduce((a, r) => a + r.weight, 0)

    expect(total).toBe(1200350)
    expect(buildTsv(rows, total)).toBe(OUTPUT)
  })

  it('uses CRLF line endings with no trailing newline', () => {
    const rows = parseTsv(OUTPUT).rows
    const text = buildTsv(rows, 1200350)
    expect(text).toContain('\r\n')
    expect(text.endsWith('\n')).toBe(false)
    expect(text.split('\r\n')).toHaveLength(32) // header + 30 buckets + totals
  })

  it('writes the header with its trailing space after Avg Payout', () => {
    expect(EXPORT_HEADER).toBe('ID\tAvg Payout \tLabel\tWeights\tWeighted Value\tChance')
    expect(buildTsv([], 0).split('\r\n')[0]).toBe(EXPORT_HEADER)
  })

  it('writes the totals row with three empty leading fields', () => {
    const rows = parseTsv(OUTPUT).rows
    const totals = buildTsv(rows, 1200350).split('\r\n').at(-1)!
    expect(totals).toBe('\t\t\t1200350\t1.08819261\t1')
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
