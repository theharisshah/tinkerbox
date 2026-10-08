<?php

require_once __DIR__ . '/support/helpers.php';
t_load_runner_sources();

use Tinkerbox\LogReader;

/** Read a fixture log (copied into a fresh temp root) newest first. */
function p4_read_fixture(string $file, int $limit = 500): array
{
    $entries = LogReader::read(p4_log_root(), $file, $limit);
    foreach ($entries as $entry) {
        p4_assert_log_entry($entry);
    }

    return $entries;
}

return [
    'lists *.log and *.txt recursively, grouped by directory, newest first' => function () {
        $root = p4_log_root([
            'daily/laravel-2024-05-01.log' => mktime(8, 0, 0, 5, 1, 2024),
            'daily/laravel-2024-05-02.log' => mktime(8, 0, 0, 5, 2, 2024),
            'laravel.log' => mktime(12, 0, 0, 5, 3, 2024),
        ]);
        $listing = LogReader::list($root);
        p4_assert_keys($listing, ['root', 'files'], [], 'LogListing');
        t_same($root, $listing['root']);
        $paths = array_column($listing['files'], 'path');
        t_same('laravel.log', $paths[0], 'newest root file first');
        t_assert(!in_array('notes.md', $paths, true), 'non-log files are not listed');
        t_assert(!in_array('.hidden.log', $paths, true), 'hidden files are not listed');
        t_assert(in_array('deploy.txt', $paths, true), '.txt files are listed');
        $rootFiles = array_values(array_filter($listing['files'], function ($f) { return $f['dir'] === ''; }));
        t_same(8, count($rootFiles), 'root files: ' . json_encode(array_column($rootFiles, 'path')));
        $last = array_slice($listing['files'], -2);
        t_same(['daily/laravel-2024-05-02.log', 'daily/laravel-2024-05-01.log'], array_column($last, 'path'), 'directory group after root files, newest first');
        foreach ($listing['files'] as $file) {
            p4_assert_keys($file, ['path', 'name', 'dir', 'size', 'modifiedAt'], [], 'LogFile');
            t_assert(is_int($file['size']) && $file['size'] === filesize($root . '/' . $file['path']), 'size in bytes');
            t_same(filemtime($root . '/' . $file['path']) * 1000, $file['modifiedAt'], 'modifiedAt in ms');
        }
        t_same('daily', $last[0]['dir']);
        t_same('laravel-2024-05-02.log', $last[0]['name']);
    },

    'missing log root yields an empty listing' => function () {
        $listing = LogReader::list('/definitely/not/here/logs');
        t_same(['root' => '/definitely/not/here/logs', 'files' => []], $listing);
        t_same([], LogReader::list('')['files']);
    },

    'parses Laravel entries with context, multi-line messages and stack traces' => function () {
        $entries = p4_read_fixture('laravel.log');
        t_same(10, count($entries));
        $levels = array_column($entries, 'level');
        t_same(['error', 'notice', 'alert', 'emergency', 'error', 'critical', 'warning', 'error', 'debug', 'info'], $levels, 'newest first');

        // Newest: JSON context cut off (no closing brace) → recovered textually.
        $truncated = $entries[0];
        t_same('Truncated context', $truncated['message']);
        t_contains('ErrorException(code: 0): Undefined variable $x at /var/www/app/routes/web.php:5', $truncated['context']);
        t_contains("HandleExceptions->handleError(2, 'Undefined varia...')", $truncated['stack']);
        t_contains('Illuminate\\Foundation\\Bootstrap', $truncated['stack']);
        t_assert(strpos($truncated['stack'], '\\\\') === false, 'JSON escapes removed from the recovered stack');

        $notice = $entries[1];
        t_same('Response payload', $notice['message']);
        $context = json_decode($notice['context'], true);
        t_same(['data' => ['ok' => true, 'emoji' => "\u{2713} ü"]], $context);

        $alert = $entries[2];
        t_same('Disk usage at 95%', $alert['message']);
        t_assert(!isset($alert['context']) && !isset($alert['stack']), 'no context / stack');

        $outer = $entries[4];
        t_same('Outer failure', $outer['message']);
        t_contains('#0 /var/www/app/vendor/laravel/framework/src/Illuminate/Container/BoundMethod.php(36): App\\Jobs\\Sync->handle()', $outer['stack']);
        t_contains('[previous exception] [object] (PDOException(code: HY000)', $outer['stack'], 'previous exceptions stay in the stack');

        $critical = $entries[5];
        t_same('2024-05-01T12:00:04.5Z', $critical['datetime']);
        t_same('testing', $critical['env']);
        t_same('Queue failed with nested', $critical['message']);
        t_contains('"attempts": 3', $critical['context']);
        t_contains('"memory": "12MB"', $critical['context'], 'extra is shown with the context');

        $warning = $entries[6];
        t_same('2024-05-01T12:00:03.123456+02:00', $warning['datetime']);
        t_same('Payment {provider} slow', $warning['message'], 'braces in the message and empty [] [] context/extra');
        t_assert(!isset($warning['context']), 'empty context is omitted');

        $error = $entries[7];
        t_same('2024-05-01 12:00:02', $error['datetime']);
        t_same('production', $error['env']);
        t_same('Call to undefined method App\\Models\\User::foo()', $error['message']);
        $context = json_decode($error['context'], true);
        t_same(7, $context['userId']);
        t_same('[object] (BadMethodCallException(code: 0): Call to undefined method App\\Models\\User::foo() at /var/www/app/vendor/laravel/framework/src/Illuminate/Support/Traits/ForwardsCalls.php:67)', $context['exception']);
        t_assert(strpos($error['stack'], "#0 /var/www/app/vendor/laravel/framework/src/Illuminate/Support/Traits/ForwardsCalls.php(36): Illuminate\\Database\\Eloquent\\Model::throwBadMethodCallException('foo')") === 0, 'stack starts with frame #0: ' . $error['stack']);
        t_same('#2 {main}', substr($error['stack'], -9));

        $debug = $entries[8];
        t_same("Multi-line message\nsecond line of the message\nthird line", $debug['message']);
        t_same(['step' => 3], json_decode($debug['context'], true));

        $info = $entries[9];
        t_same(['datetime' => '2024-05-01 12:00:00', 'env' => 'local', 'level' => 'info', 'message' => 'User logged in'], array_diff_key($info, ['context' => 1]));
        t_same(['user_id' => 1, 'ip' => '127.0.0.1'], json_decode($info['context'], true));
    },

    'limit returns only the newest entries' => function () {
        $entries = p4_read_fixture('laravel.log', 3);
        t_same(['Truncated context', 'Response payload', 'Disk usage at 95%'], array_column($entries, 'message'));
        t_same(10, count(p4_read_fixture('laravel.log', 0)), 'limit <= 0 falls back to the default');
        t_same(10, count(p4_read_fixture('laravel.log', 999999)), 'huge limits are capped');
    },

    'reads daily logs in sub-directories' => function () {
        $entries = p4_read_fixture('daily/laravel-2024-05-01.log');
        t_same(['Daily one second', 'Daily one first'], array_column($entries, 'message'));
        t_same('warning', $entries[0]['level']);
        t_same(['retries' => 2], json_decode($entries[0]['context'], true));
        t_same('production', $entries[0]['env']);
    },

    'parses nginx error logs' => function () {
        $entries = p4_read_fixture('nginx-error.log');
        t_same(['emergency', 'notice', 'critical', 'warning', 'error'], array_column($entries, 'level'));
        t_same('2024-05-01 12:00:04', $entries[0]['datetime']);
        t_same('1#1: bind() to 0.0.0.0:80 failed (98: Address already in use)', $entries[0]['message']);
        t_contains('FastCGI sent in stderr: "PHP message: PHP Warning:  Undefined variable $x', $entries[4]['message']);
    },

    'parses apache error logs (2.2 and 2.4) incl. multi-line PHP fatals' => function () {
        $entries = p4_read_fixture('apache-error.log');
        t_same(6, count($entries));
        t_same(['debug', 'error', 'warning', 'warning', 'notice', 'error'], array_column($entries, 'level'));
        $fatal = $entries[5];
        t_same('2024-05-01 12:00:00.123456', $fatal['datetime']);
        t_same('php', $fatal['env']);
        t_same('[client 10.0.0.1:52344] PHP Fatal error:  Uncaught Error: Call to undefined function foo() in /var/www/html/index.php:3', $fatal['message']);
        t_same("#0 {main}\n  thrown in /var/www/html/index.php on line 3", $fatal['stack']);
        t_same('AH00094: Command line: \'/usr/sbin/apache2\'', $entries[4]['message'], 'pid / tid prefix removed');
        t_same('2024-05-01 12:00:02', $entries[3]['datetime'], 'apache 2.2 single-digit day');
        t_same('[client 10.0.0.2] mod_fcgid: stderr: PHP Warning:  foo', $entries[3]['message']);
        t_assert(!isset($entries[3]['env']), 'no module on apache 2.2');
        t_same('2024-05-02 08:05:10.000000', $entries[1]['datetime']);
    },

    'parses php-fpm logs' => function () {
        $entries = p4_read_fixture('php-fpm.log');
        t_same(['alert', 'error', 'warning', 'warning', 'notice', 'notice'], array_column($entries, 'level'));
        t_same('2024-05-01 12:07:01', $entries[0]['datetime']);
        t_same('[pool www] child 43 exited on signal 11 (SIGSEGV) after 1.5 seconds from start', $entries[0]['message']);
    },

    'parses PHP error_log files with stack traces' => function () {
        $entries = p4_read_fixture('php_errors.log');
        t_same(['critical', 'critical', 'notice', 'warning'], array_column($entries, 'level'));
        $fatal = $entries[1];
        t_same('2024-05-01 12:00:02 Europe/Berlin', $fatal['datetime']);
        t_same('Fatal error: Uncaught Exception: boom in /var/www/app/run.php:3', $fatal['message']);
        t_same("#0 /var/www/app/index.php(4): run()\n#1 {main}\n  thrown in /var/www/app/run.php on line 3", $fatal['stack']);
        t_same('Deprecated: Creation of dynamic property Foo::$bar is deprecated in /var/www/app/Foo.php on line 5', $entries[2]['message']);
        t_same('2024-05-01 12:00:00 UTC', $entries[3]['datetime']);
    },

    'parses queue worker / Horizon output and stand-alone plain lines' => function () {
        $entries = p4_read_fixture('horizon.log');
        t_same(7, count($entries));
        t_same(['datetime' => '', 'level' => 'info', 'message' => 'Horizon started successfully.'], $entries[0]);
        t_same('error', $entries[1]['level']);
        t_same('[Xy12Ab] Failed:     App\\Jobs\\LegacyJob', $entries[1]['message']);
        t_same('2023-04-01 10:00:01', $entries[1]['datetime']);
        t_same('info', $entries[2]['level']);
        t_same('App\\Jobs\\ImportCsv … 3s FAIL', $entries[3]['message']);
        t_same('error', $entries[3]['level']);
        t_same('2024-05-01 12:00:05', $entries[3]['datetime']);
        t_same(['info', 'info', 'info'], array_column(array_slice($entries, 4), 'level'));
        t_same('App\\Jobs\\SendWelcomeEmail … RUNNING', $entries[6]['message']);
    },

    'plain text logs: one entry per line, level by keyword' => function () {
        $entries = p4_read_fixture('deploy.txt');
        t_same(['debug: cache hit ratio 0.93', 'Deploy finished', 'ERROR could not connect to redis', 'Warning: low disk space', 'Starting deploy'], array_column($entries, 'message'));
        t_same(['debug', 'info', 'error', 'warning', 'info'], array_column($entries, 'level'));
        t_same('', $entries[0]['datetime']);
    },

    'parses Monolog JSON lines' => function () {
        $entries = p4_read_fixture('json.log');
        t_same(4, count($entries));
        t_same(['datetime' => '', 'level' => 'info', 'message' => 'not json at all'], $entries[0]);
        t_same('alert', $entries[1]['level'], 'numeric Monolog level 550');
        t_same('2024-05-01T12:00:02Z', $entries[1]['datetime']);
        $payment = $entries[2];
        t_same('Payment failed', $payment['message']);
        t_same('error', $payment['level']);
        t_same('production', $payment['env']);
        t_same("#0 /app/Checkout.php:20\n#1 /app/index.php:5", $payment['stack']);
        t_contains('"message": "Card declined"', $payment['context']);
        t_contains('"uid": "x1"', $payment['context']);
        t_assert(strpos($payment['context'], '"trace"') === false, 'trace moved to stack');
        t_same(['order' => 42], json_decode($entries[3]['context'], true));
    },

    'CRLF line endings, BOM and empty files' => function () {
        $root = p4_tmpdir('logs-crlf');
        file_put_contents($root . '/win.log', "\xEF\xBB\xBF[2024-05-01 12:00:00] local.INFO: first\r\n[2024-05-01 12:00:01] local.ERROR: second\r\nmore\r\n");
        file_put_contents($root . '/empty.log', '');
        $entries = LogReader::read($root, 'win.log', 10);
        t_same(["second\nmore", 'first'], array_column($entries, 'message'));
        t_same('2024-05-01 12:00:00', $entries[1]['datetime']);
        t_same([], LogReader::read($root, 'empty.log', 10));
    },

    'path traversal and non-log files are refused' => function () {
        $base = p4_tmpdir('logs-traversal');
        mkdir($base . '/logs/nested', 0777, true);
        file_put_contents($base . '/secret.log', "[2024-05-01 12:00:00] local.INFO: secret\n");
        file_put_contents($base . '/logs/app.log', "[2024-05-01 12:00:00] local.INFO: ok\n");
        file_put_contents($base . '/logs/nested/inner.log', "[2024-05-01 12:00:00] local.INFO: inner\n");
        file_put_contents($base . '/logs/.env.txt', "SECRET=1\n");
        file_put_contents($base . '/logs/config.php', "<?php return [];\n");
        symlink($base . '/secret.log', $base . '/logs/link-out.log');
        symlink($base . '/logs/app.log', $base . '/logs/link-in.log');
        $root = $base . '/logs';

        foreach (['../secret.log', 'nested/../../secret.log', $base . '/secret.log', 'link-out.log', '/etc/passwd', '../../../../../../etc/passwd'] as $attempt) {
            $e = t_throws(function () use ($root, $attempt) {
                LogReader::read($root, $attempt, 10);
            }, \RuntimeException::class);
            t_contains('outside of the log directory', $e->getMessage(), $attempt);
        }
        t_contains('Only .log and .txt', t_throws(function () use ($root) {
            LogReader::read($root, 'config.php', 10);
        }, \RuntimeException::class)->getMessage());
        t_throws(function () use ($root) {
            LogReader::read($root, "app.log\0.txt", 10);
        }, \InvalidArgumentException::class);
        t_throws(function () use ($root) {
            LogReader::read($root, '', 10);
        }, \InvalidArgumentException::class);
        t_contains('not found', t_throws(function () use ($root) {
            LogReader::read($root, 'missing.log', 10);
        }, \RuntimeException::class)->getMessage());
        t_contains('Log directory not found', t_throws(function () use ($base) {
            LogReader::read($base . '/nope', 'app.log', 10);
        }, \RuntimeException::class)->getMessage());

        // Allowed: paths that stay inside the root, symlinks to files inside the root.
        t_same('inner', LogReader::read($root, 'nested/../nested/inner.log', 10)[0]['message']);
        t_same('ok', LogReader::read($root, './link-in.log', 10)[0]['message']);
        t_same('ok', LogReader::read($root, $root . '/app.log', 10)[0]['message'], 'absolute path inside the root');

        $paths = array_column(LogReader::list($root)['files'], 'path');
        sort($paths);
        t_same(['app.log', 'link-in.log', 'nested/inner.log'], $paths, 'links out of the root and hidden files are not listed');
    },

    'big files: only the tail (≤ 5 MB) is read, newest entries first' => function () {
        $root = p4_tmpdir('logs-big');
        $path = $root . '/huge.log';
        $handle = fopen($path, 'wb');
        $frame = str_repeat('#1 /var/www/vendor/laravel/framework/src/Illuminate/Pipeline/Pipeline.php(183): Illuminate\\\\Pipeline\\\\Pipeline->{closure}(Object(Illuminate\\\\Http\\\\Request))' . "\n", 6);
        $total = 13000;
        $lengths = [];
        for ($i = 1; $i <= $total; $i++) {
            $entry = sprintf('[2024-05-01 12:%02d:%02d] production.ERROR: Failure number %d {"exception":"[object] (RuntimeException(code: 0): Failure number %d at /var/www/app/x.php:1)' . "\n[stacktrace]\n#0 /var/www/app/x.php(1): run()\n", intdiv($i, 60) % 60, $i % 60, $i, $i)
                . $frame . "#2 {main}\n\"} \n";
            $lengths[$i] = strlen($entry);
            fwrite($handle, $entry);
        }
        fclose($handle);
        $size = filesize($path);
        t_assert($size > 12 * 1048576, 'fixture is larger than 12 MB: ' . $size);

        // Entries completely inside the last 5 MB (the one cut by the window boundary is dropped).
        $expected = 0;
        $bytes = 0;
        for ($i = $total; $i >= 1; $i--) {
            $bytes += $lengths[$i];
            if ($bytes > 5242880) {
                break;
            }
            $expected++;
        }
        t_assert($expected < 10000, 'test needs fewer than MAX_LIMIT entries in 5 MB: ' . $expected);

        $start = microtime(true);
        $entries = LogReader::read($root, 'huge.log', 50);
        $smallMs = (microtime(true) - $start) * 1000;
        t_same(50, count($entries));
        t_same('Failure number ' . $total, $entries[0]['message'], 'newest entry first');
        t_same('Failure number ' . ($total - 49), $entries[49]['message']);
        t_contains('#2 {main}', $entries[0]['stack']);
        t_contains('RuntimeException(code: 0): Failure number ' . $total, $entries[0]['context']);

        $start = microtime(true);
        $memoryBefore = memory_get_usage();
        $all = LogReader::read($root, 'huge.log', 10000);
        $allMs = (microtime(true) - $start) * 1000;
        t_same($expected, count($all), 'exactly the entries contained in the 5 MB tail');
        foreach ($all as $index => $entry) {
            if ($entry['message'] !== 'Failure number ' . ($total - $index) || !isset($entry['stack'], $entry['context'])) {
                throw new AssertionFailed('Entries must be contiguous and complete, broke at ' . $index . ': ' . json_encode($entry));
            }
        }
        t_assert($smallMs < 1000, sprintf('small limit read took %.0f ms', $smallMs));
        t_assert($allMs < 3000, sprintf('5 MB read took %.0f ms', $allMs));
        fwrite(STDERR, sprintf("    (%.1f MB log: limit 50 in %.0f ms, %d entries from the 5 MB tail in %.0f ms, +%.1f MB memory)\n", $size / 1048576, $smallMs, count($all), $allMs, (memory_get_usage() - $memoryBefore) / 1048576));
    },

    'window starting exactly at a line boundary keeps that entry' => function () {
        $root = p4_tmpdir('logs-boundary');
        $path = $root . '/edge.log';
        // 8192 entries of exactly 640 bytes = 5 MB, preceded by unrelated lines: the tail window starts exactly
        // at the header of entry 1, which must not be mistaken for a partial line.
        $entry = function ($i) {
            $prefix = sprintf('[2024-05-01 10:00:00] local.INFO: entry %05d ', $i);

            return $prefix . str_repeat('x', 640 - strlen($prefix) - 1) . "\n";
        };
        t_same(640, strlen($entry(1)));
        $handle = fopen($path, 'wb');
        fwrite($handle, str_repeat("stack line before the window\n", 30000));
        for ($i = 1; $i <= 8192; $i++) {
            fwrite($handle, $entry($i));
        }
        fclose($handle);
        $all = LogReader::read($root, 'edge.log', 10000);
        t_same(8192, count($all), 'every entry of the window, none of the lines before it');
        t_same(rtrim(substr($entry(8192), strlen('[2024-05-01 10:00:00] local.INFO: '))), $all[0]['message']);
        t_same(rtrim(substr($entry(1), strlen('[2024-05-01 10:00:00] local.INFO: '))), $all[8191]['message'], 'first entry of the window is kept');
    },

    'level normalization and keyword detection' => function () {
        t_same('warning', LogReader::normalizeLevel('WARN'));
        t_same('critical', LogReader::normalizeLevel('crit'));
        t_same('emergency', LogReader::normalizeLevel('emerg'));
        t_same('critical', LogReader::normalizeLevel('Fatal error'));
        t_same('notice', LogReader::normalizeLevel('Deprecated'));
        t_same('debug', LogReader::normalizeLevel('trace5'));
        t_same('info', LogReader::normalizeLevel('whatever'));
        t_same('error', LogReader::detectLevel('Job failed after 3 attempts'));
        t_same('info', LogReader::detectLevel('App\\Exceptions\\Handler registered'), 'no keyword match inside identifiers');
        t_same('critical', LogReader::detectLevel('FATAL: out of memory'));
    },
];
