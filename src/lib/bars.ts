import type { BucketRow } from './types'
import type { GroupInfo, Grouping } from './groups'

/**
 * What the distribution chart draws, worked out away from the chart itself.
 *
 * Two independent aggregations land here, and the order between them is the
 * whole design:
 *
 *  1. A group the user has collapsed becomes exactly one bar, whatever payouts
 *     its buckets span.
 *  2. Whatever is left over aggregates by equal payout, as it always has.
 *
 * Collapsing first is what makes the two composable: a collapsed group is gone
 * before the payout pass runs, so a bucket can never appear both inside a group
 * bar and inside an equal-payout bar.
 */

export interface Segment {
  color: string
  weight: number
  chance: number
}

interface BarBase {
  /** Where the bar sits on the payout axis. */
  payout: number
  weight: number
  /** Share of the grand total — never of the bar's own group. */
  chance: number
  labels: string[]
  uids: string[]
  /** One per group present in the bar, in group rank order — stacked bottom-up. */
  segments: Segment[]
  allLocked: boolean
}

export interface BucketBar extends BarBase {
  kind: 'buckets'
}

export interface GroupBar extends BarBase {
  kind: 'group'
  groupId: string
  name: string
  /** Lowest and highest member payout, for the readout. */
  payoutRange: [number, number]
}

export type ChartBar = BucketBar | GroupBar

export interface BuildBarsOptions {
  /** Merge loose buckets that share a payout into one bar. */
  aggregate: boolean
  /** Group ids drawn as a single bar instead of their buckets. */
  groupBars: string[]
  /** A log payout axis has nowhere to put a zero-payout bar. */
  logX: boolean
  /**
   * 'group' clusters the ladder by group rank (payout order inside each
   * group). Ignored under logX, whose positions are payout-derived.
   */
  xOrder?: 'payout' | 'group'
}

export interface BuiltBars {
  bars: ChartBar[]
  /** Bars a log axis had to omit, for the axis title's note. */
  droppedZero: number
}

export function buildBars(
  rows: BucketRow[],
  grouping: Grouping,
  totalWeight: number,
  opts: BuildBarsOptions,
): BuiltBars {
  const chanceOf = (w: number) => (totalWeight > 0 ? w / totalWeight : 0)
  const rankOf = (uid: string) => grouping.rank.get(uid) ?? Number.MAX_SAFE_INTEGER
  const colorOf = (uid: string) => grouping.byUid.get(uid)?.color ?? 'var(--bar)'

  const collapsed = new Set(opts.groupBars)

  const bucketBar = (members: BucketRow[]): BucketBar => {
    const byRank = new Map<number, Segment>()
    for (const r of [...members].sort((a, b) => rankOf(a.uid) - rankOf(b.uid))) {
      const seg = byRank.get(rankOf(r.uid))
      if (seg) {
        seg.weight += r.weight
        seg.chance += chanceOf(r.weight)
      } else {
        byRank.set(rankOf(r.uid), {
          color: colorOf(r.uid),
          weight: r.weight,
          chance: chanceOf(r.weight),
        })
      }
    }
    const weight = members.reduce((a, r) => a + r.weight, 0)
    return {
      kind: 'buckets',
      payout: members[0].payout,
      weight,
      chance: chanceOf(weight),
      labels: members.map((r) => r.label),
      uids: members.map((r) => r.uid),
      segments: [...byRank.values()],
      allLocked: members.every((r) => r.locked),
    }
  }

  const groupBar = (g: GroupInfo, members: BucketRow[]): GroupBar => {
    const weight = members.reduce((a, r) => a + r.weight, 0)
    // The bar goes where the group's mass is, so its position against the
    // loose bars still means something. With no weight there is nothing to
    // weight by, and the plain mean is the only honest answer left.
    const payout =
      weight > 0
        ? members.reduce((a, r) => a + r.payout * r.weight, 0) / weight
        : members.reduce((a, r) => a + r.payout, 0) / members.length
    const payouts = members.map((r) => r.payout)
    return {
      kind: 'group',
      groupId: g.id,
      name: g.name,
      payout,
      payoutRange: [Math.min(...payouts), Math.max(...payouts)],
      weight,
      chance: chanceOf(weight),
      labels: members.map((r) => r.label),
      uids: members.map((r) => r.uid),
      // One group, so one solid segment — never a stack.
      segments: [{ color: g.color, weight, chance: chanceOf(weight) }],
      allLocked: members.every((r) => r.locked),
    }
  }

  const byUid = new Map(rows.map((r) => [r.uid, r]))
  const bars: ChartBar[] = []

  for (const g of grouping.groups) {
    if (!collapsed.has(g.id)) continue
    const members = g.uids
      .map((uid) => byUid.get(uid))
      .filter((r): r is BucketRow => r !== undefined)
    if (members.length > 0) bars.push(groupBar(g, members))
  }

  const loose = rows.filter((r) => {
    const id = grouping.byUid.get(r.uid)?.id
    return id === undefined || !collapsed.has(id)
  })

  if (opts.aggregate) {
    const byPayout = new Map<number, BucketRow[]>()
    for (const r of loose) {
      const list = byPayout.get(r.payout)
      if (list === undefined) byPayout.set(r.payout, [r])
      else list.push(r)
    }
    for (const members of byPayout.values()) bars.push(bucketBar(members))
  } else {
    const ordered = [...loose].sort((a, b) => a.payout - b.payout || a.bucketId - b.bucketId)
    for (const r of ordered) bars.push(bucketBar([r]))
  }

  // Stable, so the bucketId tiebreak above survives and a group bar tying with
  // a loose bar keeps the order they were pushed in.
  const groupRankOf = (b: ChartBar) =>
    Math.min(...b.uids.map((u) => grouping.rank.get(u) ?? Number.MAX_SAFE_INTEGER))
  if (opts.xOrder === 'group' && !opts.logX) {
    bars.sort((a, b) => groupRankOf(a) - groupRankOf(b) || a.payout - b.payout)
  } else {
    bars.sort((a, b) => a.payout - b.payout)
  }

  if (!opts.logX) return { bars, droppedZero: 0 }
  const kept = bars.filter((b) => b.payout > 0)
  return { bars: kept, droppedZero: bars.length - kept.length }
}
