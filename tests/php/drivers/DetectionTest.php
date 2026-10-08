<?php
/**
 * Driver detection (docs/ARCHITECTURE.md §1.7) against the tests/fixtures/projects/<driver id> folders, including
 * negative fixtures, on the harness PHP and on PHP 7.4 / 8.5.
 */

require_once __DIR__ . '/support.php';

use Tinkerbox\DriverRegistry;
use Tinkerbox\Drivers;

$tests = [];

$tests['every fixture project is detected as its driver id'] = function () {
    $expected = p3_expected_fixture_ids();
    $warnings = count(DriverRegistry::warnings());
    $actual = [];
    foreach (scandir(p3_fixture()) as $name) {
        if ($name[0] === '.' || !is_dir(p3_fixture($name))) {
            continue;
        }
        t_assert(array_key_exists($name, $expected), "Fixture '$name' has no expected driver id in p3_expected_fixture_ids()");
        $actual[$name] = p3_detect(p3_fixture($name))->id();
    }
    ksort($expected);
    ksort($actual);
    t_same($expected, $actual);
    t_same([], p3_new_warnings($warnings), 'detection of the fixtures must not produce warnings');
};

$tests['fixture folders are named after the driver they exercise'] = function () {
    $aliases = ['kirby-composer' => 'kirby', 'shopware5' => 'shopware', 'typo3-classic' => 'typo3', 'plain' => 'none'];
    foreach (p3_expected_fixture_ids() as $folder => $id) {
        if (strpos($folder, 'not-') === 0) {
            t_same('none', $id, $folder);
            continue;
        }
        t_same(isset($aliases[$folder]) ? $aliases[$folder] : $folder, $id, $folder);
    }
};

$tests['detection works on PHP 7.4 and 8.5 with identical results'] = function () {
    $binaries = p3_php_binaries();
    if (!$binaries) {
        p3_skip('no Herd php74 / php85 binaries');

        return;
    }
    $code = '$out = [];'
        . '$root = ' . var_export(p3_fixture(), true) . ';'
        . 'foreach (scandir($root) as $n) { if ($n[0] === "." || !is_dir($root . "/" . $n)) continue;'
        . '  $out[$n] = \\Tinkerbox\\DriverRegistry::detect($root . "/" . $n, "", ' . var_export(p3_empty_home(), true) . ')->id(); }'
        . 'ksort($out); return ["ids" => $out, "warnings" => \\Tinkerbox\\DriverRegistry::warnings(), "php" => PHP_VERSION];';
    $expected = p3_expected_fixture_ids();
    ksort($expected);
    foreach ($binaries as $alias => $binary) {
        $result = p3_php_script($code, $binary);
        t_same($expected, $result['ids'], "fixture ids on $alias (PHP {$result['php']})");
        t_same([], $result['warnings'], "warnings on $alias");
    }
};

$tests['negative fixtures are not claimed by the driver they imitate'] = function () {
    $cases = [
        'not-laravel' => Drivers\LaravelDriver::class,
        'not-laravel-zero' => Drivers\LaravelZeroDriver::class,
        'not-symfony' => Drivers\SymfonyDriver::class,
        'not-wordpress' => Drivers\WordPressDriver::class,
        'not-yii' => Drivers\Yii2Driver::class,
        'not-kirby' => Drivers\KirbyDriver::class,
        'not-testbench' => Drivers\TestbenchDriver::class,
    ];
    foreach ($cases as $fixture => $class) {
        t_same(false, (new $class())->canBootstrap(p3_fixture($fixture)), "$class must not claim $fixture");
    }
    // Products built on a framework are claimed by the framework's driver too; the registry order picks the product.
    t_same(true, (new Drivers\LaravelDriver())->canBootstrap(p3_fixture('statamic')));
    t_same(true, (new Drivers\LaravelDriver())->canBootstrap(p3_fixture('october')));
    t_same(true, (new Drivers\WordPressDriver())->canBootstrap(p3_fixture('radicle')));
    t_same(true, (new Drivers\WordPressDriver())->canBootstrap(p3_fixture('bedrock')));
    t_same(true, (new Drivers\BedrockDriver())->canBootstrap(p3_fixture('bedrock')));
    t_same(false, (new Drivers\BedrockDriver())->canBootstrap(p3_fixture('wordpress')));
    t_same(false, (new Drivers\RadicleDriver())->canBootstrap(p3_fixture('bedrock')));
    t_same(true, (new Drivers\ComposerDriver())->canBootstrap(p3_fixture('symfony')));
    t_same(false, (new Drivers\ComposerDriver())->canBootstrap(p3_fixture('plain')));
    t_same(false, (new Drivers\Drupal7Driver())->canBootstrap(p3_fixture('drupal')));
    t_same(false, (new Drivers\SymfonyDriver())->canBootstrap(p3_fixture('shopware')), 'no kernel / framework bundle');
};

$tests['canBootstrap() needs what bootstrapping needs'] = function () {
    $dir = p3_tmpdir('markers');
    $make = function ($name, array $files) use ($dir) {
        $path = $dir . '/' . $name;
        mkdir($path, 0777, true);
        $tree = [];
        foreach ($files as $file) {
            $tree[$file] = '<?php // marker' . "\n";
        }

        return p3_write_tree($path, $tree);
    };
    $cases = [
        [Drivers\LaravelDriver::class, ['artisan', 'bootstrap/app.php'], true],
        [Drivers\LaravelDriver::class, ['artisan', 'public/index.php'], false],
        [Drivers\LaravelDriver::class, ['artisan'], false],
        [Drivers\TestbenchDriver::class, ['vendor/orchestra/testbench-core/laravel/bootstrap/app.php'], true],
        [Drivers\TestbenchDriver::class, ['public/index.php', 'vendor/orchestra/testbench-core/laravel/bootstrap/app.php'], false],
        [Drivers\CraftDriver::class, ['craft', 'vendor/craftcms/cms/bootstrap/console.php'], true],
        [Drivers\CraftDriver::class, ['craft', 'web/index.php'], false],
        [Drivers\MoodleDriver::class, ['config.php', 'lib/moodlelib.php', 'version.php'], true],
        [Drivers\MoodleDriver::class, ['config.php', 'public/lib/moodlelib.php', 'public/version.php'], true],
        [Drivers\MoodleDriver::class, ['lib/moodlelib.php', 'version.php'], false],
        [Drivers\Typo3Driver::class, ['vendor/typo3/cms-core/Classes/Core/Bootstrap.php'], true],
        [Drivers\Typo3Driver::class, ['vendor/bin/typo3'], false],
        [Drivers\CodeIgniter4Driver::class, ['app/Config/Paths.php', 'spark'], true],
        [Drivers\CodeIgniter4Driver::class, ['app/Config/Paths.php', 'public/index.php'], false],
        [Drivers\RadicleDriver::class, ['bedrock/application.php', 'public/wp/wp-load.php', 'public/wp/wp-includes/version.php'], true],
        [Drivers\RadicleDriver::class, ['config/application.php', 'vendor/roots/acorn/composer.json', 'web/wp/wp-load.php', 'web/wp/wp-includes/version.php'], true],
        [Drivers\RadicleDriver::class, ['bedrock/application.php'], false],
        [Drivers\BedrockDriver::class, ['config/application.php', 'web/wp/wp-load.php', 'web/wp/wp-includes/version.php'], true],
        [Drivers\BedrockDriver::class, ['web/wp/wp-load.php', 'web/wp/wp-includes/version.php'], false],
        [Drivers\ShopwareDriver::class, ['bin/console', 'vendor/shopware/core/composer.json'], true],
        [Drivers\ShopwareDriver::class, ['bin/console', 'vendor/shopware/platform/composer.json'], true],
        [Drivers\ShopwareDriver::class, ['vendor/shopware/core/composer.json'], false],
        [Drivers\Drupal7Driver::class, ['docroot/includes/bootstrap.inc', 'docroot/modules/system/system.module'], true],
        [Drivers\Drupal7Driver::class, ['misc/drupal.js'], false],
        [Drivers\DrupalDriver::class, ['docroot/core/lib/Drupal.php'], true],
        [Drivers\KirbyDriver::class, ['kirby/bootstrap.php', 'site/config/config.php'], true],
        [Drivers\SymfonyDriver::class, ['bin/console', 'src/Kernel.php', 'vendor/symfony/framework-bundle/composer.json'], true],
        [Drivers\SymfonyDriver::class, ['bin/console', 'public/index.php', 'symfony.lock'], false],
        [Drivers\ComposerDriver::class, ['vendor/autoload.php'], true],
    ];
    foreach ($cases as $index => $case) {
        list($class, $files, $expected) = $case;
        $path = $make('case' . $index, $files);
        t_same($expected, (new $class())->canBootstrap($path), $class . ' with ' . implode(', ', $files));
    }
    // A custom vendor-dir is honored.
    $custom = p3_write_tree($dir . '/vendor-dir', [
        'composer.json' => json_encode(['config' => ['vendor-dir' => 'lib']]),
        'artisan' => '',
        'bootstrap/app.php' => '<?php',
        'lib/statamic/cms/composer.json' => '{}',
        'lib/autoload.php' => '<?php',
    ]);
    t_same('statamic', p3_detect($custom)->id());
};

$tests['plain PHP, missing folders and the Plain driver'] = function () {
    t_same('none', p3_detect('')->id());
    t_same(Drivers\PlainDriver::class, get_class(p3_detect('')));
    t_same('none', p3_detect('/definitely/not/a/tinkerbox/project')->id());
    $plain = new Drivers\PlainDriver();
    t_same(false, $plain->canBootstrap(p3_fixture('plain')), 'the Plain driver is only the fallback');
    t_same([], $plain->files(''));
    t_same(['index.php'], $plain->files(p3_fixture('plain')));
    t_same('PHP', $plain->name());
    t_same(null, $plain->version());
    t_same(['PHP Environment'], array_column($plain->panels(''), 'title'));
};

$tests['every built-in driver extends Driver and has a unique id'] = function () {
    $warnings = count(DriverRegistry::warnings());
    $ids = [];
    foreach (DriverRegistry::BUILTINS as $class) {
        t_assert(strpos($class, 'Tinkerbox\\Drivers\\') === 0, "$class lives in Tinkerbox\\Drivers");
        $driver = new $class();
        t_assert($driver instanceof Drivers\Driver, "$class extends Driver");
        $id = $driver->id();
        t_assert($id !== '' && preg_match('/^[a-z0-9-]+$/', $id) === 1, "$class id: " . var_export($id, true));
        t_assert(!isset($ids[$id]), "duplicate id $id");
        $ids[$id] = $class;
        // Drivers that were not bootstrapped answer the DriverInfo questions without throwing.
        $info = DriverRegistry::info($driver, p3_fixture('plain'));
        t_same($id, $info['id']);
        t_assert(is_string($info['name']) && $info['name'] !== '', "$class name");
    }
    foreach (['laravel', 'lumen', 'laravel-zero', 'statamic', 'october', 'testbench', 'symfony', 'wordpress', 'bedrock', 'radicle', 'drupal7', 'drupal', 'craft', 'magento2', 'shopware', 'kirby', 'moodle', 'prestashop', 'typo3', 'composer', 'none', 'cakephp', 'codeigniter4', 'yii2', 'joomla'] as $id) {
        t_assert(isset($ids[$id]), "built-in id $id exists");
    }
    t_same(25, count($ids));
    $catalog = DriverRegistry::catalog();
    t_same(count(DriverRegistry::BUILTINS), count($catalog));
    t_same(['id' => 'laravel', 'name' => 'Laravel'], $catalog[array_search(Drivers\LaravelDriver::class, DriverRegistry::BUILTINS, true)]);
    t_same([], p3_new_warnings($warnings));
};

$tests['built-ins subclass the driver of the framework they are built on'] = function () {
    foreach ([Drivers\StatamicDriver::class, Drivers\OctoberDriver::class, Drivers\LaravelZeroDriver::class, Drivers\LumenDriver::class, Drivers\TestbenchDriver::class] as $class) {
        t_assert(is_subclass_of($class, Drivers\LaravelDriver::class), "$class extends LaravelDriver");
    }
    foreach ([Drivers\BedrockDriver::class, Drivers\RadicleDriver::class] as $class) {
        t_assert(is_subclass_of($class, Drivers\WordPressDriver::class), "$class extends WordPressDriver");
    }
    t_assert((new ReflectionClass(Drivers\Driver::class))->isAbstract());
    foreach (['id', 'name', 'canBootstrap', 'bootstrap'] as $method) {
        t_assert((new ReflectionMethod(Drivers\Driver::class, $method))->isAbstract(), "Driver::$method() is abstract");
    }
};

$tests['detection order: specific drivers before the generic ones they resemble'] = function () {
    $order = array_flip(DriverRegistry::BUILTINS);
    $before = [
        [Drivers\StatamicDriver::class, Drivers\LaravelDriver::class],
        [Drivers\OctoberDriver::class, Drivers\LaravelDriver::class],
        [Drivers\LumenDriver::class, Drivers\LaravelDriver::class],
        [Drivers\LaravelZeroDriver::class, Drivers\LaravelDriver::class],
        [Drivers\Drupal7Driver::class, Drivers\DrupalDriver::class],
        [Drivers\RadicleDriver::class, Drivers\BedrockDriver::class],
        [Drivers\BedrockDriver::class, Drivers\WordPressDriver::class],
        [Drivers\PrestaShopDriver::class, Drivers\SymfonyDriver::class],
        [Drivers\ShopwareDriver::class, Drivers\SymfonyDriver::class],
        [Drivers\CraftDriver::class, Drivers\Yii2Driver::class],
        [Drivers\TestbenchDriver::class, Drivers\ComposerDriver::class],
        [Drivers\ComposerDriver::class, Drivers\PlainDriver::class],
    ];
    foreach ($before as $pair) {
        t_assert($order[$pair[0]] < $order[$pair[1]], $pair[0] . ' must be tried before ' . $pair[1]);
    }
    $builtins = DriverRegistry::BUILTINS;
    t_same(Drivers\PlainDriver::class, end($builtins));
};

$tests['the runner sources contain no global driver classes'] = function () {
    $root = dirname(__DIR__, 3) . '/resources/php';
    $manifest = json_decode(file_get_contents($root . '/manifest.json'), true);
    foreach ($manifest['files'] as $file) {
        foreach (Drivers\Support::declaredClassesInFile($root . '/' . $file) as $class) {
            t_assert(strpos($class, 'Tinkerbox\\') === 0, "$file declares $class outside the Tinkerbox namespace");
        }
    }
};

return $tests;
