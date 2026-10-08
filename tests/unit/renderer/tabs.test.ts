import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WELCOME_CODE } from '@shared/defaults'
import type { RunRequest, RunResult, SessionState, TabState } from '@shared/types'
import { setBridge } from '@/api'
import { registerEditor } from '@/editorBridge'
import { useSettingsStore } from '@/stores/settings'
import { SESSION_SAVE_DELAY_MS, useTabsStore } from '@/stores/tabs'
import { useUiStore } from '@/stores/ui'
import { deferred, fakeBridge, fakeEditor, okResult, type FakeBridge, type Overrides } from './helpers'

let fake: FakeBridge
const cleanups: Array<() => void> = []

async function setup(overrides: Overrides = {}, settingsPatch: Parameters<ReturnType<typeof useSettingsStore>['update']>[0] = {}) {
  fake = fakeBridge({
    'run:start': (request) => okResult(request),
    ...overrides
  })
  setBridge(fake.bridge)
  setActivePinia(createPinia())
  const settings = useSettingsStore()
  await settings.load()
  if (Object.keys(settingsPatch).length) await settings.update(settingsPatch)
  const tabs = useTabsStore()
  cleanups.push(() => tabs.dispose())
  return { tabs, settings, ui: useUiStore() }
}

function codeTab(id: string, patch: Partial<TabState> = {}): TabState {
  return { id, kind: 'code', title: 'PHP', code: `echo '${id}';`, connectionId: null, outputMode: 'detail', showQueries: false, ...patch }
}

function lastRequest(): RunRequest {
  const calls = fake.callsTo('run:start')
  return calls[calls.length - 1][0]
}

beforeEach(() => {
  vi.useRealTimers()
})

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
  setBridge(null)
  vi.useRealTimers()
})

describe('init', () => {
  it('starts with the Get started tab when nothing is restored', async () => {
    const { tabs } = await setup()
    await tabs.init()
    expect(tabs.tabs.map((t) => t.kind)).toEqual(['welcome'])
    expect(tabs.activeTab?.kind).toBe('welcome')
    expect(tabs.displayTitle(tabs.activeTab)).toBe('Get started')
  })

  it('opens the example script when the welcome tab is disabled', async () => {
    const { tabs } = await setup({}, { welcomeTab: false })
    await tabs.init()
    expect(tabs.tabs).toHaveLength(1)
    expect(tabs.tabs[0].kind).toBe('code')
    expect(tabs.tabs[0].code).toBe(WELCOME_CODE)
  })

  it('restores the session and keeps its active tab', async () => {
    const session: SessionState = { tabs: [codeTab('a'), codeTab('b', { customTitle: 'Mine', showQueries: true })], activeTabId: 'b' }
    const { tabs } = await setup({ 'session:load': () => session })
    await tabs.init()
    expect(tabs.tabs.map((t) => t.id)).toEqual([expect.any(String), 'a', 'b'])
    expect(tabs.tabs[0].kind).toBe('welcome')
    expect(tabs.activeTabId).toBe('b')
    expect(tabs.displayTitle('b')).toBe('Mine')
    expect(tabs.byId('b')?.showQueries).toBe(true)
  })

  it('ignores the session when restoreSession is off', async () => {
    const { tabs } = await setup({ 'session:load': () => ({ tabs: [codeTab('a')], activeTabId: 'a' }) }, { restoreSession: false })
    await tabs.init()
    expect(tabs.byId('a')).toBeUndefined()
  })

  it('drops invalid restored tabs', async () => {
    const broken = { tabs: [{ id: 5 }, codeTab('ok'), { id: 'x', kind: 'nope' }] as unknown as TabState[], activeTabId: 'zz' }
    const { tabs } = await setup({ 'session:load': () => broken }, { welcomeTab: false })
    await tabs.init()
    expect(tabs.tabs.map((t) => t.id)).toEqual(['ok'])
    expect(tabs.activeTabId).toBe('ok')
  })
})

describe('session persistence', () => {
  it('saves tabs and code (debounced) after changes', async () => {
    vi.useFakeTimers()
    const { tabs } = await setup()
    await tabs.init()
    const tab = tabs.newTab({ code: '1 + 1;' })
    tabs.setCode(tab.id, '2 + 2;')
    await vi.advanceTimersByTimeAsync(SESSION_SAVE_DELAY_MS - 50)
    expect(fake.callsTo('session:save')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(100)
    const saves = fake.callsTo('session:save')
    expect(saves).toHaveLength(1)
    const [state] = saves[0]
    expect(state.activeTabId).toBe(tab.id)
    expect(state.tabs.find((t) => t.id === tab.id)?.code).toBe('2 + 2;')
  })

  it('round-trips through session:load', async () => {
    let stored: SessionState | null = null
    const overrides: Overrides = {
      'session:load': () => stored,
      'session:save': (state) => {
        stored = JSON.parse(JSON.stringify(state)) as SessionState
      }
    }
    const first = await setup(overrides)
    await first.tabs.init()
    const tab = first.tabs.newTab({ code: '$x = 1;', connectionId: 'scratch' })
    first.tabs.renameTab(tab.id, 'Scratchpad')
    await first.tabs.saveSessionNow()
    first.tabs.dispose()

    const second = await setup(overrides)
    await second.tabs.init()
    const restored = second.tabs.byId(tab.id)
    expect(restored?.code).toBe('$x = 1;')
    expect(restored?.connectionId).toBe('scratch')
    expect(second.tabs.displayTitle(restored)).toBe('Scratchpad')
    expect(second.tabs.activeTabId).toBe(tab.id)
  })
})

describe('run', () => {
  it('runs the whole buffer with run options from the settings', async () => {
    const { tabs } = await setup({}, { prettifyOnRun: false })
    await tabs.init()
    const tab = tabs.newTab({ code: "echo 'hi';", showQueries: true })
    const result = await tabs.run()
    expect(result?.ok).toBe(true)
    const req = lastRequest()
    expect(req.tabId).toBe(tab.id)
    expect(req.code).toBe("echo 'hi';")
    expect(req.lineOffset).toBeUndefined()
    expect(req.options.captureQueries).toBe(true)
    expect(req.options.timeoutMs).toBe(120000)
    expect(tabs.resultOf(tab.id)?.runId).toBe(req.runId)
    expect(tabs.isRunning(tab.id)).toBe(false)
  })

  it('runs the selection with its line offset when "Evaluate selected code" is on', async () => {
    const { tabs } = await setup()
    await tabs.init()
    const tab = tabs.newTab({ code: 'a();\nb();\nc();' })
    const { editor, state } = fakeEditor('a();\nb();\nc();', { text: 'c();', startLine: 3, endLine: 3 })
    cleanups.push(registerEditor(tab.id, editor))
    await tabs.run()
    expect(lastRequest().code).toBe('c();')
    expect(lastRequest().lineOffset).toBe(3)
    expect(state.prettified).toBe(0)
    expect(state.decorated).toHaveLength(1)
  })

  it('ignores the selection when runSelection is off, unless selectionOnly is requested', async () => {
    const { tabs } = await setup({}, { runSelection: false, prettifyOnRun: false })
    await tabs.init()
    const tab = tabs.newTab({ code: 'a();\nb();' })
    const { editor } = fakeEditor('a();\nb();', { text: 'b();', startLine: 2, endLine: 2 })
    cleanups.push(registerEditor(tab.id, editor))
    await tabs.run()
    expect(lastRequest().code).toBe('a();\nb();')
    await tabs.run({ selectionOnly: true })
    expect(lastRequest().code).toBe('b();')
    expect(lastRequest().lineOffset).toBe(2)
  })

  it('prettifies before running and syncs the tab code', async () => {
    const { tabs } = await setup()
    await tabs.init()
    const tab = tabs.newTab({ code: 'foo() ;' })
    const { editor, state } = fakeEditor('foo() ;')
    cleanups.push(registerEditor(tab.id, editor))
    await tabs.run()
    expect(state.prettified).toBe(1)
    expect(lastRequest().code).toBe('foo();')
    expect(tabs.byId(tab.id)?.code).toBe('foo();')
  })

  it('stops the script when Run is pressed while it runs, and streams progress', async () => {
    const pending = deferred<RunResult>()
    const { tabs } = await setup({ 'run:start': () => pending.promise }, { prettifyOnRun: false })
    await tabs.init()
    const tab = tabs.newTab({ code: 'sleep(10);' })
    const first = tabs.run()
    await Promise.resolve()
    await Promise.resolve()
    expect(tabs.isRunning(tab.id)).toBe(true)
    const runId = tabs.runIds[tab.id]
    fake.emit('run:progress', { runId, tabId: tab.id, stream: 'stdout', chunk: 'tick ' })
    fake.emit('run:progress', { runId, tabId: tab.id, stream: 'stdout', chunk: 'tock' })
    fake.emit('run:progress', { runId: 'other', tabId: tab.id, stream: 'stdout', chunk: 'ignored' })
    expect(tabs.streamedOf(tab.id)).toBe('tick tock')

    expect(await tabs.run()).toBeNull()
    expect(fake.callsTo('run:cancel')).toEqual([[runId]])

    pending.resolve(okResult(lastRequest(), { cancelled: true, ok: false }))
    const result = await first
    expect(result?.cancelled).toBe(true)
    expect(tabs.isRunning(tab.id)).toBe(false)
    expect(tabs.resultOf(tab.id)?.cancelled).toBe(true)
  })

  it('turns IPC failures into a failed result', async () => {
    const { tabs } = await setup({
      'run:start': () => {
        throw new Error("Error invoking remote method 'run:start': Error: PHP binary not found")
      }
    })
    await tabs.init()
    tabs.newTab({ code: '1;' })
    const result = await tabs.run()
    expect(result?.ok).toBe(false)
    expect(result?.error).toBe('PHP binary not found')
  })

  it('does not run empty code or the welcome tab', async () => {
    const { tabs } = await setup()
    await tabs.init()
    expect(await tabs.run()).toBeNull()
    tabs.newTab({ code: '   ' })
    expect(await tabs.run()).toBeNull()
    expect(fake.callsTo('run:start')).toHaveLength(0)
  })

  it('re-shows auto-hidden output when running', async () => {
    const { tabs, settings } = await setup({}, { autoHideOutput: true, showOutput: false })
    await tabs.init()
    tabs.newTab({ code: '1;' })
    await tabs.run()
    expect(settings.settings.showOutput).toBe(true)
  })

  it('auto-evaluates after the configured delay', async () => {
    vi.useFakeTimers()
    const { tabs } = await setup({}, { autoRun: true, autoRunDelayMs: 400 })
    await tabs.init()
    const tab = tabs.newTab({ code: '' })
    tabs.setCode(tab.id, '1 +')
    tabs.setCode(tab.id, '1 + 1;')
    await vi.advanceTimersByTimeAsync(300)
    expect(fake.callsTo('run:start')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(200)
    expect(fake.callsTo('run:start')).toHaveLength(1)
    expect(lastRequest().code).toBe('1 + 1;')
  })

  it('clears output and decorations', async () => {
    const { tabs } = await setup({}, { prettifyOnRun: false })
    await tabs.init()
    const tab = tabs.newTab({ code: '1;' })
    const { editor, state } = fakeEditor('1;')
    cleanups.push(registerEditor(tab.id, editor))
    await tabs.run()
    tabs.clearOutput()
    expect(tabs.resultOf(tab.id)).toBeNull()
    expect(state.cleared).toBe(1)
  })
})

describe('tab management', () => {
  it('closing the last tab shows Get started; reopen restores it', async () => {
    const { tabs } = await setup({}, { welcomeTab: false })
    await tabs.init()
    const only = tabs.tabs[0]
    expect(await tabs.closeTab(only.id)).toBe(true)
    expect(tabs.tabs.map((t) => t.kind)).toEqual(['welcome'])
    const reopened = tabs.reopenClosedTab()
    expect(reopened?.code).toBe(WELCOME_CODE)
    expect(tabs.activeTabId).toBe(reopened?.id)
  })

  it('keeps the only Get started tab: it cannot be closed or renamed', async () => {
    const { tabs } = await setup({}, { welcomeTab: false })
    await tabs.init()
    await tabs.closeTab(tabs.tabs[0].id)
    const welcome = tabs.tabs[0]
    expect(welcome.kind).toBe('welcome')
    expect(tabs.canClose(welcome)).toBe(false)
    expect(await tabs.closeTab(welcome.id)).toBe(false)
    tabs.renameTab(welcome.id, 'Hacked')
    expect(tabs.displayTitle(welcome.id)).toBe('Get started')
    const code = tabs.newTab()
    expect(tabs.canClose(welcome.id)).toBe(true)
    expect(tabs.canClose(code.id)).toBe(true)
    tabs.renameTab(code.id, 'Mine')
    expect(tabs.displayTitle(code.id)).toBe('Mine')
  })

  it('activates the neighbour of a closed active tab', async () => {
    const { tabs } = await setup({ 'session:load': () => ({ tabs: [codeTab('a'), codeTab('b'), codeTab('c')], activeTabId: 'b' }) }, { welcomeTab: false })
    await tabs.init()
    await tabs.closeTab('b')
    expect(tabs.activeTabId).toBe('c')
    await tabs.closeTab('c')
    expect(tabs.activeTabId).toBe('a')
  })

  it('asks before closing when configured and respects the answer', async () => {
    const { tabs, ui } = await setup({}, { askBeforeClosingTab: true })
    await tabs.init()
    const tab = tabs.newTab({ code: 'important();' })
    const closing = tabs.closeTab(tab.id)
    await Promise.resolve()
    expect(ui.modal).toBe('confirm')
    ui.closeModal(undefined, false)
    expect(await closing).toBe(false)
    expect(tabs.byId(tab.id)).toBeDefined()

    const again = tabs.closeTab(tab.id)
    await Promise.resolve()
    ui.closeModal(undefined, true)
    expect(await again).toBe(true)
    expect(tabs.byId(tab.id)).toBeUndefined()
  })

  it('closes empty tabs without asking', async () => {
    const { tabs, ui } = await setup({}, { askBeforeClosingTab: true })
    await tabs.init()
    const tab = tabs.newTab({ code: '' })
    expect(await tabs.closeTab(tab.id)).toBe(true)
    expect(ui.modal).toBeNull()
  })

  it('closes others / to the right / all', async () => {
    const session = { tabs: [codeTab('a'), codeTab('b'), codeTab('c'), codeTab('d')], activeTabId: 'a' }
    const { tabs } = await setup({ 'session:load': () => session }, { welcomeTab: false })
    await tabs.init()
    await tabs.closeToRight('b')
    expect(tabs.tabs.map((t) => t.id)).toEqual(['a', 'b'])
    await tabs.closeOthers('b')
    expect(tabs.tabs.map((t) => t.id)).toEqual(['b'])
    expect(tabs.activeTabId).toBe('b')
    await tabs.closeAll()
    expect(tabs.tabs.map((t) => t.kind)).toEqual(['welcome'])
    expect(tabs.closedTabs.map((c) => c.tab.id)).toEqual(['c', 'd', 'a', 'b'])
  })

  it('duplicates, renames, cycles and reorders', async () => {
    const { tabs } = await setup({ 'session:load': () => ({ tabs: [codeTab('a', { connectionId: 'scratch' }), codeTab('b')], activeTabId: 'a' }) }, { welcomeTab: false })
    await tabs.init()
    const copy = tabs.duplicateTab('a')!
    expect(tabs.tabs.map((t) => t.id)).toEqual(['a', copy.id, 'b'])
    expect(copy.code).toBe("echo 'a';")
    expect(copy.connectionId).toBe('scratch')
    expect(tabs.activeTabId).toBe(copy.id)

    tabs.renameTab('b', '  Experiments ')
    expect(tabs.displayTitle('b')).toBe('Experiments')
    tabs.renameTab('b', '')
    expect(tabs.byId('b')?.customTitle).toBeUndefined()

    tabs.nextTab()
    expect(tabs.activeTabId).toBe('b')
    tabs.nextTab()
    expect(tabs.activeTabId).toBe('a')
    tabs.previousTab()
    expect(tabs.activeTabId).toBe('b')

    tabs.moveTab(2, 0)
    expect(tabs.tabs.map((t) => t.id)).toEqual(['b', 'a', copy.id])
  })

  it('keeps at most 20 closed tabs', async () => {
    const { tabs } = await setup({}, { welcomeTab: false })
    await tabs.init()
    for (let i = 0; i < 25; i++) {
      const t = tabs.newTab({ code: `${i};` })
      await tabs.closeTab(t.id)
    }
    expect(tabs.closedTabs).toHaveLength(20)
    expect(tabs.reopenClosedTab()?.code).toBe('24;')
  })

  it('switching the project updates the title and clears the output', async () => {
    const { tabs } = await setup({}, { prettifyOnRun: false })
    await tabs.init()
    const tab = tabs.newTab({ code: '1;' })
    await tabs.run()
    tabs.setConnection(tab.id, 'scratch')
    expect(tabs.byId(tab.id)?.title).toBe('PHP')
    expect(tabs.resultOf(tab.id)).toBeNull()
  })

  it('openCode replaces the active tab or opens a new one', async () => {
    const { tabs } = await setup({}, { welcomeTab: false })
    await tabs.init()
    const active = tabs.activeTab!
    tabs.openCode('replaced();')
    expect(tabs.byId(active.id)?.code).toBe('replaced();')
    const fresh = tabs.openCode('new();', { newTab: true, connectionId: 'scratch' })
    expect(fresh.id).not.toBe(active.id)
    expect(fresh.connectionId).toBe('scratch')
  })
})

describe('files', () => {
  it('saves to a file, marks dirty on edits and re-runs on external changes', async () => {
    const { tabs } = await setup({ 'file:save': (_content, path, name) => path ?? `/tmp/${name}` }, { prettifyOnRun: false })
    await tabs.init()
    const tab = tabs.newTab({ code: 'echo 1;' })
    expect(await tabs.saveFile(tab.id)).toBe('/tmp/Default.php')
    expect(tabs.byId(tab.id)?.filePath).toBe('/tmp/Default.php')
    expect(tabs.displayTitle(tab.id)).toBe('Default.php')
    tabs.setCode(tab.id, 'echo 2;')
    expect(tabs.byId(tab.id)?.dirty).toBe(true)

    expect(await tabs.toggleWatch(tab.id)).toBe(true)
    expect(fake.callsTo('file:watch')).toEqual([[tab.id, '/tmp/Default.php']])
    fake.emit('file:changed', { tabId: tab.id, path: '/tmp/Default.php', content: 'echo 3;' })
    await vi.waitFor(() => expect(fake.callsTo('run:start')).toHaveLength(1))
    expect(tabs.byId(tab.id)?.code).toBe('echo 3;')
    expect(tabs.byId(tab.id)?.dirty).toBeUndefined()
    expect(lastRequest().code).toBe('echo 3;')
  })

  it('opens files from the OS in a tab (once)', async () => {
    const { tabs } = await setup()
    await tabs.init()
    fake.emit('file:opened', { path: '/p/test.php', content: '<?php echo 1;' })
    fake.emit('file:opened', { path: '/p/test.php', content: '<?php echo 1;' })
    const fileTabs = tabs.tabs.filter((t) => t.filePath === '/p/test.php')
    expect(fileTabs).toHaveLength(1)
    expect(tabs.displayTitle(fileTabs[0])).toBe('test.php')
  })
})
