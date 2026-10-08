import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { acceleratorToMonaco, hasModifier } from '../../../src/renderer/src/monaco/keybindings'
import { matchScore, rankNames } from '../../../src/renderer/src/monaco/matching'
import { editorOptions, tabSizeOf } from '../../../src/renderer/src/monaco/options'

describe('accelerators → Monaco keybindings', () => {
  it('maps CmdOrCtrl to ⌘ on macOS and Ctrl elsewhere', () => {
    expect(acceleratorToMonaco('CmdOrCtrl+R', 'darwin')).toEqual({ ctrlCmd: true, winCtrl: false, alt: false, shift: false, keyCode: 'KeyR' })
    expect(acceleratorToMonaco('CmdOrCtrl+Shift+P', 'win32')).toEqual({ ctrlCmd: true, winCtrl: false, alt: false, shift: true, keyCode: 'KeyP' })
    // Ctrl on macOS is Monaco's WinCtrl
    expect(acceleratorToMonaco('Ctrl+L', 'darwin')).toEqual({ ctrlCmd: false, winCtrl: true, alt: false, shift: false, keyCode: 'KeyL' })
    expect(acceleratorToMonaco('Ctrl+L', 'linux')?.ctrlCmd).toBe(true)
  })

  it('maps digits, punctuation, function and named keys', () => {
    expect(acceleratorToMonaco('CmdOrCtrl+0', 'darwin')?.keyCode).toBe('Digit0')
    expect(acceleratorToMonaco('CmdOrCtrl+=', 'darwin')?.keyCode).toBe('Equal')
    expect(acceleratorToMonaco('CmdOrCtrl+-', 'darwin')?.keyCode).toBe('Minus')
    expect(acceleratorToMonaco('CmdOrCtrl+,', 'darwin')?.keyCode).toBe('Comma')
    expect(acceleratorToMonaco('Ctrl+.', 'darwin')?.keyCode).toBe('Period')
    expect(acceleratorToMonaco('CmdOrCtrl+\\', 'darwin')?.keyCode).toBe('Backslash')
    expect(acceleratorToMonaco('CmdOrCtrl+Alt+Shift+O', 'darwin')).toMatchObject({ alt: true, shift: true, keyCode: 'KeyO' })
    expect(acceleratorToMonaco('F5', 'win32')?.keyCode).toBe('F5')
    expect(acceleratorToMonaco('Ctrl+Tab', 'darwin')?.keyCode).toBe('Tab')
    expect(acceleratorToMonaco('Escape', 'darwin')?.keyCode).toBe('Escape')
    expect(acceleratorToMonaco('Alt+Up', 'darwin')?.keyCode).toBe('UpArrow')
    expect(acceleratorToMonaco('CmdOrCtrl+Plus', 'darwin')).toMatchObject({ keyCode: 'Equal', shift: true })
    expect(acceleratorToMonaco('', 'darwin')).toBeNull()
  })

  it('knows which accelerators have a modifier', () => {
    expect(hasModifier(acceleratorToMonaco('Escape', 'darwin')!)).toBe(false)
    expect(hasModifier(acceleratorToMonaco('Shift+Tab', 'darwin')!)).toBe(false)
    expect(hasModifier(acceleratorToMonaco('CmdOrCtrl+B', 'darwin')!)).toBe(true)
    expect(hasModifier(acceleratorToMonaco('Ctrl+Tab', 'darwin')!)).toBe(true)
  })
})

describe('completion candidate ranking', () => {
  it('matches prefixes, word starts and subsequences', () => {
    expect(matchScore('Us', 'User')).not.toBeNull()
    expect(matchScore('str_r', 'str_replace')).not.toBeNull()
    expect(matchScore('sr', 'str_replace')).not.toBeNull()
    expect(matchScore('rep', 'str_replace')).not.toBeNull()
    expect(matchScore('MF', 'ModelFactory')).not.toBeNull()
    expect(matchScore('x', 'User')).toBeNull()
    expect(matchScore('eplace', 'str_replace')).toBeNull()
    expect(matchScore('Us', 'User')! > matchScore('Us', 'AuthUserProvider')!).toBe(true)
  })

  it('ranks and caps', () => {
    expect(rankNames(['UserFactory', 'User', 'Auth'], 'Us', 10)).toEqual({ names: ['User', 'UserFactory'], incomplete: false })
    expect(rankNames(['a1', 'a2', 'a3'], 'a', 2)).toEqual({ names: ['a1', 'a2'], incomplete: true })
  })
})

describe('editor options from settings', () => {
  it('maps the appearance settings', () => {
    const options = editorOptions({ ...DEFAULT_SETTINGS, lineNumbers: false, minimap: true, wordWrap: false, indentGuides: false, editorFontSize: 99 })
    expect(options).toMatchObject({
      fontSize: 40,
      lineHeight: DEFAULT_SETTINGS.lineHeight,
      fontLigatures: true,
      lineNumbers: 'off',
      minimap: { enabled: true },
      wordWrap: 'off',
      guides: { indentation: false }
    })
    expect(editorOptions(DEFAULT_SETTINGS)).toMatchObject({ fontFamily: DEFAULT_SETTINGS.editorFontFamily, lineNumbers: 'on', wordWrap: 'on' })
    expect(tabSizeOf({ tabSize: 2 })).toBe(2)
    expect(tabSizeOf({ tabSize: 0 })).toBe(4)
  })
})

describe('word separators', () => {
  it('keep $ inside words so double-click selects $variable', async () => {
    const { BASE_EDITOR_OPTIONS } = await import('../../../src/renderer/src/monaco/options')
    expect(BASE_EDITOR_OPTIONS.wordSeparators).toBeDefined()
    expect(BASE_EDITOR_OPTIONS.wordSeparators).not.toContain('$')
    expect(BASE_EDITOR_OPTIONS.wordSeparators).toContain('>')
    expect(BASE_EDITOR_OPTIONS.wordSeparators).toContain('\\')
  })
})
