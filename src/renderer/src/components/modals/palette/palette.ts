import { fuzzyFilter } from '@/utils/fuzzy'

/**
 * Pure logic of Open Anything: query prefixes, grouped fuzzy results and keyboard navigation over the flattened
 * list. The component builds the item sources from the stores; items carry their own `run` action.
 */

export type PaletteMode = 'all' | 'snippets' | 'folders' | 'commands'
export type PalettePrefix = '' | '#' | '/' | '>'

/** Prefix → mode. `#` snippets, `/` recent folders, `>` commands. */
export const PALETTE_PREFIXES: Readonly<Record<Exclude<PalettePrefix, ''>, Exclude<PaletteMode, 'all'>>> = {
  '#': 'snippets',
  '/': 'folders',
  '>': 'commands'
}

export interface ParsedPaletteQuery {
  mode: PaletteMode
  prefix: PalettePrefix
  /** Search text without the prefix, trimmed. */
  text: string
}

/** "#  users" → { mode: 'snippets', prefix: '#', text: 'users' }; no prefix → mode 'all'. */
export function parsePaletteQuery(raw: string): ParsedPaletteQuery {
  const value = (raw ?? '').replace(/^\s+/, '')
  const first = value.charAt(0)
  if (first === '#' || first === '/' || first === '>') {
    return { mode: PALETTE_PREFIXES[first], prefix: first, text: value.slice(1).trim() }
  }
  return { mode: 'all', prefix: '', text: value.trim() }
}

/**
 * Empty-state copy when no item is listed: "Nothing matches …" only when there is search text — a bare "#" with no
 * snippets just has nothing to list.
 */
export function paletteEmptyText(parsed: ParsedPaletteQuery, counts: { snippets: number; recentFolders: number }): { title: string; hint: string } {
  const noSnippets = parsed.mode === 'snippets' && counts.snippets === 0
  const noFolders = parsed.mode === 'folders' && counts.recentFolders === 0
  if (parsed.text === '') {
    if (noSnippets) return { title: 'No snippets yet', hint: 'Save code with “Add Code to Snippets” and it shows up here.' }
    if (noFolders) return { title: 'No recent folders yet', hint: 'Folders you open show up here.' }
    return { title: 'Nothing to show', hint: 'Type to search, or use another prefix.' }
  }
  const hint = noSnippets ? 'You have no snippets yet.' : noFolders ? 'No recent folders yet.' : 'Try fewer letters or another prefix.'
  return { title: `Nothing matches “${parsed.text}”`, hint }
}

/** Query string for a mode (keeps the search text), e.g. for clickable prefix hints. */
export function withPrefix(mode: PaletteMode, text: string): string {
  const prefix = (Object.keys(PALETTE_PREFIXES) as Array<keyof typeof PALETTE_PREFIXES>).find((p) => PALETTE_PREFIXES[p] === mode)
  return prefix ? `${prefix}${text}` : text
}

export type PaletteGroupId = 'start' | 'commands' | 'folders' | 'snippets' | 'herd'

export const PALETTE_GROUP_ORDER: readonly PaletteGroupId[] = ['start', 'commands', 'folders', 'snippets', 'herd']

export const PALETTE_GROUP_TITLES: Readonly<Record<PaletteGroupId, string>> = {
  start: 'Get started',
  commands: 'Commands',
  folders: 'Recent folders',
  snippets: 'Snippets',
  herd: 'Herd sites'
}

const MODE_GROUPS: Readonly<Record<PaletteMode, readonly PaletteGroupId[]>> = {
  all: PALETTE_GROUP_ORDER,
  snippets: ['snippets'],
  folders: ['folders'],
  commands: ['commands']
}

export interface PaletteRunOptions {
  /** ⌘Enter / Ctrl+Enter: open in a new tab where it applies. */
  newTab: boolean
}

export interface PaletteItem {
  /** Unique key across groups ("cmd:run", "folder:<id>", …). */
  key: string
  group: PaletteGroupId
  title: string
  description?: string
  /** Extra searchable text (not displayed), e.g. a full path or the snippet code. */
  keywords?: string
  /** Electron accelerator shown on the right. */
  shortcut?: string
  /** Shown dimmed; Enter does nothing. */
  disabled?: boolean
  /** The item honours ⌘Enter (opens in a new tab). */
  supportsNewTab?: boolean
  /** Icon name resolved by the component. */
  icon?: string
  /** Accent color of the icon (project color). */
  color?: string
  run: (options: PaletteRunOptions) => void | Promise<void>
}

export interface PaletteHit {
  item: PaletteItem
  score: number
  /** Highlight indices in the title (empty when the match was in another field). */
  titleIndices: number[]
}

export interface PaletteGroup {
  id: PaletteGroupId
  title: string
  hits: PaletteHit[]
  /** Matches before the per-group limit was applied. */
  total: number
}

export type PaletteSources = Partial<Record<PaletteGroupId, readonly PaletteItem[]>>

export interface PaletteLimits {
  /** Per-group limit in the mixed view without a query. */
  browse: Partial<Record<PaletteGroupId, number>>
  /** Per-group limit in the mixed view while searching. */
  search: Partial<Record<PaletteGroupId, number>>
  /** Limit when a prefix narrows the view to a single group. */
  single: number
}

export const DEFAULT_PALETTE_LIMITS: PaletteLimits = {
  browse: { start: 4, commands: 5, folders: 5, snippets: 5, herd: 4 },
  search: { start: 4, commands: 8, folders: 6, snippets: 6, herd: 5 },
  single: 200
}

function searchKeys(item: PaletteItem): Array<string | undefined> {
  return [item.title, item.description, item.keywords]
}

/**
 * Score of a clear match (substring / subsequence, also in a secondary field). Typo-tolerant matches score far
 * lower; they are only shown when nothing matches clearly, so a precise query is not buried in near-misses.
 */
export const STRONG_MATCH_SCORE = 400
export const TYPO_MATCH_SCORE = 250

/**
 * Grouped results for a raw query. In the mixed view the groups follow PALETTE_GROUP_ORDER without a query and are
 * ordered by their best match while searching (ties keep the default order). Empty groups are dropped.
 */
export function buildPaletteGroups(sources: PaletteSources, raw: string, limits: PaletteLimits = DEFAULT_PALETTE_LIMITS): PaletteGroup[] {
  const parsed = parsePaletteQuery(raw)
  const groupIds = MODE_GROUPS[parsed.mode]
  const single = groupIds.length === 1
  const searching = parsed.text !== ''
  const matched = groupIds.map((id) => ({ id, results: fuzzyFilter(sources[id] ?? [], parsed.text, searchKeys) }))
  const strongest = Math.max(0, ...matched.flatMap((m) => m.results.map((r) => r.score)))
  const pruneTypos = searching && strongest >= STRONG_MATCH_SCORE
  const groups: PaletteGroup[] = []
  for (const { id, results: all } of matched) {
    const results = pruneTypos ? all.filter((r) => r.score >= TYPO_MATCH_SCORE) : all
    if (results.length === 0) continue
    const limit = single ? limits.single : ((searching ? limits.search[id] : limits.browse[id]) ?? limits.single)
    groups.push({
      id,
      title: PALETTE_GROUP_TITLES[id],
      total: results.length,
      hits: results.slice(0, limit).map((r) => ({ item: r.item, score: r.score, titleIndices: r.keyIndex === 0 ? r.indices : [] }))
    })
  }
  if (searching && !single) {
    const order = (id: PaletteGroupId): number => PALETTE_GROUP_ORDER.indexOf(id)
    // Prefer enabled matches when ranking groups so a disabled command does not push folders down.
    const best = (g: PaletteGroup): number => Math.max(...g.hits.map((h) => (h.item.disabled ? h.score * 0.5 : h.score)))
    groups.sort((a, b) => best(b) - best(a) || order(a.id) - order(b.id))
  }
  return groups
}

/** Hits of all groups in display order (keyboard navigation index space). */
export function flattenPalette(groups: readonly PaletteGroup[]): PaletteHit[] {
  return groups.flatMap((g) => g.hits)
}

/**
 * Next selectable index when moving by `delta` (wraps around, skips disabled items). Returns -1 when nothing is
 * selectable.
 */
export function moveSelection(hits: readonly PaletteHit[], current: number, delta: number): number {
  const n = hits.length
  if (n === 0) return -1
  let index = current < 0 || current >= n ? (delta >= 0 ? -1 : n) : current
  for (let step = 0; step < n; step++) {
    index = (((index + (delta >= 0 ? 1 : -1)) % n) + n) % n
    if (!hits[index].item.disabled) return index
  }
  return -1
}

/** First selectable index (or -1). */
export function firstSelectable(hits: readonly PaletteHit[]): number {
  return hits.findIndex((h) => !h.item.disabled)
}
