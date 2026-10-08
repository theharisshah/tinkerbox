import { parseAccelerator } from '../utils/accelerator'
import type { Platform } from '../utils/platform'

/**
 * Electron accelerators → Monaco keybinding parts. Kept free of Monaco so it can be unit tested; the editor turns
 * the parts into `KeyMod | KeyCode` numbers.
 */

export interface MonacoKeyParts {
  /** ⌘ on macOS, Ctrl elsewhere (KeyMod.CtrlCmd). */
  ctrlCmd: boolean
  /** Ctrl on macOS, the Windows / Super key elsewhere (KeyMod.WinCtrl). */
  winCtrl: boolean
  alt: boolean
  shift: boolean
  /** Name of the monaco.KeyCode member ("KeyR", "Digit0", "Equal", "F5", "UpArrow" …). */
  keyCode: string
}

const PUNCTUATION: Record<string, string> = {
  '=': 'Equal',
  '-': 'Minus',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  '\\': 'Backslash',
  ';': 'Semicolon',
  "'": 'Quote',
  '`': 'Backquote',
  '[': 'BracketLeft',
  ']': 'BracketRight'
}

/** Shifted US-layout characters → [key, needs shift]. */
const SHIFTED: Record<string, string> = {
  '!': 'Digit1',
  '@': 'Digit2',
  '#': 'Digit3',
  $: 'Digit4',
  '%': 'Digit5',
  '^': 'Digit6',
  '&': 'Digit7',
  '*': 'Digit8',
  '(': 'Digit9',
  ')': 'Digit0',
  _: 'Minus',
  Plus: 'Equal',
  '+': 'Equal',
  '{': 'BracketLeft',
  '}': 'BracketRight',
  '|': 'Backslash',
  ':': 'Semicolon',
  '"': 'Quote',
  '<': 'Comma',
  '>': 'Period',
  '?': 'Slash',
  '~': 'Backquote'
}

const NAMED: Record<string, string> = {
  Space: 'Space',
  Tab: 'Tab',
  Enter: 'Enter',
  Escape: 'Escape',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Up: 'UpArrow',
  Down: 'DownArrow',
  Left: 'LeftArrow',
  Right: 'RightArrow'
}

/** Monaco key parts of an accelerator ("CmdOrCtrl+Shift+P"), or null when it cannot be expressed. */
export function acceleratorToMonaco(accelerator: string, platform: Platform): MonacoKeyParts | null {
  const parsed = parseAccelerator(accelerator, platform)
  if (!parsed) return null
  const mac = platform === 'darwin'
  const parts: MonacoKeyParts = {
    ctrlCmd: mac ? parsed.meta : parsed.ctrl,
    winCtrl: mac ? parsed.ctrl : parsed.meta,
    alt: parsed.alt,
    shift: parsed.shift,
    keyCode: ''
  }
  const key = parsed.key
  if (/^[A-Z]$/.test(key)) parts.keyCode = `Key${key}`
  else if (/^[0-9]$/.test(key)) parts.keyCode = `Digit${key}`
  else if (/^F([1-9]|1[0-9])$/.test(key)) parts.keyCode = key
  else if (PUNCTUATION[key]) parts.keyCode = PUNCTUATION[key]
  else if (SHIFTED[key]) {
    parts.keyCode = SHIFTED[key]
    parts.shift = true
  } else if (NAMED[key]) parts.keyCode = NAMED[key]
  else return null
  return parts
}

/** Whether the accelerator has a modifier (plain keys such as Escape are left to Monaco and the window). */
export function hasModifier(parts: MonacoKeyParts): boolean {
  return parts.ctrlCmd || parts.winCtrl || parts.alt
}
