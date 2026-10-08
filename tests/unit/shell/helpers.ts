import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunResult } from '../../../src/shared/types'
import type { Logger, StoreNotice } from '../../../src/main/store/common'
import type { SecretCipher } from '../../../src/main/store/secrets'

/** Temp directories created by a test file; call cleanup() in afterEach. */
export function tempDirs(): { make(): string; cleanup(): void } {
  const dirs: string[] = []
  return {
    make() {
      const dir = mkdtempSync(join(tmpdir(), 'tinkerbox-shell-'))
      dirs.push(dir)
      return dir
    },
    cleanup() {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
    }
  }
}

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

export function noticeCollector(): { notices: StoreNotice[]; sink: (n: StoreNotice) => void } {
  const notices: StoreNotice[] = []
  return { notices, sink: (n) => notices.push(n) }
}

/** Reversible fake cipher (base64 of a reversed string) — enough to prove values are not stored in clear text. */
export function fakeCipher(opts: { available?: boolean; weak?: boolean; failDecrypt?: boolean } = {}): SecretCipher {
  return {
    isAvailable: () => opts.available ?? true,
    isWeak: () => opts.weak ?? false,
    encrypt: (plain) => Buffer.from([...plain].reverse().join(''), 'utf8').toString('base64'),
    decrypt: (cipherText) => {
      if (opts.failDecrypt) throw new Error('keychain changed')
      return [...Buffer.from(cipherText, 'base64').toString('utf8')].reverse().join('')
    }
  }
}

/** A successful RunResult fixture. */
export function runResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    runId: 'r1',
    tabId: 't1',
    connectionId: 'sandbox',
    ok: true,
    totalMs: 123.4,
    stderr: '',
    rawOutput: '',
    exitCode: 0,
    finishedAt: 5000,
    phpVersion: '8.3.12',
    driver: { id: 'laravel', name: 'Laravel', appVersion: 'Laravel 12.20.0' },
    events: [],
    hasReturnValue: false,
    returnValue: null,
    magic: [],
    coverage: [],
    exception: null,
    diagnostics: [],
    bootMs: 50,
    durationMs: 5,
    memoryPeak: 2_000_000,
    ...overrides
  }
}
