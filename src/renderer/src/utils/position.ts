/** Floating element placement (tooltips, popovers, context menus) — flips and clamps inside the viewport. */

export type Side = 'top' | 'bottom' | 'left' | 'right'
export type Placement = Side | `${Side}-start` | `${Side}-end`

export interface RectLike {
  left: number
  top: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

export interface Position {
  x: number
  y: number
  placement: Placement
}

const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }

function split(placement: Placement): [Side, 'start' | 'end' | 'center'] {
  const [side, align] = placement.split('-') as [Side, 'start' | 'end' | undefined]
  return [side, align ?? 'center']
}

function place(anchor: RectLike, size: Size, side: Side, align: 'start' | 'end' | 'center', offset: number): { x: number; y: number } {
  let x = 0
  let y = 0
  if (side === 'top' || side === 'bottom') {
    y = side === 'top' ? anchor.top - size.height - offset : anchor.top + anchor.height + offset
    if (align === 'start') x = anchor.left
    else if (align === 'end') x = anchor.left + anchor.width - size.width
    else x = anchor.left + anchor.width / 2 - size.width / 2
  } else {
    x = side === 'left' ? anchor.left - size.width - offset : anchor.left + anchor.width + offset
    if (align === 'start') y = anchor.top
    else if (align === 'end') y = anchor.top + anchor.height - size.height
    else y = anchor.top + anchor.height / 2 - size.height / 2
  }
  return { x, y }
}

function fits(pos: { x: number; y: number }, size: Size, viewport: Size, margin: number): boolean {
  return pos.x >= margin && pos.y >= margin && pos.x + size.width <= viewport.width - margin && pos.y + size.height <= viewport.height - margin
}

/** Position a floating box of `size` next to `anchor`; flips to the opposite side when it does not fit. */
export function computePosition(anchor: RectLike, size: Size, placement: Placement, offset = 6, viewport?: Size, margin = 8): Position {
  const vp = viewport ?? {
    width: typeof window !== 'undefined' ? window.innerWidth : 1280,
    height: typeof window !== 'undefined' ? window.innerHeight : 800
  }
  const [side, align] = split(placement)
  let chosenSide = side
  let pos = place(anchor, size, side, align, offset)
  if (!fits(pos, size, vp, margin)) {
    const flipped = place(anchor, size, OPPOSITE[side], align, offset)
    const sideOverflows =
      (side === 'top' && pos.y < margin) ||
      (side === 'bottom' && pos.y + size.height > vp.height - margin) ||
      (side === 'left' && pos.x < margin) ||
      (side === 'right' && pos.x + size.width > vp.width - margin)
    if (sideOverflows && fits(flipped, size, vp, margin)) {
      pos = flipped
      chosenSide = OPPOSITE[side]
    }
  }
  const x = Math.min(Math.max(pos.x, margin), Math.max(margin, vp.width - size.width - margin))
  const y = Math.min(Math.max(pos.y, margin), Math.max(margin, vp.height - size.height - margin))
  const placementOut = (align === 'center' ? chosenSide : `${chosenSide}-${align}`) as Placement
  return { x: Math.round(x), y: Math.round(y), placement: placementOut }
}

/** Position for a context menu opened at a point (opens up/left when there is no room). */
export function menuPosition(point: { x: number; y: number }, size: Size, viewport?: Size, margin = 6): { x: number; y: number } {
  const vp = viewport ?? {
    width: typeof window !== 'undefined' ? window.innerWidth : 1280,
    height: typeof window !== 'undefined' ? window.innerHeight : 800
  }
  let x = point.x
  let y = point.y
  if (x + size.width > vp.width - margin) x = Math.max(margin, point.x - size.width)
  if (y + size.height > vp.height - margin) y = Math.max(margin, point.y - size.height)
  return { x: Math.round(x), y: Math.round(y) }
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'

/** Visible, focusable descendants (focus traps). */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('inert') && el.getAttribute('aria-hidden') !== 'true' && (el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement)
  )
}
