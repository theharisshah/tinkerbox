/**
 * Small SQL tokenizer + pretty printer for query cards: keywords uppercased, every clause keyword on its own line
 * with its content indented below, AND/OR conditions and top-level select columns one per line, sub-queries
 * indented. Strings, quoted identifiers and comments are never touched.
 */

export type SqlTokenType =
  | 'keyword'
  | 'word'
  | 'string'
  | 'quoted'
  | 'number'
  | 'placeholder'
  | 'operator'
  | 'punct'
  | 'comment'
  | 'whitespace'

export interface SqlToken {
  type: SqlTokenType
  text: string
}

const KEYWORDS = new Set(
  `select from where and or not in is null as on join left right inner outer cross full natural group by order asc
  desc limit offset insert into values update set delete having distinct union all exists between like ilike rlike
  regexp case when then else end create table alter drop add column index primary key foreign references default
  true false returning with recursive over partition window using duplicate ignore replace for share lock nowait
  skip locked escape collate interval any some top fetch next rows row only nulls first last if begin commit
  rollback truncate view database schema unique constraint check cascade restrict show describe explain analyze
  lateral filter within straight_join sql_calc_found_rows high_priority low_priority delayed quick`
    .split(/\s+/)
    .filter(Boolean)
)

export function isSqlKeyword(word: string): boolean {
  return KEYWORDS.has(word.toLowerCase())
}

const TOKEN_RE = new RegExp(
  [
    '(\\s+)', // 1 whitespace
    '(--[^\\n]*|#[^\\n]*|\\/\\*[\\s\\S]*?(?:\\*\\/|$))', // 2 comment
    "([xXbBnNeE]?'(?:[^'\\\\]|\\\\[\\s\\S]|'')*(?:'|$))", // 3 string
    '(`(?:[^`]|``)*(?:`|$)|"(?:[^"\\\\]|\\\\[\\s\\S]|"")*(?:"|$)|\\[[^\\]\\s]*\\])', // 4 quoted identifier
    '(\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b|\\.\\d+\\b|0[xX][0-9a-fA-F]+)', // 5 number
    '(\\?\\??|:[A-Za-z_]\\w*|\\$\\d+|@@?[A-Za-z_][\\w.]*)', // 6 placeholder / variable
    '([A-Za-z_\\u0080-\\uffff][\\w$\\u0080-\\uffff]*)', // 7 word
    '(<=>|<=|>=|<>|!=|==|::|\\|\\||->>?|&&|[=<>+\\-*/%!|&^~])', // 8 operator
    '([(),;.])' // 9 punctuation
  ].join('|'),
  'gy'
)

export function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = []
  let index = 0
  TOKEN_RE.lastIndex = 0
  while (index < sql.length) {
    TOKEN_RE.lastIndex = index
    const m = TOKEN_RE.exec(sql)
    if (!m || m[0] === '') {
      tokens.push({ type: 'punct', text: sql[index] })
      index++
      continue
    }
    index += m[0].length
    let type: SqlTokenType
    if (m[1] !== undefined) type = 'whitespace'
    else if (m[2] !== undefined) type = 'comment'
    else if (m[3] !== undefined) type = 'string'
    else if (m[4] !== undefined) type = 'quoted'
    else if (m[5] !== undefined) type = 'number'
    else if (m[6] !== undefined) type = 'placeholder'
    else if (m[7] !== undefined) type = isSqlKeyword(m[7]) ? 'keyword' : 'word'
    else if (m[8] !== undefined) type = 'operator'
    else type = 'punct'
    tokens.push({ type, text: m[0] })
  }
  return tokens
}

/** Clause keywords that start a new section (keyword line + indented content). */
const CLAUSES: string[][] = [
  ['on', 'duplicate', 'key', 'update'],
  ['insert', 'ignore', 'into'],
  ['insert', 'into'],
  ['replace', 'into'],
  ['delete', 'from'],
  ['group', 'by'],
  ['order', 'by'],
  ['partition', 'by'],
  ['union', 'all'],
  ['union'],
  ['intersect'],
  ['except'],
  ['select', 'distinct'],
  ['select'],
  ['from'],
  ['where'],
  ['having'],
  ['limit'],
  ['offset'],
  ['values'],
  ['update'],
  ['set'],
  ['returning'],
  ['window'],
  ['for', 'update'],
  ['for', 'share'],
  ['with']
]

/** Join keywords: new line inside the current section. */
const JOINS: string[][] = [
  ['left', 'outer', 'join'],
  ['right', 'outer', 'join'],
  ['full', 'outer', 'join'],
  ['left', 'join'],
  ['right', 'join'],
  ['inner', 'join'],
  ['cross', 'join'],
  ['full', 'join'],
  ['natural', 'join'],
  ['straight_join'],
  ['join']
]

/** Sections whose top-level commas break lines. */
const LIST_SECTIONS = new Set(['select', 'select distinct', 'group by', 'order by', 'set', 'returning', 'partition by', 'on duplicate key update', 'with'])
/** Sections whose top-level AND / OR break lines. */
const CONDITION_SECTIONS = new Set(['where', 'having', 'from', 'update', 'delete from'])

function matchSequence(tokens: SqlToken[], start: number, seq: string[]): number {
  let i = start
  for (let s = 0; s < seq.length; s++) {
    while (i < tokens.length && (tokens[i].type === 'whitespace' || tokens[i].type === 'comment') && s > 0) i++
    const t = tokens[i]
    if (!t || (t.type !== 'keyword' && t.type !== 'word') || t.text.toLowerCase() !== seq[s]) return -1
    i++
  }
  return i
}

function matchAny(tokens: SqlToken[], start: number, list: string[][]): { seq: string[]; end: number } | null {
  for (const seq of list) {
    const end = matchSequence(tokens, start, seq)
    if (end >= 0) return { seq, end }
  }
  return null
}

function nextSignificant(tokens: SqlToken[], start: number): SqlToken | undefined {
  for (let i = start; i < tokens.length; i++) if (tokens[i].type !== 'whitespace' && tokens[i].type !== 'comment') return tokens[i]
  return undefined
}

interface Frame {
  /** Base indent level of this (sub)query. */
  base: number
  /** Current clause name. */
  section: string
  /** Nesting of inline parentheses inside this frame. */
  parens: number
  /** A sub-query frame (closed by the matching ")"). */
  sub: boolean
  between: boolean
}

/** Pretty-print SQL (see module docs). Idempotent on already formatted SQL. */
export function formatSql(sql: string, indent = '  '): string {
  const tokens = tokenizeSql(sql.trim())
  const lines: string[] = []
  let line = ''
  let level = 0
  let prev: SqlToken | null = null
  const stack: Frame[] = [{ base: 0, section: '', parens: 0, sub: false, between: false }]
  const top = (): Frame => stack[stack.length - 1]

  const flush = (): void => {
    if (line.trim() !== '') lines.push(line.replace(/\s+$/, ''))
    line = ''
    prev = null
  }
  const newline = (lvl: number): void => {
    flush()
    level = lvl
    line = indent.repeat(Math.max(0, lvl))
  }
  /** Whether the source had whitespace right before the token being written (keeps `fruits (id …)` vs `count(*)`). */
  let spaceBefore = false
  const needsSpace = (token: SqlToken): boolean => {
    if (!prev) return false
    if (token.type === 'punct' && (token.text === ',' || token.text === ')' || token.text === '.' || token.text === ';')) return false
    if (prev.type === 'punct' && (prev.text === '(' || prev.text === '.')) return false
    if (token.text === '(' && prev.type === 'word') return spaceBefore
    if (prev.type === 'operator' && prev.text === '::') return false
    if (token.type === 'operator' && token.text === '::') return false
    return true
  }
  const write = (token: SqlToken, text = token.text): void => {
    if (line.trim() === '') {
      line = indent.repeat(Math.max(0, level)) + text
    } else {
      line += (needsSpace(token) ? ' ' : '') + text
    }
    prev = token
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.type === 'whitespace') continue
    spaceBefore = i > 0 && tokens[i - 1].type === 'whitespace'
    const frame = top()

    if (token.type === 'comment') {
      if (token.text.startsWith('--') || token.text.startsWith('#')) {
        write(token)
        newline(level)
      } else {
        write(token)
      }
      continue
    }

    if (token.type === 'keyword' && frame.parens === 0) {
      const clause = matchAny(tokens, i, CLAUSES)
      if (clause) {
        const name = clause.seq.join(' ')
        frame.section = name
        frame.between = false
        newline(frame.base)
        write({ type: 'keyword', text: name }, name.toUpperCase())
        newline(frame.base + 1)
        i = clause.end - 1
        continue
      }
      const join = matchAny(tokens, i, JOINS)
      if (join) {
        frame.section = 'from'
        newline(frame.base + 1)
        write({ type: 'keyword', text: join.seq.join(' ') }, join.seq.join(' ').toUpperCase())
        i = join.end - 1
        continue
      }
      const lower = token.text.toLowerCase()
      if (lower === 'between') frame.between = true
      if ((lower === 'and' || lower === 'or') && CONDITION_SECTIONS.has(frame.section)) {
        if (lower === 'and' && frame.between) {
          frame.between = false
        } else {
          newline(frame.base + 1)
          write(token, token.text.toUpperCase())
          continue
        }
      }
    }

    if (token.type === 'punct' && token.text === '(') {
      const next = nextSignificant(tokens, i + 1)
      if (next && next.type === 'keyword' && /^(select|with)$/i.test(next.text)) {
        write(token)
        stack.push({ base: level + 1, section: '', parens: 0, sub: true, between: false })
        continue
      }
      frame.parens++
      write(token)
      continue
    }

    if (token.type === 'punct' && token.text === ')') {
      if (frame.parens > 0) {
        frame.parens--
        write(token)
        continue
      }
      if (frame.sub && stack.length > 1) {
        stack.pop()
        newline(frame.base - 1)
        write(token)
        continue
      }
      write(token)
      continue
    }

    if (token.type === 'punct' && token.text === ',') {
      write(token)
      if (frame.parens === 0 && (LIST_SECTIONS.has(frame.section) || frame.section === 'values')) newline(frame.base + 1)
      continue
    }

    if (token.type === 'punct' && token.text === ';') {
      write(token)
      stack.length = 1
      stack[0].section = ''
      newline(0)
      lines.push('')
      continue
    }

    write(token, token.type === 'keyword' ? token.text.toUpperCase() : token.text)
  }
  flush()
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

/** Collapse SQL whitespace to single spaces (one-line display / CLI). */
export function compactSql(sql: string): string {
  return tokenizeSql(sql)
    .map((t) => (t.type === 'whitespace' ? ' ' : t.text))
    .join('')
    .trim()
}
