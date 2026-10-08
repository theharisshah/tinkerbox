/**
 * Fuzzy matching used everywhere a list is searched (Open Anything, snippets, history, commands, logs…).
 *
 * Each whitespace separated query token must match the text, tried in this order:
 *  1. case-insensitive substring (best; prefix / word-start matches rank highest),
 *  2. subsequence with an fzy-style alignment score (word starts, camelCase humps and runs score higher),
 *  3. typo tolerance: approximate substring match (Damerau edit distance ≤ 1 for 3–5 characters, ≤ 2 above).
 * Results carry the matched character indices for highlighting.
 */

export interface FuzzyMatch {
  score: number
  /** Sorted, unique indices of matched characters in the text. */
  indices: number[]
}

export interface FuzzyResult<T> {
  item: T
  score: number
  /** Index of the key (from `keys(item)`) that matched best. */
  keyIndex: number
  /** Matched character indices inside that key's text. */
  indices: number[]
}

export interface FuzzyFilterOptions {
  /** Maximum number of results (after sorting). */
  limit?: number
  /** Multiplier applied to secondary keys (index ≥ 1). Default 0.85. */
  secondaryKeyWeight?: number
}

export interface HighlightSegment {
  text: string
  match: boolean
}

/** Texts longer than this are only searched by substring (no alignment / typo matrices). */
const MAX_ALIGN_TEXT = 512
const MAX_ALIGN_QUERY = 64

const SCORE_GAP_LEADING = -0.005
const SCORE_GAP_TRAILING = -0.005
const SCORE_GAP_INNER = -0.01
const SCORE_MATCH_CONSECUTIVE = 1.0
const SCORE_MATCH_SLASH = 0.9
const SCORE_MATCH_WORD = 0.8
const SCORE_MATCH_CAPITAL = 0.7
const SCORE_MATCH_DOT = 0.6

const WORD_SEPARATORS = new Set([' ', '-', '_', ':', ',', '(', ')', '[', ']', '{', '}', '@', '#', '>', '$', "'", '"', '='])

/** Bonus for matching the character at `i` (fzy's "match bonus"). */
function boundaryBonus(original: string, i: number): number {
  if (i === 0) return SCORE_MATCH_SLASH
  const prev = original[i - 1]
  if (prev === '/' || prev === '\\') return SCORE_MATCH_SLASH
  if (WORD_SEPARATORS.has(prev)) return SCORE_MATCH_WORD
  if (prev === '.') return SCORE_MATCH_DOT
  const cur = original[i]
  if (prev >= 'a' && prev <= 'z' && cur >= 'A' && cur <= 'Z') return SCORE_MATCH_CAPITAL
  return 0
}

function isWordStart(original: string, i: number): boolean {
  return boundaryBonus(original, i) >= SCORE_MATCH_CAPITAL
}

/** fzy alignment of `q` as a subsequence of `t`; null when not a subsequence. */
function alignSubsequence(q: string, t: string, original: string): FuzzyMatch | null {
  const n = q.length
  const m = t.length
  // Quick subsequence check.
  let qi = 0
  for (let i = 0; i < m && qi < n; i++) if (t[i] === q[qi]) qi++
  if (qi < n) return null

  const bonus = new Float64Array(m)
  for (let j = 0; j < m; j++) bonus[j] = boundaryBonus(original, j)
  // D[i][j]: best score with q[i] matched at t[j]; M[i][j]: best score for q[0..i] within t[0..j].
  const D: Float64Array[] = []
  const M: Float64Array[] = []
  for (let i = 0; i < n; i++) {
    const d = new Float64Array(m).fill(-Infinity)
    const mm = new Float64Array(m).fill(-Infinity)
    let prevScore = -Infinity
    const gap = i === n - 1 ? SCORE_GAP_TRAILING : SCORE_GAP_INNER
    for (let j = 0; j < m; j++) {
      if (q[i] === t[j]) {
        let score = -Infinity
        if (i === 0) {
          score = j * SCORE_GAP_LEADING + bonus[j]
        } else if (j > 0) {
          const prevM = M[i - 1][j - 1]
          const prevD = D[i - 1][j - 1]
          score = Math.max(prevM + bonus[j], prevD + SCORE_MATCH_CONSECUTIVE)
        }
        d[j] = score
        prevScore = Math.max(score, prevScore + gap)
      } else {
        prevScore = prevScore + gap
      }
      mm[j] = prevScore
    }
    D.push(d)
    M.push(mm)
  }

  // Backtrace the matched positions.
  const indices = new Array<number>(n)
  let matchRequired = false
  for (let i = n - 1, j = m - 1; i >= 0; i--) {
    for (; j >= 0; j--) {
      if (D[i][j] !== -Infinity && (matchRequired || D[i][j] === M[i][j])) {
        matchRequired = i > 0 && j > 0 && M[i][j] === D[i - 1][j - 1] + SCORE_MATCH_CONSECUTIVE
        indices[i] = j
        j--
        break
      }
    }
  }
  return { score: M[n - 1][m - 1], indices }
}

/**
 * Approximate substring match (Sellers' algorithm with adjacent transpositions). Returns the edit distance of the
 * best window and the indices of the characters that matched exactly.
 */
function approximateSubstring(q: string, t: string, maxDistance: number): { distance: number; indices: number[] } | null {
  const n = q.length
  const m = t.length
  if (n === 0 || m === 0 || n - maxDistance > m) return null
  // d[i][j] = distance between q[0..i) and the best substring of t ending at j.
  const d: Int32Array[] = []
  for (let i = 0; i <= n; i++) {
    const row = new Int32Array(m + 1)
    if (i > 0) row[0] = i
    d.push(row)
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = q[i - 1] === t[j - 1] ? 0 : 1
      let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && q[i - 1] === t[j - 2] && q[i - 2] === t[j - 1]) v = Math.min(v, d[i - 2][j - 2] + 1)
      d[i][j] = v
    }
  }
  let best = Infinity
  let bestJ = -1
  for (let j = 1; j <= m; j++) {
    if (d[n][j] < best) {
      best = d[n][j]
      bestJ = j
    }
  }
  if (best > maxDistance || bestJ < 0) return null
  // Backtrace to find exact character matches.
  const indices: number[] = []
  let i = n
  let j = bestJ
  while (i > 0 && j > 0) {
    const cost = q[i - 1] === t[j - 1] ? 0 : 1
    if (d[i][j] === d[i - 1][j - 1] + cost) {
      if (cost === 0) indices.push(j - 1)
      i--
      j--
    } else if (i > 1 && j > 1 && q[i - 1] === t[j - 2] && q[i - 2] === t[j - 1] && d[i][j] === d[i - 2][j - 2] + 1) {
      indices.push(j - 1, j - 2)
      i -= 2
      j -= 2
    } else if (d[i][j] === d[i - 1][j] + 1) {
      i--
    } else {
      j--
    }
  }
  indices.sort((a, b) => a - b)
  return { distance: best, indices }
}

function matchToken(token: string, lower: string, original: string): FuzzyMatch | null {
  const lengthPenalty = Math.min(lower.length, 500) * 0.05
  // 1. Substring: prefer a word-start occurrence over the first occurrence.
  let at = lower.indexOf(token)
  if (at >= 0) {
    let pick = at
    while (at >= 0) {
      if (isWordStart(original, at)) {
        pick = at
        break
      }
      at = lower.indexOf(token, at + 1)
    }
    let score = 1000 - Math.min(pick, 100) - lengthPenalty
    if (pick === 0) score += 200
    else if (isWordStart(original, pick)) score += 100
    if (token.length === lower.length) score += 300
    return { score, indices: Array.from({ length: token.length }, (_, k) => pick + k) }
  }
  if (lower.length > MAX_ALIGN_TEXT || token.length > MAX_ALIGN_QUERY) return null
  // 2. Subsequence.
  const aligned = alignSubsequence(token, lower, original)
  if (aligned) {
    return { score: 500 + (aligned.score / token.length) * 100 - lengthPenalty, indices: aligned.indices }
  }
  // 3. Typos.
  if (token.length < 3) return null
  const maxDistance = token.length >= 6 ? 2 : 1
  const approx = approximateSubstring(token, lower, maxDistance)
  if (!approx) return null
  return { score: 200 - approx.distance * 60 - lengthPenalty, indices: approx.indices }
}

/** Match a query against one text. Empty queries match everything with score 0. */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { score: 0, indices: [] }
  if (typeof text !== 'string' || text === '') return null
  const lower = text.toLowerCase()
  let score = 0
  const indices = new Set<number>()
  for (const token of tokens) {
    const match = matchToken(token, lower, text)
    if (!match) return null
    score += match.score
    for (const i of match.indices) indices.add(i)
  }
  return { score, indices: [...indices].sort((a, b) => a - b) }
}

/** Per query token, every substring match scores above this; subsequence and typo matches score below it. */
export const SUBSTRING_TOKEN_SCORE = 700

/**
 * When some results contain every query token as a substring, drop the ones that only matched as a loose
 * subsequence or with typos. Long texts (code) contain almost any short word as a scattered subsequence, so those
 * matches are noise next to real hits; they are kept only when nothing matches literally.
 */
export function preferSubstringMatches<R extends { score: number }>(results: readonly R[], query: string): R[] {
  const tokens = query.trim().split(/\s+/).filter(Boolean).length
  if (tokens === 0) return [...results]
  const threshold = SUBSTRING_TOKEN_SCORE * tokens
  return results.some((r) => r.score >= threshold) ? results.filter((r) => r.score >= threshold) : [...results]
}

/**
 * Filter + rank items. `keys` returns the searchable texts of an item (the first one is the primary key, e.g. the
 * title; the others e.g. a description). An empty query returns every item in input order.
 */
export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  keys: (item: T) => string | ReadonlyArray<string | null | undefined>,
  options: FuzzyFilterOptions = {}
): FuzzyResult<T>[] {
  const weight = options.secondaryKeyWeight ?? 0.85
  const results: Array<FuzzyResult<T> & { order: number }> = []
  const empty = query.trim() === ''
  items.forEach((item, order) => {
    if (empty) {
      results.push({ item, score: 0, keyIndex: 0, indices: [], order })
      return
    }
    const raw = keys(item)
    const texts = typeof raw === 'string' ? [raw] : raw
    let best: FuzzyResult<T> | null = null
    texts.forEach((text, keyIndex) => {
      if (!text) return
      const match = fuzzyMatch(query, text)
      if (!match) return
      const score = keyIndex === 0 ? match.score : match.score * weight
      if (!best || score > best.score) best = { item, score, keyIndex, indices: match.indices }
    })
    if (best) results.push({ ...(best as FuzzyResult<T>), order })
  })
  if (!empty) results.sort((a, b) => b.score - a.score || a.order - b.order)
  const limited = options.limit !== undefined ? results.slice(0, options.limit) : results
  return limited.map(({ item, score, keyIndex, indices }) => ({ item, score, keyIndex, indices }))
}

/** Split a text into highlighted / plain segments for rendering matches. */
export function highlightSegments(text: string, indices: readonly number[]): HighlightSegment[] {
  if (indices.length === 0) return text ? [{ text, match: false }] : []
  const marks = new Set(indices)
  const segments: HighlightSegment[] = []
  let current = ''
  let currentMatch = marks.has(0)
  for (let i = 0; i < text.length; i++) {
    const isMatch = marks.has(i)
    if (isMatch !== currentMatch && current !== '') {
      segments.push({ text: current, match: currentMatch })
      current = ''
    }
    currentMatch = isMatch
    current += text[i]
  }
  if (current !== '') segments.push({ text: current, match: currentMatch })
  return segments
}
