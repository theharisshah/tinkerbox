<?php
/**
 * Tinkerbox WordPress fixture: a minimal plugin API (filters / actions with priorities and accepted args).
 */
$wp_filter = isset($wp_filter) && is_array($wp_filter) ? $wp_filter : [];

function add_filter($hook_name, $callback, $priority = 10, $accepted_args = 1)
{
    global $wp_filter;
    $wp_filter[$hook_name][$priority][] = [$callback, (int) $accepted_args];
    ksort($wp_filter[$hook_name]);

    return true;
}

function add_action($hook_name, $callback, $priority = 10, $accepted_args = 1)
{
    return add_filter($hook_name, $callback, $priority, $accepted_args);
}

function apply_filters($hook_name, $value, ...$args)
{
    global $wp_filter;
    if (empty($wp_filter[$hook_name])) {
        return $value;
    }
    foreach ($wp_filter[$hook_name] as $callbacks) {
        foreach ($callbacks as $entry) {
            list($callback, $accepted) = $entry;
            $value = call_user_func_array($callback, array_slice(array_merge([$value], $args), 0, max(1, $accepted)));
        }
    }

    return $value;
}

function do_action($hook_name, ...$args)
{
    apply_filters($hook_name, null, ...$args);
}

function has_filter($hook_name)
{
    global $wp_filter;

    return !empty($wp_filter[$hook_name]);
}
