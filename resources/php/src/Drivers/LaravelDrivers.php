<?php

namespace Tinkerbox\Drivers {
    /**
     * Laravel: a project with `artisan` and `bootstrap/app.php`. Boots the application like `php artisan` does
     * (bootstrap/app.php + the console kernel's bootstrappers), so facades, configuration, service providers and
     * Eloquent are ready.
     *
     * Subclasses that boot Laravel differently override createApplication(); application() returns the running
     * application to every method. With the forced id "laravel-booted" (alreadyBooted()) an application that is
     * already running in the process (Vapor, Laravel Cloud commands) is reused instead of booting a second one.
     */
    class LaravelDriver extends Driver
    {
        /** @var object|null Illuminate\Foundation\Application */
        private $app;

        /** @var string */
        private $root = '';

        /** @var bool reuse the application that is already running */
        private $reuseRunningApp = false;

        /**
         * A Laravel driver for an application that is already booted in this process (forced id "laravel-booted").
         */
        public static function alreadyBooted(): self
        {
            $driver = new static();
            $driver->reuseRunningApp = true;

            return $driver;
        }

        public function id(): string
        {
            return 'laravel';
        }

        public function name(): string
        {
            return 'Laravel';
        }

        public function canBootstrap(string $projectPath): bool
        {
            return is_file($projectPath . '/artisan') && is_file($projectPath . '/bootstrap/app.php');
        }

        public function bootstrap(string $projectPath): void
        {
            $this->root = Support::path($projectPath);
            if ($this->reuseRunningApp) {
                $running = Laravel::runningApp();
                if ($running !== null) {
                    $this->app = $running;

                    return;
                }
                if ($this->root === '' || !is_file($this->root . '/bootstrap/app.php')) {
                    throw new \RuntimeException('A running Laravel application was expected (Vapor / Laravel Cloud), but none was found.');
                }
            }
            $app = $this->createApplication($this->root);
            $this->app = is_object($app) ? $app : null;
        }

        public function version(): ?string
        {
            $app = $this->application();

            return $app === null ? null : 'Laravel ' . $app->version();
        }

        public function variables(): array
        {
            $app = $this->application();

            return $app === null ? [] : ['app' => $app];
        }

        public function listenForQueries(callable $listener): void
        {
            Laravel::listen($this->application(), $listener);
        }

        /**
         * "App Information" from `artisan about` (configuration values on older versions).
         */
        public function panels(string $projectPath): array
        {
            $panel = \Tinkerbox\Panels\StandardPanels::laravel($this->application());

            return $panel === null ? parent::panels($projectPath) : [$panel];
        }

        public function logsPath(string $projectPath): ?string
        {
            $app = $this->application();
            if ($app !== null && method_exists($app, 'storagePath')) {
                return rtrim((string) $app->storagePath(), '/\\') . DIRECTORY_SEPARATOR . 'logs';
            }
            $root = $this->root !== '' ? $this->root : Support::path($projectPath);

            return $root === '' ? null : $root . DIRECTORY_SEPARATOR . 'storage' . DIRECTORY_SEPARATOR . 'logs';
        }

        public function models(): array
        {
            return Laravel::models($this->application(), $this->root);
        }

        protected function ignoredFolders(): array
        {
            return ['public', 'storage', 'bootstrap/cache'];
        }

        /**
         * Boot the application of a project and return it.
         *
         * @param string $projectPath
         * @return object Illuminate\Foundation\Application
         */
        protected function createApplication(string $projectPath)
        {
            return Laravel::boot($projectPath);
        }

        /**
         * The application booted by this driver, else the one running in the process (or null).
         *
         * @return object|null
         */
        protected function application()
        {
            if ($this->app === null) {
                $this->app = Laravel::runningApp();
            }

            return $this->app;
        }

        /**
         * The project folder bootstrap() was called with ('' before bootstrapping).
         */
        protected function projectRoot(): string
        {
            return $this->root;
        }

        /**
         * "<name> <version> (Laravel <framework version>)" for Laravel-based products.
         *
         * @param string $name
         * @param string|null $version
         * @return string|null
         */
        protected function productLabel(string $name, ?string $version): ?string
        {
            $app = $this->application();
            if ($app === null) {
                return null;
            }
            $framework = Laravel::frameworkVersion($app);

            return Support::label($name, $version, $framework === null ? null : 'Laravel ' . $framework);
        }
    }

    /**
     * Statamic: a Laravel application with statamic/cms installed.
     */
    class StatamicDriver extends LaravelDriver
    {
        public function id(): string
        {
            return 'statamic';
        }

        public function name(): string
        {
            return 'Statamic';
        }

        public function canBootstrap(string $projectPath): bool
        {
            return parent::canBootstrap($projectPath) && is_dir(Support::vendorDir($projectPath) . '/statamic/cms');
        }

        public function version(): ?string
        {
            // Composer metadata: Statamic::version() resolves through a real-time facade that writes a cache file.
            return $this->productLabel('Statamic', Support::packageVersion($this->projectRoot(), 'statamic/cms'));
        }
    }

    /**
     * October CMS (v1 – v3): a Laravel application with the `modules/system` module and october/rain or
     * october/system installed.
     */
    class OctoberDriver extends LaravelDriver
    {
        public function id(): string
        {
            return 'october';
        }

        public function name(): string
        {
            return 'October CMS';
        }

        public function canBootstrap(string $projectPath): bool
        {
            if (!parent::canBootstrap($projectPath) || !is_dir($projectPath . '/modules/system')) {
                return false;
            }
            $vendor = Support::vendorDir($projectPath);

            return is_dir($vendor . '/october/rain') || is_dir($vendor . '/october/system')
                || Support::composerRequires($projectPath, 'october/rain') || Support::composerRequires($projectPath, 'october/all');
        }

        public function version(): ?string
        {
            $root = $this->projectRoot();
            $version = Support::packageVersion($root, 'october/system');

            return $this->productLabel('October CMS', $version !== null ? $version : Support::packageVersion($root, 'october/rain'));
        }

        protected function ignoredFolders(): array
        {
            return ['public', 'storage', 'modules'];
        }
    }

    /**
     * Laravel Zero console applications: bootstrap/app.php with laravel-zero/framework installed and no web front
     * controller.
     */
    class LaravelZeroDriver extends LaravelDriver
    {
        public function id(): string
        {
            return 'laravel-zero';
        }

        public function name(): string
        {
            return 'Laravel Zero';
        }

        public function canBootstrap(string $projectPath): bool
        {
            return is_file($projectPath . '/bootstrap/app.php')
                && is_dir(Support::vendorDir($projectPath) . '/laravel-zero/framework')
                && !is_file($projectPath . '/public/index.php');
        }

        public function version(): ?string
        {
            $version = defined('LaravelZero\Framework\Application::VERSION')
                ? (string) constant('LaravelZero\Framework\Application::VERSION')
                : Support::packageVersion($this->projectRoot(), 'laravel-zero/framework');

            return $this->productLabel('Laravel Zero', $version);
        }

        /**
         * Console applications usually log nowhere: only an existing storage/logs folder is offered.
         */
        public function logsPath(string $projectPath): ?string
        {
            $path = parent::logsPath($projectPath);

            return $path !== null && is_dir($path) ? $path : null;
        }

        protected function ignoredFolders(): array
        {
            return ['storage', 'builds'];
        }
    }

    /**
     * Lumen: bootstrap/app.php with laravel/lumen-framework installed. The application is booted without handling a
     * request.
     */
    class LumenDriver extends LaravelDriver
    {
        public function id(): string
        {
            return 'lumen';
        }

        public function name(): string
        {
            return 'Lumen';
        }

        public function canBootstrap(string $projectPath): bool
        {
            return is_file($projectPath . '/bootstrap/app.php') && is_dir(Support::vendorDir($projectPath) . '/laravel/lumen-framework');
        }

        public function version(): ?string
        {
            $app = $this->application();
            if ($app === null) {
                return null;
            }
            // Lumen reports "Lumen (10.0.4) (Laravel Components ^10.0)".
            $version = (string) $app->version();

            return preg_match('/^Lumen \(([^)]+)\)/', $version, $match) ? 'Lumen ' . $match[1] : $version;
        }

        protected function createApplication(string $projectPath)
        {
            Support::requireAutoload($projectPath);
            Support::assertFile($projectPath . '/bootstrap/app.php', 'Lumen');
            $app = require $projectPath . '/bootstrap/app.php';
            if (!is_object($app) || !method_exists($app, 'make')) {
                throw new \RuntimeException($projectPath . '/bootstrap/app.php did not return a Lumen application instance.');
            }
            // Resolving the console kernel registers the facades / Eloquent setup a console process needs.
            if (method_exists($app, 'bound') && $app->bound('Illuminate\Contracts\Console\Kernel')) {
                $app->make('Illuminate\Contracts\Console\Kernel');
            }
            if (method_exists($app, 'boot')) {
                $app->boot();
            }

            return $app;
        }
    }

    /**
     * Laravel package development with Orchestra Testbench: a package (no application of its own) with
     * orchestra/testbench-core installed. Boots the Testbench skeleton application configured by the package's
     * testbench.yaml, the same application `vendor/bin/testbench` runs.
     */
    class TestbenchDriver extends LaravelDriver
    {
        public function id(): string
        {
            return 'testbench';
        }

        public function name(): string
        {
            return 'Testbench';
        }

        public function canBootstrap(string $projectPath): bool
        {
            return !is_file($projectPath . '/public/index.php')
                && is_dir(Support::vendorDir($projectPath) . '/orchestra/testbench-core/laravel');
        }

        public function version(): ?string
        {
            $root = $this->projectRoot();
            $version = Support::packageVersion($root, 'orchestra/testbench-core');

            return $this->productLabel('Testbench', $version !== null ? $version : Support::packageVersion($root, 'orchestra/testbench'));
        }

        protected function createApplication(string $projectPath)
        {
            Support::requireAutoload($projectPath);
            $configClass = 'Orchestra\Testbench\Foundation\Config';
            $applicationClass = 'Orchestra\Testbench\Foundation\Application';
            $commanderClass = 'Orchestra\Testbench\Console\Commander';
            $config = class_exists($configClass) && method_exists($configClass, 'loadFromYaml')
                ? $configClass::loadFromYaml($projectPath)
                : null;
            if ($config !== null && class_exists($applicationClass) && method_exists($applicationClass, 'createFromConfig')) {
                return $applicationClass::createFromConfig($config);
            }
            if ($config !== null && class_exists($commanderClass) && method_exists($commanderClass, 'laravel')) {
                return (new $commanderClass($config, $projectPath))->laravel();
            }
            if (class_exists($applicationClass) && method_exists($applicationClass, 'create')) {
                return $applicationClass::create();
            }

            throw new \RuntimeException('orchestra/testbench is installed but no supported Testbench application factory was found.');
        }
    }
}
