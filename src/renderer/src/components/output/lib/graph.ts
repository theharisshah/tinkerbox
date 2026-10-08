import type { DumpItem, DumpNode } from '@shared/types'
import { elementsOf, escapeControl, isList, isSummaryObject, shortClass, splitClass, type ObjectNode } from './dump'

/**
 * Object Graph: turns a dumped value into a tree of boxes (objects / models listing their scalar attributes,
 * "name (count)" group boxes for arrays, collections and to-many relations) and lays it out left → right.
 */

export type GraphFieldType = DumpNode['t'] | 'summary'

export interface GraphField {
  key: string
  value: string
  type: GraphFieldType
}

export type GraphNodeKind = 'object' | 'model' | 'group' | 'value' | 'more'

export interface GraphNode {
  id: string
  kind: GraphNodeKind
  title: string
  subtitle?: string
  fields: GraphField[]
  /** Scalar fields not listed (over the per-node limit). */
  hiddenFields: number
  children: string[]
  parent?: string
  /** Label drawn on the edge from the parent (property / key name). */
  edgeLabel?: string
  depth: number
  /** spl_object_id of object nodes. */
  objectId?: number
}

export interface Graph {
  root: string
  nodes: Record<string, GraphNode>
  /** Nodes not created because the node budget was spent. */
  omitted: number
}

export interface GraphOptions {
  maxFields?: number
  maxChildren?: number
  maxNodes?: number
  /** Characters kept of a field value. */
  maxValueLength?: number
}

const DEFAULTS: Required<GraphOptions> = { maxFields: 14, maxChildren: 30, maxNodes: 600, maxValueLength: 48 }

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

/** Short one-line value of a leaf for a graph field. */
export function fieldValue(node: DumpNode, max = DEFAULTS.maxValueLength): { value: string; type: GraphFieldType } {
  switch (node.t) {
    case 'null':
      return { value: 'null', type: 'null' }
    case 'bool':
      return { value: node.v ? 'true' : 'false', type: 'bool' }
    case 'int':
    case 'float':
      return { value: node.v, type: node.t }
    case 'string':
      return { value: `"${clip(escapeControl(node.v, true), max - 2)}"`, type: 'string' }
    case 'enum':
      return { value: `${shortClass(node.class)}::${node.case}`, type: 'enum' }
    case 'closure':
      return { value: clip(`Closure ${node.signature}`, max), type: 'closure' }
    case 'resource':
      return { value: `${node.type} resource`, type: 'resource' }
    case 'ref':
      return { value: `${shortClass(node.class)} {#${node.id}}`, type: 'ref' }
    case 'max-depth':
      return { value: node.class ? `${shortClass(node.class)} {…}` : node.count !== undefined ? `[…${node.count}]` : '…', type: 'max-depth' }
    case 'array':
      return { value: node.count === 0 ? '[]' : `array:${node.count}`, type: 'array' }
    case 'object':
      if (isSummaryObject(node)) return { value: clip(node.summary ?? '', max), type: 'summary' }
      return { value: `${shortClass(node.class)} {#${node.id}}`, type: 'object' }
  }
}

/** Values drawn as their own box (non-empty arrays and non-summary objects with content). */
function isBox(node: DumpNode): boolean {
  if (node.t === 'array') return node.items.length > 0
  if (node.t === 'object') return !isSummaryObject(node)
  return false
}

export function buildGraph(value: DumpNode, options: GraphOptions = {}): Graph {
  const o = { ...DEFAULTS, ...options }
  const nodes: Record<string, GraphNode> = {}
  let count = 0
  let omitted = 0

  const add = (node: GraphNode): GraphNode => {
    nodes[node.id] = node
    count++
    return node
  }

  const fieldsFor = (target: GraphNode, entries: Array<{ key: string; v: DumpNode }>): Array<{ key: string; v: DumpNode }> => {
    const boxes: Array<{ key: string; v: DumpNode }> = []
    for (const entry of entries) {
      if (isBox(entry.v)) {
        boxes.push(entry)
        continue
      }
      if (target.fields.length < o.maxFields) target.fields.push({ key: entry.key, ...fieldValue(entry.v, o.maxValueLength) })
      else target.hiddenFields++
    }
    return boxes
  }

  const addChildren = (parent: GraphNode, boxes: Array<{ key: string; v: DumpNode }>, labelEdges: boolean): void => {
    let shown = 0
    for (const box of boxes) {
      if (shown >= o.maxChildren || count >= o.maxNodes) break
      const child = visit(box.v, `${parent.id}/${parent.children.length}`, parent.depth + 1, box.key, labelEdges)
      child.parent = parent.id
      parent.children.push(child.id)
      shown++
    }
    const rest = boxes.length - shown
    if (rest > 0) {
      if (count < o.maxNodes) {
        const more = add({
          id: `${parent.id}/more`,
          kind: 'more',
          title: `… ${rest} more`,
          fields: [],
          hiddenFields: 0,
          children: [],
          parent: parent.id,
          depth: parent.depth + 1
        })
        parent.children.push(more.id)
      } else {
        omitted += rest
      }
    }
  }

  const elementEntries = (items: DumpItem[]): Array<{ key: string; v: DumpNode }> => items.map((i) => ({ key: String(i.k), v: i.v }))

  const visitObject = (node: ObjectNode, id: string, depth: number, name: string | undefined, labelEdge: boolean): GraphNode => {
    const { name: short } = splitClass(node.class)
    const model = node.kind === 'model'
    const elements = elementsOf(node)
    // A collection reached through a property becomes a "name (count)" group box.
    if (elements && name !== undefined) {
      const group = add({
        id,
        kind: 'group',
        title: `${name} (${elements.count})`,
        subtitle: `${short} {#${node.id}}`,
        fields: [],
        hiddenFields: 0,
        children: [],
        depth,
        objectId: node.id
      })
      const boxes = fieldsFor(group, elementEntries(elements.items))
      addChildren(group, boxes, !isList(elements.items))
      return group
    }
    const graphNode = add({
      id,
      kind: model ? 'model' : 'object',
      title: model && node.summary ? `${short} ${node.summary}` : short,
      subtitle: `${node.class} {#${node.id}}`,
      fields: [],
      hiddenFields: 0,
      children: [],
      depth,
      objectId: node.id,
      edgeLabel: labelEdge ? name : undefined
    })
    const props = node.props.filter((p) => !(model && p.vis === 'meta')).map((p) => ({ key: p.name, v: p.v }))
    const boxes = fieldsFor(graphNode, props)
    if (elements) {
      // Root collection: elements hang off the object box itself.
      const elementBoxes = fieldsFor(graphNode, elementEntries(elements.items))
      boxes.push(...elementBoxes)
      if (elements.truncated && elements.items.length < elements.count) graphNode.hiddenFields += elements.count - elements.items.length
    }
    addChildren(graphNode, boxes, true)
    return graphNode
  }

  const visit = (node: DumpNode, id: string, depth: number, name: string | undefined, labelEdge: boolean): GraphNode => {
    if (node.t === 'object' && !isSummaryObject(node)) return visitObject(node, id, depth, name, labelEdge)
    if (node.t === 'array') {
      const group = add({
        id,
        kind: 'group',
        title: name !== undefined ? `${name} (${node.count})` : `array (${node.count})`,
        subtitle: name !== undefined ? undefined : `array:${node.count}`,
        fields: [],
        hiddenFields: 0,
        children: [],
        depth
      })
      const boxes = fieldsFor(group, elementEntries(node.items))
      if (node.items.length < node.count) group.hiddenFields += node.count - node.items.length
      addChildren(group, boxes, !isList(node.items))
      return group
    }
    const leaf = add({ id, kind: 'value', title: name ?? 'value', fields: [], hiddenFields: 0, children: [], depth })
    leaf.fields.push({ key: name ?? 'value', ...fieldValue(node, o.maxValueLength) })
    return leaf
  }

  visit(value, 'n', 0, undefined, false)
  return { root: 'n', nodes, omitted }
}

// ---------------------------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------------------------

export interface NodeSize {
  w: number
  h: number
}

export interface LayoutBox extends NodeSize {
  id: string
  x: number
  y: number
}

export interface LayoutEdge {
  from: string
  to: string
  label?: string
  /** SVG path (cubic curve from the parent's right edge to the child's left edge). */
  path: string
  /** Label anchor. */
  lx: number
  ly: number
}

export interface GraphLayout {
  boxes: Record<string, LayoutBox>
  edges: LayoutEdge[]
  width: number
  height: number
}

export const GRAPH_METRICS = {
  charWidth: 7.2,
  lineHeight: 18,
  headerHeight: 30,
  subtitleHeight: 16,
  padX: 12,
  padY: 8,
  minWidth: 150,
  maxWidth: 340,
  gapX: 90,
  gapY: 22
}

/** Box size from its text (monospace metrics). */
export function measureNode(node: GraphNode, m = GRAPH_METRICS): NodeSize {
  let chars = node.title.length + 3
  if (node.subtitle) chars = Math.max(chars, node.subtitle.length * 0.85)
  for (const f of node.fields) chars = Math.max(chars, f.key.length + 2 + f.value.length)
  const w = Math.min(m.maxWidth, Math.max(m.minWidth, Math.ceil(chars * m.charWidth + m.padX * 2)))
  const lines = node.fields.length + (node.hiddenFields > 0 ? 1 : 0)
  const h = m.headerHeight + (node.subtitle ? m.subtitleHeight : 0) + (lines ? lines * m.lineHeight + m.padY : 0)
  return { w, h }
}

/** Visible nodes: the root plus the children of expanded nodes. */
export function visibleNodes(graph: Graph, isExpanded: (id: string) => boolean): GraphNode[] {
  const out: GraphNode[] = []
  const walk = (id: string): void => {
    const node = graph.nodes[id]
    if (!node) return
    out.push(node)
    if (isExpanded(id)) node.children.forEach(walk)
  }
  walk(graph.root)
  return out
}

/** Tidy left → right tree layout: columns per depth, parents centered on their children. */
export function layoutGraph(
  graph: Graph,
  isExpanded: (id: string) => boolean,
  measure: (node: GraphNode) => NodeSize = (n) => measureNode(n),
  m = GRAPH_METRICS
): GraphLayout {
  const sizes = new Map<string, NodeSize>()
  const columnWidth: number[] = []
  for (const node of visibleNodes(graph, isExpanded)) {
    const size = measure(node)
    sizes.set(node.id, size)
    columnWidth[node.depth] = Math.max(columnWidth[node.depth] ?? 0, size.w)
  }
  const columnX: number[] = []
  let x = 0
  for (let d = 0; d < columnWidth.length; d++) {
    columnX[d] = x
    x += (columnWidth[d] ?? 0) + m.gapX
  }

  const boxes: Record<string, LayoutBox> = {}
  const edges: LayoutEdge[] = []

  /** Lays out the subtree at `top`; returns its height. */
  const place = (id: string, top: number): number => {
    const node = graph.nodes[id]
    const size = sizes.get(id)!
    const kids = isExpanded(id) ? node.children.filter((c) => sizes.has(c)) : []
    if (kids.length === 0) {
      boxes[id] = { id, x: columnX[node.depth], y: top, ...size }
      return size.h
    }
    let cursor = top
    const kidTops: number[] = []
    for (const kid of kids) {
      kidTops.push(cursor)
      cursor += place(kid, cursor) + m.gapY
    }
    const span = cursor - m.gapY - top
    if (size.h > span) {
      // Taller parent: push its children down to center them on it.
      const shift = (size.h - span) / 2
      for (const kid of kids) shiftSubtree(kid, shift)
      boxes[id] = { id, x: columnX[node.depth], y: top, ...size }
      return size.h
    }
    const first = boxes[kids[0]]
    const last = boxes[kids[kids.length - 1]]
    const center = (first.y + first.h / 2 + last.y + last.h / 2) / 2
    let y = center - size.h / 2
    y = Math.max(top, Math.min(y, top + span - size.h))
    boxes[id] = { id, x: columnX[node.depth], y, ...size }
    return span
  }

  const shiftSubtree = (id: string, dy: number): void => {
    const box = boxes[id]
    if (!box) return
    box.y += dy
    for (const kid of graph.nodes[id].children) if (boxes[kid]) shiftSubtree(kid, dy)
  }

  const height = place(graph.root, 0)

  for (const box of Object.values(boxes)) {
    const node = graph.nodes[box.id]
    if (!node.parent || !boxes[node.parent]) continue
    const p = boxes[node.parent]
    const x1 = p.x + p.w
    const y1 = p.y + Math.min(p.h / 2, m.headerHeight / 2 + 2)
    const x2 = box.x
    const y2 = box.y + Math.min(box.h / 2, m.headerHeight / 2 + 2)
    const dx = Math.max(24, (x2 - x1) / 2)
    edges.push({
      from: node.parent,
      to: box.id,
      label: node.edgeLabel,
      path: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
      lx: x2 - 8,
      ly: y2 - 6
    })
  }

  let width = 0
  for (const box of Object.values(boxes)) width = Math.max(width, box.x + box.w)
  return { boxes, edges, width, height }
}

/** Ids of nodes initially expanded: everything above `depth`. */
export function initialExpanded(graph: Graph, depth = 2): Set<string> {
  const out = new Set<string>()
  for (const node of Object.values(graph.nodes)) if (node.depth < depth && node.children.length) out.add(node.id)
  return out
}
