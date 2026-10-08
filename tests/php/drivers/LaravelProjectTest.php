<?php
/**
 * The built-in Laravel driver against a real, read-only Laravel project (TINKERBOX_TEST_LARAVEL): boot
 * like `artisan tinker`, `$app`, Tinker-style aliases, QueryExecuted capture, models, DriverInfo, laravel-booted and
 * a custom driver extending LaravelDriver.
 *
 * Safety: the child process gets an environment that points the database at in-memory SQLite and cache / session /
 * queue / mail / logging at in-memory or stderr drivers (real environment variables win over .env), and the
 * project's storage / bootstrap/cache / database folders are snapshotted before and compared after every run.
 */

require_once __DIR__ . '/support.php';
require_once dirname(__DIR__) . '/data/support/helpers.php';

if (!function_exists('p3_laravel_project')) {
    function p3_laravel_project(): ?string
    {
        $project = t_laravel_project();
        if (!is_file($project . '/vendor/autoload.php') || !is_file($project . '/artisan')) {
            p3_skip('no Laravel project with vendor/ at ' . $project);

            return null;
        }
        if (p4_php(80200) === null) {
            p3_skip('no PHP >= 8.2 for Laravel 12');

            return null;
        }

        return $project;
    }

    /** Run the bundle against the Laravel project with the safe environment; the project must stay untouched. */
    function p3_laravel_bundle(array $payload, ?string $php = null): array
    {
        $project = p3_laravel_project();
        $before = p4_snapshot(p4_project_dirs($project));
        $payload += ['projectPath' => $project];
        $envelope = p4_with_safe_laravel_env(function () use ($payload, $php) {
            return p3_bundle($payload, $php ?: p4_php(80200));
        });
        t_same($before, p4_snapshot(p4_project_dirs($project)), 'the Laravel project must not be written to');

        return $envelope;
    }
}

$tests = [];

$tests['Laravel: boots like artisan tinker with $app, aliases and query capture'] = function () {
    $project = p3_laravel_project();
    if ($project === null) {
        return;
    }
    $envelope = p3_laravel_bundle(['code' => implode("\n", [
        "\$rows = DB::select('select 1 as one, ? as two', [2]);",
        "[\$app->version() === app()->version(), config('database.default'), DB::table('users')->where('id', 1)->toSql(), get_class(new User()), \$rows[0]->two, base_path() === \$app->basePath()]",
    ])]);
    t_same(null, $envelope['exception'], json_encode($envelope['exception']) . "\n" . $envelope['__stderr']);
    t_same([], $envelope['diagnostics']);
    t_same('laravel', $envelope['driver']['id']);
    t_assert(preg_match('/^Laravel \d+\.\d+\.\d+$/', $envelope['driver']['appVersion']) === 1, $envelope['driver']['appVersion']);
    t_same($project . DIRECTORY_SEPARATOR . 'storage' . DIRECTORY_SEPARATOR . 'logs', $envelope['driver']['logFilesPath']);
    t_same([true, 'sqlite', 'select * from "users" where "id" = ?', 'App\Models\User', 2, true], p3_value($envelope['returnValue']));
    $queries = array_values(array_filter($envelope['events'], function ($event) {
        return $event['kind'] === 'query';
    }));
    t_same(1, count($queries), json_encode($envelope['events']));
    t_same('select 1 as one, ? as two', $queries[0]['sql']);
    t_same('select 1 as one, 2 as two', $queries[0]['rawSql']);
    t_same('sqlite', $queries[0]['connection']);
    t_same(1, $queries[0]['line']);
};

$tests['Laravel: detect, logs and environment models'] = function () {
    $project = p3_laravel_project();
    if ($project === null) {
        return;
    }
    $detect = p3_laravel_bundle(['mode' => 'detect']);
    t_same('laravel', $detect['data']['driver']['id']);
    t_same('Laravel', $detect['data']['driver']['name']);
    t_contains('PHP ', $detect['data']['phpVersionLine']);

    $logs = p3_laravel_bundle(['mode' => 'logs']);
    t_same($project . DIRECTORY_SEPARATOR . 'storage' . DIRECTORY_SEPARATOR . 'logs', $logs['data']['root']);

    $environment = p3_laravel_bundle(['mode' => 'environment']);
    $models = array_column($environment['data']['models'], null, 'class');
    t_assert(isset($models['App\Models\User']), 'App\Models\User is listed');
    t_same('users', $models['App\Models\User']['table']);
    t_same([], $models['App\Models\User']['columns'], 'no users table in the in-memory database: no columns, no error');
    t_assert(is_array($models['App\Models\User']['relations']));
};

$tests['Laravel: laravel-booted falls back to booting the project when nothing is running'] = function () {
    if (p3_laravel_project() === null) {
        return;
    }
    $envelope = p3_laravel_bundle(['driver' => 'laravel-booted', 'code' => 'config("database.default")']);
    t_same(null, $envelope['exception'], json_encode($envelope['exception']));
    t_same('laravel', $envelope['driver']['id']);
    t_same('sqlite', p3_value($envelope['returnValue']));
};

$tests['Laravel: a global driver extending LaravelDriver keeps the Laravel behaviour and adds a panel'] = function () {
    $project = p3_laravel_project();
    if ($project === null) {
        return;
    }
    $home = p3_write_tree(p3_tmpdir('home'), ['.config/tinkerbox/drivers/DemoApp.php' => <<<'PHP'
<?php
use Tinkerbox\Drivers\LaravelDriver;
use Tinkerbox\Panels\Panel;

class P3DemoAppDriver extends LaravelDriver
{
    public function id(): string
    {
        return 'p3-demo-app';
    }

    public function name(): string
    {
        return 'Demo App';
    }

    public function canBootstrap(string $projectPath): bool
    {
        return parent::canBootstrap($projectPath) && realpath($projectPath) === realpath((string) getenv('TINKERBOX_TEST_LARAVEL'));
    }

    public function variables(): array
    {
        return parent::variables() + ['users' => \App\Models\User::query()];
    }

    public function panels(string $projectPath): array
    {
        $models = Panel::make('Portfolio')->section('Models', ['User' => \App\Models\User::class, 'Booted' => $this->application() !== null]);

        return array_merge(parent::panels($projectPath), [$models->toArray()]);
    }
}
PHP
    ]);
    $envelope = p3_laravel_bundle(['homePath' => $home, 'code' => '[get_class($app), $users->toSql(), config("database.default")]']);
    t_same(null, $envelope['exception'], json_encode($envelope['exception']));
    t_same('p3-demo-app', $envelope['driver']['id']);
    t_same('Demo App', $envelope['driver']['name']);
    t_assert(strpos($envelope['driver']['appVersion'], 'Laravel ') === 0, 'inherits version()');
    t_same($project . DIRECTORY_SEPARATOR . 'storage' . DIRECTORY_SEPARATOR . 'logs', $envelope['driver']['logFilesPath'], 'inherits logsPath()');
    t_same('select * from "users"', p3_value($envelope['returnValue'])[1]);
    t_same('sqlite', p3_value($envelope['returnValue'])[2]);

    $panels = p3_laravel_bundle(['homePath' => $home, 'mode' => 'panels']);
    t_same(['App Information', 'Portfolio'], array_column($panels['data'], 'title'));
    t_same(['User' => 'App\Models\User', 'Booted' => 'true'], p3_panel_rows($panels['data'][1], 'Models'));
    t_same('Environment', $panels['data'][0]['sections'][0]['title'], 'the inherited Laravel panel comes from artisan about');
};

return $tests;
