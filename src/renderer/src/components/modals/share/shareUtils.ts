/** Helpers of the "Share as GitHub Gist" modal (tests/unit/modals-b/share.test.ts). */

/** Token page with the `gist` scope pre-selected. */
export const GITHUB_TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=gist&description=Tinkerbox'

/** The renderer only sees the masked token: any non-empty value means a token is configured. */
export function hasGithubToken(token: string | null | undefined): boolean {
  return typeof token === 'string' && token.trim() !== ''
}

/** Code without the leading `<?php` tag (the gist file gets its own). */
export function stripOpenTag(code: string): string {
  return code.replace(/^\s*<\?php\b\s*/, '')
}

/** Whether there is anything worth sharing. */
export function isShareable(code: string | null | undefined): boolean {
  return stripOpenTag(code ?? '').trim() !== ''
}

export interface CodePreview {
  lines: string[]
  /** Lines not shown in the preview. */
  more: number
  total: number
}

/** First `max` lines of the code (trailing blank lines ignored) for the preview. */
export function codePreview(code: string, max = 14): CodePreview {
  const all = stripOpenTag(code).replace(/\s+$/, '').split(/\r?\n/)
  const total = all.length === 1 && all[0] === '' ? 0 : all.length
  return { lines: all.slice(0, max), more: Math.max(0, total - max), total }
}

/** Gist id from its URL ("https://gist.github.com/user/abc123" → "abc123"). */
export function gistId(url: string): string {
  const m = /gist\.github\.com\/(?:[^/]+\/)?([0-9a-f]+)/i.exec(url)
  return m ? m[1] : ''
}
