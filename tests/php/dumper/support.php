<?php
/**
 * Shared fixtures and helpers for the P2 dumper tests (not a *Test.php file, so the harness does not run it).
 * Everything here must parse on PHP 7.4: PHP 8.1+ fixtures (enums, readonly) are declared through eval().
 */

namespace TinkerboxTests\Dumper {
    class ParentWithPrivate
    {
        private $secret = 'parent-secret';
        protected $prot = 'protected';
        public $pub = 'public';
    }

    class ChildWithPrivate extends ParentWithPrivate
    {
        private $secret = 'child-secret';
        public $own = 1;
    }

    class Typed
    {
        public $untyped;
        public int $initialized = 1;
        public int $uninitialized;
        public ?string $nullable = null;
    }

    #[\AllowDynamicProperties]
    class Dynamic
    {
        public $declared = 'd';
    }

    class WithDebugInfo
    {
        private $password = 'hunter2';
        public $name = 'visible';

        public function __debugInfo()
        {
            return ['name' => $this->name, 'masked' => '***', "\0*\0kind" => 'debug'];
        }
    }

    class ThrowingDebugInfo
    {
        public $real = 'real';

        public function __debugInfo()
        {
            throw new \RuntimeException('debugInfo failed');
        }
    }

    class MagicTrap
    {
        public static $calls = 0;
        public $real = 1;

        public function __get($name)
        {
            self::$calls++;
            return 'magic';
        }

        public function __isset($name)
        {
            self::$calls++;
            return true;
        }

        public function __call($name, $arguments)
        {
            self::$calls++;
            return null;
        }

        public static function __callStatic($name, $arguments)
        {
            self::$calls++;
            return null;
        }
    }

    class StringableThing
    {
        public $inner = 'x';

        public function __toString()
        {
            return 'I am stringable';
        }
    }

    class ThrowingToString
    {
        public $value = 1;

        public function __toString()
        {
            throw new \RuntimeException('cannot stringify');
        }
    }

    class WithStatic
    {
        public static $shared = 'static';
        public $instance = 'instance';
    }

    class Linked
    {
        public $name;
        public $next;
        public $children = [];

        public function __construct($name)
        {
            $this->name = $name;
        }
    }

    class TrackingAggregate implements \IteratorAggregate
    {
        public static $iterated = false;
        public $items = [1, 2, 3];

        public function getIterator(): \Iterator
        {
            self::$iterated = true;
            return new \ArrayIterator($this->items);
        }
    }

    class CustomException extends \RuntimeException
    {
        public $context = ['user' => 5];
        private $hidden = 'h';
    }

    class Methods
    {
        public function greet(string $name, int $times = 1): string
        {
            return str_repeat($name, $times);
        }

        public static function make(): self
        {
            return new self();
        }
    }
}

namespace {
    if (!function_exists('p2_dumper_load')) {
        /** Load the P2 sources (the rest of the runner is not needed and may be mid-flight). */
        function p2_dumper_load()
        {
            static $loaded = false;
            if ($loaded) return;
            $loaded = true;
            $src = dirname(__DIR__, 3) . '/resources/php/src';
            require_once $src . '/Dumper.php';
            require_once $src . '/ExceptionFormatter.php';
            if (PHP_VERSION_ID >= 80100 && !enum_exists('TinkerboxTestStatus', false)) {
                eval('enum TinkerboxTestStatus: string { case Active = "active"; case Inactive = "inactive"; }');
                eval('enum TinkerboxTestSuit { case Hearts; case Spades; }');
                eval('enum TinkerboxTestLevel: int { case Low = 1; case High = 10; }');
                eval('final class TinkerboxTestReadonly { public function __construct(public readonly int $id, private readonly string $secret, public readonly ?int $late = null) {} }');
            }
        }

        /**
         * eval() $code like the runner does and return [Throwable|null, evalFile]. The eval statement is on
         * the same line as __LINE__ so the computed file name is exactly the one PHP reports.
         */
        function p2_eval_catch($code)
        {
            $evalFile = __FILE__ . '(' . __LINE__ . ") : eval()'d code"; try { eval($code); } catch (\Throwable $e) { return [$e, $evalFile]; }
            return [null, $evalFile];
        }

        /** Dump with explicit limits (defaults like the app). */
        function p2_dump($value, array $limits = [])
        {
            p2_dumper_load();
            return \Tinkerbox\Dumper::dump($value, $limits + ['maxDepth' => 8, 'maxItems' => 500, 'maxStringLength' => 10000]);
        }

        /** Find a property node by name (and optionally visibility / declaring class). */
        function p2_prop(array $node, $name, $vis = null, $declaringClass = false)
        {
            foreach (isset($node['props']) ? $node['props'] : [] as $prop) {
                if ($prop['name'] !== $name) continue;
                if ($vis !== null && $prop['vis'] !== $vis) continue;
                if ($declaringClass !== false && (isset($prop['declaringClass']) ? $prop['declaringClass'] : null) !== $declaringClass) continue;
                return $prop;
            }
            throw new AssertionFailed('Property ' . $name . ' not found in ' . json_encode($node));
        }

        function p2_has_prop(array $node, $name)
        {
            foreach (isset($node['props']) ? $node['props'] : [] as $prop) {
                if ($prop['name'] === $name) return true;
            }
            return false;
        }

        /** Count nodes in a DumpNode tree. */
        function p2_count_nodes(array $node)
        {
            $count = 1;
            foreach (isset($node['items']) ? $node['items'] : [] as $item) $count += p2_count_nodes($item['v']);
            foreach (isset($node['props']) ? $node['props'] : [] as $prop) $count += p2_count_nodes($prop['v']);
            return $count;
        }

        function p2_php_binary_for($minVersionId)
        {
            if (PHP_VERSION_ID >= $minVersionId) return PHP_BINARY;
            $herd = getenv('HOME') . '/Library/Application Support/Herd/bin/';
            foreach (['php84', 'php83', 'php82', 'php85', 'php'] as $candidate) {
                if (!is_file($herd . $candidate)) continue;
                $out = shell_exec(escapeshellarg($herd . $candidate) . ' -d xdebug.mode=off -r "echo PHP_VERSION_ID;"');
                if ((int) $out >= $minVersionId) return $herd . $candidate;
            }
            $out = shell_exec('php -d xdebug.mode=off -r "echo PHP_VERSION_ID;" 2>/dev/null');
            return (int) $out >= $minVersionId ? 'php' : null;
        }

        /**
         * Run a script through `php` via STDIN — exactly how the app runs the bundle, so runner code has the
         * file name "Standard input code". The script is the P2 sources followed by $code (braced namespace
         * blocks). The script must print `__TWJSON__` + json; the decoded value is returned.
         */
        function p2_stdin_run($code, $php = null, $cwd = null)
        {
            $src = dirname(__DIR__, 3) . '/resources/php/src';
            $script = "<?php\n";
            foreach (['Dumper.php', 'ExceptionFormatter.php'] as $file) {
                $script .= preg_replace('/^<\?php\s*/', '', file_get_contents($src . '/' . $file), 1) . "\n";
            }
            $script .= $code . "\n";
            return p2_pipe_php($script, $php ?: PHP_BINARY, $cwd);
        }

        function p2_pipe_php($script, $php, $cwd = null, $timeout = 120)
        {
            $proc = proc_open([$php, '-d', 'xdebug.mode=off', '-d', 'display_errors=stderr', '-d', 'memory_limit=512M'], [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, $cwd ?: sys_get_temp_dir());
            if (!is_resource($proc)) throw new AssertionFailed('Could not start ' . $php);
            fwrite($pipes[0], $script);
            fclose($pipes[0]);
            $stdout = stream_get_contents($pipes[1]);
            $stderr = stream_get_contents($pipes[2]);
            fclose($pipes[1]);
            fclose($pipes[2]);
            $exit = proc_close($proc);
            $pos = strrpos($stdout, '__TWJSON__');
            if ($pos === false) {
                throw new AssertionFailed("Subprocess produced no result (exit $exit).\nSTDOUT:\n" . substr($stdout, -4000) . "\nSTDERR:\n" . substr($stderr, -4000));
            }
            $data = json_decode(substr($stdout, $pos + 10), true);
            if (!is_array($data)) throw new AssertionFailed("Invalid JSON from subprocess:\n" . substr($stdout, $pos, 2000));
            $data['__stderr'] = $stderr;
            return $data;
        }

        /** A read-only Laravel project with vendor/ (override with TINKERBOX_TEST_LARAVEL=/path). */
        function p2_laravel_project()
        {
            $candidates = [];
            if (getenv('TINKERBOX_TEST_LARAVEL')) $candidates[] = getenv('TINKERBOX_TEST_LARAVEL');
            foreach ($candidates as $path) {
                if (is_file($path . '/vendor/autoload.php') && is_file($path . '/bootstrap/app.php') && is_file($path . '/artisan')
                    && is_dir($path . '/vendor/laravel/framework')) {
                    return $path;
                }
            }
            return null;
        }

        /** Minimum PHP_VERSION_ID of the installed vendor/ (platform check), else composer.json ("^8.2" → 80200). */
        function p2_project_min_php($path)
        {
            $check = (string) @file_get_contents($path . '/vendor/composer/platform_check.php');
            if (preg_match('/PHP_VERSION_ID >= (\d+)/', $check, $m)) return (int) $m[1];
            $composer = json_decode((string) @file_get_contents($path . '/composer.json'), true);
            $constraint = isset($composer['require']['php']) ? $composer['require']['php'] : '';
            if (preg_match('/(\d+)\.(\d+)/', $constraint, $m)) return (int) $m[1] * 10000 + (int) $m[2] * 100;
            return 80100;
        }

        function p2_rmdir($dir)
        {
            if (!is_dir($dir)) return;
            $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
            foreach ($it as $file) $file->isDir() ? rmdir($file->getPathname()) : unlink($file->getPathname());
            rmdir($dir);
        }

        /**
         * Bootstrap a real Laravel app in a subprocess (read-only: every cache, compiled view, log, session,
         * mail and database setting is redirected to a temp dir / in-memory driver), load the P2 sources and
         * run $code, which fills `$results` (array) using `$dump($value)` / `$preview($value)`.
         *
         * @return array|null results, or null when no Laravel project / compatible PHP is available
         */
        function p2_laravel_run($code)
        {
            $project = p2_laravel_project();
            if ($project === null) return null;
            $php = p2_php_binary_for(p2_project_min_php($project));
            if ($php === null) return null;

            $tmp = sys_get_temp_dir() . '/tinkerbox-dumper-' . bin2hex(random_bytes(6));
            foreach (['views', 'compiled', 'storage/framework/cache/data', 'storage/framework/views', 'storage/framework/sessions', 'storage/logs', 'storage/app/public'] as $dir) {
                mkdir($tmp . '/' . $dir, 0777, true);
            }
            $env = [
                'APP_ENV' => 'testing', 'APP_DEBUG' => 'true', 'LARAVEL_STORAGE_PATH' => $tmp . '/storage',
                'APP_SERVICES_CACHE' => $tmp . '/services.php', 'APP_PACKAGES_CACHE' => $tmp . '/packages.php',
                'APP_CONFIG_CACHE' => $tmp . '/config.php', 'APP_ROUTES_CACHE' => $tmp . '/routes.php',
                'APP_EVENTS_CACHE' => $tmp . '/events.php', 'VIEW_COMPILED_PATH' => $tmp . '/compiled',
                'DB_CONNECTION' => 'sqlite', 'DB_DATABASE' => ':memory:', 'DB_URL' => '', 'DATABASE_URL' => '',
                'LOG_CHANNEL' => 'null', 'LOG_STACK' => 'stderr', 'LOG_DEPRECATIONS_CHANNEL' => 'null',
                'CACHE_STORE' => 'array', 'CACHE_DRIVER' => 'array', 'SESSION_DRIVER' => 'array',
                'QUEUE_CONNECTION' => 'sync', 'MAIL_MAILER' => 'array', 'MAIL_DRIVER' => 'array',
                'BROADCAST_CONNECTION' => 'null', 'BROADCAST_DRIVER' => 'null',
                'TELESCOPE_ENABLED' => 'false', 'DEBUGBAR_ENABLED' => 'false', 'PULSE_ENABLED' => 'false', 'NIGHTWATCH_ENABLED' => 'false',
            ];
            $src = dirname(__DIR__, 3) . '/resources/php/src';
            $script = '<?php' . "\n"
                . 'error_reporting(E_ALL);' . "\n"
                . '$__env = ' . var_export($env, true) . ';' . "\n"
                . 'foreach ($__env as $k => $v) { putenv($k . "=" . $v); $_ENV[$k] = $v; $_SERVER[$k] = $v; }' . "\n"
                . '$tmp = ' . var_export($tmp, true) . ';' . "\n"
                . 'require ' . var_export($project . '/vendor/autoload.php', true) . ';' . "\n"
                . '$app = require ' . var_export($project . '/bootstrap/app.php', true) . ';' . "\n"
                // Every storage_path() write (real-time facades, file cache, logs, sessions) lands in the temp dir.
                . '$app->useStoragePath($tmp . "/storage");' . "\n"
                . '$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();' . "\n"
                . 'require ' . var_export($src . '/Dumper.php', true) . ';' . "\n"
                . 'require ' . var_export($src . '/ExceptionFormatter.php', true) . ';' . "\n"
                . '$limits = ["maxDepth" => 8, "maxItems" => 500, "maxStringLength" => 10000];' . "\n"
                . '$dump = function ($value, array $l = []) use ($limits) { return \Tinkerbox\Dumper::dump($value, $l + $limits); };' . "\n"
                . '$preview = function ($value, $max = 120) { return \Tinkerbox\Dumper::preview($value, $max); };' . "\n"
                . '$results = ["laravel" => $app->version(), "php" => PHP_VERSION, "project" => ' . var_export(basename($project), true) . '];' . "\n"
                . $code . "\n"
                . 'echo "\n__TWJSON__" . json_encode($results, JSON_PARTIAL_OUTPUT_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE | JSON_UNESCAPED_SLASHES);' . "\n";
            try {
                // cwd = temp dir so nothing relative can land in the project.
                return p2_pipe_php($script, $php, $tmp);
            } finally {
                p2_rmdir($tmp);
            }
        }
    }
}
