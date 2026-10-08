import type { MonacoThemeJson } from '@shared/types'
import type { ThemeDefinition } from '@/themes'
import type { PhpTokenType } from '../history/highlight'

/**
 * Helpers of the Themes modal: Monaco JSON (with a `custom` chrome block) for creating a custom
 * theme from another theme, and the colors used by the preview pane.
 */

/** Monaco theme JSON of a theme, with the chrome colors in `custom` so a copy looks the same as the original. */
export function themeToJson(theme: ThemeDefinition): MonacoThemeJson {
  const v = theme.vars
  return {
    base: theme.monaco.base,
    inherit: theme.monaco.inherit,
    rules: theme.monaco.rules.map((r) => ({ ...r })),
    colors: { ...theme.monaco.colors },
    custom: {
      'theme.isLight': theme.dark ? 'false' : 'true',
      'primary.background': v['--tw-accent'],
      'primary.foreground': v['--tw-accent-fg'],
      'secondary.background': v['--tw-bg'],
      background: v['--tw-bg'],
      alternate: v['--tw-bg-alt'],
      surface: v['--tw-surface'],
      border: v['--tw-border'],
      text: v['--tw-text'],
      mutedText: v['--tw-text-muted'],
      accent: v['--tw-accent'],
      accentText: v['--tw-accent-fg'],
      sidebar: v['--tw-sidebar-bg'],
      titlebar: v['--tw-titlebar-bg']
    }
  }
}

/** Suggested name for a copy of a theme ("Dracula Custom", "Dracula Custom 2", …) that is not taken yet. */
export function copyName(base: string, taken: readonly string[]): string {
  const lower = new Set(taken.map((t) => t.trim().toLowerCase()))
  const stem = `${base} Custom`
  if (!lower.has(stem.toLowerCase())) return stem
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem} ${i}`
    if (!lower.has(candidate.toLowerCase())) return candidate
  }
  return stem
}

function hex(value: string | undefined): string | undefined {
  if (!value) return undefined
  const v = value.startsWith('#') ? value : `#${value}`
  return /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) ? v : undefined
}

/** Foreground of the first Monaco rule matching one of the tokens (exact, then prefix). */
function ruleColor(theme: ThemeDefinition, tokens: readonly string[]): string | undefined {
  const rules = theme.monaco.rules
  for (const token of tokens) {
    const exact = rules.find((r) => r.foreground && r.token === token)
    if (exact) return hex(exact.foreground)
    const prefix = rules.find((r) => r.foreground && r.token.split(/[\s,]+/).some((t) => t === token || t.startsWith(`${token}.`)))
    if (prefix) return hex(prefix.foreground)
  }
  return undefined
}

export interface PreviewPalette {
  editorBg: string
  editorFg: string
  lineNumber: string
  lineHighlight: string
  tokens: Record<PhpTokenType, string>
}

/** Colors of the mini editor in the preview pane (Monaco data first, theme variables as fallback). */
export function previewPalette(theme: ThemeDefinition): PreviewPalette {
  const v = theme.vars
  const c = theme.monaco.colors
  const fg = hex(c['editor.foreground']) ?? v['--tw-text']
  return {
    editorBg: hex(c['editor.background']) ?? v['--tw-editor-bg'],
    editorFg: fg,
    lineNumber: hex(c['editorLineNumber.foreground']) ?? v['--tw-text-muted'],
    lineHighlight: hex(c['editor.lineHighlightBackground']) ?? 'transparent',
    tokens: {
      plain: fg,
      comment: ruleColor(theme, ['comment']) ?? v['--tw-code-comment'],
      string: ruleColor(theme, ['string']) ?? v['--tw-code-string'],
      number: ruleColor(theme, ['number', 'constant.numeric']) ?? v['--tw-code-number'],
      keyword: ruleColor(theme, ['keyword', 'storage']) ?? v['--tw-code-keyword'],
      variable: ruleColor(theme, ['variable']) ?? v['--tw-code-property'],
      function: ruleColor(theme, ['function', 'entity.name.function', 'support.function']) ?? fg,
      class: ruleColor(theme, ['class', 'type', 'entity.name.class', 'support.class']) ?? v['--tw-code-class'],
      constant: ruleColor(theme, ['constant', 'constant.language']) ?? v['--tw-code-bool'],
      tag: ruleColor(theme, ['metatag', 'tag']) ?? v['--tw-code-meta']
    }
  }
}
