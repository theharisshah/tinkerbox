<?php
/**
 * Test support: bootstraps a real Laravel project in-process with the real built-in LaravelDriver (read-only,
 * side-effect-free configuration), registers the class aliases like the runner does, and times one P4 data-mode call.
 *
 *   php -d xdebug.mode=off laravel_probe.php <projectPath> <action> [arg]
 *
 * action: environment | members <class> | panels | scoped-members
 * Output: "\n@@PROBE_BEGIN\n{json}\n@@PROBE_END\n" with "elapsedMs" (the data-mode call only) and "data".
 *
 * Safety: the database is redirected to an in-memory SQLite connection, cache / session / queue to in-memory
 * drivers and logging to stderr *before* the framework reads its .env (real environment variables win over .env),
 * and the database config is forced to in-memory SQLite again after booting, so nothing in the project (database,
 * storage/logs, cache files) is touched.
 */

error_reporting(E_ALL);
ini_set('display_errors', 'stderr');

$projectPath = isset($argv[1]) ? $argv[1] : '';
$action = isset($argv[2]) ? $argv[2] : 'environment';
$arg = isset($argv[3]) ? $argv[3] : '';

$overrides = [
    'APP_ENV' => 'local',
    'DB_CONNECTION' => 'sqlite',
    'DB_DATABASE' => ':memory:',
    'DB_URL' => '',
    'DATABASE_URL' => '',
    'LOG_CHANNEL' => 'stderr',
    'LOG_STACK' => 'stderr',
    'CACHE_STORE' => 'array',
    'CACHE_DRIVER' => 'array',
    'SESSION_DRIVER' => 'array',
    'QUEUE_CONNECTION' => 'sync',
    'BROADCAST_CONNECTION' => 'log',
    'BROADCAST_DRIVER' => 'log',
    'MAIL_MAILER' => 'array',
    'TELESCOPE_ENABLED' => 'false',
    'DEBUGBAR_ENABLED' => 'false',
];
foreach ($overrides as $key => $value) {
    putenv($key . '=' . $value);
    $_ENV[$key] = $value;
    $_SERVER[$key] = $value;
}

// Runner sources in manifest order (namespace blocks only: declaring them has no side effects).
$root = dirname(__DIR__, 4) . '/resources/php';
$manifest = json_decode(file_get_contents($root . '/manifest.json'), true);
foreach ($manifest['files'] as $file) {
    require_once $root . '/' . $file;
}

chdir($projectPath);
$driver = \Tinkerbox\DriverRegistry::detect($projectPath, 'laravel', sys_get_temp_dir() . '/tinkerbox-probe-no-home');
$driver->bootstrap($projectPath);
$app = \Tinkerbox\Drivers\Laravel::runningApp();
// Belt and braces: whatever the project's config says, never reach a real database.
$app['config']->set('database.default', 'sqlite');
$app['config']->set('database.connections.sqlite.database', ':memory:');
\Tinkerbox\ClassAliasLoader::register($projectPath);

if ($action === 'scoped-members') {
    // A model with both scope styles (scopeX() and Laravel 12's #[Scope]), declared at runtime (never written).
    $attribute = class_exists('Illuminate\Database\Eloquent\Attributes\Scope') ? "#[\\Illuminate\\Database\\Eloquent\\Attributes\\Scope]\n" : '';
    eval('namespace App\Models; class P4ScopedPost extends \Illuminate\Database\Eloquent\Model {
        protected $table = "p4_posts";
        protected $fillable = ["title", "published_at"];
        protected $casts = ["published_at" => "datetime", "meta" => "array"];
        /** Only published posts. */
        public function scopePublished($query, $flag = true) { return $query; }
        ' . $attribute . 'protected function popular(\Illuminate\Database\Eloquent\Builder $query, int $minViews = 100) { return $query; }
        public function getTitleUpperAttribute() { return strtoupper((string) $this->title); }
        public function author(): \Illuminate\Database\Eloquent\Relations\BelongsTo { return $this->belongsTo(P4ScopedPost::class); }
    }');
    $action = 'members';
    $arg = 'P4ScopedPost';
}

$start = microtime(true);
switch ($action) {
    case 'environment':
        $data = \Tinkerbox\Introspector::environment($driver, $projectPath);
        break;
    case 'members':
        $data = \Tinkerbox\Introspector::members($arg, $driver, $projectPath);
        break;
    case 'panels':
        $data = \Tinkerbox\Panels::forDriver($driver, $projectPath);
        break;
    default:
        fwrite(STDERR, "Unknown action $action\n");
        exit(2);
}
$elapsed = (microtime(true) - $start) * 1000;

echo "\n@@PROBE_BEGIN\n" . json_encode(['elapsedMs' => $elapsed, 'data' => $data], JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE) . "\n@@PROBE_END\n";
