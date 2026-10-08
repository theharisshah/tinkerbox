import { describe, expect, it } from 'vitest'
import { cmdEscapeArg, phpFlags, windowsBatchCommand } from '../../../src/main/execution/argv'

describe('phpFlags', () => {
  it('turns Xdebug off and sends display_errors to stderr by default', () => {
    expect(phpFlags()).toEqual(['-d', 'xdebug.mode=off', '-d', 'display_errors=stderr'])
  })

  it('enables step debugging when requested', () => {
    expect(phpFlags({ debug: true })).toEqual(['-d', 'xdebug.mode=debug', '-d', 'xdebug.start_with_request=yes', '-d', 'display_errors=stderr'])
  })

  it('loads a given Xdebug extension before configuring it', () => {
    expect(phpFlags({ debug: true, xdebugExtension: '/x/xdebug-83-arm64.so' })).toEqual([
      '-d',
      'zend_extension=/x/xdebug-83-arm64.so',
      '-d',
      'xdebug.mode=debug',
      '-d',
      'xdebug.start_with_request=yes',
      '-d',
      'display_errors=stderr'
    ])
  })

  it('ignores the extension when not debugging', () => {
    expect(phpFlags({ debug: false, xdebugExtension: '/x.so' })).not.toContain('zend_extension=/x.so')
  })
})

describe('cmdEscapeArg', () => {
  it('quotes and caret-escapes the quotes', () => {
    expect(cmdEscapeArg('simple', false)).toBe('^"simple^"')
  })

  it('escapes metacharacters once for executables and twice for batch files', () => {
    expect(cmdEscapeArg('a&b', false)).toBe('^"a^&b^"')
    expect(cmdEscapeArg('a&b', true)).toBe('^^^"a^^^&b^^^"')
  })

  it('doubles backslashes before quotes and at the end', () => {
    expect(cmdEscapeArg('C:\\dir\\', false)).toBe('^"C:\\dir\\\\^"')
    expect(cmdEscapeArg('say \\"hi\\"', false)).toBe('^"say^ \\\\\\^"hi\\\\\\^"^"')
  })

  it('escapes percent signs (no env expansion)', () => {
    expect(cmdEscapeArg('%PATH%', false)).toBe('^"^%PATH^%^"')
  })
})

describe('windowsBatchCommand', () => {
  it('builds a verbatim cmd.exe invocation', () => {
    const cmd = windowsBatchCommand('C:\\Herd\\composer.bat', ['create-project', 'laravel/laravel'], 'C:\\Windows\\cmd.exe')
    expect(cmd.command).toBe('C:\\Windows\\cmd.exe')
    expect(cmd.windowsVerbatimArguments).toBe(true)
    expect(cmd.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(cmd.args[3]).toBe('"^"C:\\Herd\\composer.bat^" ^^^"create-project^^^" ^^^"laravel/laravel^^^""')
  })
})
