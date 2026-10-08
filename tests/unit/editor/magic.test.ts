import { describe, expect, it } from 'vitest'
import type { MagicValue } from '@shared/types'
import { inlineErrorMessage } from '../../../src/renderer/src/monaco/decorations'
import {
  appendMagicComment,
  formatMagicBadge,
  formatSeconds,
  hasTrailingMagicComment,
  locateMagicComment,
  MAX_BADGE_CHARS
} from '../../../src/renderer/src/monaco/magic'

const magic = (extra: Partial<MagicValue>): MagicValue => ({ line: 1, type: 'value', preview: '', value: null, hits: 1, ...extra })

describe('magic comment badges', () => {
  it('shows the value preview', () => {
    expect(formatMagicBadge(magic({ preview: '"Hello"' }))).toMatchObject({ label: null, value: '"Hello"', hits: null, kind: 'value' })
  })

  it('shows labels and loop hit counts', () => {
    const badge = formatMagicBadge(magic({ preview: '42', label: 'answer', hits: 3 }))
    expect(badge).toMatchObject({ label: 'answer', value: '42', hits: '×3' })
    expect(badge.title).toContain('answer: 42')
    expect(badge.title).toContain('3 times')
  })

  it('collapses whitespace and truncates long previews', () => {
    const badge = formatMagicBadge(magic({ preview: `[\n  "a" => 1,\n  "b" => 2\n] ${'x'.repeat(200)}` }))
    expect(badge.value.startsWith('[ "a" => 1, "b" => 2 ]')).toBe(true)
    expect(badge.value.length).toBeLessThanOrEqual(MAX_BADGE_CHARS)
    expect(badge.value.endsWith('…')).toBe(true)
    expect(formatMagicBadge(magic({ preview: '' })).value).toBe('null')
  })

  it('shows seconds for timing comments', () => {
    expect(formatMagicBadge(magic({ type: 'time', preview: '0.78301s', value: { t: 'float', v: '0.78301' } })).value).toBe('0.78301s')
    expect(formatMagicBadge(magic({ type: 'time', preview: '1.25000s' })).value).toBe('1.25s')
    expect(formatMagicBadge(magic({ type: 'time', preview: '0.00012s' })).kind).toBe('time')
    expect(formatSeconds(0.000123)).toBe('0.00012s')
    expect(formatSeconds(2)).toBe('2.0s')
    expect(formatSeconds(75.123)).toBe('75.1s')
  })

  it('locates the magic comment in the line', () => {
    expect(locateMagicComment('$a = 1; //? label', 8)).toEqual({ start: 8, end: 17, inline: false })
    expect(locateMagicComment('foo() /*?*/ + 1;', 6)).toEqual({ start: 6, end: 11, inline: true })
    expect(locateMagicComment('foo(); /*?->count()*/', 7)).toEqual({ start: 7, end: 21, inline: false })
    // stale column: falls back to searching the line
    expect(locateMagicComment('  $a = 1; //?', 0)).toEqual({ start: 10, end: 13, inline: false })
    expect(locateMagicComment('$a = 1;', 3)).toBeNull()
  })

  it('appends //? at the end of a line', () => {
    expect(appendMagicComment('$a = 1;  ')).toBe('$a = 1; //?')
    expect(appendMagicComment('$a = 1; //? x')).toBe('$a = 1; //? x')
    expect(appendMagicComment('$a = 1; // the answer')).toBe('$a = 1; //? the answer')
    expect(appendMagicComment('$a = 1; #')).toBe('$a = 1; #?')
    expect(appendMagicComment("$u = 'http://x'; ")).toBe("$u = 'http://x'; //?")
    expect(appendMagicComment('')).toBe('//?')
    expect(hasTrailingMagicComment("$u = '//?';")).toBe(false)
    expect(hasTrailingMagicComment('$u = 1; #? x')).toBe(true)
  })

  it('leaves heredoc, nowdoc and multi-line string contents alone', () => {
    const code = [
      '$css = <<<CSS',
      'body { color: #fff; }',
      'a { background: url(http://x.test/a.png); }',
      'CSS;',
      "$sql = 'select 1",
      ' -- # not a comment',
      "'; // done",
      "$raw = <<<'TXT'",
      'plain // text',
      'TXT; # note',
      '/* block',
      ' # still a comment */ $b = 2;',
      '$c = 3;'
    ]
    const at = (i: number): string => appendMagicComment(code[i], code.slice(0, i).map((l) => `${l}\n`).join(''))
    expect(at(0)).toBe(code[0]) // opens the heredoc
    expect(at(1)).toBe(code[1])
    expect(at(2)).toBe(code[2])
    expect(at(3)).toBe('CSS; //?')
    expect(at(4)).toBe(code[4]) // opens a multi-line string
    expect(at(5)).toBe(code[5])
    expect(at(6)).toBe("'; //? done")
    expect(at(7)).toBe(code[7])
    expect(at(8)).toBe(code[8])
    expect(at(9)).toBe('TXT; #? note')
    expect(at(10)).toBe(code[10])
    expect(at(11)).toBe(' # still a comment */ $b = 2; //?')
    expect(at(12)).toBe('$c = 3; //?')
    expect(hasTrailingMagicComment('#? x', "$s = 'a\n")).toBe(false)
    expect(hasTrailingMagicComment("'; #? x", "$s = 'a\n")).toBe(true)
  })

  it('formats inline errors on one line', () => {
    expect(inlineErrorMessage('Illuminate\\Database\\Eloquent\\ModelNotFoundException', 'No query\nresults')).toBe('ModelNotFoundException: No query results')
    expect(inlineErrorMessage('Error', '')).toBe('Error')
    expect(inlineErrorMessage('E', 'x'.repeat(400)).length).toBeLessThanOrEqual(160)
  })
})
