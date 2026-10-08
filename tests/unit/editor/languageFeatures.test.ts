import { describe, expect, it } from 'vitest'
import type { editor, Position } from 'monaco-editor/editor/editor.api'
import type { EnvironmentInfo, MemberInfo } from '@shared/types'
import { buildEnvIndex, resolveClassName } from '../../../src/renderer/src/monaco/envIndex'
import { parseUseStatements } from '../../../src/renderer/src/monaco/imports'
import { importCodeActions, memberDeclaration, type FeatureContext } from '../../../src/renderer/src/monaco/languageFeatures'

const env: EnvironmentInfo = {
  phpVersion: '8.3.12',
  driver: null,
  extensions: [],
  functions: [],
  classes: [
    'Exception',
    'Stringable',
    'Attribute',
    'Illuminate\\Support\\Stringable',
    'Illuminate\\Database\\Eloquent\\Casts\\Attribute',
    'Illuminate\\Foundation\\Exceptions\\Renderer\\Exception',
    'Mockery\\Exception',
    'Illuminate\\Support\\Carbon',
    'Carbon\\Carbon',
    'App\\Models\\User'
  ],
  aliases: { User: 'App\\Models\\User' },
  constants: [],
  models: [],
  variables: []
}

/** Just enough of an ITextModel for the code actions (single-buffer offsets → positions). */
function fakeModel(code: string): editor.ITextModel {
  const lines = code.split('\n')
  return {
    getLineContent: (n: number) => lines[n - 1] ?? '',
    getVersionId: () => 1,
    getValue: () => code,
    getPositionAt: (offset: number) => {
      const before = code.slice(0, offset).split('\n')
      return { lineNumber: before.length, column: before[before.length - 1].length + 1 }
    }
  } as unknown as editor.ITextModel
}

function actionsAt(code: string, needle: string): Array<{ title: string; isPreferred?: boolean }> {
  const model = fakeModel(code)
  const index = buildEnvIndex(env)
  const uses = parseUseStatements(code)
  const ctx = {
    model,
    code,
    connectionId: null,
    env,
    index,
    uses,
    oracle: {
      resolveClass: (name: string) => resolveClassName(name, index, uses),
      isModel: () => false,
      members: async () => null,
      functionReturnType: () => null,
      variableType: () => null
    }
  } satisfies FeatureContext
  const offset = code.indexOf(needle) + 1
  const position = model.getPositionAt(offset) as Position
  const uri = { toString: () => 'tinkwell:/t.php' } as unknown as Parameters<typeof importCodeActions>[2]
  return importCodeActions(ctx, position, uri).map((a) => ({ title: a.title, isPreferred: a.isPreferred }))
}

describe('import class quick fix', () => {
  it('prefers the best namespaced candidate for an unknown short name', () => {
    expect(actionsAt('$d = Carbon::now();', 'Carbon')).toEqual([
      { title: 'Import Illuminate\\Support\\Carbon', isPreferred: true },
      { title: 'Import Carbon\\Carbon', isPreferred: false }
    ])
  })

  it('never prefers shadowing a global PHP class or interface', () => {
    expect(actionsAt('$s = Stringable::class;', 'Stringable')).toEqual([
      { title: 'Import Illuminate\\Support\\Stringable (shadows the global \\Stringable)', isPreferred: false }
    ])
    const exception = actionsAt("throw new Exception('x');", 'Exception')
    expect(exception.length).toBeGreaterThan(0)
    expect(exception.every((a) => !a.isPreferred && a.title.endsWith('(shadows the global \\Exception)'))).toBe(true)
    expect(actionsAt('#[Attribute]\nclass Foo {}', 'Attribute').every((a) => !a.isPreferred)).toBe(true)
  })
})

describe('hover declarations', () => {
  const property = (extra: Partial<MemberInfo>): MemberInfo => ({ name: 'email', kind: 'property', static: false, visibility: 'public', ...extra })

  it('renders instance properties with -> and static ones with ::$', () => {
    expect(memberDeclaration('App\\Models\\User', property({ type: 'varchar' }))).toBe('varchar User->email')
    expect(memberDeclaration('App\\Models\\User', property({ name: 'notifications' }))).toBe('User->notifications')
    expect(memberDeclaration('App\\Models\\User', property({ name: 'snakeAttributes', static: true, type: 'bool' }))).toBe('static bool User::$snakeAttributes')
  })
})
