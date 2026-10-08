<?php
/**
 * Smoke tests against a REAL Laravel application (read-only, side-effect-free code only: no migrations, no writes;
 * queries run on a runtime-configured in-memory sqlite connection). Skipped when the project is not available.
 */

require_once __DIR__ . '/support.php';

$tests = [];

$tests['Laravel: app()->version() with driver info'] = function () {
    $project = p1_laravel_project();
    if ($project === '') return;
    $env = p1_run('app()->version()', [], ['projectPath' => $project]);
    p1_assert_run_envelope($env);
    t_same(null, $env['exception']);
    t_same('laravel', $env['driver']['id']);
    t_same('Laravel', $env['driver']['name']);
    t_same('Laravel ' . $env['returnValue']['v'], $env['driver']['appVersion']);
    t_assert((bool) preg_match('/^\d+\.\d+\.\d+/', $env['returnValue']['v']), $env['returnValue']['v']);
    t_same($project . '/storage/logs', $env['driver']['logFilesPath']);
    t_assert($env['bootMs'] > 0, 'bootMs');
    t_same([], $env['diagnostics']);
};

$tests['Laravel: query capture on a runtime in-memory sqlite connection'] = function () {
    $project = p1_laravel_project();
    if ($project === '') return;
    $code = <<<'PHP'
config(['database.connections.p1_memory' => ['driver' => 'sqlite', 'database' => ':memory:', 'prefix' => '']]);
$db = DB::connection('p1_memory');
$db->statement('create table notes (id integer primary key, body text)');
$db->insert('insert into notes (body) values (?)', ["it's"]);
$db->table('notes')->where('body', "it's")->value('body')
PHP;
    $env = p1_run($code, [], ['projectPath' => $project]);
    t_same(null, $env['exception']);
    $queries = p1_events($env, 'query');
    t_same(3, count($queries));
    t_same(3, $queries[0]['line']);
    t_same('p1_memory', $queries[1]['connection']);
    t_same(["it's"], $queries[1]['bindings']);
    t_same("insert into notes (body) values ('it''s')", $queries[1]['rawSql']);
    t_same(5, $queries[2]['line']);
    t_contains("= 'it''s'", $queries[2]['rawSql']);
    t_same("it's", $env['returnValue']['v']);
};

$tests['Laravel: VarDumper handler, aliases and provisional classes bound into the container'] = function () {
    $project = p1_laravel_project();
    if ($project === '') return;
    $code = <<<'PHP'
interface P1Clock { public function now(); }
class P1FixedClock implements P1Clock { public function now() { return 'fixed'; } }
app()->bind(P1Clock::class, P1FixedClock::class);
collect([1, 2])->dump();
User::query()->where('id', 5)->toSql() . '|' . app(P1Clock::class)->now()
PHP;
    $env = p1_run($code, [], ['projectPath' => $project]);
    t_same(null, $env['exception']);
    $dumps = p1_events($env, 'dump');
    t_same(1, count($dumps));
    t_same(4, $dumps[0]['line']);
    t_same(true, $dumps[0]['userCode']);
    t_contains('users', $env['returnValue']['v']);
    t_contains('|fixed', $env['returnValue']['v']);
};

$tests['Laravel: collection dd() ends the run through the VarDumper handler'] = function () {
    $project = p1_laravel_project();
    if ($project === '') return;
    $env = p1_run("echo 'x';\ncollect(['a' => 1])->dd();\necho 'never';", [], ['projectPath' => $project]);
    t_same(true, $env['exited']);
    t_same(null, $env['exception']);
    t_same(['echo:1:x', 'dump:2:[a=>1]'], p1_event_summary($env));
};

$tests['Laravel: data modes detect the project'] = function () {
    $project = p1_laravel_project();
    if ($project === '') return;
    $env = p1_data('detect', ['projectPath' => $project]);
    t_same('laravel', $env['data']['driver']['id']);
    t_assert(!isset($env['error']), 'no error');
};

return $tests;
