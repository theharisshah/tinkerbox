/**
 * File-system-only project sniffing (no PHP): which driver the runner would pick for a folder, and a display
 * name. Used when opening folders and for recent-folder badges.
 *
 * `sniffDriver` mirrors `\Tinkerbox\DriverRegistry::detect()` (docs/ARCHITECTURE.md §1.7): project drivers in
 * `<project>/.tinkerbox/drivers/*.php` first, then a port of the built-in drivers' `canBootstrap()` checks
 * (resources/php/src/Drivers/*Drivers.php) in `DriverRegistry::BUILTINS` order. Project drivers are read
 * statically: their `id()` comes from a literal `return '…';` (or the built-in they extend), and simple
 * `canBootstrap()` bodies — `return` expressions combining `file_exists` / `is_file` / `is_dir` of
 * `$projectPath . '/…'`, `parent::canBootstrap()`, `true` / `false`, `!`, `&&`, `||` — are evaluated; anything
 * else is assumed to match. The runner's `detect` mode remains the source of truth once PHP runs.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'

/** composer.json names of framework skeletons: the folder name is more meaningful for those. */
const SKELETON_NAMES = new Set([
  'laravel/laravel',
  'laravel/lumen',
  'laravel-zero/laravel-zero',
  'statamic/statamic',
  'october/october',
  'symfony/skeleton',
  'symfony/website-skeleton',
  'roots/bedrock',
  'roots/radicle',
  'craftcms/craft',
  'drupal/recommended-project',
  'drupal/legacy-project',
  'magento/project-community-edition',
  'shopware/production',
  'typo3/cms-base-distribution',
  'getkirby/plainkit',
  'getkirby/starterkit',
  'cakephp/app',
  'codeigniter4/appstarter',
  'yiisoft/yii2-app-basic',
  'yiisoft/yii2-app-advanced',
  'prestashop/prestashop',
  'moodle/moodle',
  'joomla/joomla-cms',
  'wordpress/wordpress',
  'johnpbloch/wordpress'
])

interface ComposerJson {
  name?: unknown
  require?: unknown
  'require-dev'?: unknown
  config?: unknown
}

function readComposer(dir: string): ComposerJson | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'composer.json'), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as ComposerJson) : null
  } catch {
    return null
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** PHP `file_exists()`: a file or a directory. */
function exists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/** Lazily read project facts shared by the sniffers (mirrors `\Tinkerbox\Drivers\Support`). */
class Project {
  readonly root: string
  private composerCache: ComposerJson | null | undefined

  constructor(root: string) {
    this.root = root
  }

  /** `<root><rel>` — rel starts with '/' like the PHP sources. */
  path(rel: string): string {
    return this.root + rel
  }

  file(rel: string): boolean {
    return isFile(this.path(rel))
  }

  dir(rel: string): boolean {
    return isDir(this.path(rel))
  }

  exists(rel: string): boolean {
    return exists(this.path(rel))
  }

  get composer(): ComposerJson | null {
    if (this.composerCache === undefined) this.composerCache = isFile(this.path('/composer.json')) ? readComposer(this.root) : null
    return this.composerCache
  }

  /** Support::composerRequires(): the package is a key of require or require-dev. */
  requires(pkg: string): boolean {
    const composer = this.composer
    if (!composer) return false
    return (['require', 'require-dev'] as const).some((section) => {
      const deps = composer[section]
      return !!deps && typeof deps === 'object' && !Array.isArray(deps) && Object.prototype.hasOwnProperty.call(deps, pkg)
    })
  }

  /** Support::vendorDir(): honours composer.json config.vendor-dir. */
  vendorDir(): string {
    const config = this.composer?.config
    let dir = 'vendor'
    if (config && typeof config === 'object' && !Array.isArray(config)) {
      const vendor = (config as Record<string, unknown>)['vendor-dir']
      if (typeof vendor === 'string' && vendor !== '') dir = vendor
    }
    if (isAbsolute(dir) || /^[A-Za-z]:[\\/]/.test(dir)) return dir.replace(/[\\/]+$/, '') || dir
    return `${this.root}/${dir.replace(/^[\\/]+|[\\/]+$/g, '')}`
  }

  /** A path below the vendor dir is a directory (`is_dir(Support::vendorDir($p) . $rel)`). */
  vendorHasDir(rel: string): boolean {
    return isDir(this.vendorDir() + rel)
  }

  vendorHasFile(rel: string): boolean {
    return isFile(this.vendorDir() + rel)
  }
}

/** LaravelDriver::canBootstrap(). */
const laravel = (p: Project): boolean => p.file('/artisan') && p.file('/bootstrap/app.php')

const DRUPAL_ROOTS = ['', '/web', '/docroot', '/html', '/public']
const WORDPRESS_CORE_FOLDERS = ['', '/web/wp', '/wp', '/public/wp', '/wordpress']

/** WordPressDriver::coreFolder() !== null. */
const wordpress = (p: Project): boolean => WORDPRESS_CORE_FOLDERS.some((sub) => p.file(`${sub}/wp-load.php`) && p.file(`${sub}/wp-includes/version.php`))

const shopware6 = (p: Project): boolean =>
  p.file('/bin/console') && (p.vendorHasDir('/shopware/core') || p.vendorHasDir('/shopware/platform') || p.file('/src/Core/Kernel.php'))

/** One built-in driver: its id, PHP class name and `canBootstrap()` port. */
interface BuiltinSniffer {
  id: string
  className: string
  canBootstrap: (p: Project) => boolean
}

/** Built-in drivers in `\Tinkerbox\DriverRegistry::BUILTINS` order (PlainDriver, id "none", never bootstraps). */
const BUILTINS: BuiltinSniffer[] = [
  { id: 'statamic', className: 'StatamicDriver', canBootstrap: (p) => laravel(p) && p.vendorHasDir('/statamic/cms') },
  {
    id: 'drupal7',
    className: 'Drupal7Driver',
    canBootstrap: (p) =>
      DRUPAL_ROOTS.some(
        (sub) => p.file(`${sub}/includes/bootstrap.inc`) && p.file(`${sub}/modules/system/system.module`) && !p.file(`${sub}/core/lib/Drupal.php`)
      )
  },
  { id: 'drupal', className: 'DrupalDriver', canBootstrap: (p) => DRUPAL_ROOTS.some((sub) => p.file(`${sub}/core/lib/Drupal.php`)) },
  {
    id: 'kirby',
    className: 'KirbyDriver',
    canBootstrap: (p) => (p.file('/kirby/bootstrap.php') || p.file('/vendor/getkirby/cms/bootstrap.php')) && (p.dir('/site') || p.dir('/content'))
  },
  {
    id: 'moodle',
    className: 'MoodleDriver',
    canBootstrap: (p) => p.file('/config.php') && ['', '/public'].some((sub) => p.file(`${sub}/lib/moodlelib.php`) && p.file(`${sub}/version.php`))
  },
  {
    id: 'october',
    className: 'OctoberDriver',
    canBootstrap: (p) =>
      laravel(p) &&
      p.dir('/modules/system') &&
      (p.vendorHasDir('/october/rain') || p.vendorHasDir('/october/system') || p.requires('october/rain') || p.requires('october/all'))
  },
  { id: 'lumen', className: 'LumenDriver', canBootstrap: (p) => p.file('/bootstrap/app.php') && p.vendorHasDir('/laravel/lumen-framework') },
  {
    id: 'laravel-zero',
    className: 'LaravelZeroDriver',
    canBootstrap: (p) => p.file('/bootstrap/app.php') && p.vendorHasDir('/laravel-zero/framework') && !p.file('/public/index.php')
  },
  { id: 'laravel', className: 'LaravelDriver', canBootstrap: laravel },
  { id: 'craft', className: 'CraftDriver', canBootstrap: (p) => p.file('/craft') && (p.vendorHasDir('/craftcms/cms') || p.requires('craftcms/cms')) },
  { id: 'magento2', className: 'Magento2Driver', canBootstrap: (p) => p.file('/app/etc/env.php') && p.file('/app/bootstrap.php') },
  {
    id: 'prestashop',
    className: 'PrestaShopDriver',
    canBootstrap: (p) => p.file('/config/config.inc.php') && (p.dir('/src/PrestaShopBundle') || p.file('/classes/ObjectModel.php'))
  },
  {
    id: 'radicle',
    className: 'RadicleDriver',
    canBootstrap: (p) =>
      wordpress(p) && (p.file('/bedrock/application.php') || (p.vendorHasDir('/roots/acorn') && p.file('/config/application.php')))
  },
  {
    id: 'bedrock',
    className: 'BedrockDriver',
    canBootstrap: (p) => p.file('/config/application.php') && p.file('/web/wp/wp-load.php') && p.file('/web/wp/wp-includes/version.php')
  },
  { id: 'wordpress', className: 'WordPressDriver', canBootstrap: wordpress },
  { id: 'shopware', className: 'ShopwareDriver', canBootstrap: (p) => shopware6(p) || (p.file('/shopware.php') && p.dir('/engine/Shopware')) },
  {
    id: 'symfony',
    className: 'SymfonyDriver',
    canBootstrap: (p) =>
      p.file('/bin/console') &&
      (p.file('/src/Kernel.php') || p.file('/app/AppKernel.php')) &&
      (p.vendorHasDir('/symfony/framework-bundle') || p.vendorHasDir('/symfony/symfony') || p.requires('symfony/framework-bundle'))
  },
  {
    id: 'typo3',
    className: 'Typo3Driver',
    canBootstrap: (p) => p.vendorHasFile('/typo3/cms-core/Classes/Core/Bootstrap.php') || p.file('/typo3/sysext/core/Classes/Core/Bootstrap.php')
  },
  {
    id: 'testbench',
    className: 'TestbenchDriver',
    canBootstrap: (p) => !p.file('/public/index.php') && p.vendorHasDir('/orchestra/testbench-core/laravel')
  },
  {
    id: 'cakephp',
    className: 'CakePhpDriver',
    canBootstrap: (p) =>
      p.file('/config/bootstrap.php') && (p.file('/bin/cake.php') || p.file('/bin/cake')) && (p.vendorHasDir('/cakephp/cakephp') || p.requires('cakephp/cakephp'))
  },
  { id: 'codeigniter4', className: 'CodeIgniter4Driver', canBootstrap: (p) => p.file('/app/Config/Paths.php') && p.file('/spark') },
  {
    id: 'yii2',
    className: 'Yii2Driver',
    canBootstrap: (p) => p.file('/yii') && p.vendorHasFile('/yiisoft/yii2/Yii.php') && !p.vendorHasDir('/craftcms/cms')
  },
  {
    id: 'joomla',
    className: 'JoomlaDriver',
    canBootstrap: (p) =>
      p.file('/configuration.php') &&
      p.file('/includes/defines.php') &&
      (p.file('/libraries/src/Version.php') || p.file('/libraries/cms/version/version.php'))
  },
  { id: 'composer', className: 'ComposerDriver', canBootstrap: (p) => isFile(`${p.vendorDir()}/autoload.php`) }
]

/** Built-in driver ids `sniffDriver` can return, in detection order. */
export const SNIFFED_DRIVER_IDS: readonly string[] = BUILTINS.map((b) => b.id)

const DRIVERS_NAMESPACE = 'tinkerbox\\drivers\\'
/** Lower-cased FQCN of a built-in driver => its sniffer; the abstract base class maps to null. */
const BUILTIN_CLASSES = new Map<string, BuiltinSniffer | null>([
  [`${DRIVERS_NAMESPACE}driver`, null],
  [`${DRIVERS_NAMESPACE}plaindriver`, { id: 'none', className: 'PlainDriver', canBootstrap: () => false }],
  ...BUILTINS.map((b): [string, BuiltinSniffer] => [`${DRIVERS_NAMESPACE}${b.className.toLowerCase()}`, b])
])

// ---------------------------------------------------------------------------------------------------------------
// Project drivers (.tinkerbox/drivers/*.php), read statically
// ---------------------------------------------------------------------------------------------------------------

interface DriverClass {
  /** Lower-cased fully qualified name. */
  key: string
  name: string
  abstract: boolean
  /** Lower-cased fully qualified parent name. */
  parent: string
  /** Literal returned by id(), if any. */
  id: string | null
  /** Body of canBootstrap() without the braces, if declared. */
  canBootstrap: string | null
}

/** Remove comments, keeping string literals (and line breaks) intact. */
function stripComments(src: string): string {
  let out = ''
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === "'" || c === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1
      out += src.slice(i, j + 1)
      i = j
    } else if (c === '#' && src[i + 1] !== '[') {
      while (i < src.length && src[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end === -1 ? src.length : end + 1
      out += ' '
    } else {
      out += c
    }
  }
  return out
}

/** Index of the `}` matching the `{` at `open` (string literals skipped), or -1. */
function matchingBrace(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === "'" || c === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1
      i = j
    } else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i
  }
  return -1
}

/** Body of a method (between its braces), or null. */
function methodBody(body: string, method: string): string | null {
  const re = new RegExp(`\\bfunction\\s+${method}\\s*\\([^)]*\\)\\s*(?::\\s*\\??[\\w\\\\]+\\s*)?\\{`, 'i')
  const m = re.exec(body)
  if (!m) return null
  const open = m.index + m[0].length - 1
  const close = matchingBrace(body, open)
  return close === -1 ? null : body.slice(open + 1, close)
}

/** Driver classes declared by one PHP file. */
function parseDriverFile(source: string): DriverClass[] {
  const src = stripComments(source)
  const namespace = /\bnamespace\s+([\w\\]+)\s*[;{]/.exec(src)?.[1] ?? ''
  const imports = new Map<string, string>()
  for (const m of src.matchAll(/^\s*use\s+\\?([\w\\]+)(?:\s+as\s+(\w+))?\s*;/gm)) {
    imports.set((m[2] ?? m[1].split('\\').pop() ?? '').toLowerCase(), m[1])
  }
  const qualify = (name: string): string => {
    if (name.startsWith('\\')) return name.slice(1)
    const [first, ...rest] = name.split('\\')
    const imported = imports.get(first.toLowerCase())
    if (imported) return [imported, ...rest].join('\\')
    return namespace ? `${namespace}\\${name}` : name
  }
  const classes: DriverClass[] = []
  const re = /\b((?:(?:abstract|final|readonly)\s+)*)class\s+([A-Za-z_]\w*)\s+extends\s+(\\?[A-Za-z_][\w\\]*)[^{]*\{/g
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const open = m.index + m[0].length - 1
    const close = matchingBrace(src, open)
    const body = close === -1 ? '' : src.slice(open + 1, close)
    const idBody = methodBody(body, 'id')
    const id = idBody ? (/^\s*return\s+(['"])([^'"\\]+)\1\s*;\s*$/.exec(idBody)?.[2] ?? null) : null
    classes.push({
      key: qualify(m[2]).toLowerCase(),
      name: m[2],
      abstract: /\babstract\b/.test(m[1]),
      parent: qualify(m[3]).toLowerCase(),
      id,
      canBootstrap: methodBody(body, 'canBootstrap')
    })
    if (close !== -1) re.lastIndex = close
  }
  return classes
}

type Tri = boolean | null

/** Evaluates simple `canBootstrap()` bodies; null = cannot tell. */
class ConditionEvaluator {
  private pos = 0
  private tokens: string[] = []

  constructor(
    private readonly project: Project,
    private readonly parentCheck: () => Tri
  ) {}

  evaluate(body: string): Tri {
    const m = /^\s*return\s+([\s\S]*?);\s*$/.exec(body)
    if (!m) return null
    const tokens = m[1].match(/\(|\)|!|&&|\|\||\band\b|\bor\b|'[^']*'|"[^"]*"|parent::canBootstrap|[\w$]+|\S/gi)
    if (!tokens) return null
    this.tokens = tokens
    this.pos = 0
    try {
      const value = this.or()
      return this.pos === this.tokens.length ? value : null
    } catch {
      return null
    }
  }

  private peek(): string | undefined {
    return this.tokens[this.pos]
  }

  private expect(token: string): void {
    if (this.tokens[this.pos]?.toLowerCase() !== token) throw new Error(`expected ${token}`)
    this.pos++
  }

  private or(): Tri {
    let value = this.and()
    while (this.peek() === '||' || this.peek()?.toLowerCase() === 'or') {
      this.pos++
      const right = this.and()
      value = value === true || right === true ? true : value === false && right === false ? false : null
    }
    return value
  }

  private and(): Tri {
    let value = this.unary()
    while (this.peek() === '&&' || this.peek()?.toLowerCase() === 'and') {
      this.pos++
      const right = this.unary()
      value = value === false || right === false ? false : value === true && right === true ? true : null
    }
    return value
  }

  private unary(): Tri {
    if (this.peek() === '!') {
      this.pos++
      const value = this.unary()
      return value === null ? null : !value
    }
    return this.atom()
  }

  private atom(): Tri {
    const token = this.peek()
    if (token === undefined) throw new Error('unexpected end')
    if (token === '(') {
      this.pos++
      const value = this.or()
      this.expect(')')
      return value
    }
    const lower = token.toLowerCase()
    this.pos++
    if (lower === 'true') return true
    if (lower === 'false') return false
    if (lower === 'parent::canbootstrap') {
      this.skipArguments()
      return this.parentCheck()
    }
    if (lower === 'file_exists' || lower === 'is_file' || lower === 'is_dir') {
      // fn($var . '/relative')
      this.expect('(')
      const variable = this.tokens[this.pos++]
      const dot = this.tokens[this.pos++]
      const literal = this.tokens[this.pos++]
      this.expect(')')
      if (!variable?.startsWith('$') || dot !== '.' || !/^(['"])\/[^'"]*\1$/.test(literal ?? '')) return null
      const rel = literal.slice(1, -1)
      return lower === 'is_file' ? this.project.file(rel) : lower === 'is_dir' ? this.project.dir(rel) : this.project.exists(rel)
    }
    // Any other call / expression: skip it (balanced parentheses) and give up on the value.
    this.skipArguments()
    return null
  }

  private skipArguments(): void {
    if (this.peek() !== '(') return
    let depth = 0
    do {
      const token = this.tokens[this.pos++]
      if (token === '(') depth++
      else if (token === ')') depth--
    } while (depth > 0 && this.pos < this.tokens.length)
  }
}

/** Project drivers in the order DriverRegistry tries them: subclasses before the classes they extend. */
function subclassesFirst(classes: DriverClass[], all: Map<string, DriverClass>): DriverClass[] {
  const extendsClass = (child: DriverClass, ancestor: DriverClass): boolean => {
    const seen = new Set<string>()
    for (let parent = all.get(child.parent); parent && !seen.has(parent.key); parent = all.get(parent.parent)) {
      if (parent.key === ancestor.key) return true
      seen.add(parent.key)
    }
    return false
  }
  const ordered: DriverClass[] = []
  for (const cls of classes) {
    const position = ordered.findIndex((existing) => extendsClass(cls, existing))
    ordered.splice(position === -1 ? ordered.length : position, 0, cls)
  }
  return ordered
}

/** Id of the first project driver (`.tinkerbox/drivers/*.php`) that would bootstrap the project, or null. */
function projectDriver(project: Project): string | null {
  const driversDir = join(project.root, '.tinkerbox', 'drivers')
  let files: string[]
  try {
    files = readdirSync(driversDir)
      .filter((f) => f.toLowerCase().endsWith('.php') && !f.startsWith('.') && isFile(join(driversDir, f)))
      .sort()
  } catch {
    return null
  }
  const all = new Map<string, DriverClass>()
  const order: DriverClass[] = []
  for (const file of files) {
    let source: string
    try {
      source = readFileSync(join(driversDir, file), 'utf8')
    } catch {
      continue // unreadable driver file (the runner reports it)
    }
    for (const cls of parseDriverFile(source)) {
      if (all.has(cls.key) || BUILTIN_CLASSES.has(cls.key)) continue // redeclaration: skipped by the runner too
      all.set(cls.key, cls)
      order.push(cls)
    }
  }

  /** The built-in a class extends (directly or through other project classes); null = not a driver. */
  const builtinBase = (cls: DriverClass, seen = new Set<string>()): { sniffer: BuiltinSniffer | null } | null => {
    if (seen.has(cls.key)) return null
    seen.add(cls.key)
    if (BUILTIN_CLASSES.has(cls.parent)) return { sniffer: BUILTIN_CLASSES.get(cls.parent) ?? null }
    const parent = all.get(cls.parent)
    return parent ? builtinBase(parent, seen) : null
  }
  const idOf = (cls: DriverClass): string => {
    for (let current: DriverClass | undefined = cls, depth = 0; current && depth < 50; current = all.get(current.parent), depth++) {
      if (current.id !== null) return current.id
      const builtin = BUILTIN_CLASSES.get(current.parent)
      if (builtin) return builtin.id
    }
    return cls.name.toLowerCase()
  }
  const canBootstrap = (cls: DriverClass, depth = 0): Tri => {
    if (depth > 50) return null
    const parentCheck = (): Tri => {
      const builtin = BUILTIN_CLASSES.get(cls.parent)
      if (builtin !== undefined) return builtin === null ? null : builtin.canBootstrap(project)
      const parent = all.get(cls.parent)
      return parent ? canBootstrap(parent, depth + 1) : null
    }
    return cls.canBootstrap === null ? parentCheck() : new ConditionEvaluator(project, parentCheck).evaluate(cls.canBootstrap)
  }

  const candidates = order.filter((cls) => !cls.abstract && builtinBase(cls) !== null)
  for (const cls of subclassesFirst(candidates, all)) {
    // Unknown (null) counts as a match: only PHP can evaluate arbitrary canBootstrap() code.
    if (canBootstrap(cls) !== false) return idOf(cls)
  }
  return null
}

/**
 * Driver id the runner would pick (see DriverInfo.id), or null for plain PHP (the runner's "none").
 */
export function sniffDriver(dir: string): string | null {
  const root = resolve(dir).replace(/[\\/]+$/, '') || resolve(dir)
  const project = new Project(root)
  const custom = projectDriver(project)
  if (custom) return custom === 'none' ? null : custom
  for (const builtin of BUILTINS) {
    if (builtin.canBootstrap(project)) return builtin.id
  }
  return null
}

/** Display name: composer.json "name" (unless it is a framework skeleton default) or the folder name. */
export function projectName(dir: string): string {
  const folder = basename(resolve(dir)) || dir
  const name = readComposer(dir)?.name
  if (typeof name === 'string' && name.trim() && !SKELETON_NAMES.has(name.trim().toLowerCase())) return name.trim()
  return folder
}

/** File-system-only detection for a local folder: `{ driver, name }`. */
export async function detectLocalProject(path: string): Promise<{ driver: string | null; name: string }> {
  const dir = resolve(path)
  if (!isDir(dir)) return { driver: null, name: basename(dir) || path }
  return { driver: sniffDriver(dir), name: projectName(dir) }
}
