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
  setXPan: (p: number) => void
  setYPan: (p: number) => void
  resetView: () => void
  xScrollbar: ScrollbarState | null
  yScrollbar: ScrollbarState | null
}

/** No scrollbar clutter once the view is (near enough) the full extent. */
const FULL_SIZE_EPSILON = 0.999

export function useChartAxes(cfg: ChartAxesConfig): ChartAxes {
  const viewX = viewRange(cfg.xExtent, cfg.xZoom, cfg.xPan)
  const viewY = viewRange(cfg.autoYMax, cfg.yZoom, cfg.yPan)

  const setXPan = (p: number) => {
    cfg.onXPan(clampPanToExtent(cfg.xExtent, cfg.xZoom, p, cfg.xExtent))
  }

  const setYPan = (p: number) => {
    const clamped = clampPanToExtent(cfg.autoYMax, cfg.yZoom, p, cfg.trueYMax)
    cfg.onYPan(
      cfg.keepZeroVisible === true
        ? clampPanKeepZeroVisible(cfg.autoYMax, cfg.yZoom, clamped)
        : clamped,
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

  const xGeom = scrollbarGeometry(cfg.xExtent, cfg.xZoom, cfg.xPan, 0, cfg.xExtent)
  const yGeom = scrollbarGeometry(cfg.autoYMax, cfg.yZoom, cfg.yPan, 0, cfg.trueYMax)

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
            setYPan(panFromScrollbarStart(cfg.autoYMax, cfg.yZoom, start, 0, cfg.trueYMax)),
        }

  return { viewX, viewY, setXPan, setYPan, resetView, xScrollbar, yScrollbar }
}
