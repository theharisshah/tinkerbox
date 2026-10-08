import type { DumpItem, DumpNode, DumpProperty } from '@shared/types'

/**
 * Helpers over the structured `DumpNode` trees produced by resources/php/src/Dumper.php. Pure functions (no Vue,
 * no Monaco) so they can be unit tested and shared by the Cards view tree, the CLI formatter, the table preview,
 * the object graph and the copy/export serializers.
 */

export type ObjectNode = Extract<DumpNode, { t: 'object' }>
export type ArrayNode = Extract<DumpNode, { t: 'array' }>
export type StringNode = Extract<DumpNode, { t: 'string' }>
export type HtmlNode = ObjectNode & { html: string }

/** Object kinds rendered as a one-line value (their `summary`) rather than a property list. */
const SUMMARY_KINDS = new Set(['datetime', 'stringable', 'builder'])

export function splitClass(cls: string): { ns: string; name: string } {
  const at = cls.lastIndexOf('\\')
  if (at < 0) return { ns: '', name: cls }
  return { ns: cls.slice(0, at + 1), name: cls.slice(at + 1) }
}

export function shortClass(cls: string): string {
  return splitClass(cls).name
}

/** Keys are 0, 1, 2, … in order (PHP list). */
export function isList(items: readonly DumpItem[]): boolean {
  for (let i = 0; i < items.length; i++) if (items[i].k !== i) return false
  return true
}

/** Whether the object node renders as a single value (Carbon, Stringable, builders). */
export function isSummaryObject(node: DumpNode): boolean {
  return node.t === 'object' && !!node.kind && SUMMARY_KINDS.has(node.kind) && node.summary !== undefined
}

export function hasHtml(node: DumpNode | null | undefined): node is HtmlNode {
  return !!node && node.t === 'object' && typeof node.html === 'string'
}

/** Elements of an array or of a collection-like object (Collection, paginator, ArrayObject…). */
export function elementsOf(node: DumpNode): { items: DumpItem[]; count: number; truncated: boolean } | null {
  if (node.t === 'array') return { items: node.items, count: node.count, truncated: !!node.truncated || node.items.length < node.count }
  if (node.t === 'object' && node.items) {
    const count = node.count ?? node.items.length
    return { items: node.items, count, truncated: !!node.truncated || node.items.length < count }
  }
  return null
}

/** Has children worth expanding (non-empty array, object with props or items). */
export function isExpandable(node: DumpNode): boolean {
  if (node.t === 'array') return node.items.length > 0 || node.count > 0
  if (node.t === 'object') return node.props.length > 0 || (node.items?.length ?? 0) > 0 || (node.count ?? 0) > 0
  return false
}

/** Structural values: arrays and (non-summary) objects. */
export function isStructure(node: DumpNode): boolean {
  if (node.t === 'array') return true
  if (node.t === 'object') return !isSummaryObject(node)
  return false
}

/** Direct child values of a node (props and items). */
export function childValues(node: DumpNode): DumpNode[] {
  if (node.t === 'array') return node.items.map((i) => i.v)
  if (node.t === 'object') return [...node.props.map((p) => p.v), ...(node.items ?? []).map((i) => i.v)]
  return []
}

/** An array or object that contains at least one nested array/object (eye icon → Object Graph). */
export function hasNestedStructure(node: DumpNode): boolean {
  if (!isStructure(node)) return false
  return childValues(node).some((child) => (child.t === 'array' && child.count > 0) || (child.t === 'object' && isExpandable(child)))
}

/** Title for the HTML preview: a view name / mail subject, else the short class name. */
export function htmlTitle(node: HtmlNode): string {
  return node.kind === 'html' && node.summary ? node.summary : shortClass(node.class)
}

/** First node (depth-first, root included) carrying rendered HTML. */
export function findHtml(node: DumpNode | null | undefined, maxNodes = 5000): HtmlNode | null {
  if (!node) return null
  const stack: DumpNode[] = [node]
  let seen = 0
  while (stack.length && seen++ < maxNodes) {
    const current = stack.shift()!
    if (hasHtml(current)) return current
    stack.push(...childValues(current))
  }
  return null
}

/** All HTML nodes in document order (used to re-locate a previewed HTML node after a re-run). */
export function collectHtml(node: DumpNode | null | undefined, out: HtmlNode[] = [], maxNodes = 5000): HtmlNode[] {
  if (!node) return out
  const stack: DumpNode[] = [node]
  let seen = 0
  while (stack.length && seen++ < maxNodes) {
    const current = stack.pop()!
    if (hasHtml(current)) out.push(current)
    const children = childValues(current)
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i])
  }
  return out
}

/** Value of a meta property (`vis: 'meta'`) by name. */
export function metaProp(node: ObjectNode, name: string): DumpNode | undefined {
  return node.props.find((p) => p.vis === 'meta' && p.name === name)?.v
}

export interface PropGroup {
  id: 'props' | 'attributes' | 'relations' | 'meta'
  label: string
  props: DumpProperty[]
}

/** Object properties grouped for display: models → attributes / relations / meta, others → props / meta. */
export function groupProps(node: ObjectNode): PropGroup[] {
  const groups: PropGroup[] = []
  const pick = (id: PropGroup['id'], label: string, test: (p: DumpProperty) => boolean): void => {
    const props = node.props.filter(test)
    if (props.length) groups.push({ id, label, props })
  }
  if (node.kind === 'model') {
    pick('attributes', 'attributes', (p) => p.vis === 'attribute')
    pick('relations', 'relations', (p) => p.vis === 'relation')
    pick('props', 'properties', (p) => p.vis !== 'attribute' && p.vis !== 'relation' && p.vis !== 'meta')
  } else {
    pick('props', 'properties', (p) => p.vis !== 'meta')
  }
  pick('meta', 'meta', (p) => p.vis === 'meta')
  return groups
}

/** Plain value of a scalar-ish node: string content, number text, true/false/null. */
export function scalarText(node: DumpNode): string {
  switch (node.t) {
    case 'null':
      return 'null'
    case 'bool':
      return node.v ? 'true' : 'false'
    case 'int':
    case 'float':
      return node.v
    case 'string':
      return node.v + (node.truncated ? '…' : '')
    case 'enum':
      return `${node.class}::${node.case}`
    case 'closure':
      return `Closure ${node.signature}`
    case 'resource':
      return `${node.type} resource`
    case 'ref':
      return `${node.class} {#${node.id}}`
    case 'max-depth':
      return node.class ? `${node.class} {…}` : `${node.type} …`
    case 'array':
      return node.count === 0 ? '[]' : `array:${node.count}`
    case 'object':
      if (node.summary !== undefined && node.kind !== 'model') return node.summary
      return `${node.class} {#${node.id}${node.summary ? ` ${node.summary}` : ''}}`
  }
}

/** Escape control characters for single-line display (VarDumper style); `\n` kept unless `newlines`. */
export function escapeControl(text: string, newlines = false): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]|\n|\t/g, (ch) => {
    if (ch === '\n') return newlines ? '\\n' : ch
    if (ch === '\t') return '\\t'
    if (ch === '\r') return '\\r'
    if (ch === '\0') return '\\0'
    if (ch === '\u001B') return '\\e'
    return '\\x' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')
  })
}

/** Segments of a string for highlighted display: plain text vs escape sequences. */
export function escapeSegments(text: string): Array<{ text: string; escape: boolean }> {
  const out: Array<{ text: string; escape: boolean }> = []
  // eslint-disable-next-line no-control-regex
  const re = /[\u0000-\u0008\u000B-\u001F\u007F]|\t/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), escape: false })
    out.push({ text: escapeControl(m[0]), escape: true })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), escape: false })
  return out
}

/** Map spl_object_id → path of the first (expanded) occurrence of each object in a tree. */
export function objectPaths(node: DumpNode, path = 'r', out: Map<number, string> = new Map(), budget = { n: 20000 }): Map<number, string> {
  if (budget.n-- <= 0) return out
  if (node.t === 'object') {
    if (!out.has(node.id)) out.set(node.id, path)
    node.props.forEach((p, i) => objectPaths(p.v, `${path}.p${i}`, out, budget))
    node.items?.forEach((item, i) => objectPaths(item.v, `${path}.i${i}`, out, budget))
  } else if (node.t === 'array') {
    node.items.forEach((item, i) => objectPaths(item.v, `${path}.i${i}`, out, budget))
  }
  return out
}

/** spl_object_id → first expanded object node (resolves `ref` nodes inside the same dump). */
export function indexObjects(node: DumpNode, out: Map<number, ObjectNode> = new Map(), budget = { n: 20000 }): Map<number, ObjectNode> {
  if (budget.n-- <= 0) return out
  if (node.t === 'object') {
    if (!out.has(node.id)) out.set(node.id, node)
    for (const p of node.props) indexObjects(p.v, out, budget)
    for (const item of node.items ?? []) indexObjects(item.v, out, budget)
  } else if (node.t === 'array') {
    for (const item of node.items) indexObjects(item.v, out, budget)
  }
  return out
}

/** Paths of every expandable node below (and including) `node`, for recursive expand/collapse. */
export function expandablePaths(node: DumpNode, path: string, out: string[] = [], budget = { n: 20000 }): string[] {
  if (budget.n-- <= 0) return out
  if (!isExpandable(node)) return out
  out.push(path)
  if (node.t === 'object') {
    node.props.forEach((p, i) => expandablePaths(p.v, `${path}.p${i}`, out, budget))
    node.items?.forEach((item, i) => expandablePaths(item.v, `${path}.i${i}`, out, budget))
  } else if (node.t === 'array') {
    node.items.forEach((item, i) => expandablePaths(item.v, `${path}.i${i}`, out, budget))
  }
  return out
}

/** Ancestor paths of a path ("r.p1.i2" → ["r", "r.p1"]). */
export function ancestorPaths(path: string): string[] {
  const parts = path.split('.')
  const out: string[] = []
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('.'))
  return out
}
