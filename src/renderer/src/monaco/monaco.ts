/**
 * The Monaco instance of the app. Only the editor core and its contributions are bundled (no other languages,
 * no TypeScript/CSS/HTML/JSON workers): Tinkerbox only edits PHP. The single web worker (diffing, word ranges,
 * link detection) is bundled by Vite through the `?worker` import.
 */
import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/features/register.all'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import './editor.css'

let configured = false

/** Tell Monaco how to start its web worker (call before creating the first editor). */
export function configureMonacoEnvironment(): void {
  if (configured || typeof self === 'undefined') return
  configured = true
  self.MonacoEnvironment = {
    getWorker: () => new EditorWorker()
  }
}

export { monaco }
export type Monaco = typeof monaco
