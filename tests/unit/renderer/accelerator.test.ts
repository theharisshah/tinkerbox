import { describe, expect, it } from 'vitest'
import { COMMANDS } from '@shared/ipc'
import { acceleratorFor, COMMAND_META } from '@shared/shortcuts'
import {
  acceleratorParts,
  eventToAccelerator,
  formatAccelerator,
  hasStrongModifier,
  matchesAccelerator,
  parseAccelerator,
  type KeyboardEventLike
} from '@/utils/accelerator'

function ev(key: string, code: string, mods: Partial<Pick<KeyboardEventLike, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>> = {}): KeyboardEventLike {
  return { key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }
}

describe('parseAccelerator', () => {
  it('maps CmdOrCtrl per platform', () => {
    expect(parseAccelerator('CmdOrCtrl+Shift+P', 'darwin')).toEqual({ meta: true, ctrl: false, alt: false, shift: true, key: 'P' })
    expect(parseAccelerator('CmdOrCtrl+Shift+P', 'win32')).toEqual({ meta: false, ctrl: true, alt: false, shift: true, key: 'P' })
  })

  it('understands named keys and plus', () => {
    expect(parseAccelerator('Ctrl+.', 'darwin')?.key).toBe('.')
    expect(parseAccelerator('CmdOrCtrl+Plus', 'darwin')?.key).toBe('Plus')
    expect(parseAccelerator('CmdOrCtrl++', 'darwin')?.key).toBe('Plus')
    expect(parseAccelerator('Escape', 'linux')?.key).toBe('Escape')
    expect(parseAccelerator('Alt+F4', 'win32')).toEqual({ meta: false, ctrl: false, alt: true, shift: false, key: 'F4' })
  })

  it('rejects invalid accelerators', () => {
    expect(parseAccelerator('', 'darwin')).toBeNull()
    expect(parseAccelerator('Shift', 'darwin')).toBeNull()
    expect(parseAccelerator('Foo+A', 'darwin')).toBeNull()
    expect(parseAccelerator('A+B', 'darwin')).toBeNull()
  })

  it('parses every default command accelerator', () => {
    for (const id of COMMANDS) {
      for (const platform of ['darwin', 'win32', 'linux'] as const) {
        const accel = acceleratorFor(id, platform)
        if (accel) expect(parseAccelerator(accel, platform), `${id} on ${platform}`).not.toBeNull()
      }
    }
  })
})

describe('formatAccelerator', () => {
  it('uses glyphs on macOS', () => {
    expect(formatAccelerator('CmdOrCtrl+Shift+P', 'darwin')).toBe('⇧⌘P')
    expect(formatAccelerator('Ctrl+.', 'darwin')).toBe('⌃.')
    expect(formatAccelerator('CmdOrCtrl+Alt+Shift+O', 'darwin')).toBe('⌥⇧⌘O')
    expect(formatAccelerator('CmdOrCtrl+Enter', 'darwin')).toBe('⌘↵')
  })

  it('uses words elsewhere', () => {
    expect(formatAccelerator('CmdOrCtrl+Shift+P', 'win32')).toBe('Ctrl+Shift+P')
    expect(formatAccelerator('Ctrl+Alt+L', 'linux')).toBe('Ctrl+Alt+L')
    expect(formatAccelerator('Escape', 'linux')).toBe('Esc')
  })

  it('returns parts for key caps and empty output for invalid input', () => {
    expect(acceleratorParts('CmdOrCtrl+R', 'darwin')).toEqual(['⌘', 'R'])
    expect(formatAccelerator('', 'darwin')).toBe('')
    expect(formatAccelerator('Nope+Nope', 'darwin')).toBe('')
  })
})

describe('matchesAccelerator', () => {
  it('matches letters with modifiers', () => {
    expect(matchesAccelerator(ev('P', 'KeyP', { metaKey: true, shiftKey: true }), 'CmdOrCtrl+Shift+P', 'darwin')).toBe(true)
    expect(matchesAccelerator(ev('p', 'KeyP', { ctrlKey: true, shiftKey: true }), 'CmdOrCtrl+Shift+P', 'darwin')).toBe(false)
    expect(matchesAccelerator(ev('p', 'KeyP', { ctrlKey: true, shiftKey: true }), 'CmdOrCtrl+Shift+P', 'win32')).toBe(true)
    expect(matchesAccelerator(ev('p', 'KeyP', { metaKey: true }), 'CmdOrCtrl+Shift+P', 'darwin')).toBe(false)
  })

  it('matches punctuation and the physical key when Option changes the character', () => {
    expect(matchesAccelerator(ev('.', 'Period', { ctrlKey: true }), 'Ctrl+.', 'darwin')).toBe(true)
    expect(matchesAccelerator(ev('Ø', 'KeyO', { metaKey: true, altKey: true, shiftKey: true }), 'CmdOrCtrl+Alt+Shift+O', 'darwin')).toBe(true)
  })

  it('accepts both spellings of plus', () => {
    expect(matchesAccelerator(ev('+', 'Equal', { metaKey: true, shiftKey: true }), 'CmdOrCtrl+Plus', 'darwin')).toBe(true)
    expect(matchesAccelerator(ev('=', 'Equal', { metaKey: true }), 'CmdOrCtrl+=', 'darwin')).toBe(true)
  })

  it('matches plain named keys', () => {
    expect(matchesAccelerator(ev('Escape', 'Escape'), 'Escape', 'darwin')).toBe(true)
    expect(matchesAccelerator(ev('Escape', 'Escape', { shiftKey: true }), 'Escape', 'darwin')).toBe(false)
    expect(matchesAccelerator(ev('Tab', 'Tab', { ctrlKey: true }), 'Ctrl+Tab', 'darwin')).toBe(true)
  })

  it('never matches an empty accelerator', () => {
    expect(matchesAccelerator(ev('a', 'KeyA'), '', 'darwin')).toBe(false)
  })
})

describe('eventToAccelerator', () => {
  it('builds portable accelerators', () => {
    expect(eventToAccelerator(ev('P', 'KeyP', { metaKey: true, shiftKey: true }), 'darwin')).toBe('CmdOrCtrl+Shift+P')
    expect(eventToAccelerator(ev('p', 'KeyP', { ctrlKey: true, shiftKey: true }), 'win32')).toBe('CmdOrCtrl+Shift+P')
    expect(eventToAccelerator(ev('.', 'Period', { ctrlKey: true }), 'darwin')).toBe('Ctrl+.')
    expect(eventToAccelerator(ev('Ø', 'KeyO', { metaKey: true, altKey: true }), 'darwin')).toBe('CmdOrCtrl+Alt+O')
  })

  it('ignores lone modifiers', () => {
    expect(eventToAccelerator(ev('Shift', 'ShiftLeft', { shiftKey: true }), 'darwin')).toBeNull()
    expect(eventToAccelerator(ev('Meta', 'MetaLeft', { metaKey: true }), 'darwin')).toBeNull()
  })

  it('round-trips through matchesAccelerator', () => {
    const event = ev('K', 'KeyK', { metaKey: true, shiftKey: true })
    const accel = eventToAccelerator(event, 'darwin')!
    expect(matchesAccelerator(event, accel, 'darwin')).toBe(true)
  })
})

describe('acceleratorFor / hasStrongModifier', () => {
  it('honors overrides and per-platform defaults', () => {
    expect(acceleratorFor('showHistory', 'darwin')).toBe('CmdOrCtrl+Y')
    expect(acceleratorFor('showHistory', 'win32')).toBe('Ctrl+I')
    expect(acceleratorFor('run', 'darwin', { run: 'CmdOrCtrl+Enter' })).toBe('CmdOrCtrl+Enter')
    expect(acceleratorFor('run', 'darwin', { run: '' })).toBe('')
  })

  it('detects strong modifiers', () => {
    expect(hasStrongModifier('Shift+A', 'darwin')).toBe(false)
    expect(hasStrongModifier('Alt+A', 'darwin')).toBe(true)
    expect(hasStrongModifier(COMMAND_META.run.accelerator, 'linux')).toBe(true)
  })
})
