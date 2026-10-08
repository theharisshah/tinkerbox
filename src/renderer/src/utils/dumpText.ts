import type { DumpNode, DumpProperty, ExceptionInfo, OutputEvent, RunResult } from '@shared/types'
import { formatBytes, formatDuration } from './format'

/**
 * Plain-text rendering of dumped values and whole run results (VarDumper / PsySH style). Used by Copy Result,
 * Save Output, history previews and as the CLI-mode text source.
 */

const VIS_PREFIX: Record<DumpProperty['vis'], string> = {
  public: '+',
  protected: '#',
  private: '-',
  dynamic: '+',
  attribute: '',
  relation: '',
  meta: ''
}

function quote(value: string): string {
  return `"${value}"`
}

function stringText(node: Extract<DumpNode, { t: 'string' }>): string {
  const suffix = node.truncated ? `…` : ''
  if (node.v.includes('\n')) return `"""\n${node.v}${suffix}\n"""`
  return quote(node.v + suffix)
}

function keyText(k: string | number): string {
  return typeof k === 'number' ? String(k) : quote(k)
}

function propName(p: DumpProperty): string {
  if (p.vis === 'dynamic') return `+${quote(p.name)}`
  return VIS_PREFIX[p.vis] + p.name
}

/** One-line preview of a dumped value (like the magic comment badges). */
export function dumpPreview(node: DumpNode | null | undefined, max = 120): string {
  if (!node) return 'null'
  let text: string
  switch (node.t) {
    case 'null':
      text = 'null'
      break
    case 'bool':
      text = node.v ? 'true' : 'false'
      break
    case 'int':
    case 'float':
      text = node.v
      break
    case 'string':
      text = quote(node.v.replace(/\r?\n/g, '↵'))
      break
    case 'array':
      text = node.count === 0 ? '[]' : `array:${node.count} [...]`
      break
    case 'object': {
      const detail = node.summary ?? (node.count !== undefined ? `count: ${node.count}` : '')
      text = `${node.class} {#${node.id}${detail ? ` ${detail}` : ''}}`
      break
    }
    case 'ref':
      text = `${node.class} {#${node.id}}`
      break
    case 'enum':
      text = `${node.class}::${node.case}`
      break
    case 'closure':
      text = `Closure${node.signature}`
      break
    case 'resource':
      text = `${node.type} resource @${node.id}`
      break
    case 'max-depth':
      text = node.class ? `${node.class} {…}` : `${node.type} …`
      break
  }
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

/** Multi-line VarDumper-style text of a dumped value. */
export function dumpToText(node: DumpNode | null | undefined, indent = ''): string {
  if (!node) return 'null'
  const inner = indent + '  '
  switch (node.t) {
    case 'null':
    case 'bool':
    case 'int':
    case 'float':
    case 'enum':
    case 'resource':
      return dumpPreview(node, Number.MAX_SAFE_INTEGER)
    case 'string':
      return stringText(node)
    case 'array': {
      if (node.count === 0) return '[]'
      const lines = node.items.map((item) => `${inner}${keyText(item.k)} => ${dumpToText(item.v, inner)}`)
      if (node.truncated || node.items.length < node.count) lines.push(`${inner}…${node.count - node.items.length} more`)
      return `array:${node.count} [\n${lines.join('\n')}\n${indent}]`
    }
    case 'object': {
      const head = `${node.class} {#${node.id}`
      const lines: string[] = []
      if (node.kind === 'datetime' || node.kind === 'stringable' || node.kind === 'builder' || node.kind === 'html') {
        if (node.summary) lines.push(`${inner}${node.kind === 'builder' ? 'sql' : 'value'}: ${node.summary}`)
      } else if (node.summary && node.kind !== 'model') {
        lines.push(`${inner}${node.summary}`)
      }
      for (const p of node.props) {
        if (node.kind === 'datetime' || node.kind === 'html') break
        lines.push(`${inner}${propName(p)}: ${dumpToText(p.v, inner)}`)
      }
      if (node.items) {
        const items = node.items.map((item) => `${inner}  ${keyText(item.k)} => ${dumpToText(item.v, inner + '  ')}`)
        const count = node.count ?? node.items.length
        if (node.truncated || node.items.length < count) items.push(`${inner}  …${count - node.items.length} more`)
        lines.push(`${inner}all: ${count === 0 ? '[]' : `[\n${items.join('\n')}\n${inner}]`}`)
      }
      if (lines.length === 0) return `${head}}`
      return `${head}\n${lines.join('\n')}\n${indent}}`
    }
    case 'ref':
      return `${node.class} {#${node.id} …}`
    case 'closure': {
      const where = node.file ? ` {${node.file}${node.line ? `:${node.line}` : ''}}` : ''
      return `Closure${node.signature}${where}`
    }
    case 'max-depth':
      if (node.class) return `${node.class} {…}`
      return node.count !== undefined ? `${node.type}:${node.count} […]` : `${node.type} …`
  }
}

/** Text of an exception (Collision-like, without colors). */
export function exceptionToText(e: ExceptionInfo): string {
  const lines: string[] = []
  lines.push(`   ${e.class}${e.fatal ? ' (fatal)' : ''}${e.bootstrap ? ' (while bootstrapping)' : ''}`)
  lines.push('')
  lines.push(`  ${e.message}`)
  lines.push('')
  const at = e.userLine ? `Line ${e.userLine}` : `${e.file}:${e.line}`
  lines.push(`  at ${at}`)
  if (e.snippet) {
    const width = String(e.snippet.startLine + e.snippet.lines.length).length
    e.snippet.lines.forEach((code, i) => {
      const n = e.snippet!.startLine + i
      lines.push(`${n === e.snippet!.line ? '  ➜ ' : '    '}${String(n).padStart(width)}▕ ${code}`)
    })
  }
  const frames = e.trace.filter((f) => !f.vendor).slice(0, 12)
  if (frames.length) {
    lines.push('')
    frames.forEach((f, i) => {
      const where = f.userCode && f.line ? `Line ${f.line}` : f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : ''
      lines.push(`  ${i + 1}   ${where}`)
      lines.push(`      ${f.call}`)
    })
  }
  if (e.previous) {
    lines.push('')
    lines.push('  Previous exception:')
    lines.push(exceptionToText(e.previous))
  }
  return lines.join('\n')
}

function eventToText(event: OutputEvent, showQueries: boolean): string | null {
  switch (event.kind) {
    case 'echo':
      return event.text
    case 'dump':
      return (event.label ? `${event.label}: ` : '') + dumpToText(event.value) + '\n'
    case 'query':
      return showQueries ? `${event.rawSql}  (${event.timeMs.toFixed(2)}ms, ${event.connection})\n` : null
  }
}

export interface ResultTextOptions {
  /** Include SQL query events (the tab's SQL toggle). Default true. */
  showQueries?: boolean
  /** Append a "Time / Memory" footer. Default false. */
  stats?: boolean
}

/**
 * The note for a run that was stopped: main's timeout message (it names the effective timeout and where to change
 * it) or "Execution cancelled.". Null for runs that finished. Output views show this note instead of repeating the
 * same text as an error: main also sets `error` to it for stopped runs.
 */
export function runStopNote(result: Pick<RunResult, 'cancelled' | 'timedOut' | 'error'>): string | null {
  if (result.timedOut) return result.error?.startsWith('Execution timed out') ? result.error : 'Execution timed out.'
  if (result.cancelled) return 'Execution cancelled.'
  return null
}

/** Whole run output as text (echo output, dumps, queries, diagnostics, exception and "= return value"). */
export function resultToText(result: RunResult, options: ResultTextOptions = {}): string {
  const showQueries = options.showQueries ?? true
  const parts: string[] = []
  if (result.rawOutput) parts.push(result.rawOutput.endsWith('\n') ? result.rawOutput : result.rawOutput + '\n')
  for (const event of result.events ?? []) {
    const text = eventToText(event, showQueries)
    if (text) parts.push(text)
  }
  for (const d of result.diagnostics ?? []) {
    parts.push(`${d.level}: ${d.message} on ${d.userLine ? `line ${d.userLine}` : `${d.file}:${d.line}`}\n`)
  }
  if (result.exception) parts.push(exceptionToText(result.exception) + '\n')
  const note = runStopNote(result)
  if (result.error && result.error !== note) parts.push(`Error: ${result.error}\n`)
  if (note) parts.push(`${note}\n`)
  if (result.stderr && !result.exception) parts.push(result.stderr.endsWith('\n') ? result.stderr : result.stderr + '\n')
  if (result.hasReturnValue && !result.exception) parts.push(`= ${dumpToText(result.returnValue)}\n`)
  if (options.stats) {
    parts.push(`\n${formatDuration(result.durationMs)} / ${formatBytes(result.memoryPeak)}\n`)
  }
  let text = ''
  for (const part of parts) {
    if (text !== '' && !text.endsWith('\n')) text += '\n'
    text += part
  }
  return text
}
