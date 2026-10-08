import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveAppPaths, themesDir, userDataOverride, USER_DATA_ENV } from '../../../src/main/paths'
import { normalizeWindowState, restoreBounds } from '../../../src/main/store/windowState'
import {
  chromeColorsFor,
  createCustomTheme,
  effectiveThemeId,
  listCustomThemes,
  slugifyThemeName,
  themeNameFromFile,
  validateThemeJson
} from '../../../src/main/themes'
import { tempDirs } from './helpers'

const tmp = tempDirs()
afterEach(() => tmp.cleanup())

const base = {
  base: 'vs-dark',
  inherit: true,
  rules: [{ token: 'comment', foreground: '6272a4', fontStyle: 'italic' }],
  colors: { 'editor.background': '#282a36', 'editor.foreground': '#f8f8f2' },
  custom: { 'primary.background': '#21222c' }
}

describe('custom themes', () => {
  it('validates theme JSON, dropping invalid colors and rules', () => {
    const theme = validateThemeJson({
      ...base,
      rules: [...base.rules, { token: 5 }, { token: 'string', foreground: 'not-a-color' }],
      colors: { ...base.colors, 'editor.lineHighlightBackground': 'red', bad: 3 }
    })
    expect(theme.rules).toEqual([{ token: 'comment', foreground: '6272a4', fontStyle: 'italic' }, { token: 'string' }])
    expect(theme.colors).toEqual(base.colors)
    expect(() => validateThemeJson({ ...base, base: 'monokai' })).toThrow(/base/)
    expect(() => validateThemeJson([])).toThrow()
  })

  it('lists valid themes and reports invalid files', async () => {
    const dir = tmp.make()
    writeFileSync(join(dir, 'night-sky.json'), JSON.stringify(base))
    writeFileSync(join(dir, 'named.json'), JSON.stringify({ ...base, base: 'vs', name: 'My Light' }))
    writeFileSync(join(dir, 'broken.json'), '{nope')
    writeFileSync(join(dir, 'wrong-base.json'), JSON.stringify({ ...base, base: 'x' }))
    writeFileSync(join(dir, 'readme.txt'), 'ignored')
    mkdirSync(join(dir, 'folder.json'))
    const { themes, errors } = await listCustomThemes(dir)
    expect(themes.map((t) => [t.id, t.name])).toEqual([
      ['custom:named', 'My Light'],
      ['custom:night-sky', 'Night Sky']
    ])
    expect(errors.map((e) => e.file.split('/').pop())).toEqual(['broken.json', 'wrong-base.json'])
    expect(errors[0].message).toContain('invalid JSON')
  })

  it('returns an empty list when the folder does not exist', async () => {
    expect(await listCustomThemes(join(tmp.make(), 'missing'))).toEqual({ themes: [], errors: [] })
  })

  it('creates a theme file with a unique slug and never overwrites', async () => {
    const dir = join(tmp.make(), 'themes')
    const first = await createCustomTheme(dir, 'My Theme!', base)
    const second = await createCustomTheme(dir, 'My Theme!', base)
    expect(first.id).toBe('custom:my-theme')
    expect(second.id).toBe('custom:my-theme-2')
    expect(JSON.parse(readFileSync(first.file, 'utf8'))).toMatchObject({ name: 'My Theme!', base: 'vs-dark' })
    const { themes } = await listCustomThemes(dir)
    expect(themes.map((t) => t.name)).toEqual(['My Theme!', 'My Theme!'])
    await expect(createCustomTheme(dir, '   ', base)).rejects.toThrow(/name/)
  })

  it('derives names and slugs', () => {
    expect(themeNameFromFile('/x/solarized_dark-plus.json')).toBe('Solarized Dark Plus')
    expect(slugifyThemeName('Café Crème')).toBe('cafe-creme')
    expect(slugifyThemeName('!!!')).toBe('theme')
  })

  it('computes window chrome colors for built-in and custom themes', async () => {
    expect(chromeColorsFor('dracula')).toEqual({ background: '#282a36', foreground: '#f8f8f2', dark: true })
    expect(chromeColorsFor('Night Owl').dark).toBe(true)
    expect(chromeColorsFor('tinkerbox').dark).toBe(false)
    expect(chromeColorsFor('some-unknown-dark-theme').dark).toBe(true)
    const dir = tmp.make()
    writeFileSync(join(dir, 'mine.json'), JSON.stringify(base))
    const { themes } = await listCustomThemes(dir)
    expect(chromeColorsFor('custom:mine', themes)).toEqual({ background: '#21222c', foreground: '#f8f8f2', dark: true })
    expect(effectiveThemeId({ theme: 'nord', syncThemeWithOs: true, darkTheme: 'dracula', lightTheme: 'github' }, true)).toBe('dracula')
    expect(effectiveThemeId({ theme: 'nord', syncThemeWithOs: false, darkTheme: 'dracula', lightTheme: 'github' }, true)).toBe('nord')
  })
})

describe('paths', () => {
  it('uses ~/.config/tinkerbox/themes on every platform and the repo resources in development', () => {
    expect(themesDir('/home/me')).toBe('/home/me/.config/tinkerbox/themes')
    const dev = resolveAppPaths({ userData: '/data', appPath: '/repo', isPackaged: false, processResourcesPath: '/electron/res', home: '/home/me' })
    expect(dev.resources).toBe('/repo/resources')
    expect(dev.cliTemplate).toBe('/repo/resources/bin/tinkerbox.sh')
    expect(dev.files.settings).toBe('/data/settings.json')
    const packaged = resolveAppPaths({ userData: '/data', appPath: '/App/app.asar', isPackaged: true, processResourcesPath: '/App/Resources', home: '/home/me' })
    expect(packaged.resources).toBe('/App/Resources')
    expect(packaged.configDir).toBe('/home/me/.config/tinkerbox')
    expect(packaged.drivers).toBe('/home/me/.config/tinkerbox/drivers')
  })

  it('reads an isolated user-data directory from --user-data-dir= or the environment (switch wins)', () => {
    expect(userDataOverride(['electron', '.'], {}, '/cwd')).toBeNull()
    expect(userDataOverride(['electron', '.', '--user-data-dir=/tmp/p1'], {}, '/cwd')).toBe('/tmp/p1')
    expect(userDataOverride(['electron', '.', '--user-data-dir=rel/dir'], {}, '/cwd')).toBe('/cwd/rel/dir')
    expect(userDataOverride(['electron', '.'], { [USER_DATA_ENV]: '/tmp/env' }, '/cwd')).toBe('/tmp/env')
    expect(userDataOverride(['electron', '--user-data-dir=/tmp/flag'], { [USER_DATA_ENV]: '/tmp/env' }, '/cwd')).toBe('/tmp/flag')
    // Blank values are ignored; the two-argument form is not a Chromium switch (and would be an open target).
    expect(userDataOverride(['electron', '--user-data-dir='], { [USER_DATA_ENV]: '  ' }, '/cwd')).toBeNull()
    expect(userDataOverride(['electron', '--user-data-dir', '/tmp/x'], {}, '/cwd')).toBeNull()
    expect(userDataOverride(['electron', '--', '--user-data-dir=/tmp/x'], {}, '/cwd')).toBeNull()
  })
})

describe('window state', () => {
  const primary = { x: 0, y: 25, width: 1440, height: 875 }

  it('keeps a saved position that is visible on a display', () => {
    expect(restoreBounds({ x: 100, y: 100, width: 1200, height: 800, maximized: false }, [primary], primary)).toEqual({
      x: 100,
      y: 100,
      width: 1200,
      height: 800
    })
  })

  it('centers windows whose saved position is off-screen (display disconnected)', () => {
    const bounds = restoreBounds({ x: 3000, y: 200, width: 1200, height: 800, maximized: false }, [primary], primary)
    expect(bounds).toEqual({ x: 120, y: 63, width: 1200, height: 800 })
  })

  it('enforces the minimum size and clamps to the work area', () => {
    expect(restoreBounds({ width: 300, height: 200, maximized: false }, [primary], primary)).toMatchObject({ width: 910, height: 630 })
    expect(restoreBounds({ width: 5000, height: 4000, maximized: false }, [primary], primary)).toMatchObject({ width: 1440, height: 875 })
  })

  it('uses a secondary display when the window is there', () => {
    const second = { x: 1440, y: 0, width: 1920, height: 1080 }
    expect(restoreBounds({ x: 1600, y: 100, width: 1200, height: 800, maximized: true }, [primary, second], primary)).toMatchObject({ x: 1600, y: 100 })
  })

  it('normalizes stored state', () => {
    expect(normalizeWindowState({ width: 1000.4, height: 'x', x: 5 })).toEqual({ width: 1000, height: 820, maximized: false })
    expect(() => normalizeWindowState(null)).toThrow()
  })
})
