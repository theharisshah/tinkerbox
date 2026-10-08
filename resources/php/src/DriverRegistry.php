<?php

namespace Tinkerbox {
    use Tinkerbox\Drivers\Driver;

    /**
     * Picks the driver for a project (docs/ARCHITECTURE.md §1.7).
     *
     * Order: custom drivers from `<home>/.config/tinkerbox/drivers/*.php`, then `<project>/.tinkerbox/drivers/*.php`
     * (subclasses before the classes they extend), then the built-ins in BUILTINS order; the first driver whose
     * canBootstrap() returns true is used and PlainDriver is the fallback. Problems with custom drivers (files that do
     * not load, constructors with arguments, canBootstrap() exceptions) never stop the detection: they are collected
     * as warnings, which the runner reports as diagnostics.
     */
    final class DriverRegistry
    {
        /**
         * Built-in drivers in detection order: specialized products before the framework they are built on
         * (Statamic / October / Lumen / Laravel Zero before Laravel, Radicle / Bedrock before WordPress, Shopware
         * and PrestaShop before Symfony, Craft before Yii 2), Composer last. PlainDriver is the fallback.
         */
        const BUILTINS = [
            Drivers\StatamicDriver::class,
            Drivers\Drupal7Driver::class,
            Drivers\DrupalDriver::class,
            Drivers\KirbyDriver::class,
            Drivers\MoodleDriver::class,
            Drivers\OctoberDriver::class,
            Drivers\LumenDriver::class,
            Drivers\LaravelZeroDriver::class,
            Drivers\LaravelDriver::class,
            Drivers\CraftDriver::class,
            Drivers\Magento2Driver::class,
            Drivers\PrestaShopDriver::class,
            Drivers\RadicleDriver::class,
            Drivers\BedrockDriver::class,
            Drivers\WordPressDriver::class,
            Drivers\ShopwareDriver::class,
            Drivers\SymfonyDriver::class,
            Drivers\Typo3Driver::class,
            Drivers\TestbenchDriver::class,
            Drivers\CakePhpDriver::class,
            Drivers\CodeIgniter4Driver::class,
            Drivers\Yii2Driver::class,
            Drivers\JoomlaDriver::class,
            Drivers\ComposerDriver::class,
            Drivers\PlainDriver::class,
        ];

        /** Forced driver id for an application that is already running (Vapor `tinker`, Laravel Cloud). */
        const LARAVEL_BOOTED = 'laravel-booted';

        /** Max driver files loaded from one folder. */
        const MAX_DRIVER_FILES = 100;

        /** @var array<string, string[]> driver file (realpath) => classes it declared */
        private static $loadedFiles = [];

        /** @var string[] non-fatal problems (broken custom drivers, unknown forced id, …) */
        private static $warnings = [];

        /**
         * Pick the driver for a project.
         *
         * @param string $projectPath project root ('' => plain PHP)
         * @param string $forcedId DriverInfo.id to use instead of detecting ('' => detect), or "laravel-booted"
         * @param string $homePath home folder for global custom drivers ('' => $HOME / %USERPROFILE%)
         */
        public static function detect(string $projectPath, string $forcedId = '', string $homePath = ''): Driver
        {
            $projectPath = Drivers\Support::path($projectPath);
            $forcedId = trim($forcedId);

            if ($forcedId === self::LARAVEL_BOOTED) {
                return Drivers\LaravelDriver::alreadyBooted();
            }
            if ($projectPath === '' && $forcedId === '') {
                return new Drivers\PlainDriver();
            }

            $custom = self::customDrivers($projectPath, $homePath);

            if ($forcedId !== '') {
                $forced = self::forced($forcedId, $custom);
                if ($forced !== null) {
                    return $forced;
                }
                self::warn('Forced driver "' . $forcedId . '" is not available; the driver was detected automatically.');
                if ($projectPath === '') {
                    return new Drivers\PlainDriver();
                }
            }

            foreach (array_merge($custom, self::builtins()) as $driver) {
                if (self::canBootstrap($driver, $projectPath)) {
                    return $driver;
                }
            }

            return new Drivers\PlainDriver();
        }

        /**
         * Fresh instances of the built-in drivers in detection order.
         *
         * @return Driver[]
         */
        public static function builtins(): array
        {
            $drivers = [];
            foreach (self::BUILTINS as $class) {
                $drivers[] = new $class();
            }

            return $drivers;
        }

        /**
         * Built-in driver ids and names, e.g. for a "force driver" picker: [['id' => 'laravel', 'name' => 'Laravel'], …].
         *
         * @return array<int, array{id: string, name: string}>
         */
        public static function catalog(): array
        {
            $catalog = [];
            foreach (self::builtins() as $driver) {
                $catalog[] = ['id' => $driver->id(), 'name' => $driver->name()];
            }

            return $catalog;
        }

        /**
         * Custom drivers for a project (global ones first, then the project's), each subclass before the classes it
         * extends.
         *
         * @return Driver[]
         */
        public static function customDrivers(string $projectPath, string $homePath = ''): array
        {
            $directories = self::driverDirectories(Drivers\Support::path($projectPath), $homePath);
            $files = [];
            foreach ($directories as $directory) {
                foreach (self::driverFiles($directory) as $file) {
                    $files[$file] = true;
                }
            }
            if (!$files) {
                return [];
            }
            self::loadDriverFiles(array_keys($files));

            $candidates = [];
            foreach (array_keys($files) as $file) {
                foreach (isset(self::$loadedFiles[$file]) ? self::$loadedFiles[$file] : [] as $class) {
                    $reflection = self::driverClass($class, $file);
                    if ($reflection !== null) {
                        $candidates[strtolower($class)] = $reflection;
                    }
                }
            }

            $drivers = [];
            foreach (self::subclassesFirst(array_values($candidates)) as $reflection) {
                try {
                    $drivers[] = $reflection->newInstance();
                } catch (\Throwable $e) {
                    self::warn('Custom driver ' . $reflection->getName() . ' could not be created: ' . $e->getMessage());
                }
            }

            return $drivers;
        }

        /**
         * Folders with custom drivers, in priority order (existing folders only, as realpaths).
         *
         * @return string[]
         */
        public static function driverDirectories(string $projectPath, string $homePath = ''): array
        {
            $candidates = [];
            $home = self::homePath($homePath);
            if ($home !== '') {
                $candidates[] = $home . DIRECTORY_SEPARATOR . '.config' . DIRECTORY_SEPARATOR . 'tinkerbox' . DIRECTORY_SEPARATOR . 'drivers';
            }
            $projectPath = Drivers\Support::path($projectPath);
            if ($projectPath !== '') {
                $candidates[] = $projectPath . DIRECTORY_SEPARATOR . '.tinkerbox' . DIRECTORY_SEPARATOR . 'drivers';
            }
            $directories = [];
            foreach ($candidates as $directory) {
                $real = is_dir($directory) ? realpath($directory) : false;
                if ($real !== false && !in_array($real, $directories, true)) {
                    $directories[] = $real;
                }
            }

            return $directories;
        }

        /**
         * DriverInfo for the envelope: id, name, appVersion (version()), usesCollision (prettyErrors()),
         * logFilesPath (logsPath(), project-relative paths resolved). Every call is guarded: a custom driver that
         * throws yields a warning and the fallback value.
         *
         * @return array{id: string, name: string, appVersion: string|null, usesCollision: bool|null, logFilesPath: string|null}
         */
        public static function info(Driver $driver, string $projectPath = ''): array
        {
            $id = self::call($driver, 'id', null);
            $name = self::call($driver, 'name', null);
            $version = self::call($driver, 'version', null);
            $pretty = self::call($driver, 'prettyErrors', null);
            $logs = self::call($driver, 'logsPath', null, [$projectPath]);

            return [
                'id' => is_string($id) && $id !== '' ? $id : get_class($driver),
                'name' => is_string($name) && $name !== '' ? $name : get_class($driver),
                'appVersion' => is_string($version) && $version !== '' ? $version : null,
                'usesCollision' => is_bool($pretty) ? $pretty : null,
                'logFilesPath' => self::resolveLogPath($logs, $projectPath),
            ];
        }

        /**
         * Non-fatal problems collected while detecting drivers (reported as diagnostics).
         *
         * @return string[]
         */
        public static function warnings(): array
        {
            return self::$warnings;
        }

        /**
         * @param string $homePath
         * @return string
         */
        private static function homePath($homePath)
        {
            $home = (string) $homePath;
            if ($home === '') {
                foreach (['HOME', 'USERPROFILE'] as $name) {
                    $value = getenv($name);
                    if (is_string($value) && $value !== '') {
                        $home = $value;
                        break;
                    }
                }
            }
            if ($home === '' && getenv('HOMEDRIVE') !== false && getenv('HOMEPATH') !== false) {
                $home = getenv('HOMEDRIVE') . getenv('HOMEPATH');
            }

            return Drivers\Support::path($home);
        }

        /**
         * The *.php files of a driver folder (not recursive), sorted by name, bounded.
         *
         * @param string $directory
         * @return string[] realpaths
         */
        private static function driverFiles($directory)
        {
            // Unreadable folders are skipped: custom drivers are optional.
            $entries = @scandir($directory);
            if ($entries === false) {
                return [];
            }
            $files = [];
            foreach ($entries as $entry) {
                if ($entry === '' || $entry[0] === '.' || strtolower(substr($entry, -4)) !== '.php') {
                    continue;
                }
                $real = realpath($directory . DIRECTORY_SEPARATOR . $entry);
                if ($real !== false && is_file($real)) {
                    $files[] = $real;
                }
                if (count($files) >= self::MAX_DRIVER_FILES) {
                    break;
                }
            }
            sort($files, SORT_STRING);

            return $files;
        }

        /**
         * Require driver files. The classes and functions a file declares are read with the tokenizer first, so a
         * driver may extend a driver of another file regardless of the file order (a temporary autoloader loads it
         * on demand), and a file that would redeclare an existing class or function — or one an earlier driver
         * file declares (e.g. a global and a project driver copied from the same template) — is skipped with a
         * warning: redeclaring is an uncatchable fatal error that would break every run of the project.
         *
         * @param string[] $files
         * @return void
         */
        private static function loadDriverFiles(array $files)
        {
            $pending = [];
            $map = [];
            $pendingFunctions = [];
            foreach ($files as $file) {
                if (array_key_exists($file, self::$loadedFiles)) {
                    continue;
                }
                $declared = Drivers\Support::declaredClassesInFile($file);
                $collision = null;
                foreach ($declared as $class) {
                    if (class_exists($class, false) || interface_exists($class, false) || trait_exists($class, false) || isset($map[strtolower($class)])) {
                        $collision = 'class ' . $class;
                        break;
                    }
                }
                $functions = $collision === null ? Drivers\Support::declaredFunctionsInFile($file) : [];
                foreach ($functions as $function) {
                    if (function_exists($function) || isset($pendingFunctions[strtolower($function)])) {
                        $collision = 'function ' . $function . '()';
                        break;
                    }
                }
                if ($collision !== null) {
                    self::$loadedFiles[$file] = [];
                    self::warn('Custom driver file ' . $file . ' was skipped: ' . $collision . ' is already declared.');
                    continue;
                }
                foreach ($declared as $class) {
                    $map[strtolower($class)] = $file;
                }
                foreach ($functions as $function) {
                    $pendingFunctions[strtolower($function)] = $file;
                }
                $pending[] = $file;
            }
            if (!$pending) {
                return;
            }
            $loader = function ($class) use ($map) {
                $key = strtolower(ltrim($class, '\\'));
                if (isset($map[$key])) {
                    self::requireDriverFile($map[$key]);
                }
            };
            spl_autoload_register($loader, true, true);
            try {
                foreach ($pending as $file) {
                    self::requireDriverFile($file);
                }
            } finally {
                spl_autoload_unregister($loader);
            }
        }

        /**
         * @param string $file
         * @return void
         */
        private static function requireDriverFile($file)
        {
            if (array_key_exists($file, self::$loadedFiles)) {
                return;
            }
            self::$loadedFiles[$file] = [];
            $before = get_declared_classes();
            try {
                // Isolated scope: the driver file must not see (or overwrite) registry variables.
                $require = static function ($__file) {
                    require_once $__file;
                };
                $require($file);
            } catch (\Throwable $e) {
                self::warn('Custom driver file ' . $file . ' failed to load: ' . get_class($e) . ': ' . $e->getMessage());
            }
            self::$loadedFiles[$file] = array_values(array_diff(get_declared_classes(), $before));
        }

        /**
         * The reflection of a concrete driver class declared by a driver file, or null.
         *
         * @param string $class
         * @param string $file
         * @return \ReflectionClass|null
         */
        private static function driverClass($class, $file)
        {
            if (!class_exists($class, false) || !is_subclass_of($class, Driver::class)) {
                return null;
            }
            $reflection = new \ReflectionClass($class);
            if ($reflection->isAbstract() || !$reflection->isInstantiable()) {
                return null;
            }
            $declaredIn = $reflection->getFileName();
            if (!is_string($declaredIn) || realpath($declaredIn) !== $file) {
                return null; // e.g. a class created by eval() inside the driver file
            }
            $constructor = $reflection->getConstructor();
            if ($constructor !== null && $constructor->getNumberOfRequiredParameters() > 0) {
                self::warn('Custom driver ' . $class . ' was skipped: its constructor requires arguments.');

                return null;
            }

            return $reflection;
        }

        /**
         * Stable order where every class comes before the classes it extends.
         *
         * @param \ReflectionClass[] $reflections
         * @return \ReflectionClass[]
         */
        private static function subclassesFirst(array $reflections)
        {
            $ordered = [];
            foreach ($reflections as $reflection) {
                $position = count($ordered);
                foreach ($ordered as $index => $existing) {
                    if ($reflection->isSubclassOf($existing->getName())) {
                        $position = $index;
                        break;
                    }
                }
                array_splice($ordered, $position, 0, [$reflection]);
            }

            return $ordered;
        }

        /**
         * The driver for a forced id: custom drivers first (by id() or class name), then the built-ins.
         *
         * @param string $forcedId
         * @param Driver[] $custom
         * @return Driver|null
         */
        private static function forced($forcedId, array $custom)
        {
            foreach (array_merge($custom, self::builtins()) as $driver) {
                $class = get_class($driver);
                $short = ($pos = strrpos($class, '\\')) === false ? $class : substr($class, $pos + 1);
                if (self::call($driver, 'id', null) === $forcedId || strcasecmp($class, $forcedId) === 0 || strcasecmp($short, $forcedId) === 0) {
                    return $driver;
                }
            }

            return null;
        }

        /**
         * @param Driver $driver
         * @param string $projectPath
         * @return bool
         */
        private static function canBootstrap(Driver $driver, $projectPath)
        {
            try {
                return $driver->canBootstrap($projectPath);
            } catch (\Throwable $e) {
                self::warn(get_class($driver) . '::canBootstrap() failed: ' . $e->getMessage());

                return false;
            }
        }

        /**
         * @param Driver $driver
         * @param string $method
         * @param mixed $fallback
         * @param array $args
         * @return mixed
         */
        private static function call(Driver $driver, $method, $fallback, array $args = [])
        {
            try {
                return call_user_func_array([$driver, $method], $args);
            } catch (\Throwable $e) {
                self::warn(get_class($driver) . '::' . $method . '() failed: ' . $e->getMessage());

                return $fallback;
            }
        }

        /**
         * Absolute log folder for a logsPath() result: existing folders as they are, other paths relative to the
         * project ("storage/logs" and "/storage/logs" both mean <project>/storage/logs when that folder exists).
         *
         * @param mixed $path
         * @param string $projectPath
         * @return string|null
         */
        private static function resolveLogPath($path, $projectPath)
        {
            if (!is_string($path) || $path === '') {
                return null;
            }
            $absolute = Drivers\Support::isAbsolute($path);
            if ($absolute && is_dir($path)) {
                return Drivers\Support::path($path);
            }
            $projectPath = Drivers\Support::path($projectPath);
            if ($projectPath !== '') {
                $relative = $projectPath . DIRECTORY_SEPARATOR . ltrim($path, '/\\');
                if (!$absolute || is_dir($relative)) {
                    return $relative;
                }
            }

            return $path;
        }

        /**
         * @param string $message
         * @return void
         */
        private static function warn($message)
        {
            if (!in_array($message, self::$warnings, true)) {
                self::$warnings[] = $message;
            }
        }
    }
}
