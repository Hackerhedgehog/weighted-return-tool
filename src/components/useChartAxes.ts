import {
  clampPanKeepZeroVisible,
  clampPanToExtent,
  fitZoomPan,
  panFromScrollbarStart,
  scrollbarGeometry,
  viewRange,
  type ViewRange,
} from './chartView'

/**
 * Composes chartView.ts's pure math against one chart's specific baselines,
 * so SimChart and BankrollChart each get a ready-to-render view without
 * duplicating the clamp/scrollbar wiring between them. See chartView.ts's
 * module doc for the underlying model.
 */

export interface ChartAxesConfig {
  xExtent: number
  xZoom: number
  onXZoom: (z: number) => void
  xPan: number
  onXPan: (p: number) => void
  autoYMax: number
  trueYMax: number
  yZoom: number
  onYZoom: (z: number) => void
  yPan: number
  onYPan: (p: number) => void
  keepZeroVisible?: boolean
}

export interface ScrollbarState {
  size: number
  start: number
  onScroll: (start: number) => void
}

export interface ChartAxes {
  viewX: ViewRange
  viewY: ViewRange
  /** The pan value actually used to render viewX — after clamping. Needed by callers (useMiddleDragPan) that must start a drag from the value the user is actually looking at, not the possibly-stale raw prop. */
  xPan: number
  /** Same as xPan, for the y-axis. */
  yPan: number
  setXPan: (p: number) => void
  setYPan: (p: number) => void
  resetView: () => void
  xScrollbar: ScrollbarState | null
  yScrollbar: ScrollbarState | null
}

/** No scrollbar clutter once the view is (near enough) the full extent. */
const FULL_SIZE_EPSILON = 0.999

export function useChartAxes(cfg: ChartAxesConfig): ChartAxes {
  const xPan = clampPanToExtent(cfg.xExtent, cfg.xZoom, cfg.xPan, cfg.xExtent)

  // The extent a plain (non-zero-visible) pan is bounded to must never be
  // narrower than the chart's own default ceiling — otherwise a converged
  // run (autoYMax padded above the true max, the common case) would fail
  // the zoom=1/pan=0 pixel-identity invariant the moment trueYMax dips
  // below autoYMax.
  const yExtent = Math.max(cfg.autoYMax, cfg.trueYMax)

  // keepZeroVisible charts (BankrollChart) use ONLY the zero-visible clamp
  // for y, not the extent clamp too — composing both would force
  // viewMin >= 0 AND viewMin <= 0 simultaneously, pinning pan to a single
  // frozen value at every zoom level (the exact "stuck at 0" bug this
  // feature exists to fix).
  const yPan =
    cfg.keepZeroVisible === true
      ? clampPanKeepZeroVisible(cfg.autoYMax, cfg.yZoom, cfg.yPan)
      : clampPanToExtent(cfg.autoYMax, cfg.yZoom, cfg.yPan, yExtent)

  const viewX = viewRange(cfg.xExtent, cfg.xZoom, xPan)
  const viewY = viewRange(cfg.autoYMax, cfg.yZoom, yPan)

  const setXPan = (p: number) => {
    cfg.onXPan(clampPanToExtent(cfg.xExtent, cfg.xZoom, p, cfg.xExtent))
  }

  const setYPan = (p: number) => {
    cfg.onYPan(
      cfg.keepZeroVisible === true
        ? clampPanKeepZeroVisible(cfg.autoYMax, cfg.yZoom, p)
        : clampPanToExtent(cfg.autoYMax, cfg.yZoom, p, yExtent),
    )
  }

  const resetView = () => {
    const xFit = fitZoomPan(cfg.xExtent, 0, cfg.xExtent)
    cfg.onXZoom(xFit.zoom)
    cfg.onXPan(xFit.pan)
    const yFit = fitZoomPan(cfg.autoYMax, 0, cfg.trueYMax)
    cfg.onYZoom(yFit.zoom)
    cfg.onYPan(yFit.pan)
  }

  const xGeom = scrollbarGeometry(cfg.xExtent, cfg.xZoom, xPan, 0, cfg.xExtent)
  const yGeom = scrollbarGeometry(cfg.autoYMax, cfg.yZoom, yPan, 0, yExtent)

  const xScrollbar: ScrollbarState | null =
    xGeom.size >= FULL_SIZE_EPSILON
      ? null
      : {
          ...xGeom,
          onScroll: (start) =>
            setXPan(panFromScrollbarStart(cfg.xExtent, cfg.xZoom, start, 0, cfg.xExtent)),
        }

  const yScrollbar: ScrollbarState | null =
    yGeom.size >= FULL_SIZE_EPSILON
      ? null
      : {
          ...yGeom,
          onScroll: (start) =>
            setYPan(panFromScrollbarStart(cfg.autoYMax, cfg.yZoom, start, 0, yExtent)),
        }

  return { viewX, viewY, xPan, yPan, setXPan, setYPan, resetView, xScrollbar, yScrollbar }
}
