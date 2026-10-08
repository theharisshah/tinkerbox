import { describe, expect, it } from 'vitest'
import type { Snippet } from '@shared/types'
import {
  belongsToProject,
  filterSnippets,
  isReadOnlySnippet,
  matchesTextFilter,
  scopeCounts,
  snippetOpenConnection,
  snippetProjectId,
  sortSnippets
} from '@/components/modals/snippets/snippets'

function snippet(id: string, name: string, patch: Partial<Snippet> = {}): Snippet {
  return { id, name, code: `// ${name}`, connectionId: '', source: 'user', createdAt: 1, updatedAt: 1, ...patch }
}

const list: Snippet[] = [
  snippet('s1', 'Latest users', { code: 'User::latest()->take(5)->get();', description: 'Five newest accounts', connectionId: 'p1' }),
  snippet('s2', 'clear cache', { code: "Artisan::call('cache:clear');" }),
  snippet('s3', 'Open orders', { code: "Order::where('status', 'open')->count();", connectionId: 'p1', source: 'project' }),
  snippet('s4', 'Blog posts', { code: 'Post::published()->get();', connectionId: 'p2' }),
  snippet('s5', 'Dump config', { code: "config('app');", description: 'Shows the app config' })
]

const labels: Record<string, string> = { p1: 'acme-shop', p2: 'blog' }
const label = (id: string): string => labels[id] ?? id

describe('snippet helpers', () => {
  it('sorts alphabetically, case-insensitively', () => {
    expect(sortSnippets(list).map((s) => s.name)).toEqual(['Blog posts', 'clear cache', 'Dump config', 'Latest users', 'Open orders'])
  })

  it('knows read-only project snippets and project membership', () => {
    expect(isReadOnlySnippet(list[2])).toBe(true)
    expect(isReadOnlySnippet(list[0])).toBe(false)
    expect(belongsToProject(list[0], 'p1')).toBe(true)
    expect(belongsToProject(list[3], 'p1')).toBe(false)
    expect(belongsToProject(list[2], null)).toBe(true)
    expect(belongsToProject(list[1], null)).toBe(false)
    expect(scopeCounts(list, 'p1')).toEqual({ all: 5, project: 2 })
  })

  it('treats the implicit sandbox / plain PHP connections as global, never as a project', () => {
    const legacy = snippet('s9', 'Generic helper', { connectionId: 'scratch' })
    expect(snippetProjectId(legacy)).toBeNull()
    expect(snippetProjectId({ connectionId: 'sandbox' })).toBeNull()
    expect(snippetProjectId({ connectionId: '' })).toBeNull()
    expect(snippetProjectId({ connectionId: null })).toBeNull()
    expect(snippetProjectId(list[0])).toBe('p1')
    // A plain PHP tab does not claim it as "its" snippet …
    expect(belongsToProject(legacy, 'scratch')).toBe(false)
    // … and opening it keeps the tab's project (undefined = do not switch), or a new tab inherits the current one.
    expect(snippetOpenConnection(legacy, false, 'local-proj-x')).toBeUndefined()
    expect(snippetOpenConnection(legacy, true, 'local-proj-x')).toBe('local-proj-x')
    expect(snippetOpenConnection(list[0], false, 'local-proj-x')).toBe('p1')
    expect(snippetOpenConnection(list[1], true, null)).toBeNull()
  })

  it('matches the text filter against label, description and code', () => {
    expect(matchesTextFilter(list[0], 'NEWEST')).toBe(true)
    expect(matchesTextFilter(list[1], 'cache:clear')).toBe(true)
    expect(matchesTextFilter(list[1], 'users')).toBe(false)
    expect(matchesTextFilter(list[1], '   ')).toBe(true)
  })
})

describe('snippet filtering', () => {
  const ids = (scope: 'all' | 'project' | 'filter', extra: { projectId?: string | null; filterText?: string; query?: string } = {}): string[] =>
    filterSnippets(list, { scope, projectId: extra.projectId ?? null, filterText: extra.filterText, query: extra.query, projectLabel: label }).map(
      (r) => r.item.id
    )

  it('shows everything alphabetically in the All scope', () => {
    expect(ids('all')).toEqual(['s4', 's2', 's5', 's1', 's3'])
  })

  it('limits the project scope to assigned and project snippets', () => {
    expect(ids('project', { projectId: 'p1' })).toEqual(['s1', 's3'])
    expect(ids('project', { projectId: 'p2' })).toEqual(['s4', 's3'])
    expect(ids('project', { projectId: null })).toEqual(['s3'])
  })

  it('applies the plain text filter in the Filter scope only', () => {
    expect(ids('filter', { filterText: '->get()' })).toEqual(['s4', 's1'])
    expect(ids('filter', { filterText: '' })).toHaveLength(5)
    expect(ids('all', { filterText: '->get()' })).toHaveLength(5)
  })

  it('fuzzy searches labels first, then descriptions, project names and code', () => {
    const results = filterSnippets(list, { scope: 'all', projectId: null, query: 'latst', projectLabel: label })
    expect(results[0].item.id).toBe('s1')
    expect(results[0].keyIndex).toBe(0)

    expect(ids('all', { query: 'acme-shop' })).toEqual(['s1', 's3'])
    const byDescription = filterSnippets(list, { scope: 'all', projectId: null, query: 'app config', projectLabel: label })
    expect(byDescription[0].item.id).toBe('s5')
    expect(ids('all', { query: 'published' })).toEqual(['s4'])
    expect(ids('project', { projectId: 'p1', query: 'orders' })).toEqual(['s3'])
    expect(ids('all', { query: 'qqqzzz' })).toEqual([])
  })
})
