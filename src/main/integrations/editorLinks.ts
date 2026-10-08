import { spawn } from 'node:child_process'
import type { EditorIntegration } from '../../shared/types'

/** Normalize a path for use inside a URL: forward slashes, leading slash for Windows drive paths. */
function urlPath(file: string): string {
  const forward = file.replace(/\\/g, '/')
  return /^[A-Za-z]:\//.test(forward) ? `/${forward}` : forward
}

/** Percent-encode every path segment but keep the separators (and a Windows drive colon) readable. */
function encodePath(file: string): string {
  return urlPath(file)
    .split('/')
    .map((segment) => (/^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join('/')
}

function fileUrl(file: string): string {
  return `file://${encodePath(file)}`
}

/**
 * Deep link that opens `file` (optionally at `line`) in the given editor, or null when the
 * integration is disabled.
 */
export function editorUrl(integration: EditorIntegration, file: string, line?: number): string | null {
  const ln = line && line > 0 ? Math.floor(line) : undefined
  const suffix = ln ? `:${ln}` : ''
  switch (integration) {
    case 'vscode':
      return `vscode://file${encodePath(file)}${suffix}`
    case 'cursor':
      return `cursor://file${encodePath(file)}${suffix}`
    case 'windsurf':
      return `windsurf://file${encodePath(file)}${suffix}`
    case 'zed':
      return `zed://file${encodePath(file)}${suffix}`
    case 'phpstorm':
      return `phpstorm://open?file=${encodeURIComponent(file)}${ln ? `&line=${ln}` : ''}`
    case 'sublime':
      return `subl://open?url=${encodeURIComponent(fileUrl(file))}${ln ? `&line=${ln}` : ''}`
    case 'textmate':
      return `txmt://open?url=${encodeURIComponent(fileUrl(file))}${ln ? `&line=${ln}` : ''}`
    case 'nova':
      return `nova://open?path=${encodeURIComponent(file)}${ln ? `&line=${ln}` : ''}`
    case 'bbedit':
      return `x-bbedit://open?url=${encodeURIComponent(fileUrl(file))}${ln ? `&line=${ln}` : ''}`
    case 'none':
    default:
      return null
  }
}

/** CLI commands that open a folder, tried in order when the editor has no folder URL scheme. */
const EDITOR_CLIS: Partial<Record<EditorIntegration, string[]>> = {
  phpstorm: ['phpstorm', 'pstorm'],
  sublime: ['subl'],
  textmate: ['mate'],
  nova: ['nova'],
  bbedit: ['bbedit']
}

/** macOS application names used with `open -a` as the last resort before the file manager. */
const MAC_APPS: Partial<Record<EditorIntegration, string>> = {
  phpstorm: 'PhpStorm',
  sublime: 'Sublime Text',
  textmate: 'TextMate',
  nova: 'Nova',
  bbedit: 'BBEdit',
  zed: 'Zed',
  vscode: 'Visual Studio Code',
  cursor: 'Cursor',
  windsurf: 'Windsurf'
}

function trySpawn(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore' })
      child.once('error', () => resolve(false))
      child.once('spawn', () => {
        child.unref()
        resolve(true)
      })
    } catch {
      resolve(false)
    }
  })
}

/** Open a project directory in the preferred editor (URL scheme, editor CLI, `open -a`, then the file manager). */
export async function openProjectInEditor(integration: EditorIntegration, dir: string): Promise<void> {
  const { shell } = await import('electron')
  if (integration === 'none') {
    await shell.openPath(dir)
    return
  }
  // vscode / cursor / windsurf / zed open folders through their file URL scheme.
  if (integration === 'vscode' || integration === 'cursor' || integration === 'windsurf' || integration === 'zed') {
    const url = editorUrl(integration, dir)
    if (url) {
      await shell.openExternal(url)
      return
    }
  }
  for (const cli of EDITOR_CLIS[integration] ?? []) {
    if (await trySpawn(cli, [dir])) return
  }
  const app = MAC_APPS[integration]
  if (process.platform === 'darwin' && app && (await trySpawn('open', ['-a', app, dir]))) return
  const error = await shell.openPath(dir)
  if (error) throw new Error(`Could not open ${dir}: ${error}`)
}
