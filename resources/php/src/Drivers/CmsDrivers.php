<?php

namespace Tinkerbox\Drivers {
    /**
     * Drupal 8 and newer: core/lib/Drupal.php in the project or its web/, docroot/, html/ or public/ folder. Boots
     * the DrupalKernel for a request to the default site (like Drush): `$kernel` and `$container` are available and
     * database queries are read from Drupal's query log.
     */
    class DrupalDriver extends Driver
    {
        /** Folders (relative to the project) that may be the Drupal root. */
        const ROOT_FOLDERS = ['', '/web', '/docroot', '/html', '/public'];

        /** @var object|null Drupal\Core\DrupalKernel */
        private $kernel;

        /** @var DrupalQueryLog|null */
        private $queryLog;

        public function id(): string
        {
            return 'drupal';
        }

        public function name(): string
        {
            return 'Drupal';
        }

        public function canBootstrap(string $projectPath): bool
        {
            return $this->drupalRoot($projectPath) !== null;
        }

        public function bootstrap(string $projectPath): void
        {
            $root = $this->drupalRoot($projectPath);
            if ($root === null) {
                throw new \RuntimeException('No Drupal installation (core/lib/Drupal.php) found in ' . $projectPath . '.');
            }
            chdir($root);
            $server = [
                'SCRIPT_NAME' => '/index.php',
                'SCRIPT_FILENAME' => $root . '/index.php',
                'PHP_SELF' => '/index.php',
                'REQUEST_URI' => '/',
                'REMOTE_ADDR' => '127.0.0.1',
                'REQUEST_METHOD' => 'GET',
            ];
            Support::setServerVars($server, true);
            Support::setServerVars(['HTTP_HOST' => 'default', 'SERVER_NAME' => 'default']);
            Support::assertFile($root . '/autoload.php', 'Drupal');
            $autoloader = require $root . '/autoload.php';
            $request = \Symfony\Component\HttpFoundation\Request::create('http://' . $_SERVER['HTTP_HOST'] . '/', 'GET', [], [], [], $server);
            $kernel = \Drupal\Core\DrupalKernel::createFromRequest($request, $autoloader, 'prod');
            $kernel->boot();
            if (method_exists($kernel, 'preHandle')) {
                $kernel->preHandle($request);
            } elseif (method_exists($kernel, 'prepareLegacyRequest')) {
                $kernel->prepareLegacyRequest($request);
            }
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
            return defined('Drupal::VERSION') ? 'Drupal ' . constant('Drupal::VERSION') : null;
        }

        public function panels(string $projectPath): array
        {
            $kernel = $this->kernel;
            if ($kernel === null) {
                return parent::panels($projectPath);
            }

            return [\Tinkerbox\Panels\Panel::make(\Tinkerbox\Panels\StandardPanels::APP_INFORMATION)->sections([
                'Drupal' => \Tinkerbox\Panels\StandardPanels::present([
                    'Version' => defined('Drupal::VERSION') ? constant('Drupal::VERSION') : null,
                    'Site Path' => method_exists($kernel, 'getSitePath') ? $kernel->getSitePath() : null,
                    'App Root' => method_exists($kernel, 'getAppRoot') ? $kernel->getAppRoot() : null,
                ]),
                'PHP' => \Tinkerbox\Panels\StandardPanels::phpRows(),
            ])->toArray()];
        }

        public function listenForQueries(callable $listener): void
        {
            $this->queryLog = DrupalQueryLog::start('Drupal\Core\Database\Database', $listener);
        }

        public function afterRun(): void
        {
            if ($this->queryLog !== null) {
                $this->queryLog->flush();
            }
        }

        protected function ignoredFolders(): array
        {
            $folders = [];
            foreach (self::ROOT_FOLDERS as $folder) {
                $prefix = ltrim($folder, '/');
                foreach (['core', 'sites/default/files', 'sites/simpletest'] as $ignored) {
                    $folders[] = ($prefix === '' ? '' : $prefix . '/') . $ignored;
                }
            }

            return $folders;
        }

        /**
         * The Drupal root (folder containing core/), or null.
         *
         * @param string $projectPath
         * @return string|null
         */
        protected function drupalRoot(string $projectPath)
        {
            $projectPath = Support::path($projectPath);
            if ($projectPath === '') {
                return null;
            }
            foreach (self::ROOT_FOLDERS as $folder) {
                if (is_file($projectPath . $folder . '/core/lib/Drupal.php')) {
                    return $projectPath . $folder;
                }
            }

            return null;
        }
    }

    /**
     * Drupal 7: includes/bootstrap.inc and modules/system (never a Drupal 8+ root). Runs the full bootstrap of
     * index.php (drupal_bootstrap(DRUPAL_BOOTSTRAP_FULL)); `$user` is the current (anonymous) user.
     */
    class Drupal7Driver extends Driver
    {
        /** @var bool */
        private $booted = false;

        /** @var DrupalQueryLog|null */
        private $queryLog;

        public function id(): string
        {
            return 'drupal7';
        }

        public function name(): string
        {
            return 'Drupal 7';
        }

        public function canBootstrap(string $projectPath): bool
        {
            return $this->drupalRoot($projectPath) !== null;
        }

        public function bootstrap(string $projectPath): void
        {
            $root = $this->drupalRoot($projectPath);
            if ($root === null) {
                throw new \RuntimeException('No Drupal 7 installation (includes/bootstrap.inc) found in ' . $projectPath . '.');
            }
            chdir($root);
            if (!defined('DRUPAL_ROOT')) {
                define('DRUPAL_ROOT', $root);
            }
            // Drupal 7 derives base_path() and the site folder from the request.
            Support::setServerVars([
                'SCRIPT_NAME' => '/index.php',
                'PHP_SELF' => '/index.php',
                'SCRIPT_FILENAME' => $root . '/index.php',
                'REQUEST_URI' => '/',
                'REMOTE_ADDR' => '127.0.0.1',
                'REQUEST_METHOD' => 'GET',
                'SERVER_SOFTWARE' => null,
                'HTTP_USER_AGENT' => null,
            ], true);
            Support::setServerVars(['HTTP_HOST' => 'default']);
            Support::assertFile(DRUPAL_ROOT . '/includes/bootstrap.inc', 'Drupal 7');
            require_once DRUPAL_ROOT . '/includes/bootstrap.inc';
            drupal_bootstrap(constant('DRUPAL_BOOTSTRAP_FULL'));
            $this->booted = true;
        }

        public function variables(): array
        {
            return $this->booted && isset($GLOBALS['user']) ? ['user' => $GLOBALS['user']] : [];
        }

        public function version(): ?string
        {
            return defined('VERSION') ? 'Drupal ' . constant('VERSION') : null;
        }

        public function listenForQueries(callable $listener): void
        {
            $this->queryLog = DrupalQueryLog::start('Database', $listener);
        }

        public function afterRun(): void
        {
            if ($this->queryLog !== null) {
                $this->queryLog->flush();
            }
        }

        protected function ignoredFolders(): array
        {
            return ['includes', 'misc', 'modules', 'sites/default/files'];
        }

        /**
         * The Drupal 7 root, or null.
         *
         * @param string $projectPath
         * @return string|null
         */
        protected function drupalRoot(string $projectPath)
        {
            $projectPath = Support::path($projectPath);
            if ($projectPath === '') {
                return null;
            }
            foreach (DrupalDriver::ROOT_FOLDERS as $folder) {
                $root = $projectPath . $folder;
                if (is_file($root . '/includes/bootstrap.inc') && is_file($root . '/modules/system/system.module') && !is_file($root . '/core/lib/Drupal.php')) {
                    return $root;
                }
            }

            return null;
        }
    }

    /**
     * Craft CMS 3 – 5: the `craft` console script with craftcms/cms installed. Boots the console application the
     * way `./craft` does; `$craft` is the application (Craft::$app).
     */
    class CraftDriver extends Driver
    {
        /** @var object|null craft\console\Application */
        private $app;

        /** @var string */
        private $root = '';

        /** @var YiiQueryLog|null */
        private $queryLog;

        public function id(): string
        {
            return 'craft';
        }

        public function name(): string
        {
            return 'Craft CMS';
        }

        public function canBootstrap(string $projectPath): bool
        {
            return is_file($projectPath . '/craft')
                && (is_dir(Support::vendorDir($projectPath) . '/craftcms/cms') || Support::composerRequires($projectPath, 'craftcms/cms'));
        }

        public function bootstrap(string $projectPath): void
        {
            $this->root = Support::path($projectPath);
            $path = $this->root;
            if (is_file($path . '/bootstrap.php')) {
                // Craft 4+ projects: defines CRAFT_BASE_PATH / CRAFT_VENDOR_PATH, autoloads and loads .env.
                require_once $path . '/bootstrap.php';
            } else {
                // Craft 3 projects: the same steps inline.
                if (!defined('CRAFT_BASE_PATH')) {
                    define('CRAFT_BASE_PATH', $path);
                }
                if (!defined('CRAFT_VENDOR_PATH')) {
                    define('CRAFT_VENDOR_PATH', Support::vendorDir($path));
                }
                Support::requireAutoload($path);
                Support::loadPhpDotenv($path);
                if (!defined('CRAFT_ENVIRONMENT') && getenv('ENVIRONMENT') !== false) {
                    define('CRAFT_ENVIRONMENT', (string) getenv('ENVIRONMENT'));
                }
            }
            $vendor = defined('CRAFT_VENDOR_PATH') ? (string) constant('CRAFT_VENDOR_PATH') : Support::vendorDir($path);
            Support::assertFile($vendor . '/craftcms/cms/bootstrap/console.php', 'Craft CMS');
            $this->app = require $vendor . '/craftcms/cms/bootstrap/console.php';
        }

        public function variables(): array
        {
            $app = $this->craft();

            return $app === null ? [] : ['craft' => $app];
        }

        public function version(): ?string
        {
            $app = $this->craft();
            if ($app === null) {
                return null;
            }
            $version = isset($app->version) && is_scalar($app->version) ? (string) $app->version : '';
            if ($version === '' && method_exists($app, 'getVersion')) {
                $version = (string) $app->getVersion();
            }

            return Support::label('Craft CMS', $version);
        }

        public function logsPath(string $projectPath): ?string
        {
            $app = $this->craft();
            try {
                if ($app !== null && method_exists($app, 'getPath')) {
                    return (string) $app->getPath()->getLogPath();
                }
            } catch (\Throwable $e) {
                $app = null; // fall back to the default storage location
            }
            $root = $this->root !== '' ? $this->root : Support::path($projectPath);

            return $root === '' ? null : $root . '/storage/logs';
        }

        public function listenForQueries(callable $listener): void
        {
            $this->queryLog = YiiQueryLog::start($listener);
        }

        public function afterRun(): void
        {
            if ($this->queryLog !== null) {
                $this->queryLog->flush();
            }
        }

        protected function ignoredFolders(): array
        {
            return ['storage', 'web/cpresources'];
        }

        /**
         * @return object|null
         */
        protected function craft()
        {
            if ($this->app === null && class_exists('Craft', false) && isset(\Craft::$app)) {
                $this->app = \Craft::$app;
            }

            return is_object($this->app) ? $this->app : null;
        }
    }

    /**
     * Magento 2 / Adobe Commerce: an installed store (app/etc/env.php) with app/bootstrap.php. Creates the
     * application bootstrap and exposes its `$objectManager`. No area code is set by default; `$area->load('adminhtml')`
     * sets and loads one.
     */
    class Magento2Driver extends Driver
    {
        /** @var object|null Magento\Framework\ObjectManagerInterface */
        private $objectManager;

        /** @var string */
        private $root = '';

        /** @var object|null DB profiler */
        private $profiler;

        /** @var int */
        private $profiled = 0;

        /** @var callable|null */
        private $queryListener;

        public function id(): string
        {
            return 'magento2';
        }

        public function name(): string
        {
            return 'Magento';
        }

        public function canBootstrap(string $projectPath): bool
        {
            return is_file($projectPath . '/app/etc/env.php') && is_file($projectPath . '/app/bootstrap.php');
        }

        public function bootstrap(string $projectPath): void
        {
            $this->root = Support::path($projectPath);
            require_once $this->root . '/app/bootstrap.php';
            // Magento unregisters the phar:// stream wrapper; PHP tooling in the editor may need it.
            if (!in_array('phar', stream_get_wrappers(), true)) {
                stream_wrapper_restore('phar');
            }
            $bootstrap = \Magento\Framework\App\Bootstrap::create(constant('BP'), $_SERVER);
            $this->objectManager = $bootstrap->getObjectManager();
        }

        public function variables(): array
        {
            if ($this->objectManager === null) {
                return [];
            }

            return ['objectManager' => $this->objectManager, 'area' => new MagentoArea($this->objectManager)];
        }

        public function version(): ?string
        {
            if ($this->objectManager === null) {
                return null;
            }
            $metadata = $this->objectManager->get('Magento\Framework\App\ProductMetadataInterface');

            return 'Magento ' . $metadata->getVersion();
        }

        public function logsPath(string $projectPath): ?string
        {
            if (defined('BP')) {
                return constant('BP') . '/var/log';
            }
            $root = $this->root !== '' ? $this->root : Support::path($projectPath);

            return $root === '' ? null : $root . '/var/log';
        }

        /**
         * Enables the connection profiler and reports its profiles after the run.
         */
        public function listenForQueries(callable $listener): void
        {
            if ($this->objectManager === null) {
                return;
            }
            try {
                $connection = $this->objectManager->get('Magento\Framework\App\ResourceConnection')->getConnection();
                $profiler = $connection->getProfiler();
                if (!is_object($profiler) || !method_exists($profiler, 'setEnabled')) {
                    return;
                }
                $profiler->setEnabled(true);
                $profiles = $profiler->getQueryProfiles();
                $this->profiled = is_array($profiles) ? count($profiles) : 0;
                $this->profiler = $profiler;
                $this->queryListener = $listener;
            } catch (\Throwable $e) {
                // No database configured / profiler unavailable.
                return;
            }
        }

        public function afterRun(): void
        {
            if ($this->profiler === null || $this->queryListener === null) {
                return;
            }
            $profiles = $this->profiler->getQueryProfiles();
            $profiles = is_array($profiles) ? array_values($profiles) : [];
            $new = array_slice($profiles, $this->profiled);
            $this->profiled = count($profiles);
            foreach ($new as $profile) {
                $params = method_exists($profile, 'getQueryParams') ? (array) $profile->getQueryParams() : [];
                $seconds = method_exists($profile, 'getElapsedSecs') ? (float) $profile->getElapsedSecs() : 0.0;
                Support::emitQuery($this->queryListener, (string) $profile->getQuery(), $params, $seconds * 1000, 'default');
            }
        }

        protected function ignoredFolders(): array
        {
            return ['var', 'pub', 'generated', 'setup', 'dev', 'lib'];
        }
    }

    /**
     * The `$area` helper of the Magento driver: Magento code often needs an area (adminhtml, frontend, crontab, …).
     */
    final class MagentoArea
    {
        /** @var object */
        private $objectManager;

        /**
         * @param object $objectManager
         */
        public function __construct($objectManager)
        {
            $this->objectManager = $objectManager;
        }

        /**
         * The current area code, or null when none is set.
         */
        public function code(): ?string
        {
            try {
                $code = $this->objectManager->get('Magento\Framework\App\State')->getAreaCode();
            } catch (\Throwable $e) {
                return null; // "Area code is not set"
            }

            return is_string($code) && $code !== '' ? $code : null;
        }

        /**
         * Set the area code (when none is set yet) and load the area's configuration and translations.
         */
        public function load(string $area): string
        {
            if ($this->code() === null) {
                $this->objectManager->get('Magento\Framework\App\State')->setAreaCode($area);
            }
            $this->objectManager->configure($this->objectManager->get('Magento\Framework\ObjectManager\ConfigLoaderInterface')->load($area));
            $this->objectManager->get('Magento\Framework\App\AreaList')->getArea($area)
                ->load(\Magento\Framework\App\Area::PART_CONFIG)
                ->load(\Magento\Framework\App\Area::PART_TRANSLATE);

            return $area;
        }
    }

    /**
     * Kirby 3+: kirby/bootstrap.php (or getkirby/cms via Composer) next to a site/ or content/ folder, including
     * the "public folder" layout. `$kirby` and `$site` are available.
     */
    class KirbyDriver extends Driver
    {
        /** @var object|null Kirby\Cms\App */
        private $kirby;

        public function id(): string
        {
            return 'kirby';
        }

        public function name(): string
        {
            return 'Kirby';
        }

        public function canBootstrap(string $projectPath): bool
        {
            return $this->bootstrapFile($projectPath) !== null
                && (is_dir($projectPath . '/site') || is_dir($projectPath . '/content'));
        }

        public function bootstrap(string $projectPath): void
        {
            $path = Support::path($projectPath);
            // Kirby's global dump() helper would replace the editor's dump().
            if (!defined('KIRBY_HELPER_DUMP')) {
                define('KIRBY_HELPER_DUMP', false);
            }
            Support::requireAutoload($path, false);
            $bootstrap = $this->bootstrapFile($path);
            if ($bootstrap === null) {
                throw new \RuntimeException('Kirby was not found in ' . $path . ' (kirby/bootstrap.php).');
            }
            require_once $bootstrap;
            $roots = ['index' => $path];
            if (!is_file($path . '/index.php') && is_file($path . '/public/index.php')) {
                // "Public folder" setup: the web root is public/, everything else stays in the project.
                $roots = [
                    'index' => $path . '/public',
                    'base' => $path,
                    'content' => $path . '/content',
                    'site' => $path . '/site',
                    'storage' => $path . '/storage',
                    'accounts' => $path . '/storage/accounts',
                    'cache' => $path . '/storage/cache',
                    'sessions' => $path . '/storage/sessions',
                ];
            }
            $this->kirby = new \Kirby\Cms\App(['roots' => $roots]);
        }

        public function variables(): array
        {
            if ($this->kirby === null) {
                return [];
            }

            return ['kirby' => $this->kirby, 'site' => $this->kirby->site()];
        }

        public function version(): ?string
        {
            return class_exists('Kirby\Cms\App', false) ? 'Kirby ' . \Kirby\Cms\App::version() : null;
        }

        public function logsPath(string $projectPath): ?string
        {
            if ($this->kirby === null) {
                return null;
            }
            try {
                $logs = $this->kirby->root('logs');
            } catch (\Throwable $e) {
                return null; // Kirby versions without a "logs" root
            }

            return is_string($logs) && $logs !== '' ? $logs : null;
        }

        protected function ignoredFolders(): array
        {
            return ['kirby', 'media', 'content', 'storage', 'site/accounts', 'site/cache', 'site/sessions'];
        }

        /**
         * @param string $projectPath
         * @return string|null
         */
        private function bootstrapFile(string $projectPath)
        {
            foreach (['/kirby/bootstrap.php', '/vendor/getkirby/cms/bootstrap.php'] as $file) {
                if (is_file($projectPath . $file)) {
                    return $projectPath . $file;
                }
            }

            return null;
        }
    }

    /**
     * Moodle: config.php with Moodle's lib/moodlelib.php and version.php (at the root or, since Moodle 5.1, in
     * public/). Runs config.php as a CLI script; `$CFG` and `$DB` are available.
     */
    class MoodleDriver extends Driver
    {
        /** Moodle globals (config.php + lib/setup.php). */
        const GLOBALS = [
            'CFG', 'DB', 'SITE', 'USER', 'COURSE', 'PAGE', 'OUTPUT', 'SESSION', 'FULLME', 'ME', 'FULLSCRIPT', 'SCRIPT',
            'PERF', 'ACCESSLIB_PRIVATE',
        ];

        public function id(): string
        {
            return 'moodle';
        }

        public function name(): string
        {
            return 'Moodle';
        }

        public function canBootstrap(string $projectPath): bool
        {
            if (!is_file($projectPath . '/config.php')) {
                return false;
            }
            foreach (['', '/public'] as $folder) {
                if (is_file($projectPath . $folder . '/lib/moodlelib.php') && is_file($projectPath . $folder . '/version.php')) {
                    return true;
                }
            }

            return false;
        }

        public function bootstrap(string $projectPath): void
        {
            if (!defined('CLI_SCRIPT')) {
                define('CLI_SCRIPT', true);
            }
            Support::requireWithGlobals(Support::path($projectPath) . '/config.php', self::GLOBALS);
        }

        public function variables(): array
        {
            $variables = [];
            foreach (['CFG', 'DB'] as $name) {
                if (isset($GLOBALS[$name]) && is_object($GLOBALS[$name])) {
                    $variables[$name] = $GLOBALS[$name];
                }
            }

            return $variables;
        }

        public function version(): ?string
        {
            return isset($GLOBALS['CFG']) && is_object($GLOBALS['CFG']) && isset($GLOBALS['CFG']->release)
                ? 'Moodle ' . $GLOBALS['CFG']->release
                : null;
        }

        protected function ignoredFolders(): array
        {
            return ['lib', 'public/lib', 'cache', 'localcache', 'sessions', 'temp'];
        }
    }

    /**
     * PrestaShop 1.6 – 8: config/config.inc.php with the PrestaShop classes. Loads the configuration like a front
     * request; `$context` is the shop context.
     */
    class PrestaShopDriver extends Driver
    {
        /** Globals config/config.inc.php assigns at file scope. */
        const GLOBALS = [
            'context', 'cookie', 'smarty', 'link', 'cart', 'employee', 'customer', 'currentIndex', 'start_time',
            '_MODULES', '_LANG', '_LANGADM', '_LANGPDF', '_ERRORS', '_FIELDS', 'defaultCountry', 'protocol',
            'protocol_link', 'protocol_content',
        ];

        /** @var string */
        private $root = '';

        public function id(): string
        {
            return 'prestashop';
        }

        public function name(): string
        {
            return 'PrestaShop';
        }

        public function canBootstrap(string $projectPath): bool
        {
            return is_file($projectPath . '/config/config.inc.php')
                && (is_dir($projectPath . '/src/PrestaShopBundle') || is_file($projectPath . '/classes/ObjectModel.php'));
        }

        public function bootstrap(string $projectPath): void
        {
            $this->root = Support::path($projectPath);
            Support::setServerVars([
                'REQUEST_URI' => '/',
                'REQUEST_METHOD' => 'GET',
                'REMOTE_ADDR' => '127.0.0.1',
                'SERVER_PROTOCOL' => 'HTTP/1.1',
            ]);
            Support::requireWithGlobals($this->root . '/config/config.inc.php', self::GLOBALS);
        }

        public function variables(): array
        {
            return class_exists('Context', false) ? ['context' => \Context::getContext()] : [];
        }

        public function version(): ?string
        {
            return defined('_PS_VERSION_') ? 'PrestaShop ' . constant('_PS_VERSION_') : null;
        }

        public function logsPath(string $projectPath): ?string
        {
            $root = defined('_PS_ROOT_DIR_') ? (string) constant('_PS_ROOT_DIR_') : ($this->root !== '' ? $this->root : Support::path($projectPath));
            if ($root === '') {
                return null;
            }
            foreach (['/var/logs', '/app/logs', '/log'] as $dir) {
                if (is_dir($root . $dir)) {
                    return $root . $dir;
                }
            }

            return $root . '/var/logs';
        }

        protected function ignoredFolders(): array
        {
            return ['var', 'app/cache', 'cache', 'img', 'upload', 'download', 'translations'];
        }
    }

    /**
     * TYPO3 9 – 13 (Composer or classic installation): initializes the system environment for a CLI request and
     * runs the core bootstrap like the `typo3` console binary; `$container` is the DI container.
     */
    class Typo3Driver extends Driver
    {
        /** @var object|null Psr\Container\ContainerInterface */
        private $container;

        /** @var string */
        private $root = '';

        public function id(): string
        {
            return 'typo3';
        }

        public function name(): string
        {
            return 'TYPO3';
        }

        public function canBootstrap(string $projectPath): bool
        {
            return is_file(Support::vendorDir($projectPath) . '/typo3/cms-core/Classes/Core/Bootstrap.php')
                || is_file($projectPath . '/typo3/sysext/core/Classes/Core/Bootstrap.php');
        }

        public function bootstrap(string $projectPath): void
        {
            $this->root = Support::path($projectPath);
            $path = $this->root;
            $vendor = Support::vendorDir($path);
            if (is_file($vendor . '/typo3/cms-core/Classes/Core/Bootstrap.php')) {
                $classLoader = Support::requireAutoload($path);
                $composer = Support::composerJson($path);
                $webDir = isset($composer['extra']['typo3/cms']['web-dir']) && is_string($composer['extra']['typo3/cms']['web-dir'])
                    ? trim($composer['extra']['typo3/cms']['web-dir'], '/')
                    : 'public';
                // Normally exported by typo3/cms-composer-installers (vendor/typo3/autoload-include.php).
                foreach (['TYPO3_PATH_APP' => $path, 'TYPO3_PATH_ROOT' => $path . '/' . $webDir] as $name => $value) {
                    if (getenv($name) === false) {
                        putenv($name . '=' . $value);
                        $_ENV[$name] = $value;
                    }
                }
                $entry = $vendor . '/typo3/cms-core/bin/typo3';
            } else {
                $binDir = realpath($path . '/typo3/sysext/core/bin');
                $autoload = ($binDir !== false ? $binDir : $path . '/typo3/sysext/core/bin') . '/../../../../vendor/autoload.php';
                Support::assertFile($autoload, 'TYPO3');
                $classLoader = require $autoload;
                $entry = $path . '/typo3/sysext/core/bin/typo3';
            }
            // The environment builder derives every path from the entry script (four levels below the root).
            $saved = [];
            foreach (['argv', 'argc', 'SCRIPT_FILENAME', 'PWD'] as $key) {
                $saved[$key] = array_key_exists($key, $_SERVER) ? $_SERVER[$key] : null;
            }
            $_SERVER['argv'] = [$entry];
            $_SERVER['argc'] = 1;
            $_SERVER['SCRIPT_FILENAME'] = $entry;
            $_SERVER['PWD'] = $path;
            try {
                \TYPO3\CMS\Core\Core\SystemEnvironmentBuilder::run(4, \TYPO3\CMS\Core\Core\SystemEnvironmentBuilder::REQUESTTYPE_CLI);
                $container = \TYPO3\CMS\Core\Core\Bootstrap::init($classLoader);
            } finally {
                foreach ($saved as $key => $value) {
                    if ($value === null) {
                        unset($_SERVER[$key]);
                    } else {
                        $_SERVER[$key] = $value;
                    }
                }
            }
            $this->container = is_object($container) ? $container : null;
            if (method_exists('TYPO3\CMS\Core\Core\Bootstrap', 'loadExtTables')) {
                \TYPO3\CMS\Core\Core\Bootstrap::loadExtTables();
            }
        }

        public function variables(): array
        {
            return $this->container === null ? [] : ['container' => $this->container];
        }

        public function version(): ?string
        {
            if (class_exists('TYPO3\CMS\Core\Information\Typo3Version')) {
                return 'TYPO3 ' . (new \TYPO3\CMS\Core\Information\Typo3Version())->getVersion();
            }

            return defined('TYPO3_version') ? 'TYPO3 ' . constant('TYPO3_version') : null;
        }

        public function logsPath(string $projectPath): ?string
        {
            if (class_exists('TYPO3\CMS\Core\Core\Environment', false)) {
                try {
                    return \TYPO3\CMS\Core\Core\Environment::getVarPath() . '/log';
                } catch (\Throwable $e) {
                    return null; // environment not initialized
                }
            }
            $root = $this->root !== '' ? $this->root : Support::path($projectPath);

            return $root === '' ? null : $root . '/var/log';
        }

        /**
         * Doctrine DBAL 2/3 connections of the ConnectionPool (TYPO3 ≤ 12; DBAL 4 cannot be observed).
         */
        public function listenForQueries(callable $listener): void
        {
            if (!class_exists('TYPO3\CMS\Core\Database\ConnectionPool') || !isset($GLOBALS['TYPO3_CONF_VARS']['DB']['Connections'])) {
                return;
            }
            try {
                $pool = \TYPO3\CMS\Core\Utility\GeneralUtility::makeInstance('TYPO3\CMS\Core\Database\ConnectionPool');
                foreach (array_keys((array) $GLOBALS['TYPO3_CONF_VARS']['DB']['Connections']) as $name) {
                    Support::attachDoctrineLogger($pool->getConnectionByName($name), (string) $name, $listener);
                }
            } catch (\Throwable $e) {
                // Optional feature.
                return;
            }
        }

        protected function ignoredFolders(): array
        {
            return ['var', 'public', 'typo3', 'typo3temp', 'typo3conf/l10n', 'fileadmin', 'typo3_src'];
        }
    }

    /**
     * Joomla 3 – 5: configuration.php, includes/defines.php and the Joomla libraries. Follows the CLI entry point
     * (_JEXEC, path constants, framework, console application on Joomla 4+).
     */
    class JoomlaDriver extends Driver
    {
        /** @var object|null */
        private $app;

        /** @var object|null */
        private $container;

        /** @var string */
        private $root = '';

        public function id(): string
        {
            return 'joomla';
        }

        public function name(): string
        {
            return 'Joomla';
        }

        public function canBootstrap(string $projectPath): bool
        {
            return is_file($projectPath . '/configuration.php')
                && is_file($projectPath . '/includes/defines.php')
                && (is_file($projectPath . '/libraries/src/Version.php') || is_file($projectPath . '/libraries/cms/version/version.php'));
        }

        public function bootstrap(string $projectPath): void
        {
            $this->root = Support::path($projectPath);
            $path = $this->root;
            if (is_file($path . '/installation/index.php')) {
                // includes/framework.php would redirect to the installer and exit().
                throw new \RuntimeException('Joomla is not installed yet (the installation/ folder exists in ' . $path . ').');
            }
            if (!defined('_JEXEC')) {
                define('_JEXEC', 1);
            }
            if (is_file($path . '/defines.php')) {
                require_once $path . '/defines.php';
            }
            if (!defined('_JDEFINES')) {
                if (!defined('JPATH_BASE')) {
                    define('JPATH_BASE', $path);
                }
                require_once $path . '/includes/defines.php';
            }
            $libraries = (string) constant('JPATH_LIBRARIES');
            if (is_file($libraries . '/src/Version.php') && is_file($path . '/includes/framework.php')) {
                // Joomla 4+: the console application with a CLI session.
                Support::requireWithGlobals($path . '/includes/framework.php');
                $container = \Joomla\CMS\Factory::getContainer();
                $container->alias('session', 'session.cli')
                    ->alias('JSession', 'session.cli')
                    ->alias('Joomla\CMS\Session\Session', 'session.cli')
                    ->alias('Joomla\Session\Session', 'session.cli')
                    ->alias('Joomla\Session\SessionInterface', 'session.cli');
                $app = $container->get('Joomla\Console\Application');
                \Joomla\CMS\Factory::$application = $app;
                $this->container = $container;
                $this->app = $app;

                return;
            }
            // Joomla 3 CLI scripts
            Support::assertFile($libraries . '/import.legacy.php', 'Joomla 3');
            require_once $libraries . '/import.legacy.php';
            require_once $libraries . '/cms.php';
            require_once constant('JPATH_CONFIGURATION') . '/configuration.php';
            if (class_exists('JFactory')) {
                \JFactory::getConfig(constant('JPATH_CONFIGURATION') . '/configuration.php');
            }
        }

        public function variables(): array
        {
            if ($this->app !== null) {
                return ['app' => $this->app, 'container' => $this->container];
            }
            try {
                return class_exists('JFactory') ? ['db' => \JFactory::getDbo()] : [];
            } catch (\Throwable $e) {
                return [];
            }
        }

        public function version(): ?string
        {
            if (class_exists('Joomla\CMS\Version')) {
                return 'Joomla ' . (new \Joomla\CMS\Version())->getShortVersion();
            }
            if (class_exists('JVersion')) {
                return 'Joomla ' . (new \JVersion())->getShortVersion();
            }

            return defined('JVERSION') ? 'Joomla ' . constant('JVERSION') : null;
        }

        public function logsPath(string $projectPath): ?string
        {
            $path = null;
            try {
                if ($this->app !== null && method_exists($this->app, 'get')) {
                    $path = $this->app->get('log_path');
                } elseif (class_exists('JFactory')) {
                    $path = \JFactory::getConfig()->get('log_path');
                }
            } catch (\Throwable $e) {
                $path = null; // configuration unavailable
            }
            if (is_string($path) && $path !== '') {
                return $path;
            }
            $root = $this->root !== '' ? $this->root : Support::path($projectPath);
            if ($root === '') {
                return null;
            }

            return is_dir($root . '/administrator/logs') ? $root . '/administrator/logs' : $root . '/logs';
        }

        protected function ignoredFolders(): array
        {
            return ['cache', 'tmp', 'logs', 'administrator/cache', 'administrator/logs', 'media', 'images', 'libraries', 'installation'];
        }
    }
}
