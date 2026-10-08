<?php

namespace Tinkerbox\Drivers {
    /**
     * Stateless helpers shared by the built-in drivers (docs/ARCHITECTURE.md §1.7): project paths, Composer metadata,
     * bounded file scans, environment loading and query-capture adapters. Kept outside the Driver hierarchy so that
     * custom drivers extending a built-in never collide with helper method names.
     */
    final class Support
    {
        /** Max files returned by projectFiles(). */
        const FILES_LIMIT = 2000;

        /** Max directory entries visited by one projectFiles() scan (protects against huge trees). */
        const SCAN_ENTRY_LIMIT = 50000;

        /** @var array<string, mixed> autoload file => value returned by vendor/autoload.php (the ClassLoader) */
        private static $autoloaders = [];

        /** @var array<string, array> project path => decoded composer.json */
        private static $composerJson = [];

        /** @var array<string, array> project path => packages from vendor/composer/installed.json */
        private static $installed = [];

        /**
         * Normalize a project path: no trailing separator (except for a filesystem root).
         *
         * @param string $path
         * @return string
         */
        public static function path($path)
        {
            $path = (string) $path;
            if ($path === '') {
                return '';
            }
            $trimmed = rtrim($path, '/\\');
            if ($trimmed === '') {
                return DIRECTORY_SEPARATOR;
            }
            if (preg_match('/^[A-Za-z]:$/', $trimmed)) {
                return $trimmed . DIRECTORY_SEPARATOR;
            }

            return $trimmed;
        }

        /**
         * @param string $path
         * @return bool
         */
        public static function isAbsolute($path)
        {
            $path = (string) $path;

            return $path !== '' && ($path[0] === '/' || $path[0] === '\\' || preg_match('/^[A-Za-z]:[\/\\\\]/', $path) === 1);
        }

        /**
         * Decoded composer.json of a project ([] when missing or invalid).
         *
         * @param string $projectPath
         * @return array
         */
        public static function composerJson($projectPath)
        {
            $projectPath = self::path($projectPath);
            if (!array_key_exists($projectPath, self::$composerJson)) {
                $data = [];
                $file = $projectPath . '/composer.json';
                if ($projectPath !== '' && is_file($file) && is_readable($file)) {
                    $decoded = json_decode((string) file_get_contents($file), true);
                    $data = is_array($decoded) ? $decoded : [];
                }
                self::$composerJson[$projectPath] = $data;
            }

            return self::$composerJson[$projectPath];
        }

        /**
         * Whether composer.json requires a package (require or require-dev).
         *
         * @param string $projectPath
         * @param string $package
         * @return bool
         */
        public static function composerRequires($projectPath, $package)
        {
            $composer = self::composerJson($projectPath);
            foreach (['require', 'require-dev'] as $section) {
                if (isset($composer[$section]) && is_array($composer[$section]) && array_key_exists($package, $composer[$section])) {
                    return true;
                }
            }

            return false;
        }

        /**
         * Absolute vendor directory (honors composer.json config.vendor-dir).
         *
         * @param string $projectPath
         * @return string
         */
        public static function vendorDir($projectPath)
        {
            $projectPath = self::path($projectPath);
            $dir = 'vendor';
            $composer = self::composerJson($projectPath);
            if (isset($composer['config']['vendor-dir']) && is_string($composer['config']['vendor-dir']) && $composer['config']['vendor-dir'] !== '') {
                $dir = $composer['config']['vendor-dir'];
            }
            if (self::isAbsolute($dir)) {
                return self::path($dir);
            }

            return $projectPath . '/' . trim($dir, '/\\');
        }

        /**
         * Require the project's Composer autoloader and return the ClassLoader.
         *
         * @param string $projectPath
         * @param bool $required throw when vendor/autoload.php is missing
         * @return mixed the ClassLoader (or null when optional and missing)
         */
        public static function requireAutoload($projectPath, $required = true)
        {
            $file = self::vendorDir($projectPath) . '/autoload.php';
            if (array_key_exists($file, self::$autoloaders)) {
                return self::$autoloaders[$file];
            }
            if (!is_file($file)) {
                if ($required) {
                    throw new \RuntimeException('Composer dependencies are not installed: ' . $file . ' is missing. Run `composer install` in ' . self::path($projectPath) . '.');
                }

                return null;
            }
            // `require` (not require_once): vendor/autoload.php returns the cached ClassLoader on every include.
            self::$autoloaders[$file] = require $file;

            return self::$autoloaders[$file];
        }

        /**
         * Throw a readable bootstrap error instead of PHP's uncatchable "Failed opening required" fatal error when a
         * framework file a driver is about to require does not exist (incomplete checkout, missing vendor/).
         *
         * @param string $file
         * @param string $what e.g. "Drupal"
         * @return void
         */
        public static function assertFile($file, $what)
        {
            if (!is_file($file)) {
                throw new \RuntimeException($what . ' could not be booted: ' . $file . ' is missing.');
            }
        }

        /**
         * Installed version of a Composer package ("12.20.0", "dev-main"), or null.
         *
         * @param string $projectPath
         * @param string $package
         * @return string|null
         */
        public static function packageVersion($projectPath, $package)
        {
            $version = null;
            try {
                if (class_exists('Composer\InstalledVersions') && \Composer\InstalledVersions::isInstalled($package)) {
                    $version = \Composer\InstalledVersions::getPrettyVersion($package);
                }
            } catch (\Throwable $e) {
                // Composer 1 / incomplete runtime data: fall back to vendor/composer/installed.json below.
                $version = null;
            }
            if ($version === null && (string) $projectPath !== '') {
                foreach (self::installedPackages($projectPath) as $info) {
                    if (is_array($info) && isset($info['name']) && is_string($info['name']) && strcasecmp($info['name'], $package) === 0) {
                        $version = isset($info['version']) && is_string($info['version']) ? $info['version'] : null;
                        break;
                    }
                }
            }
            if ($version === null || $version === '') {
                return null;
            }

            return preg_match('/^v\d/', $version) ? substr($version, 1) : $version;
        }

        /**
         * @param string $projectPath
         * @return array
         */
        private static function installedPackages($projectPath)
        {
            $projectPath = self::path($projectPath);
            if (!array_key_exists($projectPath, self::$installed)) {
                $packages = [];
                $file = self::vendorDir($projectPath) . '/composer/installed.json';
                if (is_file($file) && is_readable($file)) {
                    $decoded = json_decode((string) file_get_contents($file), true);
                    if (is_array($decoded)) {
                        // Composer 2: {"packages": [...]}; Composer 1: [...]
                        $packages = isset($decoded['packages']) && is_array($decoded['packages']) ? $decoded['packages'] : $decoded;
                    }
                }
                self::$installed[$projectPath] = $packages;
            }

            return self::$installed[$projectPath];
        }

        /**
         * Footer label: "Statamic", "5.12.0", "Laravel 11.37.0" => "Statamic 5.12.0 (Laravel 11.37.0)". Empty parts
         * are left out.
         *
         * @param string $name
         * @param string|null $version
         * @param string|null $detail
         * @return string
         */
        public static function label($name, $version = null, $detail = null)
        {
            $label = trim($name . ($version !== null && $version !== '' ? ' ' . $version : ''));

            return $detail !== null && $detail !== '' ? $label . ' (' . $detail . ')' : $label;
        }

        /**
         * Bounded breadth-first list of a project's PHP files (relative paths with "/" separators). vendor/,
         * node_modules/, hidden folders and symlinked folders are always skipped.
         *
         * @param string $root
         * @param string[] $exclude further relative folders to skip ("storage", "wp-content/uploads", …)
         * @param int $limit
         * @return string[]
         */
        public static function projectFiles($root, array $exclude = [], $limit = self::FILES_LIMIT)
        {
            $root = self::path($root);
            if ($root === '' || !is_dir($root)) {
                return [];
            }
            $skip = [];
            foreach ($exclude as $dir) {
                $dir = trim(str_replace('\\', '/', (string) $dir), '/');
                if ($dir !== '') {
                    $skip[$dir] = true;
                }
            }
            $files = [];
            $queue = [''];
            $visited = 0;
            for ($index = 0; $index < count($queue); $index++) {
                $relative = $queue[$index];
                $absolute = $relative === '' ? $root : $root . '/' . $relative;
                // Unreadable directories (permissions) are skipped; the scan is best effort by design.
                $entries = @scandir($absolute);
                if ($entries === false) {
                    continue;
                }
                foreach ($entries as $entry) {
                    if ($entry === '.' || $entry === '..') {
                        continue;
                    }
                    if (++$visited > self::SCAN_ENTRY_LIMIT) {
                        break 2;
                    }
                    $childRelative = $relative === '' ? $entry : $relative . '/' . $entry;
                    $childAbsolute = $absolute . '/' . $entry;
                    if (is_dir($childAbsolute)) {
                        if ($entry[0] === '.' || isset($skip[$childRelative]) || $entry === 'vendor' || $entry === 'node_modules' || is_link($childAbsolute)) {
                            continue;
                        }
                        $queue[] = $childRelative;
                    } elseif (substr($entry, -4) === '.php') {
                        $files[] = $childRelative;
                        if (count($files) >= $limit) {
                            break 2;
                        }
                    }
                }
            }

            return $files;
        }

        /**
         * Recursively list PHP files below a directory (absolute paths), bounded.
         *
         * @param string $dir
         * @param int $limit
         * @return string[]
         */
        public static function phpFilesIn($dir, $limit = self::FILES_LIMIT)
        {
            $dir = self::path($dir);
            $out = [];
            foreach (self::projectFiles($dir, [], $limit) as $relative) {
                $out[] = $dir . '/' . $relative;
            }

            return $out;
        }

        /**
         * Fully qualified names of the classes / interfaces / traits / enums a PHP file declares (tokenizer based,
         * the file is never included).
         *
         * @param string $file
         * @param int $maxBytes
         * @return string[]
         */
        public static function declaredClassesInFile($file, $maxBytes = 2097152)
        {
            if (!is_file($file) || !is_readable($file) || filesize($file) > $maxBytes) {
                return [];
            }
            $code = file_get_contents($file);
            if (!is_string($code) || $code === '') {
                return [];
            }

            return self::declaredClassesInCode($code);
        }

        /**
         * @param string $code
         * @return string[]
         */
        public static function declaredClassesInCode($code)
        {
            $tokens = token_get_all($code);
            $count = count($tokens);
            $nameTokens = [T_STRING, T_NS_SEPARATOR];
            foreach (['T_NAME_QUALIFIED', 'T_NAME_FULLY_QUALIFIED'] as $constant) {
                if (defined($constant)) {
                    $nameTokens[] = constant($constant);
                }
            }
            $declarationTokens = [T_CLASS, T_INTERFACE, T_TRAIT];
            if (defined('T_ENUM')) {
                $declarationTokens[] = constant('T_ENUM');
            }
            $ignorable = [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT];
            $namespace = '';
            $classes = [];
            for ($i = 0; $i < $count; $i++) {
                $token = $tokens[$i];
                if (!is_array($token)) {
                    continue;
                }
                if ($token[0] === T_NAMESPACE) {
                    $name = '';
                    $first = true;
                    for ($j = $i + 1; $j < $count; $j++) {
                        $next = $tokens[$j];
                        if (is_array($next) && in_array($next[0], $ignorable, true)) {
                            continue;
                        }
                        if ($first && is_array($next) && $next[0] === T_NS_SEPARATOR) {
                            // `namespace\Foo` is a relative name inside an expression, not a declaration.
                            $name = null;
                            break;
                        }
                        $first = false;
                        if (is_array($next) && in_array($next[0], $nameTokens, true)) {
                            $name .= $next[1];
                            continue;
                        }
                        break;
                    }
                    if ($name !== null) {
                        $namespace = trim($name, '\\');
                        $i = $j;
                    }
                    continue;
                }
                if (!in_array($token[0], $declarationTokens, true)) {
                    continue;
                }
                $previous = null;
                for ($j = $i - 1; $j >= 0; $j--) {
                    if (is_array($tokens[$j]) && in_array($tokens[$j][0], $ignorable, true)) {
                        continue;
                    }
                    $previous = $tokens[$j];
                    break;
                }
                if (is_array($previous) && ($previous[0] === T_DOUBLE_COLON || $previous[0] === T_NEW)) {
                    continue; // Foo::class / new class { }
                }
                for ($j = $i + 1; $j < $count; $j++) {
                    if (is_array($tokens[$j]) && in_array($tokens[$j][0], $ignorable, true)) {
                        continue;
                    }
                    if (is_array($tokens[$j]) && $tokens[$j][0] === T_STRING) {
                        $classes[] = $namespace === '' ? $tokens[$j][1] : $namespace . '\\' . $tokens[$j][1];
                    }
                    break;
                }
            }

            return array_values(array_unique($classes));
        }

        /**
         * Fully qualified names of the functions a PHP file declares unconditionally (top level of the file or of
         * a namespace block, tokenizer based, the file is never included). Functions declared inside `if`
         * blocks (`if (!function_exists('x')) { function x() {} }`), classes or other functions are skipped:
         * only unconditional declarations are bound when the file is compiled.
         *
         * @param string $file
         * @param int $maxBytes
         * @return string[]
         */
        public static function declaredFunctionsInFile($file, $maxBytes = 2097152)
        {
            if (!is_file($file) || !is_readable($file) || filesize($file) > $maxBytes) {
                return [];
            }
            $code = file_get_contents($file);
            if (!is_string($code) || $code === '') {
                return [];
            }

            return self::declaredFunctionsInCode($code);
        }

        /**
         * @param string $code
         * @return string[]
         */
        public static function declaredFunctionsInCode($code)
        {
            $tokens = token_get_all($code);
            $count = count($tokens);
            $ignorable = [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT];
            $nameTokens = [T_STRING, T_NS_SEPARATOR];
            foreach (['T_NAME_QUALIFIED', 'T_NAME_FULLY_QUALIFIED'] as $constant) {
                if (defined($constant)) {
                    $nameTokens[] = constant($constant);
                }
            }
            $significant = function ($from, $step) use ($tokens, $count, $ignorable) {
                for ($j = $from; $j >= 0 && $j < $count; $j += $step) {
                    if (!is_array($tokens[$j]) || !in_array($tokens[$j][0], $ignorable, true)) {
                        return $j;
                    }
                }
                return -1;
            };
            $namespace = '';
            $depth = 0;
            // Brace depth of the current `namespace X { }` block (its body counts as the top level).
            $namespaceDepth = null;
            $functions = [];
            for ($i = 0; $i < $count; $i++) {
                $token = $tokens[$i];
                if (!is_array($token)) {
                    if ($token === '{') {
                        $depth++;
                    } elseif ($token === '}') {
                        $depth--;
                        if ($namespaceDepth !== null && $depth < $namespaceDepth) {
                            $namespaceDepth = null;
                            $namespace = '';
                        }
                    }
                    continue;
                }
                if ($token[0] === T_CURLY_OPEN || $token[0] === T_DOLLAR_OPEN_CURLY_BRACES) {
                    $depth++;
                    continue;
                }
                if ($token[0] === T_NAMESPACE && $depth === 0) {
                    $next = $significant($i + 1, 1);
                    if ($next >= 0 && is_array($tokens[$next]) && $tokens[$next][0] === T_NS_SEPARATOR) {
                        continue; // namespace\foo() is an expression
                    }
                    $name = '';
                    for ($j = $next; $j >= 0 && $j < $count; $j = $significant($j + 1, 1)) {
                        if (!is_array($tokens[$j]) || !in_array($tokens[$j][0], $nameTokens, true)) {
                            break;
                        }
                        $name .= $tokens[$j][1];
                    }
                    $namespace = trim($name, '\\');
                    if ($j >= 0 && $j < $count && $tokens[$j] === '{') {
                        $namespaceDepth = 1;
                    }
                    continue;
                }
                $top = $depth === 0 || ($namespaceDepth !== null && $depth === $namespaceDepth);
                if ($token[0] !== T_FUNCTION || !$top) {
                    continue;
                }
                $previous = $significant($i - 1, -1);
                if ($previous >= 0 && is_array($tokens[$previous]) && in_array($tokens[$previous][0], [T_USE, T_STATIC], true)) {
                    continue; // `use function`, `static function () {}`
                }
                $next = $significant($i + 1, 1);
                if ($next >= 0 && ($tokens[$next] === '&' || (is_array($tokens[$next]) && $tokens[$next][1] === '&'))) {
                    $next = $significant($next + 1, 1);
                }
                if ($next >= 0 && is_array($tokens[$next]) && $tokens[$next][0] === T_STRING) {
                    $functions[] = $namespace === '' ? $tokens[$next][1] : $namespace . '\\' . $tokens[$next][1];
                }
            }

            return array_values(array_unique($functions));
        }

        /**
         * Load <dir>/.env with the project's vlucas/phpdotenv (v2 – v5) when available.
         *
         * @param string $dir
         * @return bool
         */
        public static function loadPhpDotenv($dir)
        {
            $class = 'Dotenv\Dotenv';
            if (!is_file($dir . '/.env') || !class_exists($class)) {
                return false;
            }
            if (method_exists($class, 'createUnsafeMutable')) {
                $class::createUnsafeMutable($dir)->safeLoad();          // v5 (includes putenv)
            } elseif (method_exists($class, 'createMutable')) {
                $class::createMutable($dir)->safeLoad();                // v4
            } elseif (method_exists($class, 'create')) {
                $class::create($dir)->load();                           // v3
            } else {
                (new $class($dir))->load();                             // v2
            }

            return true;
        }

        /**
         * A Symfony Dotenv instance that behaves like the framework's front controllers.
         *
         * @param bool $usePutenv
         * @return object|null
         */
        public static function symfonyDotenv($usePutenv = false)
        {
            $class = 'Symfony\Component\Dotenv\Dotenv';
            if (!class_exists($class)) {
                return null;
            }
            $constructor = (new \ReflectionClass($class))->getConstructor();
            $parameters = $constructor === null ? [] : $constructor->getParameters();
            if ($parameters && $parameters[0]->getName() === 'usePutenv') {
                // Symfony 4.x: the constructor argument decides putenv() usage (explicit to avoid a deprecation).
                return new $class((bool) $usePutenv);
            }
            $dotenv = new $class();
            if ($usePutenv && method_exists($dotenv, 'usePutenv')) {
                $dotenv->usePutenv(true);
            }

            return $dotenv;
        }

        /**
         * Load a Symfony-style .env set (.env, .env.local, .env.<env>, .env.local.php) into $_SERVER / $_ENV.
         *
         * @param string $projectPath
         * @param bool $usePutenv
         * @param string[]|null $prodEnvs environments treated like "prod" (Symfony 5.4+ Dotenv::setProdEnvs())
         * @return bool
         */
        public static function bootSymfonyEnv($projectPath, $usePutenv = false, $prodEnvs = null)
        {
            if (!is_file($projectPath . '/.env') && !is_file($projectPath . '/.env.dist') && !is_file($projectPath . '/.env.local.php')) {
                return false;
            }
            $dotenv = self::symfonyDotenv($usePutenv);
            if ($dotenv === null) {
                return false;
            }
            if (is_array($prodEnvs) && method_exists($dotenv, 'setProdEnvs')) {
                $dotenv->setProdEnvs($prodEnvs);
            }
            if (method_exists($dotenv, 'bootEnv')) {
                $dotenv->bootEnv($projectPath . '/.env');               // Symfony 5.1+
            } elseif (method_exists($dotenv, 'loadEnv')) {
                $dotenv->loadEnv($projectPath . '/.env');               // Symfony 4.2+
            } elseif (is_file($projectPath . '/.env')) {
                $dotenv->load($projectPath . '/.env');
            }

            return true;
        }

        /**
         * Set $_SERVER entries that web frameworks expect (CLI requests have none of them).
         *
         * @param array<string, string|null> $vars
         * @param bool $override replace existing values
         * @return void
         */
        public static function setServerVars(array $vars, $override = false)
        {
            foreach ($vars as $key => $value) {
                if ($override || !isset($_SERVER[$key])) {
                    $_SERVER[$key] = $value;
                }
            }
        }

        /**
         * Require a file whose top-level code expects to run in the global scope: the given names are bound to
         * $GLOBALS before the include, and variables it creates afterwards are exported to $GLOBALS.
         *
         * @param string $__tinkerboxFile
         * @param string[] $__tinkerboxGlobals
         * @return mixed the include's return value
         */
        public static function requireWithGlobals($__tinkerboxFile, array $__tinkerboxGlobals = [])
        {
            foreach ($__tinkerboxGlobals as $__tinkerboxName) {
                ${$__tinkerboxName} = &$GLOBALS[$__tinkerboxName];
            }
            unset($__tinkerboxName);
            $__tinkerboxResult = require_once $__tinkerboxFile;
            foreach (get_defined_vars() as $__tinkerboxKey => $__tinkerboxValue) {
                if (strpos($__tinkerboxKey, '__tinkerbox') !== 0 && !array_key_exists($__tinkerboxKey, $GLOBALS)) {
                    $GLOBALS[$__tinkerboxKey] = $__tinkerboxValue;
                }
            }

            return $__tinkerboxResult;
        }

        /**
         * Call a static method that may be protected (framework boot helpers), skipping missing ones.
         *
         * @param string $class
         * @param string $method
         * @param array $args
         * @return mixed
         */
        public static function callStatic($class, $method, array $args = [])
        {
            if (!method_exists($class, $method)) {
                return null;
            }
            $reflection = new \ReflectionMethod($class, $method);
            if (!$reflection->isPublic() && PHP_VERSION_ID < 80100) {
                $reflection->setAccessible(true);
            }

            return $reflection->invokeArgs(null, $args);
        }

        /**
         * Invoke a query listener without ever breaking the user's query when capturing fails.
         *
         * @param callable $listener
         * @param string $sql
         * @param array $bindings
         * @param float $timeMs
         * @param string $connection
         * @return void
         */
        public static function emitQuery(callable $listener, $sql, array $bindings, $timeMs, $connection)
        {
            try {
                $listener((string) $sql, $bindings, (float) $timeMs, (string) $connection);
            } catch (\Throwable $e) {
                // Query capture is diagnostics only: a failing listener must not abort the user's database call.
                return;
            }
        }

        /**
         * Doctrine DBAL 2/3: attach an SQLLogger (chained with an existing one). DBAL 4 has no SQLLogger API and
         * loggers cannot be added after the connection was built, so it is skipped without error.
         *
         * @param object $connection Doctrine\DBAL\Connection
         * @param string $name connection name
         * @param callable $listener
         * @return bool
         */
        public static function attachDoctrineLogger($connection, $name, callable $listener)
        {
            $interface = 'Doctrine\DBAL\Logging\SQLLogger';
            if (!is_object($connection) || !method_exists($connection, 'getConfiguration') || !interface_exists($interface)) {
                return false;
            }
            $configuration = $connection->getConfiguration();
            if (!is_object($configuration) || !method_exists($configuration, 'setSQLLogger')) {
                return false;
            }
            if (!self::defineDoctrineLogger($interface)) {
                return false;
            }
            $previous = method_exists($configuration, 'getSQLLogger') ? $configuration->getSQLLogger() : null;
            if ($previous instanceof \TinkerboxDoctrineSqlLogger) {
                return true;
            }
            $configuration->setSQLLogger(new \TinkerboxDoctrineSqlLogger($listener, (string) $name, $previous));

            return true;
        }

        /**
         * Declare \TinkerboxDoctrineSqlLogger implementing the project's SQLLogger interface. The class is generated
         * from the interface's reflection so the signatures always match the installed DBAL version.
         *
         * @param string $interface
         * @return bool
         */
        private static function defineDoctrineLogger($interface)
        {
            if (class_exists('TinkerboxDoctrineSqlLogger', false)) {
                return true;
            }
            $signature = function ($method) use ($interface) {
                $reflection = new \ReflectionMethod($interface, $method);
                $params = [];
                foreach ($reflection->getParameters() as $parameter) {
                    $type = $parameter->hasType() ? (string) $parameter->getType() : '';
                    if ($type !== '' && $parameter->allowsNull() && $type[0] !== '?' && strpos($type, 'null') === false && strpos($type, '|') === false) {
                        $type = '?' . $type;
                    }
                    $params[] = ($type !== '' ? $type . ' ' : '') . '$' . $parameter->getName() . ($parameter->isOptional() ? ' = null' : '');
                }
                $return = $reflection->hasReturnType() ? ': ' . (string) $reflection->getReturnType() : '';

                return 'public function ' . $method . '(' . implode(', ', $params) . ')' . $return;
            };
            $start = $signature('startQuery');
            $stop = $signature('stopQuery');
            $code = 'final class TinkerboxDoctrineSqlLogger implements \\' . $interface . ' {
                private $listener; private $connection; private $previous; private $current = null;
                public function __construct($listener, $connection, $previous) { $this->listener = $listener; $this->connection = $connection; $this->previous = $previous; }
                ' . $start . ' {
                    if ($this->previous !== null) { $this->previous->startQuery($sql, $params, $types); }
                    $this->current = [(string) $sql, is_array($params) ? $params : [], microtime(true)];
                }
                ' . $stop . ' {
                    if ($this->previous !== null) { $this->previous->stopQuery(); }
                    if ($this->current === null) { return; }
                    $query = $this->current;
                    $this->current = null;
                    \\Tinkerbox\\Drivers\\Support::emitQuery($this->listener, $query[0], $query[1], (microtime(true) - $query[2]) * 1000, $this->connection);
                }
            }';
            try {
                eval($code);
            } catch (\Throwable $e) {
                return false;
            }

            return class_exists('TinkerboxDoctrineSqlLogger', false);
        }

        /**
         * A subclass of a Symfony kernel class whose container keeps every service and alias public, so services
         * can be fetched by id in the editor (`$container->get('product.repository')`). The subclass is generated
         * from the kernel's own buildContainer() signature; the original class is returned when that is not possible.
         *
         * @param string $kernelClass
         * @return string
         */
        public static function publicServicesKernel($kernelClass)
        {
            $kernelClass = ltrim((string) $kernelClass, '\\');
            try {
                if (!class_exists($kernelClass) || !method_exists($kernelClass, 'buildContainer')) {
                    return $kernelClass;
                }
                $reflection = new \ReflectionClass($kernelClass);
                $method = $reflection->getMethod('buildContainer');
                if ($reflection->isFinal() || $method->isFinal() || $method->isPrivate() || $method->isStatic()) {
                    return $kernelClass;
                }
                $name = 'TinkerboxPublicServices_' . str_replace('\\', '_', $kernelClass);
                if (class_exists($name, false)) {
                    return $name;
                }
                $return = $method->hasReturnType() ? ': ' . self::typeDeclaration($method->getReturnType()) : '';
                $visibility = $method->isPublic() ? 'public' : 'protected';
                eval('final class ' . $name . ' extends \\' . $kernelClass . ' {
                    ' . $visibility . ' function buildContainer()' . $return . '
                    {
                        $container = parent::buildContainer();
                        foreach ($container->getDefinitions() as $definition) {
                            $definition->setPublic(true);
                        }
                        if (method_exists($container, "getAliases")) {
                            foreach ($container->getAliases() as $alias) {
                                $alias->setPublic(true);
                            }
                        }

                        return $container;
                    }
                }');

                return class_exists($name, false) ? $name : $kernelClass;
            } catch (\Throwable $e) {
                // Private services stay private; the kernel itself still boots.
                return $kernelClass;
            }
        }

        /**
         * Source form of a reflected type (class names fully qualified).
         *
         * @param \ReflectionType $type
         * @return string
         */
        private static function typeDeclaration($type)
        {
            if ($type instanceof \ReflectionNamedType) {
                $name = $type->getName();
                $nullable = $type->allowsNull() && $name !== 'mixed' && $name !== 'null' ? '?' : '';

                return $nullable . ($type->isBuiltin() || in_array(strtolower($name), ['self', 'static', 'parent'], true) ? $name : '\\' . ltrim($name, '\\'));
            }
            $separator = class_exists('ReflectionIntersectionType', false) && $type instanceof \ReflectionIntersectionType ? '&' : '|';
            $parts = [];
            foreach (method_exists($type, 'getTypes') ? $type->getTypes() : [] as $part) {
                $parts[] = $part instanceof \ReflectionNamedType && !$part->isBuiltin() ? '\\' . ltrim($part->getName(), '\\') : (string) $part;
            }

            return $parts ? implode($separator, $parts) : (string) $type;
        }
    }

    /**
     * Helpers shared by the Laravel family (Laravel, Statamic, October, Laravel Zero, Lumen, Testbench) and Acorn
     * (Radicle), also used by the panels, the introspector and the class alias loader.
     */
    final class Laravel
    {
        /** Seconds a database connection may take while reading model columns. */
        const SCHEMA_TIMEOUT = 2;

        /**
         * Boot a Laravel application the way `php artisan` does: Composer autoloader, bootstrap/app.php, then the
         * console kernel's bootstrappers (environment, configuration, facades, providers).
         *
         * @param string $projectPath
         * @return object Illuminate\Foundation\Application
         */
        public static function boot($projectPath)
        {
            if (!defined('LARAVEL_START')) {
                define('LARAVEL_START', microtime(true));
            }
            Support::requireAutoload($projectPath);
            if (!is_file($projectPath . '/bootstrap/app.php')) {
                throw new \RuntimeException('Laravel could not be booted: ' . $projectPath . '/bootstrap/app.php is missing.');
            }
            $app = require $projectPath . '/bootstrap/app.php';
            if (!is_object($app) || !method_exists($app, 'make')) {
                throw new \RuntimeException($projectPath . '/bootstrap/app.php did not return a Laravel application instance.');
            }
            $app->make('Illuminate\Contracts\Console\Kernel')->bootstrap();

            return $app;
        }

        /**
         * The running Laravel / Lumen / Acorn application (Container::$instance), without creating a container.
         *
         * @return object|null
         */
        public static function runningApp()
        {
            if (!class_exists('Illuminate\Container\Container', false)) {
                return null;
            }
            try {
                $property = new \ReflectionProperty('Illuminate\Container\Container', 'instance');
                if (PHP_VERSION_ID < 80100) {
                    $property->setAccessible(true);
                }
                $app = $property->getValue();
            } catch (\Throwable $e) {
                return null;
            }

            return is_object($app) && method_exists($app, 'version') && method_exists($app, 'make') ? $app : null;
        }

        /**
         * Laravel framework version ("12.20.0").
         *
         * @param object|null $app
         * @return string|null
         */
        public static function frameworkVersion($app)
        {
            if (defined('Illuminate\Foundation\Application::VERSION')) {
                return (string) constant('Illuminate\Foundation\Application::VERSION');
            }
            try {
                return $app !== null ? (string) $app->version() : null;
            } catch (\Throwable $e) {
                return null;
            }
        }

        /**
         * Listen for executed queries through the event dispatcher.
         *
         * @param object|null $app
         * @param callable $listener
         * @return bool
         */
        public static function listen($app, callable $listener)
        {
            if ($app === null) {
                return false;
            }
            try {
                $events = $app->make('events');
            } catch (\Throwable $e) {
                return false;
            }
            if (class_exists('Illuminate\Database\Events\QueryExecuted')) {
                $events->listen('Illuminate\Database\Events\QueryExecuted', function ($query) use ($listener) {
                    $bindings = is_array($query->bindings) ? $query->bindings : [];
                    try {
                        // Same normalization the connection applies before executing (dates, booleans).
                        if (is_object($query->connection) && method_exists($query->connection, 'prepareBindings')) {
                            $bindings = $query->connection->prepareBindings($bindings);
                        }
                    } catch (\Throwable $e) {
                        $bindings = is_array($query->bindings) ? $query->bindings : [];
                    }
                    Support::emitQuery($listener, $query->sql, $bindings, (float) $query->time, (string) $query->connectionName);
                });

                return true;
            }
            // Laravel < 5.2
            $events->listen('illuminate.query', function ($sql, $bindings = [], $time = 0, $connection = 'default') use ($listener) {
                Support::emitQuery($listener, $sql, is_array($bindings) ? $bindings : [], (float) $time, (string) $connection);
            });

            return true;
        }

        /**
         * Eloquent models of the project for autocompletion: classes found in app/Models (or app/), inspected via
         * reflection without running constructors; columns read from the schema with a short connect timeout.
         *
         * @param object|null $app
         * @param string $basePath
         * @return array
         */
        public static function models($app, $basePath)
        {
            $modelClass = 'Illuminate\Database\Eloquent\Model';
            if ($app === null || !class_exists($modelClass)) {
                return [];
            }
            $appPath = method_exists($app, 'path') ? (string) $app->path() : Support::path($basePath) . '/app';
            $dir = is_dir($appPath . '/Models') ? $appPath . '/Models' : $appPath;
            if (!is_dir($dir)) {
                return [];
            }
            $models = [];
            $failedConnections = [];
            foreach (Support::phpFilesIn($dir) as $file) {
                foreach (Support::declaredClassesInFile($file) as $class) {
                    $info = self::modelInfo($app, $class, $modelClass, $failedConnections);
                    if ($info !== null) {
                        $models[] = $info;
                    }
                }
            }

            return $models;
        }

        /**
         * @param object $app
         * @param string $class
         * @param string $modelClass
         * @param array $failedConnections
         * @return array|null
         */
        private static function modelInfo($app, $class, $modelClass, array &$failedConnections)
        {
            try {
                if (!class_exists($class)) {
                    return null;
                }
                $reflection = new \ReflectionClass($class);
                if ($reflection->isAbstract() || !$reflection->isSubclassOf($modelClass)) {
                    return null;
                }
                // No constructor: avoids model boot() hooks; property defaults are enough for table / connection.
                $model = $reflection->newInstanceWithoutConstructor();
                $table = (string) $model->getTable();
                $connection = $model->getConnectionName();
            } catch (\Throwable $e) {
                return null;
            }

            return [
                'class' => $class,
                'table' => $table,
                'columns' => self::columns($app, $connection, $table, $failedConnections),
                'relations' => self::relations($reflection),
            ];
        }

        /**
         * @param object $app
         * @param string|null $connection
         * @param string $table
         * @param array $failed connection names that failed once (skipped afterwards)
         * @return array
         */
        private static function columns($app, $connection, $table, array &$failed)
        {
            $previousTimeout = ini_get('default_socket_timeout');
            try {
                $db = $app->make('db');
                $name = $connection !== null && $connection !== '' ? (string) $connection : (string) $db->getDefaultConnection();
                if (isset($failed[$name])) {
                    return [];
                }
                self::applyConnectTimeout($app, $db, $name);
                ini_set('default_socket_timeout', (string) self::SCHEMA_TIMEOUT);
                $schema = $db->connection($name)->getSchemaBuilder();
                $columns = [];
                if (method_exists($schema, 'getColumns')) {
                    foreach ($schema->getColumns($table) as $column) {
                        $type = isset($column['type_name']) ? $column['type_name'] : (isset($column['type']) ? $column['type'] : null);
                        $columns[] = $type === null ? ['name' => (string) $column['name']] : ['name' => (string) $column['name'], 'type' => (string) $type];
                    }
                } else {
                    foreach ($schema->getColumnListing($table) as $column) {
                        $columns[] = ['name' => (string) $column];
                    }
                }

                return $columns;
            } catch (\Throwable $e) {
                // Database unreachable / unknown table: models are still listed, just without columns.
                if (isset($name)) {
                    $failed[$name] = true;
                }

                return [];
            } finally {
                if ($previousTimeout !== false) {
                    ini_set('default_socket_timeout', (string) $previousTimeout);
                }
            }
        }

        /**
         * Lower the PDO connect timeout of a not yet opened network connection.
         *
         * @param object $app
         * @param object $db
         * @param string $name
         * @return void
         */
        private static function applyConnectTimeout($app, $db, $name)
        {
            if (method_exists($db, 'getConnections') && array_key_exists($name, $db->getConnections())) {
                return;
            }
            $config = $app->make('config');
            $driver = $config->get('database.connections.' . $name . '.driver');
            if (!in_array($driver, ['mysql', 'mariadb', 'pgsql', 'sqlsrv'], true)) {
                return;
            }
            $options = $config->get('database.connections.' . $name . '.options', []);
            $options = is_array($options) ? $options : [];
            if (!isset($options[\PDO::ATTR_TIMEOUT])) {
                $options[\PDO::ATTR_TIMEOUT] = self::SCHEMA_TIMEOUT;
                $config->set('database.connections.' . $name . '.options', $options);
            }
        }

        /**
         * Relation method names: public methods returning an Eloquent Relation (return type, or `$this->hasMany(`
         * style calls in the method body). Methods are never invoked.
         *
         * @param \ReflectionClass $reflection
         * @return string[]
         */
        private static function relations(\ReflectionClass $reflection)
        {
            $relationClass = 'Illuminate\Database\Eloquent\Relations\Relation';
            $pattern = '/\$this\s*->\s*(hasOne|hasMany|belongsTo|belongsToMany|morphTo|morphOne|morphMany|morphToMany|morphedByMany|hasOneThrough|hasManyThrough|hasOneDeep|hasManyDeep)\s*\(/';
            $sources = [];
            $relations = [];
            foreach ($reflection->getMethods(\ReflectionMethod::IS_PUBLIC) as $method) {
                $declaring = $method->getDeclaringClass()->getName();
                if ($method->isStatic() || $method->getNumberOfRequiredParameters() > 0 || strpos($declaring, 'Illuminate\\') === 0) {
                    continue;
                }
                $isRelation = false;
                $type = $method->getReturnType();
                $types = $type === null ? [] : (method_exists($type, 'getTypes') ? $type->getTypes() : [$type]);
                foreach ($types as $named) {
                    if ($named instanceof \ReflectionNamedType && !$named->isBuiltin()) {
                        $name = $named->getName();
                        if ($name === $relationClass || is_subclass_of($name, $relationClass)) {
                            $isRelation = true;
                        }
                    }
                }
                if (!$isRelation && $type === null) {
                    $file = $method->getFileName();
                    if (is_string($file) && is_file($file)) {
                        if (!isset($sources[$file])) {
                            $sources[$file] = file($file);
                        }
                        $lines = is_array($sources[$file]) ? array_slice($sources[$file], $method->getStartLine() - 1, max(1, $method->getEndLine() - $method->getStartLine() + 1)) : [];
                        $isRelation = preg_match($pattern, implode('', $lines)) === 1;
                    }
                }
                if ($isRelation) {
                    $relations[] = $method->getName();
                }
            }
            sort($relations);

            return $relations;
        }
    }

    /**
     * Drupal 7 / 8+ query log (Database::startLog / getLog).
     */
    final class DrupalQueryLog
    {
        /** @var string */
        private $database;

        /** @var callable */
        private $listener;

        /** @var array<string, int> connection key => entries already reported */
        private $seen = [];

        /**
         * @param string $database \Database (Drupal 7) or Drupal\Core\Database\Database
         * @param callable $listener
         * @return self|null
         */
        public static function start($database, callable $listener)
        {
            if (!class_exists($database)) {
                return null;
            }
            $log = new self();
            $log->database = $database;
            $log->listener = $listener;
            $info = $database::getAllConnectionInfo();
            foreach (array_keys(is_array($info) && $info ? $info : ['default' => []]) as $key) {
                try {
                    $database::startLog('tinkerbox', $key);
                    $log->seen[(string) $key] = 0;
                } catch (\Throwable $e) {
                    // Connection key without usable configuration: nothing to log for it.
                    continue;
                }
            }

            return $log;
        }

        /**
         * Report entries logged since the last flush.
         *
         * @return void
         */
        public function flush()
        {
            $database = $this->database;
            foreach ($this->seen as $key => $seen) {
                try {
                    $entries = $database::getLog('tinkerbox', $key);
                } catch (\Throwable $e) {
                    continue;
                }
                $entries = is_array($entries) ? array_values($entries) : [];
                $this->seen[$key] = count($entries);
                foreach (array_slice($entries, $seen) as $entry) {
                    if (is_array($entry) && isset($entry['query'])) {
                        $args = isset($entry['args']) && is_array($entry['args']) ? $entry['args'] : [];
                        $time = isset($entry['time']) ? (float) $entry['time'] * 1000 : 0.0;
                        Support::emitQuery($this->listener, (string) $entry['query'], $args, $time, $key);
                    }
                }
            }
        }
    }

    /**
     * Yii 2 / Craft CMS query log: database profiling messages of the Yii logger.
     */
    final class YiiQueryLog
    {
        /** @var object yii\log\Logger */
        private $logger;

        /** @var callable */
        private $listener;

        /** @var int */
        private $offset = 0;

        /**
         * @param callable $listener
         * @return self|null
         */
        public static function start(callable $listener)
        {
            if (!class_exists('Yii', false) || !method_exists('Yii', 'getLogger')) {
                return null;
            }
            $logger = \Yii::getLogger();
            if (!is_object($logger) || !property_exists($logger, 'messages') || !method_exists($logger, 'calculateTimings')) {
                return null;
            }
            // Keep messages in memory for the run (no automatic flush that would drop profiling entries).
            $logger->flushInterval = 0;
            $log = new self();
            $log->logger = $logger;
            $log->listener = $listener;
            $log->offset = count($logger->messages);

            return $log;
        }

        /**
         * @return void
         */
        public function flush()
        {
            $messages = is_array($this->logger->messages) ? $this->logger->messages : [];
            if (count($messages) < $this->offset) {
                $this->offset = 0; // the logger was flushed by the application
            }
            $new = array_slice($messages, $this->offset);
            $this->offset = count($messages);
            if (!$new) {
                return;
            }
            foreach ($this->logger->calculateTimings($new) as $timing) {
                if (!isset($timing['category'], $timing['info']) || strpos((string) $timing['category'], 'yii\db\Command::') !== 0) {
                    continue;
                }
                $duration = isset($timing['duration']) ? (float) $timing['duration'] * 1000 : 0.0;
                Support::emitQuery($this->listener, (string) $timing['info'], [], $duration, 'db');
            }
        }
    }
}
