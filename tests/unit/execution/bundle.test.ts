import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  buildBundle,
  buildInvocation,
  concatenateSources,
  encodeCode,
  isPackagedApp,
  loadRunnerScript,
  newNonce,
  readRunnerScript,
  resolvePhpResourceDir,
  stripPhpTags
} from '../../../src/main/execution/bundle'
import type { PhpPayload } from '../../../src/main/execution/types'
import { cleanupTempDirs, hasHerdPhp, herdPhp83, makeTempDir, repoRoot, runOptions, writeTree } from './helpers'

afterAll(cleanupTempDirs)

function payload(overrides: Partial<PhpPayload> = {}): PhpPayload {
  return {
    nonce: 'tw_test',
    mode: 'run',
    projectPath: '',
    driver: '',
    code: encodeCode('return 1;'),
    lineOffset: 1,
    className: '',
    logFile: '',
    logLimit: 500,
    homePath: '/home/me',
    options: runOptions(),
    ...overrides
  }
}

/** A tiny runner honoring the protocol, used to test concatenation independently of P1–P4. */
function fakeRunnerDir(extra: Record<string, string> = {}): string {
  const dir = makeTempDir('tw-runner-')
  writeTree(dir, {
    'manifest.json': JSON.stringify({ files: ['src/A.php', 'src/Runner.php'] }),
    'src/A.php': "<?php\n\nnamespace Tinkerbox {\n    final class A { public static function hi() { return 'hi'; } }\n}\n",
    'src/Runner.php':
      "\uFEFF<?php\nnamespace Tinkerbox {\n    final class Runner {\n        public static function main(array $p) {\n" +
      "            echo \"\\n\" . $p['nonce'] . \"BEGIN\\n\" . json_encode(['payload' => $p, 'a' => A::hi(), 'code' => base64_decode($p['code'])]) . \"\\n\" . $p['nonce'] . \"END\\n\";\n" +
      '        }\n    }\n}\n?>\n',
    ...extra
  })
  return dir
}

describe('source handling', () => {
  it('strips BOM, open tag and closing tag', () => {
    expect(stripPhpTags('\uFEFF<?php\nnamespace A {}\n?>\n')).toBe('namespace A {}\n')
    expect(stripPhpTags('<?PHP namespace A {}')).toBe('namespace A {}')
  })

  it('concatenates in order with one leading open tag and file markers', () => {
    const script = concatenateSources([
      { name: 'a.php', content: '<?php\nnamespace A {}\n' },
      { name: 'b.php', content: '<?php\nnamespace B {}\n' }
    ])
    expect(script.startsWith('<?php\n')).toBe(true)
    expect(script.match(/<\?php/g)).toHaveLength(1)
    expect(script.indexOf('namespace A')).toBeLessThan(script.indexOf('namespace B'))
    expect(script).toContain('// ---- b.php ----')
  })

  it('reads sources in manifest order and reports missing files', () => {
    const dir = fakeRunnerDir()
    const script = readRunnerScript(dir)
    expect(script.indexOf('class A')).toBeLessThan(script.indexOf('class Runner'))
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ files: ['src/Missing.php'] }))
    expect(() => readRunnerScript(dir)).toThrow(/Runner source missing: .*Missing\.php/)
  })

  it('rejects an invalid manifest', () => {
    const dir = makeTempDir()
    writeTree(dir, { 'manifest.json': '{"files": "nope"}' })
    expect(() => readRunnerScript(dir)).toThrow(/Invalid runner manifest/)
  })
})

describe('resource directory', () => {
  it('accepts the repo root (dev) and the resources dir (packaged) layouts', () => {
    expect(resolvePhpResourceDir(repoRoot)).toBe(join(repoRoot, 'resources', 'php'))
    expect(resolvePhpResourceDir(join(repoRoot, 'resources'))).toBe(join(repoRoot, 'resources', 'php'))
  })

  it('is not packaged under vitest', () => {
    expect(isPackagedApp()).toBe(false)
  })

  it('re-reads sources on every call in development and caches on request', () => {
    // Packaged layout: <resources>/php/manifest.json
    const resources = makeTempDir()
    const php = join(resources, 'php')
    writeTree(php, { 'manifest.json': JSON.stringify({ files: ['x.php'] }), 'x.php': '<?php\nnamespace X { const V = 1; }\n' })
    expect(loadRunnerScript(resources)).toContain('const V = 1')
    writeFileSync(join(php, 'x.php'), '<?php\nnamespace X { const V = 2; }\n')
    expect(loadRunnerScript(resources)).toContain('const V = 2')
    expect(loadRunnerScript(resources, { cache: true })).toContain('const V = 2')
    writeFileSync(join(php, 'x.php'), '<?php\nnamespace X { const V = 3; }\n')
    expect(loadRunnerScript(resources, { cache: true })).toContain('const V = 2')
  })
})

describe('payload invocation', () => {
  it('embeds the payload as base64 JSON in a global namespace block', () => {
    const p = payload({ projectPath: '/Users/me/app', code: encodeCode("echo 'héllo';") })
    const inv = buildInvocation(p)
    expect(inv.startsWith('namespace {')).toBe(true)
    const b64 = /base64_decode\('([A-Za-z0-9+/=]+)'\)/.exec(inv)?.[1]
    expect(b64).toBeTruthy()
    expect(JSON.parse(Buffer.from(b64!, 'base64').toString('utf8'))).toEqual(p)
  })

  it('creates unique, hex nonces', () => {
    const a = newNonce()
    expect(a).toMatch(/^tw_[0-9a-f]{24}$/)
    expect(newNonce()).not.toBe(a)
  })
})

describe.skipIf(!hasHerdPhp)('bundle accepted by PHP', () => {
  it('runs a fake runner bundle end to end through stdin', () => {
    const dir = fakeRunnerDir()
    const p = payload({ nonce: 'tw_e2e', code: encodeCode('ünïcode') })
    const bundle = buildBundle(readRunnerScript(dir), p)
    const res = spawnSync(herdPhp83, ['-d', 'xdebug.mode=off'], { input: bundle, encoding: 'utf8' })
    expect(res.stderr).toBe('')
    const json = res.stdout.split('tw_e2eBEGIN\n')[1].split('\ntw_e2eEND')[0]
    const decoded = JSON.parse(json)
    expect(decoded.a).toBe('hi')
    expect(decoded.code).toBe('ünïcode')
    expect(decoded.payload.homePath).toBe('/home/me')
  })

  it('produces a script that `php -l` accepts for the real runner sources', () => {
    const file = join(makeTempDir(), 'bundle.php')
    writeFileSync(file, buildBundle(loadRunnerScript(repoRoot), payload()))
    const res = spawnSync(herdPhp83, ['-d', 'xdebug.mode=off', '-l', file], { encoding: 'utf8' })
    expect(res.stdout + res.stderr).toContain('No syntax errors detected')
  })
})
