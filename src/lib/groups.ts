import type { BucketRow, GroupDef } from './types'
import { PASTEL_COLORS, TINT_ALPHA, withAlpha } from './palette'

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
 *  4. shared stem            → one group per leading-token stem with two or
 *                              more members: joker5/joker4 → "joker",
 *                              lw-8-16/lw-16-32 → "lw", fs-16-32/fs-32-64 → "fs".
 *  5. anything else          → other.
 *
 * These rules run once, when data is imported. `seedGroups` freezes the result
 * onto the rows as data; everything afterwards reads `row.groupId`, so the
 * heuristics can never overrule a hand-made assignment.
 */

export interface GroupInfo {
  id: string
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
/** Leading alphabetic run of the first token, with any trailing digits cut. */
const STEM_TOKEN_RE = /^([a-z]+)\d*$/

/**
 * Color slots are fixed per group kind, so the seeding is deterministic. Stems
 * draw from ten rotating hues; the 0x and other groups take the palette's two
 * neutrals — they are "everything that isn't a feature", and staying recessive
 * keeps the real groups legible.
 */
const SLOT_WINS = 0
const SLOT_BONUS = 1
const STEM_SLOTS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
const SLOT_ZERO = 19
const SLOT_OTHER = 18

const slotColor = (slot: number) => PASTEL_COLORS[slot % PASTEL_COLORS.length]
const slotTint = (slot: number) => withAlpha(slotColor(slot), TINT_ALPHA)

/**
 * The name pattern a label leads with: "joker5-maxwin" → "joker",
 * "lw-8-16" → "lw", "fs-32-64" → "fs".
 *
 * Only the *first* token counts. Scanning further, as this used to, finds a
 * stem in the wrong place — "lw-8-16" has no alpha+digits token at all, so
 * families named by a bare prefix were never detected and fell through to
 * "other" one by one. The first token is what a person reads as the family
 * name, whether or not it carries a number.
 */
export function stemOf(label: string): string | null {
  const first = label.toLowerCase().trim().split(/[-_\s]+/).filter(Boolean)[0]
  if (first === undefined) return null
  const m = STEM_TOKEN_RE.exec(first)
  return m === null ? null : m[1]
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
  const push = (id: string, name: string, slot: number, uids: string[]) => {
    if (uids.length === 0) return
    groups.push({ id, name, color: slotColor(slot), tint: slotTint(slot), uids })
  }

  push('wins', 'wins', SLOT_WINS, wins)
  push('bonus', 'bonus', SLOT_BONUS, bonus)
  stems.forEach(([stem, uids], i) => {
    push(`stem:${stem}`, stem, STEM_SLOTS[i % STEM_SLOTS.length], uids)
  })
  push('zero', '0x', SLOT_ZERO, zero)
  push('other', 'other', SLOT_OTHER, other)

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

/**
 * Turn the detector's output into document data: a list of groups and a
 * groupId stamped on every row.
 *
 * Detection runs exactly once, when data is imported. After that the
 * assignment is the user's — editable in the table and in group settings, and
 * carried in undo history like any other edit — so a rename, a recolor or a
 * hand-moved bucket is never silently undone by a re-run of the heuristics.
 */
export function seedGroups(rows: BucketRow[]): { groups: GroupDef[]; rows: BucketRow[] } {
  const detected = groupRows(rows)
  const groups: GroupDef[] = detected.groups.map((g) => ({
    id: g.id,
    name: g.name,
    color: g.color,
  }))
  const fallback = groups[0]?.id ?? ''
  return {
    groups,
    rows: rows.map((r) => ({ ...r, groupId: detected.byUid.get(r.uid)?.id ?? fallback })),
  }
}

/**
 * The display view of the stored assignment: the same shape the chart and the
 * table already consume, built from `row.groupId` rather than from the label
 * heuristics. Groups keep the order of the `groups` array, which is what the
 * chart handles and the group sort read as rank.
 */
export function buildGrouping(rows: BucketRow[], groups: GroupDef[]): Grouping {
  const infos: GroupInfo[] = groups.map((g) => ({
    id: g.id,
    name: g.name,
    color: g.color,
    tint: withAlpha(g.color, TINT_ALPHA),
    uids: [],
  }))
  const byId = new Map(infos.map((g) => [g.id, g]))

  const byUid = new Map<string, GroupInfo>()
  const rank = new Map<string, number>()
  const indexOf = new Map(groups.map((g, i) => [g.id, i]))

  for (const r of rows) {
    const info = byId.get(r.groupId)
    if (info === undefined) continue
    info.uids.push(r.uid)
    byUid.set(r.uid, info)
    rank.set(r.uid, indexOf.get(r.groupId)!)
  }

  // An empty group still exists as far as settings are concerned, but it has
  // no handle to drag and no rank to sort by, so it is dropped from the view.
  const used = infos.filter((g) => g.uids.length > 0)
  const usedRank = new Map(used.map((g, i) => [g.id, i]))
  for (const [uid, info] of byUid) rank.set(uid, usedRank.get(info.id)!)

  return { groups: used, byUid, rank }
}

/** A fresh group id that cannot collide with a detector id or an existing one. */
export function nextGroupId(groups: GroupDef[]): string {
  let n = groups.length + 1
  const taken = new Set(groups.map((g) => g.id))
  while (taken.has(`g${n}`)) n += 1
  return `g${n}`
}

/** The next palette color not already in use, wrapping when all are taken. */
export function nextGroupColor(groups: GroupDef[]): string {
  const taken = new Set(groups.map((g) => g.color.toLowerCase()))
  return (
    PASTEL_COLORS.find((c) => !taken.has(c.toLowerCase())) ??
    PASTEL_COLORS[groups.length % PASTEL_COLORS.length]
  )
}

/**
 * How much of a group is locked. A group has no lock of its own: it is locked
 * when every one of its buckets is, which keeps row locks the single source of
 * truth for the solver, for `interact.ts` and for the export.
 */
export type LockState = 'none' | 'some' | 'all'

export function groupLockState(rows: BucketRow[], groupId: string): LockState {
  let members = 0
  let locked = 0
  for (const r of rows) {
    if (r.groupId !== groupId) continue
    members += 1
    if (r.locked) locked += 1
  }
  if (members === 0 || locked === 0) return 'none'
  return locked === members ? 'all' : 'some'
}
