import type { AppPanel } from '@shared/types'

/**
 * Display helpers of the Panels modal (tests/unit/modals-b/panels.test.ts). Main already normalizes driver
 * panels; these helpers stay defensive because custom drivers can return almost anything.
 */

export type PanelRow = { key: string; value: string }
export type PanelSection = { title: string; rows: PanelRow[] }

function text(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Clean panels for display: string titles (fallback "Panel N" / "General"), string keys / values, rows without a
 * key dropped, empty sections and panels without rows dropped.
 */
export function normalizePanels(raw: unknown): AppPanel[] {
  if (!Array.isArray(raw)) return []
  const panels: AppPanel[] = []
  raw.forEach((panel, index) => {
    if (!isRecord(panel)) return
    const sections: PanelSection[] = []
    const rawSections = Array.isArray(panel.sections) ? panel.sections : []
    for (const section of rawSections) {
      if (!isRecord(section)) continue
      const rows: PanelRow[] = []
      for (const row of Array.isArray(section.rows) ? section.rows : []) {
        if (!isRecord(row)) continue
        const key = text(row.key).trim()
        if (!key) continue
        rows.push({ key, value: text(row.value) })
      }
      if (rows.length) sections.push({ title: text(section.title).trim(), rows })
    }
    if (!sections.length) return
    const title = text(panel.title).trim() || `Panel ${index + 1}`
    panels.push({ title, sections })
  })
  return panels
}

export type ValueKind = 'empty' | 'on' | 'off' | 'url' | 'path' | 'number' | 'text'

const ON = new Set(['true', 'enabled', 'on', 'yes', 'cached', 'active'])
const OFF = new Set(['false', 'disabled', 'off', 'no', 'not cached', 'inactive', 'none'])

/** How a panel value is rendered: badge for booleans / states, link for URLs, mono for paths and numbers. */
export function classifyValue(value: string): ValueKind {
  const v = value.trim()
  if (v === '' || v === 'null' || v === '-' || v === '—') return 'empty'
  const lower = v.toLowerCase()
  if (ON.has(lower)) return 'on'
  if (OFF.has(lower)) return 'off'
  if (/^https?:\/\/\S+$/i.test(v)) return 'url'
  if (/^(?:\/|~\/|[A-Za-z]:\\)\S*/.test(v) && !/\s{2,}/.test(v)) return 'path'
  if (/^[-+]?\d+(?:[.,]\d+)*(?:\s?(?:ms|s|kb|mb|gb|%))?$/i.test(v)) return 'number'
  return 'text'
}

/**
 * Label of state values: "true" → "Enabled" / "false" → "Disabled" ("Cached" / "Not cached" inside a cache
 * section, like `artisan about`); other values are shown as is.
 */
export function displayValue(value: string, sectionTitle = ''): string {
  const kind = classifyValue(value)
  const lower = value.trim().toLowerCase()
  if (kind === 'empty') return '—'
  const cache = /\bcach(e|ing)\b/i.test(sectionTitle)
  if (kind === 'on' && lower === 'true') return cache ? 'Cached' : 'Enabled'
  if (kind === 'off' && lower === 'false') return cache ? 'Not cached' : 'Disabled'
  return value
}

/** Plain-text copy of a panel ("Section" headings, "Key: value" rows). */
export function panelToText(panel: AppPanel): string {
  const lines: string[] = [panel.title]
  for (const section of panel.sections) {
    lines.push('')
    if (section.title) lines.push(section.title)
    const width = Math.min(32, Math.max(0, ...section.rows.map((r) => r.key.length)))
    for (const row of section.rows) lines.push(`  ${row.key.padEnd(width)}  ${row.value}`)
  }
  return lines.join('\n')
}

/** Total number of rows of a panel (tab badge). */
export function panelRowCount(panel: AppPanel): number {
  return panel.sections.reduce((n, s) => n + s.rows.length, 0)
}
