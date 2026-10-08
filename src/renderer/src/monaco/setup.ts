import { effectScope, watch } from 'vue'
import type { editor, IDisposable } from 'monaco-editor/editor/editor.api'
import { COMMANDS, type CommandId } from '@shared/ipc'
import { useSettingsStore } from '../stores/settings'
import { platform } from '../utils/platform'
import { acceleratorToMonaco, hasModifier, type MonacoKeyParts } from './keybindings'
import { createPhpConf, createPhpLanguage, LANGUAGE_ID } from './language'
import { registerLanguageFeatures } from './languageFeatures'
import { configureMonacoEnvironment, monaco, type Monaco } from './monaco'
import { installThemes } from './themes'

/**
 * One-time Monaco setup: worker, the `tinkwell-php` language, themes, language features and the keybinding rules
 * that keep app shortcuts away from Monaco.
 */

/** Commands implemented as editor actions (context menu + keybinding inside the editor). */
export const EDITOR_ACTION_COMMANDS: readonly CommandId[] = ['runSelection', 'addMagicComment', 'addToSnippets', 'addSelectionToSnippets', 'prettify']

/** Monaco keybinding number of key parts (null when the key has no Monaco KeyCode). */
export function keybindingOf(parts: MonacoKeyParts | null): number | null {
  if (!parts) return null
  const code = (monaco.KeyCode as unknown as Record<string, number | undefined>)[parts.keyCode]
  if (code === undefined) return null
  const { KeyMod } = monaco
  return (parts.ctrlCmd ? KeyMod.CtrlCmd : 0) | (parts.shift ? KeyMod.Shift : 0) | (parts.alt ? KeyMod.Alt : 0) | (parts.winCtrl ? KeyMod.WinCtrl : 0) | code
}

/** Keybinding of an app command (current shortcut settings), or null. */
export function commandKeybinding(id: CommandId): number | null {
  return keybindingOf(acceleratorToMonaco(useSettingsStore().accelerator(id), platform))
}

/**
 * Keybinding rules: every app shortcut with a modifier or on a function key (F3, F8 … — Monaco binds several) is
 * bound to the `null` command so Monaco neither handles nor `preventDefault()`s it — the event reaches the window
 * listener and the native menu. Monaco defaults that get in the way are removed (F1 palette, ⌘K chords, ⌘L expand
 * selection). Other plain keys (Escape) stay with Monaco.
 */
export function appKeybindingRules(): editor.IKeybindingRule[] {
  const settings = useSettingsStore()
  const rules: editor.IKeybindingRule[] = []
  const seen = new Set<number>()
  for (const id of COMMANDS) {
    if (EDITOR_ACTION_COMMANDS.includes(id)) continue
    const parts = acceleratorToMonaco(settings.accelerator(id), platform)
    if (!parts || !(hasModifier(parts) || /^F\d{1,2}$/.test(parts.keyCode))) continue
    const keybinding = keybindingOf(parts)
    if (keybinding === null || seen.has(keybinding)) continue
    seen.add(keybinding)
    rules.push({ keybinding, command: null })
  }
  const { KeyMod, KeyCode } = monaco
  rules.push({ keybinding: KeyCode.F1, command: '-editor.action.quickCommand' })
  rules.push({ keybinding: KeyMod.CtrlCmd | KeyCode.KeyL, command: '-expandLineSelection' })
  const cmdK = KeyMod.CtrlCmd | KeyCode.KeyK
  if (!seen.has(cmdK)) rules.push({ keybinding: cmdK, command: null })
  return rules
}

const scope = effectScope(true)
let ready = false
let rules: IDisposable | null = null

function remeasureFontsWhenLoaded(m: Monaco): void {
  if (typeof document === 'undefined' || !document.fonts) return
  void document.fonts.ready.then(() => m.editor.remeasureFonts())
  document.fonts.addEventListener('loadingdone', () => m.editor.remeasureFonts())
}

/** Monaco, configured for Tinkerbox (idempotent). */
export function ensureMonaco(): Monaco {
  if (ready) return monaco
  ready = true
  configureMonacoEnvironment()
  monaco.languages.register({ id: LANGUAGE_ID, extensions: ['.php'], aliases: ['PHP', 'php'], mimetypes: ['application/x-php'] })
  monaco.languages.setMonarchTokensProvider(LANGUAGE_ID, createPhpLanguage())
  monaco.languages.setLanguageConfiguration(LANGUAGE_ID, createPhpConf())
  registerLanguageFeatures(monaco)
  scope.run(() => {
    installThemes(monaco)
    const settings = useSettingsStore()
    watch(
      () => COMMANDS.map((id) => settings.accelerator(id)).join('\n'),
      () => {
        rules?.dispose()
        rules = monaco.editor.addKeybindingRules(appKeybindingRules())
      },
      { immediate: true }
    )
  })
  remeasureFontsWhenLoaded(monaco)
  return monaco
}
