/**
 * Lightweight PHP source scanner used by the editor features (completion context, type inference, use statements,
 * prettify helpers). It does not parse PHP; it only knows where strings, heredocs and comments are so that
 * structural regexes never trip over their contents.
 */

export type ScanState = 'code' | 'string' | 'comment' | 'heredoc'

export interface ScanResult {
  /**
   * Same length as the input; string contents and whole comments are replaced by spaces (newlines are kept, string
   * delimiters too), so every offset maps 1:1 to the source.
   */
  masked: string
  /** Where the scanner ended (e.g. 'string' when the input stops inside an unterminated string). */
  state: ScanState
  /** Offsets where `//` and `#` line comments start (in code, never inside strings, heredocs or block comments). */
  lineComments: number[]
}

const IDENT_START = /[A-Za-z_\x80-￿]/
const IDENT_CHAR = /[\w\x80-￿]/

export function isIdentStart(ch: string | undefined): boolean {
  return !!ch && IDENT_START.test(ch)
}

export function isIdentChar(ch: string | undefined): boolean {
  return !!ch && IDENT_CHAR.test(ch)
}

function blank(ch: string): string {
  return ch === '\n' || ch === '\r' ? ch : ' '
}

/** Mask strings and comments (see ScanResult.masked). */
export function scanPhp(code: string): ScanResult {
  const out: string[] = new Array(code.length)
  const lineComments: number[] = []
  let state: ScanState = 'code'
  let i = 0
  const n = code.length
  while (i < n) {
    const ch = code[i]
    const next = code[i + 1]
    // line comments: //, # (but not #[ attributes)
    if (ch === '/' && next === '/') {
      state = 'comment'
      lineComments.push(i)
      while (i < n && code[i] !== '\n') out[i] = blank(code[i++])
      if (i < n) state = 'code'
      continue
    }
    if (ch === '#' && next !== '[') {
      state = 'comment'
      lineComments.push(i)
      while (i < n && code[i] !== '\n') out[i] = blank(code[i++])
      if (i < n) state = 'code'
      continue
    }
    if (ch === '/' && next === '*') {
      state = 'comment'
      out[i] = ' '
      out[i + 1] = ' '
      i += 2
      let closed = false
      while (i < n) {
        if (code[i] === '*' && code[i + 1] === '/') {
          out[i] = ' '
          out[i + 1] = ' '
          i += 2
          closed = true
          break
        }
        out[i] = blank(code[i])
        i++
      }
      if (closed) state = 'code'
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      state = 'string'
      out[i++] = ch
      let closed = false
      while (i < n) {
        const c = code[i]
        if (c === '\\' && i + 1 < n) {
          out[i] = ' '
          out[i + 1] = blank(code[i + 1])
          i += 2
          continue
        }
        if (c === ch) {
          out[i++] = ch
          closed = true
          break
        }
        out[i] = blank(c)
        i++
      }
      if (closed) state = 'code'
      continue
    }
    if (ch === '<' && code.startsWith('<<<', i)) {
      const header = /^<<<[ \t]*(["']?)([A-Za-z_\x80-￿][\w\x80-￿]*)\1[ \t]*\r?\n/.exec(code.slice(i, i + 200))
      if (header) {
        const label = header[2]
        for (let k = 0; k < header[0].length; k++) out[i + k] = code[i + k]
        i += header[0].length
        state = 'heredoc'
        const closing = new RegExp(`^[ \\t]*${label}(?![\\w\\x80-\\uffff])`)
        let closed = false
        while (i < n) {
          // at a line start: closing label?
          const lineEnd = code.indexOf('\n', i)
          const line = code.slice(i, lineEnd < 0 ? n : lineEnd)
          const m = closing.exec(line)
          if (m) {
            for (let k = 0; k < m[0].length; k++) out[i + k] = code[i + k]
            i += m[0].length
            closed = true
            break
          }
          const stop = lineEnd < 0 ? n : lineEnd + 1
          while (i < stop) {
            out[i] = blank(code[i])
            i++
          }
        }
        if (closed) state = 'code'
        continue
      }
    }
    out[i] = ch
    i++
  }
  return { masked: out.join(''), state, lineComments }
}

/** Masked source (see scanPhp). */
export function maskPhp(code: string): string {
  return scanPhp(code).masked
}

const OPEN: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
const CLOSE: Record<string, string> = { '(': ')', '[': ']', '{': '}' }

/** Index of the bracket opening the one at `closeIndex` (masked text), or -1. */
export function findOpening(masked: string, closeIndex: number): number {
  const stack: string[] = []
  for (let i = closeIndex; i >= 0; i--) {
    const c = masked[i]
    if (c === ')' || c === ']' || c === '}') stack.push(OPEN[c])
    else if (c === '(' || c === '[' || c === '{') {
      if (stack.pop() !== c) return -1
      if (stack.length === 0) return i
    }
  }
  return -1
}

/** Index of the bracket closing the one at `openIndex` (masked text), or -1. */
export function findClosing(masked: string, openIndex: number): number {
  const stack: string[] = []
  for (let i = openIndex; i < masked.length; i++) {
    const c = masked[i]
    if (c === '(' || c === '[' || c === '{') stack.push(CLOSE[c])
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) return -1
      if (stack.length === 0) return i
    }
  }
  return -1
}

/** Brace depth ({…}) at every offset is expensive; this returns the depth at one offset. */
export function braceDepthAt(masked: string, offset: number): number {
  let depth = 0
  for (let i = 0; i < offset && i < masked.length; i++) {
    const c = masked[i]
    if (c === '{') depth++
    else if (c === '}') depth = Math.max(0, depth - 1)
  }
  return depth
}

/** Offset just after the end of the statement starting at `start` (`;` at depth 0), or -1 when it does not end. */
export function statementEnd(masked: string, start: number, limit = masked.length): number {
  let depth = 0
  for (let i = start; i < limit; i++) {
    const c = masked[i]
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') {
      depth--
      if (depth < 0) return i
    } else if (c === ';' && depth === 0) return i
  }
  return -1
}

/** Skip whitespace backwards from `index` (exclusive); returns the new index. */
export function skipSpaceBack(text: string, index: number): number {
  let i = index
  while (i > 0 && /\s/.test(text[i - 1])) i--
  return i
}

/** Skip whitespace forwards from `index`; returns the new index. */
export function skipSpaceForward(text: string, index: number): number {
  let i = index
  while (i < text.length && /\s/.test(text[i])) i++
  return i
}

/** 1-based line number of an offset. */
export function lineOfOffset(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++
  return line
}
