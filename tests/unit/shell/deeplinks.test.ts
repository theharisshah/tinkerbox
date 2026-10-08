import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildOpenUrl, decodeBase64Param, extractOpenTargets, needsOpenConfirmation, parseDeepLink } from '../../../src/main/deeplinks'

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')

describe('parseDeepLink', () => {
  it('parses tinkerbox://open?cwd=<base64>', () => {
    expect(parseDeepLink(`tinkerbox://open?cwd=${b64('/Users/me/Sites/app')}`)).toEqual({ path: '/Users/me/Sites/app' })
  })

  it('accepts URL-safe base64 without padding, percent-encoding and "+" turned into a space', () => {
    const path = '/Users/me/Projects/Ünïcode app/~?>' // produces + and / in standard base64
    const standard = b64(path)
    expect(standard).toMatch(/[+/=]/)
    expect(parseDeepLink(buildOpenUrl(path))).toEqual({ path })
    expect(parseDeepLink(`tinkerbox://open?cwd=${encodeURIComponent(standard)}`)).toEqual({ path })
    expect(parseDeepLink(`tinkerbox://open?cwd=${standard}`)).toEqual({ path })
  })

  it('accepts tinkerbox:open and tinkerbox:///open forms and Windows paths', () => {
    expect(parseDeepLink(`tinkerbox:open?cwd=${b64('/srv/app')}`)).toEqual({ path: '/srv/app' })
    expect(parseDeepLink(`tinkerbox:///open?cwd=${b64('/srv/app')}`)).toEqual({ path: '/srv/app' })
    expect(parseDeepLink(`TINKERBOX://OPEN?cwd=${b64('C:\\Users\\me\\app')}`)).toEqual({ path: 'C:\\Users\\me\\app' })
  })

  it('rejects other schemes, actions, relative paths and garbage', () => {
    expect(parseDeepLink(`otherapp://open?cwd=${b64('/srv/app')}`)).toBeNull()
    expect(parseDeepLink(`tinkerbox://run?cwd=${b64('/srv/app')}`)).toBeNull()
    expect(parseDeepLink(`tinkerbox://open?cwd=${b64('relative/path')}`)).toBeNull()
    expect(parseDeepLink('tinkerbox://open?cwd=%%%')).toBeNull()
    expect(parseDeepLink('tinkerbox://open')).toBeNull()
    expect(parseDeepLink('not a url')).toBeNull()
    expect(parseDeepLink(`tinkerbox://open?cwd=${b64('/a\0b')}`)).toBeNull()
  })

  it('rejects network (UNC) and device paths, which make Windows connect to a remote host', () => {
    expect(parseDeepLink(`tinkerbox://open?cwd=${b64('\\\\attacker.example\\share\\proj')}`)).toBeNull()
    expect(parseDeepLink(`tinkerbox://open?cwd=${b64('//attacker.example/share/proj')}`)).toBeNull()
    expect(parseDeepLink(`tinkerbox://open?cwd=${b64('\\/attacker.example/share')}`)).toBeNull()
    expect(parseDeepLink(`tinkerbox://open?cwd=${b64('\\\\?\\C:\\proj')}`)).toBeNull()
    expect(parseDeepLink(buildOpenUrl('\\\\server\\share'))).toBeNull()
  })

  it('returns the CLI token when present and well-formed', () => {
    const token = 'a'.repeat(64)
    expect(parseDeepLink(`${buildOpenUrl('/srv/app')}&token=${token}`)).toEqual({ path: '/srv/app', token })
    // Malformed tokens are dropped (the link is then treated like any other external link).
    const dropped = parseDeepLink(`${buildOpenUrl('/srv/app')}&token=${encodeURIComponent('<script>')}`)
    expect(dropped).toEqual({ path: '/srv/app' })
    expect(dropped).not.toHaveProperty('token')
    expect(parseDeepLink(`${buildOpenUrl('/srv/app')}&token=short`)).not.toHaveProperty('token')
  })

  it('rejects base64 that does not decode to UTF-8', () => {
    expect(decodeBase64Param(Buffer.from([0xff, 0xfe, 0xfd]).toString('base64'))).toBeNull()
    expect(decodeBase64Param('A')).toBeNull()
  })
})

describe('extractOpenTargets', () => {
  it('skips the executable (and the app path when unpackaged) and switches', () => {
    expect(extractOpenTargets(['/Applications/Tinkerbox.app/Contents/MacOS/Tinkerbox', '-psn_0_123', '/srv/app'], { defaultApp: false, cwd: '/' })).toEqual([
      { path: '/srv/app', source: 'argv' }
    ])
    expect(extractOpenTargets(['/x/electron', '/repo', '--inspect=9229', 'proj'], { defaultApp: true, cwd: '/home/me' })).toEqual([
      { path: '/home/me/proj', source: 'argv' }
    ])
    // 'second-instance' argv: Chromium puts the switches before the app path.
    expect(
      extractOpenTargets(['/x/electron', '--user-data-dir=/tmp/p', '--allow-file-access-from-files', '/repo', buildOpenUrl('/srv/linked')], {
        defaultApp: true,
        cwd: '/'
      })
    ).toEqual([{ path: '/srv/linked', source: 'url' }])
  })

  it('resolves relative paths against the invoking working directory and decodes deep links', () => {
    const targets = extractOpenTargets(['tinkerbox', '.', '../other', buildOpenUrl('/srv/linked'), 'https://example.com'], {
      defaultApp: false,
      cwd: '/home/me/app'
    })
    expect(targets).toEqual([
      { path: '/home/me/app', source: 'argv' },
      { path: '/home/me/other', source: 'argv' },
      { path: '/srv/linked', source: 'url' }
    ])
  })

  it('keeps the token of a deep link', () => {
    const token = 'b'.repeat(64)
    expect(extractOpenTargets(['tinkerbox', `${buildOpenUrl('/srv/linked')}&token=${token}`], { defaultApp: false, cwd: '/' })).toEqual([
      { path: '/srv/linked', source: 'url', token }
    ])
  })
})

describe('needsOpenConfirmation', () => {
  const token = 'c'.repeat(64)

  it('never asks for paths the local user handed over (command line, Finder, Open Recent)', () => {
    expect(needsOpenConfirmation({ path: '/srv/app', source: 'argv' }, null)).toBe(false)
    expect(needsOpenConfirmation({ path: '/srv/app', source: 'argv' }, token)).toBe(false)
  })

  it('asks for every deep link that does not carry the installed CLI helper token', () => {
    expect(needsOpenConfirmation({ path: '/srv/app', source: 'url' }, null)).toBe(true)
    expect(needsOpenConfirmation({ path: '/srv/app', source: 'url' }, token)).toBe(true)
    expect(needsOpenConfirmation({ path: '/srv/app', source: 'url', token }, null)).toBe(true)
    expect(needsOpenConfirmation({ path: '/srv/app', source: 'url', token: 'd'.repeat(64) }, token)).toBe(true)
    expect(needsOpenConfirmation({ path: '/srv/app', source: 'url', token: token.slice(1) }, token)).toBe(true)
  })

  it('trusts a deep link with the CLI helper token', () => {
    expect(needsOpenConfirmation({ path: '/srv/app', source: 'url', token }, token)).toBe(false)
  })
})

describe('packaging', () => {
  it('declares the tinkerbox:// scheme for packaged builds (macOS Info.plist, Linux .desktop handler)', () => {
    const config = readFileSync(join(__dirname, '../../../electron-builder.yml'), 'utf8')
    expect(config).toMatch(/^protocols:\s+- name: Tinkerbox\s+schemes:\s+- tinkerbox$/m)
  })
})
