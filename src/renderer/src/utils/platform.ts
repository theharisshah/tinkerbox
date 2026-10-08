/**
 * Platform detection for the renderer. Inside Electron the preload bridge reports `process.platform`; in a plain
 * browser (development without Electron, unit tests) it is derived from the user agent.
 */

export type Platform = NodeJS.Platform

export function detectPlatform(): Platform {
  if (typeof window !== 'undefined' && window.tinkerbox && typeof window.tinkerbox.platform === 'string') {
    return window.tinkerbox.platform
  }
  const ua = typeof navigator !== 'undefined' ? `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}` : ''
  if (/mac|iphone|ipad/i.test(ua)) return 'darwin'
  if (/win/i.test(ua)) return 'win32'
  return 'linux'
}

/** Platform of the running app (resolved once at startup). */
export const platform: Platform = detectPlatform()
export const isMac = platform === 'darwin'
export const isWindows = platform === 'win32'
export const isLinux = platform === 'linux'

/** "⌘" on macOS, "Ctrl" elsewhere — for inline hints such as "⌘Enter". */
export function modKeyLabel(p: Platform = platform): string {
  return p === 'darwin' ? '⌘' : 'Ctrl'
}

/** File manager name used in "Reveal in …" labels. */
export function fileManagerName(p: Platform = platform): string {
  if (p === 'darwin') return 'Finder'
  if (p === 'win32') return 'Explorer'
  return 'File Manager'
}

/** Last path segment of a POSIX or Windows path ("/a/b/c" → "c"). */
export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed
}

/** Directory part of a path ("/a/b/c" → "/a/b"). */
export function dirname(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (idx < 0) return ''
  return idx === 0 ? trimmed.slice(0, 1) : trimmed.slice(0, idx)
}

/** Replace the home directory prefix with "~" for display. */
export function tildify(path: string, home: string | undefined): string {
  if (!home || !path.startsWith(home)) return path
  const rest = path.slice(home.length)
  return rest === '' || rest.startsWith('/') || rest.startsWith('\\') ? `~${rest}` : path
}
