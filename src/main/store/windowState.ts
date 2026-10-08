import { isFiniteNumber, isPlainObject } from './common'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowState {
  /** Absent → center on the primary display. */
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

export const MIN_WINDOW_WIDTH = 910
export const MIN_WINDOW_HEIGHT = 630
export const DEFAULT_WINDOW_STATE: WindowState = { width: 1280, height: 820, maximized: false }

export function normalizeWindowState(raw: unknown): WindowState {
  if (!isPlainObject(raw)) throw new Error('window-state.json must contain a JSON object')
  const state: WindowState = {
    width: isFiniteNumber(raw.width) ? Math.round(raw.width) : DEFAULT_WINDOW_STATE.width,
    height: isFiniteNumber(raw.height) ? Math.round(raw.height) : DEFAULT_WINDOW_STATE.height,
    maximized: raw.maximized === true
  }
  if (isFiniteNumber(raw.x) && isFiniteNumber(raw.y)) {
    state.x = Math.round(raw.x)
    state.y = Math.round(raw.y)
  }
  return state
}

function intersection(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * Bounds to restore a window with: keeps the saved position when a meaningful part of the window (and its title
 * bar) is visible on a connected display, otherwise centers it on the primary display. Sizes are clamped to the
 * minimum window size and to the work area of the display the window ends up on.
 */
export function restoreBounds(saved: WindowState, workAreas: Rect[], primary: Rect): Partial<Rect> & { width: number; height: number } {
  const width = Math.max(MIN_WINDOW_WIDTH, saved.width)
  const height = Math.max(MIN_WINDOW_HEIGHT, saved.height)

  if (saved.x !== undefined && saved.y !== undefined) {
    const rect: Rect = { x: saved.x, y: saved.y, width, height }
    // The title bar strip must be reachable, otherwise the window cannot be dragged back.
    const titleBar: Rect = { x: saved.x, y: saved.y, width, height: 40 }
    let best: Rect | null = null
    let bestArea = 0
    for (const area of workAreas) {
      const visible = intersection(rect, area)
      if (visible > bestArea && intersection(titleBar, area) >= 100 * 20) {
        best = area
        bestArea = visible
      }
    }
    if (best && bestArea >= 200 * 150) {
      return {
        x: saved.x,
        y: saved.y,
        width: Math.min(width, Math.max(MIN_WINDOW_WIDTH, best.width)),
        height: Math.min(height, Math.max(MIN_WINDOW_HEIGHT, best.height))
      }
    }
  }

  const w = Math.min(width, Math.max(MIN_WINDOW_WIDTH, primary.width))
  const h = Math.min(height, Math.max(MIN_WINDOW_HEIGHT, primary.height))
  return {
    x: Math.round(primary.x + (primary.width - w) / 2),
    y: Math.round(primary.y + (primary.height - h) / 2),
    width: w,
    height: h
  }
}
