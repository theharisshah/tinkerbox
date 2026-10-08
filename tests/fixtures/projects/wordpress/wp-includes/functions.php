<?php
/**
 * Tinkerbox WordPress fixture: the blog / environment helpers used by the WordPress driver and its panel.
 */
function get_bloginfo($show = '', $filter = 'raw')
{
    global $wp_version;
    switch ($show) {
        case 'version':
            return $wp_version;
        case 'url':
        case 'wpurl':
            return WP_HOME;
        case 'description':
            return 'Just another Tinkerbox fixture';
        case 'name':
        default:
            return 'Tinkerbox Fixture Blog';
    }
}

function wp_get_environment_type()
{
    return defined('WP_ENVIRONMENT_TYPE') ? WP_ENVIRONMENT_TYPE : 'production';
}

function wp_get_development_mode()
{
    return defined('WP_DEVELOPMENT_MODE') ? WP_DEVELOPMENT_MODE : '';
}

function get_option($option, $default_value = false)
{
    $options = ['blogname' => get_bloginfo('name'), 'siteurl' => WP_SITEURL, 'home' => WP_HOME];

    return array_key_exists($option, $options) ? $options[$option] : $default_value;
}

function is_multisite()
{
    return false;
}

function get_locale()
{
    return 'en_US';
}
