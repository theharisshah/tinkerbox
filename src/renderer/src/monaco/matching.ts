/**
 * Cheap candidate filtering for large completion lists (thousands of classes / functions). Monaco does the final
 * fuzzy scoring and highlighting; this only decides which candidates are worth sending.
 */

/**
 * Score of `name` for the typed `prefix` (higher is better), or null when it does not match. The first typed
 * character must match the first character of the name or of a word inside it (camelCase / snake_case / `\`), the
 * rest is a case-insensitive subsequence.
 */
export function matchScore(prefix: string, name: string): number | null {
  if (prefix === '') return 0
  const p = prefix.toLowerCase()
  const n = name.toLowerCase()
  if (n.startsWith(p)) return 1000 - Math.min(500, name.length) + (name.startsWith(prefix) ? 50 : 0)
  const starts: number[] = []
  for (let i = 0; i < name.length; i++) {
    const ch = name[i]
    const prev = name[i - 1]
    const wordStart =
      i === 0 || prev === '_' || prev === '\\' || prev === '$' || (/[a-z0-9]/.test(prev ?? '') && /[A-Z]/.test(ch))
    if (wordStart && n[i] === p[0]) starts.push(i)
  }
  if (starts.length === 0) return null
  let best: number | null = null
  for (const start of starts) {
    let j = start
    let gaps = 0
    let k = 0
    for (; k < p.length && j < n.length; j++) {
      if (n[j] === p[k]) k++
      else if (k > 0) gaps++
    }
    if (k < p.length) continue
    const score = 600 - gaps * 5 - start - Math.min(200, name.length)
    if (best === null || score > best) best = score
  }
  return best
}

/** Best `limit` names for a prefix, best first. `incomplete` tells Monaco to ask again when the prefix grows. */
export function rankNames(names: Iterable<string>, prefix: string, limit: number): { names: string[]; incomplete: boolean } {
  const scored: Array<{ name: string; score: number }> = []
  for (const name of names) {
    const score = matchScore(prefix, name)
    if (score !== null) scored.push({ name, score })
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
  return { names: scored.slice(0, limit).map((s) => s.name), incomplete: scored.length > limit }
}
