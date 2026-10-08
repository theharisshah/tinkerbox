import type { editor } from 'monaco-editor/editor/editor.api'
import type { Settings } from '@shared/types'
import { LANGUAGE_ID } from './language'

/** Editor options that never change. */
export const BASE_EDITOR_OPTIONS: editor.IStandaloneEditorConstructionOptions = {
  language: LANGUAGE_ID,
  automaticLayout: true,
  fixedOverflowWidgets: true,
  // The context menu's shadow root would sit outside `.monaco-editor`, where Monaco defines its theme variables, so
  // the menu rendered without background or border. In the light DOM it gets the `monaco-component` variables.
  useShadowDOM: false,
  scrollBeyondLastLine: false,
  padding: { top: 14, bottom: 14 },
  renderLineHighlight: 'all',
  lineDecorationsWidth: 14,
  lineNumbersMinChars: 3,
  glyphMargin: false,
  folding: true,
  showFoldingControls: 'mouseover',
  cursorBlinking: 'smooth',
  cursorSmoothCaretAnimation: 'on',
  cursorStyle: 'line',
  cursorWidth: 2,
  smoothScrolling: true,
  mouseWheelZoom: false,
  contextmenu: true,
  wordBasedSuggestions: 'off',
  quickSuggestions: { other: true, comments: false, strings: false },
  quickSuggestionsDelay: 40,
  suggestOnTriggerCharacters: true,
  acceptSuggestionOnEnter: 'on',
  tabCompletion: 'on',
  suggest: { showWords: false, preview: false, localityBonus: true, showStatusBar: false, filterGraceful: true },
  parameterHints: { enabled: true, cycle: true },
  hover: { enabled: 'on', delay: 350, sticky: true },
  stickyScroll: { enabled: false },
  bracketPairColorization: { enabled: false },
  matchBrackets: 'near',
  renderWhitespace: 'none',
  multiCursorModifier: 'alt',
  // Double-click / word navigation keep the `$` of PHP variables (Monaco's default separators include `$`).
  wordSeparators: '`~!@#%^&*()-=+[{]}\\|;:\'",.<>/?',
  dragAndDrop: true,
  overviewRulerBorder: false,
  hideCursorInOverviewRuler: true,
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false, alwaysConsumeMouseWheel: false },
  unicodeHighlight: { ambiguousCharacters: false },
  detectIndentation: false,
  insertSpaces: true,
  autoIndent: 'advanced',
  formatOnPaste: false,
  find: { addExtraSpaceOnTop: false, seedSearchStringFromSelection: 'selection', autoFindInSelection: 'never' },
  ariaLabel: 'PHP code editor',
  'semanticHighlighting.enabled': false
}

/** Options that follow the settings (font, zoom, ligatures, line height / numbers, guides, minimap, wrap). */
export function editorOptions(s: Settings): editor.IEditorOptions & editor.IGlobalEditorOptions {
  const fontSize = Number.isFinite(s.editorFontSize) ? Math.min(40, Math.max(8, s.editorFontSize)) : 16
  const lineHeight = Number.isFinite(s.lineHeight) && s.lineHeight > 0 ? s.lineHeight : 1.6
  return {
    fontFamily: s.editorFontFamily || 'monospace',
    fontSize,
    // Monaco treats values below 8 as a multiple of the font size.
    lineHeight: lineHeight < 8 ? lineHeight : Math.round(lineHeight),
    fontLigatures: !!s.fontLigatures,
    lineNumbers: s.lineNumbers ? 'on' : 'off',
    guides: { indentation: !!s.indentGuides, highlightActiveIndentation: !!s.indentGuides, bracketPairs: false },
    minimap: { enabled: !!s.minimap, renderCharacters: false },
    wordWrap: s.wordWrap ? 'on' : 'off',
    tabSize: tabSizeOf(s)
  }
}

export function tabSizeOf(s: Pick<Settings, 'tabSize'>): number {
  const n = Math.round(Number(s.tabSize))
  return Number.isFinite(n) && n >= 1 && n <= 16 ? n : 4
}
