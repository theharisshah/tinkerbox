import type { CustomTheme, MonacoThemeJson } from '@shared/types'
import { contrastRatio, flatten, isDark, isHexColor, mix, normalizeHex, readableOn, withAlpha } from '../utils/color'
import type { MonacoThemeData, ThemeDefinition, ThemeSpec, ThemeVars } from './types'

/** Monaco theme names must match [a-z0-9-]. */
export function monacoThemeName(id: string): string {
  return 'tw-' + id.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
}

function bare(color: string): string {
  return normalizeHex(color, '#000000').replace(/^#/, '')
}

/** PHP token rules for Monaco's tokenizer (token classes are prefix-matched, e.g. "keyword" → "keyword.php"). */
function syntaxRules(spec: ThemeSpec): MonacoThemeData['rules'] {
  const s = spec.syntax
  const operator = s.operator ?? mix(spec.editor.foreground, spec.editor.background, 0.25)
  const property = s.property ?? s.variable
  const escape = s.escape ?? s.constant
  const tag = s.tag ?? s.keyword
  const rule = (token: string, color: string, fontStyle?: string): MonacoThemeData['rules'][number] =>
    fontStyle ? { token, foreground: bare(color), fontStyle } : { token, foreground: bare(color) }
  return [
    { token: '', foreground: bare(spec.editor.foreground), background: bare(spec.editor.background) },
    rule('comment', s.comment, 'italic'),
    rule('comment.doc', s.comment, 'italic'),
    rule('string', s.string),
    rule('string.heredoc', s.string),
    rule('string.escape', escape),
    rule('string.escape.invalid', '#ef4444'),
    rule('number', s.number),
    rule('keyword', s.keyword),
    rule('keyword.flow', s.keyword),
    rule('storage', s.keyword),
    rule('metatag', s.keyword),
    rule('variable', s.variable),
    rule('variable.predefined', s.constant),
    rule('variable.parameter', s.variable, 'italic'),
    rule('property', property),
    rule('identifier', spec.editor.foreground),
    rule('function', s.function),
    rule('entity.name.function', s.function),
    rule('support.function', s.function),
    rule('type', s.class),
    rule('type.identifier', s.class),
    rule('class', s.class),
    rule('entity.name.class', s.class),
    rule('support.class', s.class),
    rule('namespace', s.class),
    rule('constant', s.constant),
    rule('constant.language', s.constant),
    rule('annotation', s.constant),
    rule('attribute.name', s.function),
    rule('attribute.value', s.string),
    rule('tag', tag),
    rule('delimiter', operator),
    rule('operator', operator),
    rule('regexp', escape),
    { token: 'invalid', foreground: 'ef4444' }
  ]
}

/** `color`, pushed toward white (dark backgrounds) or black (light ones) until it reaches `ratio` on `background`. */
function readableText(color: string, background: string, ratio = 4.6): string {
  const target = isDark(background) ? '#ffffff' : '#000000'
  for (let t = 0; t <= 1; t += 0.05) {
    const candidate = mix(color, target, t)
    if (contrastRatio(candidate, background) >= ratio) return candidate
  }
  return target
}

function monacoColors(spec: ThemeSpec): Record<string, string> {
  const e = spec.editor
  const bg = normalizeHex(e.background, '#ffffff')
  const fg = normalizeHex(e.foreground, '#000000')
  const accent = normalizeHex(spec.chrome.accent, '#7c3aed')
  const widgetBg = normalizeHex(spec.chrome.surface, bg)
  const selection = withAlpha(accent, spec.dark ? 0.3 : 0.14)
  /** Text on a selected row (accent tint over the widget background). */
  const selectedFg = readableText(fg, flatten(selection, widgetBg))
  const widgetFg = readableText(fg, widgetBg)
  const colors: Record<string, string> = {
    'editor.background': bg,
    'editor.foreground': fg,
    'editor.lineHighlightBackground': normalizeHex(e.lineHighlight, mix(bg, fg, spec.dark ? 0.05 : 0.035)),
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': normalizeHex(e.selection, withAlpha(accent, spec.dark ? 0.35 : 0.22)),
    'editor.inactiveSelectionBackground': withAlpha(normalizeHex(e.selection, accent), spec.dark ? 0.22 : 0.14),
    'editor.selectionHighlightBackground': withAlpha(accent, 0.12),
    'editor.findMatchHighlightBackground': withAlpha(accent, 0.2),
    'editorCursor.foreground': normalizeHex(e.cursor, accent),
    'editorLineNumber.foreground': normalizeHex(e.lineNumber, mix(fg, bg, 0.62)),
    'editorLineNumber.activeForeground': normalizeHex(e.lineNumberActive, accent),
    'editorIndentGuide.background1': normalizeHex(e.indentGuide, mix(bg, fg, 0.08)),
    'editorIndentGuide.activeBackground1': normalizeHex(e.indentGuideActive, mix(bg, fg, 0.22)),
    'editorWhitespace.foreground': mix(bg, fg, 0.2),
    'editorGutter.background': bg,
    'editorWidget.background': normalizeHex(spec.chrome.surface, bg),
    'editorWidget.border': mix(bg, fg, 0.14),
    'editorSuggestWidget.background': normalizeHex(spec.chrome.surface, bg),
    'editorSuggestWidget.border': mix(bg, fg, 0.14),
    'editorSuggestWidget.selectedBackground': selection,
    // Foregrounds must be set explicitly: Monaco's light base derives the selected row's text from
    // list.activeSelectionForeground (white), which is unreadable on the soft accent selection above.
    'editorSuggestWidget.foreground': widgetFg,
    'editorSuggestWidget.selectedForeground': selectedFg,
    'editorSuggestWidget.selectedIconForeground': accent,
    'editorSuggestWidget.highlightForeground': accent,
    'editorSuggestWidget.focusHighlightForeground': accent,
    'editorWidget.foreground': widgetFg,
    'editorHoverWidget.foreground': widgetFg,
    'editorHoverWidget.background': widgetBg,
    'editorHoverWidget.border': mix(bg, fg, 0.14),
    'list.activeSelectionBackground': selection,
    'list.activeSelectionForeground': selectedFg,
    'list.inactiveSelectionBackground': withAlpha(accent, spec.dark ? 0.2 : 0.1),
    'list.inactiveSelectionForeground': widgetFg,
    'list.focusBackground': selection,
    'list.focusForeground': selectedFg,
    'list.hoverBackground': withAlpha(fg, spec.dark ? 0.06 : 0.04),
    'list.hoverForeground': widgetFg,
    'list.highlightForeground': accent,
    'list.focusHighlightForeground': accent,
    'quickInputList.focusBackground': selection,
    'quickInputList.focusForeground': selectedFg,
    'menu.background': widgetBg,
    'menu.foreground': widgetFg,
    'menu.selectionBackground': selection,
    'menu.selectionForeground': selectedFg,
    'menu.separatorBackground': mix(bg, fg, 0.14),
    'menu.border': mix(bg, fg, 0.14),
    'input.background': bg,
    'input.foreground': fg,
    'input.border': mix(bg, fg, 0.18),
    'editorBracketMatch.background': withAlpha(accent, 0.12),
    'editorBracketMatch.border': withAlpha(accent, 0.5),
    'editorOverviewRuler.border': '#00000000',
    'scrollbar.shadow': '#00000000',
    'scrollbarSlider.background': withAlpha(fg, spec.dark ? 0.16 : 0.12),
    'scrollbarSlider.hoverBackground': withAlpha(fg, spec.dark ? 0.26 : 0.2),
    'scrollbarSlider.activeBackground': withAlpha(fg, spec.dark ? 0.34 : 0.28),
    'minimap.background': bg,
    focusBorder: '#00000000'
  }
  return { ...colors, ...(spec.monacoColors ?? {}) }
}

function chromeVars(spec: ThemeSpec): ThemeVars {
  const c = spec.chrome
  const dark = spec.dark
  const bg = normalizeHex(c.bg, dark ? '#1b1926' : '#f4f2fb')
  const text = normalizeHex(c.text, dark ? '#e6e1f5' : '#2e2647')
  const surface = normalizeHex(c.surface, bg)
  const accent = normalizeHex(c.accent, '#7c3aed')
  const muted = normalizeHex(c.textMuted, mix(text, bg, 0.42))
  const s = spec.syntax
  return {
    '--tw-bg': bg,
    '--tw-bg-alt': normalizeHex(c.bgAlt, mix(bg, text, dark ? 0.035 : 0.025)),
    '--tw-surface': surface,
    '--tw-border': normalizeHex(c.border, mix(bg, text, dark ? 0.14 : 0.11)),
    '--tw-text': text,
    '--tw-text-muted': muted,
    '--tw-accent': accent,
    '--tw-accent-fg': normalizeHex(c.accentFg, readableOn(accent)),
    '--tw-accent-soft': normalizeHex(c.accentSoft, flatten(withAlpha(accent, dark ? 0.2 : 0.11), surface)),
    '--tw-hover': normalizeHex(c.hover, mix(bg, text, dark ? 0.08 : 0.055)),
    '--tw-active': normalizeHex(c.active, flatten(withAlpha(accent, dark ? 0.24 : 0.14), bg)),
    '--tw-danger': normalizeHex(c.danger, dark ? '#f87171' : '#dc2626'),
    '--tw-warning': normalizeHex(c.warning, dark ? '#fbbf24' : '#d97706'),
    '--tw-success': normalizeHex(c.success, dark ? '#4ade80' : '#16a34a'),
    '--tw-sidebar-bg': normalizeHex(c.sidebarBg, bg),
    '--tw-titlebar-bg': normalizeHex(c.titlebarBg, bg),
    '--tw-scrollbar': mix(bg, text, dark ? 0.28 : 0.22),
    '--tw-editor-bg': normalizeHex(spec.editor.background, surface),
    '--tw-input-bg': dark ? mix(surface, text, 0.04) : surface,
    '--tw-overlay': dark ? '#00000099' : withAlpha(mix(text, '#000000', 0.3), 0.32),
    '--tw-selection': normalizeHex(spec.editor.selection, withAlpha(accent, dark ? 0.35 : 0.22)),
    '--tw-code-string': normalizeHex(s.string, text),
    '--tw-code-number': normalizeHex(s.number, text),
    '--tw-code-keyword': normalizeHex(s.keyword, text),
    '--tw-code-class': normalizeHex(s.class, text),
    '--tw-code-property': normalizeHex(s.property ?? s.variable, text),
    '--tw-code-comment': normalizeHex(s.comment, muted),
    '--tw-code-null': normalizeHex(s.constant, muted),
    '--tw-code-bool': normalizeHex(s.constant, text),
    '--tw-code-key': normalizeHex(s.property ?? s.string, text),
    '--tw-code-meta': muted
  }
}

export function buildTheme(spec: ThemeSpec): ThemeDefinition {
  return {
    id: spec.id,
    name: spec.name,
    dark: spec.dark,
    custom: false,
    monacoName: monacoThemeName(spec.id),
    vars: chromeVars(spec),
    monaco: {
      base: spec.dark ? 'vs-dark' : 'vs',
      inherit: true,
      rules: syntaxRules(spec),
      colors: monacoColors(spec)
    }
  }
}

/** Foreground of the first rule whose token equals or starts with one of `tokens` (in order of preference). */
function ruleColor(theme: MonacoThemeJson, tokens: string[]): string | undefined {
  for (const token of tokens) {
    const exact = theme.rules.find((r) => r.foreground && r.token === token)
    if (exact?.foreground) return '#' + exact.foreground.replace(/^#/, '')
    const prefix = theme.rules.find((r) => r.foreground && r.token.split(/\s+/).some((t) => t.startsWith(token)))
    if (prefix?.foreground) return '#' + prefix.foreground.replace(/^#/, '')
  }
  return undefined
}

function pick(...values: Array<string | undefined>): string | undefined {
  return values.find((v) => isHexColor(v))
}

/**
 * Convert a custom theme (Monaco JSON + optional `custom` chrome block) into a ThemeDefinition.
 * Missing chrome keys are derived from the Monaco colors (editor.background, editor.foreground, cursor…).
 * Recognized `custom` keys: background, alternate, surface, border, text, mutedText, accent, accentText,
 * primary.background / primary.textColor / primary.foreground (accent), secondary.background, sidebar, titlebar.
 */
export function fromCustomTheme(custom: CustomTheme): ThemeDefinition {
  const t = custom.theme
  const c = t.custom ?? {}
  const colors = t.colors ?? {}
  const baseDark = t.base === 'vs-dark' || t.base === 'hc-black'
  const editorBg = pick(colors['editor.background']) ?? (baseDark ? '#1e1e1e' : '#ffffff')
  const editorFg = pick(colors['editor.foreground']) ?? (baseDark ? '#d4d4d4' : '#1f1f1f')
  const dark = typeof c['theme.isLight'] === 'string' ? c['theme.isLight'] !== 'true' : baseDark || isDark(editorBg)
  const accent =
    pick(c.accent, c['primary.background'], colors['button.background'], colors['editorCursor.foreground'], colors['focusBorder']) ??
    (dark ? '#a78bfa' : '#7c3aed')
  const chromeBg = pick(c.background, c['secondary.background'], colors['sideBar.background'], colors['editorGroupHeader.tabsBackground']) ??
    mix(editorBg, dark ? '#000000' : editorFg, dark ? 0.18 : 0.04)
  const text = pick(c.text, c['default.textColor'], colors['foreground'], editorFg) ?? editorFg
  const fallbackSyntax = dark
    ? { comment: '#6a737d', string: '#a5d6a7', number: '#f78c6c', keyword: '#c792ea', variable: '#f07178', function: '#82aaff', class: '#ffcb6b', constant: '#f78c6c' }
    : { comment: '#8b949e', string: '#0a7f3f', number: '#b45309', keyword: '#7c3aed', variable: '#be185d', function: '#1d4ed8', class: '#0e7490', constant: '#c2410c' }
  const spec: ThemeSpec = {
    id: custom.id,
    name: custom.name,
    dark,
    chrome: {
      bg: chromeBg,
      bgAlt: pick(c.alternate),
      surface: pick(c.surface, colors['editorWidget.background'], editorBg) ?? editorBg,
      border: pick(c.border, colors['editorGroup.border'], colors['editorWidget.border']),
      text,
      textMuted: pick(c.mutedText, colors['descriptionForeground'], colors['editorLineNumber.foreground']),
      accent,
      accentFg: pick(c.accentText, c['primary.textColor'], c['primary.foreground'], colors['button.foreground']),
      sidebarBg: pick(c.sidebar, colors['activityBar.background']),
      titlebarBg: pick(c.titlebar, colors['titleBar.activeBackground'])
    },
    editor: {
      background: editorBg,
      foreground: editorFg,
      selection: pick(colors['editor.selectionBackground'])
    },
    syntax: {
      comment: ruleColor(t, ['comment']) ?? fallbackSyntax.comment,
      string: ruleColor(t, ['string']) ?? fallbackSyntax.string,
      number: ruleColor(t, ['number', 'constant.numeric']) ?? fallbackSyntax.number,
      keyword: ruleColor(t, ['keyword', 'storage']) ?? fallbackSyntax.keyword,
      variable: ruleColor(t, ['variable']) ?? fallbackSyntax.variable,
      function: ruleColor(t, ['entity.name.function', 'support.function', 'function']) ?? fallbackSyntax.function,
      class: ruleColor(t, ['entity.name.class', 'support.class', 'type']) ?? fallbackSyntax.class,
      constant: ruleColor(t, ['constant.language', 'constant']) ?? fallbackSyntax.constant
    }
  }
  const built = buildTheme(spec)
  return {
    ...built,
    custom: true,
    // The user's Monaco theme is used as-is (Monaco validates it); only the chrome is derived.
    monaco: {
      base: t.base,
      inherit: t.inherit,
      rules: t.rules.map((r) => ({ ...r })),
      colors: { ...colors }
    }
  }
}
