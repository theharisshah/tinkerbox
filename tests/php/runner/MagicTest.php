<?php
/**
 * Magic comments end to end (docs/ARCHITECTURE.md §1.5 rule 6): MagicValue records in the envelope.
 */

require_once __DIR__ . '/support.php';

$tests = [];

$tests['//? records the value of the statement on its line'] = function () {
    $env = p1_run("\$a = ['x' => 1]; //?\n\$a");
    $magic = p1_magic($env);
    t_same(['1:17'], array_keys($magic));
    $m = $magic['1:17'];
    t_same(1, $m['line']);
    t_same(17, $m['column']);
    t_same('value', $m['type']);
    t_same(1, $m['hits']);
    t_same('array', $m['value']['t']);
    t_contains('"x" => 1', $m['preview']);
    t_assert(!isset($m['label']), 'no label');
    t_same('[x=>1]', p1_plain($env['returnValue']), 'the statement keeps its value');
};

$tests['//? label and #? forms'] = function () {
    $env = p1_run("\$total = 3 * 3; //? the total\n\$hash = 'h'; #?");
    $magic = p1_magic($env);
    t_same('the total', $magic['1:16']['label']);
    t_same('9', $magic['1:16']['preview']);
    t_same('"h"', $magic['2:13']['preview']);
};

$tests['//?->method() records the tapped value while the statement keeps its own'] = function () {
    $env = p1_run("\$bag = new ArrayObject([1, 2, 3]); //?->count()\nget_class(\$bag)");
    $m = p1_magic($env)['1:35'];
    t_same('3', $m['preview']);
    t_same(['t' => 'int', 'v' => '3'], $m['value']);
    t_same('ArrayObject', $env['returnValue']['v']);
};

$tests['inline /*?*/ and /*?->expr*/ capture sub-expressions'] = function () {
    $env = p1_run('$n = (new ArrayObject([1, 2]))/*?->getArrayCopy()*/->count()/*?*/;' . "\n" . '$n');
    $magic = p1_magic($env);
    t_same(['1:30', '1:60'], array_keys($magic));
    t_same('array', $magic['1:30']['value']['t']);
    t_same('2', $magic['1:60']['preview']);
    t_same('2', $env['returnValue']['v']);
};

$tests['/*?.*/ records the time since the script started'] = function () {
    $env = p1_run("usleep(1000); /*?.*/\n\$v = strlen('abc')/*?.*/;\n\$v");
    $magic = p1_magic($env);
    t_same('time', $magic['1:14']['type']);
    t_assert((bool) preg_match('/^\d+\.\d{5}s$/', $magic['1:14']['preview']), $magic['1:14']['preview']);
    t_same('time', $magic['2:18']['type']);
    t_same('3', $env['returnValue']['v'], 'a timed expression keeps its value');
};

$tests['magic comments in loops count hits and keep the latest value'] = function () {
    $env = p1_run("foreach ([1, 2, 3] as \$i) {\n  \$sq = \$i * \$i; //?\n}");
    $m = p1_magic($env)['2:17'];
    t_same(3, $m['hits']);
    t_same('9', $m['preview']);
    t_same(['t' => 'int', 'v' => '9'], $m['value']);
};

$tests['magic values are dumped with maxDepth <= 3'] = function () {
    $env = p1_run('$deep = [[[[["x"]]]]]; //?', ['maxDepth' => 8]);
    $node = p1_magic($env)['1:23']['value'];
    for ($i = 0; $i < 3; $i++) $node = $node['items'][0]['v'];
    t_same('max-depth', $node['t']);
};

$tests['magic comments on the last expression and on return statements'] = function () {
    $env = p1_run("function p1_twice(\$x) {\n  return \$x * 2; //?\n}\np1_twice(4) //?");
    $magic = p1_magic($env);
    t_same('8', $magic['2:17']['preview']);
    t_same('8', $magic['4:12']['preview']);
    t_same('8', $env['returnValue']['v']);
};

$tests['magicComments off records nothing'] = function () {
    $env = p1_run('$a = 1; //?', ['magicComments' => false]);
    t_same([], $env['magic']);
    t_same('1', $env['returnValue']['v']);
};

$tests['magic comment on a selection run uses editor lines'] = function () {
    $env = p1_run("\$a = 1;\n\$b = \$a + 1; //?", [], ['lineOffset' => 7]);
    t_same(8, $env['magic'][0]['line']);
};

$tests['magic comments inside constant expressions are skipped instead of breaking the run'] = function () {
    $code = "class P1Config {\n  public \$options = [\n    'debug' => true //?\n  ];\n}\nfunction p1_defaults(\n  \$a = 5 //?\n) { return \$a; }\nconst P1_LIST = [\n 'b' => 2 //?\n];\n"
        . "function p1_static() { static \$n = 0/*?*/; return ++\$n; }\ndeclare(ticks=1/*?*/);\n[(new P1Config)->options, p1_defaults(), P1_LIST, p1_static()]";
    $env = p1_run($code);
    t_same(null, $env['exception']);
    t_same('[0=>[debug=>true],1=>5,2=>[b=>2],3=>1]', p1_plain($env['returnValue']));
    t_same([], $env['diagnostics']);
};

$tests['magic comments keep by-reference semantics (by-ref arguments, foreach &, writes through, &-returns)'] = function () {
    $code = "\$arr = [3, 1, 2]; sort(\$arr/*?*/);\n"
        . "\$b = [1, 2]; foreach (\$b/*?*/ as &\$v) { \$v *= 2; } unset(\$v);\n"
        . "\$a = [[0, 0]]; \$a[0]/*?*/[1] = 2;\n"
        . "function &p1_get_ref(array &\$arr) {\n  return \$arr[0]; //?\n}\n"
        . "\$c = [1]; \$r = &p1_get_ref(\$c); \$r = 5;\n"
        . "preg_match('/(b)/', 'abc', \$m /*?*/);\n"
        . "function p1_push(array &\$x) { \$x[] = 1; }\n\$d = []; p1_push(\$d /*?*/);\n"
        . "\$o = new stdClass; \$o->list = []; \$o->list/*?*/['k'] = 1;\n"
        . "[\$arr, \$b, \$a[0][1], \$c[0], \$m, \$d, \$o->list]";
    $env = p1_run($code);
    t_same(null, $env['exception']);
    t_same([], $env['diagnostics']);
    t_same('[0=>[0=>1,1=>2,2=>3],1=>[0=>2,1=>4],2=>2,3=>5,4=>[0=>b,1=>b],5=>[0=>1],6=>[k=>1]]', p1_plain($env['returnValue']));
    $magic = p1_magic($env);
    t_same(7, count($magic), 'every comment still records its value');
    t_same('[3, 1, 2]', $magic['1:27']['preview'], 'the value passed in');
    t_same('1', $magic['5:18']['preview']);
};

$tests['inline magic inside {$…} interpolation keeps the string intact'] = function () {
    $env = p1_run("\$a = 2;\n\"x{\$a/*?*/}y\"");
    t_same('x2y', p1_plain($env['returnValue']));
};

$tests['/*?.*/ after a ternary colon does not split the statement'] = function () {
    $env = p1_run("\$a = false;\n\$x = \$a ? 1 : /*?.*/ 2;\n\$y = \$a ?: /*?.*/ 'fallback';\nfunction p1_tern() { return false ? 1 : /*?.*/ 2; }\n[\$x, \$y, p1_tern()]");
    t_same('[0=>2,1=>fallback,2=>2]', p1_plain($env['returnValue']));
};

$tests['a trailing comment after a //?-> tap keeps every magic comment working; an invalid tap is reported'] = function () {
    $env = p1_run("\$a = new ArrayObject([1, 2]); //?->count() // the count\n\$b = 1; //?\n\$c = 3; //?->nope(((\n\$a->count()");
    $magic = p1_magic($env);
    t_same('2', $magic['1:30']['preview']);
    t_same('1', $magic['2:8']['preview']);
    t_same(2, count($magic));
    t_same([['level' => 'Notice', 'message' => 'Tinkerbox could not apply the magic comment on this line; it was skipped.', 'file' => '', 'line' => 3, 'userLine' => 3]], $env['diagnostics']);
};

return $tests;
