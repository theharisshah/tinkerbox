<?php
/**
 * Shared helpers for the P3 driver tests (tests/php/drivers/*Test.php). Everything is prefixed with `p3_` because
 * all modules' test files run in one harness process.
 *
 * Detection runs in-process (canBootstrap() only looks at files). Anything that bootstraps a project runs in a
 * separate PHP process (t_run_bundle() or p3_php_script()) so fixture frameworks never leak into the harness.
 */

t_load_runner_sources();

if (!function_exists('p3_fixture')) {
    /** Absolute path of a fixture project in tests/fixtures/projects (realpath). */
    function p3_fixture(string $name = ''): string
    {
        $root = realpath(dirname(__DIR__, 2) . '/fixtures/projects');

        return $name === '' ? $root : $root . '/' . $name;
    }

    /** Absolute path below tests/php/drivers/fixtures. */
    function p3_local_fixture(string $path = ''): string
    {
        return __DIR__ . '/fixtures' . ($path !== '' ? '/' . ltrim($path, '/') : '');
    }

    /** Unique temporary directory (realpath, removed when the harness exits). */
    function p3_tmpdir(string $prefix = 'p3'): string
    {
        static $dirs = null;
        if ($dirs === null) {
            $dirs = [];
            register_shutdown_function(function () use (&$dirs) {
                foreach ($dirs as $dir) {
                    p3_rmrf($dir);
                }
            });
        }
        $dir = realpath(sys_get_temp_dir()) . '/tinkerbox-' . $prefix . '-' . bin2hex(random_bytes(5));
        mkdir($dir, 0777, true);
        $dirs[] = $dir;

        return $dir;
    }

    function p3_rmrf(string $path): void
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
                p3_rmrf($path . '/' . $name);
            }
        }
        rmdir($path);
    }

    /** Write files below a directory: ['relative/path' => 'contents']. */
    function p3_write_tree(string $dir, array $files): string
    {
        foreach ($files as $path => $contents) {
            $target = $dir . '/' . $path;
            if (!is_dir(dirname($target))) {
                mkdir(dirname($target), 0777, true);
            }
            file_put_contents($target, $contents);
        }

        return $dir;
    }

    /** Recursive copy (fixture → temp dir for tests that need a modified project). */
    function p3_copy_tree(string $source, string $target): string
    {
        if (!is_dir($target)) {
            mkdir($target, 0777, true);
        }
        $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($source, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::SELF_FIRST);
        foreach ($it as $file) {
            $dest = $target . '/' . substr($file->getPathname(), strlen($source) + 1);
            if ($file->isDir()) {
                if (!is_dir($dest)) {
                    mkdir($dest, 0777, true);
                }
            } else {
                copy($file->getPathname(), $dest);
            }
        }

        return $target;
    }

    /**
     * An empty home folder: detection must never pick up the developer's real ~/.config/tinkerbox/drivers, so
     * every test passes an explicit homePath.
     */
    function p3_empty_home(): string
    {
        static $home = null;
        if ($home === null) {
            $home = p3_tmpdir('home');
        }

        return $home;
    }

    /** Detect a fixture's driver in-process (never bootstraps). */
    function p3_detect(string $projectPath, string $forced = '', ?string $home = null): \Tinkerbox\Drivers\Driver
    {
        return \Tinkerbox\DriverRegistry::detect($projectPath, $forced, $home === null ? p3_empty_home() : $home);
    }

    /** Fixture folder => expected DriverInfo.id of every fixture project (incl. negative cases). */
    function p3_expected_fixture_ids(): array
    {
        return [
            'acme-shop' => 'acme-shop',
            'bedrock' => 'bedrock',
            'cakephp' => 'cakephp',
            'codeigniter4' => 'codeigniter4',
            'composer' => 'composer',
            'craft' => 'craft',
            'drupal' => 'drupal',
            'drupal7' => 'drupal7',
            'joomla' => 'joomla',
            'kirby' => 'kirby',
            'kirby-composer' => 'kirby',
            'laravel' => 'laravel',
            'laravel-zero' => 'laravel-zero',
            'lumen' => 'lumen',
            'magento2' => 'magento2',
            'moodle' => 'moodle',
            'not-kirby' => 'none',
            'not-laravel' => 'none',
            'not-laravel-zero' => 'none',
            'not-symfony' => 'none',
            'not-testbench' => 'none',
            'not-wordpress' => 'none',
            'not-yii' => 'none',
            'october' => 'october',
            'plain' => 'none',
            'prestashop' => 'prestashop',
            'radicle' => 'radicle',
            'shopware' => 'shopware',
            'shopware5' => 'shopware',
            'statamic' => 'statamic',
            'symfony' => 'symfony',
            'testbench' => 'testbench',
            'typo3' => 'typo3',
            'typo3-classic' => 'typo3',
            'wordpress' => 'wordpress',
            'yii2' => 'yii2',
        ];
    }

    /** Herd PHP binaries by alias (php74, php85, …) that exist on this machine. */
    function p3_php_binaries(array $aliases = ['php74', 'php85']): array
    {
        $herd = getenv('HOME') . '/Library/Application Support/Herd/bin';
        $out = [];
        foreach ($aliases as $alias) {
            $candidate = $herd . '/' . $alias;
            if (is_file($candidate) && is_executable($candidate)) {
                $out[$alias] = $candidate;
            }
        }

        return $out;
    }

    /** Skip notice (the harness has no skip state; the test passes and says why on stderr). */
    function p3_skip(string $why): void
    {
        fwrite(STDERR, "    \033[33m↷ skipped: " . $why . "\033[0m\n");
    }

    /**
     * Run a PHP script in a separate process with the runner sources loaded first and return its result decoded
     * from JSON. By default $code is a function body whose `return` value is the result; with $raw the code is a
     * sequence of braced namespace blocks that stores the result in $GLOBALS['__result'].
     */
    function p3_php_script(string $code, ?string $php = null, ?string $cwd = null, bool $raw = false)
    {
        $root = dirname(__DIR__, 3) . '/resources/php';
        $prelude = "namespace {\nerror_reporting(E_ALL);\nini_set('display_errors', 'stderr');\n"
            . '$__m = json_decode(file_get_contents(' . var_export($root . '/manifest.json', true) . '), true);'
            . 'foreach ($__m["files"] as $__f) { require_once ' . var_export($root, true) . " . '/' . \$__f; }\n}\n";
        $body = $raw ? $code : "namespace {\n\$GLOBALS['__result'] = (function () {\n" . $code . "\n})();\n}";
        $script = "<?php\n" . $prelude . $body . "\nnamespace {\n"
            . 'echo "\n@@P3_BEGIN\n" . json_encode($GLOBALS[\'__result\'], JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR) . "\n@@P3_END\n";' . "\n}\n";
        $file = p3_tmpdir('script') . '/script.php';
        file_put_contents($file, $script);
        $proc = proc_open([$php ?: PHP_BINARY, '-d', 'xdebug.mode=off', '-d', 'pcre.jit=0', $file], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, $cwd ?: sys_get_temp_dir());
        fclose($pipes[0]);
        $stdout = stream_get_contents($pipes[1]);
        $stderr = stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        $exit = proc_close($proc);
        $begin = strpos($stdout, '@@P3_BEGIN');
        $end = strpos($stdout, '@@P3_END');
        if ($begin === false || $end === false) {
            throw new AssertionFailed("Script produced no result (exit $exit).\nSTDOUT:\n" . $stdout . "\nSTDERR:\n" . $stderr);
        }

        return json_decode(trim(substr($stdout, $begin + 10, $end - $begin - 10)), true);
    }

    /** Warnings DriverRegistry collected since the given count (the list is process-wide). */
    function p3_new_warnings(int $since): array
    {
        return array_values(array_slice(\Tinkerbox\DriverRegistry::warnings(), $since));
    }

    /** t_run_bundle() with an empty home folder (no global custom drivers) and an optional PHP binary. */
    function p3_bundle(array $payload, ?string $php = null): array
    {
        $payload += ['homePath' => p3_empty_home()];

        return t_run_bundle($payload, null, $php);
    }

    /** Returned value of a run envelope as plain PHP data (strings / ints / bools / arrays) for assertions. */
    function p3_value(array $node)
    {
        switch ($node['t']) {
            case 'null':
                return null;
            case 'bool':
                return $node['v'];
            case 'int':
                return (int) $node['v'];
            case 'float':
                return (float) $node['v'];
            case 'string':
                return $node['v'];
            case 'array':
                $out = [];
                foreach ($node['items'] as $item) {
                    $out[$item['k']] = p3_value($item['v']);
                }

                return $out;
        }

        return $node;
    }

    /** Run user code and return its plain return value (fails with the envelope on exceptions). */
    function p3_run_value(array $payload, ?string $php = null)
    {
        $envelope = p3_bundle($payload + ['mode' => 'run'], $php);
        t_assert($envelope['exception'] === null, 'Unexpected exception: ' . json_encode($envelope['exception']) . "\nSTDERR: " . $envelope['__stderr']);
        t_assert($envelope['hasReturnValue'] === true, 'No return value: ' . json_encode($envelope));

        return p3_value($envelope['returnValue']);
    }

    /** Rows of an AppPanel section as key => value. */
    function p3_panel_rows(array $panel, string $section): ?array
    {
        foreach ($panel['sections'] as $s) {
            if ($s['title'] === $section) {
                $rows = [];
                foreach ($s['rows'] as $row) {
                    $rows[$row['key']] = $row['value'];
                }

                return $rows;
            }
        }

        return null;
    }
}

if (!function_exists('p3_set')) {
    /** Set a (private) property of a driver, declared by its class or one of its parents. */
    function p3_set($object, string $property, $value): void
    {
        p3_property($object, $property)->setValue($object, $value);
    }

    /** Read a (private) property of a driver. */
    function p3_get($object, string $property)
    {
        return p3_property($object, $property)->getValue($object);
    }

    function p3_property($object, string $property): ReflectionProperty
    {
        for ($class = new ReflectionClass($object); $class !== false; $class = $class->getParentClass()) {
            if ($class->hasProperty($property)) {
                $reflection = $class->getProperty($property);
                if (PHP_VERSION_ID < 80100) {
                    $reflection->setAccessible(true);
                }

                return $reflection;
            }
        }
        throw new AssertionFailed('No property ' . get_class($object) . '::$' . $property);
    }
}
