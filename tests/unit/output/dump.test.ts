import { describe, expect, it } from 'vitest'
import type { DumpNode } from '@shared/types'
import {
  ancestorPaths,
  collectHtml,
  escapeControl,
  escapeSegments,
  expandablePaths,
  findHtml,
  groupProps,
  hasNestedStructure,
  htmlTitle,
  isSummaryObject,
  objectPaths,
  splitClass
} from '@/components/output/lib/dump'
import { arr, collection, int, model, str } from './fixtures'

const mail: DumpNode = { t: 'object', class: 'App\\Mail\\Welcome', id: 3, kind: 'html', summary: 'Welcome aboard', html: '<p>Hi</p>', props: [] }

describe('dump helpers', () => {
  it('splits class names', () => {
    expect(splitClass('App\\Models\\User')).toEqual({ ns: 'App\\Models\\', name: 'User' })
    expect(splitClass('stdClass')).toEqual({ ns: '', name: 'stdClass' })
  })

  it('escapes control characters', () => {
    expect(escapeControl('a\tb\r\0\u001b\u0001')).toBe('a\\tb\\r\\0\\e\\x01')
    expect(escapeControl('a\nb')).toBe('a\nb')
    expect(escapeControl('a\nb', true)).toBe('a\\nb')
    expect(escapeSegments('x\ty')).toEqual([
      { text: 'x', escape: false },
      { text: '\\t', escape: true },
      { text: 'y', escape: false }
    ])
  })

  it('groups model properties', () => {
    const groups = groupProps(model('App\\User', 1, { id: int(1) }, { posts: collection(2, []) }) as Extract<DumpNode, { t: 'object' }>)
    expect(groups.map((g) => [g.id, g.props.map((p) => p.name)])).toEqual([
      ['attributes', ['id']],
      ['relations', ['posts']],
      ['meta', ['exists', 'connection', 'table']]
    ])
  })

  it('detects nested structures (Object Graph) and summary objects', () => {
    expect(hasNestedStructure(arr({ a: int(1) }))).toBe(false)
    expect(hasNestedStructure(arr({ a: arr([int(1)]) }))).toBe(true)
    expect(hasNestedStructure(model('App\\User', 1, { id: int(1) }, { posts: collection(2, [int(1)]) }))).toBe(true)
    expect(hasNestedStructure(str('x'))).toBe(false)
    expect(isSummaryObject({ t: 'object', class: 'Carbon\\Carbon', id: 1, kind: 'datetime', summary: 'x', props: [] })).toBe(true)
    expect(isSummaryObject(model('App\\User', 1, { id: int(1) }))).toBe(false)
  })

  it('finds HTML nodes in document order', () => {
    const tree = arr({ first: mail, nested: arr([{ ...mail, id: 4, html: '<p>Two</p>' }]) })
    expect(findHtml(tree)?.id).toBe(3)
    expect(collectHtml(tree).map((n) => n.html)).toEqual(['<p>Hi</p>', '<p>Two</p>'])
    expect(findHtml(int(1))).toBeNull()
    expect(htmlTitle(collectHtml(tree)[0])).toBe('Welcome aboard')
    expect(htmlTitle({ t: 'object', class: 'Illuminate\\Support\\HtmlString', id: 1, kind: 'stringable', summary: '<b>x</b>', html: '<b>x</b>', props: [] })).toBe(
      'HtmlString'
    )
  })

  it('computes expand paths and object locations', () => {
    const user = model('App\\User', 7, { id: int(1) }, { friends: collection(8, [model('App\\User', 9, { id: int(2) })]) })
    const paths = objectPaths(user)
    expect(paths.get(7)).toBe('r')
    expect(paths.get(8)).toBe('r.p1')
    expect(paths.get(9)).toBe('r.p1.i0')
    expect(ancestorPaths('r.p1.i0')).toEqual(['r', 'r.p1'])
    expect(expandablePaths(user, 'r')).toEqual(['r', 'r.p1', 'r.p1.i0'])
  })
})
