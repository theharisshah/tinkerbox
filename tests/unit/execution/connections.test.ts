import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SANDBOX_CONNECTION_ID, SCRATCH_CONNECTION_ID } from '@shared/types'
import { resolveImplicitConnection, resolveTargetConnection } from '../../../src/main/execution/connections'
import type { ExecutionContext } from '../../../src/main/execution/types'
import { cleanupTempDirs, fakeContext, localConnection, makeTempDir, writeTree } from './helpers'

afterAll(cleanupTempDirs)

function withBundledSandbox(): { resourcesPath: string; sandbox: string } {
  const resourcesPath = makeTempDir('tw-res-')
  const sandbox = join(resourcesPath, 'sandbox')
  writeTree(sandbox, { artisan: '', 'vendor/autoload.php': '<?php' })
  return { resourcesPath, sandbox }
}

describe('implicit connections', () => {
  it('resolves scratch and sandbox', () => {
    const ctx = fakeContext()
    expect(resolveImplicitConnection(ctx, SCRATCH_CONNECTION_ID)).toMatchObject({ id: 'scratch', path: '', type: 'local' })
    expect(resolveImplicitConnection(ctx, SANDBOX_CONNECTION_ID)).toMatchObject({ id: 'sandbox', name: 'Default', path: join(ctx.userDataPath, 'sandbox') })
    expect(resolveImplicitConnection(ctx, 'other')).toBeNull()
  })

  it('resolves null via Default Working Directory, then sandbox, then scratch', () => {
    const dir = makeTempDir('tw-dwd-')
    expect(resolveImplicitConnection(fakeContext({ settings: { defaultWorkingDirectory: dir } }), null)).toMatchObject({ path: dir, id: `local:${dir}` })
    const { resourcesPath, sandbox } = withBundledSandbox()
    expect(resolveImplicitConnection(fakeContext({ resourcesPath, settings: { defaultWorkingDirectory: '/missing/dir' } }), null)).toMatchObject({ id: 'sandbox', path: sandbox })
    expect(resolveImplicitConnection(fakeContext(), null)).toMatchObject({ id: 'scratch', path: '' })
  })
})

describe('resolveTargetConnection', () => {
  it('points the sandbox connection at the available sandbox', async () => {
    const { resourcesPath, sandbox } = withBundledSandbox()
    const conn = await resolveTargetConnection(fakeContext({ resourcesPath }), SANDBOX_CONNECTION_ID)
    expect(conn).toMatchObject({ id: 'sandbox', path: sandbox })
  })

  it('runs the sandbox tab as plain PHP until the sandbox is installed, keeping its settings', async () => {
    const base = fakeContext()
    const ctx: ExecutionContext = { ...base, resolveConnection: () => localConnection(SANDBOX_CONNECTION_ID, '', { phpBinary: 'php82', debug: true }) }
    expect(await resolveTargetConnection(ctx, SANDBOX_CONNECTION_ID)).toMatchObject({ id: 'sandbox', path: '', phpBinary: 'php82', debug: true })
  })

  it('falls back to implicit resolution when the shell cannot resolve implicit ids', async () => {
    const base = fakeContext()
    const ctx: ExecutionContext = {
      ...base,
      resolveConnection: () => {
        throw new Error('not ready')
      }
    }
    expect(await resolveTargetConnection(ctx, SCRATCH_CONNECTION_ID)).toMatchObject({ id: 'scratch' })
    expect(await resolveTargetConnection(ctx, null)).toMatchObject({ id: 'scratch' })
    await expect(resolveTargetConnection(ctx, 'saved-id')).rejects.toThrow('not ready')
  })

  it('returns saved connections unchanged', async () => {
    const dir = makeTempDir()
    const ctx = fakeContext({ connections: { p: localConnection('p', dir, { phpBinary: 'php84' }) } })
    expect(await resolveTargetConnection(ctx, 'p')).toMatchObject({ id: 'p', path: dir, phpBinary: 'php84' })
  })
})
