<?php
/**
 * Tinkerbox WordPress fixture: a tiny, runnable stand-in for WordPress core with the same bootstrap chain
 * (wp-load.php → wp-config.php → wp-settings.php) and the APIs the Tinkerbox WordPress driver and its "Site
 * Information" panel use. No database is involved: wpdb only records the queries it is asked to run.
 */
if (!defined('ABSPATH')) {
    define('ABSPATH', __DIR__ . '/');
}

error_reporting(E_ALL);

if (file_exists(ABSPATH . 'wp-config.php')) {
    require_once ABSPATH . 'wp-config.php';
}
