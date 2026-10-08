<?php
/**
 * \Tinkerbox\Panels (docs/ARCHITECTURE.md §1.8): normalization of a driver's panels() (Panel builders, AppPanel
 * arrays and looser shapes) to AppPanel[], the default panel, and Laravel's "App Information" (`about --json` with
 * readable keys, configuration fallback) against the real read-only Laravel project.
 */

require_once __DIR__ . '/support/helpers.php';
t_load_runner_sources();

use Tinkerbox\Panels\Panel;

if (!class_exists('P4PanelsDriver', false)) {
    /** Driver whose panels() result is set by each test. */
    class P4PanelsDriver extends \Tinkerbox\Drivers\Driver
    {
        /** @var mixed|\Closure */
        public $panels = [];

        public function id(): string
        {
            return 'p4-panels';
        }

        public function name(): string
        {
            return 'P4 panels';
        }

        public function canBootstrap(string $projectPath): bool
        {
            return false;
        }

        public function bootstrap(string $projectPath): void
        {
        }

        public function panels(string $projectPath): array
        {
            $panels = $this->panels instanceof \Closure ? call_user_func($this->panels) : $this->panels;

            return is_array($panels) ? $panels : [$panels];
        }
    }

    /** A panel object whose conversion fails. */
    class P4BrokenPanel
    {
        public function toArray()
        {
            throw new \RuntimeException('broken panel');
        }
    }

    function p4_panels_for($panels): array
    {
        $driver = new P4PanelsDriver();
        $driver->panels = $panels;

        return \Tinkerbox\Panels::forDriver($driver, '');
    }

    /** Plain value of a Dumper node (run envelopes). */
    function p4_value(array $node)
    {
        switch ($node['t']) {
            case 'null':
                return null;
            case 'bool':
            case 'string':
                return $node['v'];
            case 'int':
                return (int) $node['v'];
            case 'float':
                return (float) $node['v'];
            case 'array':
                $out = [];
                foreach ($node['items'] as $item) {
                    $out[$item['k']] = p4_value($item['v']);
                }

                return $out;
        }

        return $node;
    }

    function p4_panel_section_rows(array $panel, string $section): array
    {
        foreach ($panel['sections'] as $s) {
            if ($s['title'] === $section) {
                return array_column($s['rows'], 'value', 'key');
            }
        }

        return [];
    }
}

$tests = [];

$tests['Panel builders and AppPanel arrays become AppPanels in order'] = function () {
    $shop = Panel::make('Shop')
        ->section('Orders', ['Open' => 2, 'Express' => true])
        ->section('Stock', ['SKUs' => 1200, 'Updated' => null, 'Tags' => ['a', 'b']]);
    $panels = p4_panels_for([
        $shop->toArray(),
        Panel::make('As object')->section('S', ['k' => 1.5]),
        Panel::make('Empty'),
    ]);
    p4_assert_panels($panels);
    t_same([
        ['title' => 'Shop', 'sections' => [
            ['title' => 'Orders', 'rows' => [['key' => 'Open', 'value' => '2'], ['key' => 'Express', 'value' => 'true']]],
            ['title' => 'Stock', 'rows' => [['key' => 'SKUs', 'value' => '1200'], ['key' => 'Updated', 'value' => ''], ['key' => 'Tags', 'value' => 'a, b']]],
        ]],
        ['title' => 'As object', 'sections' => [['title' => 'S', 'rows' => [['key' => 'k', 'value' => '1.5']]]]],
        ['title' => 'Empty', 'sections' => []],
    ], $panels);
};

$tests['sections and rows named like keywords are kept exactly'] = function () {
    $panel = Panel::make('Keywords')
        ->section('rows', ['value' => 'x', 'key' => 'y'])
        ->section('data', ['title' => 'z'])
        ->section('sections', ['rows' => 'w']);
    t_same([['title' => 'Keywords', 'sections' => [
        ['title' => 'rows', 'rows' => [['key' => 'value', 'value' => 'x'], ['key' => 'key', 'value' => 'y']]],
        ['title' => 'data', 'rows' => [['key' => 'title', 'value' => 'z']]],
        ['title' => 'sections', 'rows' => [['key' => 'rows', 'value' => 'w']]],
    ]]], p4_panels_for([$panel->toArray()]));
};

$tests['looser panel shapes from custom drivers are normalized'] = function () {
    $panels = \Tinkerbox\Panels::normalizeAll([
        ['title' => 'AppPanel shape', 'sections' => [['title' => 'A', 'rows' => [['key' => 'k', 'value' => 'v']]]]],
        ['name' => 'Map content', 'content' => ['Version' => '1.0', 'Debug' => false]],
        ['title' => 'Sections keyed by title', 'content' => ['Env' => ['Name' => 'x'], 'Cache' => ['Driver' => 'redis']]],
        ['title' => 'Row lists', 'rows' => [['Label', 'Value'], ['label' => 'L', 'value' => 2], ['single' => 'pair']]],
        ['title' => 'Text', 'content' => '  hello  '],
        ['title' => 'Section list', 'content' => [['title' => 'One', 'data' => ['a' => 1]], ['title' => 'Two', 'items' => [['key' => 'b', 'value' => 2]]]]],
        'Keyed title' => ['content' => ['a' => 1]],
        'not a panel',
    ]);
    p4_assert_panels($panels);
    t_same(['title' => 'AppPanel shape', 'sections' => [['title' => 'A', 'rows' => [['key' => 'k', 'value' => 'v']]]]], $panels[0]);
    t_same(['title' => 'Map content', 'sections' => [['title' => '', 'rows' => [['key' => 'Version', 'value' => '1.0'], ['key' => 'Debug', 'value' => 'false']]]]], $panels[1]);
    t_same([['title' => 'Env', 'rows' => [['key' => 'Name', 'value' => 'x']]], ['title' => 'Cache', 'rows' => [['key' => 'Driver', 'value' => 'redis']]]], $panels[2]['sections']);
    t_same([['key' => 'Label', 'value' => 'Value'], ['key' => 'L', 'value' => '2'], ['key' => 'single', 'value' => 'pair']], $panels[3]['sections'][0]['rows']);
    t_same([['title' => '', 'rows' => [['key' => '', 'value' => 'hello']]]], $panels[4]['sections']);
    t_same([['title' => 'One', 'rows' => [['key' => 'a', 'value' => '1']]], ['title' => 'Two', 'rows' => [['key' => 'b', 'value' => '2']]]], $panels[5]['sections']);
    t_same('Keyed title', $panels[6]['title']);
    t_same(7, count($panels), 'scalars are not panels');

    t_same('a: 1, b: x, c: 2024-01-02 03:04:05 UTC', \Tinkerbox\Panels::stringify(['a' => 1, 'b' => 'x', 'c' => new DateTimeImmutable('2024-01-02 03:04:05', new DateTimeZone('UTC'))]));
    t_same('Closure', \Tinkerbox\Panels::stringify(function () {
    }));
    t_same('PHP Version', \Tinkerbox\Panels::humanize('php_version'));
    t_same('Application Name', \Tinkerbox\Panels::humanize('application_name'));
    t_same('URL', \Tinkerbox\Panels::humanize('url'));
    t_same('/var/www/public/storage', \Tinkerbox\Panels::humanize('/var/www/public/storage'));
    t_same([['key' => 'a', 'value' => '1']], \Tinkerbox\Panels::normalizeRows(new ArrayObject(['a' => 1])));
};

$tests['the default panel is used when a driver has no usable panel'] = function () {
    $default = p4_panels_for([]);
    p4_assert_panels($default);
    t_same(['PHP Environment'], array_column($default, 'title'));
    t_same(PHP_VERSION, p4_panel_section_rows($default[0], 'PHP')['Version']);
    t_same($default, p4_panels_for(null));
    t_same($default, p4_panels_for(['just a string']));
    t_same($default, p4_panels_for([new P4BrokenPanel()]), 'a panel that fails to convert is skipped');
    t_same($default, p4_panels_for(function () {
        throw new \RuntimeException('panels() failed');
    }), 'a failing panels() falls back to the default');
    // A broken panel next to a good one: only the good one is shown.
    $panels = p4_panels_for([new P4BrokenPanel(), Panel::make('Good')->toArray()]);
    t_same([['title' => 'Good', 'sections' => []]], $panels);
    // Traversables are accepted too.
    t_same('Generated', p4_panels_for(function () {
        return iterator_to_array((function () {
            yield Panel::make('Generated')->toArray();
        })());
    })[0]['title']);
};

$tests['Laravel: App Information from `about --json` with readable keys'] = function () {
    $project = t_laravel_project();
    if (!is_file($project . '/vendor/autoload.php') || p4_php(80200) === null) {
        p4_skip('no Laravel project / PHP >= 8.2');

        return;
    }
    $before = p4_snapshot(p4_project_dirs($project));
    $envelope = p4_with_safe_laravel_env(function () use ($project) {
        return t_run_bundle(['mode' => 'panels', 'projectPath' => $project, 'homePath' => p4_tmpdir('home')], null, p4_php(80200));
    });
    t_same($before, p4_snapshot(p4_project_dirs($project)), 'the Laravel project must not be written to');
    $panels = $envelope['data'];
    p4_assert_panels($panels);
    t_same('App Information', $panels[0]['title']);
    $titles = array_column($panels[0]['sections'], 'title');
    t_same(['Environment', 'Cache', 'Drivers'], array_slice($titles, 0, 3));
    $environment = array_column($panels[0]['sections'][0]['rows'], 'value', 'key');
    foreach (['Application Name', 'Laravel Version', 'PHP Version', 'Composer Version', 'Environment', 'Debug Mode', 'URL', 'Maintenance Mode', 'Timezone', 'Locale'] as $key) {
        t_assert(array_key_exists($key, $environment), "Environment row '$key' in " . json_encode(array_keys($environment)));
    }
    t_same($envelope['phpVersion'], $environment['PHP Version']);
    t_assert(preg_match('/^\d+\.\d+\.\d+/', $environment['Laravel Version']) === 1, $environment['Laravel Version']);
    t_same('local', $environment['Environment']);
    t_same(['Cache' => 'array', 'Database' => 'sqlite'], array_intersect_key(array_column($panels[0]['sections'][2]['rows'], 'value', 'key'), ['Database' => 1, 'Cache' => 1]));
    if (in_array('Storage', $titles, true)) {
        foreach (p4_panel_section_rows($panels[0], 'Storage') as $key => $value) {
            t_assert(strpos($key, $project) === 0, 'storage link paths keep their case: ' . $key);
        }
    }
    t_same(1, count(array_keys(array_column($panels, 'title'), 'App Information')), 'about runs once: one App Information panel');
};

$tests['Laravel: App Information from the configuration (no `about` command)'] = function () {
    $project = t_laravel_project();
    if (!is_file($project . '/vendor/autoload.php') || p4_php(80200) === null) {
        p4_skip('no Laravel project / PHP >= 8.2');

        return;
    }
    $code = '[\Tinkerbox\Panels\StandardPanels::laravel(app(), false), app()->version(), config("app.name"), config("app.url"), (bool) config("app.debug"), config("app.timezone")]';
    $envelope = p4_with_safe_laravel_env(function () use ($project, $code) {
        return t_run_bundle(['projectPath' => $project, 'homePath' => p4_tmpdir('home'), 'code' => $code], null, p4_php(80200));
    });
    t_same(null, $envelope['exception'], json_encode($envelope['exception']));
    list($panel, $version, $name, $url, $debug, $timezone) = p4_value($envelope['returnValue']);
    t_same('App Information', $panel['title']);
    t_same(['Environment', 'Drivers'], array_column($panel['sections'], 'title'));
    $environment = p4_panel_section_rows($panel, 'Environment');
    t_same([
        'Application Name' => (string) $name,
        'Laravel Version' => $version,
        'PHP Version' => $envelope['phpVersion'],
        'Environment' => 'local',
        'Debug Mode' => $debug ? 'true' : 'false',
        'URL' => (string) $url,
        'Timezone' => (string) $timezone,
    ], array_intersect_key($environment, array_flip(['Application Name', 'Laravel Version', 'PHP Version', 'Environment', 'Debug Mode', 'URL', 'Timezone'])));
    t_same(['Cache' => 'array', 'Database' => 'sqlite'], array_intersect_key(p4_panel_section_rows($panel, 'Drivers'), ['Cache' => 1, 'Database' => 1]));
};

return $tests;
