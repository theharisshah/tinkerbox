import { describe, expect, it } from 'vitest'
import type { DumpNode } from '@shared/types'
import { buildGraph, initialExpanded, layoutGraph, visibleNodes } from '@/components/output/lib/graph'
import { arr, collection, int, model, str } from './fixtures'

const user = model(
  'App\\Models\\User',
  10,
  { id: int(1), name: str('Taylor'), email: str('taylor@laravel.com') },
  {
    friends: collection(11, [model('App\\Models\\User', 12, { id: int(2), name: str('Abigail') }), model('App\\Models\\User', 13, { id: int(3), name: str('Jess') })]),
    manager: model('App\\Models\\User', 14, { id: int(9), name: str('Boss') })
  }
)

describe('buildGraph', () => {
  it('creates a box per model with its scalar attributes and relation boxes with counts', () => {
    const graph = buildGraph(user)
    const root = graph.nodes[graph.root]
    expect(root.kind).toBe('model')
    expect(root.title).toBe('User #1')
    expect(root.fields.map((f) => `${f.key}: ${f.value}`)).toEqual(['id: 1', 'name: "Taylor"', 'email: "taylor@laravel.com"'])
    const children = root.children.map((id) => graph.nodes[id])
    expect(children.map((c) => c.title)).toEqual(['friends (2)', 'User #9'])
    expect(children[0].kind).toBe('group')
    expect(children[1].edgeLabel).toBe('manager')
    const friends = children[0].children.map((id) => graph.nodes[id])
    expect(friends.map((f) => f.title)).toEqual(['User #2', 'User #3'])
    expect(friends[0].depth).toBe(2)
    expect(friends[0].parent).toBe(children[0].id)
  })

  it('groups arrays and keeps scalar elements as fields', () => {
    const graph = buildGraph(arr({ tags: arr([str('php'), str('laravel')]), n: int(1) }))
    const root = graph.nodes[graph.root]
    expect(root.title).toBe('array (2)')
    expect(root.fields).toEqual([{ key: 'n', value: '1', type: 'int' }])
    const tags = graph.nodes[root.children[0]]
    expect(tags.title).toBe('tags (2)')
    expect(tags.fields.map((f) => f.value)).toEqual(['"php"', '"laravel"'])
  })

  it('limits fields and children', () => {
    const many: DumpNode = arr(Array.from({ length: 50 }, (_, i) => arr({ id: int(i) })))
    const graph = buildGraph(many, { maxChildren: 5, maxFields: 3 })
    const root = graph.nodes[graph.root]
    expect(root.children).toHaveLength(6)
    expect(graph.nodes[root.children[5]].title).toBe('… 45 more')
    const wide = buildGraph(arr(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, int(i)]))), { maxFields: 3 })
    expect(wide.nodes[wide.root].fields).toHaveLength(3)
    expect(wide.nodes[wide.root].hiddenFields).toBe(7)
  })

  it('wraps scalars in a value box', () => {
    const graph = buildGraph(int(5))
    expect(graph.nodes[graph.root].kind).toBe('value')
    expect(graph.nodes[graph.root].fields[0].value).toBe('5')
  })
})

describe('layoutGraph', () => {
  it('lays out left to right without overlaps and centers parents', () => {
    const graph = buildGraph(user)
    const expanded = new Set(Object.keys(graph.nodes))
    const layout = layoutGraph(graph, (id) => expanded.has(id))
    const boxes = Object.values(layout.boxes)
    expect(boxes).toHaveLength(Object.keys(graph.nodes).length)
    for (const box of boxes) {
      const node = graph.nodes[box.id]
      if (node.parent) expect(box.x).toBeGreaterThan(layout.boxes[node.parent].x + layout.boxes[node.parent].w)
    }
    // No two boxes in the same column overlap vertically.
    for (const a of boxes) {
      for (const b of boxes) {
        if (a === b || a.x !== b.x) continue
        expect(a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true)
      }
    }
    expect(layout.edges).toHaveLength(boxes.length - 1)
    expect(layout.edges.find((e) => e.label === 'manager')).toBeTruthy()
    expect(layout.width).toBeGreaterThan(0)
    expect(layout.height).toBeGreaterThan(0)
  })

  it('hides children of collapsed nodes', () => {
    const graph = buildGraph(user)
    const expanded = initialExpanded(graph, 1)
    expect(expanded.has(graph.root)).toBe(true)
    const visible = visibleNodes(graph, (id) => expanded.has(id))
    expect(visible.map((n) => n.depth)).toEqual([0, 1, 1])
    const layout = layoutGraph(graph, (id) => expanded.has(id))
    expect(Object.keys(layout.boxes)).toHaveLength(3)
  })
})
