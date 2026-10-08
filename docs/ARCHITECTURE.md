# Tinkerbox architecture

Tinkerbox is an open-source desktop code runner for PHP and Laravel: write code in an editor, run it inside a
project (booted by a framework driver) and inspect the result, dumps, queries and errors. Code runs on this
machine with a local PHP binary.

> **Roadmap:** remote transports (SSH, Docker, …) via the Transport extension point (see §2.1).

The stack:

**Electron 44 · electron-vite 5 · Vite 7 · Vue 3.5 (`<script setup lang="ts">`) · Pinia 3 · Tailwind CSS 4 · Monaco 0.57 · monaco-vim · Prettier + @prettier/plugin-php · TypeScript 5.9 strict.**

PHP code runs in a **fresh PHP process per run**. The main process concatenates the dependency-free runner sources
in `resources/php/` into one script, appends a base64 payload (user code + options) and writes it to the PHP
process's **stdin**, so nothing is ever written into the project. The bundle is self-contained: a transport only has
to deliver it to a PHP process's stdin and hand back stdout / stderr.

```
┌──────────── renderer (Vue 3 + Pinia) ────────────┐    contextBridge: window.tinkerbox (src/shared/ipc.ts)
│ title bar · icon sidebar · tabs · Monaco editor   │ ─────────────┐
│ output (Cards / CLI) · modals               │              ▼
└───────────────────────────────────────────────────┘   ┌──────────── main process ────────────┐
                                                         │ stores: settings/connections/…       │
                                                         │ execution: bundle → transport →      │
                                                         │   parseEnvelope → RunResult          │
                                                         │ integrations: editor links, Gist     │
                                                         └──────────────┬───────────────────────┘
                       stdin:  <?php runner sources … \Tinkerbox\Runner::main(payload)
                                                                        ▼
                         php  (local transport: a child process of the main process)
                       stdout: …noise… \n{nonce}BEGIN\n{json}\n{nonce}END\n
```

## Source map

The area codes are used in the section headings below and in `docs/FEATURES.md`.

| Area | Files |
| --- | --- |
| **shared** | `src/shared/{types,ipc,defaults,shortcuts}.ts`, `resources/php/manifest.json`, `tests/php/run.php`, build and test configuration |
| **P1 runner core** | `resources/php/src/{Runner,CodeTransformer,Capture,Magic,helpers}.php`, `resources/php/tinkerbox.php`, `tests/php/runner/**` |
| **P2 dumper** | `resources/php/src/{Dumper,ExceptionFormatter}.php`, `tests/php/dumper/**` |
| **P3 drivers** | `resources/php/src/Drivers/**`, `resources/php/src/Panels/**`, `resources/php/src/{DriverRegistry,ClassAliasLoader}.php`, `src/main/execution/detectProject.ts`, `tests/php/drivers/**`, `tests/fixtures/projects/**`, `tests/unit/execution/detect-project.test.ts` |
| **P4 data modes** | `resources/php/src/{Introspector,LogReader,Panels,ProjectSnippets}.php`, `tests/php/data/**` |
| **E1 execution** | `src/main/execution/**`, `src/main/php/**`, `src/main/env/**`, `src/main/sandbox/**`, `scripts/prepare-sandbox.mjs`, `tests/unit/execution/**` |
| **E2 shell** | `src/main/index.ts`, `src/main/{menu,windows,deeplinks,cli,themes,paths}.ts`, `src/main/ipc/**`, `src/main/store/**`, `src/preload/**`, `resources/bin/**`, `tests/unit/shell/**` |
| **E3 integrations** | `src/main/integrations/{editorLinks,gist}.ts`, `tests/unit/integrations/**` |
| **R1 renderer shell** | everything under `src/renderer/` except the folders below: stores, api, commands, themes, layout, common components, the Get started tab (`docs/RENDERER.md`) |
| **R2 editor** | `src/renderer/src/components/editor/**`, `src/renderer/src/monaco/**` |
| **R3 output** | `src/renderer/src/components/output/**` |
| **R4 modals A** | `src/renderer/src/components/modals/{settings,palette,history,snippets,themes}/**` |
| **R5 modals B** | `src/renderer/src/components/modals/{logs,panels,php,wrapped,share}/**` |

Dependencies: the main process uses `electron-log` at runtime. The renderer bundles `vue`, `pinia`, `monaco-editor`,
`monaco-vim`, `prettier`, `@prettier/plugin-php`, `lucide-vue-next`, `marked`, `dompurify` and
`@fontsource/fira-code`. Tests use `vitest` and `playwright`.

Commands: `npm run typecheck`, `npx electron-vite build`, `npm test` (vitest), `npm run test:php`,
`node tests/e2e/smoke.mjs` (end-to-end, see its header). The app spawns PHP with `-d xdebug.mode=off` unless step
debugging is turned on for the project, and the PHP suite runs with `php -d xdebug.mode=off`. The smoke test opens a
real Laravel project **read-only** (`TINKERBOX_TEST_LARAVEL`) and only runs side-effect-free code
(`app()->version()`, `config('app.name')`, in-memory SQLite); it fails when a file of that project changes.

---

## 1. PHP runner (P1–P4)

### 1.1 Source rules
- Files listed in `resources/php/manifest.json` are concatenated in that order (leading `<?php` stripped).
- Each file starts with `<?php` and contains **only braced namespace blocks** (`namespace Tinkerbox { … }`,
  `namespace { … }` for global code). No `declare(strict_types=1)`, no closing `?>`, no code outside blocks.
- Runner sources must run on **PHP 7.4 → 8.5** (7.4 is still common on servers). No PHP-8-only syntax in runner
  sources (no `match`, nullsafe `?->`, named args, enums, `readonly`, union types, `mixed`, constructor
  promotion, `static` return type). Feature-detect (`PHP_VERSION_ID`, `function_exists`, `class_exists`).
  Tokenizer differences: PHP 8 has `T_NAME_QUALIFIED`/`T_NAME_FULLY_QUALIFIED`/`T_NAME_RELATIVE`; PHP 7.4 uses
  `T_STRING` + `T_NS_SEPARATOR`. Define missing `T_*` constants defensively.
- Every runner class lives in `Tinkerbox\…` (drivers in `Tinkerbox\Drivers`, the panel builder in `Tinkerbox\Panels`).
  Only custom drivers (user files, §1.7) may declare classes elsewhere.
- Never let a runner bug kill the envelope: wrap risky work in try/catch and degrade gracefully.
- `resources/php/tinkerbox.php` (P1): dev entry — requires manifest files and runs
  `\Tinkerbox\Runner::main(json_decode(file_get_contents($argv[1]), true))`.

### 1.2 Payload (JSON, base64-embedded by the bundler)

```jsonc
{
  "nonce": "tw_8f3a91c2…",          // per run; output markers
  "mode": "run",                     // run | environment | members | detect | logs | logRead | panels | snippets
  "projectPath": "/Users/me/app",    // "" => plain PHP (no framework)
  "driver": "",                      // forced driver id, "laravel-booted" (an application already booted in-process), or ""
  "code": "<base64 utf-8>",          // run mode
  "lineOffset": 1,                   // editor line of the first code line (selection runs)
  "className": "",                   // members mode
  "logFile": "", "logLimit": 500,    // logRead mode
  "homePath": "/Users/me",           // for global drivers in ~/.config/tinkerbox/drivers ("" => getenv HOME/USERPROFILE)
  "options": { "maxDepth": 8, "maxItems": 500, "maxStringLength": 10000, "captureQueries": true,
               "magicComments": true, "coverage": true, "strictTypes": false,
               "outputType": "buffered", "timeoutMs": 120000 }
}
```

### 1.3 Envelope
At the end of every mode (also from the shutdown handler after `exit`, `dd()` or a fatal error — exactly once):

```
\n{nonce}BEGIN\n{json}\n{nonce}END\n
```

`json` = `PhpEnvelope` (run) or `PhpDataEnvelope<T>` (data modes), encoded with
`JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE`
(define fallbacks for 7.4 where needed). `display_errors` → stderr. Text outside the markers is shown as raw output.

Data-mode payloads (`data` field):

| mode | data |
| --- | --- |
| `environment` | `EnvironmentInfo` |
| `members` | `ClassMembers \| null` |
| `detect` | `{ "driver": DriverInfo, "phpVersionLine": string }` |
| `logs` | `LogListing` (root = driver `logsPath()` or `<project>/storage/logs`) |
| `logRead` | `LogEntry[]` newest first, max `logLimit` |
| `panels` | `AppPanel[]` |
| `snippets` | `Array<{ name, description, code, file }>` from `<project>/.tinkerbox/snippets/*.php` |

### 1.4 Run mode (`\Tinkerbox\Runner`, P1)
1. `error_reporting(E_ALL)`, `ini_set('display_errors','stderr')`, `set_time_limit(ceil(timeoutMs/1000))`,
   record `$start = microtime(true)` (for `/*?.*/`), register the shutdown handler.
2. `chdir(projectPath)` if set. Detect driver: `$driver = \Tinkerbox\DriverRegistry::detect($projectPath, $forced, $homePath)`.
3. `bootMs` around `$driver->bootstrap($projectPath)`. Bootstrap throwable → `exception` (with `bootstrap: true`), no code runs.
4. `\Tinkerbox\ClassAliasLoader::register($projectPath)`.
5. Capture hooks: Symfony VarDumper handler (if `Symfony\Component\VarDumper\VarDumper` exists) →
   `Capture::dumpFromHandler($value)` (call site from backtrace); global helpers when undefined: `dump()`, `dd()`,
   `tw($value, $label = null)`. Queries (when `captureQueries`): `$driver->listenForQueries([Capture::class, 'query'])`
   (a throwing listener registration becomes a diagnostic).
6. Install the runner error handler after bootstrap: E_WARNING/E_NOTICE/E_DEPRECATED/E_STRICT (+USER variants)
   → `diagnostics[]` and continue; everything else → `ErrorException`.
7. `$t = \Tinkerbox\CodeTransformer::transform($code, $options, $lineOffset)` (see 1.5) →
   `['code' => string, 'hasReturnValue' => bool, 'returnLine' => ?int]`.
8. Evaluate inside a static closure: `extract($driver->variables())`, `ob_start()` (buffered mode),
   `eval($t['code'])`, catch `Throwable` → `ExceptionFormatter::format($e, $ctx)`. In realtime mode no output
   buffering: echo goes straight to stdout (main streams it); events still record dumps/queries.
9. `Capture::flushOutput()`; `$driver->afterRun()` (exactly once, also after `exit()`); dump the return value with `Dumper::dump()`;
   emit envelope with `events`, `returnValue`, `hasReturnValue`, `magic`, `coverage`, `exception`,
   `diagnostics`, `bootMs`, `durationMs` (eval only), `memoryPeak` (`memory_get_peak_usage(true)`), `exited`.
10. Shutdown handler (exit / `dd()` / fatal / time limit / memory exhaustion): emits the envelope exactly once.
    After a **fatal** error it then ends the request (`exit(255)`), so shutdown functions registered later — the
    fatal-error renderers / reporters frameworks install while bootstrapping (Laravel `HandleExceptions`,
    Collision, Whoops, Symfony `ErrorHandler`) — never print the error again outside the envelope or log it.
    After `exit()` / `dd()` later shutdown functions still run normally.

**Line mapping.** The transformed code keeps every original line at the same line number. The eval'd code's
file name is `<runner file>(<eval line>) : eval()'d code` — compute it once (`__FILE__`, the eval line) and treat
frames with that file as user code: `editorLine = line + lineOffset - 1`.

**Event capture (`\Tinkerbox\Capture`, P1).** One ordered list of `OutputEvent`s with a global `seq`:
- `flushOutput()` moves the current output-buffer contents into an `echo` event (no line) — call it before
  recording any other event and at the end.
- `echoAt(int $line, ...$parts)` — rewritten `echo` statements; records `echo` event with `line`.
- `dumpAt(int $line, string $fn, array $values)` — rewritten `dump()`/`dd()`/`var_dump()` calls in user code;
  one `dump` event per value (`userCode: true`); returns the first value (like Laravel's `dump()`); `dd` sets
  `exited` and calls `exit` after recording.
- `dumpFromHandler($value)` — VarDumper handler (dump() called from project code): `file`/`line` from the backtrace,
  `userCode` when the frame is the eval'd buffer.
- `query($sql, $bindings, $timeMs = 0.0, $connection = 'default')` — `rawSql` with bindings substituted
  (strings quoted/escaped, null → NULL, bool → 1/0, DateTime → quoted Y-m-d H:i:s); `line` = first user-code frame.
- Caps: max 1000 events (then a final `echo` event "… output truncated").

### 1.5 CodeTransformer (P1) — `token_get_all` based, never regex on raw code
All edits are insertions/replacements **within existing lines** so line numbers never shift.
1. Replace a leading `<?php` / `<?` open tag with spaces.
2. **Prefix** (inserted at the start of line 1, no newline): `declare(strict_types=1);` when `strictTypes` and the
   code does not declare it itself (if the user's code already starts with a `declare`, insert after it on its
   line), then `declare(ticks=1);` when `coverage` (the tick function records `editorLine` of executed statements
   in user code via `debug_backtrace`; cap 10 000 distinct lines).
3. **Echo rewrite**: top-level or nested `echo a, b;` → `\Tinkerbox\Capture::echoAt(L, a, b);`.
4. **Dump rewrite**: calls to the global functions `dump`, `dd`, `var_dump` (bare name or `\dump`, not preceded by
   `->`, `?->`, `::`, `function`, `new`, or a namespace qualifier other than `\`) →
   `\Tinkerbox\Capture::dumpAt(L, 'dump', [ARGS])`. Spread args (`...$x`) must keep working.
5. **Return last expression**: find the last top-level statement (track `() [] {}` depth; statements end at `;`
   at depth 0 or at a `}` returning to depth 0 for block statements — `if/elseif/else`, `for`, `foreach`,
   `while`, `do…while`, `switch`, `try/catch/finally`, named `function`, `class`/`interface`/`trait`/`enum`
   (incl. `abstract`/`final`/`readonly` modifiers and attributes `#[…]`), `namespace {}`, `declare {}`, bare `{}`;
   `else`/`elseif`/`catch`/`finally` continue the statement). If it is an expression statement, insert `return `
   before its first token. Not expression statements: `echo`, `print`, `return`, `throw`, `unset`, `global`,
   `static $x` (but `static::` / `static fn` / `static function` ARE expressions), `const`, `use`, `namespace`,
   `goto`, `break`, `continue`, block statements, inline HTML, `__halt_compiler`, labels. Missing trailing `;` on the
   last statement → insert one right after its last significant token. `hasReturnValue` = return inserted or the
   last statement is an explicit top-level `return`; `returnLine` = editor line where that statement starts.
6. **Magic comments** (when `magicComments`), editor line `L`, comment column `C`:
   - `EXPR; //?` and `EXPR; //? label` and `#?` — wrap the statement that ends on that line:
     `\Tinkerbox\Magic::capture(L, C, (EXPR))` (with `return `/`echo ` prefixes preserved:
     `return \Tinkerbox\Magic::capture(L, C, (EXPR));`). Works at any nesting depth; assignments are expressions.
   - `//?->method()` / `//?->prop` at end of line — like `//?` but records `(EXPR)->method()` while the statement
     keeps its original value: `\Tinkerbox\Magic::capture(L, C, (EXPR), function ($__v) { return $__v->method(); })`.
   - `/*?*/` inline after a sub-expression (e.g. `collect($x)/*?*/->map(...)`) — wrap the operand chain to the
     left of the comment (scan back over `->`, `?->`, `::`, names, variables, `new`, balanced `()`/`[]`, literals)
     → `\Tinkerbox\Magic::capture(L, C, (CHAIN))`; `/*?->count()*/` adds the tap closure like above.
   - `/*?.*/` — `\Tinkerbox\Magic::time(L, C)`: records seconds since script start (`"0.78301s"`) as type `time`;
     as a statement when placed after `;`, otherwise wrap like `/*?*/` but record time instead of the value.
   - `Magic` records `{line, column, type, preview, value, hits, label}`; the latest value wins, `hits` counts.
     `value` is dumped at capture time with `maxDepth = min(3, options.maxDepth)`.
   - Comments are left in place (they are comments), only code is inserted around them.

### 1.6 Dumper (P2) — `\Tinkerbox\Dumper::dump($value, array $limits): array` → `DumpNode`
- Scalars per `DumpNode` (ints/floats as strings). Strings truncated at `maxStringLength` (`len` = full length;
  `binary` when not valid UTF-8 → the value becomes a `\xNN` escaped preview).
- Arrays: `count`, first `maxItems` items, `truncated`.
- Objects keyed by `spl_object_id`; an object seen before in the same dump becomes `{t:'ref'}`. Properties via
  `(array)` cast decoding `\0Class\0prop` (private, `declaringClass`) / `\0*\0prop` (protected); dynamic props.
  Never call user methods with side effects except the documented ones below (wrap each in try/catch):
  - Eloquent `Model` → `kind:'model'`: attributes (`vis:'attribute'`, `getAttributes()`), loaded relations
    (`vis:'relation'`, `getRelations()`), meta (`vis:'meta'`: `exists`, `wasRecentlyCreated`, `connection`, `table`).
    `summary` = `"#<key>"`.
  - `Illuminate\Support\Collection`/`Enumerable` (incl. Eloquent collections, `LazyCollection` → **not** iterated:
    generic) → `kind:'collection'`, `items` from `all()`, `count`.
  - `ArrayObject`/`ArrayIterator`/`SplObjectStorage` → items; never iterate generators or unknown Traversables.
  - `DateTimeInterface` (Carbon included) → `kind:'datetime'`, `summary` = `format('Y-m-d H:i:s.u T (P)')`.
  - `Throwable` → `kind:'exception'`, props message/code/file/line (+ previous).
  - `Illuminate\Database\Eloquent\Builder` / `Query\Builder` → `kind:'builder'`, `summary` = SQL with bindings.
  - `Illuminate\Contracts\View\View`, `Illuminate\Mail\Mailable` (`render()`),
    `Illuminate\Notifications\Messages\MailMessage` (`render()`), `Illuminate\Contracts\Support\Htmlable`
    (`toHtml()`) → `kind:'html'`, `html` (≤ 2 MB) + `summary` (class + subject/view name). Rendering a Mailable
    must **not send** anything.
  - `Stringable`/`HtmlString`/objects with `__toString` (non-Model) → `kind:'stringable'`, `summary` (truncated).
  - `UnitEnum` → `{t:'enum'}` (`value` for backed enums); `Closure` → `{t:'closure', signature, file, line}`.
  - Resources → `{t:'resource'}`.
- Depth limit → `{t:'max-depth'}`. Total node budget ~20 000 per dump (then `truncated`).
- `Dumper::preview($value, int $max = 120): string` — VarDumper-like one-liner: `"hello"`, `42`, `3.14`, `true`,
  `null`, `[1, 2, 3]` / `array:3 [...]`, `App\Models\User {#123 id: 1}`, `Illuminate\Support\Collection {#12 count: 5}`,
  `Carbon\Carbon @2024-01-01 10:00:00`, `Status::Active`.
- `\Tinkerbox\ExceptionFormatter::format(\Throwable $e, array $ctx): array` → `ExceptionInfo`. `$ctx = ['evalFile'
  => string, 'lineOffset' => int, 'userCode' => string /* original editor code */, 'projectPath' => string,
  'bootstrap' => bool]`. Strip runner frames, mark `userCode` / `vendor` frames, map eval lines to editor lines,
  make file paths relative to the project, `snippet` = 9 lines around the failing line (user code when the
  exception originates in it, else the first non-vendor project frame, else the throw site), recurse `previous`
  (max 5). `ExceptionFormatter::fatal(array $errorGetLast, array $ctx)` for shutdown fatals (`fatal: true`).

### 1.7 Drivers (P3) — `Tinkerbox\Drivers`

A driver recognizes one kind of project and boots it before the user's code runs. All drivers extend one abstract
class (PHP 7.4 – 8.5 compatible signatures):

```php
namespace Tinkerbox\Drivers {
  abstract class Driver {
    abstract public function id(): string;                              // DriverInfo.id, e.g. 'laravel'
    abstract public function name(): string;                            // 'Laravel'
    abstract public function canBootstrap(string $projectPath): bool;   // file-system checks only
    abstract public function bootstrap(string $projectPath): void;      // cwd is already the project
    public function version(): ?string                  // footer label, e.g. 'Laravel 12.20.0' (DriverInfo.appVersion)
    public function variables(): array                  // injected into the user's scope, e.g. ['app' => $app]
    public function listenForQueries(callable $listener): void   // $listener(string $sql, array $bindings, float $timeMs, string $connection)
    public function afterRun(): void                    // once after the user's code (report buffered queries, …)
    public function panels(string $projectPath): array  // AppPanel arrays (default: the PHP environment panel)
    public function logsPath(string $projectPath): ?string  // log viewer root, absolute or project-relative (DriverInfo.logFilesPath)
    public function prettyErrors(): ?bool               // detailed (Collision-style) errors; null = global setting (DriverInfo.usesCollision)
    public function files(string $projectPath): array   // project PHP files, relative, bounded (ignoredFolders() skipped)
    public function models(): array                     // ModelInfo-shaped arrays for autocomplete
    protected function ignoredFolders(): array          // extra folders files() skips (vendor/, node_modules/, dot folders always)
  }
}
```

Run order: `canBootstrap()` → `bootstrap()` → `listenForQueries()` (only with `captureQueries`) → `variables()` → user
code → `afterRun()`. Data modes call `version()` / `prettyErrors()` / `logsPath()` (DriverInfo), `panels()`, `models()`
and `variables()` after `bootstrap()`. Built-ins keep their state in private properties and expose protected
helpers to subclasses (e.g. `LaravelDriver::application()`, `createApplication()`, `projectRoot()`).

**Panels.** `\Tinkerbox\Panels\Panel::make(string $title)->section(string $title, array $rows)->toArray()` builds an
`AppPanel` (`sections(array $title => $rows)` adds several, skipping empty ones); row values are converted to display
text (`true`/`false`, `''` for null, `a, b` for lists, dates, enums, stringables). `\Tinkerbox\Panels\StandardPanels`
holds the defaults: `php($projectPath)` ("PHP Environment": version, SAPI, binary, php.ini, extensions, memory limit,
OPcache, Xdebug + the project path / Composer package), `laravel($app = null, $useAbout = true, $title = 'App
Information')` (the sections of `artisan about --json` run in-process through the console kernel, keys humanized —
`php_version` → "PHP Version", storage-link keys mapped back to the configured paths — else Environment / Drivers
values from the configuration; null when no Laravel application is running) and `wordpress()` ("Site Information":
site, configuration flags, theme, active plugins).

**Detection** — `\Tinkerbox\DriverRegistry::detect(string $projectPath, string $forcedId = '', string $homePath = ''): Driver`:
1. Custom drivers: every `*.php` file (not recursive, sorted) of `<home>/.config/tinkerbox/drivers/`, then
   `<project>/.tinkerbox/drivers/`. Classes a file declares are read with the tokenizer first: a file that would
   redeclare an existing class is skipped, and a driver may extend a driver of another file (loaded on demand).
   Concrete subclasses of `Driver` declared by those files (constructor without required arguments) are candidates,
   subclasses before the classes they extend. Load errors, constructor problems and `canBootstrap()` exceptions are
   recorded as warnings (reported as run diagnostics) and never stop the detection.
2. Built-ins (`DriverRegistry::BUILTINS`): Statamic, Drupal7, Drupal (8+), Kirby, Moodle, October, Lumen,
   LaravelZero, Laravel, Craft, Magento2, PrestaShop, Radicle, Bedrock, WordPress, Shopware, Symfony, Typo3, Testbench,
   CakePhp, CodeIgniter4, Yii2, Joomla, Composer — the first `canBootstrap() === true` wins; `PlainDriver` (id `none`,
   loads `vendor/autoload.php` when present) is the fallback and the driver for `projectPath === ''`.
3. `forcedId` picks the first driver whose `id()` (or class name) matches — custom drivers first, then built-ins;
   unknown ids warn and fall back to detection. `laravel-booted` = `LaravelDriver::alreadyBooted()`: reuses an
   application already booted in the current PHP process, else boots `bootstrap/app.php` normally.

`DriverRegistry::info(Driver $driver, string $projectPath): array` builds DriverInfo with every call guarded;
relative `logsPath()` results (`storage/logs`, `/storage/logs`) resolve against the project. `builtins()` and
`catalog()` list the built-ins. Custom driver example (`<project>/.tinkerbox/drivers/ShopDriver.php`):

```php
class ShopDriver extends \Tinkerbox\Drivers\LaravelDriver {
  public function id(): string { return 'shop'; }
  public function name(): string { return 'Shop'; }
  public function variables(): array { return parent::variables() + ['orders' => \App\Models\Order::query()]; }
  public function panels(string $projectPath): array {
    return array_merge(parent::panels($projectPath), [
      \Tinkerbox\Panels\Panel::make('Shop')->section('Orders', ['Open' => \App\Models\Order::open()->count()])->toArray(),
    ]);
  }
}
```

Built-in ids and what bootstrapping needs (`canBootstrap()`; `vendor` honors composer.json `config.vendor-dir`):

| id | class | canBootstrap | bootstrap / variables |
| --- | --- | --- | --- |
| `laravel` | `LaravelDriver` | `artisan` + `bootstrap/app.php` | autoload, `bootstrap/app.php`, console kernel `bootstrap()`; `$app`; QueryExecuted listener; `about` panel; logs `storage_path('logs')`; models from app/Models (columns via the schema builder, short connect timeout) |
| `statamic` / `october` / `lumen` / `laravel-zero` / `testbench` | subclasses of `LaravelDriver` | Laravel + `vendor/statamic/cms`; Laravel + `modules/system` + october/rain\|system; `bootstrap/app.php` + `vendor/laravel/lumen-framework`; `bootstrap/app.php` + `vendor/laravel-zero/framework`, no `public/index.php`; no `public/index.php` + `vendor/orchestra/testbench-core/laravel` | labels `Statamic 5.12.0 (Laravel 11.37.0)` etc.; Lumen boots without a request; Testbench boots the skeleton from `testbench.yaml` |
| `symfony` | `SymfonyDriver` | `bin/console` + kernel (`src/Kernel.php` / `app/AppKernel.php`) + framework bundle | Dotenv `bootEnv`, kernel boot; `$kernel`, `$container`; Doctrine DBAL 2/3 logger |
| `shopware` | `ShopwareDriver` | 6: `bin/console` + `vendor/shopware/{core,platform}`; 5: `shopware.php` + `engine/Shopware` | KernelFactory with public services; `$kernel`, `$container`, `$definitions` |
| `wordpress` / `bedrock` / `radicle` | `WordPressDriver` + subclasses | core (`wp-load.php` + `wp-includes/version.php`) at the root, `web/wp`, `wp`, `public/wp`, `wordpress`; Bedrock: `config/application.php` + `web/wp`; Radicle: core + `bedrock/application.php` (or Acorn + `config/application.php`) | `WP_USE_THEMES=false`, `wp-load.php` with core globals bound to `$GLOBALS`; `$wpdb` (+ `$app` = Acorn); `SAVEQUERIES` + `log_query_custom_data` filter; `prettyErrors() === false` |
| `drupal7` / `drupal` | `Drupal7Driver`, `DrupalDriver` | `includes/bootstrap.inc` + `modules/system/system.module`; `core/lib/Drupal.php` (root, web, docroot, html, public) | full bootstrap / DrupalKernel + preHandle; `$user` / `$kernel`, `$container`; Database query log |
| `craft`, `magento2`, `kirby`, `moodle`, `prestashop`, `typo3`, `joomla`, `cakephp`, `codeigniter4`, `yii2` | `CraftDriver`, … | the project's console script / bootstrap files (see the classes) | the framework's console bootstrap; `$craft`, `$objectManager` + `$area`, `$kirby` + `$site`, `$CFG` + `$DB`, `$context`, `$container`, `$app` |
| `composer` | `ComposerDriver` | `vendor/autoload.php` | autoload; label = package name |
| `none` | `PlainDriver` | never (fallback) | autoload when present |

`src/main/execution/detectProject.ts` ports these checks (no PHP) and reads project drivers statically: `id()` from
a literal `return '…';` or the built-in it extends, simple `canBootstrap()` bodies (`file_exists` / `is_file` /
`is_dir` of `$projectPath . '/…'`, `parent::canBootstrap()`, `!`, `&&`, `||`) are evaluated, anything else counts
as a match. `tests/fixtures/projects/<driver id>` hold one fixture per driver (plus `not-*` negatives); the TS and
PHP tests cross-check every fixture.

`\Tinkerbox\ClassAliasLoader::register(string $projectPath)` — Tinker-style aliasing: short names → FQCN for project
classes (classmap + bounded PSR-4 scan of the project's own `autoload.psr-4` dirs; respect
`config('tinker.alias')`/`dont_alias` when available), registered as an autoloader that `class_alias()`es on
demand. `ClassAliasLoader::aliases(): array`.

### 1.8 Data modes (P4)
- `\Tinkerbox\Introspector::environment(\Tinkerbox\Drivers\Driver $driver, string $projectPath): array` → `EnvironmentInfo`
  (functions with signatures for internal + user functions, classes from declared + composer classmap + PSR-4
  scan (cap 20 000, driver classes hidden), aliases, constants (user + common), models via `models()`, driver
  `variables()` with types).
- `Introspector::members(string $class): ?array` → `ClassMembers` (resolve aliases; facades → reflect
  `getFacadeRoot()` class, methods marked static; Eloquent models also get public methods of Eloquent\Builder +
  Query\Builder as static + `scopeX` → `x`; Laravel `@method` docblock tags parsed).
- `\Tinkerbox\LogReader::list(string $root): array` → `LogListing`; `LogReader::read(string $root, string $file,
  int $limit): array` → `LogEntry[]` newest first. Parses Laravel/Monolog `[datetime] env.LEVEL: message {context}`
  + stack traces, plus generic line logs (nginx/apache error, php-fpm) with level detection. Reads only the tail
  (≤ 5 MB) of big files. Path traversal outside the root is rejected.
- `\Tinkerbox\Panels::forDriver(\Tinkerbox\Drivers\Driver $driver, string $projectPath): array` → `AppPanel[]`: the
  driver's `panels()` normalized (Panel builders, AppPanel arrays, looser shapes; a broken panel is skipped); when
  nothing usable remains, `StandardPanels::laravel()` while Laravel runs, else `StandardPanels::php()`.
- `\Tinkerbox\ProjectSnippets::read(string $projectPath): array` → `.tinkerbox/snippets/*.php` with `@label` /
  `@description` docblock parsing (code = file minus the docblock and `<?php`).

---

## 2. Main process (E1–E3)

### 2.1 Execution API (E1) — consumed by E2's IPC handlers

```ts
// src/main/execution/index.ts
export interface ExecutionContext {
  getSettings(): Settings                                  // decrypted
  /** Decrypted connection; null / 'sandbox' / 'scratch' resolve to the implicit local connections. */
  resolveConnection(id: string | null): Connection
  resourcesPath: string                                    // dir containing resources/php (dev) or process.resourcesPath (packaged)
  userDataPath: string
}
export function runCode(ctx, request: RunRequest, onProgress: (e: RunProgressEvent) => void): Promise<RunResult>
export function cancelRun(runId: string): void
export function runDataMode<T>(ctx, connectionId: string | null, mode: PhpDataMode, extra?: Record<string, unknown>): Promise<PhpDataEnvelope<T>>
export function introspectEnvironment(ctx, req: IntrospectRequest): Promise<EnvironmentInfo>       // cached per connection
export function introspectMembers(ctx, req: IntrospectRequest): Promise<ClassMembers | null>        // cached per connection+class
export function projectPanels(ctx, connectionId: string | null): Promise<AppPanel[]>
export function listLogs(ctx, connectionId: string | null): Promise<LogListing>
export function readLog(ctx, req: LogReadRequest): Promise<LogEntry[]>
export function projectSnippets(ctx, connectionId: string | null): Promise<Snippet[]>               // source 'project', read-only
export function testConnection(ctx, connection: Connection): Promise<ConnectionTestResult>
export function detectLocalProject(path: string): Promise<{ driver: string | null; name: string }>  // fs sniffing, no PHP: a port of the
//   project drivers (.tinkerbox/drivers, read statically) + the built-ins' canBootstrap() in DriverRegistry::BUILTINS order
//   (null = plain PHP); tests cross-check every fixture (§1.7)
export function invalidateCaches(connectionId?: string): void
export function disposeExecution(): void                                                            // kill running processes
// src/main/php/binaries.ts
export function findPhpBinaries(): Promise<PhpBinary[]>   // Herd (+ aliases php74..php85), Homebrew, MAMP, XAMPP, Laragon, Valet, system, PATH
export function inspectPhpBinary(binary: string): Promise<PhpBinary | null>
export function resolvePhpBinary(settings: Settings, connection?: Connection): Promise<{ path: string; env: Record<string,string> }> // Herd per-version php.ini scan dir env
// src/main/env/shellPath.ts
export function loadShellPath(): Promise<void>            // GUI apps miss the login-shell PATH on macOS/Linux
// src/main/php/herd.ts
export function listHerdSites(): Promise<HerdSite[]>
// src/main/sandbox/index.ts
export function sandboxStatus(ctx): Promise<SandboxStatus>
export function installSandbox(ctx, onLine: (line: string) => void): Promise<SandboxStatus>  // composer create-project laravel/laravel
```

Sandbox location (`sandboxPathSync()`): `<userData>/sandbox` when a sandbox is installed there (by
`installSandbox()`, or a copy of the prepared one); else a sandbox prepared at build time by `npm run prepare:sandbox`
(`resources/sandbox`), used in place during development and copied to `<userData>/sandbox` on first use inside a
packaged (read-only) app; else `<userData>/sandbox` (not installed yet). Implicit connections: `sandbox` → local connection at the sandbox path (name "Default",
Laravel Sandbox); `scratch` → local connection with `path: ''` (plain PHP). `null` → `defaultWorkingDirectory`
setting (opened as a local project) → sandbox if installed → scratch.

**Local transport** (`localTransport.ts`, the only built-in transport). Spawn `php` with `-d xdebug.mode=off -d display_errors=stderr`
(or `-d xdebug.mode=debug -d xdebug.start_with_request=yes` when Xdebug step debugging is on for the project:
`connection.debug`), `cwd = path ||
os.tmpdir()`, Herd per-version ini env; write the bundle to stdin; stream stdout/stderr (emit `run:progress` for text
outside the envelope); honor `timeoutMs` and `cancelRun` (kill the process group).

**Extension point: transports.** Execution goes through a small interface, so a transport for another target is a new
file that calls `registerTransport()`; `runCode`, the data modes and the IPC layer do not change. Remote transports
(SSH, Docker, …) are on the roadmap.

```ts
// src/main/execution/transport.ts
export interface TransportRequest { script: string; connection: Connection; settings: Settings; timeoutMs: number; signal: AbortSignal; onStdout(chunk: string): void; onStderr(chunk: string): void }
export interface TransportResult { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; cancelled: boolean; error?: string }
export interface Transport {
  id: string
  supports(connection: Connection): boolean
  run(req: TransportRequest): Promise<TransportResult>          // rejects when PHP cannot be started
  payloadDefaults?(connection: Connection): Partial<Pick<PhpPayload, 'projectPath' | 'driver' | 'homePath'>>
}
export function registerTransport(t: Transport): void   // replaces by id; the latest registration that supports() a connection wins
export function unregisterTransport(id: string): void   // re-registers the local transport when none would be left
export function transportFor(connection: Connection): Transport
```

`parseEnvelope(stdout, nonce)` is a pure, unit-tested function.

### 2.2 Shell (E2)
- Window: `titleBarStyle: 'hiddenInset'` (macOS) / frameless custom title bar elsewhere, min 910×630, remembers
  bounds, `backgroundColor` from the theme, `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`.
  Single instance lock; argv / `second-instance` / `open-file` / `tinkerbox://open?cwd=<base64>` deep links → `app:openPath`.
  macOS dock recent folders (`app.addRecentDocument`). Windows: `autoHideMenuBar`.
- Native menu (Tinkerbox/File/Edit/View/Run/Window/Help) built from `COMMAND_META` + `acceleratorFor()` honoring
  `settings.shortcuts`; items send `menu:command`; rebuilt when shortcuts change. `CmdOrCtrl+R` runs code (no reload role).
- Persistence in `userData`: `settings.json`, `connections.json` (`{connections}`: local project folders), `snippets.json`,
  `history.json` (cap `historyLimit`), `session.json`, `stats.json`, `window-state.json`. Atomic writes (temp +
  rename), debounced; corrupted JSON → backed up as `*.corrupt-<ts>.json`, defaults used, toast via event.
- Isolated profile: `--user-data-dir=<dir>` (or `TINKERBOX_USER_DATA_DIR`) is applied with `app.setPath('userData')`
  before the single-instance lock (`userDataOverride()` in `paths.ts`); such instances do not register the
  `tinkerbox://` protocol. The E2E smoke test (`tests/e2e/smoke.mjs`) runs the built app this way.
- Clearing recent folders forgets plain folders but keeps (without `lastUsedAt`) projects with custom settings and
  connections still referenced by the saved session's tabs or by snippets, so open tabs keep their project.
- `php:inspect` also accepts `auto` and inspects the binary automatic detection runs (`resolveAutoPhp()`: Herd's
  default PHP → first discovered binary → `php` on PATH); Settings → General and PHP Settings show that version.
- Secrets (`github.token`) encrypted
  with `safeStorage` (fallback plain with a warning on Linux without keyring). Renderer only sees `SECRET_MASK`;
  saving `SECRET_MASK` keeps the stored value.
- `run:start`: `runCode` → append `HistoryEntry`, update stats, touch connection, emit `history:changed`.
- CLI helper (`resources/bin/tinkerbox.sh`), custom themes folder (`~/.config/tinkerbox/themes/*.json`), app info.
- Preload exposes `window.tinkerbox: TinkerboxBridge` with channel allow-lists derived from `InvokeChannels`/`EventChannels`.

### 2.3 Integrations (E3)

```ts
// src/main/integrations/gist.ts
export function createGist(token: string, code: string, description: string, isPublic: boolean): Promise<string>
// src/main/integrations/editorLinks.ts
export function editorUrl(integration: EditorIntegration, file: string, line?: number): string | null
export function openProjectInEditor(integration: EditorIntegration, dir: string): Promise<void>
```

---

## 3. Renderer (R1–R5)

Layout:
```
┌───────────────────────────── title bar (drag region, traffic lights) ─────────────────────────────┐
│                         Tinkerbox - <tab name>                                    [SQL] [≡] [<>]   │
├────┬──────────────────────────────────────────────────────────────────────────────────────────────┤
│ ▶  │ [Get started] [Default ×] [my-app ×]  [+]                                                    │
│ 📁 ├───────────────────────────────────────────────┬──────────────────────────────────────────────┤
│ 🕑 │  Monaco editor (line numbers, coverage gutter, │  Cards view  (or CLI text output)     │
│ 🔖 │  magic-comment badges, inline errors)          │  [Line 9] App\Models\User {#123 ▸}           │
│ 📄 │                                                │  [Line 4] SELECT * FROM `users` …            │
│    │                                                │                                              │
│    │                                                │                                              │
│    ├───────────────────────────────────────────────┴──────────────────────────────────────────────┤
│    │ Laravel 12.20.0 ⓘ │ PHP 8.3.12 │ Xdebug │                       129.31ms / 3.37MB │ vim │ ⌄ │
│ ⚙  └──────────────────────────────────────────────────────────────────────────────────────────────┘
```
- Sidebar (≈52px) top: Run (spinner while running; click again stops), Open folder (click: folder picker;
  hover/secondary: recent folders popover), History, Snippets, Logs. Bottom: Settings. Tooltips include the shortcut.
  The Run button shows a bug icon while Xdebug step debugging is on for the tab's project.
- `layout: 'vertical'` = output right of the editor; `'horizontal'` = output below. Draggable splitter.
- Stores (`src/renderer/src/stores/`): `settings`, `connections`, `tabs` (tabs, session persistence, per-tab run
  state `results`/`running`/`streamed`, run/cancel/new/close/duplicate/reopen), `snippets`, `history`,
  `environment` (introspection cache), `ui` (modals, popovers, panels, toasts, zen). The store APIs are documented in
  `docs/RENDERER.md`.
- `editorBridge.ts`: the editor registers `{ getCode, getSelection(): {text, startLine} | null, insertText,
  replaceAll, focus, revealLine, applyRunDecorations(result) , clearDecorations }`; commands use it.
- `ModalHost` renders `ui.modal` (`settings`, `palette`, `history`, `snippets`, `themes`, `logs`, `panels`, `php`,
  `wrapped`, `share`, `tablePreview`, `objectGraph`, `htmlPreview`, `confirm`, `snippetSave`).
- Themes: built-ins — **Tinkerbox** (default: light lavender chrome, white rounded output cards, purple accent
  `#7c3aed`-ish), Tinkerbox Dark, Dracula, Ember Dark, Ember Light, Material, Night Owl, Nord, Shades of Purple,
  Snow Forest, Solarized Dark, Solarized Light, GitHub, GitHub Dark, Kew, Christmas, One Dark, Monokai — + custom
  themes. Each theme declares `dark: boolean` (moon/sun badge in the picker). A theme = Monaco theme data + a `custom` chrome palette → CSS variables `--tw-*` on `:root`.

## Conventions
- TypeScript strict; no `any` unless unavoidable (commented). Vue SFC `<script setup lang="ts">`. Tailwind utilities
  with theme CSS variables (`bg-[var(--tw-bg)]` or `@theme` tokens) — no hard-coded colors in components.
- Icons from `lucide-vue-next`. Fonts: `@fontsource/fira-code`.
- Tests: `tests/unit/<module>/*.test.ts` (vitest, node env) and `tests/php/<module>/*Test.php` (harness:
  `php -d xdebug.mode=off tests/php/run.php [filter]`, helpers `t_assert`, `t_same`, `t_contains`, `t_throws`,
  `t_load_runner_sources()`, `t_run_bundle($payload, $cwd)` which runs the full bundle through stdin exactly like the app).
