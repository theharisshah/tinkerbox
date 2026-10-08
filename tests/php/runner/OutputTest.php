<?php
/**
 * Event capture (docs/ARCHITECTURE.md §1.4 "Event capture"): one ordered list of echo / dump / query events with
 * editor lines, buffered vs realtime output, exit/dd and the exactly-once envelope.
 */

require_once __DIR__ . '/support.php';

$tests = [];

$tests['echo, print, printf, dump, var_dump, tw and queries are recorded in execution order'] = function () {
    $code = <<<'PHP'
echo 'one';
printf('%s', 'two');
dump(3);
print 'four';
var_dump(5);
\Tinkerbox\Capture::query('select * from users where id = ?', [6]);
tw(7, 'seven');
echo 'eight', "\n";
PHP;
    $env = p1_run($code);
    t_same([
        'echo:1:one',
        'echo:-:two',
        'dump:3:3',
        'echo:-:four',
        'dump:5:5',
        'query:6:select * from users where id = 6',
        'dump:7:7',
        "echo:8:eight\n",
    ], p1_event_summary($env));
    t_same('seven', $env['events'][6]['label']);
    t_same(true, $env['events'][2]['userCode']);
    t_same(false, $env['hasReturnValue']);
};

$tests['dump() with several values records one event each and returns the first value'] = function () {
    $env = p1_run("\$r = dump('a', 'b');\n\$r");
    t_same(['dump:1:a', 'dump:1:b'], p1_event_summary($env));
    t_same('a', $env['returnValue']['v']);
    $none = p1_run('dump();');
    t_same(1, count($none['events']), 'dump() without arguments marks the spot');
};

$tests['var_dump() returns null and records structured values'] = function () {
    $env = p1_run("\$r = var_dump(['k' => true]);\n\$r");
    t_same(['t' => 'null'], $env['returnValue']);
    t_same('array', $env['events'][0]['value']['t']);
};

$tests['echo in loops and functions keeps the editor line of the echo statement'] = function () {
    $env = p1_run("function p1_say(\$w) {\n  echo \$w;\n}\nforeach (['a', 'b'] as \$w) p1_say(\$w);\necho 'c';");
    t_same(['echo:2:ab', 'echo:5:c'], p1_event_summary($env));
};

$tests['dumps from callbacks and helper functions report the user code line'] = function () {
    $env = p1_run("\$f = 'dump';\n\$f('cb');\narray_map('dump', [1]);");
    t_same(['dump:2:cb', 'dump:3:1'], p1_event_summary($env));
};

$tests['dd() records its values, ends the run and sets exited'] = function () {
    $env = p1_run("echo 'before';\ndd('x', 2);\necho 'after';");
    t_same(['echo:1:before', 'dump:2:x', 'dump:2:2'], p1_event_summary($env));
    t_same(true, $env['exited']);
    t_same(false, $env['hasReturnValue']);
    t_same(null, $env['exception']);
    t_same([1, 2], $env['coverage']);
};

$tests['exit and die end the run with exited and keep the output'] = function () {
    $env = p1_run("echo 'a';\nfunction p1_stop() { exit(3); }\np1_stop();\necho 'b';");
    t_same(['echo:1:a'], p1_event_summary($env));
    t_same(true, $env['exited']);
    t_same(null, $env['exception']);
    $die = p1_run("echo 'a';\ndie('bye');");
    t_same(['echo:1:a', 'echo:-:bye'], p1_event_summary($die));
    t_same(true, $die['exited']);
};

$tests['the envelope is emitted exactly once (normal end, exit, dd, exception, fatal)'] = function () {
    $cases = ['1 + 1', 'exit(0);', 'dd(1);', 'throw new Exception("x");', 'function p1_twice() {} function p1_twice() {}', "echo 'x'; register_shutdown_function(function () { echo 'late'; });"];
    foreach ($cases as $code) {
        $raw = p1_raw($code);
        t_same(1, substr_count($raw['stdout'], $raw['nonce'] . 'BEGIN'), 'BEGIN markers for ' . $code . "\n" . $raw['stdout']);
        t_same(1, substr_count($raw['stdout'], $raw['nonce'] . 'END'), 'END markers for ' . $code);
    }
    $late = p1_raw("echo 'x'; register_shutdown_function(function () { echo 'late'; });");
    t_contains('END' . "\nlate", $late['stdout'], 'output after the run lands outside the envelope');
};

$tests['user output buffers keep working and unclosed ones are flushed into the events'] = function () {
    $env = p1_run("ob_start();\necho 'captured';\nvar_dump(1);\n\$s = ob_get_clean();\nob_start();\necho 'left open';\nstrlen(\$s) > 8");
    t_same(['echo:-:left open'], p1_event_summary($env));
    t_same(true, $env['returnValue']['v']);
    $text = p1_run("ob_start();\nvar_dump(12);\ntrim(ob_get_clean())");
    t_same('int(12)', $text['returnValue']['v'], 'var_dump writes into the user buffer');
};

$tests['realtime mode streams echo output to stdout and still records dumps'] = function () {
    $env = p1_run("echo 'a';\ndump(1);\nprint 'b';\necho 'c';\n5", ['outputType' => 'realtime']);
    t_same(['dump:2:1'], p1_event_summary($env));
    t_contains('abc', $env['__stdout_outside']);
    t_same('5', $env['returnValue']['v']);
    $exit = p1_run("echo 'x';\nexit;", ['outputType' => 'realtime']);
    t_contains('x', $exit['__stdout_outside']);
    t_same(true, $exit['exited']);
};

$tests['invalid UTF-8 output keeps the envelope valid JSON'] = function () {
    $env = p1_run("echo \"ok\\xff\\xfe\";\n\"bin\\x80\"");
    t_same("ok\u{FFFD}\u{FFFD}", $env['events'][0]['text']);
    t_same(true, $env['hasReturnValue']);
    t_same(true, !empty($env['returnValue']['binary']), 'binary strings are flagged by the dumper');
};

$tests['event cap: runaway output ends with a truncation notice'] = function () {
    $env = p1_run('for ($i = 0; $i < 1500; $i++) dump($i);');
    t_same(1001, count($env['events']));
    $last = end($env['events']);
    t_same('echo', $last['kind']);
    t_contains('output truncated (500 more events)', $last['text']);
};

$tests['echo of an array reports the conversion warning on the user line'] = function () {
    $env = p1_run("\$a = 1;\necho [1];");
    t_same(['echo:2:Array'], p1_event_summary($env));
    t_same(2, $env['diagnostics'][0]['userLine']);
    t_contains('Array to string conversion', $env['diagnostics'][0]['message']);
};

$tests['named dump arguments become labels (PHP 8)'] = function () {
    if (PHP_VERSION_ID < 80000) return;
    $env = p1_run('dump(total: 3);');
    t_same('total', $env['events'][0]['label']);
};

$tests['echo a, b prints each argument before evaluating the next (buffered and realtime)'] = function () {
    $code = "function p1_side() { echo 'b'; return 'c'; }\necho 'a', p1_side();\nfunction p1_throws() { throw new Exception('t'); }\necho 'visible', p1_throws();";
    $env = p1_run($code);
    t_same(['echo:2:a', 'echo:1:b', 'echo:2:c', 'echo:4:visible'], p1_event_summary($env));
    t_same('t', $env['exception']['message']);
    $realtime = p1_run($code, ['outputType' => 'realtime']);
    t_same("abcvisible\n\n", $realtime['__stdout_outside'], 'native order: ' . json_encode($realtime['__stdout_outside']));
};

$tests['a non-removable user output buffer cannot swallow the envelope'] = function () {
    foreach (['0', 'PHP_OUTPUT_HANDLER_CLEANABLE', 'PHP_OUTPUT_HANDLER_FLUSHABLE'] as $flags) {
        $raw = p1_raw("ob_start(null, 0, $flags);\necho 'x';\n1");
        $env = p1_raw_envelope($raw);
        t_assert(is_array($env), "envelope for flags $flags:\n" . $raw['stdout'] . $raw['stderr']);
        t_same('1', p1_plain($env['returnValue']), $flags);
        t_same('x', implode('', array_column($env['events'], 'text')), $flags);
        $realtime = p1_raw("ob_start(null, 0, $flags);\necho 'x';\n1", ['outputType' => 'realtime']);
        t_assert(is_array(p1_raw_envelope($realtime)), "realtime envelope for flags $flags");
    }
};

$tests['realtime mode: var_dump() inside a user ob_start() buffer goes into the buffer like in buffered mode'] = function () {
    foreach (['buffered', 'realtime'] as $mode) {
        $env = p1_run("ob_start();\nvar_dump(5);\n\$s = ob_get_clean();\n\$s", ['outputType' => $mode]);
        t_same("int(5)\n", p1_plain($env['returnValue']), $mode);
        t_same([], p1_events($env, 'dump'), $mode);
    }
};

$tests['echo from __debugInfo / __toString while the runner dumps a value is not program output'] = function () {
    $env = p1_run("class P1Noisy { function __debugInfo() { echo 'side'; return ['a' => 1]; } function __toString() { echo 'ts'; return 'N'; } }\n\$n = new P1Noisy; //?\n\$n");
    t_same([], $env['events']);
    t_same(1, count($env['magic']));
    $echoed = p1_run("class P1Loud { function __toString() { echo 'inside'; return 'L'; } }\necho new P1Loud;");
    t_same(['echo:1:inside', 'echo:2:L'], p1_event_summary($echoed), 'output of __toString while the program echoes stays');
};

return $tests;
