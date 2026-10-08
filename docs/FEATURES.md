# Tinkerbox feature checklist

> **Roadmap:** remote transports (SSH, Docker, …) via the Transport extension point (see `docs/ARCHITECTURE.md` §2.1).

Legend: the area codes in brackets refer to the source map in `docs/ARCHITECTURE.md`. `[x]` = implemented and
verified end-to-end in the built app by `tests/e2e/smoke.mjs` (Playwright + Electron, real PHP, read-only Laravel
project; see the script header). An item the smoke test does not cover (fully) names its other checks in a
*Verified:* note: the unit / PHP suites plus a check in the built app with an isolated profile (`--user-data-dir`)
and, for features that write into the home folder, `HOME` set to a temporary directory. `[ ]` = not verified
end-to-end; the note says why. *(account)* = needs a token supplied by the user.

## Execution & runner
- [x] F01 Run code ⌘R / Ctrl+R and sidebar ▶; spinner while running; Run again stops the script [R1, E1]
- [x] F02 Run selected code (setting "Evaluate selected code, if available" + context menu) with correct line mapping [R2, P1]
- [x] F03 Fresh PHP process per run; framework bootstrapped each run [P1, E1]
- [x] F04 Leading `<?php` stripped; missing trailing semicolon tolerated [P1]
- [x] F05 Return value of the last expression shown (PsySH semantics) [P1]
- [x] F06 `declare(strict_types=1)` toggle [P1]
- [x] F07 Provisional classes/functions/interfaces declared in the editor [P1]
- [x] F08 Tinker-style class aliasing (`User::first()` without namespace) [P3]
- [x] F09 Output type: buffered vs realtime streaming [P1, E1, R3]
- [x] F10 Timeout + cancel; `exit`/`die`/`dd()` handled; fatal errors captured [P1, E1]
- [x] F11 Warnings/notices/deprecations collected as diagnostics instead of aborting [P1]
- [x] F12 Execution time + peak memory per run (footer, seconds above 1000 ms, tooltip with start time) [P1, R1]
- [x] F13 Auto-evaluate (live) mode ⇧⌘A [R1]
- [x] F14 Xdebug step debugging toggle per project (PHP Settings modal, footer badge; Herd's Xdebug extension is loaded when needed) [E1, R1, R5] — *Verified:* `argv.test.ts`; built app: `xdebug.mode=debug` only for the toggled project
- [x] F15 Laravel Sandbox ("Default" tab) — installable via composer; a sandbox prepared at build time (`npm run prepare:sandbox`) is used without installing [E1, R1] — *Verified:* `sandbox.test.ts`; built app: the composer install (`sandbox:install`) succeeds, then `app()->version()` runs in the sandbox. Packaged builds ship a prepared sandbox as an extra resource and copy it to the user data folder on first use; no test covers a packaged build
- [x] F16 Default Working Directory setting for new tabs [E2, R1]
- [x] F17 Per-project PHP binary (footer → PHP Settings modal; path or Herd alias like php83) [E1, R5]
- [x] F18 PHP binary auto-detection (Herd, Homebrew, MAMP, XAMPP, Laragon, system, PATH) with version line [E1, R4] — *Verified:* `php-binaries.test.ts`; built app: Herd 7.4 – 8.5 and Homebrew binaries listed with versions

## Frameworks & drivers
- [x] F20 Built-in drivers: Laravel, Lumen, Laravel Zero, Statamic, October CMS, Testbench, Symfony, WordPress (+Bedrock), Radicle, Drupal 7, Drupal 8+, Craft CMS, Magento 2, Shopware, Kirby, Moodle, PrestaShop, TYPO3, CakePHP, CodeIgniter 4, Yii 2, Joomla, Composer, plain PHP [P3] — *Verified:* PHP driver suite + `detect-project.test.ts` against a fixture per driver (`tests/fixtures/projects`); smoke: a real Laravel project
- [x] F21 Custom drivers (`~/.config/tinkerbox/drivers/*.php`, `<project>/.tinkerbox/drivers/*.php`, subclasses of `Tinkerbox\Drivers\Driver` or a built-in) [P3] — *Verified:* smoke (project drivers); `CustomDriversTest.php`; built app with a temporary `HOME`: a global driver is detected and injects its variables
- [x] F22 Driver API (`Tinkerbox\Drivers\Driver`): id, name, canBootstrap, bootstrap, version, variables, listenForQueries, afterRun, panels, logsPath, prettyErrors, files, models [P3] — *Verified:* smoke (custom driver: version, variables, panels, logs path, bootstrap error); `DriverApiTest.php`
- [x] F23 Framework + version in footer (`Laravel 12.20.0 ⓘ`) [P3, R1]
- [x] F24 Panels modal (click framework label): App Information via `artisan about --json` + custom driver panels [P4, R5]

## Output
- [x] F30 Cards view: one card per echo / dump / var_dump / return value / query, in execution order, `Line N` label [P1, R3]
- [x] F31 VarDumper-style collapsible tree with `#id`, visibility markers, nested collapsed by default (setting) [P2, R3]
- [x] F32 Eloquent models (attributes/relations), collections, Carbon, enums, closures, builders (SQL), exceptions rendered specially [P2, R3]
- [x] F33 CLI mode ⇧⌘C: PsySH-style text output in a read-only editor, clickable links [R3]
- [x] F34 SQL toggle in title bar: query cards with pretty-printed SQL + bindings substituted, time [P1, P3, R3]
- [x] F35 Table Preview modal: search, N entries, Export CSV, right-click row → Copy as PHP array / Copy as JSON [R3]
- [x] F36 Object Graph modal: node graph of objects/models and relations with counts, expand on click [R3]
- [x] F37 HTML Preview modal for Views / Mailables / MailMessage / Htmlable; ⌘R refreshes [P2, R3]
- [x] F38 Collision-style exceptions: class, message, code snippet, stack trace (vendor collapsed), toggle globally / per driver [P2, R3]
- [x] F39 Inline errors in the editor next to the failing line (setting) [R2]
- [x] F40 dump()/dd() card file path opens the file at that line in the preferred editor [R3, E3]
- [x] F41 Clear output (Ctrl+L), Save output to file, Copy result, Copy as Markdown [R3, R1]
- [x] F42 Bootstrap errors reported clearly (driver failed to boot) [P1, R3]

## Editor
- [x] F50 Monaco editor, PHP without `<?php` tag, heredoc highlighting, line numbers, current line, indent guides (setting), ligatures (setting) [R2]
- [x] F51 Magic comments: `//?`, `//? label`, `/*?*/`, `/*?->method()*/`, `//?->prop`, `/*?.*/` timing; inline badges; loop hit counts [P1, R2]
- [x] F52 Code coverage gutter (executed lines) [P1, R2]
- [x] F53 Autocompletion: keywords, PHP functions with signatures, project classes, Laravel facades/models (members, scopes, columns), driver variables, local variables [P4, R2] — *Verified:* smoke (`Str::` members, functions, local variables); `IntrospectorTest.php` (models, scopes, columns); built app against the Laravel Sandbox: scope, column and relation suggestions on `User`, `Cache::` facade members, `$app` and its members
- [x] F54 Hover docs & signature help from introspection [R2]
- [x] F55 Import missing class (add `use` statement) code action [R2]
- [x] F56 Prettify code ⌘P (Prettier PHP), quote style, prettify on run [R2]
- [x] F57 Vim keymap (monaco-vim) with status in the footer [R2, R1]
- [x] F58 Editor context menu: Add code to Snippets, Add magic comment at end of line ⇧⌘M, Add selected code to Snippets, Run selected code, Trigger Completion [R2]
- [x] F59 Double-click selects `$variable` including `$`; ESC closes search; multi-cursor [R2]
- [x] F60 Font family / size, zoom ⌘+ / ⌘- / ⌘0, word wrap, minimap [R2, R1]

## Tabs, layout & window
- [x] F70 Tabs: + button, ⌘T new, ⌘W close (last tab → Get started), ⇧⌘D duplicate, ⇧⌘T reopen, Ctrl+Tab cycling, double-click rename (session), middle-click close, context menu (Close / Close Others / Close to the Right / Close All / Duplicate / Rename) [R1]
- [x] F71 Each tab has its own project, output mode, SQL toggle; badge in the project's color [R1]
- [x] F72 Get started (welcome) tab: Start Laravel Sandbox / Open local directory, recent folders, Herd sites, example script; setting to disable [R1] — *Verified:* smoke (tab, example script); built app: Laravel Sandbox card, Herd sites list, the setting hides the tab after a restart
- [x] F73 Session restore (tabs, code, folders) [R1, E2]
- [x] F74 Window title `Tinkerbox - <tab name>` [R1, E2]
- [x] F75 Layout toggle Ctrl+. (output right / below), draggable splitter, toggle output ⌘⌥⇧O + footer chevron, toggle toolbar ⌘⌥⇧T, zen mode, auto-hide output on ESC, always on top, fullscreen [R1, E2]
- [x] F76 Footer status bar: framework ⓘ, PHP version, time/memory, autocompletion status, vim status, output chevron [R1]
- [x] F77 Ask before closing tab (setting) [R1]
- [x] F78 Open / save / watch `.php` files (⇧⌘O, ⌘S, ⇧⌘S, ⇧⌘W re-run on change) [E2, R1]

## Projects
- [x] F80 Open local project ⌘O + recent folders (also macOS dock menu) [E2, R1]
- [x] F92 Laravel Herd: PHP binaries & aliases, per-version php.ini env, Herd sites in Get started / Open Anything [E1, R1] — *Verified:* smoke (per-project Herd alias); `php-binaries.test.ts`, `herd-sites.test.ts`; built app: Herd sites listed

## History, snippets, logs, palette
- [x] F100 History modal ⌘Y / Ctrl+I: project filter, fuzzy search, grouped by day, preview, Open (Enter) / Open in new tab (⌘Enter) / Create snippet / delete, keyboard navigation; configurable size (default 150) [R4, E2]
- [x] F101 Snippets modal ⌘B: All | Project | Filter, fuzzy search, list + detail (label, description, code, project badge), Enter = open in current tab with assigned project, ⌘Enter = new tab, ⇧Enter = insert into current tab, edit/delete, import/export [R4, E2]
- [x] F102 Project snippets from `<project>/.tinkerbox/snippets/*.php` (`@label`, `@description`), read-only, "Defined in project snippets" [P4, E1, R4]
- [x] F103 Log Viewer ⌘L: files grouped by directory, level filter, search, N entries, expandable stack traces, polling interval, open folder; Laravel/Monolog + generic formats [P4, E1, R5]
- [x] F104 Open Anything ⇧⌘P: fuzzy, grouped; prefixes `#` snippets, `/` recent folders, `>` commands; all commands [R4]
- [x] F105 Fuzzy search everywhere (snippets, recent folders, history, commands) [R1]

## Settings & customization
- [x] F110 Settings (⌘,): General, Appearance, Behaviour, Output, Shortcuts, Advanced, Updates, About [R4]
- [x] F111 Customizable keyboard shortcuts with key capture + search; native menu updates [R4, E2]
- [x] F112 Themes modal with Built-in list (moon/sun), live preview, Save; sync with OS dark/light [R4, R1]
- [x] F113 Custom themes: Monaco JSON + `custom` chrome block in `~/.config/tinkerbox/themes`; create / open folder / reload [R4, E2] — *Verified:* `themesWindow.test.ts`, `themes.test.ts`; built app with a temporary `HOME`: a created theme is written to `~/.config/tinkerbox/themes` and listed
- [x] F114 Corrupted settings detection & recovery [E2]
- [x] F115 Recents: clear folders [R4, E2]
- [x] F116 CLI helper `tinkerbox [path]` + `tinkerbox://open?cwd=` deep links + single instance [E2] — *Verified:* smoke (second instance + deep link); `cli.test.ts`, `deeplinks.test.ts`; built app with a temporary `HOME`: the helper is linked into `~/.local/bin`
- [x] F117 Updates / About pages (version, Electron/Chrome/Node versions, data paths) [R4]
- [x] F118 Year in Review: yearly usage stats with persona [E2, R5]

## Integrations
- [x] F125 Preferred editor (VS Code, Cursor, Windsurf, PhpStorm, Sublime, Zed, TextMate, Nova, BBEdit); open project in editor [E3, R4]
- [ ] F126 Share code as GitHub Gist (secret or public) *(account)* [E3, R5] — requires a GitHub token; `createGist` is unit-tested against a mocked GitHub API only
