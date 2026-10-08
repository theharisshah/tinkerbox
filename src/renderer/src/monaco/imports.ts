import { braceDepthAt, maskPhp } from './phpScan'

/**
 * `use` statements: parsing the imports of the buffer and computing where a new `use FQCN;` goes (after the
 * existing imports, else after `<?php` / `declare(…);` / `namespace …;`, else at the top).
 */

export interface UseStatement {
  /** Imported name without a leading backslash. */
  fqcn: string
  /** Name the import is available under (`as` alias or the last segment). */
  alias: string
  kind: 'class' | 'function' | 'const'
  /** Offset of the `use` keyword and just after the statement's `;`. */
  start: number
  end: number
}

export function shortName(fqcn: string): string {
  const clean = fqcn.replace(/^\\+/, '')
  const i = clean.lastIndexOf('\\')
  return i < 0 ? clean : clean.slice(i + 1)
}

export function namespaceOf(fqcn: string): string {
  const clean = fqcn.replace(/^\\+/, '')
  const i = clean.lastIndexOf('\\')
  return i < 0 ? '' : clean.slice(0, i)
}

function parseClause(clause: string): { name: string; alias: string } | null {
  const m = /^\\?([A-Za-z_\x80-￿][\w\x80-￿]*(?:\\[A-Za-z_\x80-￿][\w\x80-￿]*)*)(?:\s+as\s+([A-Za-z_\x80-￿][\w\x80-￿]*))?$/i.exec(
    clause.trim()
  )
  if (!m) return null
  return { name: m[1], alias: m[2] ?? shortName(m[1]) }
}

/** Top-level `use` statements (closure `use (…)` and trait `use` inside class bodies are ignored). */
export function parseUseStatements(code: string): UseStatement[] {
  const masked = maskPhp(code)
  const out: UseStatement[] = []
  const re = /(^|[;{}\n])([ \t]*)use\s+(function\s+|const\s+)?([^;(]+);/g
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    const start = m.index + m[1].length + m[2].length
    if (braceDepthAt(masked, start) !== 0) continue
    const kind = m[3] ? (m[3].trim().toLowerCase() as 'function' | 'const') : 'class'
    const bodyStart = m.index + m[0].length - 1 - m[4].length
    const body = code.slice(bodyStart, bodyStart + m[4].length).replace(/\s+/g, ' ').trim()
    const end = m.index + m[0].length
    const group = /^\\?([\w\x80-￿\\]+?)\\?\{([^}]*)\}$/.exec(body)
    if (group) {
      const prefix = group[1].replace(/\\$/, '')
      for (const part of group[2].split(',')) {
        const clause = parseClause(part)
        if (clause) out.push({ fqcn: `${prefix}\\${clause.name}`, alias: clause.alias, kind, start, end })
      }
      continue
    }
    for (const part of body.split(',')) {
      const clause = parseClause(part)
      if (clause) out.push({ fqcn: clause.name, alias: clause.alias, kind, start, end })
    }
  }
  return out
}

/** Alias under which a class is imported, or null. */
export function importedAs(uses: readonly UseStatement[], fqcn: string): string | null {
  const wanted = fqcn.replace(/^\\+/, '').toLowerCase()
  const hit = uses.find((u) => u.kind === 'class' && u.fqcn.toLowerCase() === wanted)
  return hit ? hit.alias : null
}

/** FQCN imported under `alias` (case-insensitive), or null. */
export function importFor(uses: readonly UseStatement[], alias: string): string | null {
  const wanted = alias.toLowerCase()
  const hit = uses.find((u) => u.kind === 'class' && u.alias.toLowerCase() === wanted)
  return hit ? hit.fqcn : null
}

export interface TextInsertion {
  /** Offset in the code where `text` is inserted. */
  offset: number
  text: string
}

const HEADER_LINE = /^\s*(?:<\?(?:php)?\b.*|declare\s*\(.*\)\s*;.*|namespace\s+[\w\\]+\s*;.*)$/i

/**
 * Insertion that adds `use FQCN;` — after the last top-level import, else after the file header, else at the top.
 * Null when the class is already imported (or the short name is taken by another import).
 */
export function computeUseInsertion(code: string, fqcn: string): TextInsertion | null {
  const name = fqcn.replace(/^\\+/, '')
  if (!name) return null
  const uses = parseUseStatements(code).filter((u) => u.kind === 'class')
  if (importedAs(uses, name)) return null
  if (importFor(uses, shortName(name))) return null
  const statement = `use ${name};`

  if (uses.length) {
    const lastEnd = Math.max(...uses.map((u) => u.end))
    const newline = code.indexOf('\n', lastEnd)
    if (newline < 0) return { offset: code.length, text: `\n${statement}` }
    return { offset: newline + 1, text: `${statement}\n` }
  }

  const lines = code.split('\n')
  let headerEnd = -1
  for (let i = 0; i < lines.length; i++) {
    if (HEADER_LINE.test(lines[i])) {
      headerEnd = i
      continue
    }
    if (lines[i].trim() === '' && headerEnd === i - 1 && headerEnd >= 0) continue
    break
  }
  if (headerEnd < 0) {
    const firstBlank = lines.length > 0 && lines[0].trim() === ''
    return { offset: 0, text: code === '' || firstBlank ? `${statement}\n` : `${statement}\n\n` }
  }
  let offset = 0
  for (let i = 0; i <= headerEnd; i++) offset += lines[i].length + 1
  if (headerEnd + 1 >= lines.length) return { offset: code.length, text: `\n\n${statement}\n` }
  const nextLine = lines[headerEnd + 1]
  if (nextLine.trim() === '') {
    const afterBlank = offset + nextLine.length + 1
    const following = lines[headerEnd + 2]
    if (following === undefined) return { offset: code.length, text: `\n${statement}\n` }
    return { offset: afterBlank, text: following.trim() === '' ? `${statement}\n` : `${statement}\n\n` }
  }
  return { offset, text: `\n${statement}\n\n` }
}

/** Apply an insertion to a string (tests and fallbacks). */
export function applyInsertion(code: string, insertion: TextInsertion): string {
  return code.slice(0, insertion.offset) + insertion.text + code.slice(insertion.offset)
}
