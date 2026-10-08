import type { editor } from 'monaco-editor/editor/editor.api'
import { executeCommand } from '../commands'

/**
 * Vim keymap (monaco-vim), loaded on demand. The mode / key buffer / `:` prompt render into one status node that is
 * moved into the footer slot of the active tab (`#vim-status-<tabId>`, provided by the shell's StatusBar).
 *
 * monaco-vim is loaded from a vendored copy (./vendor/monaco-vim.js): the package imports
 * `monaco-editor/esm/vs/...` paths that monaco-editor 0.57 no longer exports, so Vite cannot bundle it as is (and
 * its dev optimizer fails on it). With a renderer alias for those paths this can import 'monaco-vim' directly.
 */

interface VimAdapter {
  dispose(): void
}

interface VimApi {
  defineEx(name: string, prefix: string, handler: () => void): void
}

interface VimModule {
  initVimMode(editor: editor.IStandaloneCodeEditor, statusbarNode?: HTMLElement | null): VimAdapter
  VimMode?: { Vim?: VimApi }
}

let loading: Promise<VimModule> | null = null
let exCommandsDefined = false

function loadVim(): Promise<VimModule> {
  loading ??= (import('./vendor/monaco-vim') as Promise<VimModule>).catch((err: unknown) => {
    loading = null
    throw err
  })
  return loading
}

function defineExCommands(mod: VimModule): void {
  if (exCommandsDefined) return
  const vim = mod.VimMode?.Vim
  if (!vim) return
  exCommandsDefined = true
  try {
    vim.defineEx('write', 'w', () => void executeCommand('saveFile'))
    vim.defineEx('run', 'ru', () => void executeCommand('run'))
  } catch (err) {
    console.warn('Could not define vim ex commands:', err)
  }
}

export class VimController {
  private adapter: VimAdapter | null = null
  private generation = 0
  readonly statusNode: HTMLDivElement

  constructor(
    private readonly editor: editor.IStandaloneCodeEditor,
    private readonly onError: (err: unknown) => void
  ) {
    this.statusNode = document.createElement('div')
    this.statusNode.className = 'tw-vim-status'
  }

  get enabled(): boolean {
    return this.adapter !== null
  }

  async enable(): Promise<void> {
    if (this.adapter) return
    const generation = ++this.generation
    try {
      const mod = await loadVim()
      if (generation !== this.generation || this.adapter) return
      defineExCommands(mod)
      this.statusNode.replaceChildren()
      this.adapter = mod.initVimMode(this.editor, this.statusNode)
    } catch (err) {
      if (generation === this.generation) this.onError(err)
    }
  }

  disable(): void {
    this.generation++
    const adapter = this.adapter
    this.adapter = null
    if (adapter) {
      try {
        adapter.dispose()
      } catch (err) {
        console.warn('Disposing vim mode failed:', err)
      }
    }
    this.statusNode.replaceChildren()
  }

  /** Move the status node into the footer slot of a tab (no-op when the slot is not rendered). */
  attachStatus(tabId: string | null): void {
    if (!tabId || typeof document === 'undefined') return
    const slot = document.getElementById(`vim-status-${tabId}`)
    if (slot && this.statusNode.parentElement !== slot) slot.replaceChildren(this.statusNode)
  }

  dispose(): void {
    this.disable()
    this.statusNode.remove()
  }
}
