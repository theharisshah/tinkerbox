import { COMMANDS, type CommandId } from '@shared/ipc'
import { acceleratorFor, COMMAND_META, type CommandMeta } from '@shared/shortcuts'
import {
  eventToAccelerator,
  formatAccelerator,
  hasStrongModifier,
  parseAccelerator,
  type KeyboardEventLike
} from '@/utils/accelerator'
import { fuzzyFilter } from '@/utils/fuzzy'
import type { Platform } from '@/utils/platform'

/**
 * Pure logic behind the Shortcuts settings page: key capture → accelerator, effective shortcuts, conflict detection
 * and the grouped / searchable list of rows.
 */

export type ShortcutGroup = CommandMeta['group']

/** Order of the groups on the Shortcuts page (same as COMMAND_META / the command palette). */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = ['Run', 'Tabs', 'File', 'Panels', 'Layout', 'Output', 'Editor']

export type ShortcutOverrides = Partial<Record<string, string>>

export type CaptureOutcome =
  /** Plain Escape: stop capturing, keep the current shortcut. */
  | { action: 'cancel' }
  /** Plain Backspace / Delete: remove the shortcut. */
  | { action: 'clear' }
  /** Only modifier keys are held so far. */
  | { action: 'pending'; modifiers: string[] }
  /** A key combination that cannot be used (e.g. a letter without ⌘ / Ctrl / Alt). */
  | { action: 'invalid'; accelerator: string; reason: string }
  | { action: 'set'; accelerator: string }

const FUNCTION_KEY = /^F([1-9]|1[0-9]|2[0-4])$/

/** Modifier glyphs / names currently held (shown while capturing). */
export function heldModifiers(event: KeyboardEventLike, platform: Platform): string[] {
  const mac = platform === 'darwin'
  const out: string[] = []
  if (event.ctrlKey) out.push(mac ? '⌃' : 'Ctrl')
  if (event.metaKey) out.push(mac ? '⌘' : platform === 'win32' ? 'Win' : 'Super')
  if (event.altKey) out.push(mac ? '⌥' : 'Alt')
  if (event.shiftKey) out.push(mac ? '⇧' : 'Shift')
  return out
}

export interface ReservedShortcut {
  accelerator: string
  /** What the keys do today: "Copy", "Find Next". */
  action: string
  /**
   * true: basic editing / window keys (copy, paste, undo, quit …) — capture refuses them. false: an editor action
   * that an app shortcut on the same keys replaces while the editor has focus (the Shortcuts page warns).
   */
  blocked: boolean
}

/** Key combinations the operating system, the Edit / window menus or the code editor already use. */
export function reservedShortcuts(platform: Platform): ReservedShortcut[] {
  const block = (accelerator: string, action: string): ReservedShortcut => ({ accelerator, action, blocked: true })
  const editor = (accelerator: string, action: string): ReservedShortcut => ({ accelerator, action, blocked: false })
  const list: ReservedShortcut[] = [
    block('CmdOrCtrl+A', 'Select All'),
    block('CmdOrCtrl+C', 'Copy'),
    block('CmdOrCtrl+V', 'Paste'),
    block('CmdOrCtrl+X', 'Cut'),
    block('CmdOrCtrl+Z', 'Undo'),
    block('CmdOrCtrl+Shift+Z', 'Redo')
  ]
  if (platform === 'darwin') {
    list.push(block('Cmd+Q', 'Quit'), block('Cmd+H', 'Hide'), block('Cmd+Alt+H', 'Hide Others'), block('Cmd+M', 'Minimize'))
  } else {
    list.push(block('Ctrl+Y', 'Redo'))
    if (platform === 'linux') list.push(block('Ctrl+Q', 'Quit'))
  }
  list.push(
    editor('CmdOrCtrl+F', 'Find'),
    editor('F3', 'Find Next'),
    editor('Shift+F3', 'Find Previous'),
    editor('F8', 'Go to Next Problem'),
    editor('Shift+F8', 'Go to Previous Problem'),
    editor('F12', 'Go to Definition'),
    editor('CmdOrCtrl+D', 'Add Selection to Next Find Match'),
    editor('CmdOrCtrl+/', 'Toggle Line Comment'),
    editor('CmdOrCtrl+]', 'Indent Line'),
    editor('CmdOrCtrl+[', 'Outdent Line'),
    editor('Alt+Up', 'Move Line Up'),
    editor('Alt+Down', 'Move Line Down'),
    editor('CmdOrCtrl+Shift+K', 'Delete Line'),
    editor('CmdOrCtrl+Enter', 'Insert Line Below')
  )
  return list
}

/** The reserved combination an accelerator would take over, or null. */
export function reservedShortcut(accelerator: string, platform: Platform): ReservedShortcut | null {
  if (!accelerator) return null
  return reservedShortcuts(platform).find((r) => sameAccelerator(r.accelerator, accelerator, platform)) ?? null
}

/**
 * Interpret a key press while a shortcut button is capturing. Plain Escape cancels, plain Backspace/Delete clears,
 * modifier-only presses are pending. Everything else becomes an accelerator ("CmdOrCtrl+Shift+P"), which must use a
 * non-Shift modifier unless it is a function key (so a shortcut never swallows typed text), and must not take basic
 * editing / window keys such as ⌘C or ⌘Q (see reservedShortcuts).
 */
export function captureShortcut(event: KeyboardEventLike, platform: Platform): CaptureOutcome {
  const noModifiers = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
  if (noModifiers && event.key === 'Escape') return { action: 'cancel' }
  if (noModifiers && (event.key === 'Backspace' || event.key === 'Delete')) return { action: 'clear' }
  const accelerator = eventToAccelerator(event, platform)
  if (!accelerator) return { action: 'pending', modifiers: heldModifiers(event, platform) }
  const parsed = parseAccelerator(accelerator, platform)
  if (!parsed) return { action: 'invalid', accelerator, reason: 'This key cannot be used in a shortcut.' }
  if (!hasStrongModifier(accelerator, platform) && !FUNCTION_KEY.test(parsed.key)) {
    const mods = platform === 'darwin' ? '⌘, ⌃ or ⌥' : 'Ctrl or Alt'
    return { action: 'invalid', accelerator, reason: `Add ${mods} so the shortcut does not get in the way of typing.` }
  }
  const reserved = reservedShortcut(accelerator, platform)
  if (reserved?.blocked) {
    return { action: 'invalid', accelerator, reason: `${formatAccelerator(accelerator, platform)} is ${reserved.action} everywhere in Tinkerbox. Pick other keys.` }
  }
  return { action: 'set', accelerator }
}

/**
 * Platform-specific identity of an accelerator ("CmdOrCtrl+R" and "Cmd+R" are the same on macOS), or null when the
 * accelerator is empty / invalid.
 */
export function acceleratorSignature(accelerator: string, platform: Platform): string | null {
  const parsed = parseAccelerator(accelerator, platform)
  if (!parsed) return null
  const parts: string[] = []
  if (parsed.ctrl) parts.push('ctrl')
  if (parsed.meta) parts.push('meta')
  if (parsed.alt) parts.push('alt')
  if (parsed.shift) parts.push('shift')
  parts.push(parsed.key)
  return parts.join('+')
}

/** Whether two accelerators trigger on the same key combination. */
export function sameAccelerator(a: string, b: string, platform: Platform): boolean {
  const sa = acceleratorSignature(a, platform)
  return sa !== null && sa === acceleratorSignature(b, platform)
}

/** Default accelerator of a command on a platform (ignores overrides). */
export function defaultAccelerator(id: CommandId, platform: Platform): string {
  return acceleratorFor(id, platform, {})
}

/** Effective accelerator of every command ('' = none). */
export function effectiveShortcuts(platform: Platform, overrides: ShortcutOverrides = {}): Record<CommandId, string> {
  const out = {} as Record<CommandId, string>
  for (const id of COMMANDS) out[id] = acceleratorFor(id, platform, overrides)
  return out
}

/**
 * Commands sharing a key combination: command id → the other commands bound to the same keys. Commands without a
 * shortcut never conflict.
 */
export function findShortcutConflicts(shortcuts: Partial<Record<CommandId, string>>, platform: Platform): Map<CommandId, CommandId[]> {
  const bySignature = new Map<string, CommandId[]>()
  for (const id of COMMANDS) {
    const accel = shortcuts[id]
    if (!accel) continue
    const sig = acceleratorSignature(accel, platform)
    if (!sig) continue
    const list = bySignature.get(sig)
    if (list) list.push(id)
    else bySignature.set(sig, [id])
  }
  const conflicts = new Map<CommandId, CommandId[]>()
  for (const ids of bySignature.values()) {
    if (ids.length < 2) continue
    for (const id of ids) conflicts.set(id, ids.filter((other) => other !== id))
  }
  return conflicts
}

/** Commands (other than `except`) already using an accelerator. */
export function commandsUsing(
  accelerator: string,
  shortcuts: Partial<Record<CommandId, string>>,
  platform: Platform,
  except?: CommandId
): CommandId[] {
  const sig = acceleratorSignature(accelerator, platform)
  if (!sig) return []
  return COMMANDS.filter((id) => id !== except && !!shortcuts[id] && acceleratorSignature(shortcuts[id] as string, platform) === sig)
}

/**
 * Value to store for a newly captured accelerator: null (= back to the default) when it equals the default, so the
 * override disappears instead of pinning the default.
 */
export function overrideValue(id: CommandId, accelerator: string, platform: Platform): string | null {
  const def = defaultAccelerator(id, platform)
  if (accelerator === '') return def === '' ? null : ''
  return def !== '' && sameAccelerator(def, accelerator, platform) ? null : accelerator
}

/** Settings patch that removes every shortcut override. */
export function resetAllShortcutsPatch(overrides: ShortcutOverrides): { shortcuts: Record<string, null> } {
  const shortcuts: Record<string, null> = {}
  for (const key of Object.keys(overrides)) shortcuts[key] = null
  return { shortcuts }
}

export interface ShortcutRow {
  id: CommandId
  title: string
  group: ShortcutGroup
  /** Effective accelerator ('' = none). */
  accelerator: string
  defaultAccelerator: string
  /** The user changed this shortcut (including removing it). */
  overridden: boolean
  /** Other commands bound to the same keys. */
  conflicts: CommandId[]
}

export function shortcutRows(platform: Platform, overrides: ShortcutOverrides = {}): ShortcutRow[] {
  const effective = effectiveShortcuts(platform, overrides)
  const conflicts = findShortcutConflicts(effective, platform)
  return COMMANDS.map((id) => {
    const def = defaultAccelerator(id, platform)
    const accel = effective[id]
    const hasOverride = Object.prototype.hasOwnProperty.call(overrides, id) && overrides[id] !== undefined
    return {
      id,
      title: COMMAND_META[id].title,
      group: COMMAND_META[id].group,
      accelerator: accel,
      defaultAccelerator: def,
      overridden: hasOverride && !(accel === def || (accel !== '' && sameAccelerator(accel, def, platform))),
      conflicts: conflicts.get(id) ?? []
    }
  })
}

export interface ShortcutRowGroup {
  group: ShortcutGroup
  rows: ShortcutRow[]
}

/** "⇧⌘P" / "Ctrl + Shift + P" → comparable form without separators and spaces. */
function keysNeedle(text: string): string {
  return text.toLowerCase().replace(/[\s+]+/g, '')
}

/**
 * Rows matching a query: rows whose displayed keys ("⇧⌘P" / "Ctrl+Shift+P") contain the query come first, then fuzzy
 * matches on the title, group and command id (by relevance; COMMAND_META order without a query).
 */
export function filterShortcutRows(rows: readonly ShortcutRow[], query: string, platform: Platform): ShortcutRow[] {
  if (query.trim() === '') return [...rows]
  const needle = keysNeedle(query)
  const byKeys = needle ? rows.filter((r) => r.accelerator !== '' && keysNeedle(formatAccelerator(r.accelerator, platform)).includes(needle)) : []
  const byText = fuzzyFilter(rows, query, (r) => [r.title, r.group, r.id]).map((h) => h.item)
  return [...new Set([...byKeys, ...byText])]
}

/** Matching rows grouped in SHORTCUT_GROUPS order (empty groups dropped). */
export function groupShortcutRows(rows: readonly ShortcutRow[], query: string, platform: Platform): ShortcutRowGroup[] {
  const hits = filterShortcutRows(rows, query, platform)
  const groups: ShortcutRowGroup[] = []
  for (const group of SHORTCUT_GROUPS) {
    const list = hits.filter((r) => r.group === group)
    if (list.length) groups.push({ group, rows: list })
  }
  return groups
}
