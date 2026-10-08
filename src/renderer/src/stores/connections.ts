import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { SANDBOX_CONNECTION_ID, SCRATCH_CONNECTION_ID, type Connection, type ConnectionTestResult } from '@shared/types'
import { api } from '../api'
import { cloneJson } from '../utils/merge'
import { basename } from '../utils/platform'
import { useAppStore } from './app'
import { useSettingsStore } from './settings'
import { useUiStore } from './ui'

/** Stable color for a project without an explicit color (tab badge). */
const BADGE_COLORS = ['#7c3aed', '#db2777', '#ea580c', '#16a34a', '#0891b2', '#2563eb', '#ca8a04', '#9333ea', '#dc2626', '#0d9488']

export function colorForName(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return BADGE_COLORS[h % BADGE_COLORS.length]
}

export function isImplicitConnection(id: string | null | undefined): boolean {
  return id === null || id === undefined || id === SANDBOX_CONNECTION_ID || id === SCRATCH_CONNECTION_ID
}

/**
 * Local project connections (= recent folders) plus the implicit "Default" (Laravel Sandbox) and "PHP" (plain
 * PHP) connections. A tab's `connectionId` null means "default": Default Working Directory → Sandbox → PHP.
 */
export const useConnectionsStore = defineStore('connections', () => {
  const connections = ref<Connection[]>([])
  const loaded = ref(false)
  let unsubscribe: (() => void) | null = null
  /** Last 'file:isDirectory' answer for the configured Default Working Directory. */
  const defaultDirCheck = ref<{ dir: string; exists: boolean } | null>(null)

  function configuredDefaultDirectory(): string {
    return useSettingsStore().settings.defaultWorkingDirectory.trim()
  }

  /**
   * The configured Default Working Directory is not an existing folder. The main process then ignores it (new tabs run
   * in the sandbox or plain PHP), so the UI must not present it as the project either.
   */
  const defaultDirectoryMissing = computed(() => {
    const dir = configuredDefaultDirectory()
    const check = defaultDirCheck.value
    return dir !== '' && check !== null && check.dir === dir && !check.exists
  })

  /** Default Working Directory that `null` tabs actually use ('' when unset or missing), like the main process. */
  const defaultDirectory = computed(() => (defaultDirectoryMissing.value ? '' : configuredDefaultDirectory()))

  /** Ask the main process whether the Default Working Directory exists. Resolves true when unset or unknown. */
  async function checkDefaultDirectory(): Promise<boolean> {
    const dir = configuredDefaultDirectory()
    if (dir === '') {
      defaultDirCheck.value = null
      return true
    }
    try {
      const exists = await api.invoke('file:isDirectory', dir)
      if (configuredDefaultDirectory() === dir) defaultDirCheck.value = { dir, exists }
      return exists
    } catch {
      // Unknown: keep the previous answer instead of flagging a folder that may be fine.
      return true
    }
  }

  watch(configuredDefaultDirectory, () => void checkDefaultDirectory())

  /** Recent project folders, most recent first (plain PHP / sandbox entries excluded). */
  const recent = computed(() =>
    connections.value
      .filter((c) => c.path !== '' && !isImplicitConnection(c.id) && !!c.lastUsedAt)
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
  )

  function byId(id: string | null | undefined): Connection | undefined {
    if (!id) return undefined
    return connections.value.find((c) => c.id === id)
  }

  function findByPath(path: string): Connection | undefined {
    const wanted = path.replace(/[\\/]+$/, '')
    return connections.value.find((c) => c.path !== '' && c.path.replace(/[\\/]+$/, '') === wanted)
  }

  /** Label of what a `null` connection resolves to: the Default Working Directory, "Default" or "PHP". */
  const defaultConnectionLabel = computed(() => {
    const dir = defaultDirectory.value
    if (dir) return findByPath(dir)?.name || basename(dir) || dir
    const sandbox = useAppStore().sandbox
    return sandbox && !sandbox.installed ? 'PHP' : 'Default'
  })

  /** Display label for a connection id ('Default' for the sandbox, 'PHP' for plain PHP). */
  function label(id: string | null | undefined): string {
    if (id === null || id === undefined) return defaultConnectionLabel.value
    if (id === SANDBOX_CONNECTION_ID) {
      const sandbox = useAppStore().sandbox
      return sandbox && !sandbox.installed ? 'PHP' : 'Default'
    }
    if (id === SCRATCH_CONNECTION_ID) return 'PHP'
    return byId(id)?.name ?? 'Unknown project'
  }

  /**
   * Concrete connection id behind a tab's connection (null resolves like the main process). Returns null when the
   * default is a Default Working Directory that has no stored connection yet.
   */
  function effectiveId(id: string | null | undefined): string | null {
    if (id) return id
    const dir = defaultDirectory.value
    if (dir) return findByPath(dir)?.id ?? null
    const sandbox = useAppStore().sandbox
    return sandbox && !sandbox.installed ? SCRATCH_CONNECTION_ID : SANDBOX_CONNECTION_ID
  }

  /** Project directory ('' for plain PHP / unknown). */
  function path(id: string | null | undefined): string {
    if (id === null || id === undefined) {
      const dir = defaultDirectory.value
      if (dir) return dir
      const sandbox = useAppStore().sandbox
      return sandbox?.installed ? sandbox.path : ''
    }
    if (id === SANDBOX_CONNECTION_ID) {
      const sandbox = useAppStore().sandbox
      return sandbox?.installed ? sandbox.path : ''
    }
    if (id === SCRATCH_CONNECTION_ID) return ''
    return byId(id)?.path ?? ''
  }

  /** Badge color: explicit connection color, else a stable color per project (undefined for the defaults). */
  function color(id: string | null | undefined): string | undefined {
    const conn = byId(effectiveId(id))
    if (conn?.color) return conn.color
    if (isImplicitConnection(id)) return undefined
    return conn ? colorForName(conn.name) : undefined
  }

  /** Stored connection or a synthesized implicit one (sandbox / scratch) for editing per-project options. */
  function resolve(id: string | null | undefined): Connection | null {
    const concrete = effectiveId(id)
    if (!concrete) return null
    const stored = byId(concrete)
    if (stored) return stored
    if (concrete === SANDBOX_CONNECTION_ID || concrete === SCRATCH_CONNECTION_ID) {
      return { id: concrete, name: label(concrete), type: 'local', path: '', createdAt: 0 }
    }
    return null
  }

  function isDebugging(id: string | null | undefined): boolean {
    return resolve(id)?.debug === true
  }

  function setList(list: Connection[]): void {
    connections.value = list
  }

  function subscribe(): void {
    if (unsubscribe) return
    const off = api.on('connections:changed', ({ connections: list }) => setList(list))
    // The folder may be created, deleted or remounted while the app is in the background.
    const onFocus = (): void => void checkDefaultDirectory()
    if (typeof window !== 'undefined') window.addEventListener('focus', onFocus)
    unsubscribe = () => {
      off()
      if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus)
    }
  }

  async function load(): Promise<Connection[]> {
    subscribe()
    void checkDefaultDirectory()
    try {
      setList(await api.invoke('connections:list'))
    } catch (err) {
      useUiStore().error(err, 'Could not load recent projects')
    } finally {
      loaded.value = true
    }
    return connections.value
  }

  function upsert(conn: Connection): void {
    const exists = connections.value.some((c) => c.id === conn.id)
    connections.value = exists ? connections.value.map((c) => (c.id === conn.id ? conn : c)) : [conn, ...connections.value]
  }

  /** Open (or reuse) the project connection for a directory. */
  async function openLocal(dir: string): Promise<Connection> {
    const conn = await api.invoke('connections:openLocal', dir)
    upsert(conn)
    return conn
  }

  /** Folder picker → openLocal. Resolves null when cancelled or failed (errors are toasted). */
  async function pickDirectory(title = 'Open Local Project'): Promise<Connection | null> {
    try {
      const dir = await api.invoke('dialog:openDirectory', title)
      if (!dir) return null
      return await openLocal(dir)
    } catch (err) {
      useUiStore().error(err, 'Could not open the folder')
      return null
    }
  }

  async function save(conn: Connection): Promise<Connection> {
    const saved = await api.invoke('connections:save', cloneJson(conn))
    upsert(saved)
    return saved
  }

  async function remove(id: string): Promise<void> {
    await api.invoke('connections:delete', id)
    connections.value = connections.value.filter((c) => c.id !== id)
  }

  function test(conn: Connection): Promise<ConnectionTestResult> {
    return api.invoke('connections:test', cloneJson(conn))
  }

  function touch(id: string): void {
    if (isImplicitConnection(id)) return
    void api.invoke('connections:touch', id).catch(() => undefined)
  }

  async function clearRecents(): Promise<void> {
    try {
      await api.invoke('connections:clearRecents')
      await load()
    } catch (err) {
      useUiStore().error(err, 'Could not clear recent folders')
    }
  }

  /** Toggle Xdebug step debugging for the project behind a tab's connection. Resolves with the new state. */
  async function toggleDebug(id: string | null | undefined): Promise<boolean> {
    let conn = resolve(id)
    if (!conn && !id) {
      const dir = defaultDirectory.value
      if (dir) conn = await openLocal(dir)
    }
    if (!conn) throw new Error('This tab has no project to debug.')
    const saved = await save({ ...conn, debug: !conn.debug })
    return saved.debug === true
  }

  function dispose(): void {
    unsubscribe?.()
    unsubscribe = null
  }

  return {
    connections,
    loaded,
    recent,
    defaultConnectionLabel,
    defaultDirectory,
    defaultDirectoryMissing,
    checkDefaultDirectory,
    byId,
    findByPath,
    label,
    effectiveId,
    path,
    color,
    resolve,
    isDebugging,
    load,
    openLocal,
    pickDirectory,
    save,
    remove,
    delete: remove,
    test,
    touch,
    clearRecents,
    toggleDebug,
    dispose
  }
})

export type ConnectionsStore = ReturnType<typeof useConnectionsStore>
