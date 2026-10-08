import type { editor } from 'monaco-editor/editor/editor.api'

/** Declarations of the vendored monaco-vim build (the subset Tinkerbox uses). */

export interface VimAdapterInstance {
  dispose(): void
}

export interface VimApi {
  defineEx(name: string, prefix: string, handler: () => void): void
}

export declare const VimMode: { Vim?: VimApi }

export declare class StatusBar {
  constructor(node: HTMLElement, editor: editor.IStandaloneCodeEditor | null)
}

export declare function initVimMode(editor: editor.IStandaloneCodeEditor, statusbarNode?: HTMLElement | null): VimAdapterInstance
