import { describe, expect, it } from 'vitest'
import {
  minimalEdit,
  prettierPhpVersion,
  prettifyPhp,
  PrettifyError,
  withTrailingSemicolon
} from '../../../src/renderer/src/monaco/format'

const opts = { quoteStyle: 'single' as const, tabSize: 4, phpVersion: '8.3.12' }

describe('prettify', () => {
  it('formats code without an open tag and strips the wrapper', async () => {
    const result = await prettifyPhp('$a=[1,2,3];\nforeach($a as $b){echo $b;}', 0, opts)
    expect(result.code).toBe('$a = [1, 2, 3];\nforeach ($a as $b) {\n    echo $b;\n}')
    expect(result.code.startsWith('<?php')).toBe(false)
  })

  it('keeps a leading <?php when the code has one', async () => {
    const result = await prettifyPhp('<?php\n$a=1;\n', 0, opts)
    expect(result.code).toBe('<?php\n$a = 1;\n')
  })

  it('follows the quote style and tab size settings', async () => {
    expect((await prettifyPhp('$a = "x";', 0, opts)).code).toBe("$a = 'x';")
    expect((await prettifyPhp("$a = 'x';", 0, { ...opts, quoteStyle: 'double' })).code).toBe('$a = "x";')
    expect((await prettifyPhp('if($a){$b=1;}', 0, { ...opts, tabSize: 2 })).code).toBe('if ($a) {\n  $b = 1;\n}')
  })

  it('never adds trailing commas', async () => {
    const long = `$x = foo(${Array.from({ length: 12 }, (_, i) => `$argument${i}`).join(', ')});`
    const result = await prettifyPhp(long, 0, opts)
    expect(result.code).toContain('\n')
    expect(result.code).not.toMatch(/,\s*\)/)
  })

  it('tolerates a missing semicolon after the last statement', async () => {
    // The PHP parser accepts it at the end of the code; Prettier then prints the semicolon.
    expect((await prettifyPhp('$a=1;\nUser::where("a",1)->first()', 0, opts)).code).toBe("$a = 1;\nUser::where('a', 1)->first();")
    expect((await prettifyPhp('collect([1,2])->sum() //? total', 0, opts)).code).toBe('collect([1, 2])->sum(); //? total')
    expect(withTrailingSemicolon('foo() // c')).toEqual({ code: 'foo(); // c', offset: 5 })
    expect(withTrailingSemicolon('foo();')).toBeNull()
    expect(withTrailingSemicolon('if ($a) {}')).toBeNull()
  })

  it('keeps magic comments', async () => {
    const result = await prettifyPhp('$a=1; //?\n$b=2; //? label', 0, opts)
    expect(result.code).toBe('$a = 1; //?\n$b = 2; //? label')
  })

  it('maps the cursor into the formatted code', async () => {
    const code = '$a=1;\n$bb=2;'
    const result = await prettifyPhp(code, code.indexOf('$bb') + 2, opts)
    expect(result.code).toBe('$a = 1;\n$bb = 2;')
    expect(result.code.slice(result.cursorOffset - 2, result.cursorOffset)).toBe('$b')
  })

  it('reports syntax errors with the editor line', async () => {
    const error = await prettifyPhp('$a = 1;\n$b = ;\n', 0, opts).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PrettifyError)
    expect((error as PrettifyError).line).toBe(2)
  })

  it('leaves blank code alone', async () => {
    expect(await prettifyPhp('  \n', 1, opts)).toEqual({ code: '  \n', cursorOffset: 1 })
  })

  it('maps PHP versions to Prettier phpVersion', () => {
    expect(prettierPhpVersion('8.3.12')).toBe('8.3')
    expect(prettierPhpVersion('7.4.33')).toBe('7.4')
    expect(prettierPhpVersion('9.1.0')).toBe('8.5')
    expect(prettierPhpVersion('5.6.0')).toBe('7.0')
    expect(prettierPhpVersion('')).toBe('8.0')
    expect(prettierPhpVersion(null)).toBe('8.0')
  })
})

describe('minimal edits', () => {
  it('replaces only the changed middle part', () => {
    expect(minimalEdit('abcdef', 'abXYef')).toEqual({ start: 2, end: 4, text: 'XY' })
    expect(minimalEdit('abc', 'abc')).toBeNull()
    expect(minimalEdit('', 'x')).toEqual({ start: 0, end: 0, text: 'x' })
    expect(minimalEdit('aaa', 'aa')).toEqual({ start: 2, end: 3, text: '' })
  })
})
