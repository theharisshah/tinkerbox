import DOMPurify from 'dompurify'
import { Marked } from 'marked'
// Vite inlines the file at build time (relative to this module: the repository root).
import changelogSource from '../../../../../../CHANGELOG.md?raw'

/** Release notes from CHANGELOG.md rendered to sanitized HTML (Updates page). */

const markdown = new Marked({ gfm: true, breaks: false })

export const CHANGELOG_MARKDOWN: string = changelogSource

/** Drop the top-level "# Changelog" title; the page has its own heading. */
export function stripTitle(md: string): string {
  return md.replace(/^\s*#\s+[^\n]*\n+/, '')
}

/** Markdown → HTML (not sanitized; use renderChangelog() for anything inserted into the page). */
export function markdownToHtml(md: string): string {
  return markdown.parse(stripTitle(md), { async: false })
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

/** Sanitized HTML for v-html. Without a DOM (DOMPurify unsupported) the markdown is returned as escaped text. */
export function renderChangelog(md: string = CHANGELOG_MARKDOWN): string {
  const html = markdownToHtml(md)
  if (typeof DOMPurify.sanitize !== 'function' || DOMPurify.isSupported === false) return `<pre>${escapeHtml(stripTitle(md))}</pre>`
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
}
