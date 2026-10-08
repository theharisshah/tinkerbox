import { DEFAULT_SETTINGS } from '../../shared/defaults'
import { COMMANDS } from '../../shared/ipc'
import type { Settings } from '../../shared/types'
import { cloneJson, deepFreeze, isPlainObject, type Logger, type NoticeSink } from './common'
import { JsonStore } from './jsonStore'
import { mergeTyped, type MergeRules } from './merge'
import { maskSecret, type SecretBox } from './secrets'

/** Settings paths holding secrets (encrypted at rest, masked for the renderer). */
export const SETTINGS_SECRET_PATHS = [['github', 'token']] as const

const COMMAND_IDS = new Set<string>(COMMANDS)

export const SETTINGS_RULES: MergeRules = {
  enums: {
    editorIntegration: ['none', 'vscode', 'cursor', 'windsurf', 'phpstorm', 'sublime', 'zed', 'textmate', 'nova', 'bbedit'],
    layout: ['vertical', 'horizontal'],
    prettierQuoteStyle: ['single', 'double'],
    defaultOutputMode: ['detail', 'cli'],
    outputType: ['buffered', 'realtime']
  },
  ranges: {
    editorFontSize: { min: 6, max: 72 },
    outputFontSize: { min: 6, max: 72 },
    // Monaco: 0 = auto, < 8 = multiplier of the font size, >= 8 = pixels.
    lineHeight: { min: 0, max: 100 },
    splitRatio: { min: 0.15, max: 0.85 },
    autoRunDelayMs: { min: 0, max: 60_000, integer: true },
    tabSize: { min: 1, max: 16, integer: true },
    maxDepth: { min: 1, max: 64, integer: true },
    maxItems: { min: 1, max: 100_000, integer: true },
    maxStringLength: { min: 16, max: 10_000_000, integer: true },
    timeoutMs: { min: 1_000, max: 86_400_000, integer: true },
    historyLimit: { min: 0, max: 10_000, integer: true }
  },
  records: {
    shortcuts: { maxKeys: COMMANDS.length, maxValueLength: 100, allowKey: (key) => COMMAND_IDS.has(key) }
  },
  maxStringLength: 10_000
}

type SecretPath = (typeof SETTINGS_SECRET_PATHS)[number]

function getSecret(s: Settings, [group, key]: SecretPath): string {
  return (s[group] as Record<string, string>)[key] ?? ''
}

function setSecret(s: Settings, [group, key]: SecretPath, value: string): void {
  ;(s[group] as Record<string, string>)[key] = value
}

/** Load-time normalization: fill defaults for missing keys, drop unknown keys and invalid values. */
export function normalizeSettings(raw: unknown): Settings {
  if (!isPlainObject(raw)) throw new Error('settings.json must contain a JSON object')
  return mergeTyped(DEFAULT_SETTINGS, cloneJson(DEFAULT_SETTINGS), raw, SETTINGS_RULES)
}

export type SettingsListener = (next: Settings, prev: Settings) => void

/**
 * settings.json. In memory the secrets stay sealed (encrypted); `get()` returns a decrypted, frozen snapshot for
 * the main process and `getMasked()` the renderer-safe variant.
 */
export class SettingsStore {
  private readonly store: JsonStore<Settings>
  private decrypted: Settings | null = null
  private readonly listeners = new Set<SettingsListener>()

  constructor(
    file: string,
    private readonly box: SecretBox,
    opts: { onNotice?: NoticeSink; logger?: Logger; debounceMs?: number } = {}
  ) {
    this.store = new JsonStore<Settings>({
      file,
      label: 'Settings',
      defaults: () => cloneJson(DEFAULT_SETTINGS),
      normalize: normalizeSettings,
      pretty: true,
      debounceMs: opts.debounceMs,
      onNotice: opts.onNotice,
      logger: opts.logger
    })
  }

  /** Decrypted settings (frozen — do not mutate). */
  get(): Settings {
    if (!this.decrypted) {
      const copy = cloneJson(this.store.value)
      for (const path of SETTINGS_SECRET_PATHS) setSecret(copy, path, this.box.open(getSecret(copy, path)))
      this.decrypted = deepFreeze(copy)
    }
    return this.decrypted
  }

  /** Settings with secrets replaced by SECRET_MASK (for the renderer). */
  getMasked(): Settings {
    const copy = cloneJson(this.store.value)
    for (const path of SETTINGS_SECRET_PATHS) setSecret(copy, path, maskSecret(getSecret(copy, path)))
    return copy
  }

  /**
   * Apply a DeepPartial patch from the renderer. Unknown keys and invalid values are ignored; secrets follow the
   * SECRET_MASK rules. Shortcut overrides merge key by key (`null` removes an override).
   * Returns the masked result.
   */
  update(patch: unknown): Settings {
    if (!isPlainObject(patch)) throw new TypeError('Settings patch must be an object')
    const prevSealed = this.store.value
    const prev = this.get()

    // Secrets are resolved separately (mask semantics), so strip them from the generic merge.
    const generic = cloneJson(patch) as Record<string, unknown>
    const secretUpdates: Array<[SecretPath, unknown]> = []
    for (const path of SETTINGS_SECRET_PATHS) {
      const group = generic[path[0]]
      if (isPlainObject(group) && Object.prototype.hasOwnProperty.call(group, path[1])) {
        secretUpdates.push([path, group[path[1]]])
        delete group[path[1]]
      }
    }

    const next = mergeTyped(DEFAULT_SETTINGS, cloneJson(prevSealed), generic, SETTINGS_RULES)
    for (const [path, value] of secretUpdates) {
      setSecret(next, path, this.box.merge(value, getSecret(prevSealed, path)))
    }

    this.commit(next, prev)
    return this.getMasked()
  }

  /** Reset everything (secrets included) to DEFAULT_SETTINGS. */
  reset(): Settings {
    const prev = this.get()
    this.commit(cloneJson(DEFAULT_SETTINGS), prev)
    return this.getMasked()
  }

  onChange(listener: SettingsListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  flushSync(): boolean {
    return this.store.flushSync()
  }

  dispose(): void {
    this.store.dispose()
  }

  private commit(nextSealed: Settings, prev: Settings): void {
    this.store.set(nextSealed)
    this.decrypted = null
    const next = this.get()
    for (const listener of this.listeners) listener(next, prev)
  }
}

