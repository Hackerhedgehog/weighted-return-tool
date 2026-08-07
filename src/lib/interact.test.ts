import { describe, it, expect } from 'vitest'
import type { BucketRow } from './types'
import { scaleSubset, setSubsetTotal } from './interact'

let n = 0
const row = (weight: number, locked = false): BucketRow => ({
  uid: `u${(n += 1)}`,
  bucketId: n,
  payout: 1,
  label: `b${n}`,
  weight,
  locked,
})

const total = (w: number[]) => w.reduce((a, b) => a + b, 0)
const uids = (rows: BucketRow[]) => rows.map((r) => r.uid)

describe('scaleSubset (relative — grand total invariant)', () => {
  it('moves the subset to the requested total and compensates outside', () => {
    const rows = [row(100), row(300), row(600)]
    const w = scaleSubset(rows, [rows[0].uid], 200)!

    expect(w[0]).toBe(200)
    expect(total(w)).toBe(1000)
    // outside keeps its 1:2 proportion over the remaining 800, to integer rounding
    expect(w[1] / w[2]).toBeCloseTo(1 / 2, 2)
  })

  it('preserves proportions within a multi-row subset', () => {
    const rows = [row(100), row(300), row(600)]
    const w = scaleSubset(rows, uids(rows.slice(0, 2)), 800)!

    expect(w[0] + w[1]).toBe(800)
    expect(w[0] / w[1]).toBeCloseTo(1 / 3, 5)
    expect(total(w)).toBe(1000)
  })

  it('never moves locked rows, inside or outside the subset', () => {
    const rows = [row(100), row(300, true), row(400), row(200, true)]
    const w = scaleSubset(rows, uids(rows.slice(0, 2)), 700)!

    expect(w[1]).toBe(300)
    expect(w[3]).toBe(200)
    expect(w[0] + w[1]).toBe(700)
    expect(total(w)).toBe(1000)
  })

  it('clamps to what the unlocked weight outside can yield', () => {
    const rows = [row(100), row(300, true), row(600)]
    // outside locked 300 → subset can reach at most 1000 - 300 = 700
    const w = scaleSubset(rows, [rows[0].uid], 5000)!

    expect(w[0]).toBe(700)
    expect(w[2]).toBe(0)
    expect(total(w)).toBe(1000)
  })

  it('clamps below at the locked weight inside the subset', () => {
    const rows = [row(100), row(300, true), row(600)]
    const w = scaleSubset(rows, uids(rows.slice(0, 2)), 0)!

    expect(w[0]).toBe(0)
    expect(w[1]).toBe(300)
    expect(total(w)).toBe(1000)
  })

  it('is a no-op when the subset is fully locked', () => {
    const rows = [row(100, true), row(900)]
    const w = scaleSubset(rows, [rows[0].uid], 500)!
    expect(w).toEqual([100, 900])
  })

  it('is a no-op when everything outside is locked', () => {
    const rows = [row(100), row(900, true)]
    const w = scaleSubset(rows, [rows[0].uid], 500)!
    expect(w).toEqual([100, 900])
  })

  it('splits equally when growing a subset whose rows are all zero', () => {
    const rows = [row(0), row(0), row(1000)]
    const w = scaleSubset(rows, uids(rows.slice(0, 2)), 400)!

    expect(w[0]).toBe(200)
    expect(w[1]).toBe(200)
    expect(total(w)).toBe(1000)
  })

  it('returns exact integers summing to the grand total', () => {
    const rows = [row(333), row(334), row(333)]
    const w = scaleSubset(rows, [rows[1].uid], 100)!

    for (const v of w) expect(Number.isInteger(v)).toBe(true)
    expect(w[1]).toBe(100)
    expect(total(w)).toBe(1000)
  })
})

describe('setSubsetTotal (non-relative — the rest never moves)', () => {
  it('scales the subset and leaves everything else untouched', () => {
    const rows = [row(100), row(300), row(600)]
    const w = setSubsetTotal(rows, uids(rows.slice(0, 2)), 800)

    expect(w[0] + w[1]).toBe(800)
    expect(w[0] / w[1]).toBeCloseTo(1 / 3, 5)
    expect(w[2]).toBe(600)
  })

  it('respects locks inside the subset', () => {
    const rows = [row(100), row(300, true), row(600)]
    const w = setSubsetTotal(rows, uids(rows.slice(0, 2)), 500)

    expect(w[1]).toBe(300)
    expect(w[0]).toBe(200)
    expect(w[2]).toBe(600)
  })

  it('clamps at the locked weight when asked to go below it', () => {
    const rows = [row(100), row(300, true)]
    const w = setSubsetTotal(rows, uids(rows), 100)

    expect(w).toEqual([0, 300])
  })

  it('grows a zero subset from nothing, splitting equally', () => {
    const rows = [row(0), row(0), row(50)]
    const w = setSubsetTotal(rows, uids(rows.slice(0, 2)), 9)

    expect(w[0] + w[1]).toBe(9)
    expect(Math.abs(w[0] - w[1])).toBeLessThanOrEqual(1)
    expect(w[2]).toBe(50)
  })
})

describe('weight steps', () => {
  it('scaleSubset snaps the drag and keeps every unlocked row on the step', () => {
    const rows = [row(100), row(300), row(600)]
    const w = scaleSubset(rows, [rows[0].uid], 240, 100)!
    expect(w[0]).toBe(200) // 240 snaps to the nearest hundred
    expect(total(w)).toBe(1000)
    expect(w.every((v) => v % 100 === 0)).toBe(true)
  })

  it('scaleSubset refuses when the free weight is off the step', () => {
    const rows = [row(150), row(300), row(600)] // free total 1050
    expect(scaleSubset(rows, [rows[0].uid], 200, 100)).toBeNull()
  })

  it('an off-step locked row outside the subset is fine', () => {
    const rows = [row(100), row(421, true), row(900)] // free total 1000
    const w = scaleSubset(rows, [rows[0].uid], 350, 100)!
    expect(w).toEqual([400, 421, 600])
  })

  it('setSubsetTotal snaps the subset and leaves the rest alone', () => {
    const rows = [row(100), row(300), row(600)]
    const w = setSubsetTotal(rows, uids(rows.slice(0, 2)), 445, 10)
    expect(w[0] + w[1]).toBe(450) // 445 snaps to the nearest ten
    expect(w[0] % 10).toBe(0)
    expect(w[1] % 10).toBe(0)
    expect(w[2]).toBe(600)
  })
})
