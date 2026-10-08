import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { AppInfo, Connection, HerdSite, SandboxStatus } from '@shared/types'
import { api } from '../api'
import { useConnectionsStore } from './connections'
import { useUiStore } from './ui'

const MAX_SANDBOX_LOG = 200

/** Guess the user's home directory from a path inside it (for "~" display). */
export function guessHome(path: string | undefined | null): string | undefined {
  if (!path) return undefined
  const m = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:\\Users\\[^\\]+)/.exec(path)
  return m ? m[1] : undefined
}

/**
 * Application-level data: app info, Laravel Sandbox status/installation and Herd sites.
 */
export const useAppStore = defineStore('app', () => {
  const info = ref<AppInfo | null>(null)
  const sandbox = ref<SandboxStatus | null>(null)
  /** Output lines of the running/last sandbox installation. */
  const sandboxLog = ref<string[]>([])
  const herdSites = ref<HerdSite[]>([])
  const herdLoaded = ref(false)
  let unsubscribe: (() => void) | null = null

  /** Home directory guessed from known paths (app data, sandbox, recent projects) for "~" display. */
  const homeDir = computed<string | undefined>(() => {
    const known = guessHome(info.value?.userDataPath) ?? guessHome(sandbox.value?.path)
    if (known) return known
    const projects: Connection[] = useConnectionsStore().connections
    for (const conn of projects) {
      const home = guessHome(conn.path)
      if (home) return home
    }
    return undefined
  })
  const sandboxInstalled = computed(() => sandbox.value?.installed === true)
  const sandboxInstalling = computed(() => sandbox.value?.installing === true)

  function subscribe(): void {
    if (unsubscribe) return
    unsubscribe = api.on('sandbox:progress', ({ line, status }) => {
      sandbox.value = status
      if (line) {
        const lines = line.split(/\r?\n/).filter((l) => l.trim() !== '')
        sandboxLog.value = [...sandboxLog.value, ...lines].slice(-MAX_SANDBOX_LOG)
      }
    })
  }

  async function loadInfo(): Promise<AppInfo | null> {
    try {
      info.value = await api.invoke('app:info')
    } catch (err) {
      console.error('app:info failed', err)
    }
    return info.value
  }

  async function refreshSandbox(): Promise<SandboxStatus | null> {
    subscribe()
    try {
      sandbox.value = await api.invoke('sandbox:status')
    } catch (err) {
      console.error('sandbox:status failed', err)
    }
    return sandbox.value
  }

  /** Install (or update) the Laravel Sandbox; progress lines land in `sandboxLog`. */
  async function installSandbox(): Promise<SandboxStatus | null> {
    subscribe()
    const ui = useUiStore()
    sandboxLog.value = []
    if (sandbox.value) sandbox.value = { ...sandbox.value, installing: true, error: undefined }
    try {
      const status = await api.invoke('sandbox:install')
      sandbox.value = status
      if (status.installed && !status.error) {
        ui.toast({ level: 'success', message: `Laravel Sandbox is ready${status.laravelVersion ? ` (Laravel ${status.laravelVersion})` : ''}.` })
      } else if (status.error) {
        ui.toast({ level: 'error', title: 'Sandbox installation failed', message: status.error })
      }
    } catch (err) {
      ui.error(err, 'Sandbox installation failed')
      await refreshSandbox()
    }
    return sandbox.value
  }

  async function loadHerdSites(): Promise<HerdSite[]> {
    try {
      herdSites.value = await api.invoke('herd:sites')
    } catch (err) {
      console.warn('herd:sites failed', err)
      herdSites.value = []
    } finally {
      herdLoaded.value = true
    }
    return herdSites.value
  }

  async function load(): Promise<void> {
    await Promise.all([loadInfo(), refreshSandbox()])
  }

  function dispose(): void {
    unsubscribe?.()
    unsubscribe = null
  }

  return {
    info,
    sandbox,
    sandboxLog,
    herdSites,
    herdLoaded,
    homeDir,
    sandboxInstalled,
    sandboxInstalling,
    load,
    loadInfo,
    refreshSandbox,
    installSandbox,
    loadHerdSites,
    dispose
  }
})

export type AppStore = ReturnType<typeof useAppStore>
