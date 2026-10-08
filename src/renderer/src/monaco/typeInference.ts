import type { ClassMembers, MemberInfo } from '@shared/types'
import {
  classFromType,
  findVariableSource,
  isSelfType,
  parseChain,
  parseSignature,
  type Chain,
  type ChainRoot,
  type ChainSegment
} from './phpContext'

/**
 * Best-effort static typing of receiver expressions for completion / hover / signature help:
 * `$x = new Foo`, `$x = Foo::create(...)`, `$x = app(Foo::class)`, driver variables, typed parameters, `@var`,
 * `foreach` over model collections, chains through fluent (`$this` / `static`) methods and introspected return
 * types, plus Eloquent conventions (model → builder → model / collection).
 */

export const ELOQUENT_BUILDER = 'Illuminate\\Database\\Eloquent\\Builder'
export const ELOQUENT_COLLECTION = 'Illuminate\\Database\\Eloquent\\Collection'
export const SUPPORT_COLLECTION = 'Illuminate\\Support\\Collection'

export interface TypeRef {
  /** Class of the value (FQCN when resolvable). */
  className: string
  /** True for a class reference (`Foo::`), false for instances. */
  isStatic?: boolean
  /** Eloquent shapes: a model instance, a builder for `model`, or a collection of `model`s. */
  shape?: 'model' | 'builder' | 'collection'
  model?: string
}

export interface TypeOracle {
  /** Short / aliased / imported name → FQCN (unknown names unchanged). */
  resolveClass(name: string): string
  isModel(fqcn: string): boolean
  members(fqcn: string): Promise<ClassMembers | null>
  /** Return type of a global function (`now` → `Illuminate\Support\Carbon`), or null. */
  functionReturnType(name: string): string | null
  /** Type of a driver variable (`$app`), or null. */
  variableType(name: string): string | null
}

export interface InferenceContext {
  /** Full buffer. */
  code: string
  /** Only assignments before this offset count (the cursor). */
  offset: number
  oracle: TypeOracle
}

const MAX_DEPTH = 6

const BUILDER_TO_MODEL = new Set(
  [
    'find',
    'findOrFail',
    'findOrNew',
    'findOr',
    'first',
    'firstOrFail',
    'firstOrNew',
    'firstOrCreate',
    'firstOr',
    'firstWhere',
    'create',
    'createOrFirst',
    'forceCreate',
    'make',
    'updateOrCreate',
    'sole',
    'newModelInstance'
  ].map((s) => s.toLowerCase())
)
const BUILDER_TO_COLLECTION = new Set(['get', 'all', 'findmany', 'hydrate', 'fromquery'])
const BUILDER_PREFIX = /^(where|orwhere|orderby|order|with|without|has|orhas|doesnthave|ordoesnthave|select|addselect|join|leftjoin|rightjoin|crossjoin|groupby|having|orhaving|limit|take|skip|offset|latest|oldest|inrandomorder|distinct|withtrashed|onlytrashed|withouttrashed|lock|sharedlock|forpage|when|unless|tap|query|newquery|reorder|whereHas|withcount|withsum|withavg|withmin|withmax|withexists|withaggregate|scopes|withglobalscope|withoutglobalscope|withoutglobalscopes|from|union|unionall|tobase)$/i
const BUILDER_PREFIX_LOOSE = /^(where|orWhere|orderBy|with|has|having|join|select)/

const COLLECTION_TO_MODEL = new Set(['first', 'last', 'find', 'firstwhere', 'sole', 'pop', 'shift', 'get', 'random', 'firstorfail'])
const COLLECTION_TO_SELF = new Set(
  [
    'filter',
    'where',
    'whereIn',
    'whereNotIn',
    'whereNull',
    'whereNotNull',
    'whereStrict',
    'whereBetween',
    'reject',
    'sortBy',
    'sortByDesc',
    'sort',
    'sortDesc',
    'unique',
    'uniqueStrict',
    'values',
    'reverse',
    'take',
    'skip',
    'slice',
    'each',
    'load',
    'loadMissing',
    'loadCount',
    'fresh',
    'merge',
    'diff',
    'intersect',
    'except',
    'only',
    'keyBy',
    'shuffle',
    'append',
    'makeHidden',
    'makeVisible',
    'tap',
    'when',
    'unless',
    'collect'
  ].map((s) => s.toLowerCase())
)
const MODEL_TO_SELF = new Set(
  [
    'fresh',
    'refresh',
    'replicate',
    'load',
    'loadMissing',
    'loadCount',
    'loadSum',
    'loadAvg',
    'loadMax',
    'loadMin',
    'loadMorph',
    'fill',
    'forceFill',
    'setAttribute',
    'makeHidden',
    'makeVisible',
    'append',
    'setAppends',
    'setRelation',
    'setRelations',
    'withoutRelations',
    'unsetRelation',
    'setHidden',
    'setVisible',
    'mergeCasts',
    'setConnection',
    'setTable',
    'tap'
  ].map((s) => s.toLowerCase())
)

/** Instance (or model) reference for a class. */
export function instanceOf(className: string, oracle: TypeOracle): TypeRef {
  return oracle.isModel(className) ? { className, shape: 'model', model: className } : { className }
}

function builderOf(model: string): TypeRef {
  return { className: ELOQUENT_BUILDER, shape: 'builder', model }
}

function collectionOf(model: string): TypeRef {
  return { className: ELOQUENT_COLLECTION, shape: 'collection', model }
}

function findMember(members: ClassMembers | null, name: string, wantMethod: boolean): MemberInfo | undefined {
  if (!members) return undefined
  const bare = name.replace(/^\$/, '')
  const lower = bare.toLowerCase()
  return (
    members.members.find((m) => (wantMethod ? m.kind === 'method' && m.name.toLowerCase() === lower : m.kind !== 'method' && m.name === bare)) ??
    members.members.find((m) => m.name.toLowerCase() === lower)
  )
}

/** Return / value type of a member (MemberInfo.type, else the signature's return type). */
export function memberType(member: MemberInfo): string | null {
  if (member.type) return member.type
  if (member.kind === 'method') return parseSignature(member.signature).returnType
  return null
}

async function eloquentStep(t: TypeRef, seg: ChainSegment, oracle: TypeOracle): Promise<TypeRef | null | undefined> {
  const name = seg.name.toLowerCase()
  const model = t.model ?? (t.isStatic && oracle.isModel(t.className) ? t.className : undefined)
  if (!model || !seg.call) return undefined
  if (t.isStatic || t.shape === 'builder') {
    if (BUILDER_TO_MODEL.has(name)) return instanceOf(model, oracle)
    if (BUILDER_TO_COLLECTION.has(name) && (t.isStatic || name !== 'all')) return collectionOf(model)
    if (BUILDER_PREFIX.test(name) || BUILDER_PREFIX_LOOSE.test(seg.name)) return builderOf(model)
    // local scopes are static members typed as the Eloquent builder
    const members = await oracle.members(model)
    const scope = findMember(members, seg.name, true)
    if (scope && classFromType(memberType(scope)) === ELOQUENT_BUILDER) return builderOf(model)
    return undefined
  }
  if (t.shape === 'collection') {
    if (COLLECTION_TO_MODEL.has(name)) return instanceOf(model, oracle)
    if (COLLECTION_TO_SELF.has(name)) return t
    return undefined
  }
  if (t.shape === 'model') {
    if (MODEL_TO_SELF.has(name)) return t
    if (name === 'newquery' || name === 'query') return builderOf(model)
  }
  return undefined
}

async function step(t: TypeRef, seg: ChainSegment, ctx: InferenceContext): Promise<TypeRef | null> {
  const { oracle } = ctx
  if (seg.op === '[]') {
    return t.shape === 'collection' && t.model ? instanceOf(t.model, oracle) : null
  }
  const eloquent = await eloquentStep(t, seg, oracle)
  if (eloquent !== undefined) return eloquent

  const members = await oracle.members(t.className)
  const member = findMember(members, seg.name, seg.call)
  if (!member) return null
  if (member.kind === 'case') return instanceOf(t.className, oracle)
  const type = memberType(member)
  if (isSelfType(type)) return t.isStatic ? instanceOf(t.className, oracle) : t
  const cls = classFromType(type)
  if (!cls) return null
  const fqcn = oracle.resolveClass(cls)
  if (fqcn === ELOQUENT_BUILDER && (t.model || (t.isStatic && oracle.isModel(t.className)))) return builderOf(t.model ?? t.className)
  if (fqcn === ELOQUENT_COLLECTION && t.model) return collectionOf(t.model)
  return instanceOf(fqcn, oracle)
}

/** First argument of `app(Foo::class)` / `app('Foo')` / `resolve(…)` as a class name. */
function classArgument(args: string): string | null {
  const first = args.split(',')[0]?.trim() ?? ''
  let m = /^\\?([\w\\]+)::class$/i.exec(first)
  if (m) return m[1]
  m = /^(['"])\\*([\w\\]+)\1$/.exec(first)
  if (m) {
    // 'App\\Models\\User' in PHP source is App\Models\User
    const name = m[2].replace(/\\+/g, '\\')
    if (/^[A-Z]/.test(name.split('\\').pop() ?? '')) return name
  }
  return null
}

const FUNCTION_TYPES: Record<string, string> = {
  collect: SUPPORT_COLLECTION,
  now: 'Illuminate\\Support\\Carbon',
  today: 'Illuminate\\Support\\Carbon',
  request: 'Illuminate\\Http\\Request',
  str: 'Illuminate\\Support\\Stringable',
  response: 'Illuminate\\Http\\Response',
  cache: 'Illuminate\\Cache\\CacheManager',
  config: 'Illuminate\\Config\\Repository',
  auth: 'Illuminate\\Auth\\AuthManager',
  session: 'Illuminate\\Session\\SessionManager',
  app: 'Illuminate\\Foundation\\Application'
}

async function evalRoot(root: ChainRoot, ctx: InferenceContext, depth: number): Promise<TypeRef | null> {
  const { oracle } = ctx
  switch (root.kind) {
    case 'group':
      return evalChain(root.chain, ctx, depth + 1)
    case 'new':
      return instanceOf(oracle.resolveClass(root.className), oracle)
    case 'class': {
      const lower = root.name.toLowerCase()
      if (lower === 'static' || lower === 'self' || lower === 'parent') return null
      return { className: oracle.resolveClass(root.name), isStatic: true }
    }
    case 'call': {
      const name = root.name.replace(/^\\+/, '')
      const lower = name.toLowerCase()
      if (lower === 'app' || lower === 'resolve' || lower === 'make') {
        const cls = classArgument(root.args)
        if (cls) return instanceOf(oracle.resolveClass(cls), oracle)
      }
      if (lower === 'tap' || lower === 'with') {
        const first = root.args.split(',')[0]?.trim()
        if (first) return evalExpression(first, ctx, depth + 1)
      }
      const declared = classFromType(oracle.functionReturnType(name))
      if (declared) return instanceOf(oracle.resolveClass(declared), oracle)
      const known = FUNCTION_TYPES[lower]
      if (known && (lower !== 'app' || root.args.trim() === '')) return instanceOf(known, oracle)
      return null
    }
    case 'variable': {
      if (root.name === '$this') return null
      const source = findVariableSource(ctx.code, root.name, ctx.offset)
      if (source) {
        const inner: InferenceContext = { ...ctx, offset: source.offset }
        if (source.kind === 'type') return instanceOf(oracle.resolveClass(source.type), oracle)
        if (source.kind === 'assign') {
          const t = await evalExpression(source.expr, inner, depth + 1)
          if (t) return t
        }
        if (source.kind === 'foreach') {
          const t = await evalExpression(source.expr, inner, depth + 1)
          if (t?.shape === 'collection' && t.model) return instanceOf(t.model, oracle)
          return null
        }
      }
      const driver = classFromType(oracle.variableType(root.name))
      return driver ? instanceOf(oracle.resolveClass(driver), oracle) : null
    }
  }
}

export async function evalChain(chain: Chain, ctx: InferenceContext, depth = 0): Promise<TypeRef | null> {
  if (depth > MAX_DEPTH) return null
  let t = await evalRoot(chain.root, ctx, depth)
  for (const seg of chain.segments) {
    if (!t) return null
    t = await step(t, seg, ctx)
  }
  return t
}

/** Type of an expression (`$user`, `User::where(…)->first()`, `new Foo`, …), or null when unknown. */
export async function evalExpression(expression: string, ctx: InferenceContext, depth = 0): Promise<TypeRef | null> {
  if (depth > MAX_DEPTH) return null
  const chain = parseChain(expression)
  if (!chain) return null
  try {
    return await evalChain(chain, ctx, depth)
  } catch {
    return null
  }
}
