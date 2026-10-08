import type { EnvironmentInfo, FunctionInfo, ModelInfo } from '@shared/types'
import { importFor, shortName, type UseStatement } from './imports'

/**
 * Lookup tables derived from an EnvironmentInfo (introspection of a connection), built once per environment object.
 */
export interface EnvIndex {
  env: EnvironmentInfo
  /** lower-case short name → FQCNs */
  byShort: Map<string, string[]>
  /** lower-case FQCN → FQCN */
  classes: Map<string, string>
  /** lower-case alias → FQCN (Tinker-style class aliasing) */
  aliases: Map<string, string>
  /** lower-case FQCNs reachable through an alias (usable by short name without an import) */
  aliasTargets: Set<string>
  /** Unique short names (original case) of all classes and aliases, for completion ranking. */
  shortNames: string[]
  /** lower-case model FQCN → model */
  models: Map<string, ModelInfo>
  /** lower-case function name → function */
  functions: Map<string, FunctionInfo>
  /** `$name` → type (driver variables) */
  variables: Map<string, string | undefined>
}

const cache = new WeakMap<EnvironmentInfo, EnvIndex>()

/** Conventional namespaces preferred when a short name is ambiguous. */
const PREFERRED_PREFIXES = ['App\\Models\\', 'App\\', 'Illuminate\\Support\\Facades\\', 'Illuminate\\Support\\', 'Illuminate\\']

export function buildEnvIndex(env: EnvironmentInfo): EnvIndex {
  const cached = cache.get(env)
  if (cached) return cached
  const byShort = new Map<string, string[]>()
  const classes = new Map<string, string>()
  for (const raw of env.classes ?? []) {
    const fqcn = raw.replace(/^\\+/, '')
    classes.set(fqcn.toLowerCase(), fqcn)
    const key = shortName(fqcn).toLowerCase()
    const list = byShort.get(key)
    if (list) list.push(fqcn)
    else byShort.set(key, [fqcn])
  }
  for (const list of byShort.values()) list.sort(compareCandidates)
  const aliases = new Map<string, string>()
  const aliasTargets = new Set<string>()
  const shorts = new Map<string, string>()
  for (const list of byShort.values()) {
    const short = shortName(list[0])
    shorts.set(short.toLowerCase(), short)
  }
  for (const [alias, target] of Object.entries(env.aliases ?? {})) {
    const fqcn = target.replace(/^\\+/, '')
    aliases.set(alias.toLowerCase(), fqcn)
    if (shortName(fqcn).toLowerCase() === alias.toLowerCase()) aliasTargets.add(fqcn.toLowerCase())
    if (!shorts.has(alias.toLowerCase())) shorts.set(alias.toLowerCase(), alias)
  }
  const models = new Map<string, ModelInfo>()
  for (const model of env.models ?? []) models.set(model.class.replace(/^\\+/, '').toLowerCase(), model)
  const functions = new Map<string, FunctionInfo>()
  for (const fn of env.functions ?? []) functions.set(fn.name.toLowerCase(), fn)
  const variables = new Map<string, string | undefined>()
  for (const v of env.variables ?? []) variables.set(v.name.startsWith('$') ? v.name : `$${v.name}`, v.type)
  const index: EnvIndex = { env, byShort, classes, aliases, aliasTargets, shortNames: [...shorts.values()], models, functions, variables }
  cache.set(env, index)
  return index
}

function prefixRank(fqcn: string): number {
  const i = PREFERRED_PREFIXES.findIndex((p) => fqcn.startsWith(p))
  return i < 0 ? PREFERRED_PREFIXES.length : i
}

/** Sort candidates: conventional namespaces first, then shallower namespaces, then alphabetical. */
export function compareCandidates(a: string, b: string): number {
  return (
    prefixRank(a) - prefixRank(b) ||
    a.split('\\').length - b.split('\\').length ||
    a.localeCompare(b)
  )
}

/** FQCNs whose short name is `name` (case-insensitive), best candidate first. */
export function classesNamed(index: EnvIndex | null, name: string): string[] {
  if (!index) return []
  return index.byShort.get(name.toLowerCase()) ?? []
}

export function isKnownClass(index: EnvIndex | null, fqcn: string): boolean {
  return !!index && index.classes.has(fqcn.replace(/^\\+/, '').toLowerCase())
}

export function isModelClass(index: EnvIndex | null, fqcn: string): boolean {
  return !!index && index.models.has(fqcn.replace(/^\\+/, '').toLowerCase())
}

/**
 * Resolve a class name as written in the code to a FQCN: `\A\B` → `A\B`; imports (`use`) and their namespace
 * prefixes; Tinker-style aliases; a unique / preferred short-name match. Unknown names come back unchanged.
 */
export function resolveClassName(name: string, index: EnvIndex | null, uses: readonly UseStatement[] = []): string {
  const raw = name.trim()
  if (raw.startsWith('\\')) return raw.replace(/^\\+/, '')
  const lower = raw.toLowerCase()
  if (lower === 'static' || lower === 'self' || lower === 'parent') return raw
  const slash = raw.indexOf('\\')
  if (slash > 0) {
    // `Models\User` with `use App\Models;`
    const head = raw.slice(0, slash)
    const imported = importFor(uses, head)
    if (imported) return `${imported}\\${raw.slice(slash + 1)}`
    const known = index?.classes.get(lower)
    return known ?? raw
  }
  const imported = importFor(uses, raw)
  if (imported) return imported
  const known = index?.classes.get(lower)
  if (known) return known
  const alias = index?.aliases.get(lower)
  if (alias) return index?.classes.get(alias.toLowerCase()) ?? alias
  const candidates = classesNamed(index, raw)
  return candidates[0] ?? raw
}
