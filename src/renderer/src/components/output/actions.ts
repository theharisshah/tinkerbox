import { markRaw } from 'vue'
import type { DumpNode } from '@shared/types'
import { api } from '../../api'
import { getEditor } from '../../editorBridge'
import { useConnectionsStore } from '../../stores/connections'
import { useUiStore } from '../../stores/ui'
import { useAppStore } from '../../stores/app'
import { tildify } from '../../utils/platform'

/** Side effects used by the output components (editor navigation, open in editor, clipboard, modals). */

/**
 * Scroll the tab's editor to a 1-based line of the shown run (where that line is now, when the code was edited
 * since) and put the cursor there.
 */
export function revealLine(tabId: string | null | undefined, line: number | undefined): void {
  if (!line || line < 1) return
  const editor = getEditor(tabId)
  if (!editor) {
    useUiStore().toast({ message: 'The editor of this tab is not available.', key: 'reveal-line', timeout: 3000 })
    return
  }
  editor.revealLine(editor.runLineToEditorLine?.(line) ?? line)
  editor.focus()
}

/** Open a project / absolute file at a line in the preferred editor (Settings → General → Editor). */
export async function openInEditor(file: string, line: number | undefined, connectionId: string | null): Promise<void> {
  try {
    await api.invoke('shell:openInEditor', file, line && line > 0 ? line : undefined, connectionId)
  } catch (err) {
    useUiStore().error(err, 'Could not open the file')
  }
}

export async function copyText(text: string, message = 'Copied to the clipboard.'): Promise<void> {
  try {
    await api.copy(text)
    useUiStore().toast({ level: 'success', message, key: 'output-copy', timeout: 2200 })
  } catch (err) {
    useUiStore().error(err, 'Could not copy')
  }
}

/** File path for display: relative to the tab's project when inside it, else with ~ for the home directory. */
export function displayPath(file: string, connectionId: string | null): string {
  if (!file) return ''
  let root = ''
  try {
    root = useConnectionsStore().path(connectionId)
  } catch {
    root = ''
  }
  const normalized = file.replace(/\\/g, '/')
  if (root) {
    const base = root.replace(/\\/g, '/').replace(/\/+$/, '') + '/'
    if (normalized.startsWith(base)) return normalized.slice(base.length)
  }
  try {
    return tildify(file, useAppStore().homeDir)
  } catch {
    return file
  }
}

export function openTablePreview(value: DumpNode, title?: string): void {
  void useUiStore().openModal('tablePreview', { value: markRaw(value), title })
}

export function openObjectGraph(value: DumpNode, title?: string): void {
  void useUiStore().openModal('objectGraph', { value: markRaw(value), title })
}

export function openHtmlPreview(html: string, title: string | undefined, tabId: string | undefined): void {
  void useUiStore().openModal('htmlPreview', { html, title, tabId })
}
