<?php
/**
 * Tinkerbox WordPress fixture: wpdb with WordPress' query logging behaviour. query() runs the `query` filter and,
 * when SAVEQUERIES is true, log_query() which runs the `log_query_custom_data` filter (5 arguments, since 5.3) and
 * stores [sql, seconds, caller, start, data] in $queries. Nothing is executed: every query "returns" one row.
 */
class wpdb
{
    public $queries = [];
    public $num_queries = 0;
    public $prefix = '';
    public $last_query = '';
    public $dbname;

    public function __construct($dbuser, $dbpassword, $dbname, $dbhost)
    {
        $this->dbname = $dbname;
    }

    public function set_prefix($prefix)
    {
        $this->prefix = $prefix;

        return $prefix;
    }

    public function prepare($query, ...$args)
    {
        if (count($args) === 1 && is_array($args[0])) {
            $args = $args[0];
        }
        foreach ($args as $arg) {
            $replacement = is_int($arg) || is_float($arg) ? (string) $arg : "'" . addslashes((string) $arg) . "'";
            $query = preg_replace('/%[sdf]/', $replacement, $query, 1);
        }

        return $query;
    }

    public function query($query)
    {
        $query = apply_filters('query', $query);
        $start = microtime(true);
        $this->num_queries++;
        $this->last_query = $query;
        usleep(200);
        if (defined('SAVEQUERIES') && SAVEQUERIES) {
            $this->log_query($query, microtime(true) - $start, 'wpdb->query', $start, []);
        }

        return 1;
    }

    public function log_query($query, $query_time, $query_callstack, $query_start, $query_data)
    {
        $query_data = apply_filters('log_query_custom_data', $query_data, $query, $query_time, $query_callstack, $query_start);
        $this->queries[] = [$query, $query_time, $query_callstack, $query_start, $query_data];
    }

    public function get_var($query = null)
    {
        $this->query($query);

        return '1';
    }

    public function get_results($query = null)
    {
        $this->query($query);

        return [(object) ['ID' => 1, 'post_title' => 'Hello world!']];
    }
}

function require_wp_db()
{
    global $wpdb, $table_prefix;
    $wpdb = new wpdb(DB_USER, DB_PASSWORD, DB_NAME, DB_HOST);
    $wpdb->set_prefix($table_prefix);
}
