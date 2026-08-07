import { describe, it, expect } from 'vitest'
import { COLUMNS, DEFAULT_WIDTHS } from './columns'

describe('default column widths', () => {
  it('stay narrow enough to sit beside the chart on a wide screen', () => {
    // The table has no scroll box of its own, so its natural width is what
    // decides when the chart wraps below it. Nine columns still have to leave
    // the chart its 420px minimum inside a 1368px content area.
    const total = COLUMNS.reduce((a, c) => a + c.width, 0)
    expect(total).toBeLessThanOrEqual(912)
  })

  it('still leaves the chance column wide enough to read', () => {
    expect(DEFAULT_WIDTHS.chance).toBeGreaterThanOrEqual(130)
  })

  it('mirrors every column into DEFAULT_WIDTHS', () => {
    expect(Object.keys(DEFAULT_WIDTHS)).toHaveLength(COLUMNS.length)
    for (const c of COLUMNS) expect(DEFAULT_WIDTHS[c.key]).toBe(c.width)
  })
})
