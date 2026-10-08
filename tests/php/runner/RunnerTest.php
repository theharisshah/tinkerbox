<?php
/**
 * Runner run mode end to end (docs/ARCHITECTURE.md §1.3–1.4): the full bundle is piped to `php` over stdin
 * exactly like the app does, and the PhpEnvelope (src/shared/types.ts) is decoded.
 */

require_once __DIR__ . '/support.php';

$tests = [];

// ---------------------------------------------------------------------------------------------------------------
// Envelope + return value
// ---------------------------------------------------------------------------------------------------------------

$tests['run envelope has exactly the PhpEnvelope fields'] = function () {
    $env = p1_run("\$a = 20;\n\$a + 22");
    p1_assert_run_envelope($env);
    t_same(['id' => 'none', 'name' => 'PHP', 'usesCollision' => null, 'logFilesPath' => null], $env['driver']);
    t_same(true, $env['hasReturnValue']);
    t_same(['t' => 'int', 'v' => '42'], $env['returnValue']);
    t_same(null, $env['exception']);
    t_same(false, $env['exited']);
    t_same([], $env['diagnostics']);
    t_same("\n\n", $env['__stdout_outside'], 'nothing but the envelope on stdout');
    t_same('', $env['__stderr']);
};

$tests['a leading <?php tag is stripped and line numbers stay intact'] = function () {
    $env = p1_run("<?php\n\n\$x = 'tag';\nthrow new Exception(\$x);");
    t_same('Exception', $env['exception']['class']);
    t_same(4, $env['exception']['line']);
    t_same('', $env['exception']['file']);
};

$tests['missing trailing semicolon on the last statement is tolerated'] = function () {
    $env = p1_run("\$name = 'Tinkerbox'\n");
    t_same(null, $env['exception']);
    t_same('Tinkerbox', $env['returnValue']['v']);
    t_same('ok', p1_run("echo 'ok'")['events'][0]['text']);
};

$tests['no return value for statements, null return value is still shown for expressions'] = function () {
    $env = p1_run('foreach ([1, 2] as $i) { $x = $i; }');
    t_same(false, $env['hasReturnValue']);
    t_same(null, $env['returnValue']);
    $null = p1_run('$x = null');
    t_same(true, $null['hasReturnValue']);
    t_same(['t' => 'null'], $null['returnValue']);
};

$tests['explicit top-level return (also in a nested block) provides the return value'] = function () {
    t_same('5', p1_run("if (true) {\n  return 5;\n}\necho 'never';")['returnValue']['v']);
    t_same('7', p1_run("\$a = 7;\nreturn \$a;")['returnValue']['v']);
};

$tests['closures, match and heredoc as the last expression'] = function () {
    $closure = p1_run('$f = fn ($a) => $a * 2');
    t_same('closure', $closure['returnValue']['t']);
    $heredoc = p1_run("\$who = 'world';\n<<<EOT\nhello {\$who}\nEOT");
    t_same('hello world', $heredoc['returnValue']['v']);
    if (PHP_VERSION_ID >= 80000) {
        $match = p1_run("\$v = 3;\nmatch (true) {\n  \$v > 2 => 'big',\n  default => 'small',\n}");
        t_same('big', $match['returnValue']['v']);
    }
};

$tests['nested blocks run correctly with all rewrites enabled'] = function () {
    $code = <<<'PHP'
$total = 0;
foreach ([1, 2, 3] as $i) {
    if ($i % 2) {
        $total += $i; //?
    } else {
        switch ($i) {
            case 2:
                $total *= 10;
                break;
        }
    }
}
try {
    while ($total > 100) $total--;
} finally {
    $total++;
}
$total
PHP;
    $env = p1_run($code);
    t_same(null, $env['exception']);
    t_same('14', $env['returnValue']['v']);
    t_same([1, 2, 3, 4, 6, 8, 9, 13, 14, 16, 18], $env['coverage'], 'case labels, else and finally are not statements');
};

// ---------------------------------------------------------------------------------------------------------------
// Scope, provisional classes, strict types
// ---------------------------------------------------------------------------------------------------------------

$tests['user code runs in an isolated scope without runner variables or $this'] = function () {
    $env = p1_run("[array_keys(get_defined_vars()), isset(\$this), isset(\$code), isset(\$payload)]");
    t_same('[0=>[],1=>false,2=>false,3=>false]', p1_plain($env['returnValue']));
};

$tests['provisional classes, interfaces and functions can be used before their declaration'] = function () {
    $code = <<<'PHP'
interface P1Shape { public function area(); }
abstract class P1Base implements P1Shape { public function describe() { return static::class . ':' . $this->area(); } }
class P1Square extends P1Base { private $side; public function __construct($side) { $this->side = $side; } public function area() { return $this->side ** 2; } }
$result = p1_helper(new P1Square(3));
function p1_helper(P1Shape $s) { return $s->describe(); }
$result
PHP;
    $env = p1_run($code);
    t_same(null, $env['exception']);
    t_same('P1Square:9', $env['returnValue']['v']);
    $hoisted = p1_run('$h = new P1Hoisted();' . "\n" . 'class P1Hoisted { public function hi() { return "hoisted"; } }' . "\n" . '$h->hi()');
    t_same(null, $hoisted['exception']);
    t_same('hoisted', $hoisted['returnValue']['v']);
};

$tests['provisional classes can implement interfaces and be instantiated'] = function () {
    $env = p1_run("interface P1Greets { public function greet(); }\nclass P1Hello implements P1Greets { public function greet() { echo 'hi'; return 'done'; } }\n(new P1Hello())->greet()");
    t_same(null, $env['exception']);
    t_same('done', $env['returnValue']['v']);
    t_same(['echo:2:hi'], p1_event_summary($env), 'echo inside a provisional class method keeps its editor line');
};

$tests['enums declared in the editor (PHP 8.1)'] = function () {
    if (PHP_VERSION_ID < 80100) return;
    $env = p1_run("enum P1Status: string { case Active = 'active'; }\nP1Status::from('active')");
    t_same('enum', $env['returnValue']['t']);
    t_same('Active', $env['returnValue']['case']);
};

$tests['functions declared in the editor may use the helper names (dump, tw)'] = function () {
    $env = p1_run("function dump(\$x) { return 'mine:' . \$x; }\nfunction tw() { return 'tw'; }\ndump(1) . tw()");
    t_same(null, $env['exception']);
    t_same('mine:1tw', $env['returnValue']['v']);
    t_same([], $env['events']);
    $conditional = p1_run("if (!function_exists('dd')) {\n  function dd(\$v) { return \$v * 2; }\n}\ndd(21)");
    t_same('42', $conditional['returnValue']['v']);
};

$tests['strictTypes option enforces scalar types, off keeps coercion'] = function () {
    $strict = p1_run('strlen(123)', ['strictTypes' => true]);
    t_same('TypeError', $strict['exception']['class']);
    t_same(1, $strict['exception']['line']);
    $loose = p1_run('strlen(123)', ['strictTypes' => false]);
    t_same('3', $loose['returnValue']['v']);
    $own = p1_run("<?php declare(strict_types=1);\nstrlen(123);", ['strictTypes' => true]);
    t_same('TypeError', $own['exception']['class'], 'a user declare together with the option');
    t_same(2, $own['exception']['line']);
};

$tests['namespaces and use imports work in the editor code'] = function () {
    $env = p1_run("namespace P1\\Space;\nuse ArrayObject as Bag;\nfunction where() { return __FUNCTION__; }\nwhere() . ':' . get_class(new Bag([]))");
    t_same(null, $env['exception']);
    t_same('P1\\Space\\where:ArrayObject', $env['returnValue']['v']);
};

// ---------------------------------------------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------------------------------------------

$tests['coverage lists executed editor lines only'] = function () {
    $code = "\$a = 1;\nif (\$a > 5) {\n  \$b = 'never';\n} else {\n  \$b = 'else';\n}\nfunction p1_unused() {\n  return 1;\n}\n\$b";
    $env = p1_run($code);
    t_same([1, 2, 5, 10], $env['coverage']);
};

$tests['coverage is empty when disabled'] = function () {
    t_same([], p1_run('$a = 1; $a', ['coverage' => false])['coverage']);
};

$tests['coverage of functions and closures defined and called in the editor'] = function () {
    $env = p1_run("function p1_cov(\$x) {\n  return \$x + 1;\n}\n\$f = function () {\n  return p1_cov(1);\n};\n\$f()");
    t_same([2, 4, 5, 6, 7], $env['coverage']);
};

// ---------------------------------------------------------------------------------------------------------------
// Selection runs (lineOffset)
// ---------------------------------------------------------------------------------------------------------------

$tests['lineOffset maps events, magic, coverage and diagnostics to editor lines'] = function () {
    $code = "echo 'a';\ndump(1);\n\$x = 2; //?\ntrigger_error('careful', E_USER_WARNING);\n\$x";
    $env = p1_run($code, [], ['lineOffset' => 10]);
    t_same(['echo:10:a', 'dump:11:1'], p1_event_summary($env));
    t_same(12, $env['magic'][0]['line']);
    t_same([10, 11, 12, 13, 14], $env['coverage']);
    t_same(13, $env['diagnostics'][0]['line']);
    t_same(13, $env['diagnostics'][0]['userLine']);
};

$tests['lineOffset maps exceptions and parse errors to editor lines'] = function () {
    $env = p1_run("\$a = 1;\nthrow new LogicException('sel');", [], ['lineOffset' => 30]);
    t_same(31, $env['exception']['line']);
    t_same(31, $env['exception']['userLine']);
    $parse = p1_run("\$a = 1;\n\$b = ;", [], ['lineOffset' => 30]);
    t_same('ParseError', $parse['exception']['class']);
    t_same(31, $parse['exception']['line']);
};

// ---------------------------------------------------------------------------------------------------------------
// Development entry point
// ---------------------------------------------------------------------------------------------------------------

$tests['resources/php/tinkerbox.php runs a payload file or stdin with the same envelope'] = function () {
    $entry = dirname(__DIR__, 3) . '/resources/php/tinkerbox.php';
    $payload = json_encode([
        'nonce' => 'tw_dev_entry',
        'mode' => 'run',
        'projectPath' => '',
        'homePath' => sys_get_temp_dir(),
        'code' => base64_encode("echo 'dev';\nfunction p1_dev() { throw new LogicException('dev entry'); }\np1_dev();"),
        'options' => ['coverage' => true],
    ]);
    $file = tempnam(sys_get_temp_dir(), 'tinkerbox-p1-payload');
    file_put_contents($file, $payload);
    try {
        foreach ([[$entry, $file], [$entry, '-']] as $args) {
            $proc = proc_open(array_merge([PHP_BINARY, '-d', 'xdebug.mode=off'], $args), [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, sys_get_temp_dir());
            fwrite($pipes[0], $payload);
            fclose($pipes[0]);
            $stdout = stream_get_contents($pipes[1]);
            fclose($pipes[1]);
            fclose($pipes[2]);
            proc_close($proc);
            t_same(1, substr_count($stdout, "tw_dev_entryBEGIN\n"), $stdout);
            $json = substr($stdout, strpos($stdout, "BEGIN\n") + 6);
            $env = json_decode(substr($json, 0, strpos($json, "\ntw_dev_entryEND")), true);
            t_same(['echo:1:dev'], p1_event_summary($env));
            t_same('LogicException', $env['exception']['class']);
            t_same(2, $env['exception']['line']);
            t_same('', $env['exception']['file']);
            t_same(3, $env['exception']['trace'][0]['line']);
            t_same(true, $env['exception']['trace'][0]['userCode']);
        }
    } finally {
        @unlink($file);
    }
};

$tests['file-scope variables used with global / $GLOBALS are the real globals'] = function () {
    $env = p1_run("\$g = 1;\nfunction p1_fg() { global \$g; \$g++; return \$g; }\n\$cfg = ['x' => 3];\nfunction p1_cfg() { return \$GLOBALS['cfg']['x']; }\n[p1_fg(), \$g, p1_cfg()]");
    t_same(null, $env['exception']);
    t_same('[0=>2,1=>2,2=>3]', p1_plain($env['returnValue']));
};

$tests['coverage leaves out arrow-function bodies, match arms and ternary branches that did not run'] = function () {
    $env = p1_run("\$f = fn(\$x) =>\n  \$x * 2;\n\$t = 2 > 1\n  ? 'big'\n  : 'small';\n\$g = fn(\$x) =>\n  \$x + 1;\n\$g(1)");
    t_same([1, 3, 4, 6, 7, 8], $env['coverage']);
    if (PHP_VERSION_ID >= 80000) {
        $match = p1_run("\$x = 2;\n\$r = match(\$x) {\n  1 => 'one',\n  2 => 'two',\n  3 => 'three',\n};\n\$r");
        t_same([1, 2, 4, 6, 7], $match['coverage']);
        t_same('two', p1_plain($match['returnValue']));
    }
};

return $tests;
