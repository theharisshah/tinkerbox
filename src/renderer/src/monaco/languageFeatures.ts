import type { editor, IDisposable, IRange, languages, Position } from 'monaco-editor/editor/editor.api'
import type { EnvironmentInfo, FunctionInfo, MemberInfo } from '@shared/types'
import { useEnvironmentStore } from '../stores/environment'
import { useTabsStore } from '../stores/tabs'
import { buildEnvIndex, classesNamed, isKnownClass, isModelClass, resolveClassName, type EnvIndex } from './envIndex'
import { computeUseInsertion, importedAs, importFor, namespaceOf, parseUseStatements, shortName, type UseStatement } from './imports'
import { LANGUAGE_ID } from './language'
import { rankNames } from './matching'
import type { Monaco } from './monaco'
import { PHP_KEYWORDS, PHP_SNIPPETS, PHP_SUPERGLOBALS } from './phpData'
import {
  collectVariables,
  completionContext,
  expressionBefore,
  findCallContext,
  parseSignature,
  qualifiedNameAt,
  splitCallee
} from './phpContext'
import { tabIdOfModel } from './registry'
import { ELOQUENT_BUILDER, ELOQUENT_COLLECTION, evalExpression, type TypeOracle, type TypeRef } from './typeInference'

/**
 * Completion, hover, signature help and the "Import class" quick fix for `tinkwell-php`, backed by the
 * environment store (introspection of the tab's connection, cached per connection) and best-effort type inference.
 */

/** How long a completion request waits for a connection's environment that is still loading. */
const ENV_WAIT_MS = 2500
const MAX_CLASS_ITEMS = 250
const MAX_FUNCTION_ITEMS = 250
const MAX_CONSTANT_ITEMS = 80

export interface FeatureContext {
  model: editor.ITextModel
  code: string
  connectionId: string | null
  env: EnvironmentInfo | null
  index: EnvIndex | null
  uses: UseStatement[]
  oracle: TypeOracle
}

function delay(ms: number): Promise<null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms))
}

function connectionOf(model: editor.ITextModel): string | null {
  const tabId = tabIdOfModel(model)
  if (!tabId) return null
  return useTabsStore().byId(tabId)?.connectionId ?? null
}

/** The connection's environment; starts loading it when needed (status shown in the footer). */
async function environmentFor(connectionId: string | null, wait: boolean): Promise<EnvironmentInfo | null> {
  const store = useEnvironmentStore()
  const env = store.get(connectionId)
  if (env) return env
  if (store.statusOf(connectionId) === 'error') return null
  const pending = store.load(connectionId)
  if (!wait) return null
  return Promise.race([pending, delay(ENV_WAIT_MS)])
}

function canIntrospect(index: EnvIndex | null, fqcn: string): boolean {
  if (!fqcn || fqcn === 'static' || fqcn === 'self' || fqcn === 'parent') return false
  return isKnownClass(index, fqcn) || isModelClass(index, fqcn) || fqcn.includes('\\') || !!index?.aliases.has(fqcn.toLowerCase())
}

async function featureContext(model: editor.ITextModel, waitForEnv: boolean): Promise<FeatureContext> {
  const connectionId = connectionOf(model)
  const env = await environmentFor(connectionId, waitForEnv)
  const index = env ? buildEnvIndex(env) : null
  const code = model.getValue()
  const uses = parseUseStatements(code)
  const store = useEnvironmentStore()
  const oracle: TypeOracle = {
    resolveClass: (name) => resolveClassName(name, index, uses),
    isModel: (fqcn) => isModelClass(index, fqcn),
    members: async (fqcn) => (canIntrospect(index, fqcn) ? store.members(connectionId, fqcn) : null),
    functionReturnType: (name) => {
      const fn = index?.functions.get(name.replace(/^\\+/, '').toLowerCase())
      return fn ? parseSignature(fn.signature).returnType : null
    },
    variableType: (name) => index?.variables.get(name) ?? null
  }
  return { model, code, connectionId, env, index, uses, oracle }
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------------------------------------------

function abbreviateParams(signature: string | undefined): string {
  const { params } = parseSignature(signature)
  const text = `(${params.join(', ')})`
  return text.length > 60 ? `${text.slice(0, 57)}…)` : text
}

function shortType(type: string | null | undefined): string {
  if (!type) return ''
  return type
    .split('|')
    .map((t) => {
      const clean = t.trim()
      const q = clean.startsWith('?') ? '?' : ''
      return q + shortName(clean.replace(/^\?/, '').replace(/<.*$/, ''))
    })
    .join('|')
}

function codeBlock(text: string): string {
  return '```php\n' + text + '\n```'
}

export function memberDeclaration(owner: string, member: MemberInfo): string {
  const cls = shortName(member.declaringClass ?? owner)
  switch (member.kind) {
    case 'method':
      return `${member.static ? 'static ' : ''}function ${cls}::${member.name}${member.signature ?? '()'}`
    case 'property':
      return `${member.static ? 'static ' : ''}${member.type ? `${member.type} ` : ''}${cls}${member.static ? '::$' : '->'}${member.name}`
    case 'constant':
      return `const ${cls}::${member.name}${member.signature ?? ''}`
    case 'case':
      return `case ${cls}::${member.name}${member.signature ?? ''}`
  }
}

function memberDocs(owner: string, member: MemberInfo): languages.CompletionItem['documentation'] {
  const parts = [codeBlock(memberDeclaration(owner, member))]
  if (member.doc) parts.push(member.doc)
  if (member.declaringClass && member.declaringClass !== owner) parts.push(`*${member.declaringClass}*`)
  return { value: parts.join('\n\n') }
}

function functionDocs(fn: FunctionInfo): languages.CompletionItem['documentation'] {
  const parts = [codeBlock(`function ${fn.name}${fn.signature}`)]
  if (fn.doc) parts.push(fn.doc)
  return { value: parts.join('\n\n') }
}

function toRange(model: editor.ITextModel, start: number, end: number): IRange {
  const s = model.getPositionAt(start)
  const e = model.getPositionAt(end)
  return { startLineNumber: s.lineNumber, startColumn: s.column, endLineNumber: e.lineNumber, endColumn: e.column }
}

// ---------------------------------------------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------------------------------------------

interface MemberListOptions {
  /** `Class::` access (static methods / properties, constants, cases) vs `$obj->` (instance members). */
  staticAccess: boolean
  /** Present static methods as instance methods too (scopes on builders). */
  includeStatic?: boolean
  /** Sort group prefix. */
  group: string
}

function memberItems(monaco: Monaco, owner: string, members: readonly MemberInfo[], range: IRange, options: MemberListOptions, seen: Set<string>): languages.CompletionItem[] {
  const { CompletionItemKind, CompletionItemInsertTextRule } = monaco.languages
  const items: languages.CompletionItem[] = []
  for (const m of members) {
    if (m.visibility !== 'public') continue
    if (m.name.startsWith('__')) continue
    if (options.staticAccess) {
      if ((m.kind === 'method' || m.kind === 'property') && !m.static) continue
    } else {
      if (m.kind === 'constant' || m.kind === 'case') continue
      if (m.static && !(options.includeStatic && m.kind === 'method')) continue
    }
    const key = `${m.kind === 'method' ? 'm' : 'p'}:${m.name.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    const forwarded = !!m.declaringClass && m.declaringClass !== owner && /^Illuminate\\Database\\/.test(m.declaringClass)
    if (m.kind === 'method') {
      const { params, returnType } = parseSignature(m.signature)
      const type = m.type ?? returnType
      items.push({
        label: { label: m.name, detail: abbreviateParams(m.signature), description: shortType(type) },
        kind: CompletionItemKind.Method,
        detail: `${shortName(m.declaringClass ?? owner)}::${m.name}${m.signature ?? '()'}`,
        documentation: memberDocs(owner, m),
        insertText: params.length ? `${m.name}($0)` : `${m.name}()`,
        insertTextRules: params.length ? CompletionItemInsertTextRule.InsertAsSnippet : undefined,
        command: params.length ? { id: 'editor.action.triggerParameterHints', title: 'Parameter hints' } : undefined,
        filterText: m.name,
        sortText: `${options.group}${forwarded ? '3' : '2'}${m.name.toLowerCase()}`,
        range
      })
    } else if (m.kind === 'property') {
      const label = options.staticAccess ? `$${m.name}` : m.name
      const column = m.doc?.startsWith('Column') ?? false
      items.push({
        label: { label, description: shortType(m.type) || (m.doc === 'Relation' ? 'relation' : '') },
        kind: column ? CompletionItemKind.Field : m.doc === 'Relation' ? CompletionItemKind.Reference : CompletionItemKind.Property,
        detail: `${shortName(m.declaringClass ?? owner)}${options.staticAccess ? '::$' : '->'}${m.name}${m.type ? `: ${m.type}` : ''}`,
        documentation: memberDocs(owner, m),
        insertText: label,
        filterText: label,
        // Instance access: columns, then other properties, then methods. Static access: static properties after methods.
        sortText: `${options.group}${options.staticAccess ? '4' : column ? '0' : '1'}${m.name.toLowerCase()}`,
        range
      })
    } else {
      items.push({
        label: { label: m.name, description: (m.signature ?? '').replace(/^\s*=\s*/, '').slice(0, 40) },
        kind: m.kind === 'case' ? CompletionItemKind.EnumMember : CompletionItemKind.Constant,
        detail: `${shortName(m.declaringClass ?? owner)}::${m.name}${m.signature ?? ''}`,
        documentation: memberDocs(owner, m),
        insertText: m.name,
        // Enum cases first; plain constants after the methods (Str:: should offer after()/camel() before INVISIBLE_…).
        sortText: `${options.group}${m.kind === 'case' ? '0' : '4'}${m.name.toLowerCase()}`,
        range
      })
    }
  }
  return items
}

async function typeMembers(monaco: Monaco, ctx: FeatureContext, type: TypeRef, range: IRange, staticAccess: boolean): Promise<languages.CompletionItem[]> {
  const store = useEnvironmentStore()
  const fetch = (fqcn: string) => (canIntrospect(ctx.index, fqcn) ? store.members(ctx.connectionId, fqcn) : Promise.resolve(null))
  const seen = new Set<string>()
  const items: languages.CompletionItem[] = []
  if (staticAccess || type.isStatic) {
    const members = await fetch(type.className)
    if (members) items.push(...memberItems(monaco, members.class, members.members, range, { staticAccess: true, group: 'a' }, seen))
    items.push({
      label: { label: 'class', description: 'string' },
      kind: monaco.languages.CompletionItemKind.Keyword,
      insertText: 'class',
      detail: `${type.className}::class`,
      sortText: 'z',
      range
    })
    return items
  }
  if (type.shape === 'builder' && type.model) {
    const [builder, model] = await Promise.all([fetch(ELOQUENT_BUILDER), fetch(type.model)])
    if (model) {
      const scopes = model.members.filter((m) => m.kind === 'method' && m.static && m.declaringClass === model.class)
      items.push(...memberItems(monaco, model.class, scopes, range, { staticAccess: false, includeStatic: true, group: 'a' }, seen))
    }
    if (builder) items.push(...memberItems(monaco, builder.class, builder.members, range, { staticAccess: false, group: 'b' }, seen))
    return items
  }
  if (type.shape === 'collection') {
    const collection = await fetch(type.className || ELOQUENT_COLLECTION)
    if (collection) items.push(...memberItems(monaco, collection.class, collection.members, range, { staticAccess: false, group: 'a' }, seen))
    return items
  }
  const members = await fetch(type.className)
  if (members) items.push(...memberItems(monaco, members.class, members.members, range, { staticAccess: false, group: 'a' }, seen))
  return items
}

interface ClassItemOptions {
  /** Insert the fully qualified name (use statements, qualified prefixes). */
  qualified: boolean
  leadingSlash: boolean
  sort: string
}

function classItem(monaco: Monaco, ctx: FeatureContext, fqcn: string, range: IRange, options: ClassItemOptions): languages.CompletionItem {
  const { CompletionItemKind } = monaco.languages
  const short = shortName(fqcn)
  const ns = namespaceOf(fqcn)
  const kind = CompletionItemKind.Class
  if (options.qualified) {
    const text = `${options.leadingSlash ? '\\' : ''}${fqcn}`
    return { label: { label: short, description: ns }, kind, detail: fqcn, insertText: text, filterText: text, sortText: `${options.sort}${short.toLowerCase()}`, range }
  }
  const aliased = !!ctx.index?.aliasTargets.has(fqcn.toLowerCase())
  const imported = importedAs(ctx.uses, fqcn)
  let insertText = imported ?? short
  let detail = fqcn
  let additionalTextEdits: languages.TextEdit[] | undefined
  if (!imported && !aliased && ns !== '') {
    if (importFor(ctx.uses, short)) {
      insertText = `\\${fqcn}`
    } else {
      const insertion = computeUseInsertion(ctx.code, fqcn)
      if (insertion) {
        additionalTextEdits = [{ range: toRange(ctx.model, insertion.offset, insertion.offset), text: insertion.text }]
        detail = `${fqcn} — adds “use ${fqcn};”`
      }
    }
  } else if (aliased && !imported) {
    detail = `${fqcn} (class alias)`
  }
  return {
    label: { label: short, description: ns },
    kind,
    detail,
    insertText,
    filterText: short,
    additionalTextEdits,
    sortText: `${options.sort}${short.toLowerCase()}`,
    range
  }
}

/** Class items for a (possibly qualified) prefix. */
function classItems(monaco: Monaco, ctx: FeatureContext, prefix: string, range: IRange, insertQualified: boolean): { items: languages.CompletionItem[]; incomplete: boolean } {
  const index = ctx.index
  if (!index) return { items: [], incomplete: true }
  const leadingSlash = prefix.startsWith('\\')
  const clean = prefix.replace(/^\\+/, '')
  const items: languages.CompletionItem[] = []
  if (clean.includes('\\') || (insertQualified && clean !== '')) {
    // Qualified prefix: match FQCNs (namespace path typed so far).
    const lower = clean.toLowerCase()
    const matches: string[] = []
    let incomplete = false
    for (const fqcn of index.classes.values()) {
      if (fqcn.toLowerCase().startsWith(lower) || (!clean.includes('\\') && shortName(fqcn).toLowerCase().startsWith(lower))) {
        if (matches.length >= MAX_CLASS_ITEMS) {
          incomplete = true
          break
        }
        matches.push(fqcn)
      }
    }
    for (const fqcn of matches) items.push(classItem(monaco, ctx, fqcn, range, { qualified: true, leadingSlash, sort: '5' }))
    return { items, incomplete }
  }
  if (clean === '') return { items: [], incomplete: true }
  const ranked = rankNames(index.shortNames, clean, MAX_CLASS_ITEMS)
  for (const short of ranked.names) {
    const fqcns = classesNamed(index, short)
    if (fqcns.length === 0) {
      const target = index.aliases.get(short.toLowerCase())
      if (target) items.push(classItem(monaco, ctx, target, range, { qualified: false, leadingSlash: false, sort: '5' }))
      continue
    }
    for (const fqcn of fqcns.slice(0, 6)) items.push(classItem(monaco, ctx, fqcn, range, { qualified: false, leadingSlash: false, sort: '5' }))
  }
  return { items, incomplete: ranked.incomplete }
}

function keywordAndSnippetItems(monaco: Monaco, range: IRange): languages.CompletionItem[] {
  const { CompletionItemKind, CompletionItemInsertTextRule } = monaco.languages
  const items: languages.CompletionItem[] = PHP_KEYWORDS.map((keyword) => ({
    label: keyword,
    kind: CompletionItemKind.Keyword,
    insertText: keyword,
    sortText: `3${keyword}`,
    range
  }))
  for (const snippet of PHP_SNIPPETS) {
    items.push({
      label: { label: snippet.label, description: 'snippet' },
      kind: CompletionItemKind.Snippet,
      detail: snippet.detail,
      documentation: { value: codeBlock(snippet.body.replace(/\$\{\d+:?([^}]*)\}/g, '$1').replace(/\$\d/g, '').replace(/\\\$/g, '$').replace(/\\\\/g, '\\')) },
      insertText: snippet.body,
      insertTextRules: CompletionItemInsertTextRule.InsertAsSnippet,
      filterText: snippet.label.split(' ')[0],
      sortText: `2${snippet.label}`,
      range
    })
  }
  return items
}

function functionItems(monaco: Monaco, ctx: FeatureContext, prefix: string, range: IRange): { items: languages.CompletionItem[]; incomplete: boolean } {
  const index = ctx.index
  if (!index || prefix === '') return { items: [], incomplete: true }
  const { CompletionItemKind, CompletionItemInsertTextRule } = monaco.languages
  const ranked = rankNames(
    [...index.functions.values()].map((f) => f.name),
    prefix,
    MAX_FUNCTION_ITEMS
  )
  const items = ranked.names.map((name): languages.CompletionItem => {
    const fn = index.functions.get(name.toLowerCase()) as FunctionInfo
    const { params, returnType } = parseSignature(fn.signature)
    return {
      label: { label: fn.name, detail: abbreviateParams(fn.signature), description: shortType(returnType) },
      kind: CompletionItemKind.Function,
      detail: `${fn.name}${fn.signature}`,
      documentation: functionDocs(fn),
      insertText: params.length ? `${fn.name}($0)` : `${fn.name}()`,
      insertTextRules: params.length ? CompletionItemInsertTextRule.InsertAsSnippet : undefined,
      command: params.length ? { id: 'editor.action.triggerParameterHints', title: 'Parameter hints' } : undefined,
      sortText: `4${fn.name.toLowerCase()}`,
      range
    }
  })
  return { items, incomplete: ranked.incomplete }
}

function constantItems(monaco: Monaco, ctx: FeatureContext, prefix: string, range: IRange): languages.CompletionItem[] {
  if (!ctx.env || prefix.length < 2) return []
  const ranked = rankNames(ctx.env.constants ?? [], prefix, MAX_CONSTANT_ITEMS)
  return ranked.names.map((name) => ({
    label: name,
    kind: monaco.languages.CompletionItemKind.Constant,
    insertText: name,
    sortText: `6${name}`,
    range
  }))
}

function variableItems(monaco: Monaco, ctx: FeatureContext, offset: number, prefix: string, range: IRange): languages.CompletionItem[] {
  const { CompletionItemKind } = monaco.languages
  const without = ctx.code.slice(0, offset - prefix.length) + ctx.code.slice(offset)
  const seen = new Set<string>()
  const items: languages.CompletionItem[] = []
  const add = (name: string, sort: string, detail?: string): void => {
    if (seen.has(name)) return
    seen.add(name)
    items.push({
      label: detail ? { label: name, description: shortType(detail) } : name,
      kind: CompletionItemKind.Variable,
      detail,
      insertText: name,
      filterText: name,
      sortText: `${sort}${name.toLowerCase()}`,
      range
    })
  }
  for (const name of collectVariables(without)) if (name !== '$this') add(name, '0')
  for (const [name, type] of ctx.index?.variables ?? []) add(name, '1', type ?? 'driver variable')
  for (const name of PHP_SUPERGLOBALS) add(name, '9')
  return items
}

/** Model of the last completion request (resolveCompletionItem does not receive it). */
let completionModel: editor.ITextModel | null = null

function completionProvider(monaco: Monaco): languages.CompletionItemProvider {
  const empty: languages.CompletionList = { suggestions: [] }
  return {
    triggerCharacters: ['$', '>', ':', '\\'],
    async provideCompletionItems(model, position, context, token) {
      completionModel = model
      const offset = model.getOffsetAt(position)
      const textBefore = model.getValue().slice(0, offset)
      const cc = completionContext(textBefore)
      if (cc.kind === 'none') return empty
      if (context.triggerKind === monaco.languages.CompletionTriggerKind.TriggerCharacter) {
        const ch = context.triggerCharacter
        if (ch === '>' && cc.kind !== 'member') return empty
        if (ch === ':' && cc.kind !== 'static') return empty
        if (ch === '$' && cc.kind !== 'variable' && cc.kind !== 'static') return empty
        if (ch === '\\' && !cc.prefix.includes('\\')) return empty
      }
      const ctx = await featureContext(model, true)
      if (token.isCancellationRequested) return empty
      const startColumn = Math.max(1, position.column - cc.prefix.length)
      const range: IRange = { startLineNumber: position.lineNumber, startColumn, endLineNumber: position.lineNumber, endColumn: position.column }
      const notReady = !ctx.env
      switch (cc.kind) {
        case 'member':
        case 'static': {
          const type = cc.receiver ? await evalExpression(cc.receiver, { code: ctx.code, offset, oracle: ctx.oracle }) : null
          if (!type || token.isCancellationRequested) return { suggestions: [], incomplete: notReady }
          const suggestions = await typeMembers(monaco, ctx, type, range, cc.kind === 'static')
          return { suggestions, incomplete: notReady }
        }
        case 'variable':
          return { suggestions: variableItems(monaco, ctx, offset, cc.prefix, range), incomplete: notReady }
        case 'new':
        case 'attribute': {
          const classes = classItems(monaco, ctx, cc.prefix, range, false)
          return { suggestions: classes.items, incomplete: classes.incomplete || notReady }
        }
        case 'use': {
          const classes = classItems(monaco, ctx, cc.prefix, range, true)
          return { suggestions: classes.items, incomplete: classes.incomplete || notReady }
        }
        case 'global': {
          const qualified = cc.prefix.includes('\\')
          const suggestions: languages.CompletionItem[] = []
          let incomplete = notReady
          if (!qualified) {
            suggestions.push(...keywordAndSnippetItems(monaco, range))
            const fns = functionItems(monaco, ctx, cc.prefix, range)
            suggestions.push(...fns.items)
            incomplete ||= fns.incomplete
            suggestions.push(...constantItems(monaco, ctx, cc.prefix, range))
          }
          const classes = classItems(monaco, ctx, cc.prefix, range, false)
          suggestions.push(...classes.items)
          incomplete ||= classes.incomplete
          return { suggestions, incomplete }
        }
      }
      return empty
    },
    async resolveCompletionItem(item, token) {
      // Variables: show the inferred type in the details panel.
      if (item.kind !== monaco.languages.CompletionItemKind.Variable || item.detail) return item
      const model = completionModel && !completionModel.isDisposed() ? completionModel : null
      const name = typeof item.label === 'string' ? item.label : item.label.label
      if (!model || token.isCancellationRequested) return item
      const ctx = await featureContext(model, false)
      const type = await evalExpression(name, { code: ctx.code, offset: ctx.code.length, oracle: ctx.oracle })
      if (type) item.detail = describeType(type)
      return item
    }
  }
}

function describeType(type: TypeRef): string {
  if (type.shape === 'builder' && type.model) return `Builder<${shortName(type.model)}>`
  if (type.shape === 'collection' && type.model) return `Collection<${shortName(type.model)}>`
  return type.className
}

// ---------------------------------------------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------------------------------------------

async function findTypeMember(ctx: FeatureContext, type: TypeRef, name: string, wantMethod: boolean): Promise<{ owner: string; member: MemberInfo } | null> {
  const store = useEnvironmentStore()
  const owners =
    type.shape === 'builder' && type.model ? [type.model, ELOQUENT_BUILDER] : type.shape === 'collection' ? [type.className || ELOQUENT_COLLECTION] : [type.className]
  const bare = name.replace(/^\$/, '').toLowerCase()
  for (const owner of owners) {
    if (!canIntrospect(ctx.index, owner)) continue
    const members = await store.members(ctx.connectionId, owner)
    const member =
      members?.members.find((m) => (wantMethod ? m.kind === 'method' : m.kind !== 'method') && m.name.toLowerCase() === bare) ??
      members?.members.find((m) => m.name.toLowerCase() === bare)
    if (members && member) return { owner: members.class, member }
  }
  return null
}

function hoverProvider(): languages.HoverProvider {
  return {
    async provideHover(model, position, token) {
      const line = model.getLineContent(position.lineNumber)
      const word = qualifiedNameAt(line, position.column - 1)
      if (!word) return null
      const range: IRange = { startLineNumber: position.lineNumber, startColumn: word.start + 1, endLineNumber: position.lineNumber, endColumn: word.end + 1 }
      const ctx = await featureContext(model, false)
      if (token.isCancellationRequested) return null
      const wordOffset = model.getOffsetAt({ lineNumber: position.lineNumber, column: word.start + 1 })
      const before = line.slice(0, word.start)
      const after = line.slice(word.end)
      const isCall = /^\s*\(/.test(after)
      const memberOp = /(\??->|::)\s*$/.exec(before)

      if (memberOp) {
        const lineStart = model.getOffsetAt({ lineNumber: position.lineNumber, column: 1 })
        const receiver = expressionBefore(ctx.code, lineStart + memberOp.index)
        if (!receiver) return null
        const type = await evalExpression(receiver, { code: ctx.code, offset: wordOffset, oracle: ctx.oracle })
        if (!type) return null
        const found = await findTypeMember(ctx, type, word.text, isCall)
        if (!found) return null
        const contents = [{ value: codeBlock(memberDeclaration(found.owner, found.member)) }]
        if (found.member.doc) contents.push({ value: found.member.doc })
        if (found.member.declaringClass && found.member.declaringClass !== found.owner) contents.push({ value: `*${found.member.declaringClass}*` })
        return { range, contents }
      }

      if (word.text.startsWith('$')) {
        const type = await evalExpression(word.text, { code: ctx.code, offset: wordOffset, oracle: ctx.oracle })
        const driver = ctx.index?.variables.get(word.text)
        if (!type && driver === undefined) return null
        const typeText = type ? describeType(type) : (driver ?? 'mixed')
        return { range, contents: [{ value: codeBlock(`${typeText} ${word.text}`) }] }
      }

      const isNew = /\bnew\s+$/.test(before)
      if (isCall && !isNew && !/^[A-Z]/.test(word.text.replace(/^\\/, '').split('\\').pop() ?? '')) {
        const fn = ctx.index?.functions.get(word.text.replace(/^\\+/, '').toLowerCase())
        if (!fn) return null
        const contents = [{ value: codeBlock(`function ${fn.name}${fn.signature}`) }]
        if (fn.doc) contents.push({ value: fn.doc })
        return { range, contents }
      }

      // Class names
      if (!/^\\?[A-Z]/.test(word.text) && !word.text.includes('\\')) return null
      if (/^[A-Z][A-Z0-9_]+$/.test(word.text) && !/^\s*::/.test(after)) return null
      const fqcn = resolveClassName(word.text, ctx.index, ctx.uses)
      const known = isKnownClass(ctx.index, fqcn) || isModelClass(ctx.index, fqcn) || !!ctx.index?.aliases.has(word.text.toLowerCase())
      if (!known) return null
      const members = canIntrospect(ctx.index, fqcn) ? await useEnvironmentStore().members(ctx.connectionId, fqcn) : null
      let declaration = `class ${members?.class ?? fqcn}`
      if (members?.parent) declaration += ` extends ${shortName(members.parent)}`
      if (members?.interfaces?.length) declaration += ` implements ${members.interfaces.slice(0, 4).map(shortName).join(', ')}${members.interfaces.length > 4 ? ', …' : ''}`
      const contents = [{ value: codeBlock(declaration) }]
      const modelInfo = ctx.index?.models.get(fqcn.toLowerCase())
      if (modelInfo) {
        const columns = modelInfo.columns.map((c) => c.name).slice(0, 12)
        contents.push({ value: `Eloquent model${modelInfo.table ? ` · table \`${modelInfo.table}\`` : ''}${columns.length ? ` · ${columns.join(', ')}${modelInfo.columns.length > 12 ? ', …' : ''}` : ''}` })
      }
      if (isNew && members) {
        const ctor = members.members.find((m) => m.kind === 'method' && m.name === '__construct')
        if (ctor) contents.push({ value: codeBlock(`new ${shortName(fqcn)}${ctor.signature ?? '()'}`) })
      }
      return { range, contents }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Signature help
// ---------------------------------------------------------------------------------------------------------------

function signatureInformation(name: string, signature: string | undefined, doc: string | undefined): languages.SignatureInformation {
  const { params, returnType } = parseSignature(signature)
  let label = `${name}(`
  const parameters: languages.ParameterInformation[] = []
  params.forEach((param, i) => {
    if (i > 0) label += ', '
    const start = label.length
    label += param
    parameters.push({ label: [start, label.length] })
  })
  label += ')'
  if (returnType) label += `: ${returnType}`
  return { label, parameters, documentation: doc ? { value: doc } : undefined }
}

function signatureHelpProvider(): languages.SignatureHelpProvider {
  return {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [')'],
    async provideSignatureHelp(model, position, token) {
      const offset = model.getOffsetAt(position)
      const textBefore = model.getValue().slice(0, offset)
      const call = findCallContext(textBefore)
      if (!call) return null
      const ctx = await featureContext(model, false)
      if (token.isCancellationRequested) return null
      let info: languages.SignatureInformation | null = null
      if (call.isNew) {
        const fqcn = resolveClassName(call.callee, ctx.index, ctx.uses)
        const members = canIntrospect(ctx.index, fqcn) ? await useEnvironmentStore().members(ctx.connectionId, fqcn) : null
        const ctor = members?.members.find((m) => m.kind === 'method' && m.name === '__construct')
        if (ctor) info = signatureInformation(`new ${shortName(fqcn)}`, ctor.signature, ctor.doc)
      } else {
        const { receiver, member, op } = splitCallee(call.callee)
        if (receiver) {
          const type = await evalExpression(receiver, { code: ctx.code, offset: call.openParen, oracle: ctx.oracle })
          if (type) {
            const found = await findTypeMember(ctx, type, member, true)
            if (found?.member.kind === 'method') info = signatureInformation(`${shortName(found.member.declaringClass ?? found.owner)}${op === '::' ? '::' : '->'}${found.member.name}`, found.member.signature, found.member.doc)
          }
        } else {
          const fn = ctx.index?.functions.get(member.replace(/^\\+/, '').toLowerCase())
          if (fn) info = signatureInformation(fn.name, fn.signature, fn.doc)
        }
      }
      if (!info || token.isCancellationRequested) return null
      const count = info.parameters.length
      let active = call.argIndex
      // Extra arguments of a variadic parameter keep it highlighted.
      if (count > 0 && active >= count && /\.\.\./.test(info.label)) active = count - 1
      return {
        value: { signatures: [info], activeSignature: 0, activeParameter: active },
        dispose: () => undefined
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Import class quick fix
// ---------------------------------------------------------------------------------------------------------------

const CLASS_POSITION_BEFORE = /(?:\bnew|\binstanceof|\bextends|\bimplements|\bcatch\s*\(|#\[|\(|,|:|\|)\s*$/

/** Code actions importing the class under the cursor (`use FQCN;`), or rewriting a qualified name to its short name. */
export function importCodeActions(ctx: FeatureContext, position: Position, uri: ReturnType<Monaco['Uri']['parse']>): languages.CodeAction[] {
  const { model } = ctx
  const line = model.getLineContent(position.lineNumber)
  const word = qualifiedNameAt(line, position.column - 1)
  if (!word || word.text.startsWith('$')) return []
  const after = line.slice(word.end)
  const before = line.slice(0, word.start)
  if (/^\s*\(/.test(after) && !/\bnew\s+$/.test(before)) return [] // function call
  if (/(->|::)\s*$/.test(before)) return [] // member name
  const name = word.text
  const versionId = model.getVersionId()
  const actions: languages.CodeAction[] = []
  const edit = (edits: Array<{ range: IRange; text: string }>): languages.WorkspaceEdit => ({
    edits: edits.map((e) => ({ resource: uri, textEdit: { range: e.range, text: e.text }, versionId }))
  })

  if (name.includes('\\')) {
    const fqcn = name.replace(/^\\+/, '')
    const short = shortName(fqcn)
    if (!/^[A-Z_\x80-￿]/i.test(short)) return []
    const existing = importFor(ctx.uses, short)
    if (existing && existing.toLowerCase() !== fqcn.toLowerCase()) return []
    const insertion = computeUseInsertion(ctx.code, fqcn)
    const wordRange: IRange = { startLineNumber: position.lineNumber, startColumn: word.start + 1, endLineNumber: position.lineNumber, endColumn: word.end + 1 }
    const edits = [{ range: wordRange, text: short }]
    if (insertion) edits.unshift({ range: toRange(model, insertion.offset, insertion.offset), text: insertion.text })
    actions.push({ title: `Import ${fqcn} and use “${short}”`, kind: 'quickfix', edit: edit(edits), isPreferred: true })
    return actions
  }

  if (!/^[A-Z]/.test(name)) return []
  if (/^[A-Z][A-Z0-9_]+$/.test(name) && !/^\s*::/.test(after)) return []
  const looksLikeClass = /^\s*::/.test(after) || /^\s+&?\$/.test(after) || CLASS_POSITION_BEFORE.test(before) || /^\s*[{;]?\s*$/.test(after)
  if (!looksLikeClass) return []
  if (importFor(ctx.uses, name)) return []
  if (new RegExp(`\\b(?:class|interface|trait|enum)\\s+${name}\\b`).test(ctx.code)) return []
  // A global class / interface of that name (`Exception`, `Stringable`, `Attribute`) is what the bare name means
  // already: importing a namespaced class would silently rebind it, so that is offered but never preferred (and the
  // title says what gets shadowed).
  const builtin = classesNamed(ctx.index, name).find((fqcn) => !fqcn.includes('\\')) ?? null
  const candidates = classesNamed(ctx.index, name)
    .filter((fqcn) => fqcn.includes('\\'))
    .slice(0, 6)
  const aliased = !!ctx.index?.aliases.has(name.toLowerCase())
  candidates.forEach((fqcn, i) => {
    const insertion = computeUseInsertion(ctx.code, fqcn)
    if (!insertion) return
    actions.push({
      title: builtin ? `Import ${fqcn} (shadows the global \\${builtin})` : `Import ${fqcn}`,
      kind: 'quickfix',
      edit: edit([{ range: toRange(model, insertion.offset, insertion.offset), text: insertion.text }]),
      isPreferred: i === 0 && !aliased && !builtin
    })
  })
  return actions
}

function codeActionProvider(): languages.CodeActionProvider {
  return {
    async provideCodeActions(model, range, _context, token) {
      const ctx = await featureContext(model, false)
      if (token.isCancellationRequested) return { actions: [], dispose: () => undefined }
      const position = { lineNumber: range.startLineNumber, column: range.startColumn } as Position
      const actions = importCodeActions(ctx, position, model.uri)
      return { actions, dispose: () => undefined }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------

let registered: IDisposable[] | null = null

/** Register the providers once (they apply to every `tinkwell-php` model). */
export function registerLanguageFeatures(monaco: Monaco): void {
  if (registered) return
  registered = [
    monaco.languages.registerCompletionItemProvider(LANGUAGE_ID, completionProvider(monaco)),
    monaco.languages.registerHoverProvider(LANGUAGE_ID, hoverProvider()),
    monaco.languages.registerSignatureHelpProvider(LANGUAGE_ID, signatureHelpProvider()),
    monaco.languages.registerCodeActionProvider(LANGUAGE_ID, codeActionProvider(), { providedCodeActionKinds: ['quickfix'] })
  ]
}
