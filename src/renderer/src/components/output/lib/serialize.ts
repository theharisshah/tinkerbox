import type { DumpNode } from '@shared/types'
import { indexObjects, isList, isSummaryObject, scalarText, type ObjectNode } from './dump'

/**
 * Data-oriented views of dumped values: the "plain" shape (list / map / leaf) used by the JSON and PHP array
 * serializers, table detection (Table Preview) and the CSV / Markdown exports.
 */

export type Shape =
  | { kind: 'list'; values: DumpNode[]; truncated: boolean }
  | { kind: 'map'; entries: Array<[string | number, DumpNode]>; truncated: boolean }
  | { kind: 'leaf' }

/**
 * How a node maps to plain data: arrays → list/map, collections → their items, models → attributes + loaded
 * relations, other objects → their (non-meta) properties; Carbon / Stringable / builders and scalars are leaves.
 */
export function shapeOf(node: DumpNode): Shape {
  if (node.t === 'array') {
    const truncated = !!node.truncated || node.items.length < node.count
    if (isList(node.items)) return { kind: 'list', values: node.items.map((i) => i.v), truncated }
    return { kind: 'map', entries: node.items.map((i) => [i.k, i.v]), truncated }
  }
  if (node.t !== 'object' || isSummaryObject(node)) return { kind: 'leaf' }
  if (node.items) {
    const truncated = !!node.truncated || node.items.length < (node.count ?? node.items.length)
    if (isList(node.items)) return { kind: 'list', values: node.items.map((i) => i.v), truncated }
    return { kind: 'map', entries: node.items.map((i) => [i.k, i.v]), truncated }
  }
  if (node.kind === 'model') {
    const entries = node.props.filter((p) => p.vis === 'attribute' || p.vis === 'relation').map((p): [string, DumpNode] => [p.name, p.v])
    return { kind: 'map', entries, truncated: !!node.truncated }
  }
  if (node.summary !== undefined && node.props.length === 0) return { kind: 'leaf' }
  const entries = node.props.filter((p) => p.vis !== 'meta').map((p): [string, DumpNode] => [p.name, p.v])
  return { kind: 'map', entries, truncated: !!node.truncated }
}

// ---------------------------------------------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------------------------------------------

function jsonLeaf(node: DumpNode): string {
  switch (node.t) {
    case 'null':
      return 'null'
    case 'bool':
      return node.v ? 'true' : 'false'
    case 'int':
      return /^-?\d+$/.test(node.v) ? node.v : JSON.stringify(node.v)
    case 'float':
      // INF / NAN have no JSON representation: keep them as strings.
      return /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(node.v) ? node.v : JSON.stringify(node.v)
    case 'string':
      return JSON.stringify(node.v)
    case 'enum':
      return node.value !== undefined ? JSON.stringify(node.value) : JSON.stringify(node.case)
    default:
      return JSON.stringify(scalarText(node))
  }
}

/** Pretty JSON of a dumped value; 64-bit integers keep their exact digits. */
export function toJson(node: DumpNode, indent = '  ', level = 0): string {
  const shape = shapeOf(node)
  const pad = indent.repeat(level + 1)
  const end = indent.repeat(level)
  if (shape.kind === 'list') {
    if (shape.values.length === 0) return '[]'
    return `[\n${shape.values.map((v) => pad + toJson(v, indent, level + 1)).join(',\n')}\n${end}]`
  }
  if (shape.kind === 'map') {
    if (shape.entries.length === 0) return '{}'
    const lines = shape.entries.map(([k, v]) => `${pad}${JSON.stringify(String(k))}: ${toJson(v, indent, level + 1)}`)
    return `{\n${lines.join(',\n')}\n${end}}`
  }
  return jsonLeaf(node)
}

// ---------------------------------------------------------------------------------------------------------------
// PHP array literal
// ---------------------------------------------------------------------------------------------------------------

export function phpString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

function phpKey(key: string | number): string {
  return typeof key === 'number' ? String(key) : phpString(key)
}

function phpLeaf(node: DumpNode): string {
  switch (node.t) {
    case 'null':
      return 'null'
    case 'bool':
      return node.v ? 'true' : 'false'
    case 'int':
    case 'float':
      return node.v
    case 'string':
      // Binary strings arrive \xNN-escaped: a double-quoted literal turns the escapes back into bytes.
      if (node.binary) return `"${node.v.replace(/"/g, '\\"').replace(/\$/g, '\\$')}"`
      return phpString(node.v)
    case 'enum':
      return `\\${node.class.replace(/^\\/, '')}::${node.case}`
    case 'max-depth':
      return 'null'
    default:
      return phpString(scalarText(node))
  }
}

/** PHP short-array literal of a dumped value (4-space indentation, trailing commas). */
export function toPhp(node: DumpNode, indent = '    ', level = 0): string {
  const shape = shapeOf(node)
  const pad = indent.repeat(level + 1)
  const end = indent.repeat(level)
  if (shape.kind === 'list') {
    if (shape.values.length === 0) return '[]'
    return `[\n${shape.values.map((v) => `${pad}${toPhp(v, indent, level + 1)},`).join('\n')}\n${end}]`
  }
  if (shape.kind === 'map') {
    if (shape.entries.length === 0) return '[]'
    return `[\n${shape.entries.map(([k, v]) => `${pad}${phpKey(k)} => ${toPhp(v, indent, level + 1)},`).join('\n')}\n${end}]`
  }
  return phpLeaf(node)
}

// ---------------------------------------------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------------------------------------------

export interface TableRow {
  /** Key of the element in the list (index or array key). */
  key: string | number
  cells: Record<string, DumpNode>
  /** The element itself (for Copy as PHP array / JSON). */
  source: DumpNode
}

export interface TableData {
  columns: string[]
  rows: TableRow[]
  /** Elements in the dumped list (may exceed rows.length when the dump was truncated). */
  total: number
}

/**
 * Named-key record of a list element: an associative array, a model (attributes) or an object (properties).
 * Null for scalars, lists and summary objects.
 */
export function recordOf(node: DumpNode): Array<[string, DumpNode]> | null {
  if (node.t === 'array') {
    if (node.items.length === 0 || !node.items.some((i) => typeof i.k === 'string')) return null
    return node.items.map((i): [string, DumpNode] => [String(i.k), i.v])
  }
  if (node.t !== 'object' || isSummaryObject(node) || node.kind === 'collection' || node.items) return null
  if (node.kind === 'model') {
    const attrs = node.props.filter((p) => p.vis === 'attribute')
    return attrs.length ? attrs.map((p): [string, DumpNode] => [p.name, p.v]) : null
  }
  const props = node.props.filter((p) => p.vis !== 'meta')
  return props.length ? props.map((p): [string, DumpNode] => [p.name, p.v]) : null
}

/**
 * Table view of a list of records (arrays with named keys, objects, models — directly or inside a collection).
 * Columns are the union of the record keys in first-seen order. Null when the value is not tabulable.
 */
export function tabulate(node: DumpNode | null | undefined): TableData | null {
  if (!node) return null
  let items: Array<{ k: string | number; v: DumpNode }>
  let total: number
  if (node.t === 'array') {
    items = node.items
    total = node.count
  } else if (node.t === 'object' && node.items) {
    items = node.items
    total = node.count ?? node.items.length
  } else {
    return null
  }
  if (items.length === 0) return null
  const columns: string[] = []
  const seen = new Set<string>()
  const rows: TableRow[] = []
  // The same object listed twice is dumped once and referenced afterwards: resolve those references.
  let objects: Map<number, ObjectNode> | null = null
  for (const item of items) {
    let value = item.v
    if (value.t === 'ref') {
      objects ??= indexObjects(node)
      const target = objects.get(value.id)
      if (!target) return null
      value = target
    }
    const record = recordOf(value)
    if (!record) return null
    const cells: Record<string, DumpNode> = {}
    for (const [key, value] of record) {
      if (!seen.has(key)) {
        seen.add(key)
        columns.push(key)
      }
      cells[key] = value
    }
    rows.push({ key: item.k, cells, source: value })
  }
  return { columns, rows, total }
}

export function isTabulable(node: DumpNode | null | undefined): boolean {
  return tabulate(node) !== null
}

/** Plain text of a table cell (strings unquoted, nested values as compact JSON). */
export function cellText(node: DumpNode | undefined): string {
  if (!node) return ''
  switch (node.t) {
    case 'null':
      return ''
    case 'string':
      return node.v
    case 'bool':
    case 'int':
    case 'float':
    case 'enum':
      return node.t === 'enum' && node.value !== undefined ? String(node.value) : scalarText(node)
    default: {
      if (node.t === 'object' && isSummaryObject(node)) return node.summary ?? ''
      const shape = shapeOf(node)
      if (shape.kind === 'leaf') return scalarText(node)
      return toJson(node, '').replace(/\n/g, '')
    }
  }
}

/** Comparable sort key of a cell: numbers for numeric cells, lowercased text otherwise. */
export function cellSortKey(node: DumpNode | undefined): { rank: number; num: number; text: string } {
  if (!node || node.t === 'null') return { rank: 2, num: 0, text: '' }
  if (node.t === 'int' || node.t === 'float') {
    const n = Number(node.v)
    if (!Number.isNaN(n)) return { rank: 0, num: n, text: '' }
  }
  if (node.t === 'bool') return { rank: 0, num: node.v ? 1 : 0, text: '' }
  return { rank: 1, num: 0, text: cellText(node).toLowerCase() }
}

export function compareCells(a: DumpNode | undefined, b: DumpNode | undefined): number {
  const ka = cellSortKey(a)
  const kb = cellSortKey(b)
  if (ka.rank !== kb.rank) return ka.rank - kb.rank
  if (ka.rank === 0) return ka.num - kb.num
  return ka.text < kb.text ? -1 : ka.text > kb.text ? 1 : 0
}

function csvField(text: string): string {
  return /[",\r\n]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** RFC 4180 CSV (header row + one line per row). */
export function toCsv(table: Pick<TableData, 'columns'>, rows: readonly TableRow[]): string {
  const lines = [table.columns.map(csvField).join(',')]
  for (const row of rows) lines.push(table.columns.map((c) => csvField(cellText(row.cells[c]))).join(','))
  return lines.join('\r\n') + '\r\n'
}

/** Copy as PHP array: one row → its array literal, several rows → a list of them. */
export function rowsToPhp(rows: readonly TableRow[]): string {
  if (rows.length === 1) return toPhp(rows[0].source)
  return `[\n${rows.map((r) => `    ${toPhp(r.source, '    ', 1)},`).join('\n')}\n]`
}

/** Copy as JSON: one row → its object, several rows → an array. */
export function rowsToJson(rows: readonly TableRow[]): string {
  if (rows.length === 1) return toJson(rows[0].source)
  return `[\n${rows.map((r) => `  ${toJson(r.source, '  ', 1)}`).join(',\n')}\n]`
}

function mdCell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
}

/** GitHub-flavored Markdown table. */
export function toMarkdownTable(table: TableData, rows: readonly TableRow[] = table.rows): string {
  const head = `| ${table.columns.map(mdCell).join(' | ')} |`
  const rule = `| ${table.columns.map(() => '---').join(' | ')} |`
  const body = rows.map((r) => `| ${table.columns.map((c) => mdCell(cellText(r.cells[c]))).join(' | ')} |`)
  return [head, rule, ...body].join('\n')
}
