/**
 * Theme model. A theme provides the app chrome palette as CSS custom properties (`--tw-*` on :root) and Monaco
 * theme data (registered by the editor module — this module never imports Monaco).
 */

/** Every CSS custom property a theme defines. Components only use these (no hard-coded colors). */
export const THEME_VARS = [
  // Chrome
  '--tw-bg',
  '--tw-bg-alt',
  '--tw-surface',
  '--tw-border',
  '--tw-text',
  '--tw-text-muted',
  '--tw-accent',
  '--tw-accent-fg',
  '--tw-accent-soft',
  '--tw-hover',
  '--tw-active',
  '--tw-danger',
  '--tw-warning',
  '--tw-success',
  '--tw-sidebar-bg',
  '--tw-titlebar-bg',
  '--tw-scrollbar',
  // Extras
  '--tw-editor-bg',
  '--tw-input-bg',
  '--tw-overlay',
  '--tw-selection',
  // Dumped values (output cards / CLI)
  '--tw-code-string',
  '--tw-code-number',
  '--tw-code-keyword',
  '--tw-code-class',
  '--tw-code-property',
  '--tw-code-comment',
  '--tw-code-null',
  '--tw-code-bool',
  '--tw-code-key',
  '--tw-code-meta'
] as const

export type ThemeVar = (typeof THEME_VARS)[number]
export type ThemeVars = Record<ThemeVar, string>

/** Structurally identical to monaco.editor.IStandaloneThemeData. */
export interface MonacoThemeData {
  base: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light'
  inherit: boolean
  rules: Array<{ token: string; foreground?: string; background?: string; fontStyle?: string }>
  colors: Record<string, string>
}

export interface ThemeDefinition {
  /** Settings id: built-in slug ("tinkerbox", "dracula"…) or "custom:<file>". */
  id: string
  name: string
  dark: boolean
  /** True for themes loaded from ~/.config/tinkerbox/themes. */
  custom: boolean
  /** Name to pass to monaco.editor.defineTheme/setTheme (Monaco only accepts [a-z0-9-]). */
  monacoName: string
  vars: ThemeVars
  monaco: MonacoThemeData
}

/** Compact palette used to build the built-in themes. */
export interface ThemeSpec {
  id: string
  name: string
  dark: boolean
  chrome: {
    bg: string
    bgAlt?: string
    surface: string
    border?: string
    text: string
    textMuted?: string
    accent: string
    accentFg?: string
    accentSoft?: string
    hover?: string
    active?: string
    sidebarBg?: string
    titlebarBg?: string
    danger?: string
    warning?: string
    success?: string
  }
  editor: {
    background: string
    foreground: string
    lineHighlight?: string
    selection?: string
    cursor?: string
    lineNumber?: string
    lineNumberActive?: string
    indentGuide?: string
    indentGuideActive?: string
  }
  syntax: {
    comment: string
    string: string
    number: string
    keyword: string
    variable: string
    function: string
    class: string
    constant: string
    operator?: string
    property?: string
    escape?: string
    tag?: string
  }
  /** Extra Monaco colors (override the derived ones). */
  monacoColors?: Record<string, string>
}
