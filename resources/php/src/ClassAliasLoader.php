<?php

namespace Tinkerbox {
    /**
     * Tinker-style class aliasing: `User::first()` works without importing App\Models\User.
     *
     * Candidates come from the project's Composer classmap (non-vendor classes, like Laravel Tinker) plus a bounded
     * scan of the project's own PSR-4 directories (projects without an optimized autoloader). Nothing is autoloaded
     * while building the map: an spl autoloader calls class_alias() when an unknown short name is used.
     *
     * Rules:
     * - Laravel `config('tinker.alias')` prefixes are always aliasable (vendor classes included);
     *   `config('tinker.dont_alias')` prefixes never are (default: App\Nova).
     * - Short names that already resolve to something else are skipped: declared global classes / interfaces /
     *   traits (Exception, DateTime, user `class_alias()`es…), Laravel facade aliases (DB, Route, Str…) and global
     *   classes from the classmap (polyfills).
     * - Several classes with the same short name: tinker.alias matches first, then `…\Models\…` classes, then the
     *   shallowest namespace, then alphabetical order.
     * - Statamic projects also get Statamic\Facades\*, Statamic\Support\Arr and Statamic\Support\Str (the
     *   classes Statamic code uses all the time).
     */
    final class ClassAliasLoader
    {
        /** @var int max files visited by the PSR-4 scan */
        public static $maxScanFiles = 5000;

        /** @var string[] default `tinker.dont_alias` */
        const DEFAULT_DONT_ALIAS = ['App\Nova'];

        /** @var string[] */
        const STATAMIC_ALIASES = ['Statamic\Facades\\', 'Statamic\Support\Arr', 'Statamic\Support\Str'];

        /** @var array<string, string> lowercase short name => FQCN */
        private static $classes = [];

        /** @var array<string, string> short name => FQCN */
        private static $aliases = [];

        /** @var bool */
        private static $registered = false;

        /** @var array<string, true> short names currently being aliased (recursion guard) */
        private static $loading = [];

        /**
         * Build the alias map for a project and register the aliasing autoloader (appended after the project's own
         * autoloaders and Laravel's AliasLoader). Calling it again replaces the map.
         *
         * @param string $projectPath
         * @return void
         */
        public static function register($projectPath)
        {
            self::$classes = [];
            self::$aliases = [];
            $projectPath = Drivers\Support::path($projectPath);
            if ($projectPath === '' || !is_dir($projectPath)) {
                return;
            }
            try {
                self::build($projectPath);
            } catch (\Throwable $e) {
                // Aliasing is a convenience: a broken classmap / composer.json must never break the run.
                self::$classes = [];
                self::$aliases = [];

                return;
            }
            if (!self::$registered) {
                spl_autoload_register([__CLASS__, 'load']);
                self::$registered = true;
            }
        }

        /**
         * Short name => FQCN of every alias that would be created on demand.
         *
         * @return array<string, string>
         */
        public static function aliases()
        {
            return self::$aliases;
        }

        /**
         * Autoloader: alias an unknown short class name to its project class.
         *
         * @param string $class
         * @return void
         */
        public static function load($class)
        {
            if (strpos($class, '\\') !== false) {
                return;
            }
            $key = strtolower($class);
            if (!isset(self::$classes[$key]) || isset(self::$loading[$key])) {
                return;
            }
            self::$loading[$key] = true;
            try {
                $target = self::$classes[$key];
                $exists = class_exists($target) || interface_exists($target) || trait_exists($target);
                if ($exists && !class_exists($class, false) && !interface_exists($class, false) && !trait_exists($class, false)) {
                    class_alias($target, $class);
                }
            } finally {
                unset(self::$loading[$key]);
            }
        }

        /**
         * @param string $projectPath
         * @return void
         */
        private static function build($projectPath)
        {
            $included = [];
            $excluded = self::DEFAULT_DONT_ALIAS;
            self::laravelConfig($included, $excluded);
            if (is_dir(Drivers\Support::vendorDir($projectPath) . '/statamic/cms')) {
                $included = array_merge($included, self::STATAMIC_ALIASES);
            }

            $candidates = [];
            $reserved = self::reservedNames();

            // 1. Composer classmap (Laravel apps optimize it: it contains every project class).
            $classmapFile = Drivers\Support::vendorDir($projectPath) . '/composer/autoload_classmap.php';
            if (is_file($classmapFile)) {
                $classmap = require $classmapFile;
                $vendorReal = realpath(dirname($classmapFile, 2));
                $vendorPrefixes = array_unique(array_filter([
                    Drivers\Support::vendorDir($projectPath) . DIRECTORY_SEPARATOR,
                    $vendorReal === false ? null : $vendorReal . DIRECTORY_SEPARATOR,
                ]));
                foreach (is_array($classmap) ? $classmap : [] as $class => $file) {
                    $class = (string) $class;
                    if (strpos($class, '\\') === false) {
                        $reserved[strtolower($class)] = true; // global class (polyfill): its name is taken
                        continue;
                    }
                    $explicit = self::startsWithAny($class, $included);
                    if (!$explicit && (self::startsWithAny((string) $file, $vendorPrefixes) || self::startsWithAny($class, $excluded))) {
                        continue;
                    }
                    self::consider($candidates, $class, $explicit);
                }
            }

            // 2. Bounded scan of the project's own PSR-4 directories (autoload, then autoload-dev).
            $budget = max(0, (int) self::$maxScanFiles);
            foreach (self::psr4Mappings($projectPath) as $mapping) {
                list($prefix, $directory) = $mapping;
                if ($budget <= 0) {
                    break;
                }
                foreach (self::scanPsr4($directory, $prefix, $budget) as $class) {
                    $explicit = self::startsWithAny($class, $included);
                    if (!$explicit && self::startsWithAny($class, $excluded)) {
                        continue;
                    }
                    self::consider($candidates, $class, $explicit);
                }
            }

            ksort($candidates, SORT_STRING);
            foreach ($candidates as $key => $candidate) {
                if (isset($reserved[$key])) {
                    continue;
                }
                self::$classes[$key] = $candidate['class'];
                self::$aliases[self::shortName($candidate['class'])] = $candidate['class'];
            }
            ksort(self::$aliases, SORT_STRING | SORT_FLAG_CASE);
        }

        /**
         * Keep the best class per short name.
         *
         * @param array $candidates
         * @param string $class
         * @param bool $explicit matched tinker.alias
         * @return void
         */
        private static function consider(array &$candidates, $class, $explicit)
        {
            $class = ltrim($class, '\\');
            $short = self::shortName($class);
            if ($short === '' || !preg_match('/^[A-Za-z_\x80-\xff][A-Za-z0-9_\x80-\xff]*$/', $short)) {
                return;
            }
            $rank = [
                $explicit ? 0 : 1,
                stripos($class, '\\Models\\') !== false ? 0 : 1,
                substr_count($class, '\\'),
                strtolower($class),
            ];
            $key = strtolower($short);
            if (!isset($candidates[$key]) || $rank < $candidates[$key]['rank']) {
                $candidates[$key] = ['class' => $class, 'rank' => $rank];
            }
        }

        /**
         * Lowercase short names that must not be aliased because they already resolve to something.
         *
         * @return array<string, true>
         */
        private static function reservedNames()
        {
            $reserved = [];
            foreach (array_merge(get_declared_classes(), get_declared_interfaces(), get_declared_traits()) as $name) {
                if (strpos($name, '\\') === false) {
                    $reserved[strtolower($name)] = true;
                }
            }
            if (class_exists('Illuminate\Foundation\AliasLoader', false)) {
                try {
                    foreach (array_keys((array) \Illuminate\Foundation\AliasLoader::getInstance()->getAliases()) as $alias) {
                        $reserved[strtolower((string) $alias)] = true;
                    }
                } catch (\Throwable $e) {
                    // AliasLoader unavailable in this Laravel version: facade names stay unreserved.
                    return $reserved;
                }
            }

            return $reserved;
        }

        /**
         * Read tinker.alias / tinker.dont_alias from a running Laravel application.
         *
         * @param string[] $included
         * @param string[] $excluded
         * @return void
         */
        private static function laravelConfig(array &$included, array &$excluded)
        {
            $app = Drivers\Laravel::runningApp();
            if ($app === null) {
                return;
            }
            try {
                if (method_exists($app, 'bound') && !$app->bound('config')) {
                    return;
                }
                $config = $app->make('config');
                $alias = $config->get('tinker.alias');
                $dontAlias = $config->get('tinker.dont_alias');
            } catch (\Throwable $e) {
                // No config repository (unusual container setups): keep the defaults.
                return;
            }
            if (is_array($alias)) {
                foreach ($alias as $prefix) {
                    if (is_string($prefix) && $prefix !== '') {
                        $included[] = ltrim($prefix, '\\');
                    }
                }
            }
            if (is_array($dontAlias)) {
                $excluded = [];
                foreach ($dontAlias as $prefix) {
                    if (is_string($prefix) && $prefix !== '') {
                        $excluded[] = ltrim($prefix, '\\');
                    }
                }
            }
        }

        /**
         * [prefix, absolute directory] pairs from composer.json autoload / autoload-dev psr-4.
         *
         * @param string $projectPath
         * @return array<int, array{0: string, 1: string}>
         */
        private static function psr4Mappings($projectPath)
        {
            $composer = Drivers\Support::composerJson($projectPath);
            $mappings = [];
            foreach (['autoload', 'autoload-dev'] as $section) {
                if (!isset($composer[$section]['psr-4']) || !is_array($composer[$section]['psr-4'])) {
                    continue;
                }
                foreach ($composer[$section]['psr-4'] as $prefix => $directories) {
                    foreach ((array) $directories as $directory) {
                        if (!is_string($directory)) {
                            continue;
                        }
                        $absolute = Drivers\Support::isAbsolute($directory) ? $directory : $projectPath . '/' . $directory;
                        $absolute = Drivers\Support::path($absolute);
                        if (is_dir($absolute)) {
                            $mappings[] = [trim((string) $prefix, '\\'), $absolute];
                        }
                    }
                }
            }

            return $mappings;
        }

        /**
         * Class names derived from PSR-4 file paths (files are not parsed or loaded).
         *
         * @param string $directory
         * @param string $prefix
         * @param int $budget remaining files to visit (decremented)
         * @return string[]
         */
        private static function scanPsr4($directory, $prefix, &$budget)
        {
            $segment = '/^[A-Za-z_\x80-\xff][A-Za-z0-9_\x80-\xff]*$/';
            $classes = [];
            $queue = [[$directory, '']];
            for ($index = 0; $index < count($queue) && $budget > 0; $index++) {
                list($dir, $namespace) = $queue[$index];
                // Unreadable folders are skipped: aliasing is best effort.
                $entries = @scandir($dir);
                if ($entries === false) {
                    continue;
                }
                foreach ($entries as $entry) {
                    if ($entry === '.' || $entry === '..' || $entry[0] === '.') {
                        continue;
                    }
                    $path = $dir . DIRECTORY_SEPARATOR . $entry;
                    if (is_dir($path)) {
                        if ($entry !== 'vendor' && $entry !== 'node_modules' && preg_match($segment, $entry) && !is_link($path)) {
                            $queue[] = [$path, $namespace === '' ? $entry : $namespace . '\\' . $entry];
                        }
                        continue;
                    }
                    if (--$budget < 0) {
                        break 2;
                    }
                    if (substr($entry, -4) !== '.php') {
                        continue;
                    }
                    $name = substr($entry, 0, -4);
                    if (!preg_match($segment, $name)) {
                        continue;
                    }
                    $relative = $namespace === '' ? $name : $namespace . '\\' . $name;
                    $classes[] = $prefix === '' ? $relative : $prefix . '\\' . $relative;
                }
            }

            return $classes;
        }

        /**
         * @param string $value
         * @param string[] $prefixes
         * @return bool
         */
        private static function startsWithAny($value, array $prefixes)
        {
            foreach ($prefixes as $prefix) {
                if ($prefix !== '' && strncmp($value, $prefix, strlen($prefix)) === 0) {
                    return true;
                }
            }

            return false;
        }

        /**
         * @param string $class
         * @return string
         */
        private static function shortName($class)
        {
            $pos = strrpos($class, '\\');

            return $pos === false ? $class : substr($class, $pos + 1);
        }
    }
}
