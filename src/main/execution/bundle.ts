/**
 * Builds the single PHP script piped to `php` over stdin: the runner sources from
 * resources/php (manifest order, leading `<?php` stripped) followed by the payload invocation
 * (docs/ARCHITECTURE.md §1.1–1.2). Nothing is ever written on the target.
 *
 * Sources are cached when running packaged; in development they are re-read on every call so
 * edits to resources/php apply without restarting the app.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { PhpPayload } from './types'

/**
 * Same rule Electron uses for `app.isPackaged`, computed without importing `electron` so this module
 * stays importable from vitest: not packaged when running in plain Node, when launched as
 * `electron <dir>` (defaultApp), or when the executable is the stock `electron` binary.
 */
export function isPackagedApp(): boolean {
  if (!process.versions.electron) return false
  if ((process as NodeJS.Process & { defaultApp?: boolean }).defaultApp) return false
  const exe = basename(process.execPath).toLowerCase()
  return process.platform === 'win32' ? exe !== 'electron.exe' : exe !== 'electron'
}

/** Candidate directories holding `manifest.json` for a given resources path, most specific first. */
export function phpResourceCandidates(resourcesPath: string): string[] {
  const candidates = [join(resourcesPath, 'php'), join(resourcesPath, 'resources', 'php')]
  const electronResources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (electronResources) candidates.push(join(electronResources, 'php'))
  // Development fallbacks: out/main/index.js → <repo>/resources/php, or the current working directory.
  candidates.push(resolve(__dirname, '../../resources/php'), resolve(process.cwd(), 'resources/php'))
  return [...new Set(candidates)]
}

/** Resolve the runner resource directory (dev: <repo>/resources/php, packaged: <resources>/php). */
export function resolvePhpResourceDir(resourcesPath: string): string {
  const candidates = phpResourceCandidates(resourcesPath)
  for (const dir of candidates) {
    if (existsSync(join(dir, 'manifest.json'))) return dir
  }
  throw new Error(`Tinkerbox PHP runner not found (looked for manifest.json in ${candidates.join(', ')})`)
}

/** Remove a BOM, the leading `<?php` open tag and a trailing `?>` from one runner source file. */
export function stripPhpTags(source: string): string {
  let out = source.replace(/^﻿/, '')
  out = out.replace(/^\s*<\?php\b[ \t]*\r?\n?/i, '')
  out = out.replace(/\?>\s*$/, '')
  return out
}

/** Concatenate runner sources into one script starting with `<?php`. */
export function concatenateSources(files: Array<{ name: string; content: string }>): string {
  const parts = ['<?php\n']
  for (const file of files) {
    // Comments between namespace blocks are allowed and make PHP errors traceable to a source file.
    parts.push(`// ---- ${file.name.replace(/[\r\n]/g, ' ')} ----\n`, stripPhpTags(file.content).trimEnd(), '\n')
  }
  return parts.join('')
}

interface Manifest {
  files: string[]
}

function readManifest(dir: string): Manifest {
  const raw = readFileSync(join(dir, 'manifest.json'), 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`Invalid runner manifest ${join(dir, 'manifest.json')}: ${(err as Error).message}`)
  }
  const files = (parsed as Partial<Manifest> | null)?.files
  if (!Array.isArray(files) || files.some((f) => typeof f !== 'string')) {
    throw new Error(`Invalid runner manifest ${join(dir, 'manifest.json')}: "files" must be an array of paths`)
  }
  return { files }
}

/** Read and concatenate the runner sources of `dir` (no caching). */
export function readRunnerScript(dir: string): string {
  const manifest = readManifest(dir)
  const files = manifest.files.map((name) => {
    const path = join(dir, name)
    try {
      return { name, content: readFileSync(path, 'utf8') }
    } catch (err) {
      throw new Error(`Runner source missing: ${path} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`)
    }
  })
  return concatenateSources(files)
}

const scriptCache = new Map<string, string>()

/**
 * The concatenated runner script for a resources path. Cached when packaged (or when `cache` is true);
 * re-read on every call in development.
 */
export function loadRunnerScript(resourcesPath: string, options: { cache?: boolean } = {}): string {
  const dir = resolvePhpResourceDir(resourcesPath)
  const useCache = options.cache ?? isPackagedApp()
  if (useCache) {
    const cached = scriptCache.get(dir)
    if (cached !== undefined) return cached
  }
  const script = readRunnerScript(dir)
  if (useCache) scriptCache.set(dir, script)
  return script
}

export function clearRunnerScriptCache(): void {
  scriptCache.clear()
}

/** The trailing `namespace { … }` block invoking the runner with the base64 JSON payload (§1.2). */
export function buildInvocation(payload: PhpPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  return `namespace {\n    \\Tinkerbox\\Runner::main(\\json_decode(\\base64_decode('${encoded}'), true));\n}\n`
}

/** Full script for stdin: runner sources + invocation. */
export function buildBundle(runnerScript: string, payload: PhpPayload): string {
  return `${runnerScript.trimEnd()}\n${buildInvocation(payload)}`
}

/** Per-run marker nonce (crypto random, never guessable by user code). */
export function newNonce(): string {
  return `tw_${randomBytes(12).toString('hex')}`
}

export function encodeCode(code: string): string {
  return Buffer.from(code, 'utf8').toString('base64')
}
