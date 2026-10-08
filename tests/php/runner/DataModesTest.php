<?php
/**
 * Data-mode dispatch (docs/ARCHITECTURE.md §1.3 table): every mode emits one PhpDataEnvelope
 * `{version, mode, phpVersion, driver, data, error?}`. The P4 classes are tested in tests/php/data; these tests
 * cover the runner side (bootstrapping, routing, payload fields, failures).
 */

require_once __DIR__ . '/support.php';

if (!function_exists('p1_assert_data_envelope')) {
    function p1_assert_data_envelope(array $env, $mode, $expectError = false)
    {
        $keys = array_values(array_diff(array_keys($env), ['__stdout_outside', '__stderr']));
        sort($keys);
        $expected = ['data', 'driver', 'mode', 'phpVersion', 'version'];
        if ($expectError) $expected[] = 'error';
        sort($expected);
        t_same($expected, $keys, 'PhpDataEnvelope keys' . (isset($env['error']) ? ' (error: ' . $env['error'] . ')' : ''));
        t_same(1, $env['version']);
        t_same($mode, $env['mode']);
        t_same(PHP_VERSION, $env['phpVersion']);
        t_same("\n\n", $env['__stdout_outside'], 'data modes print nothing but the envelope');
    }
}

$tests = [];

$tests['detect: driver info and the php -v line'] = function () {
    $env = p1_data('detect');
    p1_assert_data_envelope($env, 'detect');
    t_same('none', $env['data']['driver']['id']);
    t_same($env['driver'], $env['data']['driver']);
    t_assert(strpos($env['data']['phpVersionLine'], 'PHP ' . PHP_VERSION . ' (cli)') === 0, $env['data']['phpVersionLine']);
};

$tests['detect: custom project driver is bootstrapped for its appVersion'] = function () {
    $project = p1_temp_project([
        'p1.marker' => '',
        '.tinkerbox/drivers/P1DetectDriver.php' => "<?php\nclass P1DetectDriver extends \\Tinkerbox\\Drivers\\Driver {\n"
            . "  private \$v = 'unbooted';\n"
            . "  public function id(): string { return 'p1-detect'; }\n"
            . "  public function name(): string { return 'P1 Detect'; }\n"
            . "  public function canBootstrap(string \$p): bool { return is_file(\$p . '/p1.marker'); }\n"
            . "  public function bootstrap(string \$p): void { \$this->v = 'Booted 2.0'; echo 'noise from the framework'; }\n"
            . "  public function version(): ?string { return \$this->v; }\n}\n",
    ]);
    $env = p1_data('detect', ['projectPath' => $project]);
    t_same('p1-detect', $env['data']['driver']['id']);
    t_same('P1 Detect', $env['data']['driver']['name']);
    t_same('Booted 2.0', $env['data']['driver']['appVersion']);
    t_contains('noise from the framework', $env['__stdout_outside'], 'bootstrap output stays outside the envelope');
};

$tests['snippets: project snippets from .tinkerbox/snippets'] = function () {
    $project = p1_temp_project([
        '.tinkerbox/snippets/count-users.php' => "<?php\n/**\n * @label Count users\n * @description How many users?\n */\nUser::count();\n",
    ]);
    $env = p1_data('snippets', ['projectPath' => $project]);
    p1_assert_data_envelope($env, 'snippets');
    t_same(1, count($env['data']));
    t_same('Count users', $env['data'][0]['name']);
    t_same('How many users?', $env['data'][0]['description']);
    t_same('User::count();', $env['data'][0]['code']);
};

$tests['logs and logRead: listing and entries from <project>/storage/logs'] = function () {
    $log = "[2024-01-01 10:00:00] local.INFO: first entry\n[2024-01-02 11:00:00] local.ERROR: second entry {\"id\":1}\n";
    $project = p1_temp_project(['storage/logs/laravel.log' => $log]);
    $listing = p1_data('logs', ['projectPath' => $project]);
    p1_assert_data_envelope($listing, 'logs');
    t_same(1, count($listing['data']['files']));
    $read = p1_data('logRead', ['projectPath' => $project, 'logFile' => 'laravel.log', 'logLimit' => 1]);
    p1_assert_data_envelope($read, 'logRead');
    t_same(1, count($read['data']), 'logLimit is honoured');
    t_contains('second entry', json_encode($read['data'][0]), 'newest first');
};

$tests['logRead: path traversal outside the log root is an error'] = function () {
    $project = p1_temp_project(['storage/logs/laravel.log' => "x\n", 'secret.txt' => 'secret']);
    $env = p1_data('logRead', ['projectPath' => $project, 'logFile' => '../../secret.txt']);
    t_assert(isset($env['error']) && $env['error'] !== '', 'error expected');
    t_assert(strpos(json_encode($env['data']), 'secret') === false, 'no content leaked');
};

$tests['members: class members for the className payload field'] = function () {
    $env = p1_data('members', ['className' => 'ArrayObject']);
    p1_assert_data_envelope($env, 'members');
    t_same('ArrayObject', $env['data']['class']);
    t_contains('"count"', json_encode($env['data']['members']));
    $missing = p1_data('members', ['className' => 'P1\\Does\\Not\\Exist']);
    t_same(null, $missing['data']);
};

$tests['environment and panels modes return their data'] = function () {
    $env = p1_data('environment');
    p1_assert_data_envelope($env, 'environment');
    t_assert(is_array($env['data']) && isset($env['data']['functions']), 'EnvironmentInfo');
    $panels = p1_data('panels');
    p1_assert_data_envelope($panels, 'panels');
    t_assert(is_array($panels['data']), 'AppPanel[]');
};

$tests['unknown modes and bootstrap failures report an error with null data'] = function () {
    $unknown = p1_data('p1-bogus');
    p1_assert_data_envelope($unknown, 'p1-bogus', true);
    t_same(null, $unknown['data']);
    t_contains('p1-bogus', $unknown['error']);
    $project = p1_temp_project([
        'p1.marker' => '',
        '.tinkerbox/drivers/P1FailDriver.php' => "<?php\nclass P1FailDriver extends \\Tinkerbox\\Drivers\\Driver {\n"
            . "  public function id(): string { return 'p1-fail'; }\n"
            . "  public function name(): string { return 'P1 Fail'; }\n"
            . "  public function canBootstrap(string \$p): bool { return true; }\n"
            . "  public function bootstrap(string \$p): void { throw new RuntimeException('cannot boot'); }\n}\n",
    ]);
    $env = p1_data('environment', ['projectPath' => $project]);
    p1_assert_data_envelope($env, 'environment', true);
    t_contains('cannot boot', $env['error']);
};

$tests['a data mode whose framework exits during bootstrap still emits its envelope'] = function () {
    $project = p1_temp_project([
        '.tinkerbox/drivers/P1QuitDriver.php' => "<?php\nclass P1QuitDriver extends \\Tinkerbox\\Drivers\\Driver {\n"
            . "  public function id(): string { return 'p1-quit'; }\n"
            . "  public function name(): string { return 'P1 Quit'; }\n"
            . "  public function canBootstrap(string \$p): bool { return true; }\n"
            . "  public function bootstrap(string \$p): void { exit(2); }\n}\n",
    ]);
    $env = p1_data('detect', ['projectPath' => $project]);
    t_same('detect', $env['mode']);
    t_contains('exit', $env['error']);
    t_same('p1-quit', $env['data']['driver']['id']);
};

return $tests;
