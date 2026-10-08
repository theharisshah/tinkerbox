import { describe, expect, it } from 'vitest'
import type { DumpNode } from '@shared/types'
import {
  cellText,
  compareCells,
  isTabulable,
  rowsToJson,
  rowsToPhp,
  tabulate,
  toCsv,
  toJson,
  toMarkdownTable,
  toPhp
} from '@/components/output/lib/serialize'
import { valueMarkdown } from '@/components/output/lib/copy'
import { arr, bool, collection, float, int, model, nul, str } from './fixtures'

const rows = arr([
  arr({ id: int(1), name: str('Taylor'), email: str('taylor@laravel.com') }),
  arr({ id: int(2), name: str('Abigail, "Abby"'), admin: bool(true) })
])

describe('tabulable detection', () => {
  it('accepts lists of associative arrays, objects, models and collections of them', () => {
    expect(isTabulable(rows)).toBe(true)
    expect(isTabulable(collection(1, [model('App\\User', 2, { id: int(1) }), model('App\\User', 3, { id: int(2) })]))).toBe(true)
    const objects = arr([
      { t: 'object', class: 'stdClass', id: 4, props: [{ name: 'a', vis: 'dynamic', v: int(1) }] },
      { t: 'object', class: 'stdClass', id: 5, props: [{ name: 'b', vis: 'dynamic', v: int(2) }] }
    ])
    expect(isTabulable(objects)).toBe(true)
  })

  it('rejects scalars, lists of scalars, lists of lists, empty lists and mixed lists', () => {
    expect(isTabulable(int(1))).toBe(false)
    expect(isTabulable(arr([int(1), int(2)]))).toBe(false)
    expect(isTabulable(arr([arr([int(1)]), arr([int(2)])]))).toBe(false)
    expect(isTabulable(arr([]))).toBe(false)
    expect(isTabulable(arr([arr({ a: int(1) }), int(2)]))).toBe(false)
    expect(isTabulable(model('App\\User', 1, { id: int(1) }))).toBe(false)
    expect(isTabulable(null)).toBe(false)
  })

  it('builds the union of keys in first-seen order', () => {
    const table = tabulate(rows)!
    expect(table.columns).toEqual(['id', 'name', 'email', 'admin'])
    expect(table.rows).toHaveLength(2)
    expect(table.rows[1].cells.email).toBeUndefined()
    expect(table.total).toBe(2)
  })

  it('resolves references to objects listed earlier in the same dump', () => {
    const user = model('App\\User', 7, { id: int(1), name: str('A') })
    const list = collection(1, [user, { t: 'ref', class: 'App\\User', id: 7 }])
    const table = tabulate(list)!
    expect(table.rows).toHaveLength(2)
    expect(cellText(table.rows[1].cells.name)).toBe('A')
    expect(table.rows[1].source).toBe(user)
    expect(isTabulable(collection(2, [user, { t: 'ref', class: 'App\\User', id: 99 }]))).toBe(false)
  })

  it('uses model attributes as columns (not relations or meta)', () => {
    const table = tabulate(collection(1, [model('App\\User', 2, { id: int(1), name: str('A') }, { posts: collection(3, []) })]))!
    expect(table.columns).toEqual(['id', 'name'])
  })
})

describe('cells', () => {
  it('renders plain cell text', () => {
    expect(cellText(str('x'))).toBe('x')
    expect(cellText(nul)).toBe('')
    expect(cellText(bool(false))).toBe('false')
    expect(cellText(arr([int(1), int(2)]))).toBe('[1,2]')
    expect(cellText(undefined)).toBe('')
  })

  it('sorts numbers numerically, text case-insensitively, nulls last', () => {
    const values: Array<DumpNode | undefined> = [str('b'), int(10), nul, int(9), str('A'), undefined]
    values.sort(compareCells)
    expect(values.map((v) => (v ? cellText(v) : 'undef'))).toEqual(['9', '10', 'A', 'b', '', 'undef'])
  })
})

describe('serializers', () => {
  it('exports CSV with quoting', () => {
    const table = tabulate(rows)!
    expect(toCsv(table, table.rows)).toBe(
      'id,name,email,admin\r\n1,Taylor,taylor@laravel.com,\r\n2,"Abigail, ""Abby""",,true\r\n'
    )
  })

  it('serializes PHP array literals', () => {
    expect(toPhp(arr({ id: int(1), name: str("O'Brien \\ co"), tags: arr([str('a')]), none: nul, ok: bool(true), f: float('1.5') }))).toBe(
      "[\n    'id' => 1,\n    'name' => 'O\\'Brien \\\\ co',\n    'tags' => [\n        'a',\n    ],\n    'none' => null,\n    'ok' => true,\n    'f' => 1.5,\n]"
    )
    expect(toPhp(arr([]))).toBe('[]')
    expect(toPhp({ t: 'enum', class: 'App\\Status', case: 'Active', value: 'active' })).toBe('\\App\\Status::Active')
    const table = tabulate(rows)!
    expect(rowsToPhp([table.rows[0]])).toBe("[\n    'id' => 1,\n    'name' => 'Taylor',\n    'email' => 'taylor@laravel.com',\n]")
    expect(rowsToPhp(table.rows)).toBe(
      "[\n    [\n        'id' => 1,\n        'name' => 'Taylor',\n        'email' => 'taylor@laravel.com',\n    ],\n    [\n        'id' => 2,\n        'name' => 'Abigail, \"Abby\"',\n        'admin' => true,\n    ],\n]"
    )
  })

  it('serializes JSON keeping 64-bit integers exact', () => {
    expect(toJson(arr({ big: int('9223372036854775807'), f: float('INF'), list: arr([nul]) }))).toBe(
      '{\n  "big": 9223372036854775807,\n  "f": "INF",\n  "list": [\n    null\n  ]\n}'
    )
    expect(toJson(model('App\\User', 1, { id: int(1) }, { posts: collection(2, []) }))).toBe('{\n  "id": 1,\n  "posts": []\n}')
    const table = tabulate(rows)!
    expect(JSON.parse(rowsToJson(table.rows))).toEqual([
      { id: 1, name: 'Taylor', email: 'taylor@laravel.com' },
      { id: 2, name: 'Abigail, "Abby"', admin: true }
    ])
    expect(JSON.parse(rowsToJson([table.rows[0]]))).toEqual({ id: 1, name: 'Taylor', email: 'taylor@laravel.com' })
  })

  it('renders Markdown tables and fenced blocks', () => {
    const table = tabulate(arr([arr({ a: str('x|y'), b: str('1\n2') })]))!
    expect(toMarkdownTable(table)).toBe('| a | b |\n| --- | --- |\n| x\\|y | 1<br>2 |')
    expect(valueMarkdown(int(1))).toBe('```php\n1\n```')
    expect(valueMarkdown(rows).startsWith('| id | name | email | admin |')).toBe(true)
  })
})
