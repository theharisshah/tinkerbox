import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { setBridge } from '@/api'
import { useConnectionsStore } from '@/stores/connections'
import { useSettingsStore } from '@/stores/settings'
import { fakeBridge, type FakeBridge } from './helpers'

const EXISTING = '/Users/dev/projects/shop'

let fake: FakeBridge

beforeEach(async () => {
  fake = fakeBridge({ 'file:isDirectory': (path) => path === EXISTING, 'connections:list': () => [] })
  setBridge(fake.bridge)
  setActivePinia(createPinia())
  await useSettingsStore().load()
})

afterEach(() => {
  useConnectionsStore().dispose()
  setBridge(null)
})

describe('Default Working Directory', () => {
  it('is the project of tabs without one when the folder exists', async () => {
    const connections = useConnectionsStore()
    await useSettingsStore().set('defaultWorkingDirectory', EXISTING)
    expect(await connections.checkDefaultDirectory()).toBe(true)
    expect(connections.defaultDirectoryMissing).toBe(false)
    expect(connections.label(null)).toBe('shop')
    expect(connections.path(null)).toBe(EXISTING)
  })

  it('is ignored like the main process does when the folder does not exist', async () => {
    const connections = useConnectionsStore()
    await connections.load()
    await useSettingsStore().set('defaultWorkingDirectory', '/nonexistent/dir/abc')
    await nextTick()
    // The store re-checks whenever the setting changes.
    expect(fake.callsTo('file:isDirectory').map(([path]) => path)).toContain('/nonexistent/dir/abc')
    await connections.checkDefaultDirectory()
    expect(connections.defaultDirectoryMissing).toBe(true)
    expect(connections.defaultDirectory).toBe('')
    // Tabs without a project are labelled the way they run: the sandbox / plain PHP, not "abc".
    expect(connections.label(null)).not.toBe('abc')
    expect(connections.path(null)).toBe('')
    expect(connections.effectiveId(null)).toMatch(/^(sandbox|scratch)$/)
  })

  it('forgets a missing folder once the setting is cleared or fixed', async () => {
    const connections = useConnectionsStore()
    const settings = useSettingsStore()
    await settings.set('defaultWorkingDirectory', '/gone')
    await connections.checkDefaultDirectory()
    expect(connections.defaultDirectoryMissing).toBe(true)
    await settings.set('defaultWorkingDirectory', EXISTING)
    // A new value is not "missing" before it was checked.
    expect(connections.defaultDirectoryMissing).toBe(false)
    await connections.checkDefaultDirectory()
    expect(connections.label(null)).toBe('shop')
    await settings.set('defaultWorkingDirectory', '')
    expect(await connections.checkDefaultDirectory()).toBe(true)
    expect(connections.defaultDirectoryMissing).toBe(false)
  })
})
