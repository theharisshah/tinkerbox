<?php
/**
 * Shared helpers for the P1 runner-core tests (not a *Test.php file, so the harness does not run it).
 * Everything here must parse on PHP 7.4 → 8.5: PHP-8-only user code is passed as strings.
 */

if (!function_exists('p1_run')) {
    /**
     * Run editor code through the full bundle (manifest concatenation piped to `php` over stdin, like the app).
     *
     * @param string $code    editor code (plain text; base64-encoded by t_run_bundle)
     * @param array  $options RunOptions overrides
     * @param array  $payload other payload fields (lineOffset, projectPath, driver, mode, …)
     * @return array the decoded envelope (+ __stdout_outside / __stderr)
     */
    function p1_run($code, array $options = [], array $payload = [])
    {
        $payload += ['homePath' => sys_get_temp_dir()]; // never load the developer's global custom drivers
        $payload['code'] = $code;
        $payload['options'] = $options + (isset($payload['options']) && is_array($payload['options']) ? $payload['options'] : []);
        return t_run_bundle($payload);
    }

    /** Run a data mode through the bundle. */
    function p1_data($mode, array $payload = [])
    {
        $payload['mode'] = $mode;
        $payload += ['homePath' => sys_get_temp_dir()];
        return t_run_bundle($payload);
    }

    /**
     * Raw stdout/stderr of a bundle run (to count envelopes and inspect text outside of them).
     * @param array $ini extra php.ini settings (`-d name=value`), e.g. ['memory_limit' => '128M']
     * @return array{stdout: string, stderr: string, nonce: string}
     */
    function p1_raw($code, array $options = [], array $payload = [], array $ini = [])
    {
        $root = dirname(__DIR__, 3) . '/resources/php';
        $manifest = json_decode(file_get_contents($root . '/manifest.json'), true);
        $script = "<?php\n";
        foreach ($manifest['files'] as $file) {
            $script .= preg_replace('/^<\?php\s*/', '', file_get_contents($root . '/' . $file), 1) . "\n";
        }
        $nonce = 'tw_raw_' . bin2hex(random_bytes(4));
        $payload += ['nonce' => $nonce, 'mode' => 'run', 'projectPath' => '', 'driver' => '', 'lineOffset' => 1, 'className' => '', 'homePath' => sys_get_temp_dir()];
        $payload['code'] = base64_encode($code);
        $payload['options'] = $options + ['maxDepth' => 6, 'maxItems' => 250, 'maxStringLength' => 10000, 'captureQueries' => true, 'magicComments' => true, 'coverage' => true, 'strictTypes' => false, 'outputType' => 'buffered', 'timeoutMs' => 60000];
        $script .= "namespace { \\Tinkerbox\\Runner::main(json_decode(base64_decode('" . base64_encode(json_encode($payload)) . "'), true)); }\n";

        $command = [PHP_BINARY, '-d', 'xdebug.mode=off'];
        foreach ($ini as $name => $value) array_push($command, '-d', $name . '=' . $value);
        $proc = proc_open($command, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, sys_get_temp_dir());
        fwrite($pipes[0], $script);
        fclose($pipes[0]);
        $stdout = stream_get_contents($pipes[1]);
        $stderr = stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        proc_close($proc);
        return ['stdout' => $stdout, 'stderr' => $stderr, 'nonce' => $payload['nonce']];
    }

    /** The envelope in p1_raw() output (null when there is none). */
    function p1_raw_envelope(array $raw)
    {
        $begin = strrpos($raw['stdout'], $raw['nonce'] . 'BEGIN');
        $end = strrpos($raw['stdout'], $raw['nonce'] . 'END');
        if ($begin === false || $end === false || $end < $begin) return null;
        $begin += strlen($raw['nonce'] . 'BEGIN');
        return json_decode(trim(substr($raw['stdout'], $begin, $end - $begin)), true);
    }

    /** CodeTransformer::transform() in-process (coverage markers off unless requested). */
    function p1_transform($code, array $options = [], $lineOffset = 1)
    {
        t_load_runner_sources();
        return \Tinkerbox\CodeTransformer::transform($code, $options + ['coverage' => false, 'magicComments' => true, 'strictTypes' => false], $lineOffset);
    }

    /** @return array[] the events of an envelope, optionally of one kind */
    function p1_events(array $env, $kind = null)
    {
        $events = [];
        foreach ($env['events'] as $event) {
            if ($kind === null || $event['kind'] === $kind) $events[] = $event;
        }
        return $events;
    }

    /** Compact "kind:line:payload" description of the events (ordering assertions). */
    function p1_event_summary(array $env)
    {
        $out = [];
        foreach ($env['events'] as $event) {
            $line = isset($event['line']) ? $event['line'] : '-';
            if ($event['kind'] === 'echo') {
                $out[] = 'echo:' . $line . ':' . $event['text'];
            } elseif ($event['kind'] === 'dump') {
                $out[] = 'dump:' . $line . ':' . p1_plain($event['value']);
            } else {
                $out[] = 'query:' . $line . ':' . $event['rawSql'];
            }
        }
        return $out;
    }

    /** Scalar DumpNodes as PHP-ish text (int 1 → "1", string → "s", null → "null"); others → their type. */
    function p1_plain($node)
    {
        if (!is_array($node) || !isset($node['t'])) return 'none';
        switch ($node['t']) {
            case 'null':
                return 'null';
            case 'bool':
                return $node['v'] ? 'true' : 'false';
            case 'int':
            case 'float':
            case 'string':
                return (string) $node['v'];
            case 'array':
                $items = [];
                foreach ($node['items'] as $item) $items[] = $item['k'] . '=>' . p1_plain($item['v']);
                return '[' . implode(',', $items) . ']';
            case 'object':
                return $node['class'];
            case 'closure':
                return 'Closure';
            case 'enum':
                return $node['class'] . '::' . $node['case'];
        }
        return $node['t'];
    }

    /** Magic records keyed by "line:column". */
    function p1_magic(array $env)
    {
        $out = [];
        foreach ($env['magic'] as $record) $out[$record['line'] . ':' . $record['column']] = $record;
        return $out;
    }

    /** Assert the envelope has the PhpEnvelope shape (src/shared/types.ts) with the exact key set. */
    function p1_assert_run_envelope(array $env)
    {
        $required = ['version', 'mode', 'phpVersion', 'driver', 'events', 'hasReturnValue', 'returnValue', 'magic', 'coverage', 'exception', 'diagnostics', 'bootMs', 'durationMs', 'memoryPeak', 'exited'];
        $keys = array_values(array_diff(array_keys($env), ['__stdout_outside', '__stderr']));
        sort($keys);
        $expected = $required;
        sort($expected);
        t_same($expected, $keys, 'PhpEnvelope keys');
        t_same(1, $env['version']);
        t_same('run', $env['mode']);
        t_same(PHP_VERSION, $env['phpVersion']);
        t_assert(is_array($env['events']) && is_array($env['magic']) && is_array($env['coverage']) && is_array($env['diagnostics']), 'list fields');
        t_assert(is_bool($env['hasReturnValue']) && is_bool($env['exited']), 'bool fields');
        t_assert(is_int($env['bootMs']) || is_float($env['bootMs']), 'bootMs is a number');
        t_assert(is_int($env['durationMs']) || is_float($env['durationMs']), 'durationMs is a number');
        t_assert(is_int($env['memoryPeak']) && $env['memoryPeak'] > 0, 'memoryPeak');
        $seq = 0;
        foreach ($env['events'] as $event) {
            t_assert($event['seq'] > $seq, 'event seq increases');
            $seq = $event['seq'];
            t_assert(in_array($event['kind'], ['echo', 'dump', 'query'], true), 'event kind');
        }
    }

    /** Create a temporary project directory with the given files (removed at shutdown). */
    function p1_temp_project(array $files)
    {
        $dir = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'tinkerbox-p1-' . bin2hex(random_bytes(5));
        mkdir($dir, 0777, true);
        foreach ($files as $path => $content) {
            $full = $dir . DIRECTORY_SEPARATOR . $path;
            if (!is_dir(dirname($full))) mkdir(dirname($full), 0777, true);
            file_put_contents($full, $content);
        }
        register_shutdown_function('p1_remove_tree', $dir);
        return realpath($dir);
    }

    function p1_remove_tree($dir)
    {
        if (!is_dir($dir)) return;
        $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($it as $file) {
            $file->isDir() ? @rmdir($file->getPathname()) : @unlink($file->getPathname());
        }
        @rmdir($dir);
    }

    /** Real Laravel project used read-only for smoke tests ('' when not available). */
    function p1_laravel_project()
    {
        $path = t_laravel_project();
        if ($path === '' || !is_file($path . '/artisan') || !is_file($path . '/vendor/autoload.php')) return '';
        // Skip on PHP versions the project's dependencies do not support (Composer's platform check).
        $check = @file_get_contents($path . '/vendor/composer/platform_check.php');
        if (is_string($check) && preg_match('/PHP_VERSION_ID >= (\d+)/', $check, $m) && PHP_VERSION_ID < (int) $m[1]) return '';
        return $path;
    }
}
