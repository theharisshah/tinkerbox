<?php
/**
 * CodeTransformer (docs/ARCHITECTURE.md §1.5): token-based rewrites that never shift line numbers.
 * These tests run in-process on the transformer output; RunnerTest covers the runtime behaviour.
 */

require_once __DIR__ . '/support.php';

$tests = [];

// ---------------------------------------------------------------------------------------------------------------
// Rule 1: open tag, rule 5: missing semicolon
// ---------------------------------------------------------------------------------------------------------------

$tests['strips a leading <?php tag without shifting lines'] = function () {
    $r = p1_transform("<?php\n\$a = 1;\n\$a + 1");
    t_same("     \n\$a = 1;\nreturn \$a + 1;", $r['code']);
    t_same(true, $r['hasReturnValue']);
    t_same(3, $r['returnLine']);
};

$tests['strips <?php on the same line as code, a short <? tag and a UTF-8 BOM'] = function () {
    t_same('      return 1 + 1;', p1_transform('<?php 1 + 1')['code']);
    t_same("  \nreturn 5;", p1_transform("<?\n5")['code']);
    t_same('      return 7;', p1_transform("\xEF\xBB\xBF<?php 7")['code']);
    // Not an open tag: `<?php` inside a string stays untouched.
    t_same('return "<?php";', p1_transform('"<?php"')['code']);
};

$tests['inserts a missing trailing semicolon after the last significant token'] = function () {
    t_same('return $a = 1;', p1_transform('$a = 1')['code']);
    t_same("return strlen('x'); // trailing comment", p1_transform("strlen('x') // trailing comment")['code']);
    t_same("\\Tinkerbox\\Capture::echoAt(1,  'hi');\n", p1_transform("echo 'hi'\n")['code']);
};

$tests['keeps every line at the same line number with all features enabled'] = function () {
    $code = <<<'PHP'
<?php
declare(strict_types=1);
$items = collect([1, 2, 3])/*?*/->map(function ($x) {
    echo $x, "\n"; //?
    return $x * 2; //? doubled
});
if ($items) dump($items);
foreach ([1, 2] as $i)
    $total = ($total ?? 0) + $i; //?
$s = <<<EOT
heredoc {$total}
EOT;
class Point { public $x = 0; }
$total /*?.*/
PHP;
    $r = p1_transform($code, ['coverage' => true, 'strictTypes' => true]);
    t_same(substr_count($code, "\n"), substr_count($r['code'], "\n"));
    t_same([], $r['disabled']);
    t_same(14, $r['returnLine']);
    t_assert(\Tinkerbox\CodeTransformer::parses($r['code']), 'transformed code parses');
};

// ---------------------------------------------------------------------------------------------------------------
// Rule 5: return the last expression
// ---------------------------------------------------------------------------------------------------------------

$returnCases = [
    'arithmetic expression' => ["\$a = 1;\n\$a + 1", true, 2],
    'assignment' => ['$a = 5;', true, 1],
    'function call' => ['strlen("abc");', true, 1],
    'method chain over several lines' => ["\$o = new ArrayObject([1]);\n\$o\n  ->count()", true, 2],
    'closure' => ['function () { return 1; };', true, 1],
    'static closure' => ['static function () { return 1; };', true, 1],
    'static arrow function' => ['static fn () => 1', true, 1],
    'anonymous class' => ['new class { public $a = 1; };', true, 1],
    'heredoc' => ["<<<EOT\nhello\nEOT;", true, 1],
    'print is not returned' => ['print "x";', false, null],
    'echo is not returned' => ['echo "x";', false, null],
    'explicit return' => ["\$a = 2;\nreturn \$a;", true, 2],
    'throw' => ['throw new Exception("x");', false, null],
    'unset' => ['$a = 1; unset($a);', false, null],
    'global' => ['global $a;', false, null],
    'static variable' => ['static $a = 1;', false, null],
    'const' => ['const FOO_P1 = 1;', false, null],
    'use import' => ['use ArrayObject as AO;', false, null],
    'goto + label' => ["goto end;\nend:", false, null],
    'if block' => ['if (true) { $a = 1; }', false, null],
    'if / else chain' => ["if (false) {\n} elseif (true) {\n} else {\n}", false, null],
    'alternative if syntax' => ['if (true): $a = 1; endif;', false, null],
    'foreach' => ['foreach ([1] as $i) { $i; }', false, null],
    'braceless while' => ['$i = 0; while ($i < 2) $i++;', false, null],
    'do while' => ['do { $a = 1; } while (false);', false, null],
    'for' => ['for ($i = 0; $i < 1; $i++) {}', false, null],
    'switch' => ['switch (1) { case 1: $a = 1; break; }', false, null],
    'try / catch / finally' => ['try { $a = 1; } catch (Exception $e) { } finally { }', false, null],
    'function declaration' => ['function p1_fn() { return 1; }', false, null],
    'class declaration' => ['class P1Decl {}', false, null],
    'abstract / final class' => ["abstract class P1Abs {}\nfinal class P1Fin {}", false, null],
    'interface and trait' => ["interface P1I {}\ntrait P1T {}", false, null],
    'attribute-prefixed class' => ["#[Attribute]\nclass P1Attr {}", false, null],
    'bare block' => ['{ $a = 1; }', false, null],
    'declare' => ['declare(ticks=1);', false, null],
    'inline html after close tag' => ["\$a = 1; ?>\n<b>x</b>", false, null],
    'expression before trailing comments and empty statements' => ["1 + 1;;\n// done\n/* end */", true, 1],
    'expression after a closing tag' => ["?>x<?php\n3 * 3", true, 2],
    'last expression inside a braced namespace' => ["namespace P1Ns {\n  1 + 2;\n}", true, 2],
    'statement after a namespace declaration' => ["namespace P1Ns2;\nstrtoupper('a')", true, 2],
    'expression before __halt_compiler()' => ["\$a = 3;\n\$a * 2;\n__halt_compiler(); raw data }}}", true, 2],
];
foreach ($returnCases as $name => $case) {
    $tests['return-last-expression: ' . $name] = function () use ($case) {
        list($code, $has, $line) = $case;
        $r = p1_transform($code);
        t_same([], $r['disabled'], 'transformed without degradation');
        t_same($has, $r['hasReturnValue'], 'hasReturnValue of ' . var_export($code, true) . "\n" . $r['code']);
        t_same($line, $r['returnLine']);
        t_same(substr_count($code, "\n"), substr_count($r['code'], "\n"));
    };
}

$tests['return-last-expression: match expression (PHP 8)'] = function () {
    if (PHP_VERSION_ID < 80000) return;
    $r = p1_transform("\$v = 2;\nmatch (\$v) {\n  1 => 'one',\n  default => 'many',\n}");
    t_same(true, $r['hasReturnValue']);
    t_same(2, $r['returnLine']);
    t_contains("return match (\$v) {", $r['code']);
    t_contains("default => 'many',\n};", $r['code']);
};

$tests['return-last-expression: enum declaration is not an expression (PHP 8.1)'] = function () {
    if (PHP_VERSION_ID < 80100) return;
    $r = p1_transform("enum P1Suit: string { case H = 'h'; }");
    t_same(false, $r['hasReturnValue']);
};

$tests['top-level return anywhere is reported for the runner'] = function () {
    $r = p1_transform("if (true) { return 5; }\necho 'x';");
    t_same(true, $r['hasTopLevelReturn']);
    t_same(false, $r['hasReturnValue']);
    $closure = p1_transform('$f = function () { return 1; }; echo 1;');
    t_same(false, $closure['hasTopLevelReturn'], 'a return inside a closure is not top level');
};

// ---------------------------------------------------------------------------------------------------------------
// Rules 3 + 4: echo and dump rewrites
// ---------------------------------------------------------------------------------------------------------------

$tests['echo statements are rewritten at every nesting depth with editor lines'] = function () {
    $code = "echo 'a', 'b';\nfunction p1_e() {\n  echo 'c';\n}\n\$f = function () { echo 'd'; };";
    $r = p1_transform($code, [], 10);
    // One call per argument: `a` is printed before `b` is evaluated, like PHP's own echo.
    t_contains("\\Tinkerbox\\Capture::echoAt(10,  'a') . \\Tinkerbox\\Capture::echoAt(10,  'b');", $r['code']);
    t_contains("\\Tinkerbox\\Capture::echoAt(12,  'c');", $r['code']);
    t_contains("\\Tinkerbox\\Capture::echoAt(14,  'd');", $r['code']);
    t_assert(strpos($r['code'], 'echo ') === false, 'no echo left');
};

$tests['dump(), \\dump(), dd() and var_dump() calls become Capture::dumpAt()'] = function () {
    $r = p1_transform("dump(\$a, \$b);\n\\dump(1);\nvar_dump(2, 3);\nif (0) dd(4);", [], 5);
    t_contains("\\Tinkerbox\\Capture::dumpAt(5, 'dump', [\$a, \$b]);", $r['code']);
    t_contains("\\Tinkerbox\\Capture::dumpAt(6, 'dump', [1]);", $r['code']);
    t_contains("\\Tinkerbox\\Capture::dumpAt(7, 'var_dump', [2, 3]);", $r['code']);
    t_contains("\\Tinkerbox\\Capture::dumpAt(8, 'dd', [4]);", $r['code']);
    t_contains("\\Tinkerbox\\Capture::dumpAt(1, 'dump', [1])", p1_transform('DUMP(1);')['code'], 'function names are case-insensitive');
};

$tests['spread arguments keep working in rewritten dumps'] = function () {
    t_contains("\\Tinkerbox\\Capture::dumpAt(1, 'dump', [...\$args])", p1_transform('dump(...$args);')['code']);
};

$tests['methods, static calls, qualified names and user functions named dump are not rewritten'] = function () {
    $code = "\$o->dump(1);\nFoo::dump(2);\nFoo\\dump(3);\nnamespace\\dump(4);\n\$x = new dump();";
    $r = p1_transform($code);
    t_assert(strpos($r['code'], 'dumpAt') === false, $r['code']);
    $declared = p1_transform("function dump(\$x) { return \$x; }\ndump(1)");
    t_assert(strpos($declared['code'], 'dumpAt') === false, 'user-declared dump() wins');
    $imported = p1_transform("use function Foo\\dd;\ndd(1);");
    t_assert(strpos($imported['code'], 'dumpAt') === false, 'imported dd() wins');
    if (PHP_VERSION_ID >= 80000) {
        t_assert(strpos(p1_transform('$o?->dump(1);')['code'], 'dumpAt') === false, 'nullsafe method');
    }
    if (PHP_VERSION_ID >= 80100) {
        t_same('return dump(...);', p1_transform('dump(...)')['code'], 'first-class callable keeps the real function');
    }
};

$tests['named dump arguments are collected with Capture::args() (PHP 8)'] = function () {
    if (PHP_VERSION_ID < 80000) return;
    t_contains("\\Tinkerbox\\Capture::dumpAt(1, 'dump', \\Tinkerbox\\Capture::args(total: 1, 2))", p1_transform('dump(total: 1, 2);')['code']);
};

// ---------------------------------------------------------------------------------------------------------------
// Rule 6: magic comments
// ---------------------------------------------------------------------------------------------------------------

$tests['magic //? wraps the statement ending on the line (assignment, return, echo)'] = function () {
    $r = p1_transform("\$a = 1; //?\nfunction p1_m() {\n  return 2; //?\n}\necho \$a; //?");
    t_contains("\\Tinkerbox\\Magic::capture(1, 8, (\$a = 1)); //?", $r['code']);
    t_contains("return \\Tinkerbox\\Magic::capture(3, 12, (2)); //?", $r['code']);
    t_contains("\\Tinkerbox\\Capture::echoAt(5,  \\Tinkerbox\\Magic::capture(5, 9, (\$a))); //?", $r['code']);
};

$tests['magic //? label, #? and //?->method() forms'] = function () {
    $r = p1_transform("\$a = [1]; //? my label\n\$b = 2; #?\n\$c = new ArrayObject([1, 2]); //?->count()");
    t_contains("\\Tinkerbox\\Magic::capture(1, 10, (\$a = [1]), null, 'my label');", $r['code']);
    t_contains("\\Tinkerbox\\Magic::capture(2, 8, (\$b = 2)); #?", $r['code']);
    t_contains("\\Tinkerbox\\Magic::capture(3, 30, (\$c = new ArrayObject([1, 2])), fn (\$__twValue) => \$__twValue->count());", $r['code']);
};

$tests['magic //? on the last expression keeps the inserted return'] = function () {
    $r = p1_transform("\$a = 1;\n\$a + 1 //?");
    t_same("\$a = 1;\nreturn \\Tinkerbox\\Magic::capture(2, 7, (\$a + 1)); //?", $r['code']);
    t_same(true, $r['hasReturnValue']);
};

$tests['inline /*?*/ and /*?->expr*/ wrap the operand chain to their left'] = function () {
    $r = p1_transform('$n = collect([1, 2])/*?*/->map(fn ($x) => $x * 2)/*?->count()*/;');
    t_same('return $n = \\Tinkerbox\\Magic::capture(1, 49, (\\Tinkerbox\\Magic::capture(1, 20, (collect([1, 2])))/*?*/->map(fn ($x) => $x * 2)), fn ($__twValue) => $__twValue->count())/*?->count()*/;', $r['code']);
    $static = p1_transform('$d = DateTime::createFromFormat("Y", "2024")/*?*/->format("Y");');
    t_contains('\\Tinkerbox\\Magic::capture(1, 44, (DateTime::createFromFormat("Y", "2024")))/*?*/->format', $static['code']);
    $var = p1_transform('$x = $items[0]["a"]/*? first */ + 1;');
    t_contains("\\Tinkerbox\\Magic::capture(1, 19, (\$items[0][\"a\"]), null, 'first')", $var['code']);
};

$tests['/*?.*/ timing comment as a statement and wrapped around an expression'] = function () {
    $r = p1_transform("usleep(1); /*?.*/\n\$v = strlen('abc')/*?.*/;");
    t_contains("usleep(1); \\Tinkerbox\\Magic::time(1, 11);/*?.*/", $r['code']);
    t_contains("\$v = \\Tinkerbox\\Magic::time(2, 18, (strlen('abc')))/*?.*/;", $r['code']);
};

$tests['magic comments are ignored inside strings and when disabled'] = function () {
    t_same('return $s = "x //? y";', p1_transform('$s = "x //? y"')['code']);
    t_same("return \$a = 1; //?", p1_transform('$a = 1; //?', ['magicComments' => false])['code']);
    t_same("// only a comment //?\nreturn 1;", p1_transform("// only a comment //?\n1")['code']);
};

$tests['magic comments never turn write targets into calls'] = function () {
    $r = p1_transform('$a /*?*/ = 5; $b[] /*?*/ = 1; list($c /*?*/) = [1]; $i = 0; $i /*?*/ ++;');
    t_assert(strpos($r['code'], 'Magic::capture') === false, $r['code']);
    t_assert(\Tinkerbox\CodeTransformer::parses($r['code']), 'still parses');
};

$tests['magic comment columns are UTF-16 based like Monaco'] = function () {
    $r = p1_transform("\$s = 'héllo 😀'; //?");
    // `$s = 'héllo 😀'; ` is 17 UTF-16 code units (the emoji counts twice).
    t_contains('\\Tinkerbox\\Magic::capture(1, 17, ', $r['code']);
};

$tests['magic comments work inside nested blocks, closures and methods'] = function () {
    $code = "foreach ([1, 2] as \$i) {\n  if (\$i) {\n    \$x = \$i * 2; //?\n  }\n}\n\$f = function () {\n  \$y = 3; //?\n};\nclass P1Mag { public function m() { \$z = 4; //?\n} }";
    $r = p1_transform($code);
    t_contains('\\Tinkerbox\\Magic::capture(3, 17, ($x = $i * 2));', $r['code']);
    t_contains('\\Tinkerbox\\Magic::capture(7, 10, ($y = 3));', $r['code']);
    t_contains('\\Tinkerbox\\Magic::capture(9, 44, ($z = 4));', $r['code']);
};

// ---------------------------------------------------------------------------------------------------------------
// Rule 2: strict types, coverage markers
// ---------------------------------------------------------------------------------------------------------------

$tests['strictTypes prefixes declare(strict_types=1) on line 1'] = function () {
    $r = p1_transform("\$a = 1;\n\$a", ['strictTypes' => true]);
    t_same("declare(strict_types=1);\$a = 1;\nreturn \$a;", $r['code']);
    t_same("return \$a = 1;", p1_transform('$a = 1', ['strictTypes' => false])['code']);
};

$tests['strictTypes does not duplicate a declare written by the user'] = function () {
    $r = p1_transform("<?php declare(strict_types=1);\n\$a = 1;", ['strictTypes' => true, 'coverage' => true]);
    t_same(1, substr_count($r['code'], 'strict_types'));
    t_assert(strpos(ltrim($r['code']), 'declare(strict_types=1);') === 0, 'the user declare stays first: ' . $r['code']);
    t_assert(\Tinkerbox\CodeTransformer::parses($r['code']), 'parses');
};

$tests['coverage markers precede executable statements and map to editor lines'] = function () {
    $r = p1_transform("\$a = 1;\nif (\$a)\n  \$b = 2;\nfunction p1_c() {\n  return 1;\n}\n\$a", ['coverage' => true], 20);
    t_same('markers', $r['coverage']);
    t_contains('\\Tinkerbox\\Capture::cover(20);$a = 1;', $r['code']);
    t_contains('\\Tinkerbox\\Capture::cover(21);if ($a)', $r['code']);
    t_contains('{\\Tinkerbox\\Capture::cover(22);$b = 2;}', $r['code'], 'braceless bodies are wrapped in braces');
    t_contains('\\Tinkerbox\\Capture::cover(24);return 1;', $r['code']);
    t_contains('\\Tinkerbox\\Capture::cover(26);return $a;', $r['code']);
    t_assert(strpos($r['code'], 'cover(23)') === false, 'function declarations are not marked');
    t_same([20], $r['coverageMap'][20]);
};

$tests['coverage map of a multi-line statement covers all of its lines'] = function () {
    $r = p1_transform("\$a = [\n  1,\n  2,\n];\n\$f = function () {\n  return 1;\n};", ['coverage' => true]);
    t_same([1, 2, 3, 4], $r['coverageMap'][1]);
    t_same([5, 7], $r['coverageMap'][5], 'closure bodies carry their own markers');
    t_same([6], $r['coverageMap'][6]);
};

$tests['coverage off adds no markers'] = function () {
    $r = p1_transform('$a = 1; $a', ['coverage' => false]);
    t_same('none', $r['coverage']);
    t_assert(strpos($r['code'], 'cover(') === false, 'no markers');
};

// ---------------------------------------------------------------------------------------------------------------
// Safety net
// ---------------------------------------------------------------------------------------------------------------

$tests['code with a syntax error is returned untouched (PHP reports the real ParseError)'] = function () {
    $r = p1_transform("<?php\n\$a = ;\necho 1;");
    t_same("     \n\$a = ;\necho 1;", $r['code']);
    t_same(['all'], $r['disabled']);
    t_same(false, $r['hasReturnValue']);
};

$tests['the transformer never throws on garbage input'] = function () {
    foreach (["\x00\xff\xfe", '}}}', '((', "<<<EOT\n", '/* unterminated', '"open', '?>', '', "\n\n"] as $input) {
        $r = p1_transform($input);
        t_assert(is_string($r['code']), 'code for ' . bin2hex($input));
    }
};

$tests['parses() validates code like eval() would'] = function () {
    t_load_runner_sources();
    t_same(true, \Tinkerbox\CodeTransformer::parses('$a = 1;'));
    t_same(false, \Tinkerbox\CodeTransformer::parses('$a = ;'));
};

// ---------------------------------------------------------------------------------------------------------------
// Magic comments: contexts that must not (or must differently) be wrapped
// ---------------------------------------------------------------------------------------------------------------

$tests['magic comments are never applied inside constant expressions (they would be compile errors)'] = function () {
    $code = "class P1Cfg {\n  public \$options = [\n    'debug' => true //?\n  ];\n  const LIMIT = 3 /*?*/;\n  public static \$s = [1 /*?*/];\n}\n"
        . "function p1_def(\n  \$a = 5 //?\n) { return \$a; }\n"
        . "\$c = function (\$b = [1 /*?*/]) { return \$b; };\n"
        . "const P1_ITEMS = [\n 'b' => 2 //?\n];\n"
        . "declare(ticks=1/*?*/);\n"
        . "function p1_sv() { static \$n = 0/*?*/, \$m /*?*/; return ++\$n; }\n"
        . "\$x = [1, 2] /*?*/;";
    $r = p1_transform($code);
    t_same([], $r['disabled']);
    t_same(1, substr_count($r['code'], 'Magic::capture(17, '), 'the runtime operand on the last line is still wrapped: ' . $r['code']);
    $static = PHP_VERSION_ID >= 80300 ? 1 : 0; // arbitrary static initializers since PHP 8.3
    t_same(1 + $static, substr_count($r['code'], 'Magic::'), $r['code']);
    t_assert(strpos($r['code'], '$m /*?*/') !== false, 'a declared static variable stays a variable');
    if (PHP_VERSION_ID >= 80100) {
        $enum = p1_transform("enum P1E: int { case A = 1/*?*/; const X = 3 /*?*/; }\n#[Attribute]\nclass P1Route { function __construct(\$p) {} }\n#[P1Route(\n '/home' //?\n)] class P1H {}\nP1E::A->value");
        t_assert(strpos($enum['code'], 'Magic::') === false, $enum['code']);
    }
};

$tests['magic comments do not break {$…} interpolation (the braces would become literal text)'] = function () {
    $r = p1_transform("\$a = [2];\n\$s = \"x{\$a/*?*/}y {\$a[0 /*?*/]}\";\n\$h = <<<EOT\nx {\$a/*?*/} y\nEOT;\n\$s");
    t_contains('"x{$a/*?*/}y {$a[\\Tinkerbox\\Magic::capture(2, 24, (0)) /*?*/]}"', $r['code'], 'an index inside the interpolation can still be captured');
    t_contains('x {$a/*?*/} y', $r['code']);
};

$tests['operands taken by reference are wrapped in Magic::captureRef()'] = function () {
    if (PHP_VERSION_ID < 80000) return; // named arguments
    $code = "\$arr = [3, 1]; sort(\$arr/*?*/);\n"
        . "foreach (\$arr/*?*/ as &\$v) {} unset(\$v);\n"
        . "\$a = [[0]]; \$a[0]/*?*/[1] = 2;\n"
        . "function &p1_ref(array &\$arr) {\n  return \$arr[0]; //?\n}\n"
        . "function p1_add(array &\$x) {}\n\$d = []; p1_add(\$d /*?*/); p1_add(x: \$d /*?*/);\n"
        . "\$o = new ArrayObject([]); \$o->exchangeArray(\$d /*?*/); \$o->exchangeArray(\$a[0] /*?*/);\n"
        . "strlen('abc' /*?*/); array_map('trim', \$arr /*?*/); foreach (\$arr/*?*/ as \$w) {}";
    $r = p1_transform($code);
    t_same([], $r['disabled']);
    foreach (['sort(\\Tinkerbox\\Magic::captureRef(1, 24, $arr)', 'foreach (\\Tinkerbox\\Magic::captureRef(2, 13, $arr)', '\\Tinkerbox\\Magic::captureRef(3, 17, $a[0])/*?*/[1] = 2',
        'return \\Tinkerbox\\Magic::captureRef(5, 18, $arr[0]);', 'p1_add(\\Tinkerbox\\Magic::captureRef(8, 19, $d)', 'p1_add(x: \\Tinkerbox\\Magic::captureRef(8, 40, $d)',
        // Unknown callee: a plain variable by reference (works for both), an element chain by value.
        '$o->exchangeArray(\\Tinkerbox\\Magic::captureRef(9, 47, $d)', '$o->exchangeArray(\\Tinkerbox\\Magic::capture(9, 79, ($a[0]))',
        "strlen(\\Tinkerbox\\Magic::capture(10, 13, ('abc'))", 'array_map(\'trim\', \\Tinkerbox\\Magic::capture(10, 44, ($arr))', 'foreach (\\Tinkerbox\\Magic::capture(10, 65, ($arr))'] as $expected) {
        t_contains($expected, $r['code']);
    }
};

$tests['/*?.*/ after a ternary colon is not a statement position'] = function () {
    $r = p1_transform("\$a = false;\n\$x = \$a ? 1 : /*?.*/ 2;\n\$y = \$a ?: /*?.*/ 'f';\n\$x");
    t_assert(strpos($r['code'], 'Magic::time(2') === false && strpos($r['code'], 'Magic::time(3') === false, $r['code']);
    t_contains('$x = $a ? 1 : /*?.*/ 2;', $r['code']);
    // Statement positions keep working: after `;`, `{` and an alternative-syntax `:`.
    $s = p1_transform("if (true): /*?.*/\n  \$b = 1;\nendif;\nfunction p1_t() { /*?.*/ return 1; }");
    t_contains('if (true): \\Tinkerbox\\Magic::time(1, 11);/*?.*/', $s['code']);
    t_contains('{ \\Tinkerbox\\Magic::time(4, 18);/*?.*/', $s['code']);
};

$tests['a trailing comment after a //?-> tap is not part of the tap; an invalid tap skips only its comment'] = function () {
    $r = p1_transform("\$a = new ArrayObject([1]); //?->count() // the count\n\$b = 1; //?\n\$c = 2; //?->nope(((\n\$d = 3; #?->x() # note\n\$a");
    t_same([], $r['disabled']);
    t_same([3], $r['skippedMagicLines']);
    t_contains('fn ($__twValue) => $__twValue->count()); //?->count() // the count', $r['code']);
    t_contains('\\Tinkerbox\\Magic::capture(2, 8, ($b = 1)); //?', $r['code']);
    t_contains('$c = 2; //?->nope(((', $r['code']);
    t_contains('fn ($__twValue) => $__twValue->x()); #?->x() # note', $r['code']);
};

$tests['a magic comment that breaks the code is skipped on its own, the others stay'] = function () {
    // A tap that is a valid chain on its own but not where it is inserted: only its line is skipped.
    $r = p1_transform("\$a = 1; //?\n\$b = [1]; //?->x() ; }\n\$c = 3; //?");
    t_same([], $r['disabled']);
    t_contains('\\Tinkerbox\\Magic::capture(1, 8, ($a = 1));', $r['code']);
    t_contains('\\Tinkerbox\\Magic::capture(3, 8, ($c = 3));', $r['code']);
    t_assert(\Tinkerbox\CodeTransformer::parses($r['code']), $r['code']);
};

$tests['PHP 8.4 property hook bodies are statement lists (markers, magic comments, echo)'] = function () {
    if (PHP_VERSION_ID < 80400) return;
    $code = "class P1PM {\n  public int \$x {\n    get {\n      return 7; //?\n    }\n  }\n  public int \$y = 1 {\n    get => \$this->y * 2; //?\n    set(int \$value) { echo 'set'; \$this->y = \$value; }\n  }\n}\n(new P1PM)->x";
    $r = p1_transform($code, ['coverage' => true]);
    t_same([], $r['disabled']);
    t_contains('\\Tinkerbox\\Capture::cover(4);return \\Tinkerbox\\Magic::capture(4, 16, (7));', $r['code']);
    t_contains('get => \\Tinkerbox\\Magic::capture(8, 25, ($this->y * 2));', $r['code']);
    t_contains("\\Tinkerbox\\Capture::echoAt(9,  'set');", $r['code']);
};

// ---------------------------------------------------------------------------------------------------------------
// Coverage of expressions, globals
// ---------------------------------------------------------------------------------------------------------------

$tests['arrow-function bodies, match arms and ternary branches on lines of their own get expression markers'] = function () {
    if (PHP_VERSION_ID < 80000) {
        $r = p1_transform("\$f = fn(\$x) =>\n  \$x * 2;\n\$t = \$f\n  ? 'yes'\n  : 'no';", ['coverage' => true]);
        t_same([1], $r['coverageMap'][1]);
        t_same([1, 2], $r['coverageMap'][-1]);
        t_same([4], $r['coverageMap'][-2]);
        t_same([5], $r['coverageMap'][-3]);
        return;
    }
    $code = "\$f = fn(\$x) =>\n  \$x * 2;\n\$r = match(2) {\n  1 => 'one',\n  2 => 'two',\n};\n\$t = \$r\n  ? 'yes'\n  : 'no';\n\$one = \$r ? 1 : 2;\n\$a = false &&\n  die('no');";
    $r = p1_transform($code, ['coverage' => true]);
    t_same([], $r['disabled']);
    t_contains('$f = fn($x) =>\\Tinkerbox\\Capture::cover(-1) ?? ', $r['code']);
    t_contains("1 =>\\Tinkerbox\\Capture::cover(-2) ??  'one'", $r['code']);
    t_contains("?\\Tinkerbox\\Capture::cover(-4) ??  'yes'", $r['code']);
    t_contains("\$one = \$r ? 1 : 2;", $r['code'], 'one-line expressions need no marker of their own');
    $map = $r['coverageMap'];
    t_same([1], $map[1], 'the statement does not cover the body of the arrow function');
    t_same([1, 2], $map[-1], 'a span owns its operator (=>, ?, :)');
    t_same([3, 6], $map[3]);
    t_same([4], $map[-2]);
    t_same([5], $map[-3]);
    t_same([7], $map[7]);
    t_same([8], $map[-4]);
    t_same([9], $map[-5]);
    t_same([11, 12], $map[11], '&& / || operands keep statement granularity');
    // Constant expressions never get markers.
    t_assert(strpos(p1_transform("const P1_C = true\n  ? 1\n  : 2;", ['coverage' => true])['code'], 'cover(-') === false, 'const');
};

$tests['names used with global / $GLOBALS[...] and as file-scope variables are reported as globals'] = function () {
    $r = p1_transform("\$g = 1;\nfunction p1_g() { global \$g, \$unused; return \$GLOBALS['cfg'] + \$GLOBALS[\"g\"]; }\n\$cfg = 2;\nclass P1G { public \$cfg; }\nfunction p1_h() { \$local = 1; return \$GLOBALS['local']; }\np1_g()");
    $globals = $r['globals'];
    sort($globals);
    t_same(['cfg', 'g'], $globals);
};

$tests['large code is tokenized without keeping token_get_all() arrays alive'] = function () {
    $code = '';
    for ($i = 0; $i < 1500; $i++) $code .= "\$a$i = [$i, 's' => strlen('x$i')]; if (\$a$i) { \$b = \$a$i; }\n";
    $before = memory_get_usage();
    if (function_exists('memory_reset_peak_usage')) memory_reset_peak_usage();
    $peakBefore = memory_get_peak_usage();
    $r = p1_transform($code, ['coverage' => true]);
    $peak = memory_get_peak_usage() - max($before, function_exists('memory_reset_peak_usage') ? $before : $peakBefore);
    t_same([], $r['disabled']);
    // Runner::TRANSFORM_MEMORY_FACTOR must stay an upper bound of the transformer's peak per code byte.
    if (function_exists('memory_reset_peak_usage')) t_assert($peak < strlen($code) * \Tinkerbox\Runner::TRANSFORM_MEMORY_FACTOR, 'peak ' . $peak . ' for ' . strlen($code) . ' bytes');
};

$tests['names in declaration headers and destructuring after a block are never wrapped'] = function () {
    $code = "interface P1I extends Countable, ArrayAccess //?\n{}\nabstract class P1D extends ArrayObject implements P1I //?\n{}\n"
        . "function p1_typed(int \$a): ?string //?\n{ return null; }\n\$f = function () use (\$code): int //?\n{ return 1; };\n"
        . "\$ok = \$f instanceof Closure //?\n;\nif (true) { \$z = 1; }\n[\$m/*?*/, \$n/*?*/] = [1, 2];\nif (true) [\$o /*?*/] = [3];\n[\$m, \$n, \$o]";
    $r = p1_transform($code);
    t_same([], $r['disabled']);
    t_same([], $r['skippedMagicLines'], 'nothing had to be skipped: ' . $r['code']);
    t_same(0, substr_count($r['code'], 'Magic::'), $r['code']);
    if (PHP_VERSION_ID >= 80100) {
        $enum = p1_transform("enum P1Size: string //?\n{\n  case S = 's';\n}\nP1Size::S");
        t_same([], $enum['skippedMagicLines']);
        t_same(0, substr_count($enum['code'], 'Magic::'));
    }
};

return $tests;
