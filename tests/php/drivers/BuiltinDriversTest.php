<?php
/**
 * Built-in drivers after bootstrapping: version() labels, the variables injected into the user's scope, log folders
 * and panels, plus the shared Tinkerbox\Drivers\Support helpers.
 *
 * Framework classes are faked in a separate PHP process (p3_php_script) so nothing leaks into the harness; the
 * drivers' private state is set by reflection as if bootstrap() had run.
 */

require_once __DIR__ . '/support.php';

use Tinkerbox\Drivers;

if (!function_exists('p3_builtin_results')) {
    /**
     * Fake framework classes + the questions asked of each driver, evaluated in a separate process.
     * Returns ['versions' => key => version(), 'variables' => key => variable names, …].
     */
    function p3_builtin_results(?string $php = null): array
    {
        $installed = p3_write_tree(p3_tmpdir('installed'), [
            'vendor/composer/installed.json' => json_encode(['packages' => [
                ['name' => 'statamic/cms', 'version' => 'v5.12.0'],
                ['name' => 'shopware/core', 'version' => 'v6.6.4.0'],
                ['name' => 'laravel-zero/framework', 'version' => 'v11.0.1'],
                ['name' => 'october/system', 'version' => 'v3.6.30'],
                ['name' => 'roots/acorn', 'version' => 'v4.3.0'],
                ['name' => 'orchestra/testbench-core', 'version' => 'v9.5.2'],
            ]]),
        ]);
        $script = <<<'PHP'
namespace Kirby\Cms {
    class App {
        public static function version() { return '4.3.0'; }
        public function site() { return 'site-object'; }
    }
}
namespace Symfony\Component\HttpKernel {
    abstract class Kernel { const VERSION = '7.1.3'; }
}
namespace CodeIgniter {
    class CodeIgniter { const CI_VERSION = '4.5.5'; }
}
namespace Cake\Core {
    class Configure { public static function version() { return '5.0.10'; } }
}
namespace Roots {
    function app($service = null) { return $service === null ? $GLOBALS['__acorn'] : 'service:' . $service; }
}
namespace {
    class Drupal { const VERSION = '10.3.1'; }
    class Yii { public static function getVersion() { return '2.0.51'; } }
    class Context { public static function getContext() { return (object) ['shop' => 'default']; } }
    function get_bloginfo($show = '') { return $show === 'version' ? '6.6.2' : 'Fixture Blog'; }
    define('_PS_VERSION_', '8.1.7');
    define('VERSION', '7.101');
    define('TYPO3_version', '12.4.20');
    define('JVERSION', '5.1.2');

    class P3FakeApp {
        public $label;
        public function __construct($label) { $this->label = $label; }
        public function version() { return $this->label; }
        public function make($id) { return $this; }
        public function storagePath() { return '/srv/app/storage'; }
    }
    class P3FakeContainer {
        public function has($id) { return true; }
        public function get($id) { return 'service:' . $id; }
        public function hasParameter($name) { return true; }
        public function getParameter($name) { return '5.7.19'; }
    }
    class P3FakeKernel {
        public function getContainer() { return new P3FakeContainer(); }
        public function getLogDir() { return '/srv/app/var/log'; }
    }
    class P3FakeMetadata { public function getVersion() { return '2.4.7'; } }
    class P3FakeObjectManager { public function get($id) { return new P3FakeMetadata(); } }

    $GLOBALS['__result'] = (function () {
        $installed = getenv('P3_INSTALLED');
        // Private driver state, declared by the driver class or one of its parents.
        $set = function ($object, $property, $value) {
            for ($class = new \ReflectionClass($object); $class !== false; $class = $class->getParentClass()) {
                if ($class->hasProperty($property)) {
                    $reflection = $class->getProperty($property);
                    if (PHP_VERSION_ID < 80100) {
                        $reflection->setAccessible(true);
                    }
                    $reflection->setValue($object, $value);

                    return;
                }
            }
            throw new \RuntimeException('no property ' . $property);
        };
        $ns = 'Tinkerbox\\Drivers\\';
        $drivers = [];

        foreach (['LaravelDriver' => '12.1.0', 'TestbenchDriver' => '11.2.0', 'LumenDriver' => 'Lumen (10.0.4) (Laravel Components ^10.0)'] as $class => $label) {
            $fqcn = $ns . $class;
            $driver = new $fqcn();
            $set($driver, 'app', new P3FakeApp($label));
            $set($driver, 'root', $installed);
            $drivers[$class] = $driver;
        }
        foreach (['StatamicDriver', 'LaravelZeroDriver', 'OctoberDriver'] as $class) {
            $fqcn = $ns . $class;
            $driver = new $fqcn();
            $set($driver, 'app', new P3FakeApp('11.37.0'));
            $set($driver, 'root', $installed);
            $drivers[$class] = $driver;
        }
        $kirby = new \Tinkerbox\Drivers\KirbyDriver();
        $set($kirby, 'kirby', new \Kirby\Cms\App());
        $drivers['KirbyDriver'] = $kirby;

        $GLOBALS['CFG'] = (object) ['release' => '4.4.1 (Build: 20240610)'];
        $GLOBALS['DB'] = (object) ['driver' => 'mysqli'];
        $drivers['MoodleDriver'] = new \Tinkerbox\Drivers\MoodleDriver();

        $craft = new \Tinkerbox\Drivers\CraftDriver();
        $set($craft, 'app', (object) ['version' => '5.4.2']);
        $drivers['CraftDriver'] = $craft;

        $magento = new \Tinkerbox\Drivers\Magento2Driver();
        $set($magento, 'objectManager', new P3FakeObjectManager());
        $drivers['Magento2Driver'] = $magento;

        foreach (['SymfonyDriver', 'ShopwareDriver'] as $class) {
            $fqcn = $ns . $class;
            $driver = new $fqcn();
            $set($driver, 'kernel', new P3FakeKernel());
            $set($driver, 'root', $installed);
            $drivers[$class] = $driver;
        }
        $shopware5 = new \Tinkerbox\Drivers\ShopwareDriver();
        $set($shopware5, 'kernel', new P3FakeKernel());
        $set($shopware5, 'major', 5);
        $drivers['Shopware5'] = $shopware5;

        $GLOBALS['wp_version'] = '6.6.2';
        $GLOBALS['wpdb'] = (object) ['prefix' => 'wp_'];
        $GLOBALS['__acorn'] = new P3FakeApp('Acorn 4.3.0 (Laravel 11.21.0)');
        $drivers['WordPressDriver'] = new \Tinkerbox\Drivers\WordPressDriver();
        $drivers['BedrockDriver'] = new \Tinkerbox\Drivers\BedrockDriver();
        $radicle = new \Tinkerbox\Drivers\RadicleDriver();
        $set($radicle, 'root', $installed);
        $drivers['RadicleDriver'] = $radicle;
        $drivers['RadicleWithoutMetadata'] = new \Tinkerbox\Drivers\RadicleDriver();

        foreach (['DrupalDriver', 'Drupal7Driver', 'PrestaShopDriver', 'Typo3Driver', 'CodeIgniter4Driver', 'Yii2Driver', 'CakePhpDriver', 'JoomlaDriver', 'PlainDriver'] as $class) {
            $fqcn = $ns . $class;
            $drivers[$class] = new $fqcn();
        }
        $composer = new \Tinkerbox\Drivers\ComposerDriver();
        $set($composer, 'root', getenv('P3_COMPOSER'));
        $drivers['ComposerDriver'] = $composer;

        $versions = [];
        $variables = [];
        foreach ($drivers as $key => $driver) {
            try {
                $versions[$key] = $driver->version();
            } catch (\Throwable $e) {
                $versions[$key] = 'THROWS ' . get_class($e) . ': ' . $e->getMessage();
            }
            try {
                $variables[$key] = [];
                foreach ($driver->variables() as $name => $value) {
                    $variables[$key][$name] = is_object($value) ? get_class($value) : gettype($value);
                }
            } catch (\Throwable $e) {
                $variables[$key] = 'THROWS ' . get_class($e) . ': ' . $e->getMessage();
            }
        }

        return [
            'versions' => $versions,
            'variables' => $variables,
            'logs' => [
                'laravel' => $drivers['LaravelDriver']->logsPath('/elsewhere'),
                'symfony' => $drivers['SymfonyDriver']->logsPath('/elsewhere'),
                'shopware' => $drivers['ShopwareDriver']->logsPath('/elsewhere'),
                'magento' => $drivers['Magento2Driver']->logsPath('/srv/shop'),
                'craft' => (new \Tinkerbox\Drivers\CraftDriver())->logsPath('/srv/craft'),
            ],
            'pretty' => [
                'wordpress' => $drivers['WordPressDriver']->prettyErrors(),
                'laravel' => $drivers['LaravelDriver']->prettyErrors(),
            ],
            'radiclePanels' => array_column($drivers['RadicleDriver']->panels(''), 'title'),
            'acornPanel' => $drivers['RadicleDriver']->panels('')[1],
            'magentoArea' => $drivers['Magento2Driver']->variables()['area']->code(),
        ];
    })();
}
PHP;
        putenv('P3_INSTALLED=' . $installed);
        putenv('P3_COMPOSER=' . p3_fixture('composer'));
        try {
            return p3_php_script($script, $php, null, true);
        } finally {
            putenv('P3_INSTALLED');
            putenv('P3_COMPOSER');
        }
    }
}

$tests = [];

$tests['version() labels'] = function () {
    $result = p3_builtin_results();
    t_same([
        'LaravelDriver' => 'Laravel 12.1.0',
        'TestbenchDriver' => 'Testbench 9.5.2 (Laravel 11.2.0)',
        'LumenDriver' => 'Lumen 10.0.4',
        'StatamicDriver' => 'Statamic 5.12.0 (Laravel 11.37.0)',
        'LaravelZeroDriver' => 'Laravel Zero 11.0.1 (Laravel 11.37.0)',
        'OctoberDriver' => 'October CMS 3.6.30 (Laravel 11.37.0)',
        'KirbyDriver' => 'Kirby 4.3.0',
        'MoodleDriver' => 'Moodle 4.4.1 (Build: 20240610)',
        'CraftDriver' => 'Craft CMS 5.4.2',
        'Magento2Driver' => 'Magento 2.4.7',
        'SymfonyDriver' => 'Symfony 7.1.3',
        'ShopwareDriver' => 'Shopware 6.6.4.0 (prod)',
        'Shopware5' => 'Shopware 5.7.19',
        'WordPressDriver' => 'WordPress 6.6.2',
        'BedrockDriver' => 'WordPress 6.6.2 (Bedrock)',
        'RadicleDriver' => 'WordPress 6.6.2 + Acorn 4.3.0',
        'RadicleWithoutMetadata' => 'WordPress 6.6.2 + Acorn 4.3.0 (Laravel 11.21.0)',
        'DrupalDriver' => 'Drupal 10.3.1',
        'Drupal7Driver' => 'Drupal 7.101',
        'PrestaShopDriver' => 'PrestaShop 8.1.7',
        'Typo3Driver' => 'TYPO3 12.4.20',
        'CodeIgniter4Driver' => 'CodeIgniter 4.5.5',
        'Yii2Driver' => 'Yii 2.0.51',
        'CakePhpDriver' => 'CakePHP 5.0.10',
        'JoomlaDriver' => 'Joomla 5.1.2',
        'PlainDriver' => null,
        'ComposerDriver' => 'acme/greeter',
    ], $result['versions']);
};

$tests['variables injected into the user scope'] = function () {
    $result = p3_builtin_results();
    $variables = $result['variables'];
    t_same(['app' => 'P3FakeApp'], $variables['LaravelDriver']);
    t_same(['app' => 'P3FakeApp'], $variables['StatamicDriver']);
    t_same(['app' => 'P3FakeApp'], $variables['LumenDriver']);
    t_same(['kirby' => 'Kirby\Cms\App', 'site' => 'string'], $variables['KirbyDriver']);
    t_same(['CFG' => 'stdClass', 'DB' => 'stdClass'], $variables['MoodleDriver']);
    t_same(['craft' => 'stdClass'], $variables['CraftDriver']);
    t_same(['objectManager' => 'P3FakeObjectManager', 'area' => 'Tinkerbox\Drivers\MagentoArea'], $variables['Magento2Driver']);
    t_same(['kernel' => 'P3FakeKernel', 'container' => 'P3FakeContainer'], $variables['SymfonyDriver']);
    t_same(['kernel' => 'P3FakeKernel', 'container' => 'P3FakeContainer', 'definitions' => 'string'], $variables['ShopwareDriver']);
    t_same(['kernel' => 'P3FakeKernel', 'container' => 'P3FakeContainer'], $variables['Shopware5']);
    t_same(['wpdb' => 'stdClass'], $variables['WordPressDriver']);
    t_same(['wpdb' => 'stdClass'], $variables['BedrockDriver']);
    t_same(['wpdb' => 'stdClass', 'app' => 'P3FakeApp'], $variables['RadicleDriver']);
    t_same(['context' => 'stdClass'], $variables['PrestaShopDriver']);
    t_same([], $variables['DrupalDriver'], 'not booted');
    t_same([], $variables['ComposerDriver']);
    t_same([], $variables['PlainDriver']);
    t_same(null, $result['magentoArea'], 'no area code set');
};

$tests['log folders, error preferences and panels of booted drivers'] = function () {
    $result = p3_builtin_results();
    t_same([
        'laravel' => '/srv/app/storage' . DIRECTORY_SEPARATOR . 'logs',
        'symfony' => '/srv/app/var/log',
        'shopware' => '/srv/app/var/log',
        'magento' => '/srv/shop/var/log',
        'craft' => '/srv/craft/storage/logs',
    ], $result['logs']);
    t_same(['wordpress' => false, 'laravel' => null], $result['pretty']);
    t_same(['Site Information', 'Acorn'], $result['radiclePanels']);
    t_same('Acorn', $result['acornPanel']['title']);
    t_same('Acorn 4.3.0 (Laravel 11.21.0)', p3_panel_rows($result['acornPanel'], 'Environment')['Laravel Version']);
};

$tests['results are identical on PHP 7.4 and 8.5'] = function () {
    $binaries = p3_php_binaries();
    if (!$binaries) {
        p3_skip('no Herd php74 / php85 binaries');

        return;
    }
    $reference = p3_builtin_results();
    unset($reference['acornPanel']); // contains the PHP version
    foreach ($binaries as $alias => $binary) {
        $result = p3_builtin_results($binary);
        unset($result['acornPanel']);
        t_same($reference, $result, $alias);
    }
};

$tests['Support: paths, composer metadata and labels'] = function () {
    $s = 'Tinkerbox\Drivers\Support';
    t_same('', $s::path(''));
    t_same('/srv/app', $s::path('/srv/app///'));
    t_same(DIRECTORY_SEPARATOR, $s::path('/'));
    t_same('C:' . DIRECTORY_SEPARATOR, $s::path('C:\\'));
    t_same(true, $s::isAbsolute('/srv'));
    t_same(true, $s::isAbsolute('C:\\app'));
    t_same(false, $s::isAbsolute('storage/logs'));
    t_same('Statamic 5.12.0 (Laravel 11.37.0)', $s::label('Statamic', '5.12.0', 'Laravel 11.37.0'));
    t_same('Composer', $s::label('Composer', '', ''));
    t_same('Composer (dev)', $s::label('Composer', null, 'dev'));

    $project = p3_write_tree(p3_tmpdir('composer-meta'), [
        'composer.json' => json_encode(['name' => 'acme/app', 'require' => ['laravel/framework' => '^12'], 'require-dev' => ['orchestra/testbench' => '^9'], 'config' => ['vendor-dir' => 'deps']]),
        'deps/composer/installed.json' => json_encode([['name' => 'acme/legacy', 'version' => 'v1.2.3'], ['name' => 'acme/dev', 'version' => 'dev-main']]),
    ]);
    t_same(true, $s::composerRequires($project, 'laravel/framework'));
    t_same(true, $s::composerRequires($project, 'orchestra/testbench'));
    t_same(false, $s::composerRequires($project, 'symfony/symfony'));
    t_same($project . '/deps', $s::vendorDir($project));
    t_same('1.2.3', $s::packageVersion($project, 'acme/legacy'), 'Composer 1 installed.json, v prefix stripped');
    t_same('dev-main', $s::packageVersion($project, 'acme/dev'));
    t_same(null, $s::packageVersion($project, 'acme/missing'));
    t_same([], $s::composerJson(p3_tmpdir('empty')));
    $broken = p3_write_tree(p3_tmpdir('broken'), ['composer.json' => '{broken']);
    t_same([], $s::composerJson($broken));
    t_same(null, $s::requireAutoload($broken, false));
    t_throws(function () use ($s, $broken) {
        $s::requireAutoload($broken);
    }, 'RuntimeException');
    t_contains('composer install', t_throws(function () use ($s, $broken) {
        $s::requireAutoload($broken);
    })->getMessage());
};

$tests['Support: declared classes are read with the tokenizer (never included)'] = function () {
    $code = <<<'PHP'
<?php
namespace Acme\Shop;

use Foo\Bar;

interface Payable {}
trait Loggable {}
abstract class Base {}
final class Order extends Base implements Payable
{
    public function name() { return static::class . Order::class; }
    public function make() { return new class {}; }
}
PHP;
    t_same(['Acme\Shop\Payable', 'Acme\Shop\Loggable', 'Acme\Shop\Base', 'Acme\Shop\Order'], Drivers\Support::declaredClassesInCode($code));
    t_same(['First\A', 'Second\B', 'C'], Drivers\Support::declaredClassesInCode("<?php\nnamespace First { class A {} }\nnamespace Second { class B {} }\nnamespace { class C { function f() { return namespace\\C::class; } } }\n"));
    if (PHP_VERSION_ID >= 80100) {
        t_same(['App\Status'], Drivers\Support::declaredClassesInCode("<?php\nnamespace App;\nenum Status: string { case Active = 'a'; }\n"));
    }
    t_same([], Drivers\Support::declaredClassesInFile('/definitely/missing.php'));
};

$tests['Support: projectFiles() is bounded and skips vendor, hidden and excluded folders'] = function () {
    $root = p3_tmpdir('scan');
    $tree = ['a.php' => '<?php', 'lib/b.php' => '<?php', 'lib/c.txt' => 'x', '.hidden/d.php' => '<?php', 'vendor/e.php' => '<?php', 'sub/vendor/f.php' => '<?php', 'storage/g.php' => '<?php'];
    for ($i = 0; $i < 30; $i++) {
        $tree['many/file' . $i . '.php'] = '<?php';
    }
    p3_write_tree($root, $tree);
    $all = Drivers\Support::projectFiles($root, ['storage']);
    t_same(32, count($all));
    t_assert(in_array('a.php', $all, true) && in_array('lib/b.php', $all, true));
    foreach ($all as $file) {
        t_assert(strpos($file, 'vendor') === false && strpos($file, '.hidden') === false && strpos($file, 'storage') === false, $file);
    }
    t_same(5, count(Drivers\Support::projectFiles($root, [], 5)));
    t_same('a.php', Drivers\Support::projectFiles($root, [], 1)[0], 'breadth-first: root files first');
    t_same([], Drivers\Support::projectFiles('/definitely/missing'));
};

return $tests;
