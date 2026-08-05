export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

/** Chance rendered as a percentage with adaptive precision. */
export function fmtPct(fraction: number): string {
  if (!Number.isFinite(fraction)) return '—'
  if (fraction === 0) return '0%'
  const pct = fraction * 100
  const abs = Math.abs(pct)
  if (abs >= 10) return `${trimZeros(pct.toFixed(3))}%`
  if (abs >= 1) return `${trimZeros(pct.toFixed(4))}%`
  if (abs >= 0.001) return `${trimZeros(pct.toFixed(5))}%`
  return `${pct.toExponential(2)}%`
}

export function fmtReturn(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (n === 0) return '0'
  const abs = Math.abs(n)
  if (abs >= 0.0001) return trimZeros(n.toFixed(6))
  return n.toExponential(3)
}

export function fmtRtp(n: number): string {
  return Number.isFinite(n) ? n.toFixed(4) : '—'
}

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}
