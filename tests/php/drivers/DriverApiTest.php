<?php
/**
 * The driver API (docs/ARCHITECTURE.md §1.7): the defaults of \Tinkerbox\Drivers\Driver, files(), the panel builder
 * \Tinkerbox\Panels\Panel and the standard panels (\Tinkerbox\Panels\StandardPanels) without a framework.
 */

require_once __DIR__ . '/support.php';

use Tinkerbox\Drivers\Driver;
use Tinkerbox\Panels\Panel;
use Tinkerbox\Panels\StandardPanels;

if (!class_exists('P3MinimalDriver', false)) {
    /** A driver implementing only the abstract methods. */
    class P3MinimalDriver extends Driver
    {
        public function id(): string
        {
            return 'p3-minimal';
        }

        public function name(): string
        {
            return 'Minimal';
        }

        public function canBootstrap(string $projectPath): bool
        {
            return true;
        }

        public function bootstrap(string $projectPath): void
        {
        }
    }

    /** A driver that skips a folder of its own in files(). */
    class P3IgnoringDriver extends P3MinimalDriver
    {
        protected function ignoredFolders(): array
        {
            return ['cache', 'src/Generated'];
        }
    }
}

$tests = [];

$tests['Driver defaults'] = function () {
    $driver = new P3MinimalDriver();
    t_same('p3-minimal', $driver->id());
    t_same('Minimal', $driver->name());
    t_same(null, $driver->version());
    t_same([], $driver->variables());
    t_same(null, $driver->logsPath('/srv/app'));
    t_same(null, $driver->prettyErrors());
    t_same([], $driver->models());
    $driver->listenForQueries(function () {
        throw new RuntimeException('never called by the default implementation');
    });
    $driver->afterRun();
    $panels = $driver->panels('');
    t_same(['PHP Environment'], array_column($panels, 'title'), 'the default panel is the PHP environment');
    t_same(['PHP'], array_column($panels[0]['sections'], 'title'), 'no project section without a project');
    t_same(PHP_VERSION, p3_panel_rows($panels[0], 'PHP')['Version']);

    $info = \Tinkerbox\DriverRegistry::info($driver, '');
    t_same(['id' => 'p3-minimal', 'name' => 'Minimal', 'appVersion' => null, 'usesCollision' => null, 'logFilesPath' => null], $info);
};

$tests['the public API has the documented signatures'] = function () {
    $expected = [
        'id' => ['', 'string'],
        'name' => ['', 'string'],
        'canBootstrap' => ['string $projectPath', 'bool'],
        'bootstrap' => ['string $projectPath', 'void'],
        'version' => ['', '?string'],
        'variables' => ['', 'array'],
        'listenForQueries' => ['callable $listener', 'void'],
        'afterRun' => ['', 'void'],
        'panels' => ['string $projectPath', 'array'],
        'logsPath' => ['string $projectPath', '?string'],
        'prettyErrors' => ['', '?bool'],
        'files' => ['string $projectPath', 'array'],
        'models' => ['', 'array'],
    ];
    // PHP 7.4 casts nullable types without the "?": spell them out the same way on every version.
    $type = function ($type) {
        return $type instanceof ReflectionNamedType ? ($type->allowsNull() ? '?' : '') . $type->getName() : (string) $type;
    };
    $public = [];
    foreach ((new ReflectionClass(Driver::class))->getMethods(ReflectionMethod::IS_PUBLIC) as $method) {
        $params = [];
        foreach ($method->getParameters() as $parameter) {
            $params[] = $type($parameter->getType()) . ' $' . $parameter->getName();
        }
        $public[$method->getName()] = [implode(', ', $params), $type($method->getReturnType())];
    }
    ksort($expected);
    ksort($public);
    t_same($expected, $public);
};

$tests['files() lists the project PHP files minus vendor, hidden and ignored folders'] = function () {
    $root = p3_write_tree(p3_tmpdir('files'), [
        'index.php' => '<?php',
        'src/Models/User.php' => '<?php',
        'src/Generated/Proxy.php' => '<?php',
        'src/readme.md' => 'x',
        'vendor/acme/lib/Lib.php' => '<?php',
        'node_modules/x/y.php' => '<?php',
        'cache/compiled.php' => '<?php',
        '.git/hooks/pre-commit.php' => '<?php',
    ]);
    $files = (new P3MinimalDriver())->files($root);
    sort($files);
    t_same(['cache/compiled.php', 'index.php', 'src/Generated/Proxy.php', 'src/Models/User.php'], $files);
    $files = (new P3IgnoringDriver())->files($root);
    sort($files);
    t_same(['index.php', 'src/Models/User.php'], $files);
    t_same([], (new P3MinimalDriver())->files('/definitely/missing'));

    $laravel = p3_write_tree(p3_tmpdir('laravel-files'), [
        'app/Models/User.php' => '<?php',
        'public/index.php' => '<?php',
        'storage/framework/views/abc.php' => '<?php',
        'bootstrap/cache/packages.php' => '<?php',
        'bootstrap/app.php' => '<?php',
    ]);
    $files = (new \Tinkerbox\Drivers\LaravelDriver())->files($laravel);
    sort($files);
    t_same(['app/Models/User.php', 'bootstrap/app.php'], $files);

    $wordpress = p3_write_tree(p3_tmpdir('wp-files'), [
        'wp-config.php' => '<?php',
        'wp-includes/version.php' => '<?php',
        'wp-content/plugins/acme/acme.php' => '<?php',
        'wp-content/uploads/2024/evil.php' => '<?php',
        'web/wp/wp-admin/admin.php' => '<?php',
    ]);
    $files = (new \Tinkerbox\Drivers\WordPressDriver())->files($wordpress);
    sort($files);
    t_same(['wp-config.php', 'wp-content/plugins/acme/acme.php'], $files);
};

$tests['a driver may declare narrower parameter types and keep the documented return types'] = function () {
    $project = p3_write_tree(p3_tmpdir('typed'), [
        'shop.marker' => '',
        '.tinkerbox/drivers/P3LooseDriver.php' => <<<'PHP'
<?php
class P3LooseDriver extends \Tinkerbox\Drivers\Driver
{
    public function id(): string { return 'p3-loose'; }
    public function name(): string { return 'Loose'; }
    // Parameter types may be widened (no type at all).
    public function canBootstrap($projectPath): bool { return file_exists($projectPath . '/shop.marker') ? 1 : 0; }
    public function bootstrap($projectPath): void {}
    public function variables(): array { return ['loose' => true]; }
}
PHP
    ]);
    $driver = p3_detect($project);
    t_same('p3-loose', $driver->id());
    t_same(['loose' => true], $driver->variables());
    t_same(true, $driver->canBootstrap($project), 'non-strict return values are converted to bool');
};

$tests['Panel builder: AppPanel arrays with display values'] = function () {
    $panel = Panel::make('  Shop ');
    t_assert($panel instanceof Panel);
    t_same($panel, $panel->section('Orders', ['Open' => 2, 'Express' => true, 'Cancelled' => null, 'Rate' => 1.5]));
    $panel->section('Stock', ['SKUs' => 1200, 'Tags' => ['a', 'b'], 'Since' => new DateTimeImmutable('2024-01-02 03:04:05', new DateTimeZone('UTC')), 7 => 'numeric key']);
    $panel->section('Orders', ['Open' => 3]);
    t_same([
        'title' => 'Shop',
        'sections' => [
            ['title' => 'Orders', 'rows' => [
                ['key' => 'Open', 'value' => '2'],
                ['key' => 'Express', 'value' => 'true'],
                ['key' => 'Cancelled', 'value' => ''],
                ['key' => 'Rate', 'value' => '1.5'],
            ]],
            ['title' => 'Stock', 'rows' => [
                ['key' => 'SKUs', 'value' => '1200'],
                ['key' => 'Tags', 'value' => 'a, b'],
                ['key' => 'Since', 'value' => '2024-01-02 03:04:05 UTC'],
                ['key' => '7', 'value' => 'numeric key'],
            ]],
            ['title' => 'Orders', 'rows' => [['key' => 'Open', 'value' => '3']]],
        ],
    ], $panel->toArray());
    t_same(['title' => 'Empty', 'sections' => []], Panel::make('Empty')->toArray());
    t_same(
        ['title' => 'Many', 'sections' => [['title' => 'A', 'rows' => [['key' => 'k', 'value' => 'v']]]]],
        Panel::make('Many')->sections(['A' => ['k' => 'v'], 'Skipped' => []])->toArray(),
        'sections() leaves out empty sections'
    );
    // The builder output is exactly what the panels data mode emits.
    t_same([Panel::make('Shop')->section('S', ['k' => true])->toArray()], \Tinkerbox\Panels::normalizeAll([Panel::make('Shop')->section('S', ['k' => true])]));
};

$tests['StandardPanels without a framework'] = function () {
    $php = StandardPanels::php(p3_fixture('composer'));
    t_same('PHP Environment', $php['title']);
    $rows = p3_panel_rows($php, 'PHP');
    t_same(PHP_VERSION, $rows['Version']);
    t_same(PHP_SAPI, $rows['SAPI']);
    t_same((string) count(get_loaded_extensions()), $rows['Extensions']);
    t_same(['Path' => p3_fixture('composer'), 'Composer Package' => 'acme/greeter'], p3_panel_rows($php, 'Project'));
    t_same(['Version', 'SAPI', 'Binary', 'Configuration File', 'Extensions', 'Memory Limit', 'OPcache'], array_slice(array_keys(StandardPanels::phpRows()), 0, 7));
    t_same(['a' => 1, 'c' => false], StandardPanels::present(['a' => 1, 'b' => null, 'c' => false]));

    // No Laravel running (checked in a clean process: the harness may have Laravel classes loaded).
    t_same(null, p3_php_script('return \\Tinkerbox\\Panels\\StandardPanels::laravel();'));

    // WordPress functions are missing: the site section only keeps what can be read, flags default to false.
    $result = p3_php_script('return \\Tinkerbox\\Panels\\StandardPanels::wordpress();');
    t_same('Site Information', $result['title']);
    t_same(['Configuration'], array_column($result['sections'], 'title'));
    t_same(['WP_DEBUG' => 'false', 'WP_DEBUG_LOG' => 'false', 'SAVEQUERIES' => 'false', 'WP_CACHE' => 'false'], p3_panel_rows($result, 'Configuration'));
};

return $tests;
