import { describe, expect, it } from 'vitest'
import type { DumpNode } from '@shared/types'
import { dumpToCli, exceptionCli, resultToCli, returnValueCli } from '@/components/output/lib/cliFormat'
import { resultToText, runStopNote } from '@/utils/dumpText'
import { arr, bool, collection, float, int, model, nul, result, str } from './fixtures'

describe('dumpToCli (PsySH style)', () => {
  it('formats scalars', () => {
    expect(dumpToCli(nul)).toBe('null')
    expect(dumpToCli(bool(true))).toBe('true')
    expect(dumpToCli(int('9223372036854775807'))).toBe('9223372036854775807')
    expect(dumpToCli(float('1.5'))).toBe('1.5')
    expect(dumpToCli(str('hello'))).toBe('"hello"')
    expect(dumpToCli(null)).toBe('null')
  })

  it('escapes control characters and marks truncated / binary strings', () => {
    expect(dumpToCli(str('a\tb'))).toBe('"a\\tb"')
    expect(dumpToCli(str('abc', { len: 100, truncated: true }))).toBe('"abc"…')
    expect(dumpToCli(str('\\x00\\xFF', { binary: true }))).toBe('b"\\x00\\xFF"')
  })

  it('prints multi-line strings as indented blocks', () => {
    expect(dumpToCli(str('one\ntwo'))).toBe('"""\n  one\n  two\n  """')
    expect(dumpToCli(arr({ text: str('a\nb') }))).toBe('[\n  "text" => """\n    a\n    b\n    """,\n]')
  })

  it('prints the collection example exactly', () => {
    expect(dumpToCli(collection(1259, [int(1)]))).toBe('Illuminate\\Support\\Collection {#1259\n  all: [\n    1,\n  ],\n}')
  })

  it('prints lists without keys and maps with keys', () => {
    expect(dumpToCli(arr([int(1), int(2)]))).toBe('[\n  1,\n  2,\n]')
    expect(dumpToCli(arr({ name: str('Taylor'), 5: int(5) }))).toBe('[\n  "5" => 5,\n  "name" => "Taylor",\n]')
    expect(dumpToCli({ t: 'array', count: 2, items: [{ k: 3, v: int(1) }, { k: 'a', v: nul }] })).toBe('[\n  3 => 1,\n  "a" => null,\n]')
    expect(dumpToCli(arr([]))).toBe('[]')
  })

  it('notes truncated containers', () => {
    const node: DumpNode = { t: 'array', count: 10, items: [{ k: 0, v: int(1) }], truncated: true }
    expect(dumpToCli(node)).toBe('[\n  1,\n  // … 9 more\n]')
  })

  it('prints objects with visibility prefixes', () => {
    const node: DumpNode = {
      t: 'object',
      class: 'App\\Foo',
      id: 7,
      props: [
        { name: 'x', vis: 'public', v: int(1) },
        { name: 'y', vis: 'protected', v: str('two') },
        { name: 'z', vis: 'private', v: arr([int(1)]) },
        { name: 'dyn', vis: 'dynamic', v: nul }
      ]
    }
    expect(dumpToCli(node)).toBe('App\\Foo {#7\n  +x: 1,\n  #y: "two",\n  -z: [\n    1,\n  ],\n  +"dyn": null,\n}')
    expect(dumpToCli({ t: 'object', class: 'Empty', id: 1, props: [] })).toBe('Empty {#1}')
  })

  it('prints models with attributes and relations, without meta', () => {
    const user = model('App\\Models\\User', 12, { id: int(1), name: str('Taylor') }, { posts: collection(13, []) })
    expect(dumpToCli(user)).toBe(
      'App\\Models\\User {#12\n  id: 1,\n  name: "Taylor",\n  posts: Illuminate\\Support\\Collection {#13\n    all: [],\n  },\n}'
    )
  })

  it('prints Carbon, stringables, enums, closures, refs and depth markers', () => {
    const date: DumpNode = {
      t: 'object',
      class: 'Carbon\\Carbon',
      id: 3,
      kind: 'datetime',
      summary: '2024-01-01 00:00:00.000000 UTC (+00:00)',
      props: [
        { name: 'timezone', vis: 'meta', v: str('UTC') },
        { name: 'timestamp', vis: 'meta', v: int(1704067200) }
      ]
    }
    expect(dumpToCli(date)).toBe('Carbon\\Carbon @1704067200 {#3\n  date: 2024-01-01 00:00:00.000000 UTC (+00:00),\n}')
    expect(dumpToCli({ t: 'object', class: 'Illuminate\\Support\\Stringable', id: 4, kind: 'stringable', summary: 'foo', props: [] })).toBe(
      'Illuminate\\Support\\Stringable {#4\n  value: "foo",\n}'
    )
    expect(dumpToCli({ t: 'enum', class: 'App\\Status', case: 'Active', value: 'active' })).toBe('App\\Status::Active')
    expect(dumpToCli({ t: 'closure', signature: 'fn (int $x): int', line: 2 })).toBe('Closure fn (int $x): int // line 2')
    expect(dumpToCli({ t: 'closure', signature: 'function ()', file: 'app/a.php', line: 9 })).toBe('Closure function () // app/a.php:9')
    expect(dumpToCli({ t: 'ref', class: 'stdClass', id: 5 })).toBe('stdClass {#5 …}')
    expect(dumpToCli({ t: 'resource', type: 'stream', id: 8 })).toBe('stream resource @8')
    expect(dumpToCli({ t: 'max-depth', type: 'object', class: 'App\\Foo' })).toBe('App\\Foo {#…}')
    expect(dumpToCli({ t: 'max-depth', type: 'array', count: 3 })).toBe('[ …3]')
  })

  it('aligns multi-line return values after "= "', () => {
    expect(returnValueCli(collection(1, [int(1)]))).toBe('= Illuminate\\Support\\Collection {#1\n    all: [\n      1,\n    ],\n  }')
    expect(returnValueCli(int(42))).toBe('= 42')
  })
})

describe('resultToCli', () => {
  it('renders echo, dumps, queries and the return value in order', () => {
    const text = resultToCli(
      result({
        events: [
          { seq: 1, kind: 'echo', text: 'Hello', line: 1 },
          { seq: 2, kind: 'dump', value: int(1), line: 2, userCode: true },
          { seq: 3, kind: 'query', sql: 'select * from `users` where `id` = ?', bindings: ['1'], rawSql: 'select * from `users` where `id` = 1', timeMs: 1.234, connection: 'mysql', line: 3 },
          { seq: 4, kind: 'dump', value: str('x'), file: 'app/Models/User.php', line: 40, userCode: false }
        ],
        hasReturnValue: true,
        returnValue: arr([int(1)])
      }),
      { showQueries: true }
    )
    expect(text).toBe(
      'Hello\n1\nselect * from `users` where `id` = 1; -- 1.23ms (mysql)\n// app/Models/User.php:40\n"x"\n= [\n    1,\n  ]\n'
    )
  })

  it('hides queries when the SQL toggle is off', () => {
    const text = resultToCli(
      result({ events: [{ seq: 1, kind: 'query', sql: 'select 1', bindings: [], rawSql: 'select 1', timeMs: 1, connection: 'sqlite' }] })
    )
    expect(text).toBe('')
  })

  it('prints exceptions like PsySH and skips the return value', () => {
    const text = resultToCli(
      result({
        ok: false,
        hasReturnValue: true,
        returnValue: int(1),
        exception: { class: 'RuntimeException', message: 'Boom!', code: '0', file: '', line: 2, userLine: 2, trace: [] }
      })
    )
    expect(text).toBe('   RuntimeException  Boom! on line 2.\n')
    expect(exceptionCli({ class: 'Exception', message: 'Nope', code: '0', file: 'app/Foo.php', line: 12, trace: [] })).toBe('   Exception  Nope in app/Foo.php:12.')
  })

  it('reports diagnostics, transport errors and cancellation', () => {
    const text = resultToCli(
      result({
        diagnostics: [{ level: 'Warning', message: 'Undefined variable $x', file: '', line: 3, userLine: 3 }],
        error: 'Could not start PHP',
        cancelled: true
      })
    )
    expect(text).toBe('   WARNING  Undefined variable $x on line 3.\n   ERROR  Could not start PHP\n   INFO  Execution cancelled.\n')
  })

  it('does not repeat the stop note that main also puts into `error`', () => {
    expect(resultToCli(result({ error: 'Execution cancelled.', cancelled: true }))).toBe('   INFO  Execution cancelled.\n')
    const timeout = 'Execution timed out after 1.5s. Increase the timeout in Settings → Output if the script needs more time.'
    expect(resultToCli(result({ error: timeout, timedOut: true }))).toBe(`   INFO  ${timeout}\n`)
    expect(resultToText(result({ error: 'Execution cancelled.', cancelled: true }))).toBe('Execution cancelled.\n')
    expect(runStopNote({ cancelled: false, timedOut: true, error: null })).toBe('Execution timed out.')
    expect(runStopNote({ cancelled: false, timedOut: false, error: 'boom' })).toBeNull()
  })

  it('keeps raw stdout first and separates blocks with newlines', () => {
    const text = resultToCli(result({ rawOutput: 'booting', hasReturnValue: true, returnValue: nul }))
    expect(text).toBe('booting\n= null\n')
  })
})
