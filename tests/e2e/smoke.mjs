#!/usr/bin/env node
/**
 * Tinkerbox end-to-end smoke test: drives the BUILT Electron app with Playwright (`_electron`).
 *
 * Run (from the repo root):
 *   npm run build && node tests/e2e/smoke.mjs              # typecheck + build, then the smoke test
 *   npx electron-vite build && node tests/e2e/smoke.mjs    # build only (faster), then the smoke test
 *   npm run test && npm run test:php                       # unit and PHP suites (separate)
 *
 * Environment:
 *   TINKERBOX_TEST_LARAVEL  Laravel project opened READ-ONLY (no default; Laravel steps are skipped when unset). Laravel steps
 *                           are skipped when it does not exist. The run fails when any file in it (outside
 *                           vendor/node_modules/.git) changes. Only in-memory SQLite and non-persisting code is run.
 *   E2E_KEEP=1              keep the isolated user-data directory (path printed at the end)
 *   E2E_SLOWMO=<ms>         slow every Playwright action down (debugging)
 *
 * Isolation: the app runs with --user-data-dir=<fresh temp dir> (plus TINKERBOX_USER_DATA_DIR), which
 * src/main/index.ts applies before the single-instance lock: a running Tinkerbox is never touched, the test starts
 * from default settings, and isolated profiles do not register the tinkerbox:// protocol. OS dialogs are stubbed in
 * the main process for the steps that need them. `clipboard.writeText` and `shell.openExternal` are replaced in the
 * main process for the whole run: copies and editor / browser links are captured and asserted, never performed, so
 * the system clipboard is untouched and no editor or browser opens.
 *
 * Native menu accelerators (⌘R, ⇧⌘P, …) are handled by macOS before key events reach the page, and Playwright's
 * synthesized keys never reach the native menu. Menu commands are therefore triggered by clicking the real native
 * menu items from the main process (`Menu.getApplicationMenu().getMenuItemById('command:<id>').click()`), the same
 * path as the keyboard shortcut. Keys the renderer or Monaco handle (ESC, typing, ⌘. quick fix) use the keyboard.
 * Pinia state is only READ for assertions (through `window.__tbx`); a few settings that have no quick UI path are
 * set up through the app's own `settings:update` IPC channel.
 *
 * Phases: light theme → Dracula → relaunch (session restore) → relaunch with a corrupted settings.json.
 * Screenshots: tests/e2e/screenshots/<nn>-<name>[-dracula].png. Exit code 0 when every step passed.
 */
import { _electron as electron } from 'playwright'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SHOTS = join(ROOT, 'tests/e2e/screenshots')
const LARAVEL = process.env.TINKERBOX_TEST_LARAVEL || ''
const HAS_LARAVEL = LARAVEL !== '' && existsSync(join(LARAVEL, 'artisan'))
const LARAVEL_NAME = LARAVEL.split('/').pop()
const KEEP = process.env.E2E_KEEP === '1'
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
/** The app's modals (Monaco's find widget also has role=dialog, but no aria-modal). */
const MODAL = '[role=dialog][aria-modal=true]'
const ELECTRON_BIN = createRequire(import.meta.url)('electron')

const DRIVER_PHP = `<?php

use Tinkerbox\\Drivers\\Driver;
use Tinkerbox\\Panels\\Panel;

class E2eDriver extends Driver
{
    public function id(): string
    {
        return 'e2e';
    }

    public function name(): string
    {
        return 'E2E Framework';
    }

    public function canBootstrap(string $projectPath): bool
    {
        return is_file($projectPath . '/e2e.marker');
    }

    public function bootstrap(string $projectPath): void
    {
        if (is_file($projectPath . '/broken.marker')) {
            throw new RuntimeException('The E2E framework refused to boot');
        }
    }

    public function version(): ?string
    {
        return 'E2E Framework 1.2.3';
    }

    public function variables(): array
    {
        return ['greeting' => 'Hello from the E2E driver'];
    }

    public function panels(string $projectPath): array
    {
        return [Panel::make('E2E Panel')->section('Status', ['Mode' => 'testing', 'Answer' => 42])->toArray()];
    }
}
`
const SNIPPET_PHP = `<?php
/**
 * @label E2E project snippet
 * @description Shows the variable the E2E driver injects.
 */
$greeting;
`

if (!existsSync(join(ROOT, 'out/main/index.js')) || !existsSync(join(ROOT, 'out/renderer/index.html'))) {
  console.error('The app is not built. Run `npx electron-vite build` (or `npm run build`) first.')
  process.exit(1)
}
mkdirSync(SHOTS, { recursive: true })
for (const f of readdirSync(SHOTS)) if (f.endsWith('.png')) rmSync(join(SHOTS, f))

// ---------------------------------------------------------------------------------------------------------------
// Step runner
// ---------------------------------------------------------------------------------------------------------------
const results = []
let shotNo = 0
let themeSuffix = ''

/** Thrown by a step whose precondition is not met by the configured project (reported as skipped, not failed). */
class SkipStep extends Error {}

function assert(cond, message) {
  if (!cond) throw new Error(`Assertion failed: ${message}`)
}

async function step(name, fn, { needsLaravel = false } = {}) {
  if (needsLaravel && !HAS_LARAVEL) {
    results.push({ name, status: 'skip', detail: `no Laravel project at ${LARAVEL}` })
    console.log(`  - ${name} (skipped: no Laravel project)`)
    return
  }
  const started = Date.now()
  try {
    await fn()
    results.push({ name, status: 'pass', ms: Date.now() - started })
    console.log(`  ✓ ${name} (${Date.now() - started} ms)`)
  } catch (err) {
    if (err instanceof SkipStep) {
      results.push({ name, status: 'skip', detail: err.message })
      console.log(`  - ${name} (skipped: ${err.message})`)
      await closeModals().catch(() => undefined)
      return
    }
    results.push({ name, status: 'fail', detail: err?.stack || String(err) })
    console.log(`  ✗ ${name}\n      ${String(err?.message || err).split('\n').join('\n      ')}`)
    if (unexpectedExit) {
      console.log(`\nThe app exited unexpectedly. Last main-process output:\n${mainLog.slice(-60).join('\n')}`)
      await finish()
    }
    await shot(`FAILED-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 60)}`).catch(() => undefined)
    await closeModals().catch(() => undefined) // leave the app usable for the next step
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Launching (relaunchable with the same isolated profile)
// ---------------------------------------------------------------------------------------------------------------
const userData = mkdtempSync(join(tmpdir(), 'tinkerbox-e2e-'))
const scratch = join(userData, 'e2e-scratch') // folders/files the test creates (never inside the Laravel project)
mkdirSync(scratch, { recursive: true })
const consoleErrors = []
const mainErrors = []
const mainLog = []
const startedAt = Date.now()
const laravelBefore = HAS_LARAVEL ? snapshotTree(LARAVEL) : null
let app = null
let page = null
let closingOnPurpose = false
let unexpectedExit = false

console.log(`Tinkerbox E2E smoke test\n  user data: ${userData}\n  laravel:   ${HAS_LARAVEL ? LARAVEL : '(none)'}\n`)

function collectMain(text) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    mainLog.push(line)
    if (mainLog.length > 400) mainLog.shift()
    if (/\[error\]/i.test(line)) mainErrors.push(line.trim())
  }
}

async function launch() {
  closingOnPurpose = false
  app = await electron.launch({
    args: [ROOT, `--user-data-dir=${userData}`],
    cwd: ROOT,
    env: { ...process.env, TINKERBOX_USER_DATA_DIR: userData },
    slowMo: Number(process.env.E2E_SLOWMO || 0) || undefined,
    timeout: 60_000
  })
  app.process().stdout?.on('data', (d) => collectMain(String(d)))
  app.process().stderr?.on('data', (d) => collectMain(String(d)))
  app.on('close', () => {
    if (!closingOnPurpose) unexpectedExit = true
  })
  page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`))
  await page.waitForFunction(() => !!document.querySelector('#app')?.__vue_app__, null, { timeout: 30_000 })
  // Read-only accessor for assertions: window.__tbx('tabs') → the Pinia store.
  await page.evaluate(() => {
    window.__tbx = (name) => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get(name)
  })
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.setSize(1440, 920)
    win.center()
  })
  // Capture copies and external links instead of performing them (see the header).
  await app.evaluate(({ clipboard, shell }) => {
    globalThis.__e2eCaptured = { clipboard: [], urls: [] }
    clipboard.writeText = (text) => void globalThis.__e2eCaptured.clipboard.push(String(text))
    shell.openExternal = async (url) => void globalThis.__e2eCaptured.urls.push(String(url))
    shell.showItemInFolder = (path) => void globalThis.__e2eCaptured.urls.push(`reveal:${path}`)
  })
}

/** Texts copied and URLs "opened" in the main process since launch. */
const captured = () => app.evaluate(() => globalThis.__e2eCaptured)
const lastCopied = async () => (await captured()).clipboard.at(-1) ?? ''

async function quit() {
  closingOnPurpose = true
  await app.close().catch(() => undefined)
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------
async function shot(name) {
  shotNo += 1
  const file = join(SHOTS, `${String(shotNo).padStart(2, '0')}-${name}${themeSuffix}.png`)
  await page.waitForTimeout(300) // let modal / popover transitions finish
  await page.screenshot({ path: file })
  return file
}

/** Click a native menu item for a command (same path as its keyboard shortcut). */
async function menu(command) {
  const ok = await app.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(`command:${id}`)
    if (!item) return false
    item.click()
    return true
  }, command)
  assert(ok, `native menu item command:${command} exists`)
}

/** Evaluate `fn(store, arg)` in the page (read-only assertions). */
function store(fn, arg) {
  return page.evaluate(`(${fn.toString()})(window.__tbx, ${JSON.stringify(arg ?? null)})`)
}

/**
 * Wait until `fn(store, arg)` is truthy in the page. Polled from Node through `store()` (CDP evaluation): the page CSP
 * forbids eval, which page.waitForFunction would need for a predicate built at runtime.
 */
async function until(fn, arg, timeout = 15_000) {
  const end = Date.now() + timeout
  let last
  for (;;) {
    try {
      last = await store(fn, arg)
      if (last) return last
    } catch (err) {
      if (Date.now() > end) throw err
    }
    if (Date.now() > end) throw new Error(`Timed out after ${timeout} ms waiting for ${fn.toString().slice(0, 160)}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

const activeCode = () => store((s) => s('tabs').activeTab?.code ?? null)
const settingsValue = (key) => store((s, k) => s('settings').settings[k], key)

/** Test setup only: change settings through the app's own IPC channel. */
async function updateSettings(patch) {
  await page.evaluate((p) => window.tinkerbox.invoke('settings:update', p), patch)
  await until((s, p) => Object.entries(p).every(([k, v]) => JSON.stringify(s('settings').settings[k]) === JSON.stringify(v)), patch)
}

function topModal() {
  return page.locator(MODAL).last()
}

async function closeModals() {
  for (let i = 0; i < 5; i++) {
    if ((await page.locator(MODAL).count()) === 0) return
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
  }
}

async function expectNoModal() {
  await page.locator(MODAL).first().waitFor({ state: 'detached', timeout: 5000 })
}

const editorEl = () => page.locator('[data-testid=editor-pane] .monaco-editor').first()
const viewLinesText = async () => (await page.locator('[data-testid=editor-pane] .view-lines').innerText()).replace(/ /g, ' ')

/**
 * Replace the editor content like a user pasting it: select all, delete, then a `paste` ClipboardEvent carrying the
 * text (Monaco's real paste path, without auto-indent and without touching the system clipboard).
 */
async function setCode(code) {
  await editorEl().waitFor()
  await editorEl().click({ position: { x: 200, y: 40 } })
  await page.keyboard.press(`${MOD}+A`)
  await page.keyboard.press('Backspace')
  if (code) {
    const pasted = await page.evaluate((text) => {
      const target = document.activeElement
      if (!target || !target.closest('[data-testid=editor-pane]')) return false
      const data = new DataTransfer()
      data.setData('text/plain', text)
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
      return true
    }, code)
    assert(pasted, 'the editor has focus for pasting')
  }
  await until((s, expected) => s('tabs').activeTab?.code === expected, code, 5000)
}

const activeTabId = () => store((s) => s('tabs').activeTabId)
const lastFinishedAt = (id) => store((s, tabId) => s('tabs').results[tabId]?.finishedAt ?? 0, id)

async function waitForRun(tabId, previous, timeout = 60_000) {
  await until(
    (s, [id, prev]) => {
      const tabs = s('tabs')
      const r = tabs.results[id]
      return !tabs.running[id] && r && r.finishedAt !== prev
    },
    [tabId, previous],
    timeout
  )
  return store((s, id) => {
    const r = s('tabs').results[id]
    return {
      error: r.error ?? null,
      exception: r.exception?.class ?? null,
      hasReturn: r.hasReturnValue,
      php: r.phpVersion,
      driver: r.driver?.appVersion ?? null,
      cancelled: !!r.cancelled,
      timedOut: !!r.timedOut,
      exited: !!r.exited
    }
  }, tabId)
}

/** Click Run (sidebar ▶) and wait for the run to finish. */
async function run({ timeout = 60_000 } = {}) {
  const tabId = await activeTabId()
  const before = await lastFinishedAt(tabId)
  await page.locator('[data-testid=run-button]').click()
  await page.mouse.move(700, 760) // keep the Run tooltip out of screenshots
  return waitForRun(tabId, before, timeout)
}

const okRun = (r) => assert(!r.error && !r.exception, `run succeeded (${r.error ?? r.exception ?? ''})`)
const output = () => page.locator('[data-testid=cards-view]')
const returnCard = () => output().locator('section', { has: page.getByText('Return value', { exact: true }) }).last()

async function cardAction(card, label) {
  await card.hover()
  const button = card.getByRole('button', { name: label, exact: true })
  await button.waitFor({ state: 'visible' })
  await button.click()
}

/** Open the Laravel project in the active code tab through Open Anything's "/" folder search. */
async function openLaravelHere() {
  await menu('commandPalette')
  const input = page.locator('[data-testid=palette-input]')
  await input.waitFor()
  await input.fill('/' + LARAVEL_NAME)
  await page.locator('[role=option][data-selected=true]', { hasText: LARAVEL_NAME }).waitFor()
  await page.keyboard.press('Enter')
  await expectNoModal()
  await until(() => document.querySelector('[data-testid=status-framework]')?.textContent?.includes('Laravel'), null, 60_000)
}

/** Put the cursor at the start of a (1-based) editor line. */
async function gotoLine(line) {
  await editorEl().click({ position: { x: 200, y: 40 } })
  await page.keyboard.press(`${MOD}+ArrowUp`)
  for (let i = 1; i < line; i++) await page.keyboard.press('ArrowDown')
  await page.keyboard.press(process.platform === 'darwin' ? `${MOD}+ArrowLeft` : 'Home')
}

/** Stub the OS save / open dialogs in the main process (restore with restoreDialogs()). */
async function stubDialogs({ save, open }) {
  await app.evaluate(({ dialog }, cfg) => {
    globalThis.__e2eDialogs ??= { save: dialog.showSaveDialog, open: dialog.showOpenDialog }
    if (cfg.save) dialog.showSaveDialog = async () => ({ canceled: false, filePath: cfg.save })
    if (cfg.open) dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [cfg.open] })
  }, { save, open })
}

async function restoreDialogs() {
  await app.evaluate(({ dialog }) => {
    if (!globalThis.__e2eDialogs) return
    dialog.showSaveDialog = globalThis.__e2eDialogs.save
    dialog.showOpenDialog = globalThis.__e2eDialogs.open
  })
}

async function waitForFile(path, timeout = 10_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (existsSync(path) && statSync(path).size > 0) return readFileSync(path, 'utf8')
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`file was not written: ${path}`)
}

async function confirmIfAsked() {
  const confirm = page.locator('[role=dialog][aria-modal=true] [data-confirm-focus]')
  if (await confirm.count()) await confirm.first().click()
}

/** Click the confirm button of the confirmation dialog that is about to open. */
async function confirmDialog() {
  const confirm = page.locator('[role=dialog][aria-modal=true] [data-confirm-focus]').first()
  await confirm.waitFor()
  await confirm.click()
}

function snapshotTree(root) {
  const out = new Map()
  const skip = new Set(['node_modules', 'vendor', '.git'])
  const walk = (dir) => {
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (!skip.has(e.name)) walk(p)
      } else {
        try {
          const st = statSync(p)
          out.set(p, `${st.size}:${st.mtimeMs}`)
        } catch {
          // vanished
        }
      }
    }
  }
  walk(root)
  return out
}

// =================================================================================================================
// Phase 1 — light theme
// =================================================================================================================
await launch()
console.log('Light theme (default)')

await step('app starts with an isolated profile and shows Get started', async () => {
  await page.locator('[data-testid=get-started]').waitFor({ timeout: 30_000 })
  await page.getByText('Welcome to Tinkerbox').waitFor()
  const title = await page.locator('[data-testid=window-title]').textContent()
  assert(title?.includes('Get started'), `title bar "${title}" mentions Get started`)
  assert((await page.title()) === 'Tinkerbox - Get started', `document.title is "${await page.title()}"`)
  const native = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())
  assert(native === 'Tinkerbox - Get started', `native window title (${native})`)
  const userDataPath = await app.evaluate(({ app: a }) => a.getPath('userData'))
  assert(userDataPath === userData, `isolated user data dir in use (${userDataPath})`)
  await page.waitForTimeout(600)
  await shot('get-started')
})

await step('Get started → "Open the example script" opens and runs', async () => {
  await page.getByRole('button', { name: /Open the example script/ }).click()
  await editorEl().waitFor({ timeout: 30_000 })
  assert((await activeCode())?.includes("$fruits = ['apple', 'banana', 'cherry'];"), 'example code is in the editor')
  const r = await run()
  okRun(r)
  assert((await returnCard().innerText()).includes('"APPLE"'), 'example returns the upper-cased fruits')
  // Word wrap can split a long badge over several view lines (and Monaco's DOM order is not the visual order), so
  // read the badge segments in visual order and ignore whitespace.
  await page.locator('[data-testid=editor-pane] .tw-magic-value').first().waitFor()
  const badge = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid=editor-pane] .tw-magic-value')]
      .map((el) => ({ r: el.getBoundingClientRect(), t: el.textContent ?? '' }))
      .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left)
      .map((s) => s.t)
      .join('')
      .replace(/\s+/g, '')
  )
  assert(/HellofromPHP8\./.test(badge), `example magic comment badge (${badge})`)
})

await step('"+" opens a new code tab with an editor', async () => {
  const before = await store((s) => s('tabs').codeTabs.length)
  await page.getByRole('button', { name: 'New tab', exact: true }).click()
  await until((s, n) => s('tabs').codeTabs.length === n + 1 && s('tabs').activeTab?.code === '', before)
  await editorEl().waitFor()
  await page.locator('[data-testid=output-pane]').waitFor()
})

await step('run with magic comments: return value card, echo "Line N", inline badges, coverage gutter', async () => {
  await setCode(
    [
      "$greeting = 'Hello ' . PHP_VERSION; //?",
      '$total = 0;',
      'foreach ([1, 2, 3] as $n) {',
      '    $total += $n; //? running',
      '}',
      'echo "Total: $total";',
      '$total * 2;'
    ].join('\n')
  )
  const r = await run()
  okRun(r)
  assert(r.hasReturn, 'result has a return value')
  assert((await returnCard().innerText()).includes('12'), 'Return value card shows 12')
  await output().getByText('Total: 6').waitFor()
  assert(await output().getByRole('button', { name: 'Line 6' }).count(), 'echo card has a "Line 6" label')
  await page.locator('[data-testid=editor-pane] .tw-magic-value').first().waitFor()
  const text = await viewLinesText()
  assert(/Hello 8\.\d+/.test(text), `inline badge shows the greeting (${text.slice(0, 160)})`)
  assert(text.includes('running') && text.includes('×3'), 'labelled loop badge shows ×3 hits')
  const coverage = await page.locator('[data-testid=editor-pane] .tw-coverage').count()
  assert(coverage >= 5, `coverage gutter marks executed lines (got ${coverage})`)
  assert(/PHP 8\.\d+/.test(await page.locator('[data-testid=status-php]').innerText()), 'footer shows the PHP version')
  assert(/ms \/ [\d.]+MB/.test(await page.locator('[data-testid=status-timing]').innerText()), 'footer shows time / memory')
  await page.locator('[data-testid=status-timing]').hover()
  await page.getByText(/Started at .*Peak memory/).first().waitFor()
  await page.mouse.move(700, 760)
  await shot('run-magic-coverage')
})

await step('magic comment forms: /*?*/, /*?->method()*/, //?->prop, /*?.*/ timing', async () => {
  await setCode(
    [
      '$list = new ArrayObject([3, 1, 2]); /*?->count()*/',
      "$user = (object) ['name' => 'Ada']; //?->name",
      "$label = strtoupper('magic'); /*?*/ $done = true;",
      'usleep(3000); /*?.*/'
    ].join('\n')
  )
  okRun(await run())
  await page.locator('[data-testid=editor-pane] .tw-magic-time').first().waitFor()
  const values = (await page.locator('[data-testid=editor-pane] .tw-magic-value').allInnerTexts()).map((t) => t.replace(/ /g, ' '))
  assert(values.some((v) => v.trim() === '3'), `->count() badge shows 3 (${values.join(' | ')})`)
  assert(values.some((v) => v.includes('"Ada"')), `->name badge shows "Ada" (${values.join(' | ')})`)
  assert(values.some((v) => v.includes('"MAGIC"')), `inline /*?*/ badge shows "MAGIC" (${values.join(' | ')})`)
  await shot('magic-forms')
})

await step('CLI mode toggle shows PsySH-style output', async () => {
  await setCode(['echo "Total: 6";', '12;'].join('\n'))
  okRun(await run())
  await page.getByRole('button', { name: 'CLI Mode', exact: true }).click()
  await page.locator('[data-testid=cli-output] .view-lines').waitFor()
  await until(() => (document.querySelector('[data-testid=cli-output] .view-lines')?.textContent ?? '').replace(/ /g, ' ').includes('= 12'))
  await shot('cli-mode')
  await page.getByRole('button', { name: 'Cards', exact: true }).click()
  await output().waitFor()
})

await step('exception: Collision view (class, message, snippet, trace) + inline error', async () => {
  await setCode(
    [
      'function divide(int $a, int $b): float',
      '{',
      '    if ($b === 0) {',
      "        throw new InvalidArgumentException('Division by zero is not allowed');",
      '    }',
      '    return $a / $b;',
      '}',
      '',
      'divide(10, 0);'
    ].join('\n')
  )
  const r = await run()
  assert(r.exception === 'InvalidArgumentException', `exception class (${r.exception})`)
  await output().getByText('Division by zero is not allowed').first().waitFor()
  await output().getByText('your code, line 4').first().waitFor()
  await output().getByText('your code, line 9').first().waitFor()
  await output().getByText('Stack trace').waitFor()
  await page.locator('[data-testid=editor-pane] .tw-inline-error').first().waitFor()
  await page.locator('[data-testid=editor-pane] .tw-error-line').first().waitFor()
  await shot('exception-collision')
  // CLI mode: "line 4" is a link (⌘/Ctrl-click) that reveals the editor line.
  await page.getByRole('button', { name: 'CLI Mode', exact: true }).click()
  try {
    const link = page.locator('[data-testid=cli-output] .detected-link', { hasText: /line\s4/ }).first() // NBSPs in Monaco
    await link.waitFor()
    await gotoLine(1)
    await link.click({ modifiers: [MOD] })
    await until(() => document.querySelector('[data-testid=editor-pane] .active-line-number')?.textContent?.trim() === '4')
  } finally {
    await page.getByRole('button', { name: 'Cards', exact: true }).click()
  }
})

await step('Collision can be turned off (Settings → Advanced): compact exception', async () => {
  await updateSettings({ collision: false })
  try {
    await setCode("throw new LogicException('compact please');")
    const r = await run()
    assert(r.exception === 'LogicException', `exception (${r.exception})`)
    await output().getByText('compact please').first().waitFor()
    assert((await output().getByText('Stack trace').count()) === 0, 'no Collision details')
  } finally {
    await updateSettings({ collision: true })
  }
})

await step('leading <?php, missing trailing semicolon and a class declared in the editor', async () => {
  await setCode(
    ['<?php', '', 'class Greeter', '{', '    public function hi(string $name): string', '    {', '        return "Hi {$name}";', '    }', '}', '', "(new Greeter())->hi('Ada')"].join('\n')
  )
  okRun(await run())
  assert((await returnCard().innerText()).includes('"Hi Ada"'), 'return value "Hi Ada"')
})

await step('warnings become diagnostics; dd() ends the script early', async () => {
  await setCode(['$data = [];', "$value = $data['missing'];", 'echo "still running";', "dd('stopped here');", "echo 'never printed';"].join('\n'))
  const r = await run()
  assert(!r.error && !r.exception, `no fatal error (${r.error ?? r.exception ?? ''})`)
  assert(r.exited, 'result is marked as exited')
  await output().getByText(/Undefined array key/).first().waitFor()
  await output().getByText('still running').first().waitFor()
  await output().getByText('"stopped here"').first().waitFor()
  await output().getByText(/The script ended early/).waitFor()
  assert((await output().getByText('never printed').count()) === 0, 'code after dd() did not run')
  await shot('diagnostics-dd')
})

await step('run selected code: only the selection runs, badges land on the editor line', async () => {
  await setCode(['$a = 10;', '$b = 20; //?', '$c = $a + $b; //?'].join('\n'))
  await gotoLine(2)
  await page.keyboard.press('Shift+End')
  const tabId = await activeTabId()
  const before = await lastFinishedAt(tabId)
  await menu('runSelection')
  const r = await waitForRun(tabId, before)
  okRun(r)
  await page.locator('[data-testid=editor-pane] .tw-magic-value').first().waitFor()
  const values = await page.locator('[data-testid=editor-pane] .tw-magic-value').allInnerTexts()
  assert(values.length === 1 && values[0].includes('20'), `only line 2 ran (${values.join(' | ')})`)
  const lineOfBadge = await page.evaluate(() => {
    const badge = document.querySelector('[data-testid=editor-pane] .tw-magic-value')
    const line = badge?.closest('.view-line')
    return line?.textContent?.replace(/ /g, ' ') ?? ''
  })
  assert(lineOfBadge.startsWith('$b = 20;'), `badge is on the "$b" line (${lineOfBadge})`)
})

await step('Run again stops a running script (spinner, Stop, "Execution cancelled.")', async () => {
  await setCode(['echo "started";', 'sleep(20);', "'finished';"].join('\n'))
  const tabId = await activeTabId()
  const before = await lastFinishedAt(tabId)
  await page.locator('[data-testid=run-button]').click()
  await until((s, id) => s('tabs').running[id], tabId)
  await page.locator('[data-testid=run-button][aria-label="Stop running code"]').waitFor()
  await page.locator('[data-testid=output-pane]').getByText(/Running…/).first().waitFor()
  await page.waitForTimeout(600)
  await page.locator('[data-testid=run-button]').click()
  const r = await waitForRun(tabId, before, 15_000)
  assert(r.cancelled, 'run was cancelled')
  await output().getByText('Execution cancelled.').first().waitFor()
})

await step('timeout ends a long run (Settings → Output → timeout)', async () => {
  const original = await settingsValue('timeoutMs')
  await updateSettings({ timeoutMs: 1500 })
  try {
    await setCode(['sleep(10);', "'too late';"].join('\n'))
    const r = await run({ timeout: 20_000 })
    // Either the process timeout fires, or PHP's own max_execution_time (set from the same setting) stops it first.
    const message = await output().innerText()
    assert(r.timedOut || /Maximum execution time of \d+ seconds? exceeded/.test(message), `run was stopped by the timeout (${message.slice(0, 160)})`)
    assert(!r.hasReturn, 'the code after sleep() did not finish')
    await shot('timeout')
  } finally {
    await updateSettings({ timeoutMs: original })
  }
})

await step('strict types setting is applied to the run', async () => {
  await setCode(['function twice(int $n): int', '{', '    return $n * 2;', '}', '', "twice('21');"].join('\n'))
  await updateSettings({ strictTypes: true })
  try {
    const strict = await run()
    assert(strict.exception === 'TypeError', `TypeError with strict_types (${strict.exception})`)
  } finally {
    await updateSettings({ strictTypes: false })
  }
  const loose = await run()
  okRun(loose)
  assert((await returnCard().innerText()).includes('42'), 'coercion without strict types returns 42')
})

await step('realtime output streams while the script runs', async () => {
  await updateSettings({ outputType: 'realtime' })
  try {
    await setCode(['foreach ([1, 2, 3, 4] as $i) {', '    echo "tick $i\\n";', '    usleep(500000);', '}', "'done';"].join('\n'))
    const tabId = await activeTabId()
    const before = await lastFinishedAt(tabId)
    await page.locator('[data-testid=run-button]').click()
    await output().getByText('Receiving output…').waitFor({ timeout: 10_000 })
    await until((s, id) => s('tabs').running[id] && (s('tabs').streamed[id] ?? '').includes('tick 1'), tabId, 10_000)
    await shot('realtime-live')
    const r = await waitForRun(tabId, before)
    okRun(r)
  } finally {
    await updateSettings({ outputType: 'buffered' })
  }
})

await step('auto-evaluate runs the code after typing (native menu toggle)', async () => {
  await menu('toggleAutoRun')
  try {
    await until((s) => s('settings').settings.autoRun === true)
    await page.getByRole('button', { name: /Auto/ }).filter({ hasText: 'Auto' }).first().waitFor()
    const tabId = await activeTabId()
    const before = await lastFinishedAt(tabId)
    await setCode('6 * 7;')
    await waitForRun(tabId, before, 15_000)
    assert((await returnCard().innerText()).includes('42'), 'auto-run result 42')
  } finally {
    await menu('toggleAutoRun')
    await until((s) => s('settings').settings.autoRun === false)
  }
})

await step('editor: ⌘F find closes on ESC, ⌘⌥↓ multi-cursor, minimap setting', async () => {
  await setCode(['$a = 1;', '$b = 2;'].join('\n'))
  await page.keyboard.press(`${MOD}+F`)
  const find = page.locator('[data-testid=editor-pane] .find-widget.visible')
  await find.waitFor()
  await page.keyboard.press('Escape')
  await find.waitFor({ state: 'detached' })
  await gotoLine(1)
  await page.keyboard.press(`${MOD}+Alt+ArrowDown`)
  await page.keyboard.press('End')
  await page.keyboard.type(' //?')
  await until((s) => s('tabs').activeTab?.code === '$a = 1; //?\n$b = 2; //?')
  await updateSettings({ minimap: true })
  try {
    const minimap = page.locator('[data-testid=editor-pane] .minimap').first()
    await minimap.waitFor({ state: 'visible' })
    assert(((await minimap.boundingBox())?.width ?? 0) > 20, 'minimap is shown')
  } finally {
    await updateSettings({ minimap: false })
  }
})

await step('ask before closing a tab with code (setting): Cancel keeps the tab', async () => {
  await updateSettings({ askBeforeClosingTab: true })
  try {
    const n = await store((s) => s('tabs').tabs.length)
    await menu('closeTab')
    const cancel = page.locator(MODAL).getByRole('button', { name: 'Cancel', exact: true })
    await cancel.waitFor()
    await cancel.click()
    await expectNoModal()
    assert((await store((s) => s('tabs').tabs.length)) === n, 'the tab is still open')
  } finally {
    await updateSettings({ askBeforeClosingTab: false })
  }
})

await step('Copy result and Copy as Markdown (clipboard captured in main)', async () => {
  await setCode("['copied' => true, 'count' => 3];")
  okRun(await run())
  await page.locator('[data-testid=output-pane]').getByRole('button', { name: 'Copy result' }).click()
  await page.waitForTimeout(200)
  assert((await lastCopied()).includes('copied'), `copied result (${await lastCopied()})`)
  await cardAction(returnCard(), 'Copy as Markdown')
  await page.waitForTimeout(200)
  assert((await lastCopied()).includes('```'), `copied as Markdown (${await lastCopied()})`)
})

await step('files: open a .php file, save it, watch it (re-runs on change)', async () => {
  const file = join(scratch, 'watched.php')
  writeFileSync(file, "<?php\n\n$who = 'file';\n\"Hello from the {$who}\";\n")
  await stubDialogs({ open: file })
  try {
    await menu('openFile')
    await until((s, f) => s('tabs').activeTab?.filePath === f, file)
  } finally {
    await restoreDialogs()
  }
  assert((await activeCode()).includes('Hello from the'), 'file content is in the editor')
  assert((await page.title()).includes('watched.php'), `title shows the file (${await page.title()})`)
  await setCode("<?php\n\n'saved from the editor';\n")
  await until((s) => s('tabs').activeTab?.dirty === true)
  await menu('saveFile')
  await until((s) => !s('tabs').activeTab?.dirty)
  assert(readFileSync(file, 'utf8').includes('saved from the editor'), 'saved to disk')
  await menu('watchFile')
  await until((s) => s('tabs').watching[s('tabs').activeTabId])
  const tabId = await activeTabId()
  const before = await lastFinishedAt(tabId)
  writeFileSync(file, "<?php\n\n'changed on disk';\n")
  await waitForRun(tabId, before, 20_000)
  assert((await returnCard().innerText()).includes('changed on disk'), 'watch re-ran the changed file')
  await menu('watchFile')
  await until((s) => !s('tabs').watching[s('tabs').activeTabId])
  await menu('closeTab')
  await confirmIfAsked()
})

await step('Open folder (⌘O menu, stubbed folder picker) opens a plain project in the tab', async () => {
  const dir = join(scratch, 'plain-project')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'hello.php'), '<?php echo "hi";\n')
  writeFileSync(
    join(dir, 'helper.php'),
    "<?php\n\nfunction e2e_helper(): string\n{\n    dump('dumped from helper.php');\n\n    return 'helper done';\n}\n"
  )
  await stubDialogs({ open: dir })
  try {
    await menu('openFolder')
    await until((s, p) => {
      const tab = s('tabs').activeTab
      return !!tab && s('connections').path(tab.connectionId) === p
    }, dir)
  } finally {
    await restoreDialogs()
  }
  assert((await page.locator('[data-testid=window-title]').innerText()).includes('plain-project'), 'title shows the project')
  const r = await run()
  okRun(r)
})

await step('dump() from a project file: the file label opens it in the preferred editor; Open Project in Editor', async () => {
  const dir = join(scratch, 'plain-project')
  await setCode(`require ${JSON.stringify(join(dir, 'helper.php'))};\n\ne2e_helper();`)
  okRun(await run())
  const label = output().getByRole('button', { name: /^helper\.php:\d+$/ })
  await label.waitFor()
  await label.click()
  await page.waitForTimeout(300)
  const urls = (await captured()).urls
  assert(urls.some((u) => u.startsWith('vscode://file/') && u.includes('helper.php:5')), `editor link (${urls.join(', ')})`)
  await menu('openProjectInEditor')
  await page.waitForTimeout(300)
  const after = (await captured()).urls
  assert(after.some((u) => u.startsWith('vscode://file/') && u.includes('plain-project') && !u.includes('helper.php')), `project link (${after.join(', ')})`)
})

await step('custom driver (.tinkerbox/drivers): footer version, injected variables, panels, project snippets, bootstrap error', async () => {
  const dir = join(scratch, 'driver-project')
  mkdirSync(join(dir, '.tinkerbox', 'drivers'), { recursive: true })
  mkdirSync(join(dir, '.tinkerbox', 'snippets'), { recursive: true })
  writeFileSync(join(dir, 'e2e.marker'), '')
  writeFileSync(join(dir, '.tinkerbox', 'drivers', 'E2eDriver.php'), DRIVER_PHP)
  writeFileSync(join(dir, '.tinkerbox', 'snippets', 'greeting.php'), SNIPPET_PHP)
  await stubDialogs({ open: dir })
  try {
    await menu('openFolder')
    await until((s, p) => s('connections').path(s('tabs').activeTab?.connectionId ?? null) === p, dir)
  } finally {
    await restoreDialogs()
  }
  await setCode('$greeting;')
  const r = await run()
  okRun(r)
  assert(r.driver === 'E2E Framework 1.2.3', `driver version (${r.driver})`)
  assert((await returnCard().innerText()).includes('"Hello from the E2E driver"'), 'driver variable injected')
  await until(() => document.querySelector('[data-testid=status-framework]')?.textContent?.includes('E2E Framework 1.2.3'))
  await page.locator('[data-testid=status-framework]').click()
  await topModal().getByText('E2E Panel').first().waitFor({ timeout: 30_000 })
  await topModal().getByText('testing').first().waitFor()
  await shot('custom-driver-panels')
  await closeModals()
  await menu('showSnippets')
  await topModal().getByText('E2E project snippet').first().click()
  await topModal().getByText(/Defined in project snippets/).first().waitFor()
  await closeModals()
  writeFileSync(join(dir, 'broken.marker'), '')
  try {
    const broken = await run()
    assert(broken.exception, 'bootstrap failure is reported as an exception')
    await output().getByText('Bootstrap failed').waitFor()
    await output().getByText('The E2E framework refused to boot').first().waitFor()
    await shot('bootstrap-failed')
  } finally {
    rmSync(join(dir, 'broken.marker'))
  }
})

await step('log viewer (custom driver project): generic log file, polling picks up new entries, open folder', async () => {
  const logDir = join(scratch, 'driver-project', 'storage', 'logs')
  mkdirSync(logDir, { recursive: true })
  const line = (msg) => `[2026-10-08 10:00:00] local.ERROR: ${msg} {"user":42}\n`
  writeFileSync(join(logDir, 'app.log'), line('first e2e error'))
  await menu('showLogs')
  await page.locator('[data-testid=logs-modal]').waitFor()
  await page.getByText('first e2e error').first().waitFor({ timeout: 20_000 })
  const polling = page.locator('select[aria-label="Polling interval"]')
  await polling.selectOption('2000')
  try {
    appendFileSync(join(logDir, 'app.log'), line('second e2e error'))
    await page.getByText('second e2e error').first().waitFor({ timeout: 10_000 })
  } finally {
    await polling.selectOption('0')
  }
  await page.getByRole('button', { name: /^Open log folder/ }).click()
  await page.waitForTimeout(300)
  const urls = (await captured()).urls
  assert(urls.some((u) => u.startsWith('reveal:') && u.includes('driver-project')), `log folder revealed (${urls.join(', ')})`)
  await closeModals()
  await expectNoModal()
})

// -----------------------------------------------------------------------------------------------------------------
// Laravel project (read-only)
// -----------------------------------------------------------------------------------------------------------------
await step(
  'open the Laravel project (connections:openLocal + Open Anything "/") → footer shows Laravel + PHP',
  async () => {
    await page.evaluate((dir) => window.tinkerbox.invoke('connections:openLocal', dir), LARAVEL)
    await menu('commandPalette')
    const input = page.locator('[data-testid=palette-input]')
    await input.waitFor()
    await input.fill('/' + LARAVEL_NAME)
    await page.locator('[role=option][data-selected=true]', { hasText: LARAVEL_NAME }).waitFor()
    await page.keyboard.press('Enter')
    await expectNoModal()
    await until(() => document.querySelector('[data-testid=status-framework]')?.textContent?.includes('Laravel'), null, 60_000)
    const framework = await page.locator('[data-testid=status-framework]').innerText()
    assert(/Laravel \d+\./.test(framework), `footer framework label (${framework})`)
    assert(/PHP 8\.\d+/.test(await page.locator('[data-testid=status-php]').innerText()), 'footer PHP label')
    assert((await page.title()) === `Tinkerbox - ${LARAVEL_NAME}`, `window title (${await page.title()})`)
    if (process.platform === 'darwin') {
      await page.waitForTimeout(300) // menus are rebuilt (debounced) after connections change
      const dock = await app.evaluate(({ app: a }) => a.dock?.getMenu()?.items.map((i) => i.label) ?? [])
      assert(dock.includes(LARAVEL_NAME), `dock menu lists the recent folder (${dock.join(', ')})`)
    }
  },
  { needsLaravel: true }
)

await step(
  'run app()->version() in the Laravel project',
  async () => {
    await setCode('app()->version();')
    const r = await run()
    okRun(r)
    assert(/^Laravel \d+\./.test(r.driver ?? ''), `driver label (${r.driver})`)
    assert(/"\d+\.\d+\.\d+"/.test(await returnCard().innerText()), 'return value is the Laravel version')
    await shot('laravel-version')
    // Every run is a fresh PHP process with a freshly booted framework.
    await setCode("app()->instance('e2e.flag', true);\ngetmypid();")
    okRun(await run())
    const firstPid = (await returnCard().innerText()).match(/\d+/)?.[0]
    await setCode("[getmypid(), app()->bound('e2e.flag')];")
    okRun(await run())
    const second = await returnCard().innerText()
    assert(firstPid && !second.includes(firstPid), `a new PHP process per run (${firstPid} vs ${second})`)
    assert(/false/.test(second), 'the framework is booted again (no state from the previous run)')
  },
  { needsLaravel: true }
)

await step(
  'Default Working Directory: new tabs start in that project',
  async () => {
    const before = await store((s) => s('tabs').tabs.length)
    await updateSettings({ defaultWorkingDirectory: LARAVEL })
    try {
      await page.getByRole('button', { name: 'New tab', exact: true }).click()
      await until((s, p) => {
        const t = s('tabs').activeTab
        return t?.kind === 'code' && t.connectionId === null && s('connections').path(null) === p
      }, LARAVEL)
      // Footer + autocompletion data follow the new default right away (no run needed).
      await until(() => document.querySelector('[data-testid=status-framework]')?.textContent?.includes('Laravel'), null, 60_000)
      assert((await page.title()) === `Tinkerbox - ${LARAVEL_NAME}`, `title (${await page.title()})`)
    } finally {
      if ((await store((s) => s('tabs').tabs.length)) > before) {
        await menu('closeTab')
        await confirmIfAsked()
      }
      await updateSettings({ defaultWorkingDirectory: '' })
      await page.locator('[role=tab]', { hasText: LARAVEL_NAME }).first().click()
    }
  },
  { needsLaravel: true }
)

await step(
  'SQL toggle: runtime in-memory sqlite queries become query cards (bindings substituted)',
  async () => {
    const sql = page.getByRole('button', { name: 'SQL', exact: true })
    await sql.click()
    assert((await sql.getAttribute('aria-pressed')) === 'true', 'SQL toggle is pressed')
    await setCode(
      [
        "config(['database.connections.e2e_memory' => ['driver' => 'sqlite', 'database' => ':memory:', 'prefix' => '']]);",
        "$db = DB::connection('e2e_memory');",
        "$db->statement('create table fruits (id integer primary key, name text, color text)');",
        "$db->table('fruits')->insert([['name' => 'Apple', 'color' => 'red'], ['name' => 'Banana', 'color' => 'yellow']]);",
        "$db->table('fruits')->where('color', 'red')->get();"
      ].join('\n')
    )
    okRun(await run())
    await output().getByText('3 queries').waitFor()
    const cards = output().locator('section', { hasText: 'e2e_memory' })
    assert((await cards.count()) >= 3, `three query cards (got ${await cards.count()})`)
    const selectCard = await cards.last().innerText()
    assert(/SELECT/.test(selectCard) && selectCard.includes("'red'"), `select query with the binding substituted (${selectCard})`)
    assert((await cards.first().innerText()).includes('fruits (id integer'), 'CREATE TABLE keeps "fruits (id"')
    await shot('sql-queries')
    await sql.click()
  },
  { needsLaravel: true }
)

await step(
  'special dumps: Carbon, closure and an Eloquent model',
  async () => {
    await setCode(
      [
        'dump(now());',
        'dump(fn (int $x) => $x * 2);',
        "$user = new App\\Models\\User(['name' => 'Ada Lovelace', 'email' => 'ada@example.com']);",
        "$user->setRelation('friends', collect([new App\\Models\\User(['name' => 'Grace Hopper'])]));",
        '$user;'
      ].join('\n')
    )
    okRun(await run())
    await output().getByText(/Carbon/).first().waitFor()
    await output().getByText(/Closure/).first().waitFor()
    const model = await returnCard().innerText()
    assert(model.includes('App\\Models\\User') && model.includes('Ada Lovelace'), `model card (${model.slice(0, 200)})`)
    assert(/relations/.test(model) && model.includes('friends'), `model relations are shown (${model.slice(0, 300)})`)
    await shot('special-dumps')
    await setCode(
      [
        "enum E2eSuit: string { case Hearts = 'H'; case Spades = 'S'; }",
        'dump(E2eSuit::Hearts);',
        "dump(User::query()->where('name', 'Ada'));",
        'get_class(new User());'
      ].join('\n')
    )
    okRun(await run())
    await output().getByText(/E2eSuit/).first().waitFor()
    await output().getByText(/Hearts/).first().waitFor()
    await output().getByText(/select \* from .users. where .name. = /i).first().waitFor()
    assert((await returnCard().innerText()).includes('"App\\Models\\User"'), 'User resolves to App\\Models\\User without an import (Tinker-style alias)')
  },
  { needsLaravel: true }
)

await step(
  'Collision folds vendor frames of a framework exception',
  async () => {
    await setCode(['collect([1, 2])->map(function (int $x) {', '    throw new RuntimeException("boom $x");', '});'].join('\n'))
    const r = await run()
    assert(r.exception === 'RuntimeException', `exception (${r.exception})`)
    const fold = output().getByRole('button', { name: /\d+ vendor frames?/ }).first()
    await fold.waitFor()
    await fold.click()
    await output().getByText(/vendor\/laravel\/framework/).first().waitFor()
    await shot('exception-vendor-frames')
  },
  { needsLaravel: true }
)

await step(
  'Table Preview: entries, search, row context menu, Export CSV (stubbed save dialog)',
  async () => {
    await setCode(
      [
        'collect([',
        "    ['id' => 1, 'name' => 'Ada Lovelace', 'role' => 'admin'],",
        "    ['id' => 2, 'name' => 'Linus Torvalds', 'role' => 'editor'],",
        "    ['id' => 3, 'name' => 'Grace Hopper', 'role' => 'viewer'],",
        ']);'
      ].join('\n')
    )
    okRun(await run())
    await cardAction(returnCard(), 'Table Preview')
    const modal = topModal()
    await modal.getByText('3 entries').waitFor()
    await modal.getByText('Grace Hopper').click({ button: 'right' })
    for (const label of ['Copy as PHP array', 'Copy as JSON', 'Copy as CSV']) await page.getByRole('menuitem', { name: label }).or(page.getByText(label, { exact: true })).first().waitFor()
    await page.getByText('Copy as JSON', { exact: true }).first().click()
    await page.waitForTimeout(200)
    assert(/"name":\s*"Grace Hopper"/.test(await lastCopied()), `row copied as JSON (${(await lastCopied()).slice(0, 120)})`)
    await modal.getByText('Grace Hopper').click({ button: 'right' })
    await page.getByText('Copy as PHP array', { exact: true }).first().click()
    await page.waitForTimeout(200)
    assert(/'name' => 'Grace Hopper'/.test(await lastCopied()), `row copied as a PHP array (${(await lastCopied()).slice(0, 120)})`)
    const csv = join(scratch, 'table.csv')
    await stubDialogs({ save: csv })
    try {
      await modal.getByRole('button', { name: 'Export' }).click()
      const content = await waitForFile(csv)
      assert(/id,name,role/.test(content) && content.includes('Grace Hopper'), `CSV export (${content.slice(0, 120)})`)
    } finally {
      await restoreDialogs()
    }
    await modal.getByPlaceholder('Search...').fill('grace')
    await modal.getByText('1 of 3 entries').waitFor()
    await shot('table-preview')
    await closeModals()
    await expectNoModal()
  },
  { needsLaravel: true }
)

await step(
  'Object Graph: nodes with counts, click collapses a box',
  async () => {
    await cardAction(returnCard(), 'Object Graph')
    const svg = topModal().locator('svg[role=img]')
    await svg.waitFor()
    const label = await svg.getAttribute('aria-label')
    const nodes = Number(/Object graph with (\d+) nodes/.exec(label ?? '')?.[1] ?? 0)
    assert(nodes >= 4, `graph has the collection and its rows (${label})`)
    await topModal().locator('svg text', { hasText: '0 (3)' }).first().waitFor()
    await page.waitForTimeout(300)
    await shot('object-graph')
    await topModal().locator('svg text', { hasText: /^Collection$/ }).first().click()
    await topModal().locator('svg text', { hasText: '0 (3)' }).first().waitFor({ state: 'detached' })
    await closeModals()
    await expectNoModal()
  },
  { needsLaravel: true }
)

await step(
  'HTML Preview of an Illuminate\\Support\\HtmlString; Run again refreshes it',
  async () => {
    await setCode("new Illuminate\\Support\\HtmlString('<h1 style=\"font-family: sans-serif\">Hello from Tinkerbox</h1><p>Rendered <strong>HTML</strong> preview.</p>');")
    okRun(await run())
    await cardAction(returnCard(), 'HTML Preview')
    const frame = page.frameLocator('iframe[title="HTML preview"]')
    await frame.getByText('Hello from Tinkerbox').waitFor()
    await shot('html-preview')
    const tabId = await activeTabId()
    const before = await lastFinishedAt(tabId)
    await menu('run') // ⌘R while the preview is open
    await waitForRun(tabId, before)
    await frame.getByText('Hello from Tinkerbox').waitFor()
    await closeModals()
    await expectNoModal()
  },
  { needsLaravel: true }
)

await step(
  'autocompletion: Str:: members (methods first), functions and local variables',
  async () => {
    await until((s) => s('environment').statusOf(s('tabs').activeTab.connectionId) === 'ready', null, 60_000)
    const widget = page.locator('[data-testid=editor-pane] .suggest-widget.visible')
    await setCode('')
    await page.keyboard.type('Str::', { delay: 40 })
    await widget.locator('.monaco-list-row').first().waitFor({ timeout: 10_000 })
    const first = await widget.locator('.monaco-list-row').first().innerText()
    assert(/^after\b/.test(first.trim()), `first Str:: suggestion is a method (${first})`)
    await shot('autocomplete')
    await page.keyboard.press('Escape')
    await setCode('$fruitBasket = 1;\n')
    await page.keyboard.press(`${MOD}+ArrowDown`)
    await page.keyboard.type('$fruitB', { delay: 40 })
    await widget.locator('.monaco-list-row', { hasText: '$fruitBasket' }).first().waitFor({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await setCode('')
    await page.keyboard.type('array_key_f', { delay: 40 })
    await widget.locator('.monaco-list-row', { hasText: 'array_key_first' }).first().waitFor({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await setCode('')
    await page.keyboard.type('DatabaseSee', { delay: 40 }) // a project class (database/seeders) of any Laravel app
    await widget.locator('.monaco-list-row', { hasText: 'DatabaseSeeder' }).first().waitFor({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await setCode('')
    await page.keyboard.type('User::wh', { delay: 40 })
    await widget.locator('.monaco-list-row', { hasText: /^where/ }).first().waitFor({ timeout: 10_000 })
    await page.keyboard.press('Escape')
  },
  { needsLaravel: true }
)

await step(
  'hover docs and signature help',
  async () => {
    await setCode('')
    await page.keyboard.type('str_contains(', { delay: 40 })
    const hints = page.locator('[data-testid=editor-pane] .parameter-hints-widget.visible')
    await hints.waitFor({ timeout: 10_000 })
    assert((await hints.innerText()).includes('haystack'), 'signature help shows the parameters')
    await page.keyboard.press('Escape')
    await setCode("str_contains('abc', 'b');")
    await page.locator('[data-testid=editor-pane] .view-lines span', { hasText: /^str_contains$/ }).first().hover()
    const hover = page.locator('.monaco-hover:not(.hidden)')
    await hover.filter({ hasText: 'str_contains' }).first().waitFor({ timeout: 10_000 })
    await page.mouse.move(700, 760)
  },
  { needsLaravel: true }
)

await step(
  'import-class quick fix (⌘.) adds a use statement',
  async () => {
    await setCode("new HtmlString('<b>x</b>');")
    await page.locator('[data-testid=editor-pane] .view-lines span', { hasText: /^HtmlString$/ }).first().click()
    await page.keyboard.press(`${MOD}+Period`)
    const item = page.locator('.action-widget, .context-view').getByText(/Import .*HtmlString/).first()
    await item.waitFor({ timeout: 10_000 })
    await item.click()
    await until((s) => (s('tabs').activeTab?.code ?? '').includes('use Illuminate\\Support\\HtmlString;'))
  },
  { needsLaravel: true }
)

await step('prettify reformats the code (native menu command)', async () => {
  await setCode("$items=['b'=>2,'a'=>1];foreach($items as $key=>$value){echo $key.'='.$value;}")
  await menu('prettify')
  await until((s) => (s('tabs').activeTab?.code ?? '').includes('foreach ($items as $key => $value) {'))
  const code = await activeCode()
  assert(code.includes("$items = ['b' => 2, 'a' => 1];"), `prettified array (${code})`)
  await shot('prettify')
})

await step('editor: context menu actions, double-click selects $variable, zoom', async () => {
  await setCode(['$total = 1;', '$total + 1;'].join('\n'))
  await gotoLine(2)
  await page.keyboard.press('Shift+End')
  const selectionText = page.locator('[data-testid=editor-pane] .view-lines span', { hasText: /^\$total$/ }).nth(1)
  await selectionText.click({ button: 'right' })
  const menuEl = page.locator('.monaco-menu')
  await menuEl.waitFor()
  const items = await menuEl.innerText()
  for (const label of ['Run Selected Code', 'Add Selected Code to Snippets', 'Add Magic Comment at End of Line', 'Add Code to Snippets', 'Prettify Code', 'Import Class']) {
    assert(items.includes(label), `context menu has "${label}"`)
  }
  const menuBg = await menuEl.evaluate((el) => getComputedStyle(el.closest('.monaco-scrollable-element') ?? el).backgroundColor)
  assert(menuBg !== 'rgba(0, 0, 0, 0)', `context menu has a background (${menuBg})`)
  await shot('editor-context-menu')
  await page.keyboard.press('Escape')
  await page.locator('[data-testid=editor-pane] .view-lines span', { hasText: /^\$total$/ }).nth(1).dblclick()
  await page.keyboard.type('$sum')
  await until((s) => s('tabs').activeTab?.code === '$total = 1;\n$sum + 1;')
  const size = await settingsValue('editorFontSize')
  const lineHeight = () => page.evaluate(() => document.querySelector('[data-testid=editor-pane] .view-line')?.getBoundingClientRect().height ?? 0)
  const before = await lineHeight()
  await menu('zoomIn')
  await until((s, n) => s('settings').settings.editorFontSize > n, size)
  await page.waitForTimeout(300)
  assert((await lineHeight()) > before, 'editor lines grow after zooming in')
  await menu('resetZoom')
  await until((s, n) => s('settings').settings.editorFontSize === n, size)
})

await step('Vim keymap (Settings → Advanced) shows its mode in the footer', async () => {
  await menu('openSettings')
  const modal = topModal()
  await modal.locator('[data-page=advanced]').click()
  const row = modal.locator('div.px-4.py-3', { has: page.getByText('Vim keymap', { exact: true }) })
  await row.getByRole('switch').click()
  await until((s) => s('settings').settings.vimMode === true)
  await closeModals()
  await editorEl().click({ position: { x: 200, y: 40 } })
  const status = page.locator('[data-testid=vim-status]')
  await until(() => /NORMAL/i.test(document.querySelector('[data-testid=vim-status]')?.textContent ?? ''), null, 10_000)
  await page.keyboard.press('i')
  await until(() => /INSERT/i.test(document.querySelector('[data-testid=vim-status]')?.textContent ?? ''), null, 5000)
  await shot('vim')
  await page.keyboard.press('Escape')
  assert(await status.isVisible(), 'vim status is visible')
  await updateSettings({ vimMode: false })
})

await step('output toolbar: Save output (stubbed dialog) and Clear output', async () => {
  await setCode(['echo "saved line";', "['saved' => true];"].join('\n'))
  okRun(await run())
  const file = join(scratch, 'output.txt')
  await stubDialogs({ save: file })
  try {
    await page.locator('[data-testid=output-pane]').getByRole('button', { name: 'Save output…' }).click()
    const content = await waitForFile(file)
    assert(content.includes('saved line') && content.includes('saved'), `saved output (${content.slice(0, 120)})`)
  } finally {
    await restoreDialogs()
  }
  await page.locator('[data-testid=output-pane]').getByRole('button', { name: 'Clear output' }).click()
  await output().getByText('Nothing to show yet').waitFor()
  await until(() => document.querySelectorAll('[data-testid=editor-pane] .tw-coverage').length === 0, null, 3000)
})

await step('Snippets: save the current code, open, insert; Open Anything "#" finds it', async () => {
  const code = "return 'snippet from the e2e test';"
  await setCode(code)
  await menu('addToSnippets')
  let modal = topModal()
  await modal.getByPlaceholder('e.g. Latest users').fill('E2E snippet')
  await modal.locator('[data-testid=snippet-save]').click()
  await expectNoModal()
  await setCode('// replaced')
  await menu('showSnippets')
  modal = topModal()
  await modal.getByText('E2E snippet').first().click()
  await shot('snippets')
  await modal.locator('[data-testid=snippet-open]').click()
  await expectNoModal()
  await until((s, c) => s('tabs').activeTab?.code === c, code)
  await setCode('// before\n')
  await page.keyboard.press(`${MOD}+ArrowDown`)
  await menu('showSnippets')
  await topModal().getByText('E2E snippet').first().click()
  await topModal().locator('[data-testid=snippet-insert]').click()
  await expectNoModal()
  await until((s, c) => (s('tabs').activeTab?.code ?? '').includes(c) && s('tabs').activeTab.code.startsWith('// before'), code)
  await menu('commandPalette')
  await page.locator('[data-testid=palette-input]').fill('#E2E')
  await page.locator('[role=option]', { hasText: 'E2E snippet' }).first().waitFor()
  await closeModals()
})

await step('Open Anything: groups, ">" commands, fuzzy match', async () => {
  await menu('commandPalette')
  const input = page.locator('[data-testid=palette-input]')
  await input.waitFor()
  const groups = await page.locator('#palette-results section[data-group]').evaluateAll((els) => els.map((e) => e.getAttribute('data-group')))
  assert(groups.length >= 2, `palette groups (${groups.join(', ')})`)
  await shot('open-anything')
  await input.fill('>tgl hist')
  await page.locator('[role=option]', { hasText: 'Toggle History' }).first().waitFor()
  await closeModals()
  await expectNoModal()
})

await step('History: grouped by day, search, Enter opens the entry', async () => {
  await menu('showHistory')
  const modal = topModal()
  await modal.getByText('TODAY').first().waitFor()
  const text = await modal.innerText()
  assert(text.includes('function divide'), 'history contains the exception run')
  if (HAS_LARAVEL) assert(text.includes('app()->version()'), 'history contains the Laravel run')
  await shot('history')
  await modal.getByPlaceholder(/Search code/).fill('Greeter')
  await page.waitForTimeout(200)
  await page.keyboard.press('Enter')
  await expectNoModal()
  await until((s) => (s('tabs').activeTab?.code ?? '').includes('class Greeter'))
})

await step('History: project filter, ⌘Enter opens in a new tab, Delete removes an entry', async () => {
  await menu('showHistory')
  let modal = topModal()
  await modal.getByText('TODAY').first().waitFor()
  if (HAS_LARAVEL) {
    const id = await store((s, p) => s('connections').findByPath(p)?.id ?? null, LARAVEL)
    await modal.getByRole('combobox', { name: 'Filter by project' }).or(modal.locator('select')).first().selectOption(id)
    await page.waitForTimeout(200)
    const text = await modal.innerText()
    assert(!text.includes('function divide') && text.includes('app()->version()'), 'the project filter shows only that project')
    await modal.locator('select').first().selectOption({ index: 0 })
  }
  const tabsBefore = await store((s) => s('tabs').tabs.length)
  await modal.getByPlaceholder(/Search code/).fill('Greeter')
  await page.waitForTimeout(200)
  await page.keyboard.press(`${MOD}+Enter`)
  await expectNoModal()
  await until((s, n) => s('tabs').tabs.length === n + 1 && (s('tabs').activeTab?.code ?? '').includes('class Greeter'), tabsBefore)
  const count = await store((s) => s('history').entries.length)
  await menu('showHistory')
  modal = topModal()
  await modal.getByText('TODAY').first().waitFor()
  await modal.locator('[data-testid=history-delete]').click()
  await until((s, n) => s('history').entries.length === n - 1, count)
  await closeModals()
  await menu('closeTab')
  await confirmIfAsked()
})

await step('Snippets: export, delete and import again (stubbed file dialogs)', async () => {
  const file = join(scratch, 'snippets-export.json')
  await menu('showSnippets')
  let modal = topModal()
  await modal.getByText('E2E snippet').first().waitFor()
  await stubDialogs({ save: file })
  try {
    await modal.getByRole('button', { name: 'Export', exact: true }).click()
    const exported = await waitForFile(file)
    assert(exported.includes('E2E snippet'), 'export contains the snippet')
  } finally {
    await restoreDialogs()
  }
  await modal.getByText('E2E snippet').first().click()
  await modal.locator('[data-testid=snippet-delete]').click()
  await confirmDialog()
  await until((s) => !s('snippets').snippets.some((x) => x.name === 'E2E snippet'))
  await stubDialogs({ open: file })
  try {
    await topModal().getByRole('button', { name: 'Import', exact: true }).click()
    await until((s) => s('snippets').snippets.some((x) => x.name === 'E2E snippet'))
  } finally {
    await restoreDialogs()
  }
  await closeModals()
})

await step('Settings: every page renders', async () => {
  await menu('openSettings')
  const modal = topModal()
  for (const id of ['general', 'appearance', 'behaviour', 'output', 'shortcuts', 'advanced', 'updates', 'about']) {
    await modal.locator(`[data-page=${id}]`).click()
    const h1 = (await modal.locator('[data-testid=settings-pane] h1').innerText()).toLowerCase()
    assert(h1 === id, `settings page heading ${h1} = ${id}`)
    if (id === 'general') await modal.getByText(/Using automatic detection — currently PHP 8\./).waitFor()
    if (id === 'general' || id === 'shortcuts' || id === 'about') await shot(`settings-${id}`)
  }
  await modal.locator('[data-testid=about-version]').waitFor()
  await closeModals()
})

await step('Shortcuts: capture a new shortcut; the native menu updates', async () => {
  await menu('openSettings')
  const modal = topModal()
  await modal.locator('[data-page=shortcuts]').click()
  await modal.locator('[data-testid=shortcut-search]').locator('input').fill('debugging')
  const capture = modal.locator('[data-testid=shortcut-capture]').first()
  await capture.click()
  await page.keyboard.press(`${MOD}+Shift+K`)
  await until((s) => !!s('settings').settings.shortcuts?.toggleDebugging)
  const stored = await store((s) => s('settings').settings.shortcuts.toggleDebugging)
  assert(/Shift\+K$/.test(stored), `stored accelerator (${stored})`)
  await page.waitForTimeout(300)
  const accel = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('command:toggleDebugging')?.accelerator ?? '')
  assert(accel === stored, `menu accelerator updated (${accel})`)
  await closeModals()
})

await step(
  'Log viewer: entries, expand, search',
  async () => {
    await openLaravelHere() // History's Enter switched the tab to the entry's project
    await menu('showLogs')
    await page.locator('[data-testid=logs-modal]').waitFor()
    await page.locator('[data-testid=logs-loading]').waitFor({ state: 'detached', timeout: 20_000 }).catch(() => undefined)
    const rows = page.locator('[data-testid=logs-entries] [role=button][aria-expanded]')
    const hasEntries = await rows.first().waitFor({ timeout: 8_000 }).then(() => true, () => false)
    if (!hasEntries) throw new SkipStep('the Laravel project has no log entries in storage/logs')
    const count = await page.locator('[data-testid=logs-count]').innerText()
    assert(/\d+ entr/.test(count), `entry count (${count})`)
    await rows.first().click()
    assert((await rows.first().getAttribute('aria-expanded')) === 'true', 'entry expands')
    await shot('logs')
    await page.locator('[data-testid=logs-modal] button[aria-haspopup=true]', { hasText: 'All Levels' }).click()
    const error = page.getByRole('menuitemcheckbox', { name: /^Error/ })
    await error.click()
    await until(() => document.querySelector('[role=menuitemcheckbox][aria-checked=true]')?.textContent?.includes('Error'))
    await page.getByRole('menuitemcheckbox', { name: /^All Levels/ }).click()
    await page.keyboard.press('Escape') // closes the level popover only, not the Logs modal
    await page.getByRole('menu', { name: 'Levels' }).waitFor({ state: 'hidden' })
    assert(await page.locator('[data-testid=logs-modal]').isVisible(), 'ESC on the popover keeps the Logs modal open')
    const search = page.locator('[data-testid=logs-modal] input').last()
    // Search for a word from the first entry, so the step works with any project's logs.
    const firstText = await rows.first().innerText()
    const term = (firstText.match(/[A-Za-z]{5,}/g) ?? ['error']).slice(-1)[0]
    await search.fill(term)
    await until(() => / of \d+/.test(document.querySelector('[data-testid=logs-count]')?.textContent ?? ''))
    await closeModals()
    await closeModals()
    await expectNoModal()
  },
  { needsLaravel: true }
)

await step(
  'Panels modal (footer framework label)',
  async () => {
    await page.locator('[data-testid=status-framework]').click()
    const version = page.locator('[data-testid=panels-version]')
    await version.waitFor({ timeout: 30_000 })
    assert(/Laravel \d+\./.test(await version.innerText()), 'panels header shows the Laravel version')
    await topModal().getByText('App Information').first().waitFor({ timeout: 30_000 })
    await topModal().getByText('Laravel Version').first().waitFor()
    await shot('panels')
    await closeModals()
    await expectNoModal()
  },
  { needsLaravel: true }
)

await step('PHP settings (footer PHP label): per-project PHP binary (Herd alias), then reset to the global default', async () => {
  await page.locator('[data-testid=status-php]').click()
  const modal = topModal()
  await page.locator('[data-testid=php-detected]').waitFor()
  await until(() => /PHP 8\.\d+/.test(document.querySelector('[data-testid=php-detected]')?.textContent ?? ''), null, 20_000)
  await shot('php-settings')
  // A newer PHP than the default keeps Composer's platform check of the project happy.
  const alias = (await modal.getByText('php84', { exact: true }).count()) ? 'php84' : null
  if (!alias) {
    await closeModals()
    return // no Herd php84 on this machine: only the modal was verified
  }
  try {
    await modal.getByPlaceholder(/Global default/).fill(alias)
    await modal.getByRole('button', { name: 'Change', exact: true }).click()
    await until((s, a) => {
      const tab = s('tabs').activeTab
      return s('connections').resolve(tab.connectionId)?.phpBinary === a
    }, alias)
    await closeModals()
    await setCode('PHP_VERSION;')
    const r = await run()
    okRun(r)
    assert(/^8\.4\./.test(r.php ?? ''), `the project runs on PHP 8.4 (${r.php})`)
    await until(() => /PHP 8\.4\./.test(document.querySelector('[data-testid=status-php]')?.textContent ?? ''))
  } finally {
    await closeModals()
    await page.locator('[data-testid=status-php]').click()
    await topModal().getByRole('button', { name: /Reset PHP to global default/ }).click()
    await until((s) => !s('connections').resolve(s('tabs').activeTab.connectionId)?.phpBinary)
    await closeModals()
  }
  const back = await run()
  assert(!/^8\.4\./.test(back.php ?? ''), `back on the global PHP (${back.php})`)
})

await step('Year in Review (Wrapped)', async () => {
  await menu('showWrapped')
  const modal = page.locator('[data-testid=wrapped-modal]')
  await modal.waitFor()
  const dots = modal.getByRole('tab', { name: /^Slide \d+ of \d+$/ })
  await dots.first().waitFor({ timeout: 15_000 })
  await shot('wrapped')
  await dots.last().click()
  await page.locator('[data-testid=wrapped-persona]').waitFor()
  await shot('wrapped-persona')
  await closeModals()
  await expectNoModal()
})

await step('tabs: duplicate, rename, close, reopen, next tab, context menu', async () => {
  const count = () => store((s) => s('tabs').tabs.length)
  const n = await count()
  const code = await activeCode()
  await menu('duplicateTab')
  await until((s, x) => s('tabs').tabs.length === x + 1, n)
  assert((await activeCode()) === code, 'duplicate has the same code')
  await page.locator('[role=tab][aria-selected=true]').dblclick()
  const input = page.locator('[role=tab][aria-selected=true] input')
  await input.waitFor()
  await input.fill('Renamed tab')
  await page.keyboard.press('Enter')
  await until(() => document.title === 'Tinkerbox - Renamed tab')
  await page.waitForTimeout(150) // window:setTitle is debounced
  const nativeAfter = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())
  assert(nativeAfter === 'Tinkerbox - Renamed tab', `native window title (${nativeAfter})`)
  await menu('closeTab')
  await confirmIfAsked()
  await until((s, x) => s('tabs').tabs.length === x, n)
  await menu('reopenClosedTab')
  await until((s, x) => s('tabs').tabs.length === x + 1, n)
  const before = await activeTabId()
  await menu('nextTab')
  await until((s, id) => s('tabs').activeTabId !== id, before)
  await page.locator('[role=tab]').first().click({ button: 'right' })
  for (const label of ['Close Others', 'Close to the Right', 'Close All', 'Duplicate Tab', 'Rename Tab…']) await page.getByText(label, { exact: true }).first().waitFor()
  await page.keyboard.press('Escape')
  await page.locator('[role=tab]', { hasText: 'Renamed tab' }).click()
  await menu('closeTab')
  await confirmIfAsked()
  await until((s, x) => s('tabs').tabs.length === x, n)
  // ⌘T opens a tab, a middle click closes it.
  await menu('newTab')
  await until((s, x) => s('tabs').tabs.length === x + 1, n)
  await page.locator('[role=tab][aria-selected=true]').click({ button: 'middle' })
  await until((s, x) => s('tabs').tabs.length === x, n)
  // Output mode is per tab.
  const [a, b] = await store((s) => s('tabs').codeTabs.map((t) => t.id))
  await page.locator(`[role=tab][data-tab-id="${a}"]`).click()
  await page.getByRole('button', { name: 'CLI Mode', exact: true }).click()
  await page.locator(`[role=tab][data-tab-id="${b}"]`).click()
  await output().waitFor()
  assert((await store((s, ids) => [s('tabs').byId(ids[0]).outputMode, s('tabs').byId(ids[1]).outputMode], [a, b])).join() === 'cli,detail', 'output mode is per tab')
  await page.locator(`[role=tab][data-tab-id="${a}"]`).click()
  await page.getByRole('button', { name: 'Cards', exact: true }).click()
})

await step('layout: Ctrl+. flips the split, toggle output, zen mode', async () => {
  const box = async (sel) => page.locator(sel).boundingBox()
  const e1 = await box('[data-testid=editor-pane]')
  const o1 = await box('[data-testid=output-pane]')
  assert(o1.x > e1.x + 100, 'output is on the right by default')
  await menu('toggleLayout')
  await until((s) => s('settings').settings.layout === 'horizontal')
  await page.waitForTimeout(200)
  const e2 = await box('[data-testid=editor-pane]')
  const o2 = await box('[data-testid=output-pane]')
  assert(o2.y > e2.y + 100, 'output is below after toggling the layout')
  await shot('layout-horizontal')
  await menu('toggleLayout')
  await until((s) => s('settings').settings.layout === 'vertical')
  await menu('toggleOutput')
  await page.locator('[data-testid=output-pane]').waitFor({ state: 'hidden' })
  await menu('toggleOutput')
  await page.locator('[data-testid=output-pane]').waitFor({ state: 'visible' })
  await menu('zenMode')
  await page.locator('[data-zen]').waitFor()
  assert((await page.locator('nav[aria-label=Toolbar]').count()) === 0, 'zen hides the sidebar')
  await menu('zenMode')
  await page.locator('nav[aria-label=Toolbar]').waitFor()
  await menu('toggleToolbar')
  await page.locator('nav[aria-label=Toolbar]').waitFor({ state: 'detached' })
  await menu('toggleToolbar')
  await page.locator('nav[aria-label=Toolbar]').waitFor()
  // Footer chevron.
  await page.getByRole('button', { name: 'Hide output', exact: true }).click()
  await page.locator('[data-testid=output-pane]').waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Show output', exact: true }).click()
  await page.locator('[data-testid=output-pane]').waitFor({ state: 'visible' })
  // Dragging the splitter persists the ratio; double-click resets it.
  const ratio = await settingsValue('splitRatio')
  const sep = await page.locator('[role=separator]').first().boundingBox()
  await page.mouse.move(sep.x + sep.width / 2, sep.y + 300)
  await page.mouse.down()
  await page.mouse.move(sep.x - 220, sep.y + 300, { steps: 10 })
  await page.mouse.up()
  await until((s, r) => s('settings').settings.splitRatio < r - 0.05, ratio)
  await page.locator('[role=separator]').first().dblclick()
  await until((s) => Math.abs(s('settings').settings.splitRatio - 0.55) < 0.01) // the default ratio
  // Always on top.
  const onTop = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isAlwaysOnTop())
  await menu('toggleAlwaysOnTop')
  await until((s) => s('settings').settings.alwaysOnTop === true)
  await page.waitForTimeout(200)
  assert(await onTop(), 'window is always on top')
  await menu('toggleAlwaysOnTop')
  await until((s) => s('settings').settings.alwaysOnTop === false)
  await page.waitForTimeout(200)
  assert(!(await onTop()), 'window is back to normal')
  // Auto-hide output: ESC in the editor hides it.
  await updateSettings({ autoHideOutput: true })
  try {
    await editorEl().click({ position: { x: 200, y: 40 } })
    await page.keyboard.press('Escape')
    await page.locator('[data-testid=output-pane]').waitFor({ state: 'hidden' })
    await menu('toggleOutput')
    await page.locator('[data-testid=output-pane]').waitFor({ state: 'visible' })
  } finally {
    await updateSettings({ autoHideOutput: false })
  }
})

await step('fullscreen (native menu)', async () => {
  const isFull = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen())
  const waitFull = async (want) => {
    for (let i = 0; i < 50 && (await isFull()) !== want; i++) await page.waitForTimeout(100)
    return isFull()
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus())
  await menu('toggleFullscreen')
  assert(await waitFull(true), 'the window entered fullscreen')
  assert(!(await page.evaluate(() => !!document.fullscreenElement)), 'native window fullscreen, not the page Fullscreen API')
  await page.waitForTimeout(800) // macOS fullscreen animation
  await menu('toggleFullscreen')
  assert(!(await waitFull(false)), 'the window left fullscreen')
  await page.waitForTimeout(800)
  // Fullscreen entered natively (green button / Window menu) is left by the app's own command too.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(true))
  assert(await waitFull(true), 'the window entered native fullscreen')
  await page.waitForTimeout(800)
  await menu('toggleFullscreen')
  assert(!(await waitFull(false)), 'Toggle Fullscreen left native fullscreen')
  assert(!(await page.evaluate(() => !!document.fullscreenElement)), 'no page fullscreen left behind')
  await page.waitForTimeout(800)
})

await step('second instance with a tinkerbox:// deep link asks first, then opens the folder in the running app', async () => {
  const dir = join(scratch, 'deep-link-project')
  mkdirSync(dir, { recursive: true })
  const link = `tinkerbox://open?cwd=${Buffer.from(dir).toString('base64url')}`
  const secondInstance = () =>
    new Promise((resolveExit, reject) => {
      const env = { ...process.env, TINKERBOX_USER_DATA_DIR: userData }
      delete env.ELECTRON_RUN_AS_NODE
      const child = spawn(ELECTRON_BIN, [ROOT, `--user-data-dir=${userData}`, link], { cwd: ROOT, env, stdio: 'ignore' })
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('second instance did not exit'))
      }, 20_000)
      child.on('exit', (code) => {
        clearTimeout(timer)
        resolveExit(code)
      })
    })
  // Deep links (anything can trigger one) need a confirmation: stub the native message box with an answer.
  const answerPrompt = (response) =>
    app.evaluate(({ dialog }, answer) => {
      globalThis.__e2eMessageBox ??= dialog.showMessageBox
      globalThis.__e2ePrompts ??= []
      dialog.showMessageBox = async (...args) => {
        const options = args.find((a) => a && typeof a === 'object' && 'message' in a)
        globalThis.__e2ePrompts.push(`${options?.message}\n${options?.detail}`)
        return { response: answer, checkboxChecked: false }
      }
    }, response)
  const prompts = () => app.evaluate(() => globalThis.__e2ePrompts ?? [])
  const opened = () => store((s, p) => s('connections').connections.some((c) => c.path === p), dir)
  try {
    // Cancel: nothing is opened (and no project code runs).
    await answerPrompt(1)
    assert((await secondInstance()) === 0, 'second instance exits (cancel)')
    for (let i = 0; i < 50 && (await prompts()).length === 0; i++) await page.waitForTimeout(100)
    assert((await prompts()).length === 1, 'the deep link asked for confirmation')
    assert((await prompts())[0].includes(dir), 'the prompt shows the folder')
    await page.waitForTimeout(1000)
    assert(!(await opened()), 'a cancelled deep link does not open the folder')
    // Open.
    await answerPrompt(0)
    const exitCode = await secondInstance()
    assert(exitCode === 0, `second instance exits (code ${exitCode})`)
    await until(
      (s, p) => {
        const tab = s('tabs').activeTab
        return !!tab && s('connections').path(tab.connectionId) === p
      },
      dir,
      15_000
    )
    assert((await prompts()).length === 2, 'asked again for the second link')
  } finally {
    await app.evaluate(({ dialog }) => {
      if (globalThis.__e2eMessageBox) dialog.showMessageBox = globalThis.__e2eMessageBox
    })
  }
  assert((await page.title()).includes('deep-link-project'), `title (${await page.title()})`)
  // The second instance's own app path (unpackaged) must not be opened as a project.
  const repoOpened = await store((s, root) => s('connections').connections.some((c) => c.path === root), ROOT)
  assert(!repoOpened, 'the app directory was not opened as a project')
})

await step('Sync with OS: the dark / light theme follows the system appearance', async () => {
  await updateSettings({ syncThemeWithOs: true, darkTheme: 'nord', lightTheme: 'github' })
  try {
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'dark'
    })
    await until(() => document.documentElement.dataset.theme === 'nord')
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'light'
    })
    await until(() => document.documentElement.dataset.theme === 'github')
  } finally {
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'system'
    })
    await updateSettings({ syncThemeWithOs: false })
  }
})

await step('theme switch to Dracula (Settings → Appearance → Select → Themes)', async () => {
  if (HAS_LARAVEL) await openLaravelHere()
  await menu('openSettings')
  const modal = topModal()
  await modal.locator('[data-page=appearance]').click()
  await modal.locator('[data-testid=select-theme]').click()
  const themes = page.locator(MODAL, { hasText: 'Built-in' }).last()
  await themes.locator('[data-theme-id=dracula]').click()
  await until(() => document.documentElement.dataset.theme === 'dracula')
  await shot('themes-dracula-preview')
  await themes.locator('[data-testid=theme-save]').click()
  await until((s) => s('settings').settings.theme === 'dracula')
  assert((await page.evaluate(() => document.documentElement.dataset.dark)) === 'true', 'Dracula is a dark theme')
  await closeModals()
  await expectNoModal()
})

// =================================================================================================================
// Phase 2 — Dracula screenshots of the main surfaces
// =================================================================================================================
themeSuffix = '-dracula'
console.log('Dracula')

await step('Dracula: editor, magic badges and output', async () => {
  await setCode(
    [
      "$name = 'Tinkerbox'; //?",
      '$items = [1, 2, 3];',
      'foreach ($items as $i) {',
      '    $square = $i * $i; //?',
      '}',
      '$text = <<<TXT',
      '    Hello {$name}',
      '    TXT;',
      "['name' => $name, 'squares' => array_map(fn ($i) => $i ** 2, $items)];"
    ].join('\n')
  )
  okRun(await run())
  await page.locator('[data-testid=editor-pane] .tw-magic-value').first().waitFor()
  const bg = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid=editor-pane] .monaco-editor')).backgroundColor)
  assert(bg === 'rgb(40, 42, 54)', `Monaco uses the Dracula background (${bg})`)
  await shot('run-magic-coverage')
})

await step('Dracula: exception view', async () => {
  await setCode(["$user = ['name' => 'Ada'];", '', "throw new RuntimeException('Something broke for ' . $user['name'], 42);"].join('\n'))
  const r = await run()
  assert(r.exception === 'RuntimeException', `exception (${r.exception})`)
  await output().getByText('Something broke for Ada').first().waitFor()
  await shot('exception-collision')
})

await step('Dracula: CLI mode', async () => {
  await page.getByRole('button', { name: 'CLI Mode', exact: true }).click()
  await page.locator('[data-testid=cli-output] .view-lines').waitFor()
  await shot('cli-mode')
  await page.getByRole('button', { name: 'Cards', exact: true }).click()
})

await step('Dracula: modals (Open Anything, History, Snippets, Settings)', async () => {
  await menu('commandPalette')
  await page.locator('[data-testid=palette-input]').waitFor()
  await shot('open-anything')
  await closeModals()
  await menu('showHistory')
  await topModal().getByText('TODAY').first().waitFor()
  await shot('history')
  await closeModals()
  await menu('showSnippets')
  await topModal().getByText('E2E snippet').first().waitFor()
  await shot('snippets')
  await closeModals()
  await menu('openSettings')
  await topModal().locator('[data-page=appearance]').click()
  await shot('settings-appearance')
  await closeModals()
  await expectNoModal()
})

await step(
  'Dracula: Laravel modals (Table Preview, Object Graph, Panels, Logs)',
  async () => {
    await setCode("collect([['id' => 1, 'name' => 'Ada'], ['id' => 2, 'name' => 'Grace']]);")
    okRun(await run())
    await cardAction(returnCard(), 'Table Preview')
    await topModal().getByText('2 entries').waitFor()
    await shot('table-preview')
    await closeModals()
    await cardAction(returnCard(), 'Object Graph')
    await topModal().locator('svg[role=img]').waitFor()
    await shot('object-graph')
    await closeModals()
    await page.locator('[data-testid=status-framework]').click()
    await page.locator('[data-testid=panels-version]').waitFor({ timeout: 30_000 })
    await topModal().getByText('Laravel Version').first().waitFor({ timeout: 30_000 })
    await shot('panels')
    await closeModals()
    await menu('showLogs')
    await page.locator('[data-testid=logs-modal]').waitFor()
    await page.locator('[data-testid=logs-loading]').waitFor({ state: 'detached', timeout: 20_000 }).catch(() => undefined)
    await shot('logs')
    await closeModals()
    await expectNoModal()
  },
  { needsLaravel: true }
)

await step('Dracula: Get started', async () => {
  await menu('showWelcome')
  await page.locator('[data-testid=get-started]').waitFor()
  await shot('get-started')
})

// =================================================================================================================
// Phase 3 — relaunch: the session, theme and snippets survive a restart
// =================================================================================================================
console.log('Relaunch')
const tabsBefore = await store((s) => s('tabs').tabs.map((t) => ({ kind: t.kind, code: t.code, connectionId: t.connectionId })))
await quit()
await launch()

await step('session restore: tabs, code, projects and the theme come back after a restart', async () => {
  await until((s) => s('tabs').initialized, null, 30_000)
  const after = await store((s) => s('tabs').tabs.map((t) => ({ kind: t.kind, code: t.code, connectionId: t.connectionId })))
  assert(after.length === tabsBefore.length, `same number of tabs (${after.length} vs ${tabsBefore.length})`)
  for (const t of tabsBefore.filter((x) => x.kind === 'code')) {
    assert(after.some((a) => a.code === t.code && a.connectionId === t.connectionId), 'code tab restored with its project')
  }
  await until(() => document.documentElement.dataset.theme === 'dracula')
  await menu('showSnippets')
  await topModal().getByText('E2E snippet').first().waitFor()
  await closeModals()
  await shot('restored-session')
})

await step('Recents: Settings → Advanced → Clear folders empties the recent list', async () => {
  await until((s) => s('connections').recent.length > 0)
  await menu('openSettings')
  await topModal().locator('[data-page=advanced]').click()
  await topModal().locator('[data-testid=clear-recents]').click()
  await confirmDialog()
  await until((s) => s('connections').recent.length === 0)
  await closeModals()
  const tabTitles = await page.locator('[role=tab]').allInnerTexts()
  assert(!tabTitles.some((t) => t.includes('Unknown project')), `open tabs keep their projects (${tabTitles.join(' | ')})`)
})

// =================================================================================================================
// Phase 4 — corrupted settings.json is detected, backed up and reset
// =================================================================================================================
await quit()
writeFileSync(join(userData, 'settings.json'), '{ "theme": "dracula", oops this is not JSON')
await launch()

await step('corrupted settings: the app starts with defaults, keeps a backup and says so', async () => {
  await page.getByText(/Settings file was corrupted and has been reset/i).first().waitFor({ timeout: 20_000 })
  await until((s) => s('settings').settings.theme === 'tinkerbox')
  assert(readdirSync(userData).some((f) => /^settings\.corrupt-.*\.json$/.test(f)), 'backup file written')
  const tabTitles = await page.locator('[role=tab]').allInnerTexts()
  assert(!tabTitles.some((t) => t.includes('Unknown project')), `restored tabs keep their projects (${tabTitles.join(' | ')})`)
  await shot('corrupted-settings')
})

await step('Close All (tab context menu) leaves the Get started tab', async () => {
  await page.locator('[role=tab]').last().click({ button: 'right' })
  await page.getByText('Close All', { exact: true }).first().click()
  await page.waitForTimeout(300)
  await confirmIfAsked()
  await until((s) => s('tabs').tabs.length === 1 && s('tabs').tabs[0].kind === 'welcome')
  await page.locator('[data-testid=get-started]').waitFor()
})

// -----------------------------------------------------------------------------------------------------------------
await step('no console errors in the renderer or main process', async () => {
  const relevant = consoleErrors.filter((t) => !/Autofill\.enable|Autofill\.setAddresses/.test(t))
  assert(relevant.length === 0, `renderer console errors:\n${relevant.join('\n')}`)
  // The corrupted-settings phase logs one expected warning/error about the broken file.
  const unexpected = mainErrors.filter((l) => !/corrupt/i.test(l))
  assert(unexpected.length === 0, `main process errors:\n${unexpected.join('\n')}`)
})

await step(
  'the Laravel project was not modified',
  async () => {
    const after = snapshotTree(LARAVEL)
    const changed = []
    for (const [file, sig] of after) if (laravelBefore.get(file) !== sig) changed.push(file)
    for (const file of laravelBefore.keys()) if (!after.has(file)) changed.push(`${file} (deleted)`)
    assert(changed.length === 0, `files changed in ${LARAVEL}:\n${changed.slice(0, 20).join('\n')}`)
  },
  { needsLaravel: true }
)

await finish()

async function finish() {
  await quit()
  if (!KEEP) rmSync(userData, { recursive: true, force: true })
  const failed = results.filter((r) => r.status === 'fail')
  const skipped = results.filter((r) => r.status === 'skip')
  console.log(
    `\n${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped` +
      ` in ${((Date.now() - startedAt) / 1000).toFixed(1)} s — screenshots in ${SHOTS}` +
      (KEEP ? `\nuser data kept at ${userData}` : '')
  )
  for (const f of failed) console.log(`\nFAILED: ${f.name}\n${f.detail}`)
  process.exit(failed.length || unexpectedExit ? 1 : 0)
}
