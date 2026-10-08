<?php
/**
 * Exceptions, fatal errors and diagnostics in run mode (docs/ARCHITECTURE.md §1.4 steps 6–9, shutdown handler).
 * User-code locations use the P2 convention: `file === ''` and `line` = editor line.
 */

require_once __DIR__ . '/support.php';

$tests = [];

$tests['uncaught exception keeps earlier events and maps the line to the editor'] = function () {
    $env = p1_run("echo 'before';\n\$x = 1;\nthrow new InvalidArgumentException('bad', 42);\necho 'after';");
    p1_assert_run_envelope($env);
    t_same(['echo:1:before'], p1_event_summary($env));
    $e = $env['exception'];
    t_same('InvalidArgumentException', $e['class']);
    t_same('bad', $e['message']);
    t_same('42', $e['code']);
    t_same('', $e['file']);
    t_same(3, $e['line']);
    t_same(3, $e['userLine']);
    t_same(3, $e['snippet']['line']);
    t_contains("throw new InvalidArgumentException('bad', 42);", implode("\n", $e['snippet']['lines']));
    t_same(false, $env['hasReturnValue']);
    t_same(false, $env['exited']);
};

$tests['exceptions thrown in editor functions report user-code trace frames'] = function () {
    $env = p1_run("function p1_inner() {\n  throw new RuntimeException('deep');\n}\nfunction p1_outer() {\n  p1_inner();\n}\np1_outer();");
    $e = $env['exception'];
    t_same(2, $e['line']);
    $lines = [];
    foreach ($e['trace'] as $frame) {
        t_same(true, !empty($frame['userCode']), 'user frame: ' . json_encode($frame));
        $lines[] = $frame['line'];
    }
    t_same([5, 7], $lines);
};

$tests['exceptions inside closures and rewritten statements keep their lines'] = function () {
    $env = p1_run("\$f = function () {\n  echo 'in';\n  return intdiv(1, 0); //?\n};\n\$f();");
    t_same('DivisionByZeroError', $env['exception']['class']);
    t_same(3, $env['exception']['line']);
    t_same(['echo:2:in'], p1_event_summary($env));
};

$tests['previous exceptions are reported'] = function () {
    $env = p1_run("try {\n  throw new LogicException('inner');\n} catch (Exception \$e) {\n  throw new RuntimeException('outer', 0, \$e);\n}");
    t_same('outer', $env['exception']['message']);
    t_same('LogicException', $env['exception']['previous']['class']);
    t_same(2, $env['exception']['previous']['line']);
};

$tests['caught exceptions do not end the run'] = function () {
    $env = p1_run("try { throw new Exception('x'); } catch (Exception \$e) { echo \$e->getMessage(); }\n'done'");
    t_same(null, $env['exception']);
    t_same(['echo:1:x'], p1_event_summary($env));
    t_same('done', $env['returnValue']['v']);
};

$tests['parse errors are reported as ParseError on the editor line without running anything'] = function () {
    $env = p1_run("echo 'never';\n\$b = ;\n\$c = 1;");
    t_same('ParseError', $env['exception']['class']);
    t_same(2, $env['exception']['line']);
    t_same('', $env['exception']['file']);
    t_same([], $env['events']);
    t_same([], $env['coverage']);
};

$tests['fatal errors are captured by the shutdown handler with earlier output'] = function () {
    $env = p1_run("echo 'first';\nfunction p1_dup() {}\nfunction p1_dup() {}");
    p1_assert_run_envelope($env);
    t_same(true, $env['exception']['fatal']);
    t_contains('p1_dup', $env['exception']['message']);
    t_same(3, $env['exception']['line']);
    t_same('', $env['exception']['file']);
};

$tests['memory exhaustion is reported as a fatal error and keeps earlier events'] = function () {
    $env = p1_run("echo 'kept';\ndump(1);\n\$a = [];\nini_set('memory_limit', '32M');\nwhile (true) { \$a[] = str_repeat('x', 1048576); }");
    p1_assert_run_envelope($env);
    t_same(['echo:1:kept', 'dump:2:1'], p1_event_summary($env));
    t_same(true, $env['exception']['fatal']);
    t_contains('Allowed memory size', $env['exception']['message']);
    t_same(5, $env['exception']['line']);
    t_same(false, $env['exited']);
};

$tests['the time limit ends runaway code with a fatal error'] = function () {
    $env = p1_run("echo 'spin';\nwhile (true) {}", ['timeoutMs' => 1000]);
    t_same(true, $env['exception']['fatal']);
    t_contains('Maximum execution time', $env['exception']['message']);
    t_same(2, $env['exception']['line']);
    t_same(['echo:1:spin'], p1_event_summary($env));
};

$tests['warnings, notices and deprecations become diagnostics and the code continues'] = function () {
    $code = "\$a = [];\n\$b = \$a['missing'];\ntrigger_error('note', E_USER_NOTICE);\ntrigger_error('old', E_USER_DEPRECATED);\necho 'still running';\n'end'";
    $env = p1_run($code);
    t_same(null, $env['exception']);
    t_same(['echo:5:still running'], p1_event_summary($env));
    t_same('end', $env['returnValue']['v']);
    t_same(3, count($env['diagnostics']));
    list($missing, $note, $old) = $env['diagnostics'];
    t_same(PHP_VERSION_ID >= 80000 ? 'Warning' : 'Notice', $missing['level']);
    t_same(2, $missing['line']);
    t_same('', $missing['file']);
    t_same(['level' => 'Notice', 'message' => 'note', 'file' => '', 'line' => 3, 'userLine' => 3], $note);
    t_same(['level' => 'Deprecated', 'message' => 'old', 'file' => '', 'line' => 4, 'userLine' => 4], $old);
};

$tests['identical diagnostics in loops are reported once; @ silences them'] = function () {
    $env = p1_run("for (\$i = 0; \$i < 50; \$i++) { trigger_error('loop', E_USER_WARNING); }\n@trigger_error('quiet', E_USER_WARNING);\n\$x = @\$undefined;\nerror_get_last()['message']");
    t_same(1, count($env['diagnostics']));
    t_same('loop', $env['diagnostics'][0]['message']);
    t_same(1, $env['diagnostics'][0]['line']);
};

$tests['E_USER_ERROR and recoverable errors become catchable ErrorExceptions'] = function () {
    $env = p1_run("try {\n  trigger_error('stop', E_USER_ERROR);\n} catch (ErrorException \$e) {\n  echo 'caught ' . \$e->getMessage();\n}");
    t_same(null, $env['exception']);
    t_same(['echo:4:caught stop'], p1_event_summary($env));
    $uncaught = p1_run("\$a = 1;\ntrigger_error('boom', E_USER_ERROR);");
    t_same('ErrorException', $uncaught['exception']['class']);
    t_same(2, $uncaught['exception']['line']);
};

$tests['errors inside magic-comment taps do not break the statement'] = function () {
    $env = p1_run("\$n = 5; //?->missingMethod()\n\$n * 2");
    t_same(null, $env['exception']);
    t_same('10', $env['returnValue']['v']);
    t_contains('missingMethod', $env['magic'][0]['preview']);
};

$tests['a fatal error ends the request before shutdown handlers registered later (framework error renderers)'] = function () {
    // Frameworks register their fatal-error renderers / loggers while bootstrapping, i.e. after the runner.
    $code = "register_shutdown_function(function () { echo 'FRAMEWORK RENDERED'; fwrite(STDERR, 'FRAMEWORK LOGGED'); });\n"
        . "echo 'before';\nini_set('memory_limit', '32M');\n\$s = str_repeat('x', 64 * 1024 * 1024);";
    $env = p1_run($code);
    p1_assert_run_envelope($env);
    t_same(['echo:2:before'], p1_event_summary($env));
    t_same('FatalError', $env['exception']['class']);
    t_same(true, $env['exception']['fatal']);
    t_same(4, $env['exception']['userLine']);
    t_same(false, strpos($env['__stdout_outside'], 'FRAMEWORK RENDERED'), 'nothing is rendered after the envelope');
    t_same(false, strpos($env['__stderr'], 'FRAMEWORK LOGGED'), 'later shutdown handlers do not run');
};

$tests['exit() still runs shutdown functions registered later'] = function () {
    $env = p1_run("register_shutdown_function(function () { echo 'LATER'; });\necho 'bye';\nexit;");
    p1_assert_run_envelope($env);
    t_same(true, $env['exited']);
    t_same(null, $env['exception']);
    t_contains('LATER', $env['__stdout_outside']);
};

$tests['huge warning messages are capped and deduplicated instead of exhausting memory'] = function () {
    $env = p1_run("\$lookup = [];\nfor (\$i = 0; \$i < 40; \$i++) {\n  \$key = (\$i % 20) . str_repeat('k', 1100000);\n  \$w = \$lookup[\$key];\n}\n'done'");
    t_same(null, $env['exception']);
    t_same('done', p1_plain($env['returnValue']));
    t_same(20, count($env['diagnostics']), 'identical messages are still deduplicated');
    foreach ($env['diagnostics'] as $diagnostic) {
        t_assert(strlen($diagnostic['message']) < 4200, 'capped: ' . strlen($diagnostic['message']));
        t_contains('… (', $diagnostic['message']);
    }
};

$tests['a large paste does not exhaust the memory_limit while it is prepared'] = function () {
    $code = '';
    for ($i = 0; $i < 12000; $i++) $code .= "\$a$i = [$i, 's' => strlen('x$i')]; if (\$a$i) { \$b = \$a$i; }\n";
    $code .= '$b';
    $env = p1_raw_envelope(p1_raw($code, [], [], ['memory_limit' => '128M']));
    t_assert(is_array($env), 'envelope');
    t_same(null, $env['exception']);
    t_same('[0=>11999,s=>6]', p1_plain($env['returnValue']));
    t_same([], $env['diagnostics']);
};

return $tests;
