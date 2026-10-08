import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CustomTheme, MonacoThemeJson } from '@shared/types'
import {
  allThemes,
  applyTheme,
  builtinThemes,
  effectiveThemeId,
  getTheme,
  normalizeThemeId,
  resolveTheme,
  setCustomThemes,
  THEME_VARS,
  themeForSettings,
  themeSettingsMigration
} from '@/themes'
import { contrastRatio, flatten, isDark, isHexColor } from '@/utils/color'

const EXPECTED = [
  ['tinkerbox', 'Tinkerbox', false],
  ['tinkerbox-dark', 'Tinkerbox Dark', true],
  ['dracula', 'Dracula', true],
  ['graphite', 'Graphite', true],
  ['paper', 'Paper', false],
  ['material', 'Material', true],
  ['night-owl', 'Night Owl', true],
  ['nord', 'Nord', true],
  ['shades-of-purple', 'Shades of Purple', true],
  ['glacier', 'Glacier', false],
  ['solarized-dark', 'Solarized Dark', true],
  ['solarized-light', 'Solarized Light', false],
  ['github', 'GitHub', false],
  ['github-dark', 'GitHub Dark', true],
  ['sage', 'Sage', false],
  ['lagoon', 'Lagoon', true],
  ['one-dark', 'One Dark', true],
  ['monokai', 'Monokai', true]
] as const

const PHP_TOKENS = ['', 'comment', 'string', 'number', 'keyword', 'variable', 'delimiter', 'metatag', 'type', 'constant']

describe('built-in themes', () => {
  const themes = builtinThemes()

  it('ships exactly the documented line-up, Tinkerbox first', () => {
    expect(themes.map((t) => [t.id, t.name, t.dark])).toEqual(EXPECTED.map((e) => [...e]))
  })

  it('has unique ids and valid Monaco theme names', () => {
    expect(new Set(themes.map((t) => t.id)).size).toBe(themes.length)
    expect(new Set(themes.map((t) => t.monacoName)).size).toBe(themes.length)
    for (const t of themes) expect(t.monacoName).toMatch(/^[a-z0-9-]+$/)
  })

  for (const theme of builtinThemes()) {
    describe(theme.name, () => {
      it('defines every CSS variable as a hex color', () => {
        for (const name of THEME_VARS) {
          expect(isHexColor(theme.vars[name]), `${name} = ${theme.vars[name]}`).toBe(true)
        }
        expect(Object.keys(theme.vars).sort()).toEqual([...THEME_VARS].sort())
      })

      it('matches its dark flag', () => {
        expect(isDark(theme.vars['--tw-bg'])).toBe(theme.dark)
        expect(isDark(theme.vars['--tw-editor-bg'])).toBe(theme.dark)
        expect(theme.monaco.base).toBe(theme.dark ? 'vs-dark' : 'vs')
      })

      it('keeps text readable', () => {
        expect(contrastRatio(theme.vars['--tw-text'], theme.vars['--tw-bg'])).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(theme.vars['--tw-text'], theme.vars['--tw-surface'])).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(theme.vars['--tw-text-muted'], theme.vars['--tw-bg'])).toBeGreaterThanOrEqual(2.8)
        expect(contrastRatio(theme.vars['--tw-accent-fg'], theme.vars['--tw-accent'])).toBeGreaterThanOrEqual(3)
        expect(contrastRatio(theme.vars['--tw-accent'], theme.vars['--tw-surface'])).toBeGreaterThanOrEqual(2.3)
      })

      it('keeps selected suggestion, list and menu rows readable in Monaco widgets', () => {
        const c = theme.monaco.colors
        const pairs: Array<[fg: string, bg: string, base: string]> = [
          ['editorSuggestWidget.selectedForeground', 'editorSuggestWidget.selectedBackground', 'editorSuggestWidget.background'],
          ['editorSuggestWidget.foreground', 'editorSuggestWidget.background', 'editorSuggestWidget.background'],
          ['list.activeSelectionForeground', 'list.activeSelectionBackground', 'editorWidget.background'],
          ['quickInputList.focusForeground', 'quickInputList.focusBackground', 'editorWidget.background'],
          ['menu.selectionForeground', 'menu.selectionBackground', 'menu.background'],
          ['menu.foreground', 'menu.background', 'menu.background']
        ]
        for (const [fgKey, bgKey, baseKey] of pairs) {
          expect(isHexColor(c[fgKey]), fgKey).toBe(true)
          const background = flatten(c[bgKey], flatten(c[baseKey], c['editor.background']))
          expect(contrastRatio(c[fgKey], background), `${fgKey} on ${bgKey}`).toBeGreaterThanOrEqual(4.5)
        }
      })

      it('provides Monaco PHP token rules and editor colors', () => {
        const tokens = theme.monaco.rules.map((r) => r.token)
        for (const token of PHP_TOKENS) expect(tokens).toContain(token)
        for (const rule of theme.monaco.rules) {
          if (rule.foreground) expect(rule.foreground).toMatch(/^[0-9a-f]{6}([0-9a-f]{2})?$/)
        }
        expect(theme.monaco.colors['editor.background']).toBe(theme.vars['--tw-editor-bg'])
        for (const key of ['editor.foreground', 'editor.lineHighlightBackground', 'editor.selectionBackground', 'editorCursor.foreground', 'editorLineNumber.foreground']) {
          expect(isHexColor(theme.monaco.colors[key]), key).toBe(true)
        }
      })
    })
  }
})

describe('theme lookup', () => {
  it('normalizes ids and legacy display names', () => {
    expect(normalizeThemeId('Shades Of Purple')).toBe('shades-of-purple')
    expect(normalizeThemeId('custom:My Theme')).toBe('custom:My Theme')
    expect(getTheme('Github')?.id).toBe('github')
    expect(getTheme('night_owl')?.id).toBe('night-owl')
    expect(getTheme('SolarizedDark')?.id).toBe('solarized-dark')
    expect(getTheme('nope')).toBeUndefined()
    expect(getTheme('')).toBeUndefined()
  })

  it('maps the ids of replaced built-in themes to their successors', () => {
    expect(getTheme('kew')?.id).toBe('sage')
    expect(getTheme('Ember Dark')?.id).toBe('graphite')
    expect(themeForSettings({ theme: 'christmas', syncThemeWithOs: false, darkTheme: 'dracula', lightTheme: 'tinkerbox' }, false).id).toBe('lagoon')
    expect(themeSettingsMigration({ theme: 'snow-forest', darkTheme: 'ember-dark', lightTheme: 'tinkerbox' })).toEqual({
      theme: 'glacier',
      darkTheme: 'graphite'
    })
    expect(themeSettingsMigration({ theme: 'github', darkTheme: 'dracula', lightTheme: 'custom:kew' })).toBeNull()
  })

  it('falls back to the default light/dark theme', () => {
    expect(resolveTheme('missing').id).toBe('tinkerbox')
    expect(resolveTheme('missing', true).id).toBe('tinkerbox-dark')
    expect(resolveTheme('custom:gone', true).id).toBe('tinkerbox-dark')
  })

  it('follows the OS when syncing', () => {
    const s = { theme: 'github', syncThemeWithOs: true, darkTheme: 'dracula', lightTheme: 'sage' }
    expect(effectiveThemeId(s, true)).toBe('dracula')
    expect(effectiveThemeId(s, false)).toBe('sage')
    expect(effectiveThemeId({ ...s, syncThemeWithOs: false }, true)).toBe('github')
    expect(themeForSettings({ ...s, darkTheme: 'missing' }, true).id).toBe('tinkerbox-dark')
  })
})

describe('custom themes', () => {
  const fixtures = join(__dirname, '../../fixtures/themes')
  const load = (file: string): MonacoThemeJson => {
    const raw = JSON.parse(readFileSync(join(fixtures, file), 'utf8')) as MonacoThemeJson & { custom?: Record<string, unknown> }
    // The main process keeps only string values of the `custom` block (see src/main/themes.ts).
    const custom = Object.fromEntries(Object.entries(raw.custom ?? {}).filter(([, v]) => typeof v === 'string')) as Record<string, string>
    return { ...raw, custom }
  }

  it('derives the chrome from a dark custom theme', () => {
    const custom: CustomTheme = { id: 'custom:dark-example', name: 'Dark Example', file: '/x/dark-example.json', theme: load('dark-example.json') }
    const [def] = setCustomThemes([custom])
    expect(def.custom).toBe(true)
    expect(def.dark).toBe(true)
    expect(def.vars['--tw-accent']).toBe('#e06c9f')
    for (const name of THEME_VARS) expect(isHexColor(def.vars[name]), name).toBe(true)
    // Monaco data is the user's theme, untouched.
    expect(def.monaco.base).toBe('vs-dark')
    expect(def.monaco.colors['editor.background']).toBe('#1f2130')
    expect(getTheme('custom:dark-example')).toBe(def)
    expect(allThemes()).toContain(def)
  })

  it('derives a light theme and falls back for missing keys', () => {
    const minimal: CustomTheme = {
      id: 'custom:min',
      name: 'Min',
      file: '/x/min.json',
      theme: { base: 'vs', inherit: true, rules: [], colors: {} }
    }
    const light: CustomTheme = { id: 'custom:light', name: 'Light', file: '/x/light.json', theme: load('light-example.json') }
    const [min, lightDef] = setCustomThemes([minimal, light])
    expect(min.dark).toBe(false)
    expect(lightDef.vars['--tw-accent']).toBe('#1a73e8')
    for (const name of THEME_VARS) expect(isHexColor(min.vars[name]), name).toBe(true)
    setCustomThemes([])
    expect(getTheme('custom:min')).toBeUndefined()
  })
})

describe('applyTheme', () => {
  it('writes CSS variables and the dark flag on the root element', () => {
    const props = new Map<string, string>()
    const el = {
      style: { setProperty: (k: string, v: string) => props.set(k, v), colorScheme: '' },
      dataset: {} as Record<string, string>
    }
    const dracula = getTheme('dracula')!
    applyTheme(dracula, el as unknown as HTMLElement)
    expect(props.get('--tw-bg')).toBe(dracula.vars['--tw-bg'])
    expect(props.size).toBe(THEME_VARS.length)
    expect(el.dataset.dark).toBe('true')
    expect(el.dataset.theme).toBe('dracula')
    expect(el.style.colorScheme).toBe('dark')
  })
})
