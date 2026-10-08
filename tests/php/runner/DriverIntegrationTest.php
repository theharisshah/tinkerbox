<?php
/**
 * Runner ↔ driver wiring (docs/ARCHITECTURE.md §1.4 steps 2–5, 8–9): bootstrap timing and failures, driver
 * variables in the user's scope, listenForQueries() / afterRun() and driver warnings. Uses throw-away projects with
 * `.tinkerbox/drivers/*.php` files.
 */

require_once __DIR__ . '/support.php';

if (!function_exists('p1_driver_project')) {
    /** Temp project with a custom driver class body (methods besides id / name / canBootstrap). */
    function p1_driver_project($class, $methods)
    {
        $source = "<?php\nclass {$class} extends \\Tinkerbox\\Drivers\\Driver\n{\n"
            . "    public function id(): string { return '" . strtolower($class) . "'; }\n"
            . "    public function name(): string { return '{$class}'; }\n"
            . "    public function canBootstrap(string \$projectPath): bool { return is_file(\$projectPath . '/p1.marker'); }\n"
            . $methods . "\n}\n";
        return p1_temp_project(['p1.marker' => '', '.tinkerbox/drivers/' . $class . '.php' => $source]);
    }
}

$tests = [];

$tests['custom driver: info, bootstrap time and variables in the user scope'] = function () {
    $project = p1_driver_project('P1VarsDriver', <<<'PHP'
    public function bootstrap(string $projectPath): void { usleep(20000); $GLOBALS['p1_booted_in'] = getcwd(); }
    public function variables(): array { return ['greeting' => 'hello', 'answer' => 42, 'not valid' => 1, 'this' => 2]; }
    public function version(): ?string { return 'P1 App 1.0'; }
PHP
    );
    $env = p1_run("[\$greeting, \$answer, array_keys(get_defined_vars()), \$GLOBALS['p1_booted_in'] === getcwd()]", [], ['projectPath' => $project]);
    t_same(null, $env['exception']);
    t_same(['id' => 'p1varsdriver', 'name' => 'P1VarsDriver', 'appVersion' => 'P1 App 1.0', 'usesCollision' => null, 'logFilesPath' => null], $env['driver']);
    t_same('[0=>hello,1=>42,2=>[0=>greeting,1=>answer],3=>true]', p1_plain($env['returnValue']));
    t_assert($env['bootMs'] >= 15, 'bootMs measures bootstrap(): ' . $env['bootMs']);
};

$tests['custom driver: listenForQueries() listener records query events with lines'] = function () {
    $project = p1_driver_project('P1QueryDriver', <<<'PHP'
    public function bootstrap(string $projectPath): void {}
    public function listenForQueries(callable $listener): void { $GLOBALS['p1_listener'] = $listener; }
    public function afterRun(): void { $listener = $GLOBALS['p1_listener']; $listener('select deferred', [], 0.5, 'log'); }
PHP
    );
    $code = "echo 'start';\n\$GLOBALS['p1_listener']('select * from t where a = ? and b = ? and c = ?', ['x\\'y', null, true], 1.25, 'mysql');\necho 'end';";
    $env = p1_run($code, [], ['projectPath' => $project]);
    t_same(['echo:1:start', "query:2:select * from t where a = 'x''y' and b = NULL and c = 1", 'echo:3:end', 'query:-:select deferred'], p1_event_summary($env));
    $query = $env['events'][1];
    t_same(['x\'y', 'NULL', '1'], $query['bindings']);
    t_same(1.25, $query['timeMs']);
    t_same('mysql', $query['connection']);
};

$tests['captureQueries off disables query events'] = function () {
    $project = p1_driver_project('P1NoQueryDriver', <<<'PHP'
    public function bootstrap(string $projectPath): void {}
    public function listenForQueries(callable $listener): void { $GLOBALS['p1_listener'] = $listener; }
PHP
    );
    $env = p1_run("isset(\$GLOBALS['p1_listener'])", ['captureQueries' => false], ['projectPath' => $project]);
    t_same(false, $env['returnValue']['v'], 'the listener is not registered');
    t_same([], p1_run("\\Tinkerbox\\Capture::query('select 1');", ['captureQueries' => false])['events']);
};

$tests['listenForQueries() runs once, after bootstrap() and before the user code; afterRun() once at the end'] = function () {
    $project = p1_driver_project('P1OrderDriver', <<<'PHP'
    public function bootstrap(string $projectPath): void { $GLOBALS['p1_calls'][] = 'bootstrap'; }
    public function listenForQueries(callable $listener): void { $GLOBALS['p1_calls'][] = 'listen'; }
    public function variables(): array { $GLOBALS['p1_calls'][] = 'variables'; return []; }
    public function afterRun(): void { $GLOBALS['p1_calls'][] = 'afterRun'; echo implode(',', $GLOBALS['p1_calls']); }
PHP
    );
    $env = p1_run("\$GLOBALS['p1_calls'][] = 'code';", [], ['projectPath' => $project]);
    t_same(null, $env['exception']);
    t_same(['echo:-:bootstrap,listen,variables,code,afterRun'], p1_event_summary($env));

    $exited = p1_run("\$GLOBALS['p1_calls'][] = 'code';\nexit;", [], ['projectPath' => $project]);
    t_same(true, $exited['exited']);
    t_same(['echo:-:bootstrap,listen,variables,code,afterRun'], p1_event_summary($exited), 'afterRun() also runs after exit()');
};

$tests['a failing listenForQueries() or afterRun() becomes a diagnostic'] = function () {
    $project = p1_driver_project('P1FailingHooksDriver', <<<'PHP'
    public function bootstrap(string $projectPath): void {}
    public function listenForQueries(callable $listener): void { throw new RuntimeException('no database'); }
    public function afterRun(): void { throw new LogicException('flush failed'); }
PHP
    );
    $env = p1_run('40 + 2', [], ['projectPath' => $project]);
    t_same(null, $env['exception']);
    t_same('42', $env['returnValue']['v']);
    $messages = implode("\n", array_column($env['diagnostics'], 'message'));
    t_contains('Query logging is unavailable: RuntimeException: no database', $messages);
    t_contains('P1FailingHooksDriver::afterRun() failed: flush failed', $messages);
};

$tests['bootstrap exceptions are reported with bootstrap: true and the code does not run'] = function () {
    $project = p1_driver_project('P1BrokenDriver', <<<'PHP'
    public function bootstrap(string $projectPath): void { throw new RuntimeException('database offline'); }
PHP
    );
    $env = p1_run("echo 'ran';", [], ['projectPath' => $project]);
    p1_assert_run_envelope($env);
    t_same([], $env['events']);
    t_same('RuntimeException', $env['exception']['class']);
    t_same('database offline', $env['exception']['message']);
    t_same(true, $env['exception']['bootstrap']);
    t_same('p1brokendriver', $env['driver']['id']);
};

$tests['a framework that exits while bootstrapping still produces an envelope'] = function () {
    $project = p1_driver_project('P1ExitDriver', <<<'PHP'
    public function bootstrap(string $projectPath): void { echo 'maintenance mode'; exit(1); }
PHP
    );
    $env = p1_run("echo 'ran';", [], ['projectPath' => $project]);
    p1_assert_run_envelope($env);
    t_same(true, $env['exception']['bootstrap']);
    t_contains('exited while bootstrapping', $env['exception']['message']);
    t_same(true, $env['exited']);
    t_contains('maintenance mode', $env['__stdout_outside']);
};

$tests['fatal errors while bootstrapping are reported as bootstrap fatals'] = function () {
    $project = p1_driver_project('P1FatalBootDriver', <<<'PHP'
    public function bootstrap(string $projectPath): void { ini_set('memory_limit', '16M'); $a = []; while (true) { $a[] = str_repeat('y', 1048576); } }
PHP
    );
    $env = p1_run("echo 'ran';", [], ['projectPath' => $project]);
    t_same(true, $env['exception']['fatal']);
    t_same(true, $env['exception']['bootstrap']);
    t_same([], $env['events']);
};

$tests['a missing project folder is a bootstrap error'] = function () {
    $env = p1_run('1', [], ['projectPath' => sys_get_temp_dir() . '/tinkerbox-p1-does-not-exist']);
    t_same(true, $env['exception']['bootstrap']);
    t_contains('does not exist', $env['exception']['message']);
};

$tests['an unknown forced driver falls back to detection with a diagnostic'] = function () {
    $env = p1_run('1', [], ['driver' => 'p1-unknown-driver']);
    t_same('none', $env['driver']['id']);
    t_contains('p1-unknown-driver', $env['diagnostics'][0]['message']);
    t_same('1', $env['returnValue']['v']);
};

$tests['the runner chdir()s into the project'] = function () {
    $project = p1_temp_project(['data.txt' => 'payload']);
    $env = p1_run("file_get_contents('data.txt')", [], ['projectPath' => $project]);
    t_same('payload', $env['returnValue']['v']);
};

$tests['/*?.*/ measures the user code, not the framework bootstrap'] = function () {
    $project = p1_driver_project('P1SlowBootDriver', <<<'PHP'
    public function bootstrap(string $projectPath): void { usleep(300000); }
PHP
    );
    $env = p1_run("\$a = 1 /*?.*/;\n\$a", [], ['projectPath' => $project]);
    t_assert($env['bootMs'] >= 250, 'bootMs ' . $env['bootMs']);
    $seconds = (float) rtrim($env['magic'][0]['preview'], 's');
    t_assert($seconds < 0.2, 'timing badge excludes the 300 ms bootstrap: ' . $env['magic'][0]['preview']);
};

return $tests;
