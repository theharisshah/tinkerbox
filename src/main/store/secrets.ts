import { SECRET_MASK } from '../../shared/types'
import { consoleLogger, errorMessage, type Logger, type NoticeSink } from './common'

/**
 * Encryption backend. In the app this wraps Electron's `safeStorage` (Keychain / DPAPI / libsecret);
 * tests inject a fake so the stores run without Electron.
 */
export interface SecretCipher {
  /** True when values can be encrypted at all. */
  isAvailable(): boolean
  /** True when encryption only obfuscates (Linux `basic_text` backend without a keyring). */
  isWeak?(): boolean
  /** Encrypt UTF-8 text → base64 ciphertext. */
  encrypt(plain: string): string
  /** Decrypt base64 ciphertext → UTF-8 text. Throws when the data cannot be decrypted. */
  decrypt(cipherText: string): string
}

const ENC_PREFIX = 'tw-enc:v1:'
const PLAIN_PREFIX = 'tw-plain:'

/**
 * Seals / opens secrets for storage and resolves values coming back from the renderer:
 * - the renderer only ever sees `SECRET_MASK` (or '' when no secret is stored);
 * - saving `SECRET_MASK` keeps the stored value, '' clears it, anything else replaces it.
 *
 * Stored format: `tw-enc:v1:<base64>` when encrypted, `tw-plain:<value>` when encryption is unavailable
 * (Linux without a keyring — a warning is shown once). Values without a prefix (hand-edited files) are read as
 * plain text and encrypted on the next save.
 */
export class SecretBox {
  private warnedPlain = false
  private warnedWeak = false
  private warnedDecrypt = false

  constructor(
    private readonly cipher: SecretCipher,
    private readonly onNotice?: NoticeSink,
    private readonly logger: Logger = consoleLogger
  ) {}

  seal(plain: string): string {
    if (plain === '') return ''
    if (this.cipher.isAvailable()) {
      if (this.cipher.isWeak?.() && !this.warnedWeak) {
        this.warnedWeak = true
        this.onNotice?.({
          level: 'warning',
          message: 'No system keyring was found. Secrets are stored with weak obfuscation only.'
        })
      }
      try {
        return ENC_PREFIX + this.cipher.encrypt(plain)
      } catch (err) {
        this.logger.error('Secret encryption failed, storing as plain text:', err)
      }
    }
    if (!this.warnedPlain) {
      this.warnedPlain = true
      this.onNotice?.({
        level: 'warning',
        message: 'Secure storage is not available on this system. Passwords and API tokens are stored unencrypted.'
      })
    }
    return PLAIN_PREFIX + plain
  }

  open(stored: string | undefined | null): string {
    if (!stored) return ''
    if (stored.startsWith(PLAIN_PREFIX)) return stored.slice(PLAIN_PREFIX.length)
    if (!stored.startsWith(ENC_PREFIX)) return stored
    try {
      return this.cipher.decrypt(stored.slice(ENC_PREFIX.length))
    } catch (err) {
      // Typically the keychain entry changed (copied profile, reinstall). The secret is unrecoverable; the user
      // has to enter it again, so tell them once instead of failing every operation.
      this.logger.error('Secret decryption failed:', err)
      if (!this.warnedDecrypt) {
        this.warnedDecrypt = true
        this.onNotice?.({
          level: 'warning',
          message: `A stored password or token could not be decrypted (${errorMessage(err)}). Please enter it again.`
        })
      }
      return ''
    }
  }

  /**
   * Resolve a secret value coming from the renderer against the currently stored (sealed) value.
   * Returns the new sealed value.
   */
  merge(incoming: unknown, storedSealed: string | undefined): string {
    if (incoming === SECRET_MASK) return storedSealed ?? ''
    if (typeof incoming !== 'string' || incoming === '') return ''
    return this.seal(incoming)
  }
}

/** What the renderer sees for a stored secret. */
export function maskSecret(stored: string | undefined | null): string {
  return stored ? SECRET_MASK : ''
}

/** Cipher used when Electron's safeStorage cannot be used at all. */
export const unavailableCipher: SecretCipher = {
  isAvailable: () => false,
  encrypt: () => {
    throw new Error('Encryption is not available')
  },
  decrypt: () => {
    throw new Error('Encryption is not available')
  }
}
