import { watch } from 'vue'
import { allThemes, currentTheme, customThemesRef, type ThemeDefinition } from '../themes'
import type { Monaco } from './monaco'

/**
 * Registers every theme of the shell's registry with Monaco (re-registering when custom themes change) and keeps
 * Monaco on the applied theme (`currentTheme`, including the Themes modal's live preview).
 */

type ThemeData = Parameters<Monaco['editor']['defineTheme']>[1]

function bare(hex: string | undefined): string | undefined {
  if (!hex) return undefined
  const m = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(hex.trim())
  return m ? m[1] : undefined
}

/** Theme data with the editor-specific token rules (magic comments in the accent color) added. */
export function editorThemeData(theme: ThemeDefinition): ThemeData {
  const data = theme.monaco
  const rules = [...(data.rules ?? [])]
  const accent = bare(theme.vars['--tw-accent'])
  if (accent && !rules.some((r) => r.token === 'comment.magic')) {
    rules.push({ token: 'comment.magic', foreground: accent, fontStyle: 'bold' })
  }
  return { base: data.base, inherit: data.inherit, rules, colors: { ...(data.colors ?? {}) } }
}

const defined = new Set<string>()

function defineAll(monaco: Monaco): void {
  for (const theme of allThemes()) {
    try {
      monaco.editor.defineTheme(theme.monacoName, editorThemeData(theme))
      defined.add(theme.monacoName)
    } catch (err) {
      console.warn(`Monaco rejected theme ${theme.id}:`, err)
    }
  }
}

function apply(monaco: Monaco, theme: ThemeDefinition): void {
  const name = defined.has(theme.monacoName) ? theme.monacoName : theme.dark ? 'vs-dark' : 'vs'
  monaco.editor.setTheme(name)
}

let installed = false

export function installThemes(monaco: Monaco): void {
  if (installed) return
  installed = true
  defineAll(monaco)
  watch(customThemesRef, () => {
    defineAll(monaco)
    apply(monaco, currentTheme.value)
  })
  watch(currentTheme, (theme) => apply(monaco, theme), { immediate: true })
}
