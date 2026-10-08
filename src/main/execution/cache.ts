/**
 * TTL cache of promises: concurrent requests for the same key share one in-flight computation and
 * failures are never cached.
 */
export class PromiseCache<V> {
  private readonly entries = new Map<string, { at: number; promise: Promise<V> }>()

  constructor(private readonly ttlMs: number) {}

  get(key: string, factory: () => Promise<V>, force = false): Promise<V> {
    const hit = this.entries.get(key)
    if (!force && hit && Date.now() - hit.at < this.ttlMs) return hit.promise
    const promise = factory()
    const entry = { at: Date.now(), promise }
    this.entries.set(key, entry)
    promise.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key)
    })
    return promise
  }

  deleteWhere(predicate: (key: string) => boolean): void {
    for (const key of [...this.entries.keys()]) if (predicate(key)) this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}
