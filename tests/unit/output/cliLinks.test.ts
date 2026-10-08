import { describe, expect, it } from 'vitest'
import { findCliLinks } from '@/components/output/lib/cliLinks'

function texts(line: string): Array<[string, unknown]> {
  return findCliLinks(line).map((l) => [line.slice(l.start, l.end), l.target])
}

describe('findCliLinks', () => {
  it('finds project and absolute file paths with lines', () => {
    expect(texts('   Exception  Nope in vendor/laravel/framework/src/Foo.php:822.')).toEqual([
      ['vendor/laravel/framework/src/Foo.php:822', { kind: 'file', file: 'vendor/laravel/framework/src/Foo.php', line: 822 }]
    ])
    expect(texts('// /Users/me/app/Models/User.php:40')).toEqual([
      ['/Users/me/app/Models/User.php:40', { kind: 'file', file: '/Users/me/app/Models/User.php', line: 40 }]
    ])
    expect(texts('see resources/views/welcome.blade.php')).toEqual([
      ['resources/views/welcome.blade.php', { kind: 'file', file: 'resources/views/welcome.blade.php', line: undefined }]
    ])
  })

  it('finds editor line references', () => {
    expect(texts('   RuntimeException  Boom! on line 2.')).toEqual([['on line 2', { kind: 'line', line: 2 }]])
    expect(texts('Closure fn () // line 7')).toEqual([['line 7', { kind: 'line', line: 7 }]])
  })

  it('finds URLs without trailing punctuation and does not double-link them', () => {
    expect(texts('Docs: https://laravel.com/docs/12.x/eloquent.')).toEqual([
      ['https://laravel.com/docs/12.x/eloquent', { kind: 'url', url: 'https://laravel.com/docs/12.x/eloquent' }]
    ])
    expect(texts('https://example.com/a/b.php')).toHaveLength(1)
  })

  it('ignores plain words and bare file names', () => {
    expect(findCliLinks('"Taylor", 42, App\\Models\\User {#12')).toEqual([])
    expect(findCliLinks('composer.json')).toEqual([])
  })
})
