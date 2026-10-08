/** What a click on a link inside the HTML Preview frame does. */
export type PreviewLinkAction = { kind: 'fragment'; id: string } | { kind: 'open'; url: string } | { kind: 'none' }

const OPENABLE = /^(https?:|mailto:|tel:)/i

/**
 * Decide what a link click in the preview does.
 *  - `raw` is the `href` attribute as written. An in-page `#id` link scrolls the frame. It has to be read from the
 *    attribute, because `anchor.href` resolves against the app page (srcdoc frames inherit its URL), so `#bottom`
 *    comes back as `file:///…/index.html#bottom`.
 *  - `resolved` is `anchor.href`. http(s), mailto and tel links open outside the app.
 *  - `appOrigin` is the app page's origin. A relative link in content without a `<base href>` resolves to the app
 *    page itself (the dev server in development), and there is nothing to open then.
 */
export function previewLinkAction(raw: string, resolved: string, appOrigin: string): PreviewLinkAction {
  const href = raw.trim()
  if (href.startsWith('#')) {
    let id = href.slice(1)
    try {
      id = decodeURIComponent(id)
    } catch {
      // Malformed escapes: use the fragment as written.
    }
    return { kind: 'fragment', id }
  }
  const url = resolved || href
  if (!OPENABLE.test(url)) return { kind: 'none' }
  if (/^https?:/i.test(url)) {
    let origin: string
    try {
      origin = new URL(url).origin
    } catch {
      return { kind: 'none' }
    }
    if (origin === appOrigin) return { kind: 'none' }
  }
  return { kind: 'open', url }
}
