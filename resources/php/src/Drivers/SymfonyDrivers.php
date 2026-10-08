<?php

namespace Tinkerbox\Drivers {
    /**
     * Symfony (3.4 – 7.x): `bin/console` plus a kernel class and the framework bundle. Loads the .env files and
     * boots the kernel the way bin/console does; `$kernel` and `$container` are available in the editor and Doctrine
     * DBAL 2/3 connections report their queries.
     */
    class SymfonyDriver extends Driver
    {
        /** @var object|null Symfony\Component\HttpKernel\KernelInterface */
        private $kernel;

        /** @var string */
        private $root = '';

        public function id(): string
        {
            return 'symfony';
        }

        public function name(): string
        {
            return 'Symfony';
        }

        public function canBootstrap(string $projectPath): bool
        {
            if (!is_file($projectPath . '/bin/console')) {
                return false;
            }
            $vendor = Support::vendorDir($projectPath);

            return (is_file($projectPath . '/src/Kernel.php') || is_file($projectPath . '/app/AppKernel.php'))
                && (is_dir($vendor . '/symfony/framework-bundle') || is_dir($vendor . '/symfony/symfony')
                    || Support::composerRequires($projectPath, 'symfony/framework-bundle'));
        }

        public function bootstrap(string $projectPath): void
        {
            $this->root = Support::path($projectPath);
            $path = $this->root;
            Support::requireAutoload($path);
            if (is_file($path . '/config/bootstrap.php')) {
                // Symfony 4.x recipe: loads .env and sets APP_ENV / APP_DEBUG itself.
                require_once $path . '/config/bootstrap.php';
            } else {
                Support::bootSymfonyEnv($path);
            }
            $env = isset($_SERVER['APP_ENV']) ? (string) $_SERVER['APP_ENV'] : (isset($_ENV['APP_ENV']) ? (string) $_ENV['APP_ENV'] : 'dev');
            $debug = isset($_SERVER['APP_DEBUG']) ? (bool) $_SERVER['APP_DEBUG'] : ($env !== 'prod');
            $class = $this->kernelClass($path);
            $kernel = new $class($env, $debug);
            $kernel->boot();
            $this->kernel = $kernel;
        }

        public function variables(): array
        {
            if ($this->kernel === null) {
                return [];
            }

            return ['kernel' => $this->kernel, 'container' => $this->kernel->getContainer()];
        }

        public function version(): ?string
        {
            return defined('Symfony\Component\HttpKernel\Kernel::VERSION')
                ? 'Symfony ' . constant('Symfony\Component\HttpKernel\Kernel::VERSION')
                : null;
        }

        public function panels(string $projectPath): array
        {
            $kernel = $this->kernel;
            if ($kernel === null) {
                return parent::panels($projectPath);
            }
            $read = function ($method) use ($kernel) {
                try {
                    return method_exists($kernel, $method) ? $kernel->{$method}() : null;
                } catch (\Throwable $e) {
                    return null;
                }
            };
            $bundles = $read('getBundles');

            return [\Tinkerbox\Panels\Panel::make(\Tinkerbox\Panels\StandardPanels::APP_INFORMATION)->sections([
                'Symfony' => \Tinkerbox\Panels\StandardPanels::present([
                    'Version' => defined('Symfony\Component\HttpKernel\Kernel::VERSION') ? constant('Symfony\Component\HttpKernel\Kernel::VERSION') : null,
                    'Environment' => $read('getEnvironment'),
                    'Debug' => $read('isDebug'),
                    'Kernel' => get_class($kernel),
                    'Project Directory' => $read('getProjectDir'),
                    'Cache Directory' => $read('getCacheDir'),
                    'Log Directory' => $read('getLogDir'),
                    'Bundles' => is_array($bundles) && $bundles ? implode(', ', array_keys($bundles)) : null,
                ]),
                'PHP' => \Tinkerbox\Panels\StandardPanels::phpRows(),
            ])->toArray()];
        }

        public function logsPath(string $projectPath): ?string
        {
            if ($this->kernel !== null && method_exists($this->kernel, 'getLogDir')) {
                return (string) $this->kernel->getLogDir();
            }
            $root = $this->root !== '' ? $this->root : Support::path($projectPath);
            if ($root === '') {
                return null;
            }

            // Symfony 3.x wrote to var/logs, newer versions to var/log.
            return is_dir($root . '/var/logs') && !is_dir($root . '/var/log') ? $root . '/var/logs' : $root . '/var/log';
        }

        /**
         * Doctrine DBAL 2/3 connections of the "doctrine" registry (DBAL 4 cannot be observed after boot).
         */
        public function listenForQueries(callable $listener): void
        {
            if ($this->kernel === null) {
                return;
            }
            try {
                $container = $this->kernel->getContainer();
                if (!$container->has('doctrine')) {
                    return;
                }
                foreach ($container->get('doctrine')->getConnections() as $name => $connection) {
                    Support::attachDoctrineLogger($connection, (string) $name, $listener);
                }
            } catch (\Throwable $e) {
                // Query capture is optional; a misconfigured Doctrine setup must not break the run.
                return;
            }
        }

        protected function ignoredFolders(): array
        {
            return ['var', 'public'];
        }

        /**
         * The booted kernel (null before bootstrap()).
         *
         * @return object|null
         */
        protected function kernel()
        {
            return $this->kernel;
        }

        /**
         * The kernel class of the project: App\Kernel (Flex), AppKernel (3.x) or the class in src/Kernel.php.
         *
         * @param string $path
         * @return string
         */
        protected function kernelClass(string $path): string
        {
            if (class_exists('App\Kernel')) {
                return 'App\Kernel';
            }
            if (!class_exists('AppKernel') && is_file($path . '/app/AppKernel.php')) {
                require_once $path . '/app/AppKernel.php';
            }
            if (class_exists('AppKernel')) {
                return 'AppKernel';
            }
            foreach (Support::declaredClassesInFile($path . '/src/Kernel.php') as $class) {
                if (class_exists($class) && is_subclass_of($class, 'Symfony\Component\HttpKernel\KernelInterface')) {
                    return $class;
                }
            }
            throw new \RuntimeException('No Symfony kernel class found (expected App\Kernel in src/Kernel.php).');
        }
    }

    /**
     * Shopware 6 (a Symfony kernel built by Shopware's KernelFactory) and Shopware 5 (shopware.php). Every service of
     * the container is kept public so repositories can be fetched by id in the editor.
     */
    class ShopwareDriver extends Driver
    {
        /** @var object|null */
        private $kernel;

        /** @var string */
        private $root = '';

        /** @var int 5 or 6 */
        private $major = 6;

        /** @var string APP_ENV the kernel was booted with */
        private $env = 'prod';

        public function id(): string
        {
            return 'shopware';
        }

        public function name(): string
        {
            return 'Shopware';
        }

        public function canBootstrap(string $projectPath): bool
        {
            return self::isShopware6($projectPath) || self::isShopware5($projectPath);
        }

        /**
         * `bin/console` with shopware/core (or the platform monorepo) installed, or the platform repository itself.
         */
        public static function isShopware6(string $projectPath): bool
        {
            if (!is_file($projectPath . '/bin/console')) {
                return false;
            }
            $vendor = Support::vendorDir($projectPath);

            return is_dir($vendor . '/shopware/core') || is_dir($vendor . '/shopware/platform') || is_file($projectPath . '/src/Core/Kernel.php');
        }

        public static function isShopware5(string $projectPath): bool
        {
            return is_file($projectPath . '/shopware.php') && is_dir($projectPath . '/engine/Shopware');
        }

        public function bootstrap(string $projectPath): void
        {
            $this->root = Support::path($projectPath);
            $path = $this->root;
            if (!self::isShopware6($path) && self::isShopware5($path)) {
                $this->major = 5;
                Support::assertFile($path . '/autoload.php', 'Shopware 5');
                require_once $path . '/autoload.php';
                $env = getenv('SHOPWARE_ENV') ?: (getenv('REDIRECT_SHOPWARE_ENV') ?: 'production');
                $this->env = (string) $env;
                $kernel = new \Shopware\Kernel($env, false);
                $kernel->boot();
                $this->kernel = $kernel;

                return;
            }

            $classLoader = Support::requireAutoload($path);
            // bin/console semantics: putenv() enabled, "prod" and "e2e" count as production environments.
            Support::bootSymfonyEnv($path, true, ['prod', 'e2e']);
            $env = isset($_SERVER['APP_ENV']) ? (string) $_SERVER['APP_ENV'] : 'prod';
            $debug = isset($_SERVER['APP_DEBUG']) ? (bool) $_SERVER['APP_DEBUG'] : ($env !== 'prod');
            $this->env = $env;
            $factory = 'Shopware\Core\Framework\Adapter\Kernel\KernelFactory';
            if (class_exists($factory)) {
                // Shopware 6.5+: the factory builds the kernel class configured in KernelFactory::$kernelClass.
                $previous = null;
                if (property_exists($factory, 'kernelClass')) {
                    $previous = $factory::$kernelClass;
                    $factory::$kernelClass = Support::publicServicesKernel($previous);
                }
                try {
                    $kernel = $factory::create($env, $debug, $classLoader);
                } finally {
                    if ($previous !== null) {
                        $factory::$kernelClass = $previous;
                    }
                }
            } else {
                // Shopware 6.0 – 6.4 (production template)
                $connection = \Shopware\Core\Kernel::getConnection();
                $pluginLoader = new \Shopware\Core\Framework\Plugin\KernelPluginLoader\DbalKernelPluginLoader($classLoader, null, $connection);
                $cacheIdLoader = 'Shopware\Core\Framework\Adapter\Cache\CacheIdLoader';
                $cacheId = class_exists($cacheIdLoader) ? (new $cacheIdLoader($connection))->load() : 'tinkerbox';
                $version = $this->installedVersion();
                if ($version === null) {
                    $version = defined('Shopware\Core\Kernel::SHOPWARE_FALLBACK_VERSION') ? (string) constant('Shopware\Core\Kernel::SHOPWARE_FALLBACK_VERSION') : '6.0.0';
                }
                $kernelClass = Support::publicServicesKernel(class_exists('Shopware\Production\Kernel') ? 'Shopware\Production\Kernel' : 'Shopware\Core\Kernel');
                $kernel = new $kernelClass($env, $debug, $pluginLoader, $cacheId, $version, $connection, $path);
            }
            $kernel->boot();
            $this->kernel = $kernel;
        }

        public function variables(): array
        {
            if ($this->kernel === null) {
                return [];
            }
            $container = $this->kernel->getContainer();
            $variables = ['kernel' => $this->kernel, 'container' => $container];
            $registry = 'Shopware\Core\Framework\DataAbstractionLayer\DefinitionInstanceRegistry';
            try {
                if ($this->major === 6 && $container->has($registry)) {
                    $variables['definitions'] = $container->get($registry);
                }
            } catch (\Throwable $e) {
                // Private service in this Shopware version: not exposed.
                unset($variables['definitions']);
            }

            return $variables;
        }

        /**
         * "Shopware 6.6.4.0 (prod)" / "Shopware 5.7.19".
         */
        public function version(): ?string
        {
            if ($this->kernel === null) {
                return null;
            }
            if ($this->major === 5) {
                $container = $this->kernel->getContainer();
                $version = $container->hasParameter('shopware.release.version') ? (string) $container->getParameter('shopware.release.version') : null;

                return Support::label('Shopware', $version);
            }

            return Support::label('Shopware', $this->installedVersion(), $this->env);
        }

        public function logsPath(string $projectPath): ?string
        {
            if ($this->kernel !== null && method_exists($this->kernel, 'getLogDir')) {
                return (string) $this->kernel->getLogDir();
            }
            $root = $this->root !== '' ? $this->root : Support::path($projectPath);

            return $root === '' ? null : $root . '/var/log';
        }

        public function listenForQueries(callable $listener): void
        {
            if ($this->kernel === null || $this->major !== 6) {
                return;
            }
            try {
                $container = $this->kernel->getContainer();
                if ($container->has('Doctrine\DBAL\Connection')) {
                    Support::attachDoctrineLogger($container->get('Doctrine\DBAL\Connection'), 'default', $listener);
                }
            } catch (\Throwable $e) {
                // Optional feature (DBAL 4 / private service).
                return;
            }
        }

        protected function ignoredFolders(): array
        {
            return ['var', 'public', 'files'];
        }

        /**
         * Installed shopware/core (or shopware/platform) version.
         *
         * @return string|null
         */
        private function installedVersion()
        {
            $version = Support::packageVersion($this->root, 'shopware/core');

            return $version !== null ? $version : Support::packageVersion($this->root, 'shopware/platform');
        }
    }
}
