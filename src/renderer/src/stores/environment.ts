import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ClassMembers, EnvironmentInfo } from '@shared/types'
import { api } from '../api'

export type EnvironmentStatus = 'idle' | 'loading' | 'ready' | 'error'

/** Cache key of a tab connection (null = the default connection). */
export function envKey(connectionId: string | null | undefined): string {
  return connectionId ?? '@default'
}

/**
 * Introspection cache per connection (autocompletion data from the PHP runner). Concurrent requests for the same
 * connection / class share one IPC call. The main process caches too; `force` bypasses both caches.
 */
export const useEnvironmentStore = defineStore('environment', () => {
  const envs = ref<Record<string, EnvironmentInfo>>({})
  const status = ref<Record<string, EnvironmentStatus>>({})
  const errors = ref<Record<string, string>>({})
  const loadedAt = ref<Record<string, number>>({})
  const memberCache = new Map<string, ClassMembers | null>()
  const inflight = new Map<string, Promise<EnvironmentInfo | null>>()
  const memberInflight = new Map<string, Promise<ClassMembers | null>>()

  function get(connectionId: string | null | undefined): EnvironmentInfo | null {
    return envs.value[envKey(connectionId)] ?? null
  }

  function statusOf(connectionId: string | null | undefined): EnvironmentStatus {
    return status.value[envKey(connectionId)] ?? 'idle'
  }

  function errorOf(connectionId: string | null | undefined): string | null {
    return errors.value[envKey(connectionId)] ?? null
  }

  /** Load (or return the cached) environment of a connection. Resolves null on failure (see errorOf()). */
  function load(connectionId: string | null | undefined, force = false): Promise<EnvironmentInfo | null> {
    const key = envKey(connectionId)
    const pending = inflight.get(key)
    if (pending && !force) return pending
    if (!force && envs.value[key]) return Promise.resolve(envs.value[key])
    status.value = { ...status.value, [key]: 'loading' }
    const request = api
      .invoke('introspect:environment', { connectionId: connectionId ?? null, force })
      .then((env) => {
        envs.value = { ...envs.value, [key]: env }
        loadedAt.value = { ...loadedAt.value, [key]: Date.now() }
        status.value = { ...status.value, [key]: 'ready' }
        const { [key]: _drop, ...rest } = errors.value
        void _drop
        errors.value = rest
        if (force) clearMembers(connectionId)
        return env
      })
      .catch((err: unknown) => {
        status.value = { ...status.value, [key]: 'error' }
        errors.value = { ...errors.value, [key]: api.errorText(err) }
        return null
      })
      .finally(() => {
        if (inflight.get(key) === request) inflight.delete(key)
      })
    inflight.set(key, request)
    return request
  }

  function memberKey(connectionId: string | null | undefined, className: string): string {
    return `${envKey(connectionId)}\u0000${className.replace(/^\\+/, '').toLowerCase()}`
  }

  /** Members of a class (methods, properties, constants, cases) — cached per connection. */
  function members(connectionId: string | null | undefined, className: string, force = false): Promise<ClassMembers | null> {
    const key = memberKey(connectionId, className)
    if (!force && memberCache.has(key)) return Promise.resolve(memberCache.get(key) ?? null)
    const pending = memberInflight.get(key)
    if (pending && !force) return pending
    const request = api
      .invoke('introspect:members', { connectionId: connectionId ?? null, className, force })
      .then((result) => {
        memberCache.set(key, result)
        return result
      })
      .catch((err: unknown) => {
        console.warn(`introspect:members ${className} failed:`, api.errorText(err))
        return null
      })
      .finally(() => {
        if (memberInflight.get(key) === request) memberInflight.delete(key)
      })
    memberInflight.set(key, request)
    return request
  }

  /** Synchronous cache lookup for members (undefined = not loaded yet). */
  function cachedMembers(connectionId: string | null | undefined, className: string): ClassMembers | null | undefined {
    const key = memberKey(connectionId, className)
    return memberCache.has(key) ? (memberCache.get(key) ?? null) : undefined
  }

  function clearMembers(connectionId: string | null | undefined): void {
    const prefix = `${envKey(connectionId)}\u0000`
    for (const key of [...memberCache.keys()]) if (key.startsWith(prefix)) memberCache.delete(key)
  }

  /** Forget cached data (one connection or everything). */
  function invalidate(connectionId?: string | null): void {
    if (connectionId === undefined) {
      envs.value = {}
      status.value = {}
      errors.value = {}
      memberCache.clear()
      return
    }
    const key = envKey(connectionId)
    const strip = <T>(rec: Record<string, T>): Record<string, T> => {
      const { [key]: _drop, ...rest } = rec
      void _drop
      return rest
    }
    envs.value = strip(envs.value)
    status.value = strip(status.value)
    errors.value = strip(errors.value)
    clearMembers(connectionId)
  }

  return { envs, status, errors, loadedAt, get, statusOf, errorOf, load, members, cachedMembers, invalidate }
})

export type EnvironmentStore = ReturnType<typeof useEnvironmentStore>
