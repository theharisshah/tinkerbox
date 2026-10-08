import {
  findClosing,
  findOpening,
  isIdentChar,
  maskPhp,
  scanPhp,
  skipSpaceBack,
  skipSpaceForward,
  statementEnd
} from './phpScan'

/**
 * Pure helpers that read PHP source around the cursor: what is being completed, the receiver expression of
 * `->` / `::`, chains like `User::where(...)->first()`, where a variable got its value, the call surrounding the
 * cursor (signature help) and signature strings from introspection.
 */

const NAME = '[A-Za-z_\\x80-\\uffff][\\w\\x80-\\uffff]*'
const NAME_RE = new RegExp(`^${NAME}$`)

// ---------------------------------------------------------------------------------------------------------------
// Completion context
// ---------------------------------------------------------------------------------------------------------------

export type CompletionKind =
  /** Inside a string or comment: nothing to complete. */
  | 'none'
  /** `$receiver->prefix` / `$receiver?->prefix` */
  | 'member'
  /** `Receiver::prefix` */
  | 'static'
  /** `$prefix` */
  | 'variable'
  /** `new Prefix` */
  | 'new'
  /** `use Prefix` (import statement) */
  | 'use'
  /** `#[Prefix` */
  | 'attribute'
  /** anything else: keywords, functions, classes, constants */
  | 'global'

export interface CompletionContext {
  kind: CompletionKind
  /** Text being completed, as typed (may contain `$` or backslashes). */
  prefix: string
  /** Receiver expression for 'member' / 'static' (source text, may span lines). */
  receiver?: string
}

const NONE: CompletionContext = { kind: 'none', prefix: '' }

/** Classify the completion position from the text before the cursor. */
export function completionContext(textBefore: string): CompletionContext {
  const { masked, state } = scanPhp(textBefore)
  if (state !== 'code') return NONE

  let m = new RegExp(`(\\??->)\\s*(${NAME})?$`).exec(masked)
  if (m) {
    const receiver = receiverBefore(textBefore, masked, m.index)
    return receiver ? { kind: 'member', prefix: m[2] ?? '', receiver } : NONE
  }

  m = new RegExp(`::\\s*(\\$?(?:${NAME})?)$`).exec(masked)
  if (m) {
    const receiver = receiverBefore(textBefore, masked, m.index)
    return receiver ? { kind: 'static', prefix: m[1], receiver } : NONE
  }

  m = new RegExp(`(?:^|[^\\w\\x80-\\uffff$])(\\$+(?:${NAME})?)$`).exec(masked)
  if (m) return { kind: 'variable', prefix: m[1].replace(/^\$+/, '$') }

  m = /(?:^|[^\w\x80-￿$\\])new\s+(\\?(?:[A-Za-z_\x80-￿][\w\x80-￿]*\\)*(?:[A-Za-z_\x80-￿][\w\x80-￿]*)?)$/.exec(masked)
  if (m) return { kind: 'new', prefix: m[1] }

  m = /(?:^|[;{}]|\n)[ \t]*use\s+(?:function\s+|const\s+)?(\\?(?:[A-Za-z_\x80-￿][\w\x80-￿]*\\)*(?:[A-Za-z_\x80-￿][\w\x80-￿]*)?)$/.exec(masked)
  if (m) return { kind: 'use', prefix: m[1] }

  m = /#\[\s*(\\?(?:[A-Za-z_\x80-￿][\w\x80-￿]*\\)*(?:[A-Za-z_\x80-￿][\w\x80-￿]*)?)$/.exec(masked)
  if (m) return { kind: 'attribute', prefix: m[1] }

  m = /(\\?(?:[A-Za-z_\x80-￿][\w\x80-￿]*\\)*(?:[A-Za-z_\x80-￿][\w\x80-￿]*)?)$/.exec(masked)
  const prefix = m ? m[1] : ''
  // A number literal being typed ("12") or a name glued to a previous one is not completable.
  const before = masked[masked.length - prefix.length - 1]
  if (prefix === '' && before !== undefined && /[\w\x80-￿]/.test(before)) return NONE
  if (/^\d/.test(prefix)) return NONE
  return { kind: 'global', prefix }
}

// ---------------------------------------------------------------------------------------------------------------
// Receiver expressions
// ---------------------------------------------------------------------------------------------------------------

/**
 * Start offset of the expression ending at `end` in masked text — a chain of primaries (`$var`, `Name`, calls,
 * array access, parenthesized groups) joined by `->`, `?->` and `::`, possibly across lines. -1 when there is none.
 */
export function expressionStart(masked: string, end: number): number {
  let i = skipSpaceBack(masked, end)
  for (;;) {
    let consumed = false
    while (i > 0) {
      const c = masked[i - 1]
      if (c === ')' || c === ']') {
        const open = findOpening(masked, i - 1)
        if (open < 0) return -1
        i = open
        consumed = true
        continue
      }
      if (isIdentChar(c) || c === '$' || c === '\\') {
        // A primary is one name: stop at the previous whitespace-separated word (`return $x`).
        if (consumed && !(masked[i] === '(' || masked[i] === '[')) break
        while (i > 0 && (isIdentChar(masked[i - 1]) || masked[i - 1] === '$' || masked[i - 1] === '\\')) i--
        consumed = true
        continue
      }
      break
    }
    if (!consumed) return -1
    const k = skipSpaceBack(masked, i)
    if (masked.slice(k - 3, k) === '?->') {
      i = skipSpaceBack(masked, k - 3)
      continue
    }
    const op = masked.slice(k - 2, k)
    if (op === '->' || op === '::') {
      i = skipSpaceBack(masked, k - 2)
      continue
    }
    // `new Foo()->bar()` (PHP 8.4): keep the `new`.
    const word = /(?:^|[^\w\x80-￿$])(new)\s*$/.exec(masked.slice(Math.max(0, k - 8), i))
    if (word && /\s/.test(masked[i - 1] ?? '')) {
      i = k - 3
    }
    return i
  }
}

function receiverBefore(source: string, masked: string, operatorIndex: number): string | null {
  const end = skipSpaceBack(masked, operatorIndex)
  const start = expressionStart(masked, end)
  if (start < 0 || start >= end) return null
  const text = source.slice(start, end).trim()
  return text === '' ? null : text
}

/** Receiver expression ending at `end` in `source` (null when there is none). */
export function expressionBefore(source: string, end: number): string | null {
  return receiverBefore(source, maskPhp(source.slice(0, end)), end)
}

// ---------------------------------------------------------------------------------------------------------------
// Chains
// ---------------------------------------------------------------------------------------------------------------

export type ChainRoot =
  | { kind: 'variable'; name: string }
  /** Class reference before `::` (also `static`, `self`, `parent`). */
  | { kind: 'class'; name: string }
  | { kind: 'new'; className: string }
  | { kind: 'call'; name: string; args: string }
  | { kind: 'group'; chain: Chain }

export interface ChainSegment {
  op: '->' | '::' | '[]'
  /** Member name (`$prop` keeps its `$` for static properties). Empty for array access. */
  name: string
  call: boolean
  args: string
}

export interface Chain {
  root: ChainRoot
  segments: ChainSegment[]
}

/** Parse `User::where('a', 1)->first()`, `$user->posts`, `(new Foo)->bar()`, `app(Foo::class)->x` … */
export function parseChain(expression: string): Chain | null {
  const src = expression.trim()
  if (src === '') return null
  const masked = maskPhp(src)
  let pos = 0
  let root: ChainRoot

  const readName = (): string | null => {
    const m = /^\\?(?:[A-Za-z_\x80-￿][\w\x80-￿]*\\)*[A-Za-z_\x80-￿][\w\x80-￿]*/.exec(src.slice(pos))
    if (!m) return null
    pos += m[0].length
    return m[0]
  }
  const readArgs = (): string | null => {
    const p = skipSpaceForward(masked, pos)
    if (masked[p] !== '(') return null
    const close = findClosing(masked, p)
    if (close < 0) return null
    pos = close + 1
    return src.slice(p + 1, close)
  }

  pos = skipSpaceForward(masked, pos)
  if (masked[pos] === '(') {
    const close = findClosing(masked, pos)
    if (close < 0) return null
    const inner = parseChain(src.slice(pos + 1, close))
    if (!inner) return null
    pos = close + 1
    root = { kind: 'group', chain: inner }
  } else if (/^new\s/.test(src.slice(pos))) {
    pos = skipSpaceForward(masked, pos + 3)
    const name = readName()
    if (!name) return null
    readArgs()
    root = { kind: 'new', className: name }
  } else if (src[pos] === '$') {
    const m = new RegExp(`^\\$${NAME}`).exec(src.slice(pos))
    if (!m) return null
    pos += m[0].length
    root = { kind: 'variable', name: m[0] }
  } else {
    const name = readName()
    if (!name) return null
    const save = pos
    const args = readArgs()
    if (args !== null) root = { kind: 'call', name, args }
    else {
      pos = save
      root = { kind: 'class', name }
    }
  }

  const segments: ChainSegment[] = []
  for (;;) {
    pos = skipSpaceForward(masked, pos)
    if (pos >= src.length) break
    let op: ChainSegment['op'] | null = null
    if (src.startsWith('?->', pos)) {
      op = '->'
      pos += 3
    } else if (src.startsWith('->', pos)) {
      op = '->'
      pos += 2
    } else if (src.startsWith('::', pos)) {
      op = '::'
      pos += 2
    } else if (masked[pos] === '[') {
      const close = findClosing(masked, pos)
      if (close < 0) return null
      segments.push({ op: '[]', name: '', call: false, args: src.slice(pos + 1, close) })
      pos = close + 1
      continue
    } else {
      return null
    }
    pos = skipSpaceForward(masked, pos)
    const m = new RegExp(`^\\$?${NAME}`).exec(src.slice(pos))
    if (!m) return null
    pos += m[0].length
    const args = readArgs()
    segments.push({ op, name: m[0], call: args !== null, args: args ?? '' })
  }
  return { root, segments }
}

// ---------------------------------------------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------------------------------------------

export type VariableSource =
  /** `$x = <expr>;` */
  | { kind: 'assign'; expr: string; offset: number }
  /** `foreach (<expr> as $x)` / `as $k => $x` */
  | { kind: 'foreach'; expr: string; offset: number }
  /** Typed parameter / catch variable / `@var Type $x` */
  | { kind: 'type'; type: string; offset: number }

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Where `$name` got its value before `before` (the latest assignment, foreach, typed parameter or `@var` doc
 * comment wins). Assignments still being typed (no `;` before `before`) are ignored.
 */
export function findVariableSource(code: string, name: string, before: number = code.length): VariableSource | null {
  const varName = name.startsWith('$') ? name : `$${name}`
  if (!new RegExp(`^\\$${NAME}$`).test(varName)) return null
  const masked = maskPhp(code)
  const v = escapeRe(varName)
  const tail = '(?![\\w\\x80-\\uffff])'
  let best: VariableSource | null = null
  const consider = (candidate: VariableSource): void => {
    if (candidate.offset < before && (!best || candidate.offset >= best.offset)) best = candidate
  }

  const assign = new RegExp(`(?<![\\w\\x80-\\uffff$])${v}${tail}\\s*=(?![=>])`, 'g')
  for (let m = assign.exec(masked); m; m = assign.exec(masked)) {
    if (m.index >= before) break
    const start = m.index + m[0].length
    const end = statementEnd(masked, start, before)
    if (end < 0) continue
    const expr = code.slice(start, end).trim()
    if (expr) consider({ kind: 'assign', expr, offset: m.index })
  }

  const foreachRe = new RegExp(`foreach\\s*\\(([^;{}]*?)\\s+as\\s+(?:&?\\$${NAME}\\s*=>\\s*)?&?${v}${tail}`, 'g')
  for (let m = foreachRe.exec(masked); m; m = foreachRe.exec(masked)) {
    if (m.index >= before) break
    const exprStart = m.index + m[0].indexOf('(') + 1
    const expr = code.slice(exprStart, exprStart + m[1].length).trim()
    if (expr) consider({ kind: 'foreach', expr, offset: m.index })
  }

  const param = new RegExp(
    `(?:^|[(,])\\s*(?:(?:public|protected|private|readonly)\\s+)*(\\??\\\\?[A-Za-z_\\x80-\\uffff][\\w\\x80-\\uffff\\\\]*(?:\\s*\\|\\s*\\\\?[A-Za-z_\\x80-\\uffff][\\w\\x80-\\uffff\\\\]*)*)\\s+&?(?:\\.\\.\\.)?${v}${tail}`,
    'g'
  )
  for (let m = param.exec(masked); m; m = param.exec(masked)) {
    if (m.index >= before) break
    const type = classFromType(m[1])
    if (type) consider({ kind: 'type', type, offset: m.index })
  }

  // `/** @var User $user */` lives in a comment: search the raw source.
  const doc = new RegExp(`@var\\s+(\\??\\\\?[A-Za-z_\\x80-\\uffff][\\w\\x80-\\uffff\\\\|]*)\\s+${v}${tail}`, 'g')
  for (let m = doc.exec(code); m; m = doc.exec(code)) {
    if (m.index >= before) break
    const type = classFromType(m[1])
    if (type) consider({ kind: 'type', type, offset: m.index })
  }
  return best
}

/** Every `$variable` in the code (strings and comments excluded), in order of first appearance. */
export function collectVariables(code: string): string[] {
  const masked = maskPhp(code)
  const seen = new Set<string>()
  const re = new RegExp(`(?<![\\w\\x80-\\uffff])\\$${NAME}`, 'g')
  for (let m = re.exec(masked); m; m = re.exec(masked)) seen.add(m[0])
  return [...seen]
}

// ---------------------------------------------------------------------------------------------------------------
// Types and signatures
// ---------------------------------------------------------------------------------------------------------------

const SCALAR_TYPES = new Set([
  'int',
  'integer',
  'float',
  'double',
  'string',
  'bool',
  'boolean',
  'array',
  'iterable',
  'callable',
  'object',
  'mixed',
  'void',
  'never',
  'null',
  'false',
  'true',
  'resource',
  'numeric',
  'scalar',
  'array-key',
  'list',
  'class-string',
  'positive-int',
  'negative-int',
  'non-empty-string',
  'non-empty-array',
  'callable-string'
])

/**
 * A type without its generic arguments and array shapes, at any depth: `static<int, TValue>` → `static`,
 * `Collection<int, array<string, User>>` → `Collection`, `array{id: int|string}` → `array`.
 */
function stripGenerics(type: string): string {
  let t = type
  for (let previous = ''; previous !== t; ) {
    previous = t
    t = t.replace(/<[^<>]*>|\{[^{}]*\}/g, '')
  }
  return t
}

/** The members of a union / intersection type, without generics, parentheses and `?` markers. */
function typeParts(type: string): string[] {
  return stripGenerics(type)
    .split(/[|&]/)
    .map((part) => part.trim().replace(/^\(+|\)+$/g, '').replace(/^\?/, '').trim())
    .filter((part) => part !== '')
}

/** `static`, `self` and `$this` (fluent methods), generic forms included (`static<int, TValue>`). */
export function isSelfType(type: string | null | undefined): boolean {
  if (!type) return false
  return typeParts(type).some((t) => {
    const lower = t.toLowerCase()
    return lower === 'static' || lower === 'self' || lower === '$this'
  })
}

/** Template parameters such as `TModel`, `TValue`, `TKey` are not classes. */
function isTemplateName(name: string): boolean {
  return /^T[A-Z]\w*$/.test(name) || /^T$/.test(name)
}

/**
 * First class-like type of a declaration (`?User`, `User|null`, `\App\Models\User[]` → null for arrays,
 * `Collection<int, User>` → `Collection`). Scalars, templates and `static`/`self` give null.
 */
export function classFromType(type: string | null | undefined): string | null {
  if (!type) return null
  for (const part of typeParts(type)) {
    if (part.endsWith('[]')) continue
    const lower = part.toLowerCase()
    if (SCALAR_TYPES.has(lower) || lower === 'static' || lower === 'self' || lower === '$this' || lower === 'parent') continue
    const name = part.replace(/^\\+/, '')
    if (!/^[A-Za-z_\x80-￿][\w\x80-￿]*(?:\\[A-Za-z_\x80-￿][\w\x80-￿]*)*$/.test(name)) continue
    if (isTemplateName(name)) continue
    return name
  }
  return null
}

export interface ParsedSignature {
  /** Parameter declarations (`string $needle`, `int $limit = -1`). */
  params: string[]
  returnType: string | null
}

/** Split `(string $a, array $b = [1, 2]): ?Foo` into parameters and the return type. */
export function parseSignature(signature: string | null | undefined): ParsedSignature {
  const sig = (signature ?? '').trim()
  const open = sig.indexOf('(')
  if (open < 0) return { params: [], returnType: null }
  const masked = maskPhp(sig)
  const close = findClosing(masked, open)
  if (close < 0) return { params: [], returnType: null }
  const params: string[] = []
  let depth = 0
  let start = open + 1
  for (let i = open + 1; i < close; i++) {
    const c = masked[i]
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (c === ',' && depth === 0) {
      params.push(sig.slice(start, i).trim())
      start = i + 1
    }
  }
  const last = sig.slice(start, close).trim()
  if (last) params.push(last)
  const rest = sig.slice(close + 1).trim()
  const returnType = rest.startsWith(':') ? rest.slice(1).trim() || null : null
  return { params, returnType }
}

// ---------------------------------------------------------------------------------------------------------------
// Calls (signature help)
// ---------------------------------------------------------------------------------------------------------------

export interface CallContext {
  /** Callee expression: `str_replace`, `$user->update`, `User::where`, or the class for `new Foo(`. */
  callee: string
  /** 0-based index of the argument under the cursor. */
  argIndex: number
  /** `new Foo(` — the callee is a class (constructor). */
  isNew: boolean
  /** Offset of the opening parenthesis. */
  openParen: number
}

const NOT_CALLS = new Set([
  'if',
  'elseif',
  'while',
  'for',
  'foreach',
  'switch',
  'match',
  'catch',
  'function',
  'fn',
  'use',
  'return',
  'echo',
  'print',
  'declare',
  'array',
  'list'
])

/** The function / method call whose argument list contains the end of `textBefore`. */
export function findCallContext(textBefore: string): CallContext | null {
  const { masked, state } = scanPhp(textBefore)
  if (state === 'comment') return null
  const stack: Array<{ ch: string; index: number; commas: number }> = []
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i]
    if (c === '(' || c === '[' || c === '{') stack.push({ ch: c, index: i, commas: 0 })
    else if (c === ')' || c === ']' || c === '}') stack.pop()
    else if (c === ',' && stack.length) stack[stack.length - 1].commas++
  }
  // Innermost "(" reachable through array literals (not through closures / blocks).
  for (let s = stack.length - 1; s >= 0; s--) {
    const entry = stack[s]
    if (entry.ch === '{') return null
    if (entry.ch !== '(') continue
    const end = skipSpaceBack(masked, entry.index)
    const start = expressionStart(masked, end)
    if (start < 0 || start >= end) return null
    const callee = textBefore.slice(start, end).trim()
    const isNew = /^new\s/.test(callee)
    const name = isNew ? callee.replace(/^new\s+/, '') : callee
    if (NOT_CALLS.has(name.toLowerCase())) return null
    return { callee: name, argIndex: entry.commas, isNew, openParen: entry.index }
  }
  return null
}

/** Split a callee into receiver + member (`$user->update` → `$user`, `update`, '->'). */
export function splitCallee(callee: string): { receiver: string | null; member: string; op: '->' | '::' | null } {
  const masked = maskPhp(callee)
  const m = new RegExp(`(\\??->|::)\\s*(\\$?${NAME})$`).exec(masked)
  if (!m) return { receiver: null, member: callee.trim(), op: null }
  return {
    receiver: callee.slice(0, m.index).trim(),
    member: callee.slice(m.index + m[0].length - m[2].length),
    op: m[1] === '::' ? '::' : '->'
  }
}

/** True for a bare identifier (`foo`, not `$foo` or `A\b`). */
export function isPlainName(text: string): boolean {
  return NAME_RE.test(text)
}

/** The word (identifier, `$variable` or qualified name) touching `column` (0-based) in a line. */
export function qualifiedNameAt(line: string, column: number): { start: number; end: number; text: string } | null {
  const re = /\$?\\?(?:[A-Za-z_\x80-￿][\w\x80-￿]*\\)*[A-Za-z_\x80-￿][\w\x80-￿]*/g
  for (let m = re.exec(line); m; m = re.exec(line)) {
    const start = m.index
    const end = start + m[0].length
    if (column >= start && column <= end) return { start, end, text: m[0] }
    if (start > column) break
  }
  return null
}
