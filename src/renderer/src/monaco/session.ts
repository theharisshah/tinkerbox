import { effectScope, shallowRef, watch, type EffectScope } from 'vue'
import type { editor, IDisposable, IRange } from 'monaco-editor/editor/editor.api'
import type { CommandId } from '@shared/ipc'
import { executeCommand } from '../commands'
import { registerEditor, type EditorBridge, type EditorSelection } from '../editorBridge'
import { useEnvironmentStore } from '../stores/environment'
import { useSettingsStore } from '../stores/settings'
import { useTabsStore } from '../stores/tabs'
import { useUiStore } from '../stores/ui'
import { isMac } from '../utils/platform'
import type { DecorationSettings } from './decorations'
import { minimalEdit, prettifyPhp } from './format'
import { appendMagicComment } from './magic'
import { monaco } from './monaco'
import { BASE_EDITOR_OPTIONS, editorOptions, tabSizeOf } from './options'
import { allTabStates, ensureTabState, pruneTabStates, type TabEditorState } from './registry'
import { commandKeybinding, ensureMonaco } from './setup'
import { VimController } from './vim'

/**
 * The editor widget of the workspace. One Monaco editor is mounted once and swaps per-tab models (undo stacks,
 * decorations) and view states (cursor, selections, scroll, folding) when the active tab changes. It registers the
 * EditorBridge of the shown tab, mirrors buffer changes into the tabs store, follows the settings and hosts the
 * editor actions (context menu) and the vim mode.
 */

function decorationSettings(): DecorationSettings {
  const s = useSettingsStore().settings
  return { magicComments: s.magicComments, coverage: s.coverage, inlineErrors: s.inlineErrors }
}

function offsetRange(model: editor.ITextModel, start: number, end: number): IRange {
  const s = model.getPositionAt(start)
  const e = model.getPositionAt(end)
  return { startLineNumber: s.lineNumber, startColumn: s.column, endLineNumber: e.lineNumber, endColumn: e.column }
}

export class EditorSession {
  readonly editor: editor.IStandaloneCodeEditor
  private readonly scope: EffectScope = effectScope()
  private readonly disposables: IDisposable[] = []
  private actionDisposables: IDisposable[] = []
  private readonly vim: VimController
  /** Active tab id (reactive for the watchers). */
  private readonly current = shallowRef<string | null>(null)
  private state: TabEditorState | null = null
  private unregister: (() => void) | null = null
  /** Last buffer value known to be in the store (avoids echoing store updates back into the model). */
  private synced = ''
  /** > 0 while applying programmatic replacements (they are already in the store). */
  private external = 0
  private disposed = false

  constructor(host: HTMLElement) {
    ensureMonaco()
    const settings = useSettingsStore()
    this.editor = monaco.editor.create(host, { ...BASE_EDITOR_OPTIONS, ...editorOptions(settings.settings), model: null })
    this.vim = new VimController(this.editor, (err) => useUiStore().error(err, 'Vim mode could not be loaded'))
    this.disposables.push(this.editor.onDidChangeModelContent(() => this.onContentChanged()))
    this.registerActions()
    this.scope.run(() => this.watchState())
  }

  get tabId(): string | null {
    return this.current.value
  }

  // -- tabs -----------------------------------------------------------------------------------------------------

  /** Show a tab's buffer (creating its model on first use) and register its bridge. */
  show(tabId: string): void {
    if (this.disposed) return
    if (this.state && this.current.value === tabId && !this.state.model.isDisposed()) return
    this.saveViewState()
    this.unregister?.()
    this.unregister = null
    const tabs = useTabsStore()
    const tab = tabs.byId(tabId)
    if (!tab || tab.kind !== 'code') {
      this.state = null
      this.current.value = null
      this.editor.setModel(null)
      return
    }
    const state = ensureTabState(monaco, tabId, tab.code, tabSizeOf(useSettingsStore().settings))
    this.state = state
    this.current.value = tabId
    // The store may have changed the code while the tab was hidden (file reloads, snippets…).
    if (state.model.getValue() !== tab.code) this.replaceModel(state, tab.code)
    this.synced = tab.code
    this.editor.setModel(state.model)
    if (state.viewState) this.editor.restoreViewState(state.viewState)
    this.unregister = registerEditor(tabId, this.makeBridge(state))
    this.syncDecorations(state)
  }

  focus(): void {
    if (!this.disposed && this.state) this.editor.focus()
  }

  private saveViewState(): void {
    if (this.state && !this.state.model.isDisposed() && this.editor.getModel() === this.state.model) {
      this.state.viewState = this.editor.saveViewState()
    }
  }

  private isShown(state: TabEditorState): boolean {
    return !this.disposed && this.state === state && this.editor.getModel() === state.model
  }

  /** Decorations of the tab's latest result (runs that finished while another tab was shown, cleared output). */
  private syncDecorations(state: TabEditorState): void {
    const result = useTabsStore().resultOf(state.tabId)
    if (!result) {
      if (state.decorations.appliedRunId !== null || !state.decorations.isEmpty) state.decorations.clear()
      return
    }
    if (result.runId !== state.decorations.appliedRunId) state.decorations.apply(result, decorationSettings())
  }

  private onContentChanged(): void {
    const state = this.state
    if (!state || state.model.isDisposed()) return
    const value = state.model.getValue()
    this.synced = value
    if (this.external > 0) return
    useTabsStore().setCode(state.tabId, value)
  }

  // -- editing --------------------------------------------------------------------------------------------------

  /** Replace a model's text with an undoable minimal edit (programmatic: not echoed to the store). */
  private replaceModel(state: TabEditorState, code: string): void {
    const model = state.model
    const edit = minimalEdit(model.getValue(), code)
    if (!edit) return
    const range = offsetRange(model, edit.start, edit.end)
    this.external++
    try {
      if (this.isShown(state)) {
        this.editor.pushUndoStop()
        this.editor.executeEdits('tinkwell.replace', [{ range, text: edit.text, forceMoveMarkers: true }])
        this.editor.pushUndoStop()
      } else {
        model.pushStackElement()
        model.pushEditOperations([], [{ range, text: edit.text, forceMoveMarkers: true }], () => null)
        model.pushStackElement()
      }
    } finally {
      this.external--
    }
    if (this.state === state) this.synced = model.getValue()
  }

  private insertText(state: TabEditorState, text: string): void {
    const model = state.model
    if (this.isShown(state)) {
      const selection = this.editor.getSelection() ?? new monaco.Selection(1, 1, 1, 1)
      this.editor.pushUndoStop()
      this.editor.executeEdits('tinkwell.insert', [{ range: selection, text, forceMoveMarkers: true }])
      this.editor.pushUndoStop()
      this.editor.focus()
      return
    }
    const end = model.getFullModelRange().getEndPosition()
    const prefix = model.getValueLength() === 0 || model.getValue().endsWith('\n') ? '' : '\n'
    model.pushEditOperations([], [{ range: new monaco.Range(end.lineNumber, end.column, end.lineNumber, end.column), text: prefix + text }], () => null)
  }

  private selectionOf(state: TabEditorState): EditorSelection | null {
    if (!this.isShown(state)) return null
    const selection = this.editor.getSelection()
    if (!selection || selection.isEmpty()) return null
    const text = state.model.getValueInRange(selection)
    if (text === '') return null
    let endLine = selection.endLineNumber
    if (selection.endColumn === 1 && endLine > selection.startLineNumber) endLine--
    return { text, startLine: selection.startLineNumber, startColumn: selection.startColumn, endLine }
  }

  private cursorLine(state: TabEditorState): number {
    if (this.isShown(state)) return this.editor.getPosition()?.lineNumber ?? 1
    return state.viewState?.cursorState?.[0]?.position?.lineNumber ?? 1
  }

  private revealLine(state: TabEditorState, line: number): void {
    if (!this.isShown(state)) return
    const model = state.model
    const target = Math.min(Math.max(1, Math.round(line) || 1), model.getLineCount())
    const column = Math.max(1, model.getLineFirstNonWhitespaceColumn(target) || 1)
    this.editor.setPosition({ lineNumber: target, column })
    this.editor.revealLineInCenterIfOutsideViewport(target, monaco.editor.ScrollType.Smooth)
    this.editor.focus()
  }

  /** Append ` //?` to every cursor line (`// note` becomes `//? note`). */
  private addMagicComment(state: TabEditorState): void {
    const model = state.model
    const lines = new Set<number>()
    if (this.isShown(state)) {
      for (const selection of this.editor.getSelections() ?? []) lines.add(selection.positionLineNumber)
    } else {
      lines.add(this.cursorLine(state))
    }
    const edits: editor.IIdentifiedSingleEditOperation[] = []
    const code = model.getValue()
    for (const line of lines) {
      if (line < 1 || line > model.getLineCount()) continue
      const text = model.getLineContent(line)
      // The code above the line tells whether it continues a multi-line string / heredoc (left alone then).
      const next = appendMagicComment(text, code.slice(0, model.getOffsetAt({ lineNumber: line, column: 1 })))
      if (next === text) continue
      const edit = minimalEdit(text, next)
      if (!edit) continue
      edits.push({ range: new monaco.Range(line, edit.start + 1, line, edit.end + 1), text: edit.text })
    }
    if (edits.length === 0) return
    if (this.isShown(state)) {
      const before = this.editor.getSelections()
      this.editor.pushUndoStop()
      this.editor.executeEdits('tinkwell.magicComment', edits, before ?? undefined)
      this.editor.pushUndoStop()
      this.editor.focus()
    } else {
      model.pushEditOperations([], edits, () => null)
    }
  }

  /** Prettier PHP on the tab's buffer as one undoable edit; the cursor follows the code. */
  private async prettify(state: TabEditorState): Promise<void> {
    const settings = useSettingsStore().settings
    const tabs = useTabsStore()
    const model = state.model
    const code = model.getValue()
    if (code.trim() === '') return
    const shown = this.isShown(state)
    const position = shown ? this.editor.getPosition() : null
    const cursorOffset = position ? model.getOffsetAt(position) : 0
    const tab = tabs.byId(state.tabId)
    const phpVersion = tabs.resultOf(state.tabId)?.phpVersion || (tab ? useEnvironmentStore().get(tab.connectionId)?.phpVersion : null) || null
    const result = await prettifyPhp(code, cursorOffset, { quoteStyle: settings.prettierQuoteStyle, tabSize: settings.tabSize, phpVersion })
    if (model.isDisposed() || model.getValue() !== code) return // edited meanwhile
    const edit = minimalEdit(code, result.code)
    if (!edit) return
    const range = offsetRange(model, edit.start, edit.end)
    if (this.isShown(state)) {
      const scrollTop = this.editor.getScrollTop()
      this.editor.pushUndoStop()
      this.editor.executeEdits('tinkwell.prettify', [{ range, text: edit.text }], () => {
        const pos = model.getPositionAt(result.cursorOffset)
        return [new monaco.Selection(pos.lineNumber, pos.column, pos.lineNumber, pos.column)]
      })
      this.editor.pushUndoStop()
      this.editor.setScrollTop(scrollTop)
      const pos = this.editor.getPosition()
      if (pos) this.editor.revealPositionInCenterIfOutsideViewport(pos)
    } else {
      model.pushStackElement()
      model.pushEditOperations([], [{ range, text: edit.text }], () => null)
      model.pushStackElement()
      tabs.setCode(state.tabId, model.getValue())
    }
  }

  private makeBridge(state: TabEditorState): EditorBridge {
    return {
      getCode: () => (state.model.isDisposed() ? (useTabsStore().byId(state.tabId)?.code ?? '') : state.model.getValue()),
      getSelection: () => this.selectionOf(state),
      insertText: (text: string) => this.insertText(state, text),
      replaceAll: (code: string) => this.replaceModel(state, code),
      focus: () => {
        if (this.isShown(state)) this.editor.focus()
      },
      revealLine: (line: number) => this.revealLine(state, line),
      beginRun: (runId, selection) =>
        state.decorations.beginRun(runId, selection ? { line: selection.startLine, column: selection.startColumn ?? 1 } : null),
      applyRunDecorations: (result) => state.decorations.apply(result, decorationSettings()),
      runLineToEditorLine: (line) => state.decorations.runLineMap().nearest(line),
      clearDecorations: () => state.decorations.clear(),
      getCursorLine: () => this.cursorLine(state),
      prettify: () => this.prettify(state),
      addMagicComment: () => this.addMagicComment(state)
    }
  }

  // -- actions --------------------------------------------------------------------------------------------------

  private openSnippetSave(selectionOnly: boolean): void {
    const state = this.state
    if (!state) return
    const ui = useUiStore()
    const code = selectionOnly ? (this.selectionOf(state)?.text ?? '') : state.model.getValue()
    if (code.trim() === '') {
      ui.toast({ message: selectionOnly ? 'Select some code first.' : 'There is no code to save yet.', key: 'no-selection', timeout: 3000 })
      return
    }
    const tab = useTabsStore().byId(state.tabId)
    void ui.openModal('snippetSave', { code, connectionId: tab?.connectionId ?? null })
  }

  /** Context menu actions (re-created when their shortcuts change). */
  private registerActions(): void {
    for (const d of this.actionDisposables.splice(0)) d.dispose()
    const keys = (id: CommandId): number[] => {
      const kb = commandKeybinding(id)
      return kb === null ? [] : [kb]
    }
    const add = (descriptor: editor.IActionDescriptor): void => {
      this.actionDisposables.push(this.editor.addAction(descriptor))
    }
    const { KeyMod, KeyCode } = monaco
    add({
      id: 'tinkwell.runSelection',
      label: 'Run Selected Code',
      precondition: 'editorHasSelection',
      keybindings: keys('runSelection'),
      contextMenuGroupId: '0_tinkwell',
      contextMenuOrder: 1,
      run: () => void executeCommand('runSelection')
    })
    add({
      id: 'tinkwell.addMagicComment',
      label: 'Add Magic Comment at End of Line',
      keybindings: keys('addMagicComment'),
      contextMenuGroupId: '0_tinkwell',
      contextMenuOrder: 2,
      run: () => {
        if (this.state) this.addMagicComment(this.state)
      }
    })
    add({
      id: 'tinkwell.addToSnippets',
      label: 'Add Code to Snippets',
      keybindings: keys('addToSnippets'),
      contextMenuGroupId: '0_tinkwell',
      contextMenuOrder: 3,
      run: () => this.openSnippetSave(false)
    })
    add({
      id: 'tinkwell.addSelectionToSnippets',
      label: 'Add Selected Code to Snippets',
      precondition: 'editorHasSelection',
      keybindings: keys('addSelectionToSnippets'),
      contextMenuGroupId: '0_tinkwell',
      contextMenuOrder: 4,
      run: () => this.openSnippetSave(true)
    })
    add({
      id: 'tinkwell.prettify',
      label: 'Prettify Code',
      keybindings: keys('prettify'),
      contextMenuGroupId: '1_tinkwell',
      contextMenuOrder: 1,
      run: () => void executeCommand('prettify')
    })
    add({
      id: 'tinkwell.importClass',
      label: 'Import Class…',
      contextMenuGroupId: '1_tinkwell',
      contextMenuOrder: 2,
      run: (ed) => ed.trigger('tinkwell', 'editor.action.quickFix', null)
    })
    add({
      id: 'tinkwell.triggerSuggest',
      label: 'Trigger Completion',
      keybindings: [(isMac ? KeyMod.WinCtrl : KeyMod.CtrlCmd) | KeyCode.Space],
      contextMenuGroupId: '1_tinkwell',
      contextMenuOrder: 3,
      run: (ed) => ed.trigger('tinkwell', 'editor.action.triggerSuggest', {})
    })
  }

  // -- reactive state -------------------------------------------------------------------------------------------

  private watchState(): void {
    const settings = useSettingsStore()
    const tabs = useTabsStore()
    const ui = useUiStore()

    watch(
      () => editorOptions(settings.settings),
      (options) => this.editor.updateOptions(options)
    )
    watch(
      () => tabSizeOf(settings.settings),
      (size) => {
        for (const s of allTabStates()) if (!s.model.isDisposed()) s.model.updateOptions({ tabSize: size, indentSize: size })
      }
    )
    watch(
      () => settings.settings.editorFontFamily,
      () => setTimeout(() => monaco.editor.remeasureFonts(), 50)
    )
    watch(
      () => [settings.settings.magicComments, settings.settings.coverage, settings.settings.inlineErrors].join(','),
      () => {
        for (const s of allTabStates()) {
          const result = tabs.resultOf(s.tabId)
          if (result && s.decorations.appliedRunId === result.runId) s.decorations.apply(result, decorationSettings())
        }
      }
    )
    watch(
      () => (['runSelection', 'addMagicComment', 'addToSnippets', 'addSelectionToSnippets', 'prettify'] as CommandId[]).map((id) => settings.accelerator(id)).join('\n'),
      () => this.registerActions()
    )
    // Closed tabs: drop their models.
    watch(
      () => tabs.tabs.map((t) => t.id).join('\n'),
      () => {
        pruneTabStates(tabs.tabs.map((t) => t.id))
        if (this.state?.model.isDisposed()) {
          this.state = null
          this.unregister?.()
          this.unregister = null
        }
      }
    )
    // Store → editor: code replaced without the bridge (e.g. while the tab was hidden).
    watch(
      () => (this.current.value ? tabs.byId(this.current.value)?.code : undefined),
      (code) => {
        const state = this.state
        if (!state || code === undefined || code === this.synced || state.model.isDisposed()) return
        if (code !== state.model.getValue()) this.replaceModel(state, code)
        this.synced = code
      }
    )
    // Results that arrived without applyRunDecorations (tab switched mid-run) or cleared output.
    watch(
      () => (this.current.value ? tabs.resultOf(this.current.value) : null),
      () => {
        if (this.state) this.syncDecorations(this.state)
      }
    )
    // Vim mode and its footer slot.
    watch(
      () => settings.settings.vimMode,
      async (on) => {
        if (on) {
          await this.vim.enable()
          this.vim.attachStatus(this.current.value)
        } else this.vim.disable()
      },
      { immediate: true }
    )
    watch(
      () => [this.current.value, ui.zen, settings.settings.vimMode, ui.showChrome],
      () => this.vim.attachStatus(this.current.value),
      { flush: 'post' }
    )
  }

  dispose(): void {
    if (this.disposed) return
    this.saveViewState()
    this.disposed = true
    this.unregister?.()
    this.unregister = null
    this.scope.stop()
    this.vim.dispose()
    for (const d of this.actionDisposables.splice(0)) d.dispose()
    for (const d of this.disposables.splice(0)) d.dispose()
    this.editor.setModel(null)
    this.editor.dispose()
    this.state = null
    this.current.value = null
  }
}
