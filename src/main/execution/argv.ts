/**
 * Pure command-line helpers (unit-tested in tests/unit/execution/argv.test.ts): the PHP `-d` flags
 * every run uses and Windows batch-file invocation (Herd's `composer.bat`) without Node's generic
 * `shell: true` mode.
 */

export interface SpawnCommand {
  command: string
  args: string[]
  /** Pass the args to CreateProcess verbatim (Windows batch invocations). */
  windowsVerbatimArguments?: boolean
}

export interface PhpFlagOptions {
  /** Xdebug step debugging (per-project toggle). */
  debug?: boolean
  /** Absolute path of an Xdebug extension to load when debugging and the php.ini does not load it. */
  xdebugExtension?: string
}

/**
 * `-d` flags passed to every PHP process (docs/ARCHITECTURE.md §2.1): Xdebug off (Herd ships it enabled,
 * which slows every run down) unless debugging, and PHP's own error display on stderr so it never
 * mixes with the envelope on stdout.
 */
export function phpFlags(options: PhpFlagOptions = {}): string[] {
  const flags: string[] = []
  if (options.debug) {
    if (options.xdebugExtension) flags.push('-d', `zend_extension=${options.xdebugExtension}`)
    flags.push('-d', 'xdebug.mode=debug', '-d', 'xdebug.start_with_request=yes')
  } else {
    flags.push('-d', 'xdebug.mode=off')
  }
  flags.push('-d', 'display_errors=stderr')
  return flags
}

/** cmd.exe metacharacters that must be `^`-escaped (same set as cross-spawn). */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

/**
 * Escape an argument for `cmd.exe /d /s /c "…"`. MSVC quoting first (backslashes doubled before a
 * quote / at the end, quotes escaped), then metacharacters `^`-escaped — twice for batch files, which
 * re-parse their arguments (the approach cross-spawn uses).
 */
export function cmdEscapeArg(value: string, isBatchFile = true): string {
  let escaped = `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`
  escaped = escaped.replace(CMD_META, '^$1')
  if (isBatchFile) escaped = escaped.replace(CMD_META, '^$1')
  return escaped
}

/** Spawn spec for a Windows .bat/.cmd file (e.g. Herd's composer.bat). */
export function windowsBatchCommand(file: string, args: string[], comspec = 'cmd.exe'): SpawnCommand {
  const line = [cmdEscapeArg(file, false), ...args.map((a) => cmdEscapeArg(a, true))].join(' ')
  return { command: comspec, args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true }
}
