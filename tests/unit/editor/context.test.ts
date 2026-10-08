import { describe, expect, it } from 'vitest'
import {
  classFromType,
  collectVariables,
  completionContext,
  expressionBefore,
  findCallContext,
  findVariableSource,
  isSelfType,
  parseChain,
  parseSignature,
  qualifiedNameAt,
  splitCallee
} from '../../../src/renderer/src/monaco/phpContext'
import { maskPhp, scanPhp } from '../../../src/renderer/src/monaco/phpScan'

describe('scanner', () => {
  it('masks strings, comments and heredocs keeping offsets', () => {
    const code = "$a = 'x;y'; // c;\n$b = \"q{\"; /* ; */ $c;\n$h = <<<EOT\n ; {\nEOT;\n$d;"
    const masked = maskPhp(code)
    expect(masked).toHaveLength(code.length)
    expect(masked.split(';').length - 1).toBe(5)
    expect(masked).not.toContain('{')
    expect(masked).toContain('$c')
    expect(masked).toContain('$d')
  })

  it('reports where the text ends', () => {
    expect(scanPhp("$a = 'abc").state).toBe('string')
    expect(scanPhp('$a = 1; // x').state).toBe('comment')
    expect(scanPhp('$a = 1; /* x').state).toBe('comment')
    expect(scanPhp('$a = 1;').state).toBe('code')
    expect(scanPhp('#[Attr]').state).toBe('code')
  })
})

describe('completion context', () => {
  it('detects member access and its receiver', () => {
    expect(completionContext('$user->na')).toEqual({ kind: 'member', prefix: 'na', receiver: '$user' })
    expect(completionContext('$user?->')).toEqual({ kind: 'member', prefix: '', receiver: '$user' })
    expect(completionContext("User::where('a', 1)->fi")).toEqual({ kind: 'member', prefix: 'fi', receiver: "User::where('a', 1)" })
    expect(completionContext('return $order->items()->')).toMatchObject({ kind: 'member', receiver: '$order->items()' })
    expect(completionContext('(new Foo)->')).toMatchObject({ kind: 'member', receiver: '(new Foo)' })
    expect(completionContext('new Foo()->')).toMatchObject({ kind: 'member', receiver: 'new Foo()' })
    expect(completionContext('$a[0]->')).toMatchObject({ kind: 'member', receiver: '$a[0]' })
  })

  it('follows chains across lines', () => {
    const text = "User::query()\n    ->where('active', true)\n    ->"
    expect(completionContext(text)).toMatchObject({ kind: 'member', receiver: "User::query()\n    ->where('active', true)" })
  })

  it('detects static access', () => {
    expect(completionContext('User::')).toEqual({ kind: 'static', prefix: '', receiver: 'User' })
    expect(completionContext('\\App\\Models\\User::fi')).toEqual({ kind: 'static', prefix: 'fi', receiver: '\\App\\Models\\User' })
    expect(completionContext('Config::$con')).toEqual({ kind: 'static', prefix: '$con', receiver: 'Config' })
  })

  it('detects variables, new, use, attributes and globals', () => {
    expect(completionContext('echo $us')).toEqual({ kind: 'variable', prefix: '$us' })
    expect(completionContext('$')).toEqual({ kind: 'variable', prefix: '$' })
    expect(completionContext('$x = new Us')).toEqual({ kind: 'new', prefix: 'Us' })
    expect(completionContext('$x = new \\App\\Mo')).toEqual({ kind: 'new', prefix: '\\App\\Mo' })
    expect(completionContext('use App\\Models\\U')).toEqual({ kind: 'use', prefix: 'App\\Models\\U' })
    expect(completionContext('$a = 1;\nuse ')).toEqual({ kind: 'use', prefix: '' })
    expect(completionContext('#[Depr')).toEqual({ kind: 'attribute', prefix: 'Depr' })
    expect(completionContext('$x = str_rep')).toEqual({ kind: 'global', prefix: 'str_rep' })
    expect(completionContext('App\\Mod')).toEqual({ kind: 'global', prefix: 'App\\Mod' })
    expect(completionContext('')).toEqual({ kind: 'global', prefix: '' })
  })

  it('does not complete inside strings, comments or numbers', () => {
    expect(completionContext("$a = 'User::").kind).toBe('none')
    expect(completionContext('// $user->').kind).toBe('none')
    expect(completionContext('$a = 12').kind).toBe('none')
    // closure `use (` is not an import
    expect(completionContext('function () use (').kind).toBe('global')
  })
})

describe('expressions and chains', () => {
  it('finds the expression before an offset', () => {
    const code = '$x = $user->posts()->latest()'
    expect(expressionBefore(code, code.length)).toBe('$user->posts()->latest()')
    expect(expressionBefore('foo(bar($a), $b', 15)).toBe('$b')
  })

  it('parses chains', () => {
    expect(parseChain("User::where('a', 1)->first()")).toEqual({
      root: { kind: 'class', name: 'User' },
      segments: [
        { op: '::', name: 'where', call: true, args: "'a', 1" },
        { op: '->', name: 'first', call: true, args: '' }
      ]
    })
    expect(parseChain('$user->name')).toEqual({ root: { kind: 'variable', name: '$user' }, segments: [{ op: '->', name: 'name', call: false, args: '' }] })
    expect(parseChain('app(Foo::class)->bar()')?.root).toEqual({ kind: 'call', name: 'app', args: 'Foo::class' })
    expect(parseChain('new \\App\\Foo(1, 2)')?.root).toEqual({ kind: 'new', className: '\\App\\Foo' })
    expect(parseChain('(new Foo)->x')?.root).toEqual({ kind: 'group', chain: { root: { kind: 'new', className: 'Foo' }, segments: [] } })
    expect(parseChain('$items[0]->name')?.segments[0]).toEqual({ op: '[]', name: '', call: false, args: '0' })
    expect(parseChain('Foo::$instance')?.segments[0]).toMatchObject({ op: '::', name: '$instance' })
    expect(parseChain('$a +')).toBeNull()
  })
})

describe('variable sources', () => {
  it('finds the latest assignment before the cursor', () => {
    const code = '$u = new Foo();\n$u = User::first();\n$u->'
    expect(findVariableSource(code, '$u', code.length)).toEqual({ kind: 'assign', expr: 'User::first()', offset: 16 })
    expect(findVariableSource(code, '$u', 16)).toEqual({ kind: 'assign', expr: 'new Foo()', offset: 0 })
  })

  it('ignores the statement being typed, comparisons and other variables', () => {
    expect(findVariableSource('$user = $user->', '$user', 15)).toBeNull()
    expect(findVariableSource('if ($user == 1) {}', '$user')).toBeNull()
    expect(findVariableSource('$users = User::all();', '$user')).toBeNull()
    expect(findVariableSource("$s = '$user = 1;';", '$user')).toBeNull()
  })

  it('handles multi-line assignments, foreach, parameters, catch and @var', () => {
    expect(findVariableSource("$q = User::query()\n  ->where('a', 1);\n$q", '$q')).toMatchObject({ kind: 'assign', expr: "User::query()\n  ->where('a', 1)" })
    expect(findVariableSource('foreach (User::all() as $user) {\n$user', '$user')).toMatchObject({ kind: 'foreach', expr: 'User::all()' })
    expect(findVariableSource('foreach ($rows as $key => $row) { $row', '$row')).toMatchObject({ kind: 'foreach', expr: '$rows' })
    expect(findVariableSource('fn (User $u) => $u', '$u')).toMatchObject({ kind: 'type', type: 'User' })
    expect(findVariableSource('function (?\\App\\Models\\Post $post) { $post', '$post')).toMatchObject({ kind: 'type', type: 'App\\Models\\Post' })
    expect(findVariableSource('try {} catch (QueryException $e) { $e', '$e')).toMatchObject({ kind: 'type', type: 'QueryException' })
    expect(findVariableSource('/** @var \\App\\Models\\User $u */\n$u', '$u')).toMatchObject({ kind: 'type', type: 'App\\Models\\User' })
    expect(findVariableSource('function (int $n) { $n', '$n')).toBeNull()
  })

  it('collects the variables of the buffer', () => {
    expect(collectVariables("$a = 1; $b = $a + $c; // $d\n'$e'; $a")).toEqual(['$a', '$b', '$c'])
  })
})

describe('types and signatures', () => {
  it('extracts class types', () => {
    expect(classFromType('?\\App\\Models\\User')).toBe('App\\Models\\User')
    expect(classFromType('User|null')).toBe('User')
    expect(classFromType('null|Carbon')).toBe('Carbon')
    expect(classFromType('Collection<int, User>')).toBe('Collection')
    expect(classFromType('User[]')).toBeNull()
    expect(classFromType('static')).toBeNull()
    expect(classFromType('TModel|null')).toBeNull()
    expect(classFromType('int|string')).toBeNull()
    expect(classFromType('Tag')).toBe('Tag')
    expect(classFromType('static<int, TValue>')).toBeNull()
    expect(classFromType('\\Illuminate\\Support\\Collection<int, array<string, User>>|null')).toBe('Illuminate\\Support\\Collection')
    expect(classFromType('array{id: int|User}|Tag')).toBe('Tag')
    expect(classFromType('(Countable&Traversable)|null')).toBe('Countable')
  })

  it('recognises fluent self types, generic forms included', () => {
    expect(isSelfType('static')).toBe(true)
    expect(isSelfType('?static')).toBe(true)
    expect(isSelfType('$this')).toBe(true)
    expect(isSelfType('static<int, TValue>')).toBe(true)
    expect(isSelfType('static<TKey, array<int, TMapValue>>|null')).toBe(true)
    expect(isSelfType('self<TKey, TValue>')).toBe(true)
    expect(isSelfType('Collection<int, static>')).toBe(false)
    expect(isSelfType('static[]')).toBe(false)
    expect(isSelfType('TValue|null')).toBe(false)
    expect(isSelfType(null)).toBe(false)
  })

  it('parses signatures', () => {
    expect(parseSignature('(string $haystack, string $needle): bool')).toEqual({ params: ['string $haystack', 'string $needle'], returnType: 'bool' })
    expect(parseSignature("(array $columns = ['*', 'id'], $x = foo(1, 2)): ?static")).toEqual({
      params: ["array $columns = ['*', 'id']", '$x = foo(1, 2)'],
      returnType: '?static'
    })
    expect(parseSignature('()')).toEqual({ params: [], returnType: null })
    expect(parseSignature(' = 5')).toEqual({ params: [], returnType: null })
  })

  it('finds the call around the cursor', () => {
    expect(findCallContext('str_replace($a, ')).toEqual({ callee: 'str_replace', argIndex: 1, isNew: false, openParen: 11 })
    expect(findCallContext("User::where('a', foo(1), [1, 2")).toMatchObject({ callee: 'User::where', argIndex: 2 })
    expect(findCallContext('$user->update([')).toMatchObject({ callee: '$user->update', argIndex: 0 })
    expect(findCallContext('new Foo(1, ')).toMatchObject({ callee: 'Foo', argIndex: 1, isNew: true })
    expect(findCallContext('if ($a')).toBeNull()
    expect(findCallContext('foo(function () { bar')).toBeNull()
    expect(findCallContext('foo(1); bar')).toBeNull()
  })

  it('splits callees and finds names at a column', () => {
    expect(splitCallee('$user->posts()->where')).toEqual({ receiver: '$user->posts()', member: 'where', op: '->' })
    expect(splitCallee('User::find')).toEqual({ receiver: 'User', member: 'find', op: '::' })
    expect(splitCallee('strlen')).toEqual({ receiver: null, member: 'strlen', op: null })
    expect(qualifiedNameAt('$x = new \\App\\User();', 12)).toEqual({ start: 9, end: 18, text: '\\App\\User' })
    expect(qualifiedNameAt('$user->name', 2)).toEqual({ start: 0, end: 5, text: '$user' })
    expect(qualifiedNameAt('   ', 1)).toBeNull()
  })
})
