import { readonly, ref, shallowRef, watch, type Ref, type ShallowRef } from 'vue'
import type { CustomTheme, Settings } from '@shared/types'
import { api } from '../api'
import { buildTheme, fromCustomTheme, monacoThemeName } from './build'
import { BUILTIN_THEME_SPECS } from './builtins'
import { THEME_VARS, type ThemeDefinition } from './types'

export type { ThemeDefinition, ThemeVars, ThemeVar, MonacoThemeData } from './types'
export { THEME_VARS, monacoThemeName }

/**
 * Theme registry. Built-in themes are built once from their palettes; custom themes come from
 * `themes:listCustom` (~/.config/tinkerbox/themes). The effective theme follows the settings
 * (`theme`, or `darkTheme`/`lightTheme` when `syncThemeWithOs`) and is applied as CSS variables on :root.
 *
 * This module never imports Monaco: the editor module registers `allThemes()` with monaco.editor.defineTheme()
 * and follows `currentTheme` (a shallow ref) with monaco.editor.setTheme(theme.monacoName).
 */

export const DEFAULT_LIGHT_THEME_ID = 'tinkerbox'
export const DEFAULT_DARK_THEME_ID = 'tinkerbox-dark'

const BUILTINS: readonly ThemeDefinition[] = Object.freeze(BUILTIN_THEME_SPECS.map((spec) => buildTheme(spec)))

/** Built-in themes of older versions that were replaced: old id → id of the closest current theme. */
export const RENAMED_THEMES: Readonly<Record<string, string>> = Object.freeze({
  'ember-dark': 'graphite',
  'ember-light': 'paper',
  'snow-forest': 'glacier',
  kew: 'sage',
  christmas: 'lagoon'
})

const customThemes: ShallowRef<readonly ThemeDefinition[]> = shallowRef([])
const previewId = ref<string | null>(null)

function systemPrefersDark(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false
  } catch {
    // matchMedia can throw in exotic embedders; assume light.
    return false
  }
}

/** OS dark mode (matchMedia + the main process' 'theme:osChanged' event). */
export const osDark: Ref<boolean> = ref(systemPrefersDark())

/** The theme currently applied to the UI (includes a live preview from the Themes modal). */
export const currentTheme: ShallowRef<ThemeDefinition> = shallowRef(BUILTINS[0])

/** Read-only view of the custom themes (reactive). */
export const customThemesRef = readonly(customThemes)

/** Theme id being previewed (Themes modal), or null. */
export const previewThemeId = readonly(previewId)

/** "Shades Of Purple" → "shades-of-purple"; custom ids ("custom:x") are kept as-is. */
export function normalizeThemeId(id: string): string {
  if (typeof id !== 'string') return ''
  const trimmed = id.trim()
  if (trimmed.startsWith('custom:')) return trimmed
  return trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function compactId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, '')
}

const RENAMED_BY_COMPACT_ID = new Map(Object.entries(RENAMED_THEMES).map(([from, to]) => [compactId(from), to]))

/** Current id of a built-in theme that was replaced ("Kew" → "sage"); other ids are returned unchanged. */
export function currentThemeId(id: string): string {
  if (typeof id !== 'string' || id.startsWith('custom:')) return id
  return RENAMED_BY_COMPACT_ID.get(compactId(id)) ?? id
}

/** Settings patch moving theme settings off replaced built-in theme ids, or null when nothing needs to change. */
export function themeSettingsMigration(settings: Pick<Settings, 'theme' | 'darkTheme' | 'lightTheme'>): Partial<Settings> | null {
  const patch: Partial<Settings> = {}
  for (const key of ['theme', 'darkTheme', 'lightTheme'] as const) {
    const next = currentThemeId(settings[key])
    if (next !== settings[key]) patch[key] = next
  }
  return Object.keys(patch).length > 0 ? patch : null
}

export function builtinThemes(): readonly ThemeDefinition[] {
  return BUILTINS
}

export function customThemeList(): readonly ThemeDefinition[] {
  return customThemes.value
}

/** Built-in themes followed by custom themes. */
export function allThemes(): ThemeDefinition[] {
  return [...BUILTINS, ...customThemes.value]
}

/** Find a theme by id (built-in slug in any casing/spacing, e.g. "Github" or "night_owl", or "custom:<file>"). */
export function getTheme(id: string | null | undefined): ThemeDefinition | undefined {
  if (!id) return undefined
  if (id.startsWith('custom:')) return customThemes.value.find((t) => t.id === id)
  const wanted = compactId(normalizeThemeId(currentThemeId(id)))
  if (wanted === '') return undefined
  return BUILTINS.find((t) => compactId(t.id) === wanted)
}

/** Like getTheme() but never undefined: falls back to the default light / dark theme. */
export function resolveTheme(id: string | null | undefined, preferDark = false): ThemeDefinition {
  return getTheme(id) ?? (getTheme(preferDark ? DEFAULT_DARK_THEME_ID : DEFAULT_LIGHT_THEME_ID) as ThemeDefinition)
}

type ThemeSettings = Pick<Settings, 'theme' | 'syncThemeWithOs' | 'darkTheme' | 'lightTheme'>

/** Theme id in effect for the settings and the OS appearance. */
export function effectiveThemeId(settings: ThemeSettings, dark: boolean): string {
  if (settings.syncThemeWithOs) return dark ? settings.darkTheme : settings.lightTheme
  return settings.theme
}

/** Theme in effect for the settings (with fallbacks). */
export function themeForSettings(settings: ThemeSettings, dark: boolean): ThemeDefinition {
  const id = effectiveThemeId(settings, dark)
  return resolveTheme(id, settings.syncThemeWithOs ? dark : false)
}

/** Write the theme's CSS variables on :root (or the given element) and mark dark/light. */
export function applyTheme(theme: ThemeDefinition, root?: HTMLElement): void {
  const el = root ?? (typeof document !== 'undefined' ? document.documentElement : undefined)
  if (!el) return
  for (const name of THEME_VARS) el.style.setProperty(name, theme.vars[name])
  el.dataset.dark = theme.dark ? 'true' : 'false'
  el.dataset.theme = theme.id
  el.style.colorScheme = theme.dark ? 'dark' : 'light'
}

/** Replace the custom themes (from 'themes:listCustom'). */
export function setCustomThemes(list: readonly CustomTheme[]): ThemeDefinition[] {
  const defs: ThemeDefinition[] = []
  for (const custom of list) {
    try {
      defs.push(fromCustomTheme(custom))
    } catch (err) {
      console.warn(`Skipping custom theme ${custom?.id}:`, err)
    }
  }
  customThemes.value = defs
  return defs
}

let loading: Promise<ThemeDefinition[]> | null = null

/** (Re)load custom themes from disk. Concurrent calls share one request. */
export function loadCustomThemes(): Promise<ThemeDefinition[]> {
  if (loading) return loading
  loading = api
    .invoke('themes:listCustom')
    .then((list) => setCustomThemes(list))
    .catch((err: unknown) => {
      console.warn('Could not load custom themes:', api.errorText(err))
      return [...customThemes.value]
    })
    .finally(() => {
      loading = null
    })
  return loading
}

/** Temporarily show another theme (Themes modal live preview). Pass null to go back to the configured theme. */
export function previewTheme(id: string | null): void {
  previewId.value = id
}

let syncStop: (() => void) | null = null

/**
 * Keep `currentTheme` and :root in sync with the settings, the OS appearance, custom themes and previews.
 * `source` returns the theme-related settings (normally the settings store). Returns a stop function.
 */
export function startThemeSync(source: () => ThemeSettings): () => void {
  syncStop?.()
  const cleanups: Array<() => void> = []

  const update = (): void => {
    const settings = source()
    const preview = previewId.value ? getTheme(previewId.value) : undefined
    const theme = preview ?? themeForSettings(settings, osDark.value)
    if (currentTheme.value !== theme) currentTheme.value = theme
    applyTheme(theme)
  }

  cleanups.push(
    watch(
      () => {
        const s = source()
        return [s.theme, s.syncThemeWithOs, s.darkTheme, s.lightTheme, osDark.value, previewId.value, customThemes.value]
      },
      update,
      { immediate: true }
    )
  )

  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    try {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const onChange = (e: MediaQueryListEvent): void => {
        osDark.value = e.matches
      }
      mq.addEventListener('change', onChange)
      cleanups.push(() => mq.removeEventListener('change', onChange))
    } catch {
      // No media queries: rely on the main process event below.
    }
  }
  try {
    cleanups.push(api.on('theme:osChanged', ({ dark }) => (osDark.value = dark)))
  } catch (err) {
    console.warn('theme:osChanged unavailable:', err)
  }

  syncStop = () => {
    for (const fn of cleanups.splice(0)) fn()
    syncStop = null
  }
  return syncStop
}
