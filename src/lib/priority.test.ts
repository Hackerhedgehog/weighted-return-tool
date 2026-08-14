import { describe, expect, it } from 'vitest'
import { DEFAULT_PRIORITY, normalizePriority } from './types'

describe('normalizePriority', () => {
  it('ranks User curve second by default', () => {
    expect(DEFAULT_PRIORITY).toEqual(['rtp', 'usercurve', 'ordering', 'volatility', 'hit', 'win'])
    expect(normalizePriority(undefined)).toEqual(DEFAULT_PRIORITY)
  })

  it('inserts missing keys at their default-relative position', () => {
    // A pre-usercurve workspace: usercurve must land at rank 2, not be
    // appended after the keys the user deliberately ranked.
    expect(normalizePriority(['rtp', 'ordering', 'volatility', 'hit', 'win'])).toEqual([
      'rtp',
      'usercurve',
      'ordering',
      'volatility',
      'hit',
      'win',
    ])
  })

  it('places missing keys after the last present key that precedes them by default', () => {
    expect(normalizePriority(['win', 'rtp'])).toEqual([
      'win',
      'rtp',
      'usercurve',
      'ordering',
      'volatility',
      'hit',
    ])
  })

  it('drops unknown keys and collapses duplicates', () => {
    expect(normalizePriority(['rtp', 'rtp', 'nonsense', 'win'])).toEqual([
      'rtp',
      'usercurve',
      'ordering',
      'volatility',
      'hit',
      'win',
    ])
  })
})
