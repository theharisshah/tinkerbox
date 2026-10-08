<?php
/**
 * Custom drivers (docs/ARCHITECTURE.md §1.7): `<home>/.config/tinkerbox/drivers/*.php` (global, via the payload's
 * homePath) and `<project>/.tinkerbox/drivers/*.php`, precedence, drivers extending built-ins (incl. a Laravel driver
 * with its own panel), robustness against broken driver files, and forced driver ids incl. `laravel-booted`.
 */

require_once __DIR__ . '/support.php';

use Tinkerbox\DriverRegistry;
use Tinkerbox\Drivers;

if (!function_exists('p3_home_with')) {
    /** A temp home folder whose ~/.config/tinkerbox/drivers contains the given files. */
    function p3_home_with(array $files): string
    {
        $home = p3_tmpdir('home');
        $tree = [];
        foreach ($files as $name => $code) {
            $tree['.config/tinkerbox/drivers/' . $name] = $code;
        }

        return p3_write_tree($home, $tree);
    }

    /** A temp project with the given files (e.g. .tinkerbox/drivers/*.php). */
    function p3_project_with(array $files): string
    {
        return p3_write_tree(p3_tmpdir('project'), $files);
    }

    /** Source of a minimal driver class. */
    function p3_driver_source(string $class, string $id, string $canBootstrap, string $extends = '\\Tinkerbox\\Drivers\\Driver', string $extra = ''): string
    {
        return "<?php\nclass $class extends $extends\n{\n"
            . "    public function id(): string { return '$id'; }\n"
            . "    public function name(): string { return '$class'; }\n"
            . "    public function canBootstrap(string \$projectPath): bool { $canBootstrap }\n"
            . "    public function bootstrap(string \$projectPath): void {}\n"
            . $extra . "}\n";
    }
}

$tests = [];

$tests['a project driver extending LaravelDriver wins over the built-in Laravel driver'] = function () {
    $warnings = count(DriverRegistry::warnings());
    $driver = p3_detect(p3_fixture('acme-shop'));
    t_same('AcmeShopDriver', get_class($driver));
    t_same('acme-shop', $driver->id());
    t_same('Acme Shop', $driver->name());
    t_assert($driver instanceof Drivers\LaravelDriver, 'extends the built-in Laravel driver');
    // Abstract drivers are never instantiated; a driver in another file loaded its parent on demand.
    t_assert(class_exists('BillingDriver', false) && class_exists('ShopBaseDriver', false), 'cross-file parent loaded');
    $classes = array_map('get_class', DriverRegistry::customDrivers(p3_fixture('acme-shop'), p3_empty_home()));
    t_same(['AcmeShopDriver', 'BillingDriver'], $classes);
    t_same([p3_fixture('acme-shop') . '/.tinkerbox/drivers'], DriverRegistry::driverDirectories(p3_fixture('acme-shop'), p3_empty_home()));
    t_same([], p3_new_warnings($warnings));
};

$tests['the project driver adds its panels in front of the inherited ones (in-process, nothing booted)'] = function () {
    $driver = p3_detect(p3_fixture('acme-shop'));
    $panels = \Tinkerbox\Panels::forDriver($driver, p3_fixture('acme-shop'));
    t_same(['Acme Shop', 'Deploys', 'PHP Environment'], array_column($panels, 'title'), 'no Laravel running: the inherited panel is the PHP environment');
    t_same(['Open' => '3', 'Express' => 'true'], p3_panel_rows($panels[0], 'Orders'));
    t_same(['SKUs' => '1200', 'Warehouse' => ''], p3_panel_rows($panels[0], 'Inventory'));
    t_same(['Commit' => 'abc1234'], p3_panel_rows($panels[1], 'Last deploy'), 'Panel objects are converted too');
};

$tests['global drivers in ~/.config/tinkerbox/drivers are tried before project drivers'] = function () {
    $home = p3_home_with(['P3GlobalAcme.php' => p3_driver_source('P3GlobalAcmeDriver', 'p3-global-acme', "return file_exists(\$projectPath . '/acme-shop.json');")]);
    t_same('p3-global-acme', p3_detect(p3_fixture('acme-shop'), '', $home)->id());
    // Without that home folder the project driver is used again.
    t_same('acme-shop', p3_detect(p3_fixture('acme-shop'))->id());

    $wordpressHome = p3_home_with(['P3WordPressSites.php' => p3_driver_source('P3WordPressSitesDriver', 'p3-wp-sites', "return is_dir(\$projectPath . '/wp-content');", '\\Tinkerbox\\Drivers\\WordPressDriver')]);
    t_same('p3-wp-sites', p3_detect(p3_fixture('wordpress'), '', $wordpressHome)->id());
    t_same('bedrock', p3_detect(p3_fixture('bedrock'), '', $wordpressHome)->id(), 'global driver does not match → built-in');
    t_same([$wordpressHome . '/.config/tinkerbox/drivers'], DriverRegistry::driverDirectories('', $wordpressHome));
};

$tests['a global driver that does not match falls through to the project driver'] = function () {
    $home = p3_home_with(['P3Never.php' => p3_driver_source('P3NeverDriver', 'p3-never', 'return false;')]);
    t_same('acme-shop', p3_detect(p3_fixture('acme-shop'), '', $home)->id());
    t_same('laravel', p3_detect(p3_fixture('laravel'), '', $home)->id());
};

$tests['subclasses are tried before their parents, in any file order'] = function () {
    $project = p3_project_with([
        'marker.txt' => 'x',
        '.tinkerbox/drivers/A-child.php' => p3_driver_source('P3ChildDriver', 'p3-child', "return file_exists(\$projectPath . '/marker.txt');", 'P3ParentDriver'),
        '.tinkerbox/drivers/B-parent.php' => p3_driver_source('P3ParentDriver', 'p3-parent', 'return true;'),
    ]);
    t_same('p3-child', p3_detect($project)->id());
    unlink($project . '/marker.txt');
    t_same('p3-parent', p3_detect($project)->id());
};

$tests['a subclass of a built-in keeps the built-in id unless it declares its own'] = function () {
    $project = p3_project_with([
        'artisan' => '',
        'bootstrap/app.php' => '<?php',
        '.tinkerbox/drivers/Team.php' => <<<'PHP'
<?php
namespace Acme\Tinkerbox;

class TeamLaravelDriver extends \Tinkerbox\Drivers\LaravelDriver
{
    public function variables(): array
    {
        return parent::variables() + ['team' => 'acme'];
    }
}
PHP
    ]);
    $driver = p3_detect($project);
    t_same('Acme\Tinkerbox\TeamLaravelDriver', get_class($driver), 'namespaced driver classes work');
    t_same('laravel', $driver->id());
    t_same('Laravel', $driver->name());
    t_same(['team' => 'acme'], $driver->variables(), 'nothing booted: no $app yet');
    t_same('Acme\Tinkerbox\TeamLaravelDriver', get_class(p3_detect($project, 'laravel')), 'forcing "laravel" picks the project variant');
    t_same('Acme\Tinkerbox\TeamLaravelDriver', get_class(p3_detect($project, 'TeamLaravelDriver')), 'class names work too');
};

$tests['broken driver files are skipped with warnings, never fatal'] = function () {
    $project = p3_project_with([
        'artisan' => '',
        'bootstrap/app.php' => '<?php',
        '.tinkerbox/drivers/Throwing.php' => p3_driver_source('P3ThrowingDriver', 'p3-throwing', "throw new RuntimeException('cannot decide');"),
        '.tinkerbox/drivers/Syntax.php' => "<?php\nclass P3SyntaxDriver extends \\Tinkerbox\\Drivers\\Driver {\n  public function id(): string { return 'x' }\n}\n",
        '.tinkerbox/drivers/Redeclare.php' => "<?php\nnamespace Tinkerbox\\Drivers;\nclass LaravelDriver {}\n",
        '.tinkerbox/drivers/Args.php' => p3_driver_source('P3ArgsDriver', 'p3-args', 'return true;', '\\Tinkerbox\\Drivers\\Driver', "    public function __construct(\$required) {}\n"),
        '.tinkerbox/drivers/NotADriver.php' => "<?php\nclass P3NotADriver { public function canBootstrap(\$p) { return true; } }\n",
        '.tinkerbox/drivers/helpers.php' => "<?php\nthrow new RuntimeException('helper file failed');\n",
        '.tinkerbox/drivers/readme.md' => 'not PHP',
        '.tinkerbox/drivers/nested/P3Nested.php' => "<?php\nthrow new RuntimeException('subfolders are not scanned');\n",
    ]);
    $before = count(DriverRegistry::warnings());
    $driver = p3_detect($project);
    t_same('laravel', $driver->id(), 'falls back to the built-in driver');
    $warnings = implode("\n", p3_new_warnings($before));
    t_contains('P3ThrowingDriver::canBootstrap() failed: cannot decide', $warnings);
    t_contains('Syntax.php failed to load: ParseError', $warnings);
    t_contains('Redeclare.php was skipped: class Tinkerbox\Drivers\LaravelDriver is already declared', $warnings);
    t_contains('P3ArgsDriver was skipped: its constructor requires arguments', $warnings);
    t_contains('helpers.php failed to load: RuntimeException: helper file failed', $warnings);
    t_assert(strpos($warnings, 'subfolders are not scanned') === false, $warnings);
    t_assert(strpos($warnings, 'P3NotADriver') === false, 'classes that are not drivers are ignored silently');
};

$tests['DriverRegistry::info() guards custom drivers and resolves project-relative log folders'] = function () {
    $project = p3_project_with(['p3-logs/app.log' => 'x']);
    $driver = new class extends Drivers\Driver {
        public $logs = 'p3-logs';

        public function id(): string
        {
            return 'p3-info';
        }

        public function name(): string
        {
            throw new RuntimeException('no name');
        }

        public function canBootstrap(string $projectPath): bool
        {
            return false;
        }

        public function bootstrap(string $projectPath): void
        {
        }

        public function version(): ?string
        {
            return '';
        }

        public function logsPath(string $projectPath): ?string
        {
            return $this->logs;
        }

        public function prettyErrors(): ?bool
        {
            return true;
        }
    };
    $before = count(DriverRegistry::warnings());
    $info = DriverRegistry::info($driver, $project);
    t_same('p3-info', $info['id']);
    t_same(get_class($driver), $info['name'], 'falls back to the class name');
    t_same(null, $info['appVersion'], 'an empty version is no version');
    t_same(true, $info['usesCollision']);
    t_same($project . DIRECTORY_SEPARATOR . 'p3-logs', $info['logFilesPath']);
    t_contains('::name() failed: no name', implode("\n", p3_new_warnings($before)));
    $driver->logs = '/p3-logs';
    t_same($project . DIRECTORY_SEPARATOR . 'p3-logs', DriverRegistry::info($driver, $project)['logFilesPath'], 'a leading slash still means the project folder when that exists');
    $driver->logs = $project . '/p3-logs';
    t_same($project . '/p3-logs', DriverRegistry::info($driver, $project)['logFilesPath']);
    $driver->logs = '/p3-missing/logs';
    t_same('/p3-missing/logs', DriverRegistry::info($driver, $project)['logFilesPath'], 'other absolute paths are kept');
    // Relative paths belong to the project, never to the current directory (the runner chdir()s into projects).
    $driver->logs = 'p3-logs';
    $other = p3_tmpdir('other');
    $previous = getcwd();
    chdir($project);
    try {
        t_same($other . DIRECTORY_SEPARATOR . 'p3-logs', DriverRegistry::info($driver, $other)['logFilesPath']);
    } finally {
        chdir($previous);
    }
};

$tests['forced driver ids'] = function () {
    $forcedSymfony = p3_detect(p3_fixture('laravel'), 'symfony');
    t_same(Drivers\SymfonyDriver::class, get_class($forcedSymfony), 'forced even when canBootstrap() is false');
    t_same('acme-shop', p3_detect(p3_fixture('acme-shop'), 'acme-shop')->id());
    t_same('AcmeShopDriver', get_class(p3_detect(p3_fixture('acme-shop'), 'acmeshopdriver')), 'class names work case-insensitively');
    t_same('billing', p3_detect(p3_fixture('acme-shop'), 'billing')->id(), 'a custom driver can be forced although it does not match');
    t_same('none', p3_detect(p3_fixture('laravel'), 'none')->id());
    t_same('wordpress', p3_detect('', 'wordpress')->id(), 'forcing works without a project folder');

    $unknown = p3_detect(p3_fixture('symfony'), 'p3-no-such-driver');
    t_same('symfony', $unknown->id(), 'unknown ids fall back to detection');
    t_contains('Forced driver "p3-no-such-driver" is not available', implode("\n", DriverRegistry::warnings()));
    t_same('none', p3_detect('', 'p3-no-such-driver')->id());

    $booted = p3_detect(p3_fixture('laravel'), 'laravel-booted');
    t_same(Drivers\LaravelDriver::class, get_class($booted));
    t_same('laravel', $booted->id());
    t_same(true, p3_get($booted, 'reuseRunningApp'));
    t_same(true, p3_get(p3_detect('', 'laravel-booted'), 'reuseRunningApp'), 'laravel-booted needs no project folder');
    t_same(false, p3_get(p3_detect(p3_fixture('laravel')), 'reuseRunningApp'));
};

$tests['laravel-booted reuses the running application (Vapor / Laravel Cloud)'] = function () {
    $result = p3_php_script(<<<'PHP'
namespace Illuminate\Container {
    class Container {
        protected static $instance;
        public $bindings = ['config' => true];
        public static function setInstance($app) { static::$instance = $app; }
        public function version() { return '11.9.0'; }
        public function make($id) { if ($id === 'events') { throw new \RuntimeException('no events'); } return $this; }
        public function basePath() { return '/srv/app'; }
        public function storagePath() { return '/srv/app/storage'; }
    }
}
namespace {
    $GLOBALS['__result'] = (function () {
        $app = new \Illuminate\Container\Container();
        \Illuminate\Container\Container::setInstance($app);
        $driver = \Tinkerbox\DriverRegistry::detect('', 'laravel-booted', sys_get_temp_dir() . '/p3-no-home');
        $driver->bootstrap('');
        $vars = $driver->variables();
        $driver->listenForQueries(function () {});

        return [
            'sameApp' => isset($vars['app']) && $vars['app'] === $app,
            'version' => $driver->version(),
            'logs' => $driver->logsPath(''),
            'info' => \Tinkerbox\DriverRegistry::info($driver, ''),
        ];
    })();
}
PHP
        , null, null, true);
    t_same(true, $result['sameApp']);
    t_same('Laravel 11.9.0', $result['version']);
    t_same('/srv/app/storage' . DIRECTORY_SEPARATOR . 'logs', $result['logs']);
    t_same('laravel', $result['info']['id']);
    t_same('Laravel 11.9.0', $result['info']['appVersion']);
};

$tests['global drivers are honoured end-to-end through the payload homePath'] = function () {
    $home = p3_home_with(['P3E2eGlobal.php' => <<<'PHP'
<?php
class P3E2eGlobalDriver extends \Tinkerbox\Drivers\Driver
{
    private $booted = '';
    public function id(): string { return 'p3-e2e-global'; }
    public function name(): string { return 'Global'; }
    public function canBootstrap(string $projectPath): bool { return true; }
    public function bootstrap(string $projectPath): void { $this->booted = $projectPath; }
    public function variables(): array { return ['global' => basename($this->booted)]; }
    public function version(): ?string { return 'Global 1.0'; }
}
PHP
    ]);
    $envelope = p3_bundle(['projectPath' => p3_fixture('acme-shop'), 'homePath' => $home, 'code' => '$global']);
    t_same('p3-e2e-global', $envelope['driver']['id']);
    t_same('Global 1.0', $envelope['driver']['appVersion']);
    t_same('acme-shop', p3_value($envelope['returnValue']));
};

$tests['Support::declaredFunctionsInCode() lists unconditional function declarations only'] = function () {
    $code = "<?php\nnamespace Acme\\Tools;\nfunction helper() {}\nfunction &byRef() {}\nif (!function_exists('guarded')) { function guarded() {} }\n"
        . "class Box { public function method() {} }\n\$c = function () {};\n\$s = static function () {};\nuse function strlen;\n";
    t_same(['Acme\Tools\helper', 'Acme\Tools\byRef'], Drivers\Support::declaredFunctionsInCode($code));
    t_same(['First\a', 'b'], Drivers\Support::declaredFunctionsInCode("<?php\nnamespace First { function a() {} }\nnamespace { function b() { function inner() {} } }\n"));
};

$tests['two driver files declaring the same function or class: the later file is skipped with a warning, never fatal'] = function () {
    $helper = "function p3_shared_template_helper() { return 'shared'; }\n";
    $project = p3_project_with([
        '.tinkerbox/drivers/A.php' => p3_driver_source('P3TemplateDriverA', 'p3-template-a', 'return true;') . $helper,
        '.tinkerbox/drivers/B.php' => p3_driver_source('P3TemplateDriverB', 'p3-template-b', 'return true;') . $helper,
        '.tinkerbox/drivers/C.php' => p3_driver_source('P3TemplateDriverA', 'p3-template-c', 'return true;'),
    ]);
    $envelope = p3_bundle(['projectPath' => $project, 'code' => 'p3_shared_template_helper()']);
    t_same(null, $envelope['exception']);
    t_same('p3-template-a', $envelope['driver']['id']);
    t_same('shared', p3_value($envelope['returnValue']));
    $messages = implode("\n", array_column($envelope['diagnostics'], 'message'));
    t_contains('B.php was skipped: function p3_shared_template_helper() is already declared', $messages);
    t_contains('C.php was skipped: class P3TemplateDriverA is already declared', $messages);
    foreach (['detect', 'panels'] as $mode) {
        $data = p3_bundle(['projectPath' => $project, 'mode' => $mode]);
        t_assert(!isset($data['error']), $mode . ': ' . (isset($data['error']) ? $data['error'] : ''));
        t_same('p3-template-a', $data['driver']['id'], $mode);
    }
    // A global driver file and a project driver file copied from the same template.
    $home = p3_home_with(['Global.php' => p3_driver_source('P3TemplateGlobal', 'p3-template-global', 'return false;') . $helper]);
    $envelope = p3_bundle(['projectPath' => $project, 'homePath' => $home, 'code' => '1']);
    t_same(null, $envelope['exception']);
    t_contains('A.php was skipped: function p3_shared_template_helper() is already declared', implode("\n", array_column($envelope['diagnostics'], 'message')));
};

return $tests;
