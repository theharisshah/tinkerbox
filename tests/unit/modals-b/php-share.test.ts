import { describe, expect, it } from 'vitest'
import type { PhpBinary } from '@shared/types'
import {
  binaryValue,
  effectiveBinary,
  globalBinary,
  guessAutoBinary,
  isHerdAlias,
  matchesBinary,
  minorVersion
} from '@/components/modals/php/phpUtils'
import { codePreview, gistId, hasGithubToken, isShareable, stripOpenTag } from '@/components/modals/share/shareUtils'
import { SECRET_MASK } from '@shared/types'

const HERD: PhpBinary = {
  path: '/Users/me/Library/Application Support/Herd/bin/php83',
  version: '8.3.12',
  versionLine: 'PHP 8.3.12 (cli) (NTS)',
  source: 'Herd',
  alias: 'php83'
}
const BREW: PhpBinary = { path: '/opt/homebrew/bin/php', version: '8.4.1', versionLine: 'PHP 8.4.1 (cli) (NTS)', source: 'Homebrew' }
const SYSTEM: PhpBinary = { path: '/usr/bin/php', version: '8.3.12', versionLine: 'PHP 8.3.12 (cli)', source: 'System' }

describe('php settings helpers', () => {
  it('recognizes Herd aliases', () => {
    expect(isHerdAlias('php83')).toBe(true)
    expect(isHerdAlias(' PHP74 ')).toBe(true)
    expect(isHerdAlias('php')).toBe(false)
    expect(isHerdAlias('/usr/bin/php83')).toBe(false)
  })

  it('prefers aliases when picking a detected binary', () => {
    expect(binaryValue(HERD)).toBe('php83')
    expect(binaryValue(BREW)).toBe('/opt/homebrew/bin/php')
  })

  it('matches configured values against binaries', () => {
    expect(matchesBinary(HERD, 'php83')).toBe(true)
    expect(matchesBinary(HERD, 'PHP83')).toBe(true)
    expect(matchesBinary(HERD, HERD.path)).toBe(true)
    expect(matchesBinary(BREW, 'php83')).toBe(false)
    expect(matchesBinary(BREW, '')).toBe(false)
  })

  it('resolves the effective configuration', () => {
    expect(globalBinary('')).toBe('auto')
    expect(globalBinary(' auto ')).toBe('auto')
    expect(globalBinary('php84')).toBe('php84')
    expect(effectiveBinary('php83', 'auto')).toBe('php83')
    expect(effectiveBinary('', '/usr/bin/php')).toBe('/usr/bin/php')
    expect(effectiveBinary(undefined, undefined)).toBe('auto')
  })

  it('guesses the binary behind auto', () => {
    expect(guessAutoBinary([], '8.3.12')).toBeNull()
    expect(guessAutoBinary([BREW, SYSTEM, HERD], '8.3.12')).toBe(HERD)
    expect(guessAutoBinary([BREW, SYSTEM], '8.3.12')).toBe(SYSTEM)
    expect(guessAutoBinary([BREW, SYSTEM], '')).toBe(BREW)
  })

  it('shortens versions', () => {
    expect(minorVersion('8.3.12')).toBe('PHP 8.3')
    expect(minorVersion('')).toBe('PHP')
  })
})

describe('share helpers', () => {
  it('detects a configured (masked) token', () => {
    expect(hasGithubToken(SECRET_MASK)).toBe(true)
    expect(hasGithubToken('')).toBe(false)
    expect(hasGithubToken('  ')).toBe(false)
    expect(hasGithubToken(undefined)).toBe(false)
  })

  it('knows when there is code to share', () => {
    expect(isShareable('<?php\n\n')).toBe(false)
    expect(isShareable('  ')).toBe(false)
    expect(isShareable('<?php echo 1;')).toBe(true)
    expect(stripOpenTag('<?php\nUser::first();')).toBe('User::first();')
    expect(stripOpenTag('$php = 1;')).toBe('$php = 1;')
  })

  it('previews the first lines', () => {
    const code = Array.from({ length: 20 }, (_, i) => `$a${i} = ${i};`).join('\n') + '\n\n'
    const preview = codePreview(code, 14)
    expect(preview.lines).toHaveLength(14)
    expect(preview.total).toBe(20)
    expect(preview.more).toBe(6)
    expect(codePreview('<?php\n')).toEqual({ lines: [''], more: 0, total: 0 })
  })

  it('extracts gist ids', () => {
    expect(gistId('https://gist.github.com/someone/0f3a9c1b2d')).toBe('0f3a9c1b2d')
    expect(gistId('https://example.com')).toBe('')
  })
})
