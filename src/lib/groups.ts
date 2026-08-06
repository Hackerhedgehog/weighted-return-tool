import type { BucketRow } from './types'

/**
 * Bucket grouping by payout and label, for color coding, group sort and the
 * chart's group handles.
 *
 * Rules, in priority order — earlier rules claim a bucket outright:
 *
 *  1. payout == 0            → the `0x` group. Beats every name rule, so a
 *                              "joker2-tease" that pays nothing sits with the
 *                              other duds, not with "joker3".
 *  2. label contains "bonus" → the bonus group (case-insensitive).
 *  3. label is a pure range  → the wins group ("0-1x", "8-16x", "512-1024x").
 *  4. shared stem            → one group per alpha+digits stem with two or
 *                              more members: joker5/joker4 → "joker",
 *                              diamond3/diamond4 → "diamond".
 *  5. anything else          → other.
 */

export type GroupKind = 'wins' | 'bonus' | 'stem' | 'zero' | 'other'

export interface GroupInfo {
  id: string
  kind: GroupKind
  /** Display name — the stem itself for stem groups. */
  name: string
  /** CSS color for chart marks. */
  color: string
  /** Low-alpha companion for table row backgrounds. */
  tint: string
  /** Member rows, in table order. */
  uids: string[]
}

export interface Grouping {
  groups: GroupInfo[]
  byUid: Map<string, GroupInfo>
  /** uid → index into `groups`, for sorting. */
  rank: Map<string, number>
}

const RANGE_RE = /^\d+(\.\d+)?\s*-\s*\d+(\.\d+)?x$/i
const STEM_TOKEN_RE = /^([a-z]+)(\d+)$/

/**
 * Color slots are fixed per group kind, so a group keeps its color as rows
 * come and go. Stems draw from four rotating hues; the 0x and other groups
 * are deliberately gray — they are "everything that isn't a feature", and
 * recessive neutrals keep the real groups legible. Values live in CSS as
 * --series-N / --series-N-tint.
 */
const SLOT_WINS = 0
const SLOT_BONUS = 1
const STEM_SLOTS = [2, 3, 4, 5]
const SLOT_ZERO = 6
const SLOT_OTHER = 7

const slotColor = (slot: number) => `var(--series-${slot})`
const slotTint = (slot: number) => `var(--series-${slot}-tint)`

/** First alpha+digits token gives the stem: "joker5-maxwin" → "joker". */
export function stemOf(label: string): string | null {
  for (const token of label.toLowerCase().split(/[-_\s]+/)) {
    const m = STEM_TOKEN_RE.exec(token)
    if (m !== null) return m[1]
  }
  return null
}

export function groupRows(rows: BucketRow[]): Grouping {
  const zero: string[] = []
  const bonus: string[] = []
  const wins: string[] = []
  const other: string[] = []
  const byStem = new Map<string, string[]>()

  for (const r of rows) {
    if (!(r.payout > 0)) {
      zero.push(r.uid)
    } else if (/bonus/i.test(r.label)) {
      bonus.push(r.uid)
    } else if (RANGE_RE.test(r.label.trim())) {
      wins.push(r.uid)
    } else {
      const stem = stemOf(r.label)
      if (stem === null) {
        other.push(r.uid)
      } else {
        const list = byStem.get(stem)
        if (list === undefined) byStem.set(stem, [r.uid])
        else list.push(r.uid)
      }
    }
  }

  // A stem needs company; singletons drop through to `other`, keeping the
  // original row order among the fallthroughs irrelevant (other is sorted by
  // the table anyway).
  const stems = [...byStem.entries()]
    .filter(([, uids]) => uids.length >= 2)
    .sort(([a], [b]) => a.localeCompare(b))
  for (const uids of byStem.values()) {
    if (uids.length < 2) other.push(...uids)
  }

  const groups: GroupInfo[] = []
  const push = (id: string, kind: GroupKind, name: string, slot: number, uids: string[]) => {
    if (uids.length === 0) return
    groups.push({ id, kind, name, color: slotColor(slot), tint: slotTint(slot), uids })
  }

  push('wins', 'wins', 'wins', SLOT_WINS, wins)
  push('bonus', 'bonus', 'bonus', SLOT_BONUS, bonus)
  stems.forEach(([stem, uids], i) => {
    push(`stem:${stem}`, 'stem', stem, STEM_SLOTS[i % STEM_SLOTS.length], uids)
  })
  push('zero', 'zero', '0x', SLOT_ZERO, zero)
  push('other', 'other', 'other', SLOT_OTHER, other)

  const byUid = new Map<string, GroupInfo>()
  const rank = new Map<string, number>()
  groups.forEach((g, i) => {
    for (const uid of g.uids) {
      byUid.set(uid, g)
      rank.set(uid, i)
    }
  })

  return { groups, byUid, rank }
}
