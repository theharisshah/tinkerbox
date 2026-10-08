import { describe, expect, it } from 'vitest'
import type { ClassMembers, EnvironmentInfo, MemberInfo } from '@shared/types'
import { buildEnvIndex, resolveClassName } from '../../../src/renderer/src/monaco/envIndex'
import { parseUseStatements } from '../../../src/renderer/src/monaco/imports'
import {
  ELOQUENT_BUILDER,
  ELOQUENT_COLLECTION,
  evalExpression,
  SUPPORT_COLLECTION,
  type TypeOracle
} from '../../../src/renderer/src/monaco/typeInference'

const method = (name: string, extra: Partial<MemberInfo> = {}): MemberInfo => ({ name, kind: 'method', static: false, visibility: 'public', ...extra })

const env: EnvironmentInfo = {
  phpVersion: '8.3.12',
  driver: null,
  extensions: [],
  functions: [{ name: 'now', signature: '($tz = null): Illuminate\\Support\\Carbon' }],
  classes: [
    'App\\Models\\User',
    'App\\Models\\Post',
    'App\\Services\\Billing',
    'App\\Enums\\Status',
    'Illuminate\\Support\\Carbon',
    'Illuminate\\Support\\Str',
    'Illuminate\\Support\\Stringable',
    'Illuminate\\Foundation\\Application',
    ELOQUENT_BUILDER,
    ELOQUENT_COLLECTION,
    SUPPORT_COLLECTION
  ],
  aliases: { User: 'App\\Models\\User', Str: 'Illuminate\\Support\\Str' },
  constants: [],
  models: [
    { class: 'App\\Models\\User', table: 'users', columns: [{ name: 'id' }, { name: 'email' }], relations: ['posts'] },
    { class: 'App\\Models\\Post', table: 'posts', columns: [{ name: 'title' }] }
  ],
  variables: [{ name: '$app', type: 'Illuminate\\Foundation\\Application' }]
}

const members: Record<string, ClassMembers> = {
  'App\\Models\\User': {
    class: 'App\\Models\\User',
    interfaces: [],
    members: [
      method('active', { static: true, type: ELOQUENT_BUILDER }),
      method('posts', { type: 'Illuminate\\Database\\Eloquent\\Relations\\HasMany' }),
      method('subscription', { signature: '(): App\\Services\\Billing' })
    ]
  },
  'App\\Services\\Billing': {
    class: 'App\\Services\\Billing',
    interfaces: [],
    members: [method('charge', { signature: '(int $amount): static' }), method('owner', { type: 'App\\Models\\User' }), method('make', { static: true, type: 'static' })]
  },
  'Illuminate\\Support\\Str': { class: 'Illuminate\\Support\\Str', interfaces: [], members: [method('of', { static: true, type: 'Illuminate\\Support\\Stringable' })] },
  'Illuminate\\Support\\Stringable': { class: 'Illuminate\\Support\\Stringable', interfaces: [], members: [method('upper', { type: 'static' })] },
  'App\\Enums\\Status': { class: 'App\\Enums\\Status', interfaces: [], members: [{ name: 'Active', kind: 'case', static: true, visibility: 'public' }] },
  [SUPPORT_COLLECTION]: {
    class: SUPPORT_COLLECTION,
    interfaces: [],
    members: [
      method('make', { static: true, type: 'static<TMakeKey, TMakeValue>' }),
      method('values', { type: 'static<int, TValue>' }),
      method('map', { type: 'static<TKey, TMapValue>' }),
      method('filter', { type: 'static' })
    ]
  },
  'Illuminate\\Foundation\\Application': { class: 'Illuminate\\Foundation\\Application', interfaces: [], members: [method('version', { type: 'string' })] }
}

function oracleFor(code: string): TypeOracle {
  const index = buildEnvIndex(env)
  const uses = parseUseStatements(code)
  return {
    resolveClass: (name) => resolveClassName(name, index, uses),
    isModel: (fqcn) => index.models.has(fqcn.toLowerCase()),
    members: async (fqcn) => members[fqcn] ?? null,
    functionReturnType: (name) => (name === 'now' ? 'Illuminate\\Support\\Carbon' : null),
    variableType: (name) => index.variables.get(name) ?? null
  }
}

async function typeAt(code: string, expression: string): Promise<unknown> {
  return evalExpression(expression, { code, offset: code.length, oracle: oracleFor(code) })
}

describe('type inference', () => {
  it('infers `new` and static factories', async () => {
    expect(await typeAt('$b = new \\App\\Services\\Billing();\n', '$b')).toEqual({ className: 'App\\Services\\Billing' })
    expect(await typeAt('use App\\Services\\Billing;\n$b = Billing::make();\n', '$b')).toEqual({ className: 'App\\Services\\Billing' })
    expect(await typeAt('$u = User::find(1);\n', '$u')).toEqual({ className: 'App\\Models\\User', shape: 'model', model: 'App\\Models\\User' })
    expect(await typeAt('$u = User::create([]);\n', '$u')).toMatchObject({ shape: 'model', model: 'App\\Models\\User' })
    expect(await typeAt("$u = User::firstWhere('email', 'a');\n", '$u')).toMatchObject({ shape: 'model' })
  })

  it('infers the container: app(Foo::class), app("Foo"), driver variables, helpers', async () => {
    expect(await typeAt('$b = app(\\App\\Services\\Billing::class);\n', '$b')).toEqual({ className: 'App\\Services\\Billing' })
    expect(await typeAt("$b = resolve('App\\\\Services\\\\Billing');\n", '$b')).toEqual({ className: 'App\\Services\\Billing' })
    expect(await typeAt('', '$app')).toEqual({ className: 'Illuminate\\Foundation\\Application' })
    expect(await typeAt('$t = now();\n', '$t')).toEqual({ className: 'Illuminate\\Support\\Carbon' })
  })

  it('follows Eloquent builders, collections and scopes', async () => {
    expect(await typeAt('', "User::where('a', 1)")).toEqual({ className: ELOQUENT_BUILDER, shape: 'builder', model: 'App\\Models\\User' })
    expect(await typeAt('', "User::where('a', 1)->orderBy('id')->first()")).toMatchObject({ shape: 'model', model: 'App\\Models\\User' })
    expect(await typeAt('', 'User::active()')).toMatchObject({ shape: 'builder', model: 'App\\Models\\User' })
    expect(await typeAt('', 'User::query()->get()')).toEqual({ className: ELOQUENT_COLLECTION, shape: 'collection', model: 'App\\Models\\User' })
    expect(await typeAt('', 'User::all()->first()')).toMatchObject({ shape: 'model' })
    expect(await typeAt('', 'User::all()[0]')).toMatchObject({ shape: 'model' })
    expect(await typeAt('', 'User::first()->fresh()')).toMatchObject({ shape: 'model' })
    expect(await typeAt('foreach (User::all() as $user) {\n', '$user')).toMatchObject({ shape: 'model', model: 'App\\Models\\User' })
  })

  it('uses introspected return types (fluent and declared classes)', async () => {
    expect(await typeAt('$u = User::first();\n', '$u->subscription()')).toEqual({ className: 'App\\Services\\Billing' })
    expect(await typeAt('$u = User::first();\n', '$u->subscription()->charge(5)->owner()')).toMatchObject({ shape: 'model', model: 'App\\Models\\User' })
    expect(await typeAt('', "Str::of('x')->upper()")).toEqual({ className: 'Illuminate\\Support\\Stringable' })
    expect(await typeAt('', 'App\\Enums\\Status::Active')).toEqual({ className: 'App\\Enums\\Status' })
    expect(await typeAt('', '$app->version()')).toBeNull()
  })

  it('follows generic fluent return types (`static<int, TValue>`)', async () => {
    expect(await typeAt('', 'collect([1])->values()')).toEqual({ className: SUPPORT_COLLECTION })
    expect(await typeAt('', 'collect([1])->map(fn ($v) => $v)->values()->filter()')).toEqual({ className: SUPPORT_COLLECTION })
    expect(await typeAt('', '\\Illuminate\\Support\\Collection::make([1])->values()')).toEqual({ className: SUPPORT_COLLECTION })
    expect(await typeAt('$c = collect([1]);\n', '$c->values()')).toEqual({ className: SUPPORT_COLLECTION })
  })

  it('uses typed parameters and @var, and gives up on unknowns', async () => {
    expect(await typeAt('fn (User $u) => ', '$u')).toMatchObject({ shape: 'model' })
    expect(await typeAt('/** @var \\App\\Services\\Billing $b */\n', '$b')).toEqual({ className: 'App\\Services\\Billing' })
    expect(await typeAt('$x = 1 + 2;\n', '$x')).toBeNull()
    expect(await typeAt('', '$nope')).toBeNull()
    // self-referencing assignments terminate
    expect(await typeAt('$a = $a->foo();\n', '$a')).toBeNull()
  })
})

describe('class resolution', () => {
  const index = buildEnvIndex(env)
  it('resolves short names through imports, aliases and the class list', () => {
    const uses = parseUseStatements('use App\\Models\\Post as Article;\nuse App\\Services;')
    expect(resolveClassName('Article', index, uses)).toBe('App\\Models\\Post')
    expect(resolveClassName('Services\\Billing', index, uses)).toBe('App\\Services\\Billing')
    expect(resolveClassName('User', index)).toBe('App\\Models\\User')
    expect(resolveClassName('Billing', index)).toBe('App\\Services\\Billing')
    expect(resolveClassName('\\Foo\\Bar', index)).toBe('Foo\\Bar')
    expect(resolveClassName('Unknown', index)).toBe('Unknown')
  })

  it('indexes short names, alias targets and driver variables', () => {
    expect(index.byShort.get('user')).toEqual(['App\\Models\\User'])
    expect(index.aliasTargets.has('app\\models\\user')).toBe(true)
    expect(index.shortNames).toContain('Billing')
    expect(index.variables.get('$app')).toBe('Illuminate\\Foundation\\Application')
  })
})
