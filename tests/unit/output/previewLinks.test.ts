import { describe, expect, it } from 'vitest'
import { previewLinkAction } from '@/components/output/lib/previewLinks'

/** Link clicks inside the HTML Preview frame (HtmlPreviewModal.vue). */

const PACKAGED = 'null' // window.location.origin of the file:// app page
const DEV = 'http://localhost:5173'

describe('HTML preview links', () => {
  it('scrolls to in-page anchors although anchor.href resolves against the app page', () => {
    expect(previewLinkAction('#bottom', 'file:///Applications/Tinkerbox.app/out/renderer/index.html#bottom', PACKAGED)).toEqual({
      kind: 'fragment',
      id: 'bottom'
    })
    expect(previewLinkAction(' #top ', `${DEV}/#top`, DEV)).toEqual({ kind: 'fragment', id: 'top' })
    expect(previewLinkAction('#', `${DEV}/#`, DEV)).toEqual({ kind: 'fragment', id: '' })
    expect(previewLinkAction('#caf%C3%A9', `${DEV}/#caf%C3%A9`, DEV)).toEqual({ kind: 'fragment', id: 'café' })
    expect(previewLinkAction('#100%', `${DEV}/#100%`, DEV)).toEqual({ kind: 'fragment', id: '100%' })
  })

  it('opens web, mail and phone links outside the app', () => {
    expect(previewLinkAction('https://laravel.com/docs', 'https://laravel.com/docs', PACKAGED)).toEqual({ kind: 'open', url: 'https://laravel.com/docs' })
    expect(previewLinkAction('mailto:a@b.test', 'mailto:a@b.test', PACKAGED)).toEqual({ kind: 'open', url: 'mailto:a@b.test' })
    expect(previewLinkAction('tel:+123', 'tel:+123', DEV)).toEqual({ kind: 'open', url: 'tel:+123' })
    // Content with its own <base href>: relative links resolve against it.
    expect(previewLinkAction('pricing', 'https://example.test/pricing', DEV)).toEqual({ kind: 'open', url: 'https://example.test/pricing' })
  })

  it('ignores relative links that resolve to the app page and other schemes', () => {
    expect(previewLinkAction('page.html', 'file:///Applications/Tinkerbox.app/out/renderer/page.html', PACKAGED)).toEqual({ kind: 'none' })
    expect(previewLinkAction('page.html', `${DEV}/page.html`, DEV)).toEqual({ kind: 'none' })
    expect(previewLinkAction('javascript:alert(1)', 'javascript:alert(1)', DEV)).toEqual({ kind: 'none' })
    expect(previewLinkAction('', '', DEV)).toEqual({ kind: 'none' })
  })
})
