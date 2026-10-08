<?php
/**
 * Tinkerbox WordPress fixture: sets up the fake core like wp-settings.php does (version globals, plugin API, wpdb,
 * blog info helpers). Globals are assigned at file scope exactly like WordPress, so the driver must load this file
 * with WordPress' globals bound to $GLOBALS.
 */
define('WPINC', 'wp-includes');

require ABSPATH . WPINC . '/version.php';
require ABSPATH . WPINC . '/plugin.php';
require ABSPATH . WPINC . '/class-wpdb.php';
require ABSPATH . WPINC . '/functions.php';

if (!defined('WP_CONTENT_DIR')) {
    define('WP_CONTENT_DIR', ABSPATH . 'wp-content');
}

require_wp_db();

$wp_fixture_loaded_at = microtime(true);

do_action('plugins_loaded');
do_action('init');
do_action('wp_loaded');
