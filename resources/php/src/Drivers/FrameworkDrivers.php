<?php

namespace Tinkerbox\Drivers {
    /**
     * CakePHP 3.3 – 5: config/bootstrap.php, the `bin/cake` console and cakephp/cakephp. Creates App\Application and
     * runs its bootstrap() and pluginBootstrap() like the console does (older applications: config/bootstrap.php).
     * Queries are logged into an in-memory log engine and reported after the run.
     */
    class CakePhpDriver extends Driver
    {
        /** Name of the in-memory log configuration that collects the queries. */
        const QUERY_LOG = 'tinkerbox_queries';

        /** @var object|null App\Application */
        private $app;

        /** @var string */
        private $root = '';

        /** @var callable|null */
        private $queryListener;

        /** @var int */
        private $queryOffset = 0;

        public function id(): string
        {
            return 'cakephp';
        }

        public function name(): string
        {
            return 'CakePHP';
        }

        public function canBootstrap(string $projectPath): bool
        {
            return is_file($projectPath . '/config/bootstrap.php')
                && (is_file($projectPath . '/bin/cake.php') || is_file($projectPath . '/bin/cake'))
                && (is_dir(Support::vendorDir($projectPath) . '/cakephp/cakephp') || Support::composerRequires($projectPath, 'cakephp/cakephp'));
        }

        public function bootstrap(string $projectPath): void
        {
            $this->root = Support::path($projectPath);
            $path = $this->root;
            Support::requireAutoload($path);
            $class = 'App\Application';
            if (class_exists($class)) {
                $app = new $class($path . '/config');
                $app->bootstrap();
                if (method_exists($app, 'pluginBootstrap')) {
                    $app->pluginBootstrap();
                }
                $this->app = $app;
            } else {
                require_once $path . '/config/bootstrap.php';
            }
        }

        public function variables(): array
        {
            return $this->app === null ? [] : ['app' => $this->app];
        }

        public function version(): ?string
        {
            return class_exists('Cake\Core\Configure') ? 'CakePHP ' . \Cake\Core\Configure::version() : null;
        }

        public function logsPath(string $projectPath): ?string
        {
            if (defined('LOGS')) {
                return rtrim((string) constant('LOGS'), '/\\');
            }
            $root = $this->root !== '' ? $this->root : Support::path($projectPath);

            return $root === '' ? null : $root . '/logs';
        }

        /**
         * Turn on query logging for every configured connection, written to an in-memory log engine.
         */
        public function listenForQueries(callable $listener): void
        {
            $manager = 'Cake\Datasource\ConnectionManager';
            $log = 'Cake\Log\Log';
            if (!class_exists($manager) || !class_exists($log) || !class_exists('Cake\Log\Engine\ArrayLog')) {
                return;
            }
            try {
                if (!in_array(self::QUERY_LOG, $log::configured(), true)) {
                    $log::setConfig(self::QUERY_LOG, ['className' => 'Array', 'scopes' => ['queriesLog', 'cake.database.queries']]);
                }
                foreach ($manager::configured() as $name) {
                    $connection = $manager::get($name);
                    if (method_exists($connection, 'enableQueryLogging')) {
                        $connection->enableQueryLogging(true);
                    } elseif (method_exists($connection, 'logQueries')) {
                        $connection->logQueries(true);
                    }
                }
                $this->queryOffset = count((array) $log::engine(self::QUERY_LOG)->read());
                $this->queryListener = $listener;
            } catch (\Throwable $e) {
                // No datasource configured.
                return;
            }
        }

        public function afterRun(): void
        {
            if ($this->queryListener === null) {
                return;
            }
            $lines = array_values((array) \Cake\Log\Log::engine(self::QUERY_LOG)->read());
            $new = array_slice($lines, $this->queryOffset);
            $this->queryOffset = count($lines);
            foreach ($new as $line) {
                // "debug: connection=default role=write duration=1 rows=3 SELECT …"
                $line = (string) $line;
                $duration = preg_match('/duration=([\d.]+)/', $line, $match) ? (float) $match[1] : 0.0;
                $connection = preg_match('/connection=(\S+)/', $line, $match) ? $match[1] : 'default';
                $sql = preg_match('/rows=\d+\s+(.*)$/s', $line, $match) ? $match[1] : preg_replace('/^\w+:\s*/', '', $line);
                Support::emitQuery($this->queryListener, trim((string) $sql), [], $duration, $connection);
            }
        }

        protected function ignoredFolders(): array
        {
            return ['tmp', 'logs', 'webroot'];
        }
    }

    /**
     * CodeIgniter 4: app/Config/Paths.php and the `spark` console. Runs spark's boot sequence without a command
     * (CodeIgniter\Boot on 4.5+, system/bootstrap.php before); `$app` is the CodeIgniter instance.
     */
    class CodeIgniter4Driver extends Driver
    {
        /** @var object|null CodeIgniter\CodeIgniter */
        private $app;

        /** @var string */
        private $root = '';

        public function id(): string
        {
            return 'codeigniter4';
        }

        public function name(): string
        {
            return 'CodeIgniter';
        }

        public function canBootstrap(string $projectPath): bool
        {
            return is_file($projectPath . '/app/Config/Paths.php') && is_file($projectPath . '/spark');
        }

        public function bootstrap(string $projectPath): void
        {
            $this->root = Support::path($projectPath);
            $path = $this->root;
            if (!defined('FCPATH')) {
                define('FCPATH', $path . DIRECTORY_SEPARATOR . 'public' . DIRECTORY_SEPARATOR);
            }
            Support::assertFile($path . '/app/Config/Paths.php', 'CodeIgniter 4');
            require_once $path . '/app/Config/Paths.php';
            $paths = new \Config\Paths();
            $system = rtrim((string) $paths->systemDirectory, '\\/ ');
            if (is_file($system . '/Boot.php')) {
                // 4.5+: the steps of Boot::bootSpark() up to (not including) running a command.
                require_once $system . '/Boot.php';
                $boot = 'CodeIgniter\Boot';
                Support::callStatic($boot, 'definePathConstants', [$paths]);
                if (!defined('APP_NAMESPACE')) {
                    Support::callStatic($boot, 'loadConstants');
                }
                Support::callStatic($boot, 'checkMissingExtensions');
                Support::callStatic($boot, 'loadDotEnv', [$paths]);
                Support::callStatic($boot, 'defineEnvironment');
                Support::callStatic($boot, 'loadEnvironmentBootstrap', [$paths]);
                Support::callStatic($boot, 'loadCommonFunctions');
                Support::callStatic($boot, 'loadAutoloader');
                Support::callStatic($boot, 'initializeKint');
                Support::callStatic($boot, 'autoloadHelpers');
                $app = \Config\Services::codeigniter();
                $app->initialize();
            } else {
                // 4.0 – 4.3 return the initialized application; 4.4 leaves .env / ENVIRONMENT to spark.
                Support::assertFile($system . '/bootstrap.php', 'CodeIgniter 4');
                $app = require $system . '/bootstrap.php';
                if (!is_object($app)) {
                    if (class_exists('CodeIgniter\Config\DotEnv')) {
                        (new \CodeIgniter\Config\DotEnv(constant('ROOTPATH')))->load();
                    }
                    if (!defined('ENVIRONMENT')) {
                        $env = isset($_ENV['CI_ENVIRONMENT']) ? $_ENV['CI_ENVIRONMENT'] : (isset($_SERVER['CI_ENVIRONMENT']) ? $_SERVER['CI_ENVIRONMENT'] : getenv('CI_ENVIRONMENT'));
                        define('ENVIRONMENT', $env !== false && $env !== null ? (string) $env : 'production');
                    }
                    $environmentBoot = constant('APPPATH') . 'Config/Boot/' . constant('ENVIRONMENT') . '.php';
                    if (is_file($environmentBoot)) {
                        require_once $environmentBoot;
                    }
                    $app = \Config\Services::codeigniter();
                    $app->initialize();
                }
            }
            if (method_exists($app, 'setContext')) {
                $app->setContext('spark');
            }
            $this->app = $app;
        }

        public function variables(): array
        {
            return $this->app === null ? [] : ['app' => $this->app];
        }

        public function version(): ?string
        {
            return defined('CodeIgniter\CodeIgniter::CI_VERSION') ? 'CodeIgniter ' . constant('CodeIgniter\CodeIgniter::CI_VERSION') : null;
        }

        public function logsPath(string $projectPath): ?string
        {
            if (defined('WRITEPATH')) {
                return rtrim((string) constant('WRITEPATH'), '/\\') . DIRECTORY_SEPARATOR . 'logs';
            }
            $root = $this->root !== '' ? $this->root : Support::path($projectPath);

            return $root === '' ? null : $root . '/writable/logs';
        }

        /**
         * The framework's "DBQuery" event (triggered for every executed query).
         */
        public function listenForQueries(callable $listener): void
        {
            if (!class_exists('CodeIgniter\Events\Events')) {
                return;
            }
            \CodeIgniter\Events\Events::on('DBQuery', function ($query) use ($listener) {
                $sql = method_exists($query, 'getQuery') ? (string) $query->getQuery() : (string) $query;
                $seconds = method_exists($query, 'getDuration') ? (float) $query->getDuration() : 0.0;
                Support::emitQuery($listener, $sql, [], $seconds * 1000, 'default');
            });
        }

        protected function ignoredFolders(): array
        {
            return ['writable', 'public', 'system'];
        }
    }

    /**
     * Yii 2 (basic and advanced templates): the `yii` console script with yiisoft/yii2 installed (Craft CMS projects
     * excluded). Creates the console application from the project's configuration; `$app` is Yii::$app.
     */
    class Yii2Driver extends Driver
    {
        /** @var object|null yii\console\Application */
        private $app;

        /** @var string */
        private $root = '';

        /** @var YiiQueryLog|null */
        private $queryLog;

        public function id(): string
        {
            return 'yii2';
        }

        public function name(): string
        {
            return 'Yii 2';
        }

        public function canBootstrap(string $projectPath): bool
        {
            $vendor = Support::vendorDir($projectPath);

            return is_file($projectPath . '/yii') && is_file($vendor . '/yiisoft/yii2/Yii.php') && !is_dir($vendor . '/craftcms/cms');
        }

        public function bootstrap(string $projectPath): void
        {
            $this->root = Support::path($projectPath);
            $path = $this->root;
            // YII_DEBUG / YII_ENV as written in the project's `yii` script (generated by the `init` command).
            $script = is_file($path . '/yii') ? (string) file_get_contents($path . '/yii') : '';
            if (!defined('YII_DEBUG')) {
                define('YII_DEBUG', preg_match('/define\(\s*[\'"]YII_DEBUG[\'"]\s*,\s*true\s*\)/i', $script) === 1);
            }
            if (!defined('YII_ENV')) {
                define('YII_ENV', preg_match('/define\(\s*[\'"]YII_ENV[\'"]\s*,\s*[\'"](\w+)[\'"]\s*\)/', $script, $match) ? $match[1] : 'prod');
            }
            Support::requireAutoload($path);
            require_once Support::vendorDir($path) . '/yiisoft/yii2/Yii.php';
            if (is_file($path . '/common/config/main.php') && is_dir($path . '/console/config')) {
                // Advanced template
                foreach (['/common/config/bootstrap.php', '/console/config/bootstrap.php'] as $file) {
                    if (is_file($path . $file)) {
                        require_once $path . $file;
                    }
                }
                $parts = [];
                foreach (['/common/config/main.php', '/common/config/main-local.php', '/console/config/main.php', '/console/config/main-local.php'] as $file) {
                    if (is_file($path . $file)) {
                        $parts[] = require $path . $file;
                    }
                }
                $config = call_user_func_array(['yii\helpers\ArrayHelper', 'merge'], $parts);
            } elseif (is_file($path . '/config/console.php')) {
                $config = require $path . '/config/console.php';
            } else {
                throw new \RuntimeException('No Yii 2 console configuration found (config/console.php or console/config/main.php).');
            }
            $this->app = new \yii\console\Application($config);
        }

        public function variables(): array
        {
            return $this->app === null ? [] : ['app' => $this->app];
        }

        public function version(): ?string
        {
            return class_exists('Yii', false) ? 'Yii ' . \Yii::getVersion() : null;
        }

        public function logsPath(string $projectPath): ?string
        {
            if ($this->app !== null && method_exists($this->app, 'getRuntimePath')) {
                return $this->app->getRuntimePath() . DIRECTORY_SEPARATOR . 'logs';
            }
            $root = $this->root !== '' ? $this->root : Support::path($projectPath);

            return $root === '' ? null : $root . '/runtime/logs';
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
            return ['runtime', 'web/assets', 'console/runtime', 'frontend/runtime', 'backend/runtime', 'frontend/web/assets', 'backend/web/assets'];
        }
    }

    /**
     * Any Composer project (vendor/autoload.php, honoring config.vendor-dir): loads the autoloader.
     */
    class ComposerDriver extends Driver
    {
        /** @var string */
        private $root = '';

        public function id(): string
        {
            return 'composer';
        }

        public function name(): string
        {
            return 'Composer';
        }

        public function canBootstrap(string $projectPath): bool
        {
            return $projectPath !== '' && is_file(Support::vendorDir($projectPath) . '/autoload.php');
        }

        public function bootstrap(string $projectPath): void
        {
            $this->root = Support::path($projectPath);
            Support::requireAutoload($this->root);
        }

        /**
         * The package name from composer.json ("acme/greeter"), else "Composer".
         */
        public function version(): ?string
        {
            $composer = Support::composerJson($this->root);

            return isset($composer['name']) && is_string($composer['name']) && $composer['name'] !== '' ? $composer['name'] : 'Composer';
        }

        public function panels(string $projectPath): array
        {
            $composer = Support::composerJson($projectPath);
            $string = function ($key) use ($composer) {
                return isset($composer[$key]) && is_string($composer[$key]) && $composer[$key] !== '' ? $composer[$key] : null;
            };
            $license = isset($composer['license']) ? $composer['license'] : null;

            return [\Tinkerbox\Panels\Panel::make(\Tinkerbox\Panels\StandardPanels::APP_INFORMATION)->sections([
                'Package' => \Tinkerbox\Panels\StandardPanels::present([
                    'Name' => $string('name'),
                    'Description' => $string('description'),
                    'Type' => $string('type'),
                    'License' => is_string($license) || is_array($license) ? $license : null,
                    'Dependencies' => isset($composer['require']) && is_array($composer['require']) ? count($composer['require']) : 0,
                    'Path' => $projectPath,
                ]),
                'PHP' => \Tinkerbox\Panels\StandardPanels::phpRows(),
            ])->toArray()];
        }

        protected function ignoredFolders(): array
        {
            return ['var', 'cache', 'tmp', 'storage', 'build'];
        }
    }

    /**
     * Plain PHP (no framework): the fallback when no other driver matches. Never detected by itself; loads
     * vendor/autoload.php when the folder has one.
     */
    class PlainDriver extends Driver
    {
        public function id(): string
        {
            return 'none';
        }

        public function name(): string
        {
            return 'PHP';
        }

        public function canBootstrap(string $projectPath): bool
        {
            return false;
        }

        public function bootstrap(string $projectPath): void
        {
            $root = Support::path($projectPath);
            if ($root !== '') {
                Support::requireAutoload($root, false);
            }
        }
    }
}
