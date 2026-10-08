import { existsSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { herdPaths, listHerdSites, phpVersionFromNginx, type HerdPaths } from '../../../src/main/php/herd'
import { cleanupTempDirs, makeTempDir, writeTree } from './helpers'

afterAll(cleanupTempDirs)

function fakeHerd(): { paths: HerdPaths; parked: string; linkedTarget: string } {
  const root = makeTempDir('tw-herd-')
  const valet = join(root, 'config', 'valet')
  const parked = join(root, 'Herd')
  const linkedTarget = join(root, 'elsewhere', 'Linked-App')
  writeTree(root, {
    'Herd/alpha/public/index.php': '<?php',
    'Herd/Beta/artisan': '',
    'Herd/.hidden/x': '',
    'Herd/file.txt': 'not a site',
    'elsewhere/Linked-App/composer.json': '{}',
    'config/valet/Nginx/beta.test': 'listen 127.0.0.1:443 ssl;\nfastcgi_pass $herd_sock_84;',
    'config/valet/Certificates/alpha.test.crt': 'cert',
    'config/valet/Sites/.keep': ''
  })
  writeTree(valet, { 'config.json': JSON.stringify({ tld: 'test', paths: [join(valet, 'Sites'), parked, join(root, 'missing')] }) })
  symlinkSync(linkedTarget, join(valet, 'Sites', 'linked'))
  // A linked site with the same name as a parked folder wins.
  symlinkSync(linkedTarget, join(valet, 'Sites', 'alpha'))
  return { paths: { root, bin: join(root, 'bin'), configPhp: join(root, 'config', 'php'), valet, appResources: null }, parked, linkedTarget }
}

describe('Herd sites', () => {
  it('parses PHP versions of isolated sites', () => {
    expect(phpVersionFromNginx('fastcgi_pass $herd_sock_83;')).toBe('8.3')
    expect(phpVersionFromNginx('unix:/x/herd74.sock')).toBe('7.4')
    expect(phpVersionFromNginx('fastcgi_pass $herd_sock;')).toBeUndefined()
  })

  it('lists parked and linked sites with URLs and PHP versions', async () => {
    const { paths, parked, linkedTarget } = fakeHerd()
    const sites = await listHerdSites(paths)
    const real = (p: string): string => p.replace(/^\/private/, '')
    expect(sites.map((s) => s.name)).toEqual(['alpha', 'Beta', 'linked'])
    const alpha = sites.find((s) => s.name === 'alpha')!
    expect(real(alpha.path)).toBe(real(linkedTarget))
    expect(alpha.url).toBe('https://alpha.test')
    const beta = sites.find((s) => s.name === 'Beta')!
    expect(beta).toMatchObject({ path: join(parked, 'Beta'), url: 'https://beta.test', phpVersion: '8.4' })
    expect(sites.find((s) => s.name === 'linked')!.url).toBe('http://linked.test')
  })

  it('returns nothing without Herd or with a corrupted config', async () => {
    expect(await listHerdSites(null)).toEqual([])
    const { paths } = fakeHerd()
    writeTree(paths.valet, { 'config.json': '{broken' })
    expect(await listHerdSites(paths)).toEqual([])
  })

  const realHerd = herdPaths()
  it.skipIf(!realHerd || !existsSync(join(realHerd.valet, 'config.json')))('lists the Herd sites on this machine', async () => {
    const sites = await listHerdSites()
    expect(sites.length).toBeGreaterThan(0)
    for (const site of sites) {
      expect(site.url).toMatch(/^https?:\/\/[a-z0-9._-]+\.[a-z]+$/)
      expect(existsSync(site.path)).toBe(true)
    }
    // Site names map to their folder names.
    for (const site of sites) expect(site.url).toContain(site.name.toLowerCase())
  })
})
