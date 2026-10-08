import { SANDBOX_CONNECTION_ID, SCRATCH_CONNECTION_ID, type Snippet } from '@shared/types'
import { fuzzyFilter, type FuzzyResult } from '@/utils/fuzzy'

/** Pure logic of the Snippets modal: scope (All | project | Filter), text filter, fuzzy search and ordering. */

/** all = every snippet; project = assigned to the current project + its project snippets; filter = text filter. */
export type SnippetScope = 'all' | 'project' | 'filter'

export interface SnippetFilter {
  scope: SnippetScope
  /** Concrete connection id of the current project (null when the tab has none). */
  projectId: string | null
  /** Plain text filter of the "Filter" scope: case-insensitive substring of the label, description or code. */
  filterText?: string
  /** Fuzzy search (label first, then description, project name and code). */
  query?: string
  /** Display name of a connection id (searchable). */
  projectLabel?: (connectionId: string) => string
}

/** Project snippets come from `.tinkerbox/snippets` and cannot be edited in the app. */
export function isReadOnlySnippet(snippet: Pick<Snippet, 'source'>): boolean {
  return snippet.source === 'project'
}

/**
 * Real project a snippet is assigned to (opening it switches the tab there), or null for a global snippet. The
 * implicit "Default" (sandbox) and "PHP" (scratch) connections are not projects: older versions stored them for
 * snippets saved from a tab without a project, which then dragged project tabs back to plain PHP.
 */
export function snippetProjectId(snippet: { connectionId?: string | null }): string | null {
  const id = snippet.connectionId
  return id && id !== SCRATCH_CONNECTION_ID && id !== SANDBOX_CONNECTION_ID ? id : null
}

/** Whether the snippet belongs to the project (assigned to it, or defined in its .tinkerbox/snippets). */
export function belongsToProject(snippet: Snippet, projectId: string | null): boolean {
  if (snippet.source === 'project') return true
  return !!projectId && snippetProjectId(snippet) === projectId
}

/**
 * Connection to hand to `tabs.openCode()`: the snippet's project, else (new tab) the current tab's connection, else
 * undefined so the current tab keeps its project.
 */
export function snippetOpenConnection(snippet: { connectionId?: string | null }, newTab: boolean, current: string | null): string | null | undefined {
  const project = snippetProjectId(snippet)
  if (project) return project
  return newTab ? current : undefined
}

/** Case-insensitive substring match on label, description and code; an empty filter matches everything. */
export function matchesTextFilter(snippet: Snippet, filterText: string): boolean {
  const needle = filterText.trim().toLowerCase()
  if (needle === '') return true
  return [snippet.name, snippet.description ?? '', snippet.code].some((text) => text.toLowerCase().includes(needle))
}

/** Alphabetical by label (case-insensitive), then newest first. */
export function sortSnippets(list: readonly Snippet[]): Snippet[] {
  return [...list].sort(
    (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)
  )
}

/** Snippets visible for the filter, as fuzzy results (alphabetical without a query, by relevance with one). */
export function filterSnippets(list: readonly Snippet[], filter: SnippetFilter): FuzzyResult<Snippet>[] {
  let scoped = sortSnippets(list)
  if (filter.scope === 'project') scoped = scoped.filter((s) => belongsToProject(s, filter.projectId))
  else if (filter.scope === 'filter') scoped = scoped.filter((s) => matchesTextFilter(s, filter.filterText ?? ''))
  const label = filter.projectLabel
  return fuzzyFilter(scoped, filter.query ?? '', (s) => [
    s.name,
    s.description,
    snippetProjectId(s) && label ? label(snippetProjectId(s) as string) : undefined,
    s.code
  ])
}

/** Counts shown next to the scope segments. */
export function scopeCounts(list: readonly Snippet[], projectId: string | null): { all: number; project: number } {
  return { all: list.length, project: list.filter((s) => belongsToProject(s, projectId)).length }
}
