import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveTextFile } from '../../../src/main/ipc/files'

/** file:save of an editor tab (src/main/ipc/files.ts saveTextFile). */

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tinkerbox-save-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('saving editor files', () => {
  it('replaces a regular file atomically, keeping its permissions', () => {
    const dir = tempDir()
    const file = join(dir, 'script.php')
    writeFileSync(file, '<?php // original\n')
    chmodSync(file, 0o640)
    expect(saveTextFile(file, '<?php // saved\n')).toBe(file)
    expect(readFileSync(file, 'utf8')).toBe('<?php // saved\n')
    expect(statSync(file).mode & 0o777).toBe(0o640)
    expect(readdirSync(dir)).toEqual(['script.php'])
  })

  it('creates new files', () => {
    const dir = tempDir()
    const file = join(dir, 'new.php')
    saveTextFile(file, 'x')
    expect(readFileSync(file, 'utf8')).toBe('x')
    expect(statSync(file).mode & 0o777).toBe(0o644)
  })

  it('writes through a symlink and keeps the link', () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'real'))
    const real = join(dir, 'real', 'real.php')
    const link = join(dir, 'link.php')
    writeFileSync(real, '<?php // original\n')
    symlinkSync(real, link)
    const written = saveTextFile(link, '<?php // through the link\n')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(real, 'utf8')).toBe('<?php // through the link\n')
    expect(written).toBe(realpathSync(real))
    expect(readdirSync(dir).sort()).toEqual(['link.php', 'real'])
    expect(readdirSync(join(dir, 'real'))).toEqual(['real.php'])
  })

  it('edits the shared content of hard-linked files', () => {
    const dir = tempDir()
    const a = join(dir, 'a.php')
    const b = join(dir, 'b.php')
    writeFileSync(a, 'orig')
    linkSync(a, b)
    saveTextFile(b, 'changed')
    expect(readFileSync(a, 'utf8')).toBe('changed')
    expect(statSync(a).ino).toBe(statSync(b).ino)
  })

  it('refuses directories and links to missing files', () => {
    const dir = tempDir()
    expect(() => saveTextFile(dir, 'x')).toThrow(/not a regular file/)
    const dangling = join(dir, 'dangling.php')
    symlinkSync(join(dir, 'missing.php'), dangling)
    expect(() => saveTextFile(dangling, 'x')).toThrow(/does not exist/)
    expect(lstatSync(dangling).isSymbolicLink()).toBe(true)
  })
})
