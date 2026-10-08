/** Clickable references in CLI-mode text: URLs, file paths (with :line) and "line N" editor references. */

export type CliLinkTarget = { kind: 'url'; url: string } | { kind: 'file'; file: string; line?: number } | { kind: 'line'; line: number }

export interface CliLink {
  /** 0-based start column (inclusive). */
  start: number
  /** 0-based end column (exclusive). */
  end: number
  target: CliLinkTarget
}

const URL_RE = /\bhttps?:\/\/[^\s"'<>`]+[^\s"'<>`.,;:!?)\]}]/g
const FILE_RE =
  /(?<![\w/.~@-])((?:[A-Za-z]:[\\/]|~?\/)?(?:[\w.@-]+[\\/])+[\w.@-]+\.(?:blade\.php|php|phtml|inc|json|js|mjs|ts|vue|ya?ml|env|log|txt|xml|twig|neon|md|ini|conf|sql))(?::(\d+)|\((\d+)\)| on line (\d+))?/g
const LINE_RE = /\b(?:on )?line (\d+)\b/gi

export function findCliLinks(line: string): CliLink[] {
  const links: CliLink[] = []
  const overlaps = (start: number, end: number): boolean => links.some((l) => start < l.end && end > l.start)

  for (const m of line.matchAll(URL_RE)) {
    const start = m.index ?? 0
    links.push({ start, end: start + m[0].length, target: { kind: 'url', url: m[0] } })
  }
  for (const m of line.matchAll(FILE_RE)) {
    const start = m.index ?? 0
    const end = start + m[0].length
    if (overlaps(start, end)) continue
    const lineNo = m[2] ?? m[3] ?? m[4]
    links.push({ start, end, target: { kind: 'file', file: m[1], line: lineNo ? Number(lineNo) : undefined } })
  }
  for (const m of line.matchAll(LINE_RE)) {
    const start = m.index ?? 0
    const end = start + m[0].length
    if (overlaps(start, end)) continue
    const n = Number(m[1])
    if (n > 0) links.push({ start, end, target: { kind: 'line', line: n } })
  }
  return links.sort((a, b) => a.start - b.start)
}
