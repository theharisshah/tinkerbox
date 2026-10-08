import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { detectLocalProject, sniffDriver } from '../../../src/main/execution/detectProject'
import { cleanupTempDirs, hasHerdPhp, herdPhp83, makeTempDir, repoRoot, writeTree } from './helpers'

afterAll(cleanupTempDirs)

const composer = (name: string, require: Record<string, string> = {}, requireDev: Record<string, string> = {}): string =>
  JSON.stringify({ name, require, 'require-dev': requireDev })

function project(files: Record<string, string>, folder = 'my-app'): string {
  const dir = join(makeTempDir('tw-detect-'), folder)
  writeTree(dir, files)
  return dir
}

describe('detectLocalProject', () => {
  // Installed-project markers, mirroring the PHP drivers' canBootstrap() (resources/php/src/Drivers/*Drivers.php).
  const cases: Array<[string, Record<string, string>]> = [
    ['laravel', { artisan: '', 'bootstrap/app.php': '', 'composer.json': composer('laravel/laravel', { 'laravel/framework': '^12' }) }],
    ['lumen', { artisan: '', 'bootstrap/app.php': '', 'vendor/laravel/lumen-framework/composer.json': '' }],
    ['laravel-zero', { application: '', 'bootstrap/app.php': '', 'vendor/laravel-zero/framework/composer.json': '' }],
    ['statamic', { artisan: '', please: '', 'bootstrap/app.php': '', 'vendor/statamic/cms/composer.json': '' }],
    ['october', { artisan: '', 'bootstrap/app.php': '', 'modules/system/ServiceProvider.php': '', 'composer.json': composer('october/october', { 'october/rain': '^3' }) }],
    ['wordpress', { 'wp-load.php': '', 'wp-config.php': '', 'wp-includes/version.php': '' }],
    ['wordpress', { 'wp/wp-load.php': '', 'wp/wp-includes/version.php': '', 'composer.json': composer('acme/site', { 'johnpbloch/wordpress': '^6' }) }],
    ['bedrock', { 'config/application.php': '', 'web/wp/wp-load.php': '', 'web/wp/wp-includes/version.php': '', 'composer.json': composer('roots/bedrock', { 'roots/wordpress': '^6' }) }],
    ['radicle', { 'bedrock/application.php': '', 'public/wp/wp-load.php': '', 'public/wp/wp-includes/version.php': '' }],
    ['radicle', { 'config/application.php': '', 'vendor/roots/acorn/composer.json': '', 'web/wp/wp-load.php': '', 'web/wp/wp-includes/version.php': '' }],
    ['symfony', { 'bin/console': '', 'src/Kernel.php': '', 'vendor/symfony/framework-bundle/composer.json': '' }],
    ['symfony', { 'bin/console': '', 'src/Kernel.php': '', 'composer.json': composer('symfony/skeleton', { 'symfony/framework-bundle': '^7' }) }],
    ['shopware', { 'bin/console': '', 'vendor/shopware/core/Framework/ShopwareHttpException.php': '', 'symfony.lock': '' }],
    ['shopware', { 'shopware.php': '', 'engine/Shopware/Kernel.php': '' }],
    ['drupal', { 'web/core/lib/Drupal.php': '', 'composer.json': composer('drupal/recommended-project') }],
    ['drupal7', { 'includes/bootstrap.inc': '', 'modules/system/system.module': '' }],
    ['drupal7', { 'docroot/includes/bootstrap.inc': '', 'docroot/modules/system/system.module': '' }],
    ['craft', { craft: '', 'composer.json': composer('craftcms/craft', { 'craftcms/cms': '^5' }) }],
    ['magento2', { 'bin/magento': '', 'app/etc/env.php': '', 'app/bootstrap.php': '' }],
    ['kirby', { 'kirby/bootstrap.php': '', 'site/config/config.php': '' }],
    ['kirby', { 'vendor/getkirby/cms/bootstrap.php': '', 'content/home/home.txt': '' }],
    ['typo3', { 'vendor/typo3/cms-core/Classes/Core/Bootstrap.php': '' }],
    ['testbench', { 'vendor/orchestra/testbench-core/laravel/public/index.php': '' }],
    ['cakephp', { 'bin/cake': '', 'config/bootstrap.php': '', 'composer.json': composer('cakephp/app', { 'cakephp/cakephp': '^5' }) }],
    ['codeigniter4', { spark: '', 'app/Config/Paths.php': '' }],
    ['yii2', { yii: '', 'vendor/yiisoft/yii2/Yii.php': '' }],
    ['joomla', { 'configuration.php': '', 'includes/defines.php': '', 'libraries/src/Version.php': '' }],
    ['moodle', { 'config.php': '', 'lib/moodlelib.php': '', 'version.php': '' }],
    ['moodle', { 'config.php': '', 'public/lib/moodlelib.php': '', 'public/version.php': '' }],
    ['prestashop', { 'config/config.inc.php': '', 'classes/ObjectModel.php': '' }],
    ['composer', { 'vendor/autoload.php': '', 'composer.json': composer('acme/lib') }],
    ['composer', { 'lib/autoload.php': '', 'composer.json': JSON.stringify({ name: 'acme/lib', config: { 'vendor-dir': 'lib' } }) }],
    ['statamic', { artisan: '', 'bootstrap/app.php': '', 'deps/statamic/cms/composer.json': '', 'composer.json': JSON.stringify({ config: { 'vendor-dir': 'deps' } }) }]
  ]

  it.each(cases)('detects %s', async (driver, files) => {
    expect((await detectLocalProject(project(files))).driver).toBe(driver)
  })

  it('needs what bootstrapping needs, not only composer.json requirements or marker files', async () => {
    expect(sniffDriver(project({ 'composer.json': composer('acme/site', { 'typo3/cms-core': '^13' }) }))).toBeNull()
    expect(sniffDriver(project({ 'composer.json': composer('acme/package', {}, { 'orchestra/testbench': '^9' }) }))).toBeNull()
    // Marker-only Kirby / WordPress folders are not bootstrappable (no site/content, no wp-includes/version.php).
    expect(sniffDriver(project({ 'kirby/bootstrap.php': '' }))).toBeNull()
    expect(sniffDriver(project({ 'wp-load.php': '' }))).toBeNull()
    // Testbench yields to an application with its own front controller.
    expect(sniffDriver(project({ artisan: '', 'bootstrap/app.php': '', 'public/index.php': '', 'vendor/orchestra/testbench-core/laravel/public/index.php': '' }))).toBe('laravel')
    // Laravel needs bootstrap/app.php, Symfony a kernel, Drupal 7 its bootstrap files.
    expect(sniffDriver(project({ artisan: '', 'public/index.php': '' }))).toBeNull()
    expect(sniffDriver(project({ 'bin/console': '', 'public/index.php': '', 'symfony.lock': '' }))).toBeNull()
    expect(sniffDriver(project({ 'misc/drupal.js': '' }))).toBeNull()
  })

  describe('project drivers (.tinkerbox/drivers/*.php)', () => {
    const laravelApp = { artisan: '', 'bootstrap/app.php': '' }

    it('uses the id() of the first concrete driver whose canBootstrap() matches', () => {
      const dir = project({
        ...laravelApp,
        'shop.json': '{}',
        '.tinkerbox/drivers/AbstractBase.php': '<?php abstract class AbstractBaseDriver extends \\Tinkerbox\\Drivers\\Driver { public function id(): string { return "base"; } }',
        '.tinkerbox/drivers/Billing.php': "<?php\nclass BillingDriver extends AbstractBaseDriver {\n  public function canBootstrap(string $projectPath): bool { return file_exists($projectPath . '/billing.json'); }\n}",
        '.tinkerbox/drivers/Shop.php': [
          '<?php',
          'use Tinkerbox\\Drivers\\LaravelDriver;',
          '',
          'class ShopDriver extends LaravelDriver',
          '{',
          "    public function id(): string { return 'shop'; } // the driver id",
          '    public function canBootstrap(string $projectPath): bool',
          '    {',
          "        return is_file($projectPath . '/shop.json') && !is_dir($projectPath . '/billing');",
          '    }',
          '}'
        ].join('\n')
      })
      expect(sniffDriver(dir)).toBe('shop')
    })

    it('inherits ids and canBootstrap() from built-in and project parents', () => {
      const inherit = "<?php\nnamespace Acme;\nclass TeamDriver extends \\Tinkerbox\\Drivers\\LaravelDriver {\n  public function variables(): array { return []; }\n}"
      expect(sniffDriver(project({ ...laravelApp, '.tinkerbox/drivers/Team.php': inherit }))).toBe('laravel')
      expect(sniffDriver(project({ 'README.md': '', '.tinkerbox/drivers/Team.php': inherit }))).toBeNull()

      const chained = project({
        ...laravelApp,
        'acme.marker': '',
        '.tinkerbox/drivers/A.php': "<?php\nclass ChildDriver extends ParentDriver {\n  public function canBootstrap(string $p): bool { return parent::canBootstrap($p) && file_exists($p . '/acme.marker'); }\n}",
        '.tinkerbox/drivers/B.php': "<?php\nclass ParentDriver extends Tinkerbox\\Drivers\\LaravelDriver {\n  public function id(): string { return 'acme'; }\n}"
      })
      expect(sniffDriver(chained)).toBe('acme')
    })

    it('assumes a match when canBootstrap() cannot be evaluated, and ignores non-drivers', () => {
      const dir = project({
        '.tinkerbox/drivers/Helpers.php': '<?php class Helper extends ArrayObject {}',
        '.tinkerbox/drivers/Custom.php': "<?php\nclass CustomDriver extends \\Tinkerbox\\Drivers\\Driver {\n  public function id(): string { return 'custom-app'; }\n  public function canBootstrap(string $p): bool { return getenv('APP') === 'x'; }\n}"
      })
      expect(sniffDriver(dir)).toBe('custom-app')
      expect(sniffDriver(project({ ...laravelApp, '.tinkerbox/drivers/Helpers.php': '<?php class Helper extends ArrayObject {}' }))).toBe('laravel')
    })
  })

  it('returns null for empty or missing folders', async () => {
    expect(await detectLocalProject(project({ 'README.md': '' }, 'notes'))).toEqual({ driver: null, name: 'notes' })
    expect(await detectLocalProject('/definitely/not/here/app')).toEqual({ driver: null, name: 'app' })
  })

  it('names projects after composer.json unless it is a framework skeleton', async () => {
    expect((await detectLocalProject(project({ 'composer.json': composer('acme/billing') }, 'folder'))).name).toBe('acme/billing')
    expect((await detectLocalProject(project({ 'composer.json': composer('laravel/laravel') }, 'shop'))).name).toBe('shop')
    expect((await detectLocalProject(project({ 'composer.json': '{broken' }, 'broken-json'))).name).toBe('broken-json')
  })

  const fixtures = join(repoRoot, 'tests', 'fixtures', 'projects')
  const fixtureNames = existsSync(fixtures) ? readdirSync(fixtures).filter((n) => statSync(join(fixtures, n)).isDirectory()) : []
  /** Expected ids for folders whose name is not a driver id (null = plain PHP, the runner's "none"). */
  const special: Record<string, string | null> = {
    'kirby-composer': 'kirby',
    plain: null,
    shopware5: 'shopware',
    'typo3-classic': 'typo3'
  }
  const expected = (name: string): string | null => (name in special ? special[name] : name.startsWith('not-') ? null : name)

  it.skipIf(!fixtureNames.length)('detects every shared driver fixture project', async () => {
    for (const name of fixtureNames) {
      expect((await detectLocalProject(join(fixtures, name))).driver, name).toBe(expected(name))
    }
  })

  it.skipIf(!fixtureNames.length || !hasHerdPhp)('agrees with the PHP runner detect mode for every fixture', async () => {
    const homePath = makeTempDir('tw-detect-home-')
    const detectWithPhp = (projectPath: string): Promise<string> =>
      new Promise((resolvePromise, reject) => {
        const nonce = 'tw_detect'
        const child = spawn(herdPhp83, ['-d', 'xdebug.mode=off', join(repoRoot, 'resources', 'php', 'tinkerbox.php'), '-'], {
          cwd: projectPath,
          stdio: ['pipe', 'pipe', 'ignore']
        })
        let out = ''
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => (out += chunk))
        child.on('error', reject)
        child.on('close', () => {
          const match = new RegExp(`${nonce}BEGIN\\n([\\s\\S]*?)\\n${nonce}END`).exec(out)
          if (!match) return reject(new Error(`no envelope for ${projectPath}: ${out.slice(0, 500)}`))
          const envelope = JSON.parse(match[1]) as { data: { driver: { id: string } } | null; error?: string }
          resolvePromise(envelope.data?.driver.id ?? `error: ${envelope.error ?? 'unknown'}`)
        })
        child.stdin.end(JSON.stringify({ nonce, mode: 'detect', projectPath, driver: '', homePath, options: {} }))
      })

    const php = await Promise.all(fixtureNames.map((name) => detectWithPhp(join(fixtures, name))))
    fixtureNames.forEach((name, i) => {
      const id = php[i] === 'none' ? null : php[i]
      expect(sniffDriver(join(fixtures, name)), name).toBe(id)
    })
  })
})
