import { describe, expect, it } from 'vitest'
import { EnvelopeStreamFilter, parseEnvelope } from '../../../src/main/execution/envelope'

const nonce = 'tw_0123456789abcdef01234567'
const wrap = (json: string, nl = '\n'): string => `${nl}${nonce}BEGIN${nl}${json}${nl}${nonce}END${nl}`

describe('parseEnvelope', () => {
  it('decodes a clean envelope with no outside text', () => {
    const r = parseEnvelope<{ a: number }>(wrap('{"a":1}'), nonce)
    expect(r.envelope).toEqual({ a: 1 })
    expect(r.outside).toBe('')
    expect(r.problem).toBeUndefined()
  })

  it('keeps noise before and after the envelope and strips the framing newlines only', () => {
    const r = parseEnvelope(`Warning: booting\nhello` + wrap('{"ok":true}') + 'shutdown noise\n', nonce)
    expect(r.envelope).toEqual({ ok: true })
    expect(r.outside).toBe('Warning: booting\nhelloshutdown noise\n')
  })

  it('preserves a newline the user printed before the envelope (only one newline is framing)', () => {
    const r = parseEnvelope('line\n' + wrap('{}'), nonce)
    expect(r.outside).toBe('line\n')
  })

  it('handles CRLF line endings', () => {
    const r = parseEnvelope('noise\r\n' + wrap('{"x":"y"}', '\r\n') + 'after\r\n', nonce)
    expect(r.envelope).toEqual({ x: 'y' })
    expect(r.outside).toBe('noise\r\nafter\r\n')
  })

  it('reports a missing envelope and returns all output', () => {
    const r = parseEnvelope('Fatal error: something\n', nonce)
    expect(r.envelope).toBeNull()
    expect(r.outside).toBe('Fatal error: something\n')
    expect(r.problem).toBe('missing')
  })

  it('drops a partial envelope (BEGIN without END) from the outside text', () => {
    const r = parseEnvelope(`before\n${nonce}BEGIN\n{"events":[{"seq":1,`, nonce)
    expect(r.envelope).toBeNull()
    expect(r.outside).toBe('before')
    expect(r.problem).toBe('incomplete')
  })

  it('reports invalid JSON', () => {
    const r = parseEnvelope(wrap('{not json'), nonce)
    expect(r.envelope).toBeNull()
    expect(r.problem).toMatch(/^invalid-json/)
  })

  it('rejects non-object JSON documents', () => {
    expect(parseEnvelope(wrap('[1,2]'), nonce).envelope).toBeNull()
    expect(parseEnvelope(wrap('"str"'), nonce).envelope).toBeNull()
  })

  it('ignores envelopes of other runs and takes the last valid envelope of this run', () => {
    const other = 'tw_ffffffffffffffffffffffff'
    const foreign = `\n${other}BEGIN\n{"foreign":true}\n${other}END\n`
    const r = parseEnvelope(foreign + wrap('{"n":1}') + 'mid' + wrap('{"n":2}'), nonce)
    expect(r.envelope).toEqual({ n: 2 })
    expect(r.outside).toBe(foreign + 'mid')
  })

  it('keeps an earlier valid envelope when a later one is broken', () => {
    const r = parseEnvelope(wrap('{"n":1}') + wrap('{broken'), nonce)
    expect(r.envelope).toEqual({ n: 1 })
    expect(r.problem).toBeUndefined()
  })

  it('handles huge payloads and huge noise', () => {
    const big = 'x'.repeat(5_000_000)
    const json = JSON.stringify({ big })
    const noise = 'n'.repeat(3_000_000)
    const r = parseEnvelope<{ big: string }>(noise + wrap(json) + noise, nonce)
    expect(r.envelope?.big.length).toBe(5_000_000)
    expect(r.outside.length).toBe(6_000_000)
  })

  it('handles unicode and JSON containing marker-like text of another nonce', () => {
    const r = parseEnvelope<{ s: string }>(wrap(JSON.stringify({ s: 'héllo 🐘 tw_abcBEGIN' })), nonce)
    expect(r.envelope?.s).toBe('héllo 🐘 tw_abcBEGIN')
  })

  it('returns the raw output when the nonce is empty', () => {
    expect(parseEnvelope('abc', '')).toEqual({ envelope: null, outside: 'abc', problem: 'missing' })
  })
})

describe('EnvelopeStreamFilter', () => {
  /** Feed `input` in chunks of the given sizes and collect what the filter emits. */
  function feed(input: string, sizes: number[]): string {
    const filter = new EnvelopeStreamFilter(nonce)
    let out = ''
    let i = 0
    let s = 0
    while (i < input.length) {
      const size = sizes[s++ % sizes.length]
      out += filter.push(input.slice(i, i + size))
      i += size
    }
    return out + filter.flush()
  }

  const sample = 'echo 1\nline two' + wrap(JSON.stringify({ events: ['a'.repeat(500)] })) + 'tail\n'

  it('matches parseEnvelope for every chunking', () => {
    const expected = parseEnvelope(sample, nonce).outside
    for (const sizes of [[1], [2], [3], [7], [13], [64], [1, 5, 2, 9], [sample.length]]) {
      expect(feed(sample, sizes)).toBe(expected)
    }
  })

  it('matches parseEnvelope for random chunkings with CRLF', () => {
    const input = 'a\r\nb' + wrap('{"x":1}', '\r\n') + 'c\r\n'
    const expected = parseEnvelope(input, nonce).outside
    for (let trial = 0; trial < 200; trial++) {
      const sizes = Array.from({ length: 5 }, () => 1 + Math.floor(Math.random() * 6))
      expect(feed(input, sizes)).toBe(expected)
    }
  })

  it('emits plain output immediately, holding back only a trailing newline', () => {
    const filter = new EnvelopeStreamFilter(nonce)
    expect(filter.push('tick 1\n')).toBe('tick 1')
    expect(filter.push('tick 2\n')).toBe('\ntick 2')
    expect(filter.flush()).toBe('\n')
  })

  it('holds back a possible marker prefix until it is decided', () => {
    const filter = new EnvelopeStreamFilter(nonce)
    expect(filter.push('abc' + nonce.slice(0, 5))).toBe('abc')
    expect(filter.push('zzz')).toBe(nonce.slice(0, 5) + 'zzz')
  })

  it('never emits envelope JSON and drops an unterminated envelope at the end', () => {
    const filter = new EnvelopeStreamFilter(nonce)
    let out = filter.push(`out\n${nonce}BEGIN\n{"secret":`)
    out += filter.push('"value"')
    out += filter.flush()
    expect(out).toBe('out')
  })

  it('passes through output when no envelope is ever printed', () => {
    expect(feed('just text without markers', [4])).toBe('just text without markers')
  })
})
