# Renderer API

Everything below lives in `src/renderer/src/` (alias `@/`). Shared contracts come from `src/shared` (alias `@shared/`).
Vue 3.5 `<script setup lang="ts">`, Pinia 3 setup stores, Tailwind 4, lucide icons. **Never import Monaco outside
`components/editor/**` and `monaco/**`.** No hard-coded colors in components: use the theme tokens below.

```
src/renderer/src/
  main.ts            createApp + Pinia, fonts (@fontsource/fira-code 400/500/600), prepare() → mount → start()
  bootstrap.ts       prepare(): settings + theme sync · start(): commands, app:notice, app info, recents, session
  App.vue            TitleBar · Sidebar · TabsBar · (GetStarted | Workspace) · StatusBar · ModalHost · Toasts · ContextMenu
  api.ts             typed window.tinkerbox wrapper (+ api.mock.ts used ONLY without Electron)
  editorBridge.ts    editor ⇄ shell contract
  commands/index.ts  every CommandId, menu/keyboard wiring, list for the palette & shortcuts editor
  stores/            app, settings, connections, tabs, snippets, history, environment, ui (+ index.ts barrel)
  themes/            types.ts, builtins.ts (palettes), build.ts (spec → vars + Monaco data), index.ts (registry)
  utils/             accelerator, color, dumpText, format, fuzzy, id, merge, platform, position
  components/common  design system (see below)
  components/layout  TitleBar, Sidebar, RecentFolders, TabsBar, Workspace, StatusBar
  components/welcome GetStarted.vue
  components/ModalHost.vue
  components/editor  EditorPane + Monaco integration (with monaco/)
  components/output  Cards / CLI output, Table Preview, Object Graph, HTML Preview
  components/modals  settings, palette, history, snippets, themes, logs, panels, php, wrapped, share
```

## Startup & lifecycle

1. `prepare()` — `settings.load()` (subscribes `settings:changed`), `startThemeSync()`, `loadCustomThemes()`.
2. mount `App.vue`.
3. `start()` — `installCommands()` (`menu:command` + keydown), `app:notice` → toast, `app.load()`,
   `connections.load()`, `tabs.init()` (calls `session:load`, which tells main the renderer is ready; queued
   `app:openPath` / `file:opened` events are then delivered and open tabs).

`App.vue` also: sets `document.title` + `window:setTitle` to `Tinkerbox - <tab title>`, and loads the environment
(autocompletion data) of the active code tab's connection 700 ms after it becomes active.

---

## api.ts

```ts
import { api, invoke, on, errorText, setBridge, isMockBridge } from '@/api'
api.invoke(channel, ...args): Promise<InvokeReturn<C>>   // typed by InvokeChannels (src/shared/ipc.ts)
api.on(channel, listener): () => void                    // typed by EventChannels; returns unsubscribe
api.errorText(err): string      // strips "Error invoking remote method 'x': Error:" prefixes
api.copy(text): Promise<void>   // clipboard via main
api.platform                    // NodeJS.Platform
api.isMock                      // true when running without Electron (in-memory mock bridge)
setBridge(bridge | null)        // tests: inject a fake TinkerboxBridge
```
Pass plain data over IPC: wrap reactive objects with `cloneJson()` (`@/utils/merge`) first.

## editorBridge.ts (the editor implements it, the rest of the renderer consumes it)

```ts
interface EditorSelection { text: string; startLine: number; endLine: number }   // 1-based lines
interface EditorBridge {
  getCode(): string
  getSelection(): EditorSelection | null        // null when the selection is empty
  insertText(text: string): void                // at the cursor, replacing the selection
  replaceAll(code: string): void                // keep undo history when possible
  focus(): void
  revealLine(line: number): void                // scroll + put the cursor on the 1-based line
  applyRunDecorations(result: RunResult): void  // magic comment badges, coverage gutter, inline errors
  clearDecorations(): void
  getCursorLine(): number                       // 1-based
  prettify?(): Promise<void>                    // Prettier PHP (optional); may throw on syntax errors
  addMagicComment?(): void                      // optional; fallback appends " //?" to the cursor line
}
registerEditor(tabId, bridge): () => void       // call on mount / when tabId changes; call the result on unmount
getEditor(tabId): EditorBridge | null           // reactive (usable in computed)
hasEditor(tabId): boolean
appendMagicComment(bridge): void                // uses bridge.addMagicComment or text fallback
```
Rules for `EditorPane.vue` (props `{ tabId: string }`):
- It is mounted **once** and receives the **active** `tabId` (it is not re-created per tab): swap Monaco models /
  view state on `tabId` change and re-register the bridge for the new tab.
- Call `tabs.setCode(tabId, code)` on every content change (the store marks file tabs dirty, schedules auto-run and
  persists the session). Programmatic changes come in through `bridge.replaceAll/insertText` (the store calls them).
- Put `data-editor` on the root element: the renderer keyboard handler treats it as the editor (ESC → `focusEditor`).
- Vim status: `<div id="vim-status-<tabId>">` exists in the status bar (shown when `settings.vimMode`).
- Native menu accelerators only fire for key events the page did **not** `preventDefault()`. Remove Monaco
  keybindings that collide with app shortcuts (`commandList()` gives the effective accelerators; e.g. ⌘L
  expandLineSelection vs Toggle Logs, Ctrl+Y redo on Windows vs History…). Menu-less commands (`menu: false` in
  COMMAND_META: renameTab, clearOutput, addMagicComment, addSelectionToSnippets, focusEditor) are dispatched by the
  renderer's `window` keydown listener (bubble phase) and are skipped when the event was `defaultPrevented`.
- Run decorations: `tabs.run()` calls `getEditor(tabId)?.applyRunDecorations(result)` after every run,
  `clearOutput()` calls `clearDecorations()`.

---

## Stores (`@/stores/<name>` or the `@/stores` barrel)

All stores are Pinia setup stores; refs are unwrapped on the store instance (`tabs.tabs`, `settings.settings`).

### `useSettingsStore()`
| member | description |
| --- | --- |
| `settings: Settings` | mirror of the main settings (defaults until loaded); `github.token` is `SECRET_MASK` when set |
| `loaded: boolean` | |
| `shortcuts` | `settings.shortcuts` (computed) |
| `accelerator(id: CommandId): string` | effective accelerator (override or platform default), '' = none |
| `load(): Promise<Settings>` | `settings:get` + subscribe `settings:changed` |
| `update(patch: DeepPartial<Settings>): Promise<Settings>` | optimistic deep-merge; reverts + toasts on failure |
| `set(key, value)` | one top-level key |
| `toggle(booleanKey): Promise<boolean>` | resolves with the new value |
| `setShortcut(id, accel: string \| null)` | `''` = no shortcut, `null` = back to default |
| `reset(): Promise<Settings>` | `settings:reset` |

### `useAppStore()`
`info: AppInfo | null`, `sandbox: SandboxStatus | null`, `sandboxLog: string[]` (install output, last 200 lines),
`herdSites: HerdSite[]`, `herdLoaded`, getters `homeDir` (for `tildify()`), `sandboxInstalled`, `sandboxInstalling`;
actions `load()`, `loadInfo()`, `refreshSandbox()`, `installSandbox()` (progress via `sandbox:progress`, toasts the
outcome), `loadHerdSites()`. `guessHome(path)` helper.

### `useConnectionsStore()`
Connections = local project folders (recent folders) + the implicit `'sandbox'` ("Default") and `'scratch'` ("PHP").
A tab's `connectionId: null` = default: Default Working Directory → Sandbox (installed) → PHP.

| member | description |
| --- | --- |
| `connections: Connection[]`, `loaded` | raw list from main (`connections:changed` keeps it fresh) |
| `recent: Connection[]` | recent project folders, newest first (implicit + cleared entries excluded) |
| `defaultConnectionLabel: string` | label of what `null` resolves to: DWD folder name, 'Default' or 'PHP' |
| `label(id \| null): string` | 'Default' (sandbox; 'PHP' when not installed), 'PHP' (scratch), project name |
| `byId(id)`, `findByPath(path)` | lookups |
| `effectiveId(id \| null): string \| null` | concrete id behind a tab connection (null when the DWD has no stored entry) |
| `path(id \| null): string` | project directory ('' = plain PHP) |
| `color(id \| null): string \| undefined` | badge color (explicit `color`, else stable per project; undefined for defaults) |
| `resolve(id \| null): Connection \| null` | stored connection or synthesized sandbox/scratch entry (to edit `phpBinary`, `driver`, `debug`…) |
| `isDebugging(id)` | Xdebug toggle state |
| `load()`, `openLocal(dir)`, `pickDirectory(title?)` | folder dialog → openLocal (null when cancelled) |
| `save(conn)`, `remove(id)` (alias `delete`), `test(conn)`, `touch(id)`, `clearRecents()` | |
| `toggleDebug(id \| null): Promise<boolean>` | flips `debug` on the project behind the tab |

`colorForName(name)`, `isImplicitConnection(id)` are exported helpers.

### `useTabsStore()`
State: `tabs: TabState[]`, `activeTabId`, and per-tab runtime maps (keyed by tab id, **not persisted**):
`results: Record<id, RunResult | null>` (raw, never deep-reactive — do not mutate), `running: Record<id, boolean>`,
`runIds`, `runStartedAt`, `streamed: Record<id, string>` (realtime stdout/stderr of the current run, ≤ 2 MB),
`watching: Record<id, boolean>`, `closedTabs` (≤ 20), `initialized`.

Getters / helpers: `activeTab`, `activeResult`, `codeTabs`, `anyRunning`, `byId(id)`, `isRunning(id)`,
`resultOf(id)`, `streamedOf(id)`, `autoTitle(tab)`, `displayTitle(tab | id)` (custom title → file name → project
label → "Get started").

| action | behaviour |
| --- | --- |
| `init()` | restore `session:load` (if `restoreSession`), add "Get started" (if `welcomeTab`; active only when no code tab was restored), else a tab with `WELCOME_CODE`; starts debounced (500 ms) `session:save`; flushes on `beforeunload` |
| `newTab(opts?: NewTabOptions): TabState` | `{ connectionId?, code?, customTitle?, filePath?, outputMode?, showQueries?, afterTabId?, activate? }` |
| `openWelcome()` | activate/create the "Get started" tab (first position) |
| `activate(id)`, `nextTab()`, `previousTab()`, `moveTab(from, to)` | |
| `closeTab(id?, { force? }): Promise<boolean>` | asks (ui.confirm) when `askBeforeClosingTab` and code is non-empty, or the file tab is dirty; last tab → "Get started"; false when cancelled |
| `closeOthers(id?)`, `closeToRight(id?)`, `closeAll()` | one confirmation for all |
| `removeTabs(ids)` | close without asking |
| `duplicateTab(id?)`, `reopenClosedTab()`, `renameTab(id, title)` | rename is session-only; '' restores the auto title |
| `setConnection(id, connectionId)` | switch project (updates title, clears output) |
| `openProject(conn \| id \| null, { newTab? })` | in the active code tab, or a new tab ("Get started" active / `newTab`) |
| `openSandbox()` | new tab on 'sandbox' (or "Get started" + warning when not installed) |
| `setOutputMode(id \| null, 'detail' \| 'cli')`, `toggleQueries(id?)` | |
| `setCode(id, code)` | **editor → store** (dirty flag for file tabs, auto-run debounce) |
| `replaceCode(id, code)` | programmatic replace (updates the mounted editor too) |
| `insertCode(id, text)` | insert at the cursor (append when no editor) |
| `openCode(code, { connectionId?, newTab?, run? })` | history/snippet "open": replaces the active code tab's code or opens a tab |
| `run({ tabId?, selectionOnly?, auto? }): Promise<RunResult \| null>` | see below |
| `cancel(id?)` | `run:cancel` (the run resolves with `cancelled: true`) |
| `clearOutput(id?)` | result + streamed cleared, `clearDecorations()` |
| `openFile()`, `openFileContent(path, content)`, `saveFile(id?, { as? })`, `toggleWatch(id?)` | file tabs; `file:changed` replaces the code and re-runs |
| `snapshot()`, `saveSessionNow()`, `dispose()` | |

`run()` details: running again while running cancels; `settings.runSelection` (or `selectionOnly`) uses
`editor.getSelection()` → `code = selection.text`, `lineOffset = selection.startLine`; without a selection and with
`settings.prettifyOnRun`, `editor.prettify()` runs first (errors ignored), then the buffer is synced into the tab;
empty code does nothing; `autoHideOutput` + hidden output → `showOutput: true`; options =
`runOptionsFromSettings(settings, tab.showQueries)`; IPC failures become a `RunResult` with `error`
(`failedRunResult()`); `run:progress` chunks of the current run append to `streamed[tabId]`.
Auto-evaluate (`settings.autoRun`): `setCode` schedules `run({ auto: true })` after `autoRunDelayMs`
(whole buffer, no prettify, never cancels a running script).

### `useSnippetsStore()`
`snippets: Snippet[]` (user + project snippets of `connectionId`), `loaded`, `loading`, `connectionId`, getters
`userSnippets`, `projectSnippets`, `byId(id)`; actions `load(connId?)`, `save(input: SnippetInput): Promise<Snippet>`
(`{ id?, name, description?, code, connectionId? }`; throws for project snippets), `remove(id)` (alias `delete`;
throws on failure), `importFile(): Promise<number>`, `exportFile(): Promise<string | null>`.

### `useHistoryStore()`
`entries: HistoryEntry[]` (newest first), `loaded`, `loading`, `byDay: DayGroup<HistoryEntry>[]`
(TODAY / YESTERDAY / date); `load()`, `remove(id)` (alias `delete`), `clear()`. Reloads on `history:changed` once
loaded.

### `useEnvironmentStore()` (autocompletion data)
Keyed by connection id (`envKey(null) = '@default'`). `get(connId): EnvironmentInfo | null`,
`statusOf(connId): 'idle' | 'loading' | 'ready' | 'error'`, `errorOf(connId)`,
`load(connId, force = false): Promise<EnvironmentInfo | null>` (in-flight dedupe; `force` bypasses caches),
`members(connId, className, force = false): Promise<ClassMembers | null>` (cached + deduped),
`cachedMembers(connId, className)` (sync; `undefined` = not loaded), `invalidate(connId?)`.

### `useUiStore()`
| member | description |
| --- | --- |
| `modals: ModalEntry[]` | stack `{ id, name, props }`; `modal` (top name), `modalProps` (top props), `topModal`, `anyModalOpen`, `isModalOpen(name)` |
| `openModal(name, props?, { stack? }): Promise<unknown>` | default **replaces** open modals; `stack: true` opens on top; resolves with the value passed to `emit('close', value)` (undefined when dismissed) |
| `closeModal(idOrName?, result?)`, `closeAllModals()`, `toggleModal(name, props?)` | |
| `confirm(opts: ConfirmOptions): Promise<boolean>` | `{ title, message?, confirmLabel?, cancelLabel?, danger? }` — stacked |
| `prompt(opts: PromptOptions): Promise<string \| null>` | `{ title, message?, label?, value?, placeholder?, validate?(v) → error \| null }` |
| `toasts`, `toast(opts \| message): id` | `{ level?: info\|success\|warning\|error, title?, message, timeout? (10 000; 0 = sticky), actions?: [{ label, run }], key? (replaces same key) }`; max 5 |
| `dismissToast(id)`, `holdToast(id)`, `releaseToast(id, ms)`, `error(err, prefix?)` | `error()` toasts an Error/IPC error message |
| `contextMenu`, `openContextMenu(event \| {x,y}, items: MenuItem[])`, `closeContextMenu()` | items: `{ label, icon?, shortcut?, danger?, disabled?, checked?, action }`, `{ type: 'separator' }`, `{ type: 'header', label }` |
| `popover`, `openPopover(id)`, `closePopover(id?)` | one id-ed popover at a time |
| `zen`, `setZen(b)`, `toggleZen()` | zen hides sidebar, tabs, status bar, output, title-bar controls |
| `renamingTabId`, `startRename(id \| null)` | inline tab rename in the tab bar |
| `showSidebar`, `showOutput`, `showChrome` | computed visibility (settings + zen) |
| `toggleSidebar()`, `toggleOutput()`, `toggleLayout()` | persisted through settings (`showToolbar`, `showOutput`, `layout`) |

### Modals (`ModalHost.vue`)
Each entry is rendered as `<Component v-bind="entry.props" @close="(result?) => ui.closeModal(entry.id, result)" />`.
Modal components declare the props below with `defineProps`, use `<Modal>` from `components/common`, and emit
`close` (optionally with a result).

| name | file | props (`ModalPropsMap`) |
| --- | --- | --- |
| `settings` | modals/settings/SettingsModal.vue | `{ page?: 'general'\|'appearance'\|'behaviour'\|'output'\|'shortcuts'\|'advanced'\|'updates'\|'about' }` |
| `palette` | modals/palette/CommandPalette.vue | `{ query?: string }` (`#` snippets, `/` folders, `>` commands) |
| `history` | modals/history/HistoryModal.vue | none |
| `snippets` | modals/snippets/SnippetsModal.vue | `{ connectionId?: string \| null }` |
| `snippetSave` | modals/snippets/SnippetSaveModal.vue | `{ code: string; connectionId: string \| null; snippet?: Snippet }` |
| `themes` | modals/themes/ThemesModal.vue | none |
| `logs` | modals/logs/LogsModal.vue | `{ connectionId: string \| null }` |
| `panels` | modals/panels/PanelsModal.vue | `{ connectionId: string \| null }` |
| `php` | modals/php/PhpSettingsModal.vue | `{ connectionId: string \| null }` |
| `wrapped` | modals/wrapped/WrappedModal.vue | `{ year?: number }` |
| `share` | modals/share/ShareGistModal.vue | `{ code: string; connectionId?: string \| null }` |
| `tablePreview` | output/TablePreviewModal.vue | `{ value: DumpNode; title?: string }` |
| `objectGraph` | output/ObjectGraphModal.vue | `{ value: DumpNode; title?: string }` |
| `htmlPreview` | output/HtmlPreviewModal.vue | `{ html: string; title?: string; tabId?: string }` |
| `confirm` | common/ConfirmModal.vue | `ConfirmOptions & { prompt? }` — use `ui.confirm()` / `ui.prompt()` |


---

## Commands (`@/commands`)

```ts
executeCommand(id: CommandId): Promise<void>   // never rejects; errors become toasts
commandList(): CommandInfo[]                    // COMMAND_META + { id, shortcut, shortcutLabel, enabled }
isCommandEnabled(id): boolean                   // e.g. cancelRun only while running, run only for code tabs
commandShortcut(id): string                     // effective accelerator
commandShortcutLabel(id): string                // "⇧⌘P" / "Ctrl+Shift+P"
isCommandId(x): x is CommandId
handleKeydown(event): boolean                   // renderer shortcut dispatcher (installed on window)
installCommands(): () => void                   // 'menu:command' + keydown listener
```
Sources: native menu (`menu: true` commands, via `menu:command`), the renderer keydown listener (`menu: false`
commands — or every command when `api.isMock`), palette and buttons. Plain-key shortcuts (ESC) are ignored while a
modal / context menu / popover is open or in form fields. While a modal is open only `closeTab`, `commandPalette`,
`openSettings`, `showHistory`, `showSnippets`, `showLogs`, `zenMode`, `run` pass the renderer listener.

Notable implementations: `closeTab` closes the top modal first; `showHistory/showSnippets/showLogs/openSettings/
commandPalette` toggle; `toggleToolbar` and `toggleSidebar` both toggle the icon sidebar (`showToolbar`, the
"toolbar" setting; ⌘\ is the "purist mode" alias); `zenMode` = `ui.toggleZen()`; `zoomIn/zoomOut/resetZoom` change
`editorFontSize` (8–40) and `outputFontSize` (8–32); `toggleFullscreen` uses the HTML fullscreen API;
`focusEditor` (ESC) leaves zen mode, hides the output when `autoHideOutput`, focuses the editor; `saveOutput` /
`copyResult` use `resultToText()`; `addToSnippets` / `addSelectionToSnippets` open `snippetSave`; `shareGist` opens
`share`; `toggleDebugging` → `connections.toggleDebug()`; `phpSettings`/`showPanels`/`showLogs` pass the active
tab's `connectionId`.

---

## Themes (`@/themes`)

```ts
builtinThemes(): readonly ThemeDefinition[]   // Tinkerbox (default), Tinkerbox Dark, Dracula, Ember Dark/Light,
                                              // Material, Night Owl, Nord, Shades of Purple, Snow Forest,
                                              // Solarized Dark/Light, GitHub, GitHub Dark, Kew, Christmas, One Dark, Monokai
customThemeList(), customThemesRef            // custom themes (readonly ref), from 'themes:listCustom'
allThemes(): ThemeDefinition[]                // built-ins + custom
getTheme(id): ThemeDefinition | undefined     // ids are kebab-case ('night-owl'); legacy names ('Github', 'Shades Of Purple') work
resolveTheme(id, preferDark?)                 // with fallback to 'tinkerbox' / 'tinkerbox-dark'
normalizeThemeId(id), effectiveThemeId(settings, osDark), themeForSettings(settings, osDark)
currentTheme: ShallowRef<ThemeDefinition>     // applied theme (incl. preview) — the editor watches it → monaco.editor.setTheme(t.monacoName)
osDark: Ref<boolean>                          // matchMedia + 'theme:osChanged'
previewTheme(id | null), previewThemeId      // Themes modal live preview (null restores the configured theme)
loadCustomThemes(): Promise<ThemeDefinition[]> // reload from disk (deduped)
setCustomThemes(list: CustomTheme[])
applyTheme(theme, root?)                       // writes vars on :root, data-dark, data-theme, color-scheme
startThemeSync(source)                         // bootstrap only
interface ThemeDefinition { id; name; dark; custom; monacoName /* tw-<id>, [a-z0-9-] */; vars: ThemeVars; monaco: MonacoThemeData /* = IStandaloneThemeData */ }
```
The editor registers every theme with `monaco.editor.defineTheme(t.monacoName, t.monaco)` (re-register when
`customThemesRef` changes) and follows `currentTheme`. Built-in Monaco rules cover `comment`, `string`,
`string.escape`, `number`, `keyword`, `variable`, `variable.predefined`, `delimiter`, `operator`, `metatag`, `type`,
`class`, `function`, `constant`, `namespace`, `attribute.*`, `tag`, `regexp`, `invalid`.

Custom themes (Monaco theme JSON + `custom` block): chrome is derived from the `custom` block — `primary.background` (accent),
`primary.textColor`/`primary.foreground` (on-accent), `secondary.background` (chrome bg), `background`, `alternate`,
`surface`, `border`, `text`, `mutedText`, `sidebar`, `titlebar` — falling back to Monaco colors
(`editor.background/foreground`, `editorCursor.foreground`, …). Their Monaco data is used as-is.

### CSS tokens
Variables on `:root` (always hex): `--tw-bg` (window chrome), `--tw-bg-alt` (output pane / welcome background),
`--tw-surface` (cards, modals, popovers), `--tw-border`, `--tw-text`, `--tw-text-muted`, `--tw-accent`,
`--tw-accent-fg` (text on accent), `--tw-accent-soft` (selected rows, soft fills), `--tw-hover`, `--tw-active`,
`--tw-danger`, `--tw-warning`, `--tw-success`, `--tw-sidebar-bg`, `--tw-titlebar-bg`, `--tw-scrollbar`,
`--tw-editor-bg` (= Monaco editor.background), `--tw-input-bg`, `--tw-overlay` (modal backdrop), `--tw-selection`,
dump colors `--tw-code-string`, `--tw-code-number`, `--tw-code-keyword`, `--tw-code-class`, `--tw-code-property`,
`--tw-code-comment`, `--tw-code-null`, `--tw-code-bool`, `--tw-code-key`, `--tw-code-meta`.
`<html data-dark="true|false" data-theme="<id>" data-platform="darwin|win32|linux">`; Tailwind `dark:` variant
follows `data-dark`.

Tailwind utilities (style.css `@theme inline`; opacity modifiers work, e.g. `bg-accent/10`):
`app` (bg), `app-alt`, `surface`, `line` (border), `fg` (text), `muted`, `accent`, `on-accent`, `accent-soft`, `hover`,
`active`, `danger`, `warning`, `success`, `sidebar`, `titlebar`, `scrollbar`, `editor`, `input`, `overlay`,
`selection`, `code-string|number|keyword|class|property|comment|null|bool|key|meta` → `bg-surface`, `text-muted`,
`border-line`, `text-code-string`… Fonts: `font-sans`, `font-mono` (Fira Code). Utility classes: `drag-region`,
`no-drag`, `selectable` (body is `user-select: none`), `scrollbar-none`, `tabular`. Transitions: `tw-fade`, `tw-pop`.
Layout surfaces: output pane background `bg-app-alt`, cards `bg-surface border-line rounded-xl`, editor `bg-editor`.

---

## Common components (`@/components/common/*.vue`)

| component | props | slots / events |
| --- | --- | --- |
| `Button` | `variant: primary\|secondary\|default\|ghost\|danger` (default `default`), `size: xs\|sm\|md\|lg`, `type`, `disabled`, `loading`, `block`, `icon`, `iconRight` (lucide components) | default slot; native click |
| `IconButton` | `icon` (required), `label` (aria + tooltip), `command?: CommandId` (tooltip shortcut from settings) or `shortcut?: string`, `active`, `disabled`, `size: xs\|sm\|md\|lg`, `variant: ghost\|soft`, `tooltipPlacement`, `noTooltip`, `iconSize`, `strokeWidth` | `click`; slots default (custom glyph), `badge` |
| `Tooltip` | `text`, `shortcut` (accelerator), `placement` (`top`… `bottom-end`), `delay` (450), `disabled`, `block` | default (trigger), `content` (rich) |
| `Kbd` | `accelerator` or `keys: string[]`, `size: xs\|sm\|md`, `subtle` | — |
| `Modal` | `title`, `size: sm\|md\|lg\|xl\|full`, `height`, `position: center\|top`, `closable`, `closeOnBackdrop`, `padded`, `hideHeader`, `initialFocus` (selector), `bodyClass`, `ariaLabel` | default, `title`, `actions` (header), `header` (replace), `footer`; `close`. ESC (top-most only, ignored when `defaultPrevented`), focus trap + restore, accent header rule |
| `Popover` | `v-model:open`, `placement`, `trigger: click\|hover\|manual`, `offset`, `id` (exclusive via ui.popover), `openDelay`, `closeDelay`, `panelClass`, `block` | `trigger` ({ open, toggle }), default ({ close }); exposes `open/close/toggle/reposition` |
| `ContextMenu` | host (mounted once in App) | driven by `ui.openContextMenu()`; ↑/↓/Home/End/Enter/ESC |
| `Toggle` | `v-model: boolean`, `label`, `description`, `disabled`, `size: sm\|md` | — |
| `Select` | `v-model`, `options: Array<{ value, label, disabled? } \| string \| number>`, `placeholder`, `disabled`, `size`, `block` | — (native select, generic over value type) |
| `TextInput` | `v-model: string`, `placeholder`, `type`, `icon`, `clearable`, `folderPicker` (+`pickerTitle`), `monospace`, `disabled`, `readonly`, `size: sm\|md\|lg`, `error`, `autofocus`, `spellcheck` | `enter`, `escape`, `picked`; slot `suffix`; exposes `focus()`, `select()`, `el` |
| `SegmentedControl` | `v-model`, `options: Array<{ value, label?, icon?, title?, disabled? }>`, `size`, `block` | — |
| `Badge` | `variant: neutral\|accent\|success\|warning\|danger`, `color` (CSS color), `size: xs\|sm`, `dot` | default |
| `Spinner` | `size` (16), `strokeWidth`, `label` | — |
| `EmptyState` | `icon`, `title`, `description`, `compact` | `description`, `actions` |
| `SplitView` | `v-model:ratio` (first pane fraction), `layout: vertical\|horizontal` (settings semantics: vertical = side by side), `minFirst`, `minSecond` (px), `defaultRatio`, `minRatio`, `maxRatio`, `showSecond` | `first`, `second`; `commit(ratio)` at drag end / double-click reset / keyboard |
| `Toasts` | host (mounted once) | driven by `ui.toast()`; hover pauses |
| `ConfirmModal` | see `confirm` modal | `close(true\|false\|string\|null)` |

Types for `Select`/`SegmentedControl` options: `components/common/types.ts` (`SelectOption`, `Segment`).

## Layout

- `TitleBar` (40 px drag region; macOS traffic-light inset 84 px, Windows/Linux overlay space 140 px right): centered
  `Tinkerbox - <tab>`; for code tabs: SQL toggle (Cards view only), Cards + CLI icons.
- `Sidebar` (52 px): Run (play / spinner / stop on hover / bug when debugging), Open folder (click: picker; hover or
  right-click: recent folders popover — click opens in the current tab, ⌘/Ctrl-click in a new tab), History,
  Snippets, Logs … Settings.
- `TabsBar`: active tab uses the content's background, project color dot, spinner while running, eye when
  watching, dirty dot, middle-click close, double-click rename, context menu, drag reorder, "+".
- `Workspace` (`tabId`): `SplitView` of `EditorPane` / `OutputPane` (both receive `tabId`; output hidden with
  `ui.showOutput`); ratio persisted to `settings.splitRatio` on release.
- `StatusBar`: framework label (result driver → environment driver; "Plain PHP" without a project) + ⓘ → `panels`,
  `PHP x.y.z` → `php`, time / memory (tooltip: start time, code vs framework boot vs total), Xdebug + Auto badges,
  autocompletion status (click = re-index), `#vim-status-<tabId>`, output chevron.
- `GetStarted`: "Hi there!", Laravel Sandbox start/install with live log line, open folder, plain PHP, example
  script, recent folders, Herd sites, tips with shortcuts, "Show this tab when Tinkerbox starts" toggle.

## Utils
- `accelerator.ts`: `parseAccelerator(accel, platform)`, `formatAccelerator(accel, platform)` ("⇧⌘P" /
  "Ctrl+Shift+P"), `acceleratorParts()`, `matchesAccelerator(event, accel, platform)` (layout-aware incl. Option
  characters and Plus), `eventToAccelerator(event, platform)` (key capture → "CmdOrCtrl+Shift+P"),
  `hasStrongModifier()`.
- `fuzzy.ts`: `fuzzyMatch(query, text)` → `{ score, indices }`, `fuzzyFilter(items, query, keys, { limit,
  secondaryKeyWeight })` → `{ item, score, keyIndex, indices }[]` (substring > subsequence > typo tolerant;
  empty query keeps order), `highlightSegments(text, indices)`.
- `format.ts`: `formatDuration` (129.31ms / 1.26s / 2m 05s), `formatBytes` (3.37MB), `formatTime`,
  `formatDateTime`, `dayKey`, `dayLabel` (TODAY / YESTERDAY / "MONDAY, OCTOBER 5"), `groupByDay`, `relativeTime`,
  `truncate`, `firstLine`, `pluralize`.
- `platform.ts`: `platform`, `isMac`, `isWindows`, `isLinux`, `modKeyLabel()`, `fileManagerName()`, `basename`,
  `dirname`, `tildify(path, home)`.
- `dumpText.ts`: `dumpPreview(node, max)`, `dumpToText(node)`, `exceptionToText(e)`, `resultToText(result, opts)`.
- `color.ts`: `parseHex`, `toHex`, `mix`, `withAlpha`, `flatten`, `luminance`, `contrastRatio`, `isDark`,
  `readableOn`, `shade`.
- `position.ts`: `computePosition(anchorRect, size, placement, offset)`, `menuPosition()`, `focusableIn(root)`.
- `merge.ts`: `cloneJson`, `deepMerge` (settings patch semantics), `isPlainObject`. `id.ts`: `uid(prefix?)`.

## Tests
`tests/unit/renderer/*.test.ts` (vitest, node env): fuzzy, accelerator, format, themes (completeness, contrast,
custom theme derivation), tabs (init/restore, persistence, run/selection/lineOffset/prettify/cancel/streaming,
auto-run, close/reopen/duplicate/rename, files), ui (modal stack, confirm/prompt, toasts), commands (registry,
every command executes, keyboard dispatch). `helpers.ts` provides `fakeBridge()` (mock bridge + overrides + call
log + `emit`), `fakeEditor()`, `okResult()`, `deferred()`.
