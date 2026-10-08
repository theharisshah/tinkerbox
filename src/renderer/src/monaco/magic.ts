import type { MagicValue } from '@shared/types'
import { scanPhp } from './phpScan'

/**
 * Formatting of magic comment results (`//?`, `//? label`, `/*?*\/`, `/*?->expr*\/`, `/*?.*\/`) into inline badges,
 * and locating the comment in the editor line.
 */

/** Longest value preview rendered inline (the hover shows the full preview). */
export const MAX_BADGE_CHARS = 80
export const MAX_LABEL_CHARS = 32

export interface MagicBadge {
  /** `//? label` text (muted, before the value). */
  label: string | null
  /** One-line value preview (bold, accent). */
  value: string
  /** `×3` when the comment ran more than once (loops). */
  hits: string | null
  /** Full text for the hover. */
  title: string
  kind: 'value' | 'time'
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

/** Seconds for a `/*?.*\/` timing comment: "0.00123s", "1.25s", "75.0s". */
export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0s'
  if (seconds < 1) return `${seconds.toFixed(5).replace(/0+$/, '').replace(/\.$/, '.0')}s`
  if (seconds < 10) return `${seconds.toFixed(3).replace(/0+$/, '').replace(/\.$/, '.0')}s`
  return `${seconds.toFixed(1)}s`
}

function secondsOf(m: MagicValue): number | null {
  const node = m.value
  if (node && (node.t === 'float' || node.t === 'int')) {
    const n = Number(node.v)
    if (Number.isFinite(n)) return n
  }
  const match = /^\s*(\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*s?\s*$/.exec(m.preview ?? '')
  return match ? Number(match[1]) : null
}

/** Badge parts for a magic comment value. */
export function formatMagicBadge(m: MagicValue): MagicBadge {
  const label = m.label ? truncate(oneLine(m.label), MAX_LABEL_CHARS) || null : null
  const hits = m.hits > 1 ? `×${m.hits}` : null
  let full: string
  if (m.type === 'time') {
    const seconds = secondsOf(m)
    full = seconds === null ? oneLine(m.preview || '') : formatSeconds(seconds)
  } else {
    full = oneLine(m.preview ?? '')
    if (full === '') full = m.value ? '…' : 'null'
  }
  const value = truncate(full, MAX_BADGE_CHARS)
  const titleParts = [label ? `${label}: ` : '', m.type === 'time' ? `${full} since the script started` : (m.preview ?? '').trim() || full]
  if (m.hits > 1) titleParts.push(` (hit ${m.hits} times — latest value shown)`)
  return { label, value, hits, title: titleParts.join(''), kind: m.type }
}

export interface MagicCommentLocation {
  /** 0-based column of the comment start. */
  start: number
  /** 0-based column just after the comment. */
  end: number
  /** `/*?*\/` comment in the middle of the code (badge right after it) vs a trailing `//?` (badge at line end). */
  inline: boolean
}

const BLOCK = /\/\*\?.*?\*\//g
const LINE = /(?:\/\/|#)\?/g

/**
 * Locate the magic comment of a result in its line. `column` (0-based) is where the runner saw the comment; when
 * the line changed or the column does not point at a comment, the first magic comment of the line is used.
 */
export function locateMagicComment(line: string, column?: number): MagicCommentLocation | null {
  if (column !== undefined && column >= 0 && column < line.length) {
    const rest = line.slice(column)
    if (rest.startsWith('/*?')) {
      const close = line.indexOf('*/', column + 3)
      if (close >= 0) return { start: column, end: close + 2, inline: line.slice(close + 2).trim() !== '' }
    }
    if (rest.startsWith('//?') || rest.startsWith('#?')) return { start: column, end: line.length, inline: false }
  }
  BLOCK.lastIndex = 0
  const block = BLOCK.exec(line)
  LINE.lastIndex = 0
  const lineComment = LINE.exec(line)
  if (block && (!lineComment || block.index < lineComment.index)) {
    const end = block.index + block[0].length
    return { start: block.index, end, inline: line.slice(end).trim() !== '' }
  }
  if (lineComment) return { start: lineComment.index, end: line.length, inline: false }
  return null
}

interface LineScan {
  /** 0-based column of the line's trailing `//` / `#` comment, or -1. */
  comment: number
  /** The line ends inside a string, heredoc / nowdoc or block comment (or opens a heredoc): nothing goes after it. */
  open: boolean
}

/**
 * Lexical facts about one line of a buffer. `before` is the buffer text up to the start of the line (empty for the
 * first line), so a line that continues a multi-line string or heredoc is not mistaken for code: a `#` / `//` in
 * `body { color: #fff; }` inside `<<<CSS` is text, not a comment.
 */
function scanLine(line: string, before: string): LineScan {
  const start = before.length
  const scan = scanPhp(`${before}${line}\n`)
  const offset = scan.lineComments.find((o) => o >= start && o < start + line.length)
  return { comment: offset === undefined ? -1 : offset - start, open: scan.state !== 'code' }
}

/** Whether a line already ends with a `//?` magic comment (Add Magic Comment does nothing then). */
export function hasTrailingMagicComment(line: string, before = ''): boolean {
  const { comment } = scanLine(line, before)
  return comment >= 0 && /^(?:\/\/|#)\?/.test(line.slice(comment))
}

/**
 * Line with a magic comment added at its end: ` //?` is appended (trailing whitespace trimmed); an existing trailing
 * `// note` becomes the label `//? note`. Unchanged when the line already has one, and when the line ends inside a
 * string, heredoc or block comment (`before` = the buffer text up to the line, see scanLine).
 */
export function appendMagicComment(line: string, before = ''): string {
  const { comment: col, open } = scanLine(line, before)
  if (col >= 0) {
    const comment = line.slice(col)
    if (/^(?:\/\/|#)\?/.test(comment)) return line
    const marker = comment.startsWith('//') ? '//' : '#'
    const text = comment.slice(marker.length).trim()
    const code = line.slice(0, col).replace(/\s+$/, '')
    return `${code}${code ? ' ' : ''}${marker}?${text ? ` ${text}` : ''}`
  }
  if (open) return line
  const trimmed = line.replace(/\s+$/, '')
  return trimmed === '' ? '//?' : `${trimmed} //?`
}
