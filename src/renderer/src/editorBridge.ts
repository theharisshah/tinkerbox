import { shallowReactive } from 'vue'
import type { RunResult } from '@shared/types'

/**
 * Contract between the code editor (R2, Monaco) and the rest of the renderer. Each mounted editor registers a
 * bridge for its tab; stores and commands talk to the editor exclusively through it, so they never import Monaco.
 */

export interface EditorSelection {
  /** Selected text (may span several lines). */
  text: string
  /** 1-based editor line where the selection starts (becomes RunRequest.lineOffset). */
  startLine: number
  /** 1-based editor column where the selection starts (magic comment columns on its first line are relative to it). */
  startColumn?: number
  /** 1-based editor line where the selection ends. */
  endLine: number
}

export interface EditorBridge {
  /** Full buffer contents. */
  getCode(): string
  /** Current non-empty selection, or null when nothing is selected. */
  getSelection(): EditorSelection | null
  /** Insert at the cursor (replacing the selection when there is one). */
  insertText(text: string): void
  /** Replace the whole buffer (keeps undo history when possible). */
  replaceAll(code: string): void
  focus(): void
  /** Scroll so the 1-based line is visible and put the cursor there. */
  revealLine(line: number): void
  /**
   * A run of the buffer as it is now starts (`selection` for selection runs). The editor remembers the buffer so the
   * run's decorations and line links land on the right lines when it is edited before / after the result arrives.
   */
  beginRun?(runId: string, selection: EditorSelection | null): void
  /** Magic comment badges, coverage gutter, inline errors… for a finished run. */
  applyRunDecorations(result: RunResult): void
  /** Current editor line of a line of the shown run's result (it may have moved since the run). */
  runLineToEditorLine?(line: number): number
  clearDecorations(): void
  /** 1-based line of the primary cursor. */
  getCursorLine(): number
  /** Format the buffer (Prettier PHP). Optional: absent in editors without a formatter. */
  prettify?(): Promise<void>
  /** Append a `//?` magic comment to the cursor line. Optional: the command falls back to text editing. */
  addMagicComment?(): void
}

const editors = shallowReactive(new Map<string, EditorBridge>())

/**
 * Register the editor of a tab. Returns the unregister function (call it on unmount). Registering again for the
 * same tab replaces the previous bridge.
 */
export function registerEditor(tabId: string, bridge: EditorBridge): () => void {
  editors.set(tabId, bridge)
  return () => {
    if (editors.get(tabId) === bridge) editors.delete(tabId)
  }
}

/** Bridge of a tab's editor, or null when that editor is not mounted. Reactive (usable in computed()). */
export function getEditor(tabId: string | null | undefined): EditorBridge | null {
  if (!tabId) return null
  return editors.get(tabId) ?? null
}

export function hasEditor(tabId: string | null | undefined): boolean {
  return !!tabId && editors.has(tabId)
}

/** Fallback for addMagicComment: append " //?" to the cursor line through getCode/replaceAll. */
export function appendMagicComment(bridge: EditorBridge): void {
  if (bridge.addMagicComment) {
    bridge.addMagicComment()
    return
  }
  const lines = bridge.getCode().split('\n')
  const index = Math.min(Math.max(bridge.getCursorLine(), 1), lines.length) - 1
  const line = lines[index] ?? ''
  if (/\/\/\?\s*$|#\?\s*$/.test(line)) return
  lines[index] = line.replace(/\s+$/, '') + ' //?'
  bridge.replaceAll(lines.join('\n'))
  bridge.revealLine(index + 1)
}
