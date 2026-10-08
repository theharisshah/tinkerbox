<?php

namespace Tinkerbox\Panels {
    /**
     * Builder for the panels of the "App Information" modal (docs/ARCHITECTURE.md §1.7). toArray() returns an
     * AppPanel (src/shared/types.ts): `{ title, sections: [{ title, rows: [{ key, value }] }] }` with every value
     * converted to display text (booleans "true" / "false", null "", lists "a, b", dates, enums, stringables).
     *
     *     Panel::make('Shop')
     *         ->section('Orders', ['Open' => 3, 'Express' => true])
     *         ->section('Inventory', ['SKUs' => 1200])
     *         ->toArray();
     *
     * Sections keep the order they were added in; adding a section with an existing title adds a second one.
     */
    final class Panel
    {
        /** @var string */
        private $title;

        /** @var array[] AppPanel sections */
        private $sections = [];

        /**
         * @param string $title
         */
        private function __construct($title)
        {
            $this->title = $title;
        }

        /**
         * Start a panel (one tab of the modal).
         */
        public static function make(string $title): self
        {
            return new self(trim($title));
        }

        /**
         * Add a titled section of `label => value` rows.
         *
         * @param array<string|int, mixed> $rows
         */
        public function section(string $title, array $rows): self
        {
            $out = [];
            foreach ($rows as $key => $value) {
                $out[] = ['key' => (string) $key, 'value' => \Tinkerbox\Panels::stringify($value)];
            }
            $this->sections[] = ['title' => trim($title), 'rows' => $out];

            return $this;
        }

        /**
         * Add several sections at once: `section title => rows`. Sections without rows are left out.
         *
         * @param array<string, array> $sections
         */
        public function sections(array $sections): self
        {
            foreach ($sections as $title => $rows) {
                if (is_array($rows) && $rows) {
                    $this->section((string) $title, $rows);
                }
            }

            return $this;
        }

        /**
         * The AppPanel array.
         *
         * @return array{title: string, sections: array}
         */
        public function toArray(): array
        {
            return ['title' => $this->title, 'sections' => $this->sections];
        }
    }

    /**
     * The panels built-in drivers show by default: the PHP environment (every driver), Laravel's application
     * information and the WordPress site information. Every value is read defensively: a panel never throws, a
     * value that cannot be read is left out.
     */
    final class StandardPanels
    {
        const APP_INFORMATION = 'App Information';

        /**
         * "PHP Environment": the PHP runtime plus the project folder.
         *
         * @param string $projectPath
         * @return array AppPanel
         */
        public static function php(string $projectPath = ''): array
        {
            $panel = Panel::make('PHP Environment')->section('PHP', self::phpRows());
            if ($projectPath !== '') {
                $composer = \Tinkerbox\Drivers\Support::composerJson($projectPath);
                $panel->section('Project', self::present([
                    'Path' => $projectPath,
                    'Composer Package' => isset($composer['name']) && is_string($composer['name']) ? $composer['name'] : null,
                ]));
            }

            return $panel->toArray();
        }

        /**
         * Rows describing the PHP runtime.
         *
         * @return array<string, mixed>
         */
        public static function phpRows(): array
        {
            $ini = php_ini_loaded_file();
            $xdebug = phpversion('xdebug');
            $opcache = extension_loaded('Zend OPcache') && filter_var(ini_get(PHP_SAPI === 'cli' ? 'opcache.enable_cli' : 'opcache.enable'), FILTER_VALIDATE_BOOLEAN);

            return self::present([
                'Version' => PHP_VERSION,
                'SAPI' => PHP_SAPI,
                'Binary' => defined('PHP_BINARY') && PHP_BINARY !== '' ? PHP_BINARY : null,
                'Configuration File' => $ini === false ? 'none' : $ini,
                'Extensions' => count(get_loaded_extensions()),
                'Memory Limit' => (string) ini_get('memory_limit'),
                'OPcache' => $opcache ? 'Enabled' : 'Disabled',
                'Xdebug' => is_string($xdebug) && $xdebug !== '' ? $xdebug : null,
            ]);
        }

        /**
         * "App Information" of a Laravel application: the sections of `artisan about --json` (Laravel 9.21+) with
         * readable keys, or values read from the configuration when the command is unavailable or $useAbout is false.
         *
         * @param object|null $app the application (default: the running one)
         * @param bool $useAbout
         * @param string $title
         * @return array|null AppPanel, null when no Laravel application is running
         */
        public static function laravel($app = null, bool $useAbout = true, string $title = self::APP_INFORMATION): ?array
        {
            if ($app === null) {
                $app = \Tinkerbox\Drivers\Laravel::runningApp();
            }
            if (!is_object($app) || !method_exists($app, 'make')) {
                return null;
            }
            $sections = null;
            if ($useAbout) {
                try {
                    $sections = self::aboutSections($app);
                } catch (\Throwable $e) {
                    $sections = null; // command missing / failing: the configuration still describes the app
                }
            }
            if ($sections === null) {
                try {
                    $sections = self::configSections($app);
                } catch (\Throwable $e) {
                    $sections = ['Environment' => self::present(['PHP Version' => PHP_VERSION])];
                }
            }

            return Panel::make($title)->sections($sections)->toArray();
        }

        /**
         * "Site Information" of a booted WordPress installation.
         *
         * @param string $title
         * @return array AppPanel
         */
        public static function wordpress(string $title = 'Site Information'): array
        {
            $call = function ($function, array $args = []) {
                if (!function_exists($function)) {
                    return null;
                }
                try {
                    return call_user_func_array($function, $args);
                } catch (\Throwable $e) {
                    return null;
                }
            };
            $flag = function ($name) {
                return defined($name) ? constant($name) : false;
            };
            $wpdb = isset($GLOBALS['wpdb']) && is_object($GLOBALS['wpdb']) ? $GLOBALS['wpdb'] : null;
            $version = isset($GLOBALS['wp_version']) && is_string($GLOBALS['wp_version']) ? $GLOBALS['wp_version'] : $call('get_bloginfo', ['version']);
            $home = $call('home_url');
            $siteUrl = $call('site_url');
            $plugins = $call('get_option', ['active_plugins']);
            $theme = $call('wp_get_theme');

            $sections = [
                'Site' => self::present([
                    'Name' => $call('get_bloginfo', ['name']),
                    'Description' => $call('get_bloginfo', ['description']),
                    'Home URL' => $home !== null ? $home : $call('get_option', ['home']),
                    'Site URL' => $siteUrl !== null ? $siteUrl : $call('get_option', ['siteurl']),
                    'WordPress Version' => $version,
                    'Environment' => $call('wp_get_environment_type'),
                    'Multisite' => $call('is_multisite'),
                    'Language' => $call('get_locale'),
                ]),
                'Configuration' => self::present([
                    'WP_DEBUG' => $flag('WP_DEBUG'),
                    'WP_DEBUG_LOG' => $flag('WP_DEBUG_LOG'),
                    'SAVEQUERIES' => $flag('SAVEQUERIES'),
                    'WP_CACHE' => $flag('WP_CACHE'),
                    'Database' => defined('DB_NAME') ? constant('DB_NAME') : null,
                    'Database Host' => defined('DB_HOST') ? constant('DB_HOST') : null,
                    'Table Prefix' => $wpdb !== null && isset($wpdb->prefix) ? $wpdb->prefix : null,
                ]),
                'Theme' => is_object($theme) && method_exists($theme, 'get') ? self::present([
                    'Name' => $theme->get('Name'),
                    'Version' => $theme->get('Version'),
                ]) : [],
                'Plugins' => is_array($plugins) ? ['Active' => count($plugins)] : [],
            ];

            return Panel::make($title)->sections($sections)->toArray();
        }

        /**
         * Drop rows whose value is null.
         *
         * @param array $rows
         * @return array
         */
        public static function present(array $rows): array
        {
            return array_filter($rows, function ($value) {
                return $value !== null;
            });
        }

        /**
         * `about --json` → section title => rows, or null when the command is not available.
         *
         * @param object $app
         * @return array|null
         */
        private static function aboutSections($app)
        {
            $kernel = $app->make('Illuminate\Contracts\Console\Kernel');
            if (!is_object($kernel) || !method_exists($kernel, 'call') || !method_exists($kernel, 'output')) {
                return null;
            }
            $level = ob_get_level();
            ob_start();
            try {
                $exitCode = $kernel->call('about', ['--json' => true]);
                $output = (string) $kernel->output();
            } finally {
                // Output of service providers must never reach the envelope stream.
                while (ob_get_level() > $level) {
                    ob_end_clean();
                }
            }
            $about = json_decode(trim($output), true);
            if ((int) $exitCode !== 0 || !is_array($about) || !$about) {
                return null;
            }

            $links = self::storageLinks($app);
            $sections = [];
            foreach ($about as $section => $rows) {
                $out = [];
                foreach (is_array($rows) ? $rows : ['' => $rows] as $key => $value) {
                    $key = (string) $key;
                    // Paths (storage links) keep their spelling; snake_case keys become labels.
                    $label = isset($links[$key]) ? $links[$key] : \Tinkerbox\Panels::humanize($key);
                    $out[$label] = $value;
                }
                $sections[\Tinkerbox\Panels::humanize((string) $section)] = $out;
            }

            return $sections;
        }

        /**
         * Application values read from the configuration (Laravel < 9.21, Lumen, Acorn).
         *
         * @param object $app
         * @return array
         */
        private static function configSections($app)
        {
            $config = $app->make('config');
            $get = function ($key) use ($config) {
                try {
                    $value = $config->get($key);
                } catch (\Throwable $e) {
                    return null;
                }

                return $value === '' ? null : $value;
            };
            $environment = $get('app.env');
            try {
                if (method_exists($app, 'environment')) {
                    $environment = $app->environment();
                }
            } catch (\Throwable $e) {
                $environment = $get('app.env');
            }
            $mail = $get('mail.default');

            return [
                'Environment' => self::present([
                    'Application Name' => $get('app.name'),
                    'Laravel Version' => \Tinkerbox\Drivers\Laravel::frameworkVersion($app),
                    'PHP Version' => PHP_VERSION,
                    'Environment' => is_string($environment) ? $environment : null,
                    'Debug Mode' => (bool) $get('app.debug'),
                    'URL' => $get('app.url'),
                    'Timezone' => $get('app.timezone'),
                    'Locale' => $get('app.locale'),
                ]),
                'Drivers' => self::present([
                    'Cache' => $get('cache.default'),
                    'Database' => $get('database.default'),
                    'Mail' => $mail !== null ? $mail : $get('mail.driver'),
                    'Queue' => $get('queue.default'),
                    'Session' => $get('session.driver'),
                ]),
            ];
        }

        /**
         * `about --json` keys of storage links (the link path, lower-cased and snake-cased) => the configured path,
         * so the panel shows the real path.
         *
         * @param object $app
         * @return array<string, string>
         */
        private static function storageLinks($app)
        {
            try {
                $links = $app->make('config')->get('filesystems.links', []);
            } catch (\Throwable $e) {
                return [];
            }
            $map = [];
            foreach (is_array($links) ? array_keys($links) : [] as $link) {
                if (!is_string($link) || $link === '') {
                    continue;
                }
                $key = class_exists('Illuminate\Support\Str')
                    ? \Illuminate\Support\Str::snake(\Illuminate\Support\Str::lower($link))
                    : strtolower((string) preg_replace('/\s+/u', '', $link));
                $map[$key] = $link;
            }

            return $map;
        }
    }
}
