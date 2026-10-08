/**
 * Envelope protocol between the PHP runner and the main process (docs/ARCHITECTURE.md §1.3):
 *
 *   …noise… \n{nonce}BEGIN\n{json}\n{nonce}END\n …noise…
 *
 * `parseEnvelope` works on the complete stdout of a run; `EnvelopeStreamFilter` strips the envelope
 * region from live stdout chunks so only "outside" text is streamed to the renderer.
 */

export interface ParsedEnvelope<T> {
  /** The decoded JSON document (the last complete, valid envelope for this nonce), or null. */
  envelope: T | null
  /** stdout with every envelope region (and the newline framing it) removed. */
  outside: string
  /** Why no envelope could be decoded: 'missing' | 'incomplete' | 'invalid-json: …'. Unset on success. */
  problem?: string
}

const markerBegin = (nonce: string): string => `${nonce}BEGIN`
const markerEnd = (nonce: string): string => `${nonce}END`

/** Removes one trailing "\n" or "\r\n" (the newline the runner prints before the BEGIN marker). */
function stripOneTrailingNewline(text: string): string {
  if (text.endsWith('\r\n')) return text.slice(0, -2)
  if (text.endsWith('\n')) return text.slice(0, -1)
  return text
}

/** Index after one "\n" / "\r\n" at `index` (the newline the runner prints after the END marker). */
function skipOneNewline(text: string, index: number): number {
  if (text.charCodeAt(index) === 13 && text.charCodeAt(index + 1) === 10) return index + 2
  if (text.charCodeAt(index) === 10) return index + 1
  return index
}

/**
 * Extract the runner envelope for `nonce` from a complete stdout buffer.
 *
 * - Text before/after the envelope is returned as `outside` (framework noise, realtime echo output).
 * - Several envelopes with the same nonce: all regions are removed, the last valid one wins.
 * - A BEGIN marker without END (process killed mid-write) drops the partial JSON from `outside`.
 * - Envelopes of other nonces are left untouched (they are just text for this run).
 * - CRLF line endings (PTYs, Windows) are tolerated.
 */
export function parseEnvelope<T = unknown>(stdout: string, nonce: string): ParsedEnvelope<T> {
  if (!nonce) return { envelope: null, outside: stdout, problem: 'missing' }
  const begin = markerBegin(nonce)
  const end = markerEnd(nonce)
  const parts: string[] = []
  let cursor = 0
  let envelope: T | null = null
  let problem: string | undefined = 'missing'

  for (;;) {
    const b = stdout.indexOf(begin, cursor)
    if (b === -1) {
      parts.push(stdout.slice(cursor))
      break
    }
    parts.push(stripOneTrailingNewline(stdout.slice(cursor, b)))
    const jsonStart = b + begin.length
    const e = stdout.indexOf(end, jsonStart)
    if (e === -1) {
      // Partial envelope (killed / truncated while printing): never surface the half-written JSON.
      if (envelope === null) problem = 'incomplete'
      break
    }
    const json = stdout.slice(jsonStart, e).trim()
    try {
      const decoded: unknown = JSON.parse(json)
      if (decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded)) {
        envelope = decoded as T
        problem = undefined
      } else if (envelope === null) {
        problem = 'invalid-json: envelope is not an object'
      }
    } catch (err) {
      if (envelope === null) problem = `invalid-json: ${(err as Error).message}`
    }
    cursor = skipOneNewline(stdout, e + end.length)
  }

  return problem === undefined ? { envelope, outside: parts.join('') } : { envelope, outside: parts.join(''), problem }
}

/**
 * Incremental counterpart of `parseEnvelope` for live output: feed stdout chunks, get back the text
 * that lies outside the envelope and can be shown immediately. A possible partial BEGIN marker (and
 * the newline in front of it) is held back until the next chunk decides; envelope JSON is discarded.
 */
export class EnvelopeStreamFilter {
  private readonly begin: string
  private readonly end: string
  private inside = false
  private skipNewline = false
  private buffer = ''

  constructor(nonce: string) {
    this.begin = markerBegin(nonce)
    this.end = markerEnd(nonce)
  }

  /** Returns the outside text that is safe to emit now ('' when nothing). */
  push(chunk: string): string {
    if (!chunk) return ''
    this.buffer += chunk
    let out = ''
    for (;;) {
      if (this.inside) {
        const i = this.buffer.indexOf(this.end)
        if (i === -1) {
          // Keep just enough to recognise an END marker split across chunks.
          const keep = this.end.length - 1
          if (this.buffer.length > keep) this.buffer = this.buffer.slice(this.buffer.length - keep)
          return out
        }
        this.buffer = this.buffer.slice(i + this.end.length)
        this.inside = false
        this.skipNewline = true
        continue
      }

      if (this.skipNewline) {
        if (this.buffer === '' || this.buffer === '\r') return out // undecided: wait for more data
        if (this.buffer.startsWith('\r\n')) this.buffer = this.buffer.slice(2)
        else if (this.buffer.startsWith('\n')) this.buffer = this.buffer.slice(1)
        this.skipNewline = false
      }

      const i = this.buffer.indexOf(this.begin)
      if (i !== -1) {
        out += stripOneTrailingNewline(this.buffer.slice(0, i))
        this.buffer = this.buffer.slice(i + this.begin.length)
        this.inside = true
        continue
      }
      const hold = this.holdBack()
      out += this.buffer.slice(0, this.buffer.length - hold)
      this.buffer = this.buffer.slice(this.buffer.length - hold)
      return out
    }
  }

  /** Stream ended: returns any held-back outside text. A dangling (incomplete) envelope is dropped. */
  flush(): string {
    if (this.inside) {
      this.buffer = ''
      return ''
    }
    let out = this.buffer
    if (this.skipNewline) {
      if (out.startsWith('\r\n')) out = out.slice(2)
      else if (out.startsWith('\n')) out = out.slice(1)
      this.skipNewline = false
    }
    this.buffer = ''
    return out
  }

  /** Length of the buffer suffix that might be the start of "\n{nonce}BEGIN". */
  private holdBack(): number {
    const buf = this.buffer
    let k = 0
    for (let len = Math.min(this.begin.length - 1, buf.length); len > 0; len--) {
      if (buf.endsWith(this.begin.slice(0, len))) {
        k = len
        break
      }
    }
    let hold = k
    const before = buf.length - hold
    if (buf.charCodeAt(before - 1) === 10) {
      hold++
      if (buf.charCodeAt(before - 2) === 13) hold++
    } else if (k === 0 && buf.charCodeAt(before - 1) === 13) {
      hold++
    }
    return hold
  }
}
