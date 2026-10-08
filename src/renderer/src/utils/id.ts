/** Random identifiers for tabs, runs, snippets and toasts. */
export function uid(prefix = ''): string {
  let random: string
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    random = crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  } else {
    random = Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
  }
  return prefix ? `${prefix}_${random}` : random
}
