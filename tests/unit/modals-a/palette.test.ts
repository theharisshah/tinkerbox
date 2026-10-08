import { describe, expect, it, vi } from 'vitest'
import {
  buildPaletteGroups,
  DEFAULT_PALETTE_LIMITS,
  firstSelectable,
  flattenPalette,
  moveSelection,
  paletteEmptyText,
  parsePaletteQuery,
  withPrefix,
  type PaletteGroupId,
  type PaletteItem,
  type PaletteSources
} from '@/components/modals/palette/palette'

function item(group: PaletteGroupId, title: string, extra: Partial<PaletteItem> = {}): PaletteItem {
  return { key: `${group}:${title}`, group, title, run: vi.fn(), ...extra }
}

const sources: PaletteSources = {
  start: [item('start', 'Open Laravel Sandbox'), item('start', 'Open local directory…'), item('start', 'Show Get Started'), item('start', 'Open Code Example')],
  commands: [
    item('commands', 'Run Code', { shortcut: 'CmdOrCtrl+R' }),
    item('commands', 'Stop Running Code', { disabled: true }),
    item('commands', 'Toggle History'),
    item('commands', 'Toggle Snippets'),
    item('commands', 'Prettify Code'),
    item('commands', 'New Tab'),
    item('commands', 'Close Tab'),
    item('commands', 'Zoom In'),
    item('commands', 'Zoom Out')
  ],
  folders: [item('folders', 'acme-shop', { description: '~/Code/acme-shop', supportsNewTab: true }), item('folders', 'blog', { description: '~/Code/blog' })],
  snippets: [item('snippets', 'Latest users', { keywords: 'User::latest()->take(5)->get()' }), item('snippets', 'Clear cache')],
  herd: [item('herd', 'laravel-docs', { description: 'laravel-docs.test' })]
}

describe('palette query prefixes', () => {
  it('parses # / > prefixes and trims the text', () => {
    expect(parsePaletteQuery('')).toEqual({ mode: 'all', prefix: '', text: '' })
    expect(parsePaletteQuery('  users ')).toEqual({ mode: 'all', prefix: '', text: 'users' })
    expect(parsePaletteQuery('#users')).toEqual({ mode: 'snippets', prefix: '#', text: 'users' })
    expect(parsePaletteQuery('/ acme')).toEqual({ mode: 'folders', prefix: '/', text: 'acme' })
    expect(parsePaletteQuery('> zoom in')).toEqual({ mode: 'commands', prefix: '>', text: 'zoom in' })
    expect(parsePaletteQuery('  >')).toEqual({ mode: 'commands', prefix: '>', text: '' })
    // Only a leading prefix counts.
    expect(parsePaletteQuery('a#b').mode).toBe('all')
  })

  it('only says “Nothing matches” when there is search text', () => {
    const counts = { snippets: 0, recentFolders: 0 }
    expect(paletteEmptyText(parsePaletteQuery('#'), counts)).toEqual({
      title: 'No snippets yet',
      hint: 'Save code with “Add Code to Snippets” and it shows up here.'
    })
    expect(paletteEmptyText(parsePaletteQuery('/'), counts).title).toBe('No recent folders yet')
    expect(paletteEmptyText(parsePaletteQuery('#users'), counts)).toEqual({ title: 'Nothing matches “users”', hint: 'You have no snippets yet.' })
    expect(paletteEmptyText(parsePaletteQuery('zzz'), { snippets: 3, recentFolders: 2 })).toEqual({
      title: 'Nothing matches “zzz”',
      hint: 'Try fewer letters or another prefix.'
    })
    expect(paletteEmptyText(parsePaletteQuery('>'), counts).title).not.toContain('“”')
  })

  it('builds queries for a mode', () => {
    expect(withPrefix('snippets', 'users')).toBe('#users')
    expect(withPrefix('folders', '')).toBe('/')
    expect(withPrefix('commands', 'run')).toBe('>run')
    expect(withPrefix('all', 'run')).toBe('run')
  })
})

describe('palette grouping', () => {
  it('shows every group in the default order without a query, with per-group limits', () => {
    const groups = buildPaletteGroups(sources, '')
    expect(groups.map((g) => g.id)).toEqual(['start', 'commands', 'folders', 'snippets', 'herd'])
    expect(groups.map((g) => g.title)).toEqual(['Get started', 'Commands', 'Recent folders', 'Snippets', 'Herd sites'])
    const commands = groups.find((g) => g.id === 'commands')!
    expect(commands.hits).toHaveLength(DEFAULT_PALETTE_LIMITS.browse.commands!)
    expect(commands.total).toBe(9)
  })

  it('narrows to one group with a prefix and lifts the limit', () => {
    const commands = buildPaletteGroups(sources, '>')
    expect(commands.map((g) => g.id)).toEqual(['commands'])
    expect(commands[0].hits).toHaveLength(9)

    const snippets = buildPaletteGroups(sources, '#users')
    expect(snippets.map((g) => g.id)).toEqual(['snippets'])
    expect(snippets[0].hits.map((h) => h.item.title)).toEqual(['Latest users'])

    const folders = buildPaletteGroups(sources, '/blog')
    expect(folders).toHaveLength(1)
    expect(folders[0].hits.map((h) => h.item.title)).toEqual(['blog'])
  })

  it('searches secondary text (descriptions, keywords) but only highlights title matches', () => {
    const groups = buildPaletteGroups(sources, '#take(5)')
    expect(groups[0].hits[0].item.title).toBe('Latest users')
    expect(groups[0].hits[0].titleIndices).toEqual([])

    const zoom = buildPaletteGroups(sources, '>zoom')
    expect(zoom[0].hits[0].titleIndices).toEqual([0, 1, 2, 3])
  })

  it('orders groups by their best match while searching and drops empty groups', () => {
    const groups = buildPaletteGroups(sources, 'acme')
    expect(groups[0].id).toBe('folders')
    expect(groups.every((g) => g.hits.length > 0)).toBe(true)

    const history = buildPaletteGroups(sources, 'toggle history')
    expect(history[0].id).toBe('commands')
    expect(history[0].hits[0].item.title).toBe('Toggle History')

    expect(buildPaletteGroups(sources, '#nothing-like-this')).toEqual([])
  })

  it('flattens groups for keyboard navigation and skips disabled items', () => {
    const groups = buildPaletteGroups(sources, '>')
    const hits = flattenPalette(groups)
    expect(firstSelectable(hits)).toBe(0)
    // Index 1 is the disabled "Stop Running Code".
    expect(moveSelection(hits, 0, 1)).toBe(2)
    expect(moveSelection(hits, 2, -1)).toBe(0)
    // Wraps around.
    expect(moveSelection(hits, 0, -1)).toBe(hits.length - 1)
    expect(moveSelection(hits, hits.length - 1, 1)).toBe(0)
    expect(moveSelection([], 0, 1)).toBe(-1)
    const onlyDisabled = flattenPalette(buildPaletteGroups(sources, '>stop running'))
    expect(firstSelectable(onlyDisabled.filter((h) => h.item.disabled))).toBe(-1)
  })
})

describe('palette typo tolerance', () => {
  it('hides typo-only matches when something matches clearly', () => {
    const groups = buildPaletteGroups(sources, 'acme')
    const titles = flattenPalette(groups).map((h) => h.item.title)
    expect(titles[0]).toBe('acme-shop')
    // "Clear cache" would only match "acme" with a typo.
    expect(titles).not.toContain('Clear cache')
  })

  it('still finds typos when nothing matches clearly', () => {
    const titles = flattenPalette(buildPaletteGroups(sources, '>prettfy')).map((h) => h.item.title)
    expect(titles[0]).toBe('Prettify Code')
    // "histroy" swaps two letters: neither a substring nor a subsequence of "Toggle History".
    const typo = flattenPalette(buildPaletteGroups(sources, 'histroy')).map((h) => h.item.title)
    expect(typo).toEqual(['Toggle History'])
  })
})
