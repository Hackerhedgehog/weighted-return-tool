/**
 * Distribute `totalWeight` integer weight units across buckets based on their
 * payout multipliers so that total RTP lands as close as possible to
 * `targetRtp`.
 *
 * Model: weight share of bucket i ∝ (payout_i + 1)^(-alpha).
 * RTP(alpha) is monotonically decreasing in alpha (higher alpha shifts weight
 * toward low payouts), so we binary-search alpha for the target RTP, then
 * round shares to integers that sum exactly to totalWeight.
 */
export function distributeWeights(
  payouts: number[],
  totalWeight: number,
  targetRtp: number,
): number[] {
  const n = payouts.length
  if (n === 0) return []
  if (totalWeight < n) return payouts.map(() => 1)

  const sharesFor = (alpha: number): number[] => {
    // Subtract max exponent before exponentiating to avoid overflow/underflow.
    const logs = payouts.map((p) => -alpha * Math.log(p + 1))
    const maxLog = Math.max(...logs)
    const raw = logs.map((l) => Math.exp(l - maxLog))
    const sum = raw.reduce((a, b) => a + b, 0)
    return raw.map((r) => r / sum)
  }

  const rtpFor = (alpha: number): number =>
    sharesFor(alpha).reduce((acc, s, i) => acc + s * payouts[i], 0)

  let lo = -30
  let hi = 30
  // Clamp target into the achievable range for this payout set.
  const target = Math.min(Math.max(targetRtp, rtpFor(hi)), rtpFor(lo))
  for (let iter = 0; iter < 100; iter++) {
    const mid = (lo + hi) / 2
    if (rtpFor(mid) > target) lo = mid
    else hi = mid
  }

  const shares = sharesFor((lo + hi) / 2)

  // Round to integers >= 1, then push the remainder into the largest bucket
  // (typically the zero/low payout bucket) so the sum is exact.
  const weights = shares.map((s) => Math.max(1, Math.round(s * totalWeight)))
  let biggest = 0
  for (let i = 1; i < n; i++) {
    if (shares[i] > shares[biggest]) biggest = i
  }
  const diff = totalWeight - weights.reduce((a, b) => a + b, 0)
  weights[biggest] = Math.max(1, weights[biggest] + diff)

  correctRounding(weights, payouts, totalWeight, target)
  return weights
}

/**
 * Integer rounding (and the min-weight-1 clamp) drifts the achieved RTP away
 * from the target. Transfer weight units between the lowest-payout bucket and
 * other buckets to close the gap without changing the total.
 */
function correctRounding(
  weights: number[],
  payouts: number[],
  totalWeight: number,
  targetRtp: number,
): void {
  let minIdx = 0
  for (let i = 1; i < payouts.length; i++) {
    if (payouts[i] < payouts[minIdx]) minIdx = i
  }
  const pMin = payouts[minIdx]

  // Candidate partners: richest buckets first so transfers have headroom.
  const order = payouts
    .map((_, i) => i)
    .filter((i) => i !== minIdx && payouts[i] !== pMin)
    .sort((a, b) => weights[b] - weights[a])

  for (const j of order) {
    const current = weights.reduce((acc, w, i) => acc + w * payouts[i], 0)
    // Weight·payout units still missing from the target return.
    const err = targetRtp * totalWeight - current
    const perUnit = payouts[j] - pMin
    let d = Math.round(err / perUnit) // move d units from minIdx to j
    if (d === 0) continue
    d = Math.max(-(weights[j] - 1), Math.min(weights[minIdx] - 1, d))
    weights[minIdx] -= d
    weights[j] += d
  }
}

/** Rescale existing weights proportionally to a new total, preserving RTP. */
export function rescaleWeights(weights: number[], newTotal: number): number[] {
  const currentTotal = weights.reduce((a, b) => a + b, 0)
  if (currentTotal <= 0 || newTotal <= 0) return weights
  const scaled = weights.map((w) => Math.max(w > 0 ? 1 : 0, Math.round((w / currentTotal) * newTotal)))
  const diff = newTotal - scaled.reduce((a, b) => a + b, 0)
  let biggest = 0
  for (let i = 1; i < scaled.length; i++) {
    if (scaled[i] > scaled[biggest]) biggest = i
  }
  scaled[biggest] = Math.max(0, scaled[biggest] + diff)
  return scaled
}
