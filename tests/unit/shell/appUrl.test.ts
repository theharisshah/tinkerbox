import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

// windows.ts imports Electron's main-process API; isAppUrl itself only needs URL parsing.
vi.mock('electron', () => ({ BrowserWindow: class {}, Menu: {}, screen: {}, session: {}, shell: {} }))

const { isAppUrl } = await import('../../../src/main/windows')

describe('isAppUrl', () => {
  const rendererFile = join(process.platform === 'win32' ? 'C:\\app' : '/app', 'out', 'renderer', 'index.html')
  const built = { devUrl: null, rendererFile }
  const appHref = pathToFileURL(rendererFile).href

  it('accepts the built renderer file and the dev server origin', () => {
    expect(isAppUrl(appHref, built)).toBe(true)
    expect(isAppUrl(`${appHref}#/settings`, built)).toBe(true)
    expect(isAppUrl('http://localhost:5173/some/route', { devUrl: 'http://localhost:5173', rendererFile })).toBe(true)
  })

  it('rejects other files, origins and schemes', () => {
    expect(isAppUrl(pathToFileURL(join(rendererFile, '..', 'other.html')).href, built)).toBe(false)
    expect(isAppUrl('https://example.com/', built)).toBe(false)
    expect(isAppUrl('http://localhost:5174/', { devUrl: 'http://localhost:5173', rendererFile })).toBe(false)
    expect(isAppUrl('not a url', built)).toBe(false)
  })

  it('returns false (instead of throwing) for malformed percent-escapes, so the navigation guard blocks them', () => {
    expect(() => isAppUrl('file:///tmp/x%', built)).not.toThrow()
    expect(isAppUrl('file:///tmp/x%', built)).toBe(false)
    expect(isAppUrl('file:///tmp/%E0%A4%A', built)).toBe(false)
    expect(isAppUrl(`${appHref}%`, built)).toBe(false)
    expect(isAppUrl('http://localhost:5173/', { devUrl: '%%%', rendererFile })).toBe(false)
  })
})
