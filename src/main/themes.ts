import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { CustomTheme, MonacoThemeJson, Settings } from '../shared/types'
import { errorMessage, isPlainObject } from './store/common'

/**
 * Custom themes: Monaco theme JSON files (+ an optional `custom` chrome block) in
 * ~/.config/tinkerbox/themes/*.json. Files are validated so a broken theme can never crash Monaco's defineTheme().
 */

const BASES: ReadonlyArray<MonacoThemeJson['base']> = ['vs', 'vs-dark', 'hc-black', 'hc-light']
const MAX_THEME_FILES = 200
const MAX_THEME_SIZE = 2 * 1024 * 1024
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const HEX_TOKEN_COLOR = /^#?(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

export interface ThemeListing {
  themes: CustomTheme[]
  errors: Array<{ file: string; message: string }>
}

/** Validate theme JSON. Invalid colors / rules are dropped; a missing or unknown `base` is an error. */
export function validateThemeJson(raw: unknown): MonacoThemeJson {
  if (!isPlainObject(raw)) throw new Error('Theme must be a JSON object')
  if (!BASES.includes(raw.base as MonacoThemeJson['base'])) {
    throw new Error(`"base" must be one of ${BASES.join(', ')}`)
  }
  const rules: MonacoThemeJson['rules'] = []
  if (Array.isArray(raw.rules)) {
    for (const rule of raw.rules) {
      if (!isPlainObject(rule) || typeof rule.token !== 'string') continue
      const out: MonacoThemeJson['rules'][number] = { token: rule.token }
      if (typeof rule.foreground === 'string' && HEX_TOKEN_COLOR.test(rule.foreground)) out.foreground = rule.foreground.replace(/^#/, '')
      if (typeof rule.background === 'string' && HEX_TOKEN_COLOR.test(rule.background)) out.background = rule.background.replace(/^#/, '')
      if (typeof rule.fontStyle === 'string') out.fontStyle = rule.fontStyle.slice(0, 100)
      rules.push(out)
    }
  }
  const colors: Record<string, string> = {}
  if (isPlainObject(raw.colors)) {
    for (const [key, value] of Object.entries(raw.colors)) {
      if (typeof value === 'string' && HEX_COLOR.test(value)) colors[key] = value
    }
  }
  const theme: MonacoThemeJson = {
    base: raw.base as MonacoThemeJson['base'],
    inherit: raw.inherit !== false,
    rules,
    colors
  }
  if (isPlainObject(raw.custom)) {
    const custom: Record<string, string> = {}
    for (const [key, value] of Object.entries(raw.custom)) {
      if (typeof value === 'string' && value.length <= 200) custom[key] = value
    }
    theme.custom = custom
  }
  return theme
}

/** "night-sky_theme" → "Night Sky Theme". */
export function themeNameFromFile(file: string): string {
  const stem = basename(file, extname(file))
  const words = stem.split(/[-_\s.]+/).filter(Boolean)
  return words.length ? words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') : stem
}

export function slugifyThemeName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || 'theme'
}

function toCustomTheme(file: string, raw: unknown): CustomTheme {
  const theme = validateThemeJson(raw)
  const stem = basename(file, extname(file))
  const name = isPlainObject(raw) && typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 100) : themeNameFromFile(file)
  return { id: `custom:${stem}`, name, file, theme }
}

/** List valid custom themes; invalid files are reported in `errors`. A missing directory yields an empty list. */
export async function listCustomThemes(dir: string): Promise<ThemeListing> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { themes: [], errors: [] }
    throw err
  }
  const files = entries
    .filter((f) => f.toLowerCase().endsWith('.json') && !f.startsWith('.'))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_THEME_FILES)
  const themes: CustomTheme[] = []
  const errors: ThemeListing['errors'] = []
  for (const name of files) {
    const file = join(dir, name)
    try {
      const info = await stat(file)
      if (!info.isFile()) continue
      if (info.size > MAX_THEME_SIZE) throw new Error('file is larger than 2 MB')
      const text = await readFile(file, 'utf8')
      let raw: unknown
      try {
        raw = JSON.parse(text)
      } catch (err) {
        throw new Error(`invalid JSON (${errorMessage(err)})`)
      }
      themes.push(toCustomTheme(file, raw))
    } catch (err) {
      errors.push({ file, message: errorMessage(err) })
    }
  }
  return { themes, errors }
}

/** Create `<dir>/<slug>.json` from a base theme; never overwrites an existing file. */
export async function createCustomTheme(dir: string, name: string, base: unknown): Promise<CustomTheme> {
  const cleanName = name.trim().slice(0, 100)
  if (!cleanName) throw new Error('The theme needs a name')
  const theme = validateThemeJson(base)
  await mkdir(dir, { recursive: true })
  const slug = slugifyThemeName(cleanName)
  const contents = JSON.stringify({ name: cleanName, ...theme }, null, 2) + '\n'
  for (let i = 1; i <= 1000; i++) {
    const file = join(dir, i === 1 ? `${slug}.json` : `${slug}-${i}.json`)
    try {
      await writeFile(file, contents, { flag: 'wx' })
      return { id: `custom:${basename(file, '.json')}`, name: cleanName, file, theme }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  throw new Error('Could not find a free file name for the theme')
}

// ---------------------------------------------------------------------------
// Window chrome colors before the renderer has applied the theme
// ---------------------------------------------------------------------------

export interface ChromeColors {
  background: string
  foreground: string
  dark: boolean
}

/** Approximate chrome colors of the built-in themes (renderer owns the real palettes). */
const BUILTIN_CHROME: Record<string, ChromeColors> = {
  tinkerbox: { background: '#f4f2fb', foreground: '#3b3355', dark: false },
  tinkerboxdark: { background: '#1c1a27', foreground: '#e4e0f5', dark: true },
  dracula: { background: '#282a36', foreground: '#f8f8f2', dark: true },
  graphite: { background: '#15171c', foreground: '#e6e8ec', dark: true },
  paper: { background: '#f7f4ee', foreground: '#2a2620', dark: false },
  material: { background: '#263238', foreground: '#eeffff', dark: true },
  nightowl: { background: '#011627', foreground: '#d6deeb', dark: true },
  nord: { background: '#2e3440', foreground: '#d8dee9', dark: true },
  shadesofpurple: { background: '#2d2b55', foreground: '#ffffff', dark: true },
  glacier: { background: '#eef4f8', foreground: '#1f2f3d', dark: false },
  solarizeddark: { background: '#002b36', foreground: '#93a1a1', dark: true },
  solarizedlight: { background: '#fdf6e3', foreground: '#586e75', dark: false },
  github: { background: '#ffffff', foreground: '#24292f', dark: false },
  githubdark: { background: '#0d1117', foreground: '#c9d1d9', dark: true },
  sage: { background: '#f2f2ea', foreground: '#2b2e22', dark: false },
  lagoon: { background: '#0e1d24', foreground: '#d9ecef', dark: true },
  onedark: { background: '#282c34', foreground: '#abb2bf', dark: true },
  monokai: { background: '#272822', foreground: '#f8f8f2', dark: true }
}

const FALLBACK_LIGHT = BUILTIN_CHROME.tinkerbox
const FALLBACK_DARK = BUILTIN_CHROME.tinkerboxdark

/** Theme id in effect for the given settings and OS appearance. */
export function effectiveThemeId(settings: Pick<Settings, 'theme' | 'syncThemeWithOs' | 'darkTheme' | 'lightTheme'>, osDark: boolean): string {
  if (settings.syncThemeWithOs) return osDark ? settings.darkTheme : settings.lightTheme
  return settings.theme
}

export function chromeColorsFor(themeId: string, customThemes: CustomTheme[] = []): ChromeColors {
  if (themeId.startsWith('custom:')) {
    const custom = customThemes.find((t) => t.id === themeId)
    if (custom) {
      const dark = custom.theme.base === 'vs-dark' || custom.theme.base === 'hc-black'
      const fallback = dark ? FALLBACK_DARK : FALLBACK_LIGHT
      const c = custom.theme.custom ?? {}
      const pick = (...values: Array<string | undefined>): string | undefined =>
        values.find((v) => typeof v === 'string' && HEX_COLOR.test(v))
      return {
        background: pick(c['primary.background'], custom.theme.colors['editor.background']) ?? fallback.background,
        foreground: pick(c['primary.foreground'], c.text, custom.theme.colors['editor.foreground']) ?? fallback.foreground,
        dark
      }
    }
  }
  const key = themeId.toLowerCase().replace(/[^a-z0-9]/g, '')
  const known = BUILTIN_CHROME[key]
  if (known) return known
  return /dark|night|black|midnight/.test(key) ? FALLBACK_DARK : FALLBACK_LIGHT
}
