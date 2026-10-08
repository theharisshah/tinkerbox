<?php

namespace Tinkerbox\Drivers {
    /**
     * WordPress: a folder with WordPress core (wp-load.php + wp-includes/version.php), at the project root or in one
     * of the usual Composer locations (web/wp, wp, public/wp, wordpress). Loads WordPress like a theme-less request
     * (WP_USE_THEMES = false) with core's globals bound to the global scope, so `$wpdb`, `get_option()`,
     * `WP_Query` … work in the editor.
     *
     * Queries: SAVEQUERIES is enabled (unless the project defines it) and WordPress 5.3+ reports every query with
     * its duration through the `log_query_custom_data` filter; older versions are read from `$wpdb->queries` after
     * the run, and with SAVEQUERIES explicitly disabled the `query` filter records the SQL without timing.
     */
    class WordPressDriver extends Driver
    {
        /**
         * Globals WordPress core and wp-config.php assign at file scope. Loading WordPress from a method would turn
         * them into locals, so they are bound to $GLOBALS before wp-load.php is required.
         */
        const GLOBALS = [
            'table_prefix', 'base', 'wpdb', 'wp_version', 'wp_db_version', 'tinymce_version', 'required_php_version',
            'required_mysql_version', 'wp_local_package', 'wp', 'wp_query', 'wp_the_query', 'wp_rewrite', 'wp_roles',
            'wp_locale', 'wp_embed', 'wp_widget_factory', 'wp_filter', 'wp_actions', 'wp_filters', 'wp_current_filter',
            'wp_object_cache', 'wp_plugin_paths', 'blog_id', 'current_site', 'current_blog', 'domain', 'path',
            'site_id', 'public', 'shortcode_tags', 'current_user', 'post', 'locale', 'l10n', 'wp_scripts', 'wp_styles',
            'wp_theme_directories', 'pagenow', 'root_dir', 'webroot_dir',
        ];

        /** Folders (relative to the project) that may contain WordPress core. */
        const CORE_FOLDERS = ['', '/web/wp', '/wp', '/public/wp', '/wordpress'];

        /** @var string */
        private $root = '';

        /** @var string|null WordPress core folder (contains wp-load.php) */
        private $core;

        /** @var callable|null */
        private $queryListener;

        /** @var string|null 'filter' (log_query_custom_data), 'saved' ($wpdb->queries diff) or 'query' (no timing) */
        private $queryMode;

        /** @var int */
        private $queryOffset = 0;

        public function id(): string
        {
            return 'wordpress';
        }

        public function name(): string
        {
            return 'WordPress';
        }

        public function canBootstrap(string $projectPath): bool
        {
            return $this->coreFolder($projectPath) !== null;
        }

        public function bootstrap(string $projectPath): void
        {
            $this->root = Support::path($projectPath);
            $core = $this->coreFolder($this->root);
            if ($core === null) {
                throw new \RuntimeException('No WordPress installation (wp-load.php) found in ' . $this->root . '.');
            }
            $this->core = $core;
            $host = $this->siteHost();
            Support::setServerVars([
                'HTTP_HOST' => $host,
                'SERVER_NAME' => $host,
                'REQUEST_URI' => '/',
                'REQUEST_METHOD' => 'GET',
                'SERVER_PROTOCOL' => 'HTTP/1.1',
                'REMOTE_ADDR' => '127.0.0.1',
                'HTTP_USER_AGENT' => '',
            ]);
            if (!defined('WP_USE_THEMES')) {
                define('WP_USE_THEMES', false);
            }
            Support::requireWithGlobals($core . '/wp-load.php', self::GLOBALS);
        }

        public function variables(): array
        {
            return isset($GLOBALS['wpdb']) && is_object($GLOBALS['wpdb']) ? ['wpdb' => $GLOBALS['wpdb']] : [];
        }

        public function version(): ?string
        {
            $version = $this->wordpressVersion();

            return $version === null ? null : 'WordPress ' . $version;
        }

        public function panels(string $projectPath): array
        {
            return [\Tinkerbox\Panels\StandardPanels::wordpress()];
        }

        /**
         * Plugins routinely raise notices; detailed error pages would bury the actual result.
         */
        public function prettyErrors(): ?bool
        {
            return false;
        }

        public function logsPath(string $projectPath): ?string
        {
            if (defined('WP_DEBUG_LOG') && is_string(constant('WP_DEBUG_LOG')) && constant('WP_DEBUG_LOG') !== '') {
                return dirname((string) constant('WP_DEBUG_LOG'));
            }
            if (defined('WP_CONTENT_DIR')) {
                return (string) constant('WP_CONTENT_DIR');
            }
            $core = $this->core !== null ? $this->core : $this->coreFolder($projectPath);

            return $core === null ? null : $core . '/wp-content';
        }

        public function listenForQueries(callable $listener): void
        {
            $wpdb = isset($GLOBALS['wpdb']) ? $GLOBALS['wpdb'] : null;
            if (!is_object($wpdb)) {
                return;
            }
            $this->queryListener = $listener;
            if (!defined('SAVEQUERIES')) {
                define('SAVEQUERIES', true);
            }
            $saving = (bool) constant('SAVEQUERIES');
            if ($saving && function_exists('add_filter') && version_compare((string) $this->wordpressVersion(), '5.3', '>=')) {
                $this->queryMode = 'filter';
                // ($data, $query, $query_time, $query_callstack, $query_start): $data is passed through unchanged.
                add_filter('log_query_custom_data', function ($data, $query = '', $seconds = 0.0) use ($listener) {
                    Support::emitQuery($listener, $query, [], (float) $seconds * 1000, 'wpdb');

                    return $data;
                }, 1, 3);
            } elseif ($saving) {
                $this->queryMode = 'saved';
                $this->queryOffset = isset($wpdb->queries) && is_array($wpdb->queries) ? count($wpdb->queries) : 0;
            } elseif (function_exists('add_filter')) {
                $this->queryMode = 'query';
                add_filter('query', function ($query) use ($listener) {
                    Support::emitQuery($listener, $query, [], 0.0, 'wpdb');

                    return $query;
                }, PHP_INT_MAX);
            }
        }

        public function afterRun(): void
        {
            if ($this->queryMode !== 'saved' || $this->queryListener === null) {
                return;
            }
            $wpdb = isset($GLOBALS['wpdb']) ? $GLOBALS['wpdb'] : null;
            if (!is_object($wpdb) || !isset($wpdb->queries) || !is_array($wpdb->queries)) {
                return;
            }
            $queries = array_values($wpdb->queries);
            $new = array_slice($queries, $this->queryOffset);
            $this->queryOffset = count($queries);
            foreach ($new as $entry) {
                // [sql, seconds, caller, start, custom data]
                if (is_array($entry) && isset($entry[0])) {
                    Support::emitQuery($this->queryListener, (string) $entry[0], [], isset($entry[1]) ? (float) $entry[1] * 1000 : 0.0, 'wpdb');
                }
            }
        }

        protected function ignoredFolders(): array
        {
            $folders = [];
            foreach (self::CORE_FOLDERS as $core) {
                $prefix = ltrim($core, '/');
                foreach (['wp-admin', 'wp-includes', 'wp-content/uploads', 'wp-content/cache', 'wp-content/upgrade'] as $folder) {
                    $folders[] = ($prefix === '' ? '' : $prefix . '/') . $folder;
                }
            }

            return $folders;
        }

        /**
         * WordPress core folder of a project, or null.
         *
         * @param string $projectPath
         * @return string|null
         */
        protected function coreFolder(string $projectPath)
        {
            $projectPath = Support::path($projectPath);
            if ($projectPath === '') {
                return null;
            }
            foreach (self::CORE_FOLDERS as $folder) {
                $dir = $projectPath . $folder;
                if (is_file($dir . '/wp-load.php') && is_file($dir . '/wp-includes/version.php')) {
                    return $dir;
                }
            }

            return null;
        }

        /**
         * The project folder bootstrap() was called with ('' before bootstrapping).
         */
        protected function projectRoot(): string
        {
            return $this->root;
        }

        /**
         * The running WordPress version, or null before WordPress was loaded.
         *
         * @return string|null
         */
        protected function wordpressVersion()
        {
            if (isset($GLOBALS['wp_version']) && is_string($GLOBALS['wp_version'])) {
                return $GLOBALS['wp_version'];
            }
            if (function_exists('get_bloginfo')) {
                $version = get_bloginfo('version');

                return is_string($version) && $version !== '' ? $version : null;
            }

            return null;
        }

        /**
         * Host for $_SERVER['HTTP_HOST'] (multisite resolves the site from it): DOMAIN_CURRENT_SITE, WP_HOME or
         * WP_SITEURL from the configuration files or .env, else "localhost".
         *
         * @return string
         */
        private function siteHost()
        {
            $constants = ['DOMAIN_CURRENT_SITE', 'WP_HOME', 'WP_SITEURL'];
            $values = [];
            foreach ($this->configFiles() as $file) {
                $code = (string) file_get_contents($file);
                foreach ($constants as $constant) {
                    if (preg_match('/define\s*\(\s*[\'"]' . $constant . '[\'"]\s*,\s*[\'"]([^\'"]+)[\'"]/', $code, $match)) {
                        $values[] = $match[1];
                    }
                }
            }
            $env = $this->root . '/.env';
            if (is_file($env)) {
                $code = (string) file_get_contents($env);
                foreach ($constants as $constant) {
                    if (preg_match('/^\s*' . $constant . '\s*=\s*[\'"]?([^\'"\s#]+)/m', $code, $match)) {
                        $values[] = $match[1];
                    }
                }
            }
            foreach ($values as $value) {
                if (strpos($value, '://') !== false) {
                    $host = parse_url($value, PHP_URL_HOST);
                    $port = parse_url($value, PHP_URL_PORT);
                    if (is_string($host) && $host !== '') {
                        return $port ? $host . ':' . $port : $host;
                    }
                } elseif (preg_match('/^[A-Za-z0-9.-]+(:\d+)?$/', $value)) {
                    return $value;
                }
            }

            return 'localhost';
        }

        /**
         * wp-config.php (core folder or its parent) plus Bedrock-style configuration files.
         *
         * @return string[]
         */
        private function configFiles()
        {
            $files = [];
            $core = (string) $this->core;
            foreach ([$core . '/wp-config.php', dirname($core) . '/wp-config.php'] as $file) {
                if (is_file($file)) {
                    $files[] = $file;
                }
            }
            foreach (['config', 'bedrock'] as $dir) {
                foreach (['', '/environments'] as $sub) {
                    $path = $this->root . '/' . $dir . $sub;
                    $found = is_dir($path) ? glob($path . '/*.php') : false;
                    if (is_array($found)) {
                        foreach ($found as $file) {
                            $files[] = $file;
                        }
                    }
                }
            }

            return array_values(array_unique($files));
        }
    }

    /**
     * Bedrock (roots/bedrock): WordPress core in web/wp, configured by config/application.php.
     */
    class BedrockDriver extends WordPressDriver
    {
        public function id(): string
        {
            return 'bedrock';
        }

        public function name(): string
        {
            return 'Bedrock';
        }

        public function canBootstrap(string $projectPath): bool
        {
            return is_file($projectPath . '/config/application.php')
                && is_file($projectPath . '/web/wp/wp-load.php')
                && is_file($projectPath . '/web/wp/wp-includes/version.php');
        }

        public function version(): ?string
        {
            $version = $this->wordpressVersion();

            return $version === null ? null : Support::label('WordPress', $version, 'Bedrock');
        }
    }

    /**
     * Radicle (roots/radicle): Bedrock-style WordPress with Acorn, the Laravel container inside WordPress. Adds the
     * Acorn application as `$app`, its Eloquent queries and an "Acorn" panel.
     */
    class RadicleDriver extends WordPressDriver
    {
        public function id(): string
        {
            return 'radicle';
        }

        public function name(): string
        {
            return 'Radicle';
        }

        /**
         * WordPress core plus Radicle's bedrock/application.php, or Acorn installed next to a Bedrock configuration.
         */
        public function canBootstrap(string $projectPath): bool
        {
            if ($this->coreFolder($projectPath) === null) {
                return false;
            }

            return is_file($projectPath . '/bedrock/application.php')
                || (is_dir(Support::vendorDir($projectPath) . '/roots/acorn') && is_file($projectPath . '/config/application.php'));
        }

        public function bootstrap(string $projectPath): void
        {
            // Outside of WP-CLI, let Acorn boot its full application (providers, facades, routes) like it does for a
            // page request, instead of waiting for the `wp acorn` console.
            if (getenv('APP_RUNNING_IN_CONSOLE') === false) {
                putenv('APP_RUNNING_IN_CONSOLE=false');
            }
            parent::bootstrap($projectPath);
        }

        public function variables(): array
        {
            $variables = parent::variables();
            $app = $this->acorn();
            if ($app !== null) {
                $variables['app'] = $app;
            }

            return $variables;
        }

        /**
         * "WordPress 6.6.2 + Acorn 4.3.0".
         */
        public function version(): ?string
        {
            $wordpress = $this->wordpressVersion();
            $acorn = Support::packageVersion($this->projectRoot(), 'roots/acorn');
            if ($acorn !== null) {
                $acorn = 'Acorn ' . $acorn;
            } else {
                $app = $this->acorn();
                try {
                    $acorn = $app !== null ? trim((string) $app->version()) : null;
                } catch (\Throwable $e) {
                    $acorn = null;
                }
                if ($acorn !== null && $acorn !== '' && stripos($acorn, 'acorn') !== 0) {
                    $acorn = 'Acorn ' . $acorn;
                }
            }
            $parts = [];
            if ($wordpress !== null) {
                $parts[] = 'WordPress ' . $wordpress;
            }
            if ($acorn !== null && $acorn !== '') {
                $parts[] = $acorn;
            }

            return $parts ? implode(' + ', $parts) : null;
        }

        public function panels(string $projectPath): array
        {
            $panels = parent::panels($projectPath);
            $acorn = \Tinkerbox\Panels\StandardPanels::laravel($this->acorn(), false, 'Acorn');
            if ($acorn !== null) {
                $panels[] = $acorn;
            }

            return $panels;
        }

        public function listenForQueries(callable $listener): void
        {
            parent::listenForQueries($listener);
            // Eloquent queries through Acorn's database manager.
            Laravel::listen($this->acorn(), $listener);
        }

        /**
         * The Acorn application, or null.
         *
         * @return object|null
         */
        protected function acorn()
        {
            try {
                if (function_exists('Roots\app')) {
                    $app = \Roots\app();
                    if (is_object($app)) {
                        return $app;
                    }
                }
            } catch (\Throwable $e) {
                // Acorn not booted yet: fall back to the container instance below.
                return Laravel::runningApp();
            }

            return Laravel::runningApp();
        }
    }
}
