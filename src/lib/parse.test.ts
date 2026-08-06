import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseTsv } from './parse'

const INPUT = readFileSync('example-input-data.tsv', 'utf8')
const OUTPUT = readFileSync('example-output-data.tsv', 'utf8')

describe('parseTsv on the real input file', () => {
  const out = parseTsv(INPUT)

  it('parses every bucket', () => {
    expect(out.error).toBeUndefined()
    expect(out.rows).toHaveLength(30)
    expect(out.hasWeights).toBe(false)
  })

  it('reads columns as ID, Avg Payout, Label', () => {
    expect(out.rows[0]).toMatchObject({ bucketId: 0, payout: 1000, label: 'joker5-maxwin' })
    expect(out.rows[17]).toMatchObject({ bucketId: 17, payout: 0.33, label: 'green-two-only' })
    expect(out.rows[29]).toMatchObject({ bucketId: 29, payout: 650.75, label: '512-1024x' })
  })

  it('never rounds payouts', () => {
    expect(out.rows.find((r) => r.label === 'bonus5')!.payout).toBe(50.16)
    expect(out.rows.find((r) => r.label === 'bonus4')!.payout).toBe(10.13)
    expect(out.rows.find((r) => r.label === '128-256x')!.payout).toBe(200.82)
  })

  it('keeps zero payouts distinct from missing ones', () => {
    expect(out.rows.find((r) => r.label === '0x')!.payout).toBe(0)
    // joker2-tease, bonus-silent-tease, bonus1-tease, bonus2-tease, 0x
    expect(out.rows.filter((r) => r.payout === 0)).toHaveLength(5)
  })

  it('starts every row unlocked with zero weight', () => {
    expect(out.rows.every((r) => r.weight === 0 && r.locked === false)).toBe(true)
  })

  it('gives every row a unique id', () => {
    expect(new Set(out.rows.map((r) => r.uid)).size).toBe(30)
  })
})

describe('parseTsv round-trips our own export', () => {
  const out = parseTsv(OUTPUT)

  it('skips the header row and the totals row', () => {
    expect(out.rows).toHaveLength(30)
    expect(out.rows[0].label).toBe('joker5-maxwin')
  })

  it('picks up the Weights column', () => {
    expect(out.hasWeights).toBe(true)
    expect(out.rows[0].weight).toBe(200)
    expect(out.rows[18].weight).toBe(550000)
    expect(out.rows.reduce((a, r) => a + r.weight, 0)).toBe(1200350)
  })

  it('ignores the computed Weighted Value and Chance columns', () => {
    expect(out.rows[0]).not.toHaveProperty('chance')
  })
})

describe('parseTsv tolerance', () => {
  it('skips a header line without erroring', () => {
    const out = parseTsv('ID\tAvg Payout\tLabel\n0\t1000\tmaxwin')
    expect(out.rows).toHaveLength(1)
    expect(out.skippedLines).toHaveLength(1)
  })

  it('accepts comma-separated input', () => {
    expect(parseTsv('0,1000,maxwin').rows[0]).toMatchObject({ payout: 1000, label: 'maxwin' })
  })

  it('accepts multi-space input', () => {
    expect(parseTsv('0   1000   maxwin').rows[0]).toMatchObject({ payout: 1000, label: 'maxwin' })
  })

  it('tolerates blank lines and CRLF', () => {
    expect(parseTsv('0\t5\ta\r\n\r\n1\t6\tb\r\n').rows).toHaveLength(2)
  })

  it('allows an empty label', () => {
    expect(parseTsv('0\t5\t').rows[0].label).toBe('')
  })

  it('rejects negative payouts', () => {
    expect(parseTsv('0\t-5\tbad').error).toBeTruthy()
  })

  it('errors on unusable input', () => {
    expect(parseTsv('').error).toBeTruthy()
    expect(parseTsv('nothing useful here').error).toBeTruthy()
  })
})
