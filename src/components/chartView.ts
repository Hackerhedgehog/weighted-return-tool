/**
 * The pan/zoom view model shared by SimChart and BankrollChart.
 *
 * `zoom` is a span multiplier of an axis's own auto-computed baseline
 * (`autoMax`) — unchanged from the y-only zoom this extends. `pan` is new:
 * a *fraction of that same baseline*, not a pixel or absolute value, so it
 * scales automatically as the baseline moves (autoYMax grows during a live
 * run) — the same reason zoom is multiplicative rather than absolute.
 *
 *   span   = autoMax * zoom
 *   center = autoMax * (0.5 + pan)
 *   view   = [center - span/2, center + span/2]
 *
 * At zoom=1, pan=0 this is exactly [0, autoMax] — today's default view.
 * Zooming in with pan=0 shrinks symmetrically around autoMax/2 instead of
 * toward a 0 anchor, which is the fix for "zooming in only shows the
 * bottom." Every clamp below operates on `pan` only — `zoom` is bounded by
 * the callers' own Y_ZOOM_RANGE/X_ZOOM_RANGE.
 */

export interface ViewRange {
  min: number
  max: number
}

export function viewRange(autoMax: number, zoom: number, pan: number): ViewRange {
  const span = autoMax * zoom
  const center = autoMax * (0.5 + pan)
  return { min: center - span / 2, max: center + span / 2 }
}

/** The pan that puts the view's center at `center`, in autoMax units. */
function panForCenter(autoMax: number, center: number): number {
  return center / autoMax - 0.5
}

/**
 * Clamp `pan` so the view never scrolls past `[0, extentMax]` on this axis.
 * When the span is at least as wide as the extent, there is no valid
 * position that satisfies both edges — center exactly instead.
 */
export function clampPanToExtent(
  autoMax: number,
  zoom: number,
  pan: number,
  extentMax: number,
): number {
  const span = autoMax * zoom
  if (span >= extentMax) return panForCenter(autoMax, extentMax / 2)
  const center = autoMax * (0.5 + pan)
  const clampedCenter = Math.min(Math.max(center, span / 2), extentMax - span / 2)
  return panForCenter(autoMax, clampedCenter)
}

/** Clamp `pan` so 0 stays within [viewMin, viewMax] — BankrollChart's y-axis. */
export function clampPanKeepZeroVisible(autoMax: number, zoom: number, pan: number): number {
  const half = (autoMax * zoom) / 2
  const center = autoMax * (0.5 + pan)
  const clampedCenter = Math.min(Math.max(center, -half), half)
  return panForCenter(autoMax, clampedCenter)
}

/** The (zoom, pan) that makes `viewRange(autoMax, zoom, pan)` exactly `[lo, hi]`. */
export function fitZoomPan(autoMax: number, lo: number, hi: number): { zoom: number; pan: number } {
  return { zoom: (hi - lo) / autoMax, pan: panForCenter(autoMax, (lo + hi) / 2) }
}

/** Scrollbar thumb size/position (0..1 track fractions) for the current view. */
export function scrollbarGeometry(
  autoMax: number,
  zoom: number,
  pan: number,
  extentMin: number,
  extentMax: number,
): { size: number; start: number } {
  const { min, max } = viewRange(autoMax, zoom, pan)
  const extent = extentMax - extentMin
  const size = Math.min(1, (max - min) / extent)
  const start = Math.min(1 - size, Math.max(0, (min - extentMin) / extent))
  return { size, start }
}

/** Inverse of scrollbarGeometry: the pan value that puts the thumb at `start`. */
export function panFromScrollbarStart(
  autoMax: number,
  zoom: number,
  start: number,
  extentMin: number,
  extentMax: number,
): number {
  const extent = extentMax - extentMin
  const span = autoMax * zoom
  const viewMin = extentMin + start * extent
  return panForCenter(autoMax, viewMin + span / 2)
}
