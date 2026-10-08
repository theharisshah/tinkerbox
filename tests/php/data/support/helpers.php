<?php
/**
 * Shared helpers for the P4 data-mode tests (tests/php/data/*Test.php). Everything is prefixed with `p4_`
 * because all modules' test files run in one harness process.
 */

const P4_LEVELS = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'];

function p4_fixtures(string $path = ''): string
{
    return dirname(__DIR__) . '/fixtures' . ($path !== '' ? '/' . ltrim($path, '/') : '');
}

/** Unique temporary directory, removed when the harness exits. */
function p4_tmpdir(string $prefix = 'p4'): string
{
    static $dirs = null;
    if ($dirs === null) {
        $dirs = [];
        register_shutdown_function(function () use (&$dirs) {
            foreach ($dirs as $dir) {
                p4_rmrf($dir);
            }
        });
    }
    $base = realpath(sys_get_temp_dir());
    $dir = $base . '/tinkerbox-' . $prefix . '-' . bin2hex(random_bytes(5));
    mkdir($dir, 0777, true);
    $dirs[] = $dir;

    return $dir;
}

function p4_rmrf(string $path): void
{
    if (is_link($path) || is_file($path)) {
        unlink($path);
        return;
    }
    if (!is_dir($path)) {
        return;
    }
    foreach (scandir($path) as $name) {
        if ($name !== '.' && $name !== '..') {
            p4_rmrf($path . '/' . $name);
        }
    }
    rmdir($path);
}

/**
 * Copy tests/php/data/fixtures/logs/** into a fresh temp log root, dropping the `.fixture` suffix (the repo's
 * .gitignore ignores *.log, so fixtures are stored as *.log.fixture). Deterministic modification times:
 * files get 2024-05-01 00:00 + their index in $order minutes when listed, otherwise 2024-01-01.
 */
function p4_log_root(array $mtimes = []): string
{
    $root = p4_tmpdir('logs');
    $source = p4_fixtures('logs');
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($source, FilesystemIterator::SKIP_DOTS));
    foreach ($it as $file) {
        $relative = substr($file->getPathname(), strlen($source) + 1);
        $target = $root . '/' . preg_replace('/\.fixture$/', '', $relative);
        if (!is_dir(dirname($target))) {
            mkdir(dirname($target), 0777, true);
        }
        copy($file->getPathname(), $target);
        $name = substr($target, strlen($root) + 1);
        touch($target, isset($mtimes[$name]) ? $mtimes[$name] : mktime(0, 0, 0, 1, 1, 2024));
    }

    return $root;
}

/** Skip notice (the harness has no skip state; the test passes and says why on stderr). */
function p4_skip(string $why): void
{
    fwrite(STDERR, "    \033[33m↷ skipped: " . $why . "\033[0m\n");
}

/** A PHP binary able to run the given minimum version (current, else a Herd binary), or null. */
function p4_php(int $minVersionId = 80200): ?string
{
    if (PHP_VERSION_ID >= $minVersionId) {
        return PHP_BINARY;
    }
    $herd = getenv('HOME') . '/Library/Application Support/Herd/bin';
    foreach (['php84', 'php83', 'php85', 'php82'] as $alias) {
        $candidate = $herd . '/' . $alias;
        if (is_file($candidate) && is_executable($candidate)) {
            return $candidate;
        }
    }

    return null;
}

/**
 * Run a support script in a separate PHP process and decode the JSON between @@PROBE markers.
 *
 * @return array ['data' => mixed, 'elapsedMs' => float, 'stderr' => string]
 */
function p4_probe(string $script, array $args, ?string $php = null, ?string $cwd = null): array
{
    $command = array_merge([$php ?: PHP_BINARY, '-d', 'xdebug.mode=off', '-d', 'display_errors=stderr', $script], $args);
    $proc = proc_open($command, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, $cwd ?: sys_get_temp_dir());
    if (!is_resource($proc)) {
        throw new AssertionFailed('Could not start ' . implode(' ', $command));
    }
    fclose($pipes[0]);
    $stdout = stream_get_contents($pipes[1]);
    $stderr = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $exit = proc_close($proc);
    $begin = strpos($stdout, '@@PROBE_BEGIN');
    $end = strpos($stdout, '@@PROBE_END');
    if ($begin === false || $end === false) {
        throw new AssertionFailed("Probe produced no result (exit $exit).\nSTDOUT:\n" . $stdout . "\nSTDERR:\n" . $stderr);
    }
    $json = substr($stdout, $begin + strlen('@@PROBE_BEGIN'), $end - $begin - strlen('@@PROBE_BEGIN'));
    $decoded = json_decode(trim($json), true);
    if (!is_array($decoded) || !array_key_exists('data', $decoded)) {
        throw new AssertionFailed("Probe JSON invalid:\n" . $json . "\nSTDERR:\n" . $stderr);
    }
    $decoded['stderr'] = $stderr;

    return $decoded;
}

/**
 * Environment that keeps a bootstrapped Laravel project away from its real database, log files and cache
 * (applied around t_run_bundle(), whose child process inherits the environment). Values Laravel's env()
 * would turn into null ("null") are avoided on purpose.
 */
function p4_with_safe_laravel_env(callable $fn)
{
    $vars = [
        'DB_CONNECTION' => 'sqlite', 'DB_DATABASE' => ':memory:', 'DB_URL' => '', 'DATABASE_URL' => '',
        'LOG_CHANNEL' => 'stderr', 'LOG_STACK' => 'stderr', 'CACHE_STORE' => 'array', 'CACHE_DRIVER' => 'array',
        'SESSION_DRIVER' => 'array', 'QUEUE_CONNECTION' => 'sync', 'BROADCAST_CONNECTION' => 'log',
        'BROADCAST_DRIVER' => 'log', 'MAIL_MAILER' => 'array', 'TELESCOPE_ENABLED' => 'false',
    ];
    $previous = [];
    foreach ($vars as $key => $value) {
        $previous[$key] = getenv($key);
        putenv($key . '=' . $value);
    }
    try {
        return $fn();
    } finally {
        foreach ($previous as $key => $value) {
            putenv($value === false ? $key : $key . '=' . $value);
        }
    }
}

/** path => "mtime:size" of every file below the given directories (to prove a project was not written to). */
function p4_snapshot(array $dirs): array
{
    $snapshot = [];
    foreach ($dirs as $dir) {
        if (!is_dir($dir)) {
            continue;
        }
        $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS));
        foreach ($it as $file) {
            clearstatcache(true, $file->getPathname());
            $snapshot[$file->getPathname()] = $file->getMTime() . ':' . $file->getSize();
        }
    }
    ksort($snapshot);

    return $snapshot;
}

function p4_project_dirs(string $project): array
{
    return [$project . '/storage', $project . '/bootstrap/cache', $project . '/database'];
}

// ---------------------------------------------------------------------------------------------------------------
// Shape assertions (src/shared/types.ts)
// ---------------------------------------------------------------------------------------------------------------

function p4_assert_keys(array $value, array $required, array $optional, string $label): void
{
    foreach ($required as $key) {
        t_assert(array_key_exists($key, $value), "$label: missing key '$key' in " . json_encode($value));
    }
    $unknown = array_diff(array_keys($value), $required, $optional);
    t_assert(!$unknown, "$label: unexpected keys " . json_encode(array_values($unknown)));
}

function p4_assert_member(array $m): void
{
    p4_assert_keys($m, ['name', 'kind', 'static', 'visibility'], ['signature', 'type', 'doc', 'declaringClass'], 'MemberInfo');
    t_assert(is_string($m['name']) && $m['name'] !== '', 'MemberInfo.name');
    t_assert(in_array($m['kind'], ['method', 'property', 'constant', 'case'], true), 'MemberInfo.kind ' . json_encode($m));
    t_assert(is_bool($m['static']), 'MemberInfo.static');
    t_assert(in_array($m['visibility'], ['public', 'protected', 'private'], true), 'MemberInfo.visibility');
    foreach (['signature', 'type', 'doc', 'declaringClass'] as $key) {
        if (array_key_exists($key, $m)) {
            t_assert(is_string($m[$key]), "MemberInfo.$key must be a string: " . json_encode($m));
        }
    }
}

function p4_assert_class_members($cm): void
{
    t_assert(is_array($cm), 'ClassMembers expected, got ' . json_encode($cm));
    p4_assert_keys($cm, ['class', 'interfaces', 'members'], ['parent'], 'ClassMembers');
    t_assert(is_string($cm['class']), 'ClassMembers.class');
    t_assert(is_array($cm['interfaces']) && array_values($cm['interfaces']) === $cm['interfaces'], 'ClassMembers.interfaces list');
    t_assert(array_values($cm['members']) === $cm['members'], 'ClassMembers.members list');
    foreach ($cm['members'] as $m) {
        p4_assert_member($m);
    }
}

/** @return array name => member (first of each name+kind) */
function p4_members_by(array $cm, string $kind): array
{
    $out = [];
    foreach ($cm['members'] as $m) {
        if ($m['kind'] === $kind && !isset($out[$m['name']])) {
            $out[$m['name']] = $m;
        }
    }

    return $out;
}

function p4_assert_environment($env): void
{
    t_assert(is_array($env), 'EnvironmentInfo expected');
    p4_assert_keys($env, ['phpVersion', 'driver', 'extensions', 'functions', 'classes', 'aliases', 'constants', 'models', 'variables'], [], 'EnvironmentInfo');
    t_assert(is_string($env['phpVersion']), 'phpVersion');
    if ($env['driver'] !== null) {
        p4_assert_keys($env['driver'], ['id', 'name'], ['appVersion', 'usesCollision', 'logFilesPath'], 'DriverInfo');
    }
    foreach ($env['functions'] as $f) {
        p4_assert_keys($f, ['name', 'signature'], ['doc'], 'FunctionInfo');
        t_assert(is_string($f['signature']) && $f['signature'][0] === '(', 'FunctionInfo.signature ' . json_encode($f));
    }
    foreach (['extensions', 'classes', 'constants'] as $key) {
        t_assert(array_values($env[$key]) === $env[$key], "$key must be a list");
        foreach ($env[$key] as $item) {
            t_assert(is_string($item), "$key entries are strings");
        }
    }
    t_assert(is_array($env['aliases']), 'aliases map');
    foreach ($env['aliases'] as $alias => $target) {
        t_assert(is_string($alias) && is_string($target), 'aliases are string => string');
    }
    foreach ($env['models'] as $model) {
        p4_assert_keys($model, ['class', 'columns'], ['table', 'relations'], 'ModelInfo');
        foreach ($model['columns'] as $column) {
            p4_assert_keys($column, ['name'], ['type'], 'ModelInfo.columns[]');
        }
    }
    foreach ($env['variables'] as $variable) {
        p4_assert_keys($variable, ['name'], ['type'], 'variables[]');
    }
}

function p4_assert_log_entry(array $e): void
{
    p4_assert_keys($e, ['datetime', 'level', 'message'], ['env', 'context', 'stack'], 'LogEntry');
    t_assert(is_string($e['datetime']) && is_string($e['message']), 'LogEntry strings');
    t_assert(in_array($e['level'], P4_LEVELS, true), 'LogEntry.level ' . json_encode($e['level']));
    foreach (['env', 'context', 'stack'] as $key) {
        if (array_key_exists($key, $e)) {
            t_assert(is_string($e[$key]) && $e[$key] !== '', "LogEntry.$key non-empty string");
        }
    }
}

function p4_assert_panels($panels): void
{
    t_assert(is_array($panels) && array_values($panels) === $panels, 'AppPanel[] list');
    foreach ($panels as $panel) {
        p4_assert_keys($panel, ['title', 'sections'], [], 'AppPanel');
        t_assert(is_string($panel['title']), 'AppPanel.title');
        foreach ($panel['sections'] as $section) {
            p4_assert_keys($section, ['title', 'rows'], [], 'AppPanel.section');
            t_assert(is_string($section['title']), 'section.title');
            foreach ($section['rows'] as $row) {
                p4_assert_keys($row, ['key', 'value'], [], 'AppPanel.row');
                t_assert(is_string($row['key']) && is_string($row['value']), 'row key/value strings ' . json_encode($row));
            }
        }
    }
}

/** First panel row value by section title + key, or null. */
function p4_panel_value(array $panel, string $section, string $key): ?string
{
    foreach ($panel['sections'] as $s) {
        if ($s['title'] === $section) {
            foreach ($s['rows'] as $row) {
                if ($row['key'] === $key) {
                    return $row['value'];
                }
            }
        }
    }

    return null;
}
