import { describe, expect, it } from 'vitest'
import {
  applyInsertion,
  computeUseInsertion,
  importedAs,
  importFor,
  namespaceOf,
  parseUseStatements,
  shortName
} from '../../../src/renderer/src/monaco/imports'

function addUse(code: string, fqcn: string): string {
  const insertion = computeUseInsertion(code, fqcn)
  return insertion ? applyInsertion(code, insertion) : code
}

describe('use statements', () => {
  it('parses simple, aliased, grouped, function and const imports', () => {
    const uses = parseUseStatements(
      'use App\\Models\\User;\nuse App\\Models\\Post as Article, \\Carbon\\Carbon;\nuse Illuminate\\Support\\{Str, Arr as A};\nuse function App\\helper;\nuse const App\\VERSION;\n$x = 1;'
    )
    expect(uses.map((u) => [u.fqcn, u.alias, u.kind])).toEqual([
      ['App\\Models\\User', 'User', 'class'],
      ['App\\Models\\Post', 'Article', 'class'],
      ['Carbon\\Carbon', 'Carbon', 'class'],
      ['Illuminate\\Support\\Str', 'Str', 'class'],
      ['Illuminate\\Support\\Arr', 'A', 'class'],
      ['App\\helper', 'helper', 'function'],
      ['App\\VERSION', 'VERSION', 'const']
    ])
    expect(importedAs(uses, '\\App\\Models\\Post')).toBe('Article')
    expect(importFor(uses, 'carbon')).toBe('Carbon\\Carbon')
  })

  it('ignores closure use, trait use and use in strings / comments', () => {
    const code = "$f = function () use ($a) {};\nclass Foo {\n    use HasFactory;\n}\n// use App\\Nope;\n$s = 'use App\\Nope2;';"
    expect(parseUseStatements(code)).toEqual([])
  })

  it('names', () => {
    expect(shortName('\\App\\Models\\User')).toBe('User')
    expect(shortName('Exception')).toBe('Exception')
    expect(namespaceOf('App\\Models\\User')).toBe('App\\Models')
    expect(namespaceOf('Exception')).toBe('')
  })
})

describe('use insertion', () => {
  it('goes after the existing imports', () => {
    expect(addUse('use App\\Models\\User;\nuse App\\Models\\Post;\n\nUser::first();', 'Illuminate\\Support\\Str')).toBe(
      'use App\\Models\\User;\nuse App\\Models\\Post;\nuse Illuminate\\Support\\Str;\n\nUser::first();'
    )
    expect(addUse('use App\\Models\\User;', 'App\\Models\\Post')).toBe('use App\\Models\\User;\nuse App\\Models\\Post;')
  })

  it('goes to the top (with a blank line) when there are no imports', () => {
    expect(addUse('User::first();', 'App\\Models\\User')).toBe('use App\\Models\\User;\n\nUser::first();')
    expect(addUse('\nUser::first();', 'App\\Models\\User')).toBe('use App\\Models\\User;\n\nUser::first();')
    expect(addUse('', 'App\\Models\\User')).toBe('use App\\Models\\User;\n')
  })

  it('goes after <?php, declare and namespace headers', () => {
    expect(addUse('<?php\nUser::first();', 'App\\Models\\User')).toBe('<?php\n\nuse App\\Models\\User;\n\nUser::first();')
    expect(addUse('<?php\n\ndeclare(strict_types=1);\n\nUser::first();', 'App\\Models\\User')).toBe(
      '<?php\n\ndeclare(strict_types=1);\n\nuse App\\Models\\User;\n\nUser::first();'
    )
    expect(addUse('<?php', 'App\\Models\\User')).toBe('<?php\n\nuse App\\Models\\User;\n')
  })

  it('does nothing when already imported or when the short name is taken', () => {
    expect(computeUseInsertion('use App\\Models\\User;\n', '\\App\\Models\\User')).toBeNull()
    expect(computeUseInsertion('use App\\Models\\User;\n', 'Other\\User')).toBeNull()
    expect(computeUseInsertion('use Illuminate\\Support\\{Str};\n', 'Illuminate\\Support\\Str')).toBeNull()
  })
})
