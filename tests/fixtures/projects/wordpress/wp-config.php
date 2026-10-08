<?php
/**
 * Tinkerbox WordPress fixture configuration (like a real wp-config.php: constants plus $table_prefix at file scope).
 */
define('DB_NAME', 'tinkerbox_fixture');
define('DB_USER', 'fixture');
define('DB_PASSWORD', '');
define('DB_HOST', 'localhost');
define('WP_HOME', 'http://wordpress-fixture.test');
define('WP_SITEURL', 'http://wordpress-fixture.test');
define('WP_ENVIRONMENT_TYPE', 'local');
define('WP_DEBUG', true);
define('WP_CACHE', false);

$table_prefix = 'twf_';

if (!defined('ABSPATH')) {
    define('ABSPATH', __DIR__ . '/');
}

require_once ABSPATH . 'wp-settings.php';
