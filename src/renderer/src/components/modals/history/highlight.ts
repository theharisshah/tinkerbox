/**
 * Small PHP syntax highlighter for read-only previews (History, Snippets, theme previews). It is a lexer for display
 * purposes only — Monaco does the real highlighting in the editor.
 */

export type PhpTokenType = 'plain' | 'comment' | 'string' | 'number' | 'keyword' | 'variable' | 'function' | 'class' | 'constant' | 'tag'

export interface PhpToken {
  type: PhpTokenType
  text: string
}

const KEYWORDS = new Set(
  (
    'abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty ' +
    'enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if ' +
    'implements include include_once instanceof insteadof interface isset list match namespace new or print private protected ' +
    'public readonly require require_once return static switch throw trait try unset use var while xor yield from self parent ' +
    'int float bool string void mixed never iterable object'
  ).split(' ')
)

const CONSTANTS = new Set(['true', 'false', 'null', '__class__', '__dir__', '__file__', '__function__', '__line__', '__method__', '__namespace__', '__trait__'])

const IDENT_START = /[A-Za-z_\\\x80-￿]/
const IDENT = /[A-Za-z0-9_\\\x80-￿]/

function readQuoted(code: string, start: number): number {
  const quote = code[start]
  let i = start + 1
  while (i < code.length) {
    const ch = code[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    i++
    if (ch === quote) break
  }
  return Math.min(i, code.length)
}

/** Tokenize PHP code into a flat token list (newlines stay inside the token texts). */
export function tokenizePhp(code: string): PhpToken[] {
  const tokens: PhpToken[] = []
  const push = (type: PhpTokenType, text: string): void => {
    if (text === '') return
    const last = tokens[tokens.length - 1]
    if (last && last.type === type && type === 'plain') last.text += text
    else tokens.push({ type, text })
  }
  let prevWord = ''
  let i = 0
  const n = code.length
  while (i < n) {
    const ch = code[i]
    const next = code[i + 1]
    // Comments
    if ((ch === '/' && next === '/') || (ch === '#' && next !== '[')) {
      let end = code.indexOf('\n', i)
      if (end < 0) end = n
      push('comment', code.slice(i, end))
      i = end
      continue
    }
    if (ch === '/' && next === '*') {
      const close = code.indexOf('*/', i + 2)
      const end = close < 0 ? n : close + 2
      push('comment', code.slice(i, end))
      i = end
      continue
    }
    // Open / close tags
    if (ch === '<' && code.startsWith('<?php', i)) {
      push('tag', '<?php')
      i += 5
      continue
    }
    if (ch === '?' && next === '>') {
      push('tag', '?>')
      i += 2
      continue
    }
    // Strings
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = readQuoted(code, i)
      push('string', code.slice(i, end))
      i = end
      continue
    }
    // Variables
    if (ch === '$' && next !== undefined && /[A-Za-z_\x80-￿]/.test(next)) {
      let j = i + 1
      while (j < n && /[A-Za-z0-9_\x80-￿]/.test(code[j])) j++
      push('variable', code.slice(i, j))
      prevWord = ''
      i = j
      continue
    }
    // Numbers
    if (/[0-9]/.test(ch) || (ch === '.' && next !== undefined && /[0-9]/.test(next))) {
      const m = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|(?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][+-]?\d+)?)/.exec(code.slice(i, i + 64))
      const text = m && m[0] ? m[0] : ch
      push('number', text)
      i += text.length
      continue
    }
    // Identifiers
    if (IDENT_START.test(ch)) {
      let j = i + 1
      while (j < n && IDENT.test(code[j])) j++
      const word = code.slice(i, j)
      const lower = word.toLowerCase()
      let k = j
      while (k < n && (code[k] === ' ' || code[k] === '\t')) k++
      const before = code.slice(Math.max(0, i - 2), i)
      const isMember = before === '->' || before.endsWith('?->')
      let type: PhpTokenType
      if (isMember) type = code[k] === '(' ? 'function' : 'plain'
      else if (CONSTANTS.has(lower)) type = 'constant'
      else if (KEYWORDS.has(lower) && !(before === '::')) type = 'keyword'
      else if (prevWord === 'new' || prevWord === 'extends' || prevWord === 'implements' || prevWord === 'instanceof') type = 'class'
      else if (code.startsWith('::', k)) type = 'class'
      else if (code[k] === '(') type = 'function'
      else if (/^\\?[A-Z]/.test(word) || word.includes('\\')) type = /^[A-Z0-9_]+$/.test(word) && word.length > 1 ? 'constant' : 'class'
      else type = 'plain'
      push(type, word)
      prevWord = lower
      i = j
      continue
    }
    if (!/\s/.test(ch)) prevWord = ''
    push('plain', ch)
    i++
  }
  return tokens
}

/** Tokens split into lines (each line is a token list; tokens never contain '\n'). */
export function highlightPhpLines(code: string): PhpToken[][] {
  const lines: PhpToken[][] = [[]]
  for (const token of tokenizePhp(code.replace(/\r\n?/g, '\n'))) {
    const parts = token.text.split('\n')
    parts.forEach((part, index) => {
      if (index > 0) lines.push([])
      if (part !== '') lines[lines.length - 1].push({ type: token.type, text: part })
    })
  }
  return lines
}
