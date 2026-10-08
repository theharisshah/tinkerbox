<?php
/**
 * Runnable fixture projects through the real runner bundle (t_run_bundle: manifest concatenation + payload over
 * stdin, exactly like the app): Symfony, WordPress, a project with its own driver (.tinkerbox/drivers), a Composer
 * library and plain PHP — on the harness PHP and on PHP 7.4 / 8.5.
 */

require_once __DIR__ . '/support.php';

if (!function_exists('p3_binaries_for_e2e')) {
    /** label => binary (null = harness PHP) */
    function p3_binaries_for_e2e(): array
    {
        $binaries = ['default' => null];
        foreach (p3_php_binaries() as $alias => $binary) {
            $binaries[$alias] = $binary;
        }

        return $binaries;
    }

    function p3_assert_no_diagnostics(array $envelope, string $label): void
    {
        t_same([], $envelope['diagnostics'], $label . ' diagnostics');
        t_same(null, $envelope['exception'], $label . ' exception: ' . json_encode($envelope['exception']) . "\nSTDERR: " . $envelope['__stderr']);
    }

    /** Query events of a run envelope as [sql, rawSql, connection]. */
    function p3_queries(array $envelope): array
    {
        $queries = [];
        foreach ($envelope['events'] as $event) {
            if ($event['kind'] === 'query') {
                $queries[] = [$event['sql'], $event['rawSql'], $event['connection']];
            }
        }

        return $queries;
    }
}

$tests = [];

$tests['Symfony: Dotenv + App\Kernel boot, $kernel / $container, Doctrine query capture'] = function () {
    foreach (p3_binaries_for_e2e() as $label => $php) {
        $envelope = p3_bundle([
            'projectPath' => p3_fixture('symfony'),
            'code' => "\$container->get('doctrine')->getConnection()->executeQuery('select * from users where id = ?', [5]);\n"
                . "[get_class(\$kernel), \$kernel->getEnvironment(), \$kernel->isDebug(), \$_SERVER['FIXTURE_GREETING'], get_class(\$container)]",
        ], $php);
        p3_assert_no_diagnostics($envelope, $label);
        t_same(['id' => 'symfony', 'name' => 'Symfony', 'appVersion' => 'Symfony 7.1.0', 'usesCollision' => null, 'logFilesPath' => p3_fixture('symfony') . '/var/log'], $envelope['driver'], $label);
        t_same(['App\Kernel', 'dev', true, 'hello from .env', 'Fixture\Symfony\Container'], p3_value($envelope['returnValue']), $label);
        t_same([['select * from users where id = ?', 'select * from users where id = 5', 'default']], p3_queries($envelope), $label);
    }
};

$tests['Symfony: panels and logs data modes'] = function () {
    $panels = p3_bundle(['projectPath' => p3_fixture('symfony'), 'mode' => 'panels']);
    t_same(null, isset($panels['error']) ? $panels['error'] : null);
    t_same(['App Information'], array_column($panels['data'], 'title'));
    t_same(['Symfony', 'PHP'], array_column($panels['data'][0]['sections'], 'title'));
    $symfony = p3_panel_rows($panels['data'][0], 'Symfony');
    t_same('7.1.0', $symfony['Version']);
    t_same('dev', $symfony['Environment']);
    t_same('true', $symfony['Debug']);
    t_same('App\Kernel', $symfony['Kernel']);
    t_same(PHP_VERSION, p3_panel_rows($panels['data'][0], 'PHP')['Version']);

    $logs = p3_bundle(['projectPath' => p3_fixture('symfony'), 'mode' => 'logs']);
    t_same(['root' => p3_fixture('symfony') . '/var/log', 'files' => []], $logs['data']);
};

$tests['WordPress: wp-load with globals, $wpdb, queries via log_query_custom_data'] = function () {
    foreach (p3_binaries_for_e2e() as $label => $php) {
        $envelope = p3_bundle([
            'projectPath' => p3_fixture('wordpress'),
            'code' => "\$wpdb->get_var(\$wpdb->prepare('SELECT COUNT(*) FROM wp_posts WHERE post_status = %s', 'publish'));\n"
                . "\$wpdb->query('UPDATE wp_options SET autoload = 1');\n"
                . "[array_keys(get_defined_vars()), SAVEQUERIES, count(\$wpdb->queries), \$wpdb->queries[0][4], \$wpdb->prefix, WP_USE_THEMES, isset(\$GLOBALS['wp_fixture_loaded_at']), \$_SERVER['HTTP_HOST']]",
        ], $php);
        p3_assert_no_diagnostics($envelope, $label);
        t_same(['id' => 'wordpress', 'name' => 'WordPress', 'appVersion' => 'WordPress 6.6.2', 'usesCollision' => false, 'logFilesPath' => p3_fixture('wordpress') . '/wp-content'], $envelope['driver'], $label);
        // SAVEQUERIES is defined by the driver; the filter returns $data so WordPress' own log keeps working.
        t_same([['wpdb'], true, 2, [], 'twf_', false, true, 'wordpress-fixture.test'], p3_value($envelope['returnValue']), $label);
        t_same([
            ["SELECT COUNT(*) FROM wp_posts WHERE post_status = 'publish'", "SELECT COUNT(*) FROM wp_posts WHERE post_status = 'publish'", 'wpdb'],
            ['UPDATE wp_options SET autoload = 1', 'UPDATE wp_options SET autoload = 1', 'wpdb'],
        ], p3_queries($envelope), $label);
    }
};

$tests['WordPress: SAVEQUERIES=false in wp-config still captures queries without warnings'] = function () {
    $project = p3_copy_tree(p3_fixture('wordpress'), p3_tmpdir('wp-nosave') . '/site');
    $config = file_get_contents($project . '/wp-config.php');
    file_put_contents($project . '/wp-config.php', str_replace("define('WP_CACHE', false);", "define('WP_CACHE', false);\ndefine('SAVEQUERIES', false);", $config));
    $envelope = p3_bundle(['projectPath' => $project, 'code' => "\$wpdb->query('SELECT 1');\n[SAVEQUERIES, count(\$wpdb->queries)]"]);
    p3_assert_no_diagnostics($envelope, 'SAVEQUERIES=false');
    t_same([false, 0], p3_value($envelope['returnValue']));
    t_same([['SELECT 1', 'SELECT 1', 'wpdb']], p3_queries($envelope));

    $legacy = p3_copy_tree(p3_fixture('wordpress'), p3_tmpdir('wp-legacy') . '/site');
    file_put_contents($legacy . '/wp-includes/version.php', "<?php\n\$wp_version = '5.2.4';\n\$wp_db_version = 44719;\n");
    $envelope = p3_bundle(['projectPath' => $legacy, 'code' => "\$wpdb->query('SELECT 2');\ncount(\$wpdb->queries)"]);
    p3_assert_no_diagnostics($envelope, 'WordPress < 5.3');
    t_same(1, p3_value($envelope['returnValue']));
    t_same([['SELECT 2', 'SELECT 2', 'wpdb']], p3_queries($envelope), 'queries diffed from $wpdb->queries after the run');
};

$tests['WordPress: panels, logs and environment data modes'] = function () {
    $panels = p3_bundle(['projectPath' => p3_fixture('wordpress'), 'mode' => 'panels']);
    t_same([[
        'title' => 'Site Information',
        'sections' => [
            ['title' => 'Site', 'rows' => [
                ['key' => 'Name', 'value' => 'Tinkerbox Fixture Blog'],
                ['key' => 'Description', 'value' => 'Just another Tinkerbox fixture'],
                ['key' => 'Home URL', 'value' => 'http://wordpress-fixture.test'],
                ['key' => 'Site URL', 'value' => 'http://wordpress-fixture.test'],
                ['key' => 'WordPress Version', 'value' => '6.6.2'],
                ['key' => 'Environment', 'value' => 'local'],
                ['key' => 'Multisite', 'value' => 'false'],
                ['key' => 'Language', 'value' => 'en_US'],
            ]],
            ['title' => 'Configuration', 'rows' => [
                ['key' => 'WP_DEBUG', 'value' => 'true'],
                ['key' => 'WP_DEBUG_LOG', 'value' => 'false'],
                ['key' => 'SAVEQUERIES', 'value' => 'false'],
                ['key' => 'WP_CACHE', 'value' => 'false'],
                ['key' => 'Database', 'value' => 'tinkerbox_fixture'],
                ['key' => 'Database Host', 'value' => 'localhost'],
                ['key' => 'Table Prefix', 'value' => 'twf_'],
            ]],
        ],
    ]], $panels['data']);

    $logs = p3_bundle(['projectPath' => p3_fixture('wordpress'), 'mode' => 'logs']);
    t_same(p3_fixture('wordpress') . '/wp-content', $logs['data']['root']);

    $environment = p3_bundle(['projectPath' => p3_fixture('wordpress'), 'mode' => 'environment']);
    $variables = [];
    foreach ($environment['data']['variables'] as $variable) {
        $variables[$variable['name']] = isset($variable['type']) ? $variable['type'] : null;
    }
    t_same(['wpdb' => 'wpdb'], $variables);
    t_assert(in_array('get_bloginfo', array_column($environment['data']['functions'], 'name'), true), 'WordPress functions are offered');
    t_assert(in_array('WP_DEBUG', $environment['data']['constants'], true), 'WordPress constants are offered');
};

$tests['Bedrock: its own driver id, WordPress behaviour'] = function () {
    $envelope = p3_bundle(['projectPath' => p3_fixture('bedrock'), 'mode' => 'detect']);
    t_same('bedrock', $envelope['data']['driver']['id']);
    t_same('Bedrock', $envelope['data']['driver']['name']);
    t_same(false, $envelope['data']['driver']['usesCollision'], 'inherited from WordPressDriver');
};

$tests['project driver: variables, query capture, aliases, relative log path, panels, snippets'] = function () {
    foreach (p3_binaries_for_e2e() as $label => $php) {
        $envelope = p3_bundle([
            'projectPath' => p3_fixture('acme-shop'),
            'code' => "\$orders = \$shop->orders();\n[\$acme, count(\$orders), get_class(new Order()), \$shop->name()]",
        ], $php);
        p3_assert_no_diagnostics($envelope, $label);
        t_same(['id' => 'acme-shop', 'name' => 'Acme Shop', 'appVersion' => 'Acme Shop 2.1.0', 'usesCollision' => null, 'logFilesPath' => p3_fixture('acme-shop') . DIRECTORY_SEPARATOR . 'storage/logs'], $envelope['driver'], $label);
        t_same(['Acme Shop', 2, 'Acme\Shop\Models\Order', 'Acme Shop'], p3_value($envelope['returnValue']), $label);
        t_same([['select * from orders where status = ?', "select * from orders where status = 'open'", 'acme']], p3_queries($envelope), $label);
    }

    $panels = p3_bundle(['projectPath' => p3_fixture('acme-shop'), 'mode' => 'panels']);
    t_same(['Acme Shop', 'Deploys', 'PHP Environment'], array_column($panels['data'], 'title'));
    t_same([
        ['title' => 'Orders', 'rows' => [['key' => 'Open', 'value' => '3'], ['key' => 'Express', 'value' => 'true']]],
        ['title' => 'Inventory', 'rows' => [['key' => 'SKUs', 'value' => '1200'], ['key' => 'Warehouse', 'value' => '']]],
    ], $panels['data'][0]['sections']);
    t_same([['title' => 'Last deploy', 'rows' => [['key' => 'Commit', 'value' => 'abc1234']]]], $panels['data'][1]['sections']);
    t_same(p3_fixture('acme-shop'), p3_panel_rows($panels['data'][2], 'Project')['Path']);

    $logs = p3_bundle(['projectPath' => p3_fixture('acme-shop'), 'mode' => 'logs']);
    t_same(['worker.txt'], array_column($logs['data']['files'], 'path'));
    $entries = p3_bundle(['projectPath' => p3_fixture('acme-shop'), 'mode' => 'logRead', 'logFile' => 'worker.txt', 'logLimit' => 10]);
    t_same(['error', 'info'], array_column($entries['data'], 'level'));

    $snippets = p3_bundle(['projectPath' => p3_fixture('acme-shop'), 'mode' => 'snippets']);
    t_same([['name' => 'Open orders', 'description' => 'Lists the open orders of the shop.', 'code' => '$shop->orders();', 'file' => p3_fixture('acme-shop') . '/.tinkerbox/snippets/open-orders.php']], $snippets['data']);

    $members = p3_bundle(['projectPath' => p3_fixture('acme-shop'), 'mode' => 'members', 'className' => 'Order']);
    t_same('Acme\Shop\Models\Order', $members['data']['class'], 'short names resolve through the class aliases');

    $environment = p3_bundle(['projectPath' => p3_fixture('acme-shop'), 'mode' => 'environment']);
    t_same(['shop', 'acme'], array_column($environment['data']['variables'], 'name'));
    foreach ($environment['data']['classes'] as $class) {
        t_assert(substr($class, -6) !== 'Driver', 'driver classes are not offered for autocompletion: ' . $class);
    }
};

$tests['Composer library, plain PHP and forced drivers'] = function () {
    foreach (p3_binaries_for_e2e() as $label => $php) {
        $envelope = p3_bundle(['projectPath' => p3_fixture('composer'), 'code' => "(new Greeter())->greet('Ada')"], $php);
        p3_assert_no_diagnostics($envelope, $label);
        t_same('composer', $envelope['driver']['id']);
        t_same('acme/greeter', $envelope['driver']['appVersion']);
        t_same('Hello, Ada!', p3_value($envelope['returnValue']), $label);
    }

    $plain = p3_bundle(['projectPath' => '', 'code' => '1 + 1']);
    t_same(['id' => 'none', 'name' => 'PHP', 'usesCollision' => null, 'logFilesPath' => null], $plain['driver']);
    t_same(2, p3_value($plain['returnValue']));

    $panels = p3_bundle(['projectPath' => '', 'mode' => 'panels']);
    t_same(['PHP Environment'], array_column($panels['data'], 'title'));
    t_same(['PHP'], array_column($panels['data'][0]['sections'], 'title'));
    t_same(PHP_VERSION, p3_panel_rows($panels['data'][0], 'PHP')['Version']);

    $composerPanels = p3_bundle(['projectPath' => p3_fixture('composer'), 'mode' => 'panels']);
    t_same(['App Information'], array_column($composerPanels['data'], 'title'));
    t_same(['Package', 'PHP'], array_column($composerPanels['data'][0]['sections'], 'title'));
    t_same('acme/greeter', p3_panel_rows($composerPanels['data'][0], 'Package')['Name']);
    t_same(PHP_VERSION, p3_panel_rows($composerPanels['data'][0], 'PHP')['Version']);

    // Forcing the Plain driver still loads the project's autoloader when there is one.
    $forced = p3_bundle(['projectPath' => p3_fixture('composer'), 'driver' => 'none', 'code' => "class_exists('Acme\\\\Greeter\\\\Greeter')"]);
    t_same('none', $forced['driver']['id']);
    t_same(true, p3_value($forced['returnValue']), 'the Plain driver loads vendor/autoload.php when present');
};

$tests['laravel-booted without a running application fails the bootstrap cleanly'] = function () {
    $envelope = p3_bundle(['projectPath' => '', 'driver' => 'laravel-booted', 'code' => '1']);
    t_same('laravel', $envelope['driver']['id']);
    t_assert(is_array($envelope['exception']), 'bootstrap exception expected');
    t_contains('A running Laravel application was expected', $envelope['exception']['message']);
    t_same(true, $envelope['exception']['bootstrap']);
};

$tests['bootstrap failures of built-in drivers are reported, not fatal'] = function () {
    // The detection fixture only has marker files: bootstrapping it must fail with a useful message.
    $envelope = p3_bundle(['projectPath' => p3_fixture('statamic'), 'code' => '1']);
    t_same('statamic', $envelope['driver']['id']);
    t_assert(is_array($envelope['exception']) && $envelope['exception']['bootstrap'] === true, json_encode($envelope['exception']));
    t_contains('composer install', $envelope['exception']['message']);

    $detect = p3_bundle(['projectPath' => p3_fixture('statamic'), 'mode' => 'detect']);
    t_same('statamic', $detect['data']['driver']['id']);
};

$tests['every fixture boots or fails with a readable bootstrap error, never a fatal error'] = function () {
    foreach (p3_binaries_for_e2e() as $label => $php) {
        foreach (p3_expected_fixture_ids() as $fixture => $id) {
            $envelope = p3_bundle(['projectPath' => p3_fixture($fixture), 'code' => '"ok"'], $php);
            t_same($id, $envelope['driver']['id'], "$label $fixture");
            if ($envelope['exception'] === null) {
                t_same('ok', p3_value($envelope['returnValue']), "$label $fixture");
                continue;
            }
            t_same(true, $envelope['exception']['bootstrap'], "$label $fixture: " . json_encode($envelope['exception']));
            t_assert(empty($envelope['exception']['fatal']), "$label $fixture must not die with a fatal error: " . $envelope['exception']['message']);
            t_assert(trim($envelope['exception']['message']) !== '', "$label $fixture has a message");
        }
    }
};

return $tests;
