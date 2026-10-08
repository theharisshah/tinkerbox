/**
 * Monaco support for CLI mode (read-only PsySH-style output): the `tinkerbox-cli` language (Monarch colors), a
 * link provider for file paths / "line N" / URLs and the opener that routes those links to the editor, the
 * preferred external editor or the browser.
 *
 * Monaco is imported from the same ESM build the code editor uses (src/renderer/src/monaco), so services, the
 * web worker setup, app keybinding rules and themes are shared: the theme is global in Monaco and the code editor
 * keeps it on the app theme (its theme data adds editor-only rules, so it is never re-defined here).
 */
import * as monaco from 'monaco-editor/editor/editor.api'
// Editor contributions CLI mode relies on (no-ops when the code editor already loaded the full build).
import 'monaco-editor/editor/contrib/links/browser/links'
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution'
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard'
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu'
import 'monaco-editor/editor/contrib/find/browser/findController'
import 'monaco-editor/editor/contrib/readOnlyMessage/browser/contribution'
import { api } from '../../api'
import { useAppStore } from '../../stores/app'
import { openInEditor, revealLine } from './actions'
import { findCliLinks, type CliLinkTarget } from './lib/cliLinks'

export { monaco }

export const CLI_LANGUAGE = 'tinkerbox-cli'
const LINK_SCHEME = 'tinkerbox-cli-link'
const MAX_LINK_TARGETS = 20000

interface LinkContext {
  tabId: string | null
  connectionId: string | null
}

const context: LinkContext = { tabId: null, connectionId: null }
const targets = new Map<string, CliLinkTarget>()
let nextId = 0
let installed = false

/** Tab whose output is shown (links reveal lines in its editor / resolve files against its project). */
export function setCliLinkContext(tabId: string | null, connectionId: string | null): void {
  context.tabId = tabId
  context.connectionId = connectionId
}

function linkUri(target: CliLinkTarget): monaco.Uri {
  if (targets.size > MAX_LINK_TARGETS) targets.clear()
  const id = String(++nextId)
  targets.set(id, target)
  return monaco.Uri.from({ scheme: LINK_SCHEME, path: `/${id}` })
}

function tooltip(target: CliLinkTarget): string {
  switch (target.kind) {
    case 'url':
      return 'Open in the browser'
    case 'file':
      return 'Open in your editor'
    case 'line':
      return `Show line ${target.line} in the editor`
  }
}

function expandHome(file: string): string {
  if (!file.startsWith('~/')) return file
  const home = useAppStore().homeDir
  return home ? home.replace(/[\\/]+$/, '') + file.slice(1) : file
}

async function follow(target: CliLinkTarget): Promise<void> {
  switch (target.kind) {
    case 'url':
      try {
        await api.invoke('shell:openExternal', target.url)
      } catch (err) {
        console.error('openExternal failed', err)
      }
      return
    case 'file':
      await openInEditor(expandHome(target.file), target.line, context.connectionId)
      return
    case 'line':
      revealLine(context.tabId, target.line)
  }
}

/** Register the language, colors, links and opener once. */
export function ensureCliSupport(): void {
  if (installed) return
  installed = true

  monaco.languages.register({ id: CLI_LANGUAGE })
  monaco.languages.setMonarchTokensProvider(CLI_LANGUAGE, {
    defaultToken: '',
    tokenizer: {
      root: [
        // Status lines ("   WARNING  …", "   RuntimeException  …"): colored label, plain message.
        [/^ {3}(?:ERROR|BOOTSTRAP FAILED)(?= {2})/, { token: 'invalid', next: '@message' }],
        [/^ {3}(?:WARNING|NOTICE|DEPRECATED|USER WARNING|USER NOTICE|USER DEPRECATED|STRICT)(?= {2})/, { token: 'annotation', next: '@message' }],
        [/^ {3}INFO(?= {2})/, { token: 'comment', next: '@message' }],
        [/^ {3}Caused by [A-Za-z_\\][\w\\]*(?= {2})/, { token: 'invalid', next: '@message' }],
        [/^ {3}[A-Za-z_\\][\w\\]*(?= {2}\S)/, { token: 'invalid', next: '@message' }],
        [/^= /, 'keyword'],
        [/\/\/.*$/, 'comment'],
        [/; -- [\d.]+ms \(.*\)$/, 'comment'],
        [/b?"""$/, { token: 'string', next: '@heredoc' }],
        [/b?"(?:[^"\\]|\\.)*"…?/, 'string'],
        [/\b(?:null|true|false)\b/, 'constant'],
        [/[+#-]?"?[A-Za-z_\x80-￿][\w\x80-￿]*"?(?=: )/, 'property'],
        [/\{#\d+|#\d+|@\d+/, 'comment'],
        [/\\?(?:[A-Za-z_]\w*\\)+[A-Za-z_]\w*/, 'type'],
        [/\b[A-Z]\w*(?= \{| @\d|::)/, 'type'],
        [/::\w+/, 'keyword'],
        [/\bClosure\b/, 'type'],
        [/-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\bINF\b|\bNAN\b/, 'number'],
        [/=>/, 'operator'],
        [/[{}[\](),]/, 'delimiter']
      ],
      message: [[/.*$/, { token: '', next: '@pop' }]],
      heredoc: [
        [/^\s*"""…?$/, { token: 'string', next: '@pop' }],
        [/.*$/, 'string']
      ]
    }
  })

  monaco.languages.registerLinkProvider(CLI_LANGUAGE, {
    provideLinks(model) {
      const links: monaco.languages.ILink[] = []
      const count = model.getLineCount()
      for (let n = 1; n <= count && links.length < 5000; n++) {
        const text = model.getLineContent(n)
        if (text.length > 4000) continue
        for (const link of findCliLinks(text)) {
          links.push({
            range: new monaco.Range(n, link.start + 1, n, link.end + 1),
            url: linkUri(link.target),
            tooltip: tooltip(link.target)
          })
        }
      }
      return { links }
    }
  })

  monaco.editor.registerLinkOpener({
    open(resource) {
      if (resource.scheme !== LINK_SCHEME) return false
      const target = targets.get(resource.path.replace(/^\//, ''))
      if (target) void follow(target)
      return true
    }
  })
}
