/** Small color helpers used to derive theme tokens (no dependencies). */

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

const HEX = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/** Parse "#rgb", "#rgba", "#rrggbb", "#rrggbbaa" (with or without "#"). */
export function parseHex(color: string): Rgba | null {
  if (typeof color !== 'string') return null
  const m = HEX.exec(color.trim())
  if (!m) return null
  let hex = m[1]
  if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join('')
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
  return { r, g, b, a }
}

export function isHexColor(color: unknown): color is string {
  return typeof color === 'string' && HEX.test(color.trim())
}

function hex2(n: number): string {
  return Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .padStart(2, '0')
}

/** "#rrggbb" (alpha < 1 → "#rrggbbaa"). */
export function toHex(c: Rgba): string {
  const base = `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`
  return c.a < 1 ? base + hex2(c.a * 255) : base
}

/** Normalize any hex color to "#rrggbb[aa]" (with "#"). Returns the fallback when invalid. */
export function normalizeHex(color: string | undefined, fallback: string): string {
  const parsed = color ? parseHex(color) : null
  return parsed ? toHex(parsed) : fallback
}

/** Mix `a` toward `b` by `amount` (0 → a, 1 → b). Alpha is mixed too. */
export function mix(a: string, b: string, amount: number): string {
  const ca = parseHex(a)
  const cb = parseHex(b)
  if (!ca || !cb) return a
  const t = Math.min(1, Math.max(0, amount))
  return toHex({
    r: ca.r + (cb.r - ca.r) * t,
    g: ca.g + (cb.g - ca.g) * t,
    b: ca.b + (cb.b - ca.b) * t,
    a: ca.a + (cb.a - ca.a) * t
  })
}

/** Same color with a new alpha (0..1). */
export function withAlpha(color: string, alpha: number): string {
  const c = parseHex(color)
  if (!c) return color
  return toHex({ ...c, a: Math.min(1, Math.max(0, alpha)) })
}

/** Drop the alpha channel by compositing over `background`. */
export function flatten(color: string, background: string): string {
  const c = parseHex(color)
  const bg = parseHex(background)
  if (!c || !bg) return color
  if (c.a >= 1) return toHex({ ...c, a: 1 })
  return toHex({
    r: c.r * c.a + bg.r * (1 - c.a),
    g: c.g * c.a + bg.g * (1 - c.a),
    b: c.b * c.a + bg.b * (1 - c.a),
    a: 1
  })
}

function channel(v: number): number {
  const s = v / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

/** WCAG relative luminance (0..1). */
export function luminance(color: string): number {
  const c = parseHex(color)
  if (!c) return 0
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

export function isDark(color: string): boolean {
  return luminance(color) < 0.35
}

/** Readable text color on top of `background` (white or a near-black). */
export function readableOn(background: string, dark = '#16141f', light = '#ffffff'): string {
  return contrastRatio(background, light) >= contrastRatio(background, dark) ? light : dark
}

/** Lighten (amount > 0) or darken (amount < 0) toward white/black. */
export function shade(color: string, amount: number): string {
  return amount >= 0 ? mix(color, '#ffffff', amount) : mix(color, '#000000', -amount)
}
