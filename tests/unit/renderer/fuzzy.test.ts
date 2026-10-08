import { describe, expect, it } from 'vitest'
import { fuzzyFilter, fuzzyMatch, highlightSegments } from '@/utils/fuzzy'

describe('fuzzyMatch', () => {
  it('matches everything with an empty query', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, indices: [] })
    expect(fuzzyMatch('   ', 'anything')).toEqual({ score: 0, indices: [] })
  })

  it('returns substring indices', () => {
    const m = fuzzyMatch('code', 'Run Code')
    expect(m).not.toBeNull()
    expect(m!.indices).toEqual([4, 5, 6, 7])
  })

  it('matches subsequences at word starts', () => {
    const m = fuzzyMatch('rncd', 'Run Code')
    expect(m).not.toBeNull()
    expect(m!.indices).toEqual([0, 2, 4, 6])
  })

  it('tolerates typos (deletion, transposition, substitution)', () => {
    expect(fuzzyMatch('snipets', 'Toggle Snippets')).not.toBeNull()
    expect(fuzzyMatch('histroy', 'Toggle History')).not.toBeNull()
    expect(fuzzyMatch('prettfy', 'Prettify Code')).not.toBeNull()
  })

  it('rejects unrelated text and short typos', () => {
    expect(fuzzyMatch('xyz', 'Run Code')).toBeNull()
    expect(fuzzyMatch('qz', 'Run Code')).toBeNull()
    expect(fuzzyMatch('zzzzzz', 'Snippets')).toBeNull()
  })

  it('requires every token to match', () => {
    expect(fuzzyMatch('tog out', 'Toggle Editor Output')).not.toBeNull()
    expect(fuzzyMatch('tog zebra', 'Toggle Editor Output')).toBeNull()
  })

  it('handles non-string input defensively', () => {
    expect(fuzzyMatch('a', '')).toBeNull()
    expect(fuzzyMatch('a', undefined as unknown as string)).toBeNull()
  })
})

describe('fuzzyFilter', () => {
  const commands = ['Toggle Editor Output', 'Output: CLI Mode', 'Run Code', 'Open Anything', 'Copy Result', 'Run Selected Code']

  it('keeps input order for an empty query', () => {
    expect(fuzzyFilter(commands, '', (c) => c).map((r) => r.item)).toEqual(commands)
  })

  it('ranks prefix matches above inner and fuzzy matches', () => {
    const ranked = fuzzyFilter(commands, 'out', (c) => c).map((r) => r.item)
    expect(ranked[0]).toBe('Output: CLI Mode')
    expect(ranked).toContain('Toggle Editor Output')
    expect(ranked).not.toContain('Run Code')
  })

  it('ranks exact substring above subsequence', () => {
    const ranked = fuzzyFilter(['Rename Tab', 'Run Code'], 'run', (c) => c).map((r) => r.item)
    expect(ranked[0]).toBe('Run Code')
  })

  it('uses secondary keys with a lower weight and reports the key index', () => {
    const items = [
      { title: 'Alpha', description: 'mentions laravel' },
      { title: 'Laravel Sandbox', description: '' }
    ]
    const results = fuzzyFilter(items, 'laravel', (i) => [i.title, i.description])
    expect(results.map((r) => r.item.title)).toEqual(['Laravel Sandbox', 'Alpha'])
    expect(results[0].keyIndex).toBe(0)
    expect(results[1].keyIndex).toBe(1)
  })

  it('applies the limit after sorting', () => {
    expect(fuzzyFilter(commands, 'code', (c) => c, { limit: 1 })).toHaveLength(1)
  })

  it('returns highlight indices for the matched key', () => {
    const [hit] = fuzzyFilter(['Open Anything'], 'any', (c) => c)
    expect(hit.indices).toEqual([5, 6, 7])
  })
})

describe('highlightSegments', () => {
  it('splits text into matched and plain runs', () => {
    expect(highlightSegments('Run Code', [0, 4, 5])).toEqual([
      { text: 'R', match: true },
      { text: 'un ', match: false },
      { text: 'Co', match: true },
      { text: 'de', match: false }
    ])
  })

  it('returns the whole text when nothing matched', () => {
    expect(highlightSegments('abc', [])).toEqual([{ text: 'abc', match: false }])
    expect(highlightSegments('', [])).toEqual([])
  })
})
