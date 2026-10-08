import { describe, expect, it } from 'vitest'
import type { LogEntry, LogFile } from '@shared/types'
import {
  countLevels,
  countMatches,
  entryKeys,
  entryMatches,
  entryToText,
  filterEntries,
  groupLogFiles,
  groupStack,
  hasDetails,
  highlightParts,
  isVendorFrame,
  levelBadgeClass,
  levelFilterLabel,
  levelRank,
  messageHeadline,
  normalizeLevel,
  pickDefaultFile,
  prettyContext
} from '@/components/modals/logs/logUtils'

function entry(level: string, message: string, extra: Partial<LogEntry> = {}): LogEntry {
  return { datetime: '2026-10-08 10:00:00', env: 'local', level, message, ...extra }
}

const ENTRIES: LogEntry[] = [
  entry('error', 'SQLSTATE[42S02]: Base table not found', { stack: '#0 /app/vendor/laravel/framework/src/Db.php(10): run()' }),
  entry('info', 'User 42 logged in', { context: '{"user":42}' }),
  entry('WARNING', 'Disk almost full'),
  entry('error', 'Undefined variable $foo'),
  entry('debug', 'Cache hit for key users'),
  entry('warn', 'Deprecated call'),
  entry('custom', 'Something odd')
]

describe('levels', () => {
  it('normalizes case and aliases', () => {
    expect(normalizeLevel('WARNING')).toBe('warning')
    expect(normalizeLevel('warn')).toBe('warning')
    expect(normalizeLevel('ERR')).toBe('error')
    expect(normalizeLevel('fatal')).toBe('critical')
    expect(normalizeLevel('emerg')).toBe('emergency')
    expect(normalizeLevel('')).toBe('info')
    expect(normalizeLevel(undefined)).toBe('info')
    expect(normalizeLevel('Custom')).toBe('custom')
  })

  it('ranks by severity with unknown levels last', () => {
    expect(levelRank('debug')).toBe(0)
    expect(levelRank('emergency')).toBe(7)
    expect(levelRank('Error')).toBeGreaterThan(levelRank('warning'))
    expect(levelRank('whatever')).toBe(8)
  })

  it('counts levels, most severe first, unknown levels at the end', () => {
    expect(countLevels(ENTRIES)).toEqual([
      { level: 'error', count: 2 },
      { level: 'warning', count: 2 },
      { level: 'info', count: 1 },
      { level: 'debug', count: 1 },
      { level: 'custom', count: 1 }
    ])
    expect(countLevels([])).toEqual([])
  })

  it('labels the level filter', () => {
    expect(levelFilterLabel([])).toBe('All Levels')
    expect(levelFilterLabel(new Set(['warning']))).toBe('Warning')
    expect(levelFilterLabel(['warning', 'error'])).toBe('Error, Warning')
    expect(levelFilterLabel(['debug', 'info', 'error'])).toBe('3 levels')
  })

  it('maps every known level to a themed badge', () => {
    for (const level of ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency', 'other']) {
      expect(levelBadgeClass(level)).toMatch(/\S/)
      expect(levelBadgeClass(level)).not.toMatch(/#[0-9a-f]{3,6}/i)
    }
    expect(levelBadgeClass('ERROR')).toBe(levelBadgeClass('error'))
  })
})

describe('filtering & search', () => {
  it('keeps everything without a filter (copy, same order)', () => {
    const result = filterEntries(ENTRIES)
    expect(result).toEqual(ENTRIES)
    expect(result).not.toBe(ENTRIES)
  })

  it('filters by one or more levels (aliases and case folded)', () => {
    expect(filterEntries(ENTRIES, { levels: ['error'] }).map((e) => e.message)).toEqual([
      'SQLSTATE[42S02]: Base table not found',
      'Undefined variable $foo'
    ])
    expect(filterEntries(ENTRIES, { levels: new Set(['warning']) }).map((e) => e.message)).toEqual(['Disk almost full', 'Deprecated call'])
    expect(filterEntries(ENTRIES, { levels: ['warning', 'debug'] })).toHaveLength(3)
  })

  it('searches message, context, stack, env and datetime case-insensitively', () => {
    expect(filterEntries(ENTRIES, { query: 'sqlstate' })).toHaveLength(1)
    expect(filterEntries(ENTRIES, { query: '"user":42' })).toHaveLength(1)
    expect(filterEntries(ENTRIES, { query: 'Db.php' })).toHaveLength(1)
    expect(filterEntries(ENTRIES, { query: 'LOCAL' })).toHaveLength(ENTRIES.length)
    expect(filterEntries(ENTRIES, { query: '   ' })).toHaveLength(ENTRIES.length)
    expect(filterEntries(ENTRIES, { query: 'nope-nothing' })).toEqual([])
    expect(entryMatches(ENTRIES[1], '')).toBe(true)
  })

  it('combines level and query', () => {
    expect(filterEntries(ENTRIES, { levels: ['error'], query: 'variable' }).map((e) => e.message)).toEqual(['Undefined variable $foo'])
    expect(filterEntries(ENTRIES, { levels: ['info'], query: 'variable' })).toEqual([])
  })

  it('splits text into highlighted parts', () => {
    expect(highlightParts('Foo bar foo', 'foo')).toEqual([
      { text: 'Foo', match: true },
      { text: ' bar ', match: false },
      { text: 'foo', match: true }
    ])
    expect(highlightParts('abc', '')).toEqual([{ text: 'abc', match: false }])
    expect(highlightParts('', 'x')).toEqual([])
    expect(highlightParts('aaaa', 'aa').filter((p) => p.match)).toHaveLength(2)
    expect(countMatches('Error: error in ERROR handler', 'error')).toBe(3)
    // Reassembling the parts gives the original text back.
    const text = 'Undefined $variable in variable.php'
    expect(highlightParts(text, 'VARIABLE').map((p) => p.text).join('')).toBe(text)
  })
})

describe('entry details', () => {
  it('uses the first non-empty line as the headline', () => {
    expect(messageHeadline('\n  First line  \nsecond')).toBe('First line')
    expect(hasDetails(entry('info', 'one line'))).toBe(false)
    expect(hasDetails(entry('info', 'two\nlines'))).toBe(true)
    expect(hasDetails(entry('info', 'x', { context: '{}' }))).toBe(true)
    expect(hasDetails(entry('info', 'x', { stack: '#0 {main}' }))).toBe(true)
  })

  it('pretty-prints JSON context and leaves other text alone', () => {
    expect(prettyContext('{"a":1,"b":[1,2]}')).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}')
    expect(prettyContext('{"a":1} {"b":2}')).toBe('{\n  "a": 1\n}\n{\n  "b": 2\n}')
    expect(prettyContext('not json')).toBe('not json')
    expect(prettyContext('{broken')).toBe('{broken')
    expect(prettyContext(undefined)).toBe('')
  })

  it('groups stack frames into app and vendor runs', () => {
    const stack = [
      '[stacktrace]',
      '#0 /app/app/Models/User.php(12): boot()',
      '#1 /app/vendor/laravel/framework/src/A.php(1): a()',
      '#2 /app/vendor/laravel/framework/src/B.php(2): b()',
      '#3 C:\\www\\vendor\\symfony\\c.php(3): c()',
      '#4 /app/routes/web.php(5): handle()',
      '',
      '#5 {main}'
    ].join('\n')
    const groups = groupStack(stack)
    expect(groups.map((g) => [g.vendor, g.lines.length])).toEqual([
      [false, 1],
      [true, 3],
      [false, 2]
    ])
    expect(isVendorFrame('#3 C:\\www\\vendor\\symfony\\c.php(3)')).toBe(true)
    expect(isVendorFrame('#3 /app/vendors.php')).toBe(false)
    expect(groupStack('')).toEqual([])
  })

  it('formats an entry for the clipboard', () => {
    const text = entryToText(entry('ERROR', 'Boom', { context: '{"id":1}', stack: '#0 {main}' }))
    expect(text).toBe('[2026-10-08 10:00:00] local.ERROR: Boom\n{\n  "id": 1\n}\n#0 {main}')
    expect(entryToText({ datetime: '', level: 'info', message: 'plain' })).toBe('INFO: plain')
  })

  it('builds stable, unique keys for duplicate entries', () => {
    const dup = entry('info', 'same')
    const keys = entryKeys([dup, dup, entry('info', 'other'), dup])
    expect(new Set(keys).size).toBe(4)
    expect(keys[0]).toBe(entryKeys([dup])[0])
    // A new entry on top (newest first) keeps the keys of the existing ones.
    const before = entryKeys(ENTRIES)
    const after = entryKeys([entry('info', 'brand new'), ...ENTRIES])
    expect(after.slice(1)).toEqual(before)
  })
})

describe('files', () => {
  const file = (path: string, modifiedAt: number, size = 100): LogFile => {
    const slash = path.lastIndexOf('/')
    return { path, name: slash === -1 ? path : path.slice(slash + 1), dir: slash === -1 ? '' : path.slice(0, slash), size, modifiedAt }
  }
  const FILES = [file('worker.log', 5), file('laravel.log', 3), file('daily/b.log', 9), file('apache/error.log', 1), file('daily/a.log', 2)]

  it('groups by directory with the root first', () => {
    const groups = groupLogFiles(FILES)
    expect(groups.map((g) => g.label)).toEqual(['LOGS ROOT', 'APACHE', 'DAILY'])
    expect(groups[0].files.map((f) => f.name)).toEqual(['worker.log', 'laravel.log'])
    expect(groups[2].files.map((f) => f.name)).toEqual(['b.log', 'a.log'])
    expect(groupLogFiles([])).toEqual([])
  })

  it('picks the remembered file, else laravel.log, else the newest', () => {
    expect(pickDefaultFile(FILES, 'daily/a.log')?.path).toBe('daily/a.log')
    expect(pickDefaultFile(FILES, 'gone.log')?.path).toBe('laravel.log')
    expect(pickDefaultFile(FILES.filter((f) => f.name !== 'laravel.log'))?.path).toBe('daily/b.log')
    expect(pickDefaultFile([])).toBeNull()
  })
})
