import type { Platform } from './platform'

/**
 * Electron accelerator helpers (https://www.electronjs.org/docs/latest/api/accelerator): parse, display
 * ("⇧⌘P" / "Ctrl+Shift+P"), match against KeyboardEvents and build accelerators from captured key presses.
 */

export interface ParsedAccelerator {
  meta: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
  /** Canonical key: "A".."Z", "0".."9", "F1".."F24", punctuation ("." "," "=" …) or a named key (see NAMED). */
  key: string
}

export type KeyboardEventLike = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>

/** Named keys (lower-case alias → canonical name). */
const NAMED: Record<string, string> = {
  plus: 'Plus',
  space: 'Space',
  ' ': 'Space',
  tab: 'Tab',
  capslock: 'Capslock',
  numlock: 'Numlock',
  scrolllock: 'Scrolllock',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  return: 'Enter',
  enter: 'Enter',
  up: 'Up',
  arrowup: 'Up',
  down: 'Down',
  arrowdown: 'Down',
  left: 'Left',
  arrowleft: 'Left',
  right: 'Right',
  arrowright: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  escape: 'Escape',
  esc: 'Escape',
  printscreen: 'PrintScreen'
}

const PUNCTUATION = new Set([...')!@#$%^&*(:;+=<,_->.?/~`{]|[}"\'\\'])

/** KeyboardEvent.code → canonical key (layout independent fallback). */
const CODE_KEYS: Record<string, string> = {
  Period: '.',
  Comma: ',',
  Minus: '-',
  Equal: '=',
  Backslash: '\\',
  IntlBackslash: '\\',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backquote: '`',
  Space: 'Space',
  Tab: 'Tab',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Escape: 'Escape',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  NumpadAdd: 'Plus',
  NumpadSubtract: '-',
  NumpadDecimal: '.',
  NumpadDivide: '/',
  NumpadMultiply: '*'
}

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift', 'AltGraph', 'OS', 'Hyper', 'Super', 'Fn', 'CapsLock'])

function canonicalKey(raw: string): string | null {
  if (raw === '') return null
  if (raw.length === 1) {
    if (/[a-z]/i.test(raw)) return raw.toUpperCase()
    if (/[0-9]/.test(raw)) return raw
    if (raw === ' ') return 'Space'
    if (PUNCTUATION.has(raw)) return raw === '+' ? 'Plus' : raw
    return null
  }
  const lower = raw.toLowerCase()
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower.toUpperCase()
  if (/^num[0-9]$/.test(lower)) return lower.slice(3)
  return NAMED[lower] ?? null
}

/** Parse an accelerator for a platform (CmdOrCtrl → ⌘ on macOS, Ctrl elsewhere). Null when invalid or empty. */
export function parseAccelerator(accelerator: string, platform: Platform): ParsedAccelerator | null {
  if (typeof accelerator !== 'string' || accelerator.trim() === '') return null
  // "CmdOrCtrl++" means CmdOrCtrl + Plus.
  const raw = accelerator.trim().replace(/\+\+$/, '+Plus')
  const parts = raw.split('+').map((p) => p.trim())
  if (parts.some((p) => p === '')) return null
  const out: ParsedAccelerator = { meta: false, ctrl: false, alt: false, shift: false, key: '' }
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const lower = part.toLowerCase()
    const isLast = i === parts.length - 1
    switch (lower) {
      case 'command':
      case 'cmd':
      case 'super':
      case 'meta':
        if (isLast) return null
        out.meta = true
        continue
      case 'control':
      case 'ctrl':
        if (isLast) return null
        out.ctrl = true
        continue
      case 'commandorcontrol':
      case 'cmdorctrl':
        if (isLast) return null
        if (platform === 'darwin') out.meta = true
        else out.ctrl = true
        continue
      case 'alt':
      case 'option':
      case 'altgr':
        if (isLast) return null
        out.alt = true
        continue
      case 'shift':
        if (isLast) return null
        out.shift = true
        continue
    }
    if (!isLast) return null
    const key = canonicalKey(part)
    if (!key) return null
    out.key = key
  }
  return out.key ? out : null
}

const MAC_KEY_GLYPHS: Record<string, string> = {
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Enter: '↵',
  Escape: 'Esc',
  Tab: '⇥',
  Backspace: '⌫',
  Delete: '⌦',
  Space: 'Space',
  Plus: '+',
  PageUp: 'PgUp',
  PageDown: 'PgDn'
}

const OTHER_KEY_LABELS: Record<string, string> = {
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Escape: 'Esc',
  Delete: 'Del',
  Plus: '+',
  PageUp: 'PgUp',
  PageDown: 'PgDn'
}

/** Display parts for kbd boxes, e.g. ["⇧", "⌘", "P"] on macOS or ["Ctrl", "Shift", "P"] elsewhere. */
export function acceleratorParts(accelerator: string, platform: Platform): string[] {
  const parsed = parseAccelerator(accelerator, platform)
  if (!parsed) return []
  if (platform === 'darwin') {
    const parts: string[] = []
    if (parsed.ctrl) parts.push('⌃')
    if (parsed.alt) parts.push('⌥')
    if (parsed.shift) parts.push('⇧')
    if (parsed.meta) parts.push('⌘')
    parts.push(MAC_KEY_GLYPHS[parsed.key] ?? parsed.key)
    return parts
  }
  const parts: string[] = []
  if (parsed.ctrl) parts.push('Ctrl')
  if (parsed.meta) parts.push(platform === 'win32' ? 'Win' : 'Super')
  if (parsed.alt) parts.push('Alt')
  if (parsed.shift) parts.push('Shift')
  parts.push(OTHER_KEY_LABELS[parsed.key] ?? parsed.key)
  return parts
}

/** Human readable accelerator: "⇧⌘P" on macOS, "Ctrl+Shift+P" elsewhere; '' when empty/invalid. */
export function formatAccelerator(accelerator: string, platform: Platform): string {
  const parts = acceleratorParts(accelerator, platform)
  if (parts.length === 0) return ''
  return platform === 'darwin' ? parts.join('') : parts.join('+')
}

/** Canonical key candidates of a keyboard event: from `key` (layout aware) and from `code` (physical key). */
function eventKeys(event: KeyboardEventLike): string[] {
  const keys: string[] = []
  const fromKey = canonicalKey(event.key ?? '')
  if (fromKey) keys.push(fromKey)
  const code = event.code ?? ''
  let fromCode: string | null = null
  if (/^Key[A-Z]$/.test(code)) fromCode = code.slice(3)
  else if (/^Digit[0-9]$/.test(code)) fromCode = code.slice(5)
  else if (/^Numpad[0-9]$/.test(code)) fromCode = code.slice(6)
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) fromCode = code
  else if (CODE_KEYS[code]) fromCode = CODE_KEYS[code]
  if (fromCode && !keys.includes(fromCode)) keys.push(fromCode)
  return keys
}

/** True when the keyboard event triggers the accelerator on this platform. */
export function matchesAccelerator(event: KeyboardEventLike, accelerator: string, platform: Platform): boolean {
  const parsed = parseAccelerator(accelerator, platform)
  if (!parsed) return false
  if (event.metaKey !== parsed.meta || event.ctrlKey !== parsed.ctrl || event.altKey !== parsed.alt) return false
  const keys = eventKeys(event)
  if (parsed.key === 'Plus') {
    // "+" is typed with Shift on most layouts; accept both "Cmd+Plus" and "Cmd+Shift+=".
    return keys.includes('Plus') || (event.shiftKey && keys.includes('='))
  }
  if (event.shiftKey !== parsed.shift) {
    // Shifted punctuation (e.g. "?" for Shift+/) can be bound without spelling out Shift.
    if (!(event.shiftKey && !parsed.shift && PUNCTUATION.has(parsed.key) && keys[0] === parsed.key)) return false
  }
  return keys.includes(parsed.key)
}

/**
 * Accelerator for a captured key press (Shortcuts settings), e.g. "CmdOrCtrl+Shift+P". Uses CmdOrCtrl for the
 * platform's primary modifier so shortcuts stay portable. Returns null while only modifiers are held.
 */
export function eventToAccelerator(event: KeyboardEventLike, platform: Platform): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null
  const keys = eventKeys(event)
  // Prefer the physical key when Alt (Option) changed the produced character.
  let key = event.altKey && keys.length > 1 ? keys[1] : keys[0]
  if (!key) return null
  if (key === 'Plus' && keys.includes('=')) key = '='
  const mods: string[] = []
  if (platform === 'darwin') {
    if (event.ctrlKey) mods.push('Ctrl')
    if (event.metaKey) mods.push('CmdOrCtrl')
  } else {
    if (event.ctrlKey) mods.push('CmdOrCtrl')
    if (event.metaKey) mods.push('Super')
  }
  if (event.altKey) mods.push('Alt')
  if (event.shiftKey) mods.push('Shift')
  return [...mods, key].join('+')
}

/** Whether an accelerator has a non-Shift modifier (safe as a global shortcut that does not eat typed text). */
export function hasStrongModifier(accelerator: string, platform: Platform): boolean {
  const parsed = parseAccelerator(accelerator, platform)
  return !!parsed && (parsed.meta || parsed.ctrl || parsed.alt)
}
