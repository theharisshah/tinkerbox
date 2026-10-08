import { describe, expect, it } from 'vitest'
import { createPhpConf, createPhpLanguage, LANGUAGE_ID, WORD_PATTERN } from '../../../src/renderer/src/monaco/language'
import { tokenizeLines, typeOf } from './monarch'

function types(line: string): Array<[string, string]> {
  return tokenizeLines(line)[0].map((t) => [t.text, t.type])
}

describe('tinkwell-php grammar', () => {
  it('starts in PHP mode without an open tag', () => {
    expect(types('$user = 1;')).toEqual([
      ['$user', 'variable.php'],
      ['=', 'operator.php'],
      ['1', 'number.php'],
      [';', 'delimiter.php']
    ])
  })

  it('tolerates a leading <?php', () => {
    const lines = tokenizeLines('<?php\n$a = true;')
    expect(lines[0]).toEqual([{ text: '<?php', type: 'metatag.php' }])
    expect(lines[1][0]).toEqual({ text: '$a', type: 'variable.php' })
    expect(lines[1].find((t) => t.text === 'true')?.type).toBe('constant.php')
  })

  it('highlights keywords, PHP 8 keywords and type declarations', () => {
    expect(typeOf('fn (int $a): string => $a;', 'fn')).toBe('keyword.php')
    expect(typeOf('fn (int $a): string => $a;', 'int')).toBe('keyword.type.php')
    expect(typeOf('match ($a) { default => null };', 'match')).toBe('keyword.php')
    expect(typeOf('match ($a) { default => null };', 'default')).toBe('keyword.php')
    expect(typeOf('foreach ($items as $item) {}', 'foreach')).toBe('keyword.php')
    expect(typeOf('enum Status: string {}', 'enum')).toBe('keyword.php')
    expect(typeOf('$x = null ?? NULL;', 'NULL')).toBe('constant.php')
  })

  it('distinguishes classes, functions, properties and constants', () => {
    const line = "User::where('a', 1)->first()->name;"
    expect(typeOf(line, 'User')).toBe('type.php')
    expect(typeOf(line, 'where')).toBe('function.php')
    expect(typeOf(line, 'first')).toBe('function.php')
    expect(typeOf(line, 'name')).toBe('property.php')
    expect(typeOf('DB::table("x");', 'DB')).toBe('type.php')
    expect(typeOf('echo PHP_EOL;', 'PHP_EOL')).toBe('constant.php')
    expect(typeOf('Status::Active;', 'Active')).toBe('constant.php')
    expect(typeOf('strtoupper($x);', 'strtoupper')).toBe('function.php')
    expect(typeOf('$u = new \\App\\Models\\User();', '\\App\\Models\\User')).toBe('type.php')
    expect(typeOf('$this->x;', '$this')).toBe('variable.predefined.php')
  })

  it('tokenizes strings with escapes and interpolation', () => {
    const toks = tokenizeLines('$s = "Hi $name\\n" . \'it\\\'s\';')[0]
    expect(toks.find((t) => t.text === '$name')?.type).toBe('variable.php')
    expect(toks.find((t) => t.text === '\\n')?.type).toBe('string.escape.php')
    expect(toks.find((t) => t.text === "\\'")?.type).toBe('string.escape.php')
    // single-quoted strings do not interpolate
    expect(tokenizeLines("'$x'")[0]).toEqual([{ text: "'$x'", type: 'string.php' }])
  })

  it('highlights heredoc and nowdoc bodies across lines', () => {
    const lines = tokenizeLines('$h = <<<EOT\n  Hello $name\n  EOT;\n$n = <<<\'RAW\'\n  raw $x\nRAW;\n$after = 1;')
    expect(lines[0].find((t) => t.text === '<<<EOT')?.type).toBe('string.heredoc.delimiter.php')
    expect(lines[1].find((t) => t.text.includes('Hello'))?.type).toBe('string.heredoc.php')
    expect(lines[1].find((t) => t.text === '$name')?.type).toBe('variable.php')
    expect(lines[2][0]).toEqual({ text: '  EOT', type: 'string.heredoc.delimiter.php' })
    expect(lines[2][1]).toEqual({ text: ';', type: 'delimiter.php' })
    expect(lines[4]).toEqual([{ text: '  raw $x', type: 'string.heredoc.php' }])
    expect(lines[5][0].type).toBe('string.heredoc.delimiter.php')
    expect(lines[6][0]).toEqual({ text: '$after', type: 'variable.php' })
  })

  it('does not end a heredoc on a longer label or text containing it', () => {
    const lines = tokenizeLines('$h = <<<EOT\nEOTX\nnot EOT\nEOT;\n$x;')
    expect(lines[1][0].type).toBe('string.heredoc.php')
    expect(lines[2][0].type).toBe('string.heredoc.php')
    expect(lines[3][0].type).toBe('string.heredoc.delimiter.php')
    expect(lines[4][0].type).toBe('variable.php')
  })

  it('marks comments, doc comments and magic comments', () => {
    expect(types('$a = 1; // note')[4]).toEqual(['// note', 'comment.php'])
    expect(types('$a = 1; # note')[4]).toEqual(['# note', 'comment.php'])
    expect(types('$a = 1; //? label')[4]).toEqual(['//? label', 'comment.magic.php'])
    expect(typeOf('foo() /*?*/ + 1;', '/*?*/')).toBe('comment.magic.php')
    expect(typeOf('$x /*?->count()*/;', '/*?->count()*/')).toBe('comment.magic.php')
    const doc = tokenizeLines('/** @var User $u */')[0]
    expect(doc.find((t) => t.text === '@var')?.type).toBe('comment.doc.tag.php')
    const block = tokenizeLines('/* a\n b */ $x;')
    expect(block[1][0].type).toBe('comment.php')
    expect(block[1].find((t) => t.text === '$x')?.type).toBe('variable.php')
    // #[ is an attribute, not a comment
    expect(typeOf('#[Attr]', '#[')).toBe('annotation.php')
  })

  it('tokenizes numbers with separators and bases', () => {
    expect(typeOf('1_000_000;', '1_000_000')).toBe('number.php')
    expect(typeOf('1.5e3;', '1.5e3')).toBe('number.float.php')
    expect(typeOf('0x1F;', '0x1F')).toBe('number.hex.php')
    expect(typeOf('0b101;', '0b101')).toBe('number.binary.php')
  })

  it('exposes a configuration with the $variable word pattern', () => {
    const conf = createPhpConf()
    expect(conf.wordPattern).toBe(WORD_PATTERN)
    expect(conf.comments?.lineComment).toBe('//')
    expect(conf.autoClosingPairs?.some((p) => 'open' in p && p.open === '"')).toBe(true)
    expect(createPhpLanguage().tokenPostfix).toBe('.php')
    expect(LANGUAGE_ID).toBe('tinkwell-php')
  })

  it('word pattern selects $variable including the dollar', () => {
    const words = (text: string): string[] => [...text.matchAll(new RegExp(WORD_PATTERN.source, 'g'))].map((m) => m[0])
    expect(words('$user->name = $other;')).toEqual(['$user', 'name', '$other'])
    expect(words('App\\Models\\User::first()')).toEqual(['App', 'Models', 'User', 'first'])
    expect(words('$a1 + 2.5')).toContain('$a1')
  })
})
