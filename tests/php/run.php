<?php
/**
 * Minimal dependency-free PHP test harness.
 *
 *   php tests/php/run.php            # run every tests/php/**\/*Test.php
 *   php tests/php/run.php Dumper     # only files whose path contains "Dumper"
 *
 * A test file returns an array of `name => callable`. Use the assertion helpers below.
 * The runner sources are loaded via resources/php/tinkerbox.php's loader (manifest order)
 * when `TINKERBOX_LOAD_SOURCES` is not disabled by the test file itself.
 */

error_reporting(E_ALL);
ini_set('display_errors', 'stderr');

final class AssertionFailed extends \Exception {}

function t_assert($cond, string $message = 'Assertion failed'): void
{
    if (!$cond) throw new AssertionFailed($message);
}

function t_same($expected, $actual, string $message = ''): void
{
    if ($expected !== $actual) {
        throw new AssertionFailed(($message ? $message . "\n" : '') . 'Expected: ' . var_export($expected, true) . "\nActual:   " . var_export($actual, true));
    }
}

function t_contains(string $needle, string $haystack, string $message = ''): void
{
    if (strpos($haystack, $needle) === false) {
        throw new AssertionFailed(($message ? $message . "\n" : '') . "Expected to find: " . var_export($needle, true) . "\nIn: " . var_export($haystack, true));
    }
}

function t_throws(callable $fn, string $class = \Throwable::class): \Throwable
{
    try {
        $fn();
    } catch (\Throwable $e) {
        if ($e instanceof $class) return $e;
        throw new AssertionFailed('Expected ' . $class . ', got ' . get_class($e) . ': ' . $e->getMessage());
    }
    throw new AssertionFailed('Expected exception ' . $class . ' was not thrown');
}

/**
 * Path of a real Laravel project (with vendor/) used READ-ONLY by the Laravel integration tests, taken from the
 * TINKERBOX_TEST_LARAVEL environment variable. Returns '' when unset or not a Laravel project (tests then skip).
 */
function t_laravel_project(): string
{
    $path = rtrim((string) getenv('TINKERBOX_TEST_LARAVEL'), '/');
    if ($path === '' || !is_file($path . '/artisan') || !is_file($path . '/vendor/autoload.php')) return '';
    return $path;
}

/** Load the runner sources in manifest order (idempotent). */
function t_load_runner_sources(): void
{
    static $loaded = false;
    if ($loaded) return;
    $loaded = true;
    $root = dirname(__DIR__, 2) . '/resources/php';
    $manifest = json_decode(file_get_contents($root . '/manifest.json'), true);
    foreach ($manifest['files'] as $file) {
        if (is_file($root . '/' . $file)) require_once $root . '/' . $file;
    }
}

/**
 * Run the full runner end-to-end in a separate PHP process, exactly like the app does:
 * build the bundle (manifest concatenation + payload) and pipe it to `php` via stdin.
 * Returns the decoded envelope array (or throws when no envelope was found).
 */
function t_run_bundle(array $payload, ?string $cwd = null, ?string $php = null): array
{
    $root = dirname(__DIR__, 2) . '/resources/php';
    $manifest = json_decode(file_get_contents($root . '/manifest.json'), true);
    $script = "<?php\n";
    foreach ($manifest['files'] as $file) {
        $src = file_get_contents($root . '/' . $file);
        $script .= preg_replace('/^<\?php\s*/', '', $src, 1) . "\n";
    }
    $payload += ['nonce' => 'tw_test_' . bin2hex(random_bytes(4)), 'mode' => 'run', 'projectPath' => '', 'driver' => '', 'lineOffset' => 1, 'className' => '', 'options' => []];
    $payload['options'] += ['maxDepth' => 6, 'maxItems' => 250, 'maxStringLength' => 10000, 'captureQueries' => true, 'magicComments' => true, 'coverage' => true, 'strictTypes' => false, 'outputType' => 'buffered', 'timeoutMs' => 60000];
    if (isset($payload['code']) && empty($payload['codeIsBase64'])) $payload['code'] = base64_encode($payload['code']);
    unset($payload['codeIsBase64']);
    $script .= "namespace { \\Tinkerbox\\Runner::main(json_decode(base64_decode('" . base64_encode(json_encode($payload)) . "'), true)); }\n";

    $proc = proc_open([$php ?: PHP_BINARY, '-d', 'xdebug.mode=off'], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, $cwd ?: sys_get_temp_dir());
    fwrite($pipes[0], $script);
    fclose($pipes[0]);
    $stdout = stream_get_contents($pipes[1]);
    $stderr = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    proc_close($proc);

    $begin = $payload['nonce'] . 'BEGIN';
    $end = $payload['nonce'] . 'END';
    $b = strrpos($stdout, $begin);
    $e = strrpos($stdout, $end);
    if ($b === false || $e === false || $e < $b) {
        throw new AssertionFailed("No envelope in runner output.\nSTDOUT:\n" . $stdout . "\nSTDERR:\n" . $stderr);
    }
    $json = substr($stdout, $b + strlen($begin), $e - $b - strlen($begin));
    $data = json_decode(trim($json), true);
    if (!is_array($data)) throw new AssertionFailed("Envelope is not valid JSON:\n" . $json);
    $data['__stdout_outside'] = substr($stdout, 0, $b) . substr($stdout, $e + strlen($end));
    $data['__stderr'] = $stderr;
    return $data;
}

$filter = $argv[1] ?? '';
$files = [];
$it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator(__DIR__, FilesystemIterator::SKIP_DOTS));
foreach ($it as $f) {
    if (substr($f->getFilename(), -8) === 'Test.php' && ($filter === '' || strpos($f->getPathname(), $filter) !== false)) {
        $files[] = $f->getPathname();
    }
}
sort($files);

$passed = 0;
$failed = [];
foreach ($files as $file) {
    $tests = require $file;
    if (!is_array($tests)) {
        fwrite(STDERR, "Skipping $file: does not return an array of tests\n");
        continue;
    }
    foreach ($tests as $name => $test) {
        $label = basename($file, '.php') . ' › ' . $name;
        try {
            $test();
            $passed++;
            echo "  \033[32m✓\033[0m $label\n";
        } catch (\Throwable $e) {
            $failed[] = $label;
            echo "  \033[31m✗ $label\033[0m\n    " . str_replace("\n", "\n    ", get_class($e) . ': ' . $e->getMessage()) . "\n";
            if (!$e instanceof AssertionFailed) echo '    at ' . $e->getFile() . ':' . $e->getLine() . "\n";
        }
    }
}

echo "\n" . $passed . ' passed, ' . count($failed) . " failed\n";
exit($failed ? 1 : 0);
