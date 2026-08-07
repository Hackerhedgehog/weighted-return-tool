import { describe, it, expect } from 'vitest'
import { COLUMNS, DEFAULT_WIDTHS } from './columns'

describe('default column widths', () => {
  it('fit inside half the content width on a 1440px screen', () => {
    // 95vw of 1440 is 1368; half of that, less the grid gap and the panel
    // borders, leaves roughly 670px of table. The table has to fit it without
    // a horizontal scrollbar, since it no longer has a scroll box of its own.
    const total = COLUMNS.reduce((a, c) => a + c.width, 0)
    expect(total).toBeLessThanOrEqual(712)
  })

  it('still leaves the chance column wide enough to read', () => {
    expect(DEFAULT_WIDTHS.chance).toBeGreaterThanOrEqual(130)
  })

  it('mirrors every column into DEFAULT_WIDTHS', () => {
    expect(Object.keys(DEFAULT_WIDTHS)).toHaveLength(COLUMNS.length)
    for (const c of COLUMNS) expect(DEFAULT_WIDTHS[c.key]).toBe(c.width)
  })
})
