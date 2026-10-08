import type { PhpBinary } from '@shared/types'

/** Helpers of the PHP Settings modal (tests/unit/modals-b/php.test.ts). */

/** Herd alias such as `php83` / `php74`. */
export function isHerdAlias(value: string): boolean {
  return /^php\d{2,3}$/i.test(value.trim())
}

/** Value written to the connection when a detected binary is picked: the Herd alias when known, else the path. */
export function binaryValue(binary: PhpBinary): string {
  return binary.alias || binary.path
}

/** Whether a configured value (path or alias) designates this binary. */
export function matchesBinary(binary: PhpBinary, configured: string): boolean {
  const value = configured.trim()
  if (!value) return false
  return value === binary.path || (!!binary.alias && value.toLowerCase() === binary.alias.toLowerCase())
}

/** What runs when nothing is configured for the project: the global setting ('auto' when empty). */
export function globalBinary(globalSetting: string | undefined | null): string {
  const value = (globalSetting ?? '').trim()
  return value || 'auto'
}

/** Effective configuration of a project: its override, else the global setting. */
export function effectiveBinary(projectValue: string | undefined | null, globalSetting: string | undefined | null): string {
  return (projectValue ?? '').trim() || globalBinary(globalSetting)
}

/**
 * Best guess for the binary behind `auto` (Herd's default PHP, else the first discovered binary): the detected
 * binary whose version matches the version the project last reported, else the first one.
 */
export function guessAutoBinary(binaries: readonly PhpBinary[], reportedVersion?: string | null): PhpBinary | null {
  if (binaries.length === 0) return null
  if (reportedVersion) {
    const herd = binaries.find((b) => b.version === reportedVersion && b.source === 'Herd')
    if (herd) return herd
    const match = binaries.find((b) => b.version === reportedVersion)
    if (match) return match
  }
  return binaries[0]
}

/** "PHP 8.3" style short label of a version string. */
export function minorVersion(version: string): string {
  const m = /^(\d+)\.(\d+)/.exec(version.trim())
  return m ? `PHP ${m[1]}.${m[2]}` : version ? `PHP ${version}` : 'PHP'
}
