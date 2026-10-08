import type { editor } from 'monaco-editor/editor/editor.api'
import { RunDecorations } from './decorations'
import { LANGUAGE_ID } from './language'
import type { Monaco } from './monaco'

/**
 * One Monaco model per code tab (undo history, decorations and markers live on the model) plus the tab's saved view
 * state (cursor, selections, scroll, folding). Models outlive the editor widget: the editor is unmounted while the
 * "Get started" tab is shown and re-attaches to the same models afterwards.
 */

export interface TabEditorState {
  tabId: string
  model: editor.ITextModel
  viewState: editor.ICodeEditorViewState | null
  decorations: RunDecorations
}

const states = new Map<string, TabEditorState>()

export function modelUri(monaco: Monaco, tabId: string): ReturnType<Monaco['Uri']['from']> {
  return monaco.Uri.from({ scheme: 'tinkwell', path: `/${encodeURIComponent(tabId)}.php` })
}

export function getTabState(tabId: string): TabEditorState | undefined {
  return states.get(tabId)
}

/** Model (and state) of a tab, created with `code` on first use. */
export function ensureTabState(monaco: Monaco, tabId: string, code: string, tabSize: number): TabEditorState {
  const existing = states.get(tabId)
  if (existing && !existing.model.isDisposed()) return existing
  const uri = modelUri(monaco, tabId)
  const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(code, LANGUAGE_ID, uri)
  model.updateOptions({ tabSize, indentSize: tabSize, insertSpaces: true, trimAutoWhitespace: true })
  if (model.getEOL() !== '\n') model.setEOL(monaco.editor.EndOfLineSequence.LF)
  const state: TabEditorState = { tabId, model, viewState: null, decorations: new RunDecorations(monaco, model) }
  states.set(tabId, state)
  return state
}

/** Tab id of a model (null for models that do not belong to a tab). */
export function tabIdOfModel(model: editor.ITextModel): string | null {
  for (const state of states.values()) if (state.model === model) return state.tabId
  return null
}

export function allTabStates(): TabEditorState[] {
  return [...states.values()]
}

export function disposeTabState(tabId: string): void {
  const state = states.get(tabId)
  if (!state) return
  states.delete(tabId)
  state.decorations.dispose()
  if (!state.model.isDisposed()) state.model.dispose()
}

/** Dispose the models of tabs that no longer exist. */
export function pruneTabStates(liveTabIds: Iterable<string>): void {
  const live = new Set(liveTabIds)
  for (const id of [...states.keys()]) if (!live.has(id)) disposeTabState(id)
}
