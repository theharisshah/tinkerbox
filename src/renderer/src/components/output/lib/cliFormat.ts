import type { DumpNode, DumpProperty, ExceptionInfo, OutputEvent, PhpDiagnostic, RunResult } from '@shared/types'
import { escapeControl, isList, metaProp } from './dump'
import { runStopNote } from '@/utils/dumpText'
import { compactSql } from './sql'

/**
 * PsySH-style plain text of dumped values and whole runs, used by CLI mode (read-only Monaco), "Copy" on Detail
 * Dive cards and Save Output.
 *
 *   Illuminate\Support\Collection {#1259
 *     all: [
 *       1,
 *     ],
 *   }
 */

const PROP_PREFIX: Record<DumpProperty['vis'], string> = {
  public: '+',
  protected: '#',
  private: '-',
  dynamic: '+',
  attribute: '',
  relation: '',
  meta: ''
}

function propLabel(p: DumpProperty): string {
  if (p.vis === 'dynamic') return `+"${p.name}"`
  return PROP_PREFIX[p.vis] + p.name
}

function keyLabel(k: string | number): string {
  return typeof k === 'number' ? String(k) : `"${escapeControl(k, true)}"`
}

function stringCli(node: Extract<DumpNode, { t: 'string' }>, indent: string): string {
  const prefix = node.binary ? 'b' : ''
  const cut = node.truncated ? '…' : ''
  if (!node.binary && node.v.includes('\n')) {
    const inner = indent + '  '
    const body = escapeControl(node.v)
      .split('\n')
      .map((line) => inner + line)
      .join('\n')
    return `${prefix}"""\n${body}${cut}\n${inner}"""`
  }
  return `${prefix}"${escapeControl(node.v, true)}"${cut}`
}

function moreLine(inner: string, remaining: number): string {
  return remaining > 0 ? `${inner}// … ${remaining} more` : `${inner}// …`
}

function entriesCli(items: Array<{ k: string | number; v: DumpNode }>, count: number, truncated: boolean, indent: string): string {
  if (items.length === 0 && count === 0) return '[]'
  const inner = indent + '  '
  const list = isList(items)
  const lines = items.map((item) => `${inner}${list ? '' : `${keyLabel(item.k)} => `}${dumpToCli(item.v, inner)},`)
  if (truncated || items.length < count) lines.push(moreLine(inner, Math.max(0, count - items.length)))
  return `[\n${lines.join('\n')}\n${indent}]`
}

function objectCli(node: Extract<DumpNode, { t: 'object' }>, indent: string): string {
  const inner = indent + '  '
  const lines: string[] = []
  let head = `${node.class} {#${node.id}`

  if (node.kind === 'datetime') {
    const ts = metaProp(node, 'timestamp')
    if (ts && ts.t === 'int') head = `${node.class} @${ts.v} {#${node.id}`
    if (node.summary) lines.push(`${inner}date: ${node.summary},`)
    return lines.length ? `${head}\n${lines.join('\n')}\n${indent}}` : `${head}}`
  }
  if (node.kind === 'stringable' && node.summary !== undefined) {
    lines.push(`${inner}value: ${stringCli({ t: 'string', v: node.summary, len: node.summary.length }, inner)},`)
    for (const p of node.props) if (p.vis === 'meta') lines.push(`${inner}${p.name}: ${dumpToCli(p.v, inner)},`)
    return `${head}\n${lines.join('\n')}\n${indent}}`
  }
  if (!node.kind && node.summary !== undefined && node.props.length === 0) {
    return `${head} // ${node.summary}}`
  }

  for (const p of node.props) {
    if (node.kind === 'model' && p.vis === 'meta') continue
    lines.push(`${inner}${propLabel(p)}: ${dumpToCli(p.v, inner)},`)
  }
  if (node.items) {
    const count = node.count ?? node.items.length
    lines.push(`${inner}all: ${entriesCli(node.items, count, !!node.truncated, inner)},`)
  } else if (node.truncated) {
    lines.push(`${inner}// …`)
  }
  if (lines.length === 0) return `${head}}`
  return `${head}\n${lines.join('\n')}\n${indent}}`
}

/** PsySH-style multi-line text of a dumped value. `indent` is the indentation of the line the value starts on. */
export function dumpToCli(node: DumpNode | null | undefined, indent = ''): string {
  if (!node) return 'null'
  switch (node.t) {
    case 'null':
      return 'null'
    case 'bool':
      return node.v ? 'true' : 'false'
    case 'int':
    case 'float':
      return node.v
    case 'string':
      return stringCli(node, indent)
    case 'array':
      return entriesCli(node.items, node.count, !!node.truncated, indent)
    case 'object':
      return objectCli(node, indent)
    case 'ref':
      return `${node.class} {#${node.id} …}`
    case 'enum':
      return `${node.class}::${node.case}`
    case 'closure': {
      const where = node.file ? ` // ${node.file}${node.line ? `:${node.line}` : ''}` : node.line ? ` // line ${node.line}` : ''
      return `Closure ${node.signature}${where}`
    }
    case 'resource':
      return `${node.type} resource @${node.id}`
    case 'max-depth':
      if (node.class) return `${node.class} {#…}`
      return node.count !== undefined ? `[ …${node.count}]` : `${node.type} …`
  }
}

/** "= value" with continuation lines aligned under the value (PsySH return value). */
export function returnValueCli(node: DumpNode | null | undefined): string {
  return '= ' + dumpToCli(node, '  ')
}

function locationText(file: string, line: number | undefined, userLine?: number): string {
  if (!file) return userLine || line ? `on line ${userLine ?? line}` : ''
  return `in ${file}${line ? `:${line}` : ''}`
}

/** PsySH-style exception line ("   Exception  Boom in app/Foo.php:12."). */
export function exceptionCli(e: ExceptionInfo): string {
  const where = locationText(e.file, e.line, e.userLine)
  const lines = e.message.replace(/\s+$/, '').split('\n')
  const pad = `   ${' '.repeat(e.class.length)}  `
  const out = lines.map((text, i) => {
    let line = (i === 0 ? `   ${e.class}  ` : pad) + text
    if (i === lines.length - 1) {
      if (where) line += ` ${where}`
      if (!/[.!?]$/.test(line)) line += '.'
    }
    return line
  })
  if (e.fatal) out.push(`${pad}(fatal error)`)
  let previous = e.previous
  let depth = 0
  while (previous && depth++ < 5) {
    const line = `   Caused by ${previous.class}  ${previous.message.split('\n')[0]} ${locationText(previous.file, previous.line, previous.userLine)}`.trimEnd()
    out.push(/[.!?]$/.test(line) ? line : line + '.')
    previous = previous.previous
  }
  return out.join('\n')
}

export function diagnosticCli(d: PhpDiagnostic): string {
  const where = d.file ? `in ${d.file}:${d.line}` : `on line ${d.userLine ?? d.line}`
  return `   ${d.level.toUpperCase()}  ${d.message} ${where}.`
}

export interface CliTextOptions {
  /** Include SQL query events (the tab's SQL toggle). */
  showQueries?: boolean
}

function queryCli(event: Extract<OutputEvent, { kind: 'query' }>): string {
  return `${compactSql(event.rawSql || event.sql)}; -- ${event.timeMs.toFixed(2)}ms (${event.connection})`
}

/** Text of one output event (null when hidden). Dumps end with a newline; echo text is verbatim. */
export function eventCli(event: OutputEvent, options: CliTextOptions = {}): string | null {
  switch (event.kind) {
    case 'echo':
      return event.text
    case 'dump': {
      const source = !event.userCode && event.file ? `// ${event.file}${event.line ? `:${event.line}` : ''}\n` : ''
      const label = event.label ? `${event.label}: ` : ''
      return `${source}${label}${dumpToCli(event.value)}\n`
    }
    case 'query':
      return options.showQueries ? queryCli(event) + '\n' : null
  }
}

/**
 * Whole run as PsySH-style text: framework / realtime stdout, echo output, dumps, queries, warnings, the exception,
 * transport errors and the "= return value".
 */
export function resultToCli(result: RunResult, options: CliTextOptions = {}): string {
  let text = ''
  const add = (part: string, block = false): void => {
    if (!part) return
    if (block && text !== '' && !text.endsWith('\n')) text += '\n'
    text += part
  }
  if (result.rawOutput) add(result.rawOutput)
  for (const event of result.events ?? []) {
    const part = eventCli(event, options)
    if (part !== null) add(part, event.kind !== 'echo')
  }
  for (const d of result.diagnostics ?? []) add(diagnosticCli(d) + '\n', true)
  if (result.exception) {
    if (result.exception.bootstrap) add('   BOOTSTRAP FAILED  The framework could not be booted.\n', true)
    add(exceptionCli(result.exception) + '\n', true)
  }
  const note = runStopNote(result)
  if (result.error && result.error !== note) add(`   ERROR  ${result.error}\n`, true)
  if (result.stderr && !result.exception) add(result.stderr.endsWith('\n') ? result.stderr : result.stderr + '\n', true)
  if (note) add(`   INFO  ${note}\n`, true)
  if (result.exited && !result.exception) add('   INFO  The script ended with exit() or dd().\n', true)
  if (result.hasReturnValue && !result.exception) add(returnValueCli(result.returnValue) + '\n', true)
  return text.replace(/\n+$/, '\n')
}
