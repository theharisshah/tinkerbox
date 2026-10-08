<?php

use Tinkerbox\ExceptionFormatter;

require_once __DIR__ . '/support.php';
p2_dumper_load();

if (!function_exists('p2_fixture_project')) {
    /**
     * Temp project with app/ (project code) and vendor/ (library code), loaded once. Paths use the unresolved
     * sys_get_temp_dir() (a symlink on macOS) so the realpath fallback of relative paths is exercised.
     */
    function p2_fixture_project()
    {
        static $root = null;
        if ($root !== null) return $root;
        $root = sys_get_temp_dir() . '/tinkerbox-ef-' . bin2hex(random_bytes(5));
        $files = [
            'app/Service.php' => "<?php\nnamespace TinkerboxFixture\\App;\n\nclass Service\n{\n    public function run(\$message)\n    {\n        return \\TinkerboxFixture\\Acme\\Pipeline::through(function () use (\$message) {\n            return \\TinkerboxFixture\\Acme\\Thrower::fail(\$message);\n        });\n    }\n}\n",
            'vendor/acme/lib/src/Pipeline.php' => "<?php\nnamespace TinkerboxFixture\\Acme;\n\nclass Pipeline\n{\n    public static function through(callable \$next)\n    {\n        return \$next();\n    }\n}\n",
            'vendor/acme/lib/src/Thrower.php' => "<?php\nnamespace TinkerboxFixture\\Acme;\n\nclass Thrower\n{\n    public static function fail(\$message)\n    {\n        throw new \\DomainException(\$message);\n    }\n}\n",
        ];
        foreach ($files as $path => $content) {
            if (!is_dir(dirname($root . '/' . $path))) mkdir(dirname($root . '/' . $path), 0777, true);
            file_put_contents($root . '/' . $path, $content);
            require_once $root . '/' . $path;
        }
        $cleanup = $root;
        register_shutdown_function(function () use ($cleanup) {
            p2_rmdir($cleanup);
        });
        return $root;
    }

    /** Trace frames that belong to the user's code or the fixture project (drops the test harness frames). */
    function p2_frames(array $info)
    {
        return array_values(array_filter($info['trace'], function ($frame) {
            return !empty($frame['userCode']) || (isset($frame['file']) && strpos($frame['file'], '/') !== 0) || !isset($frame['file']);
        }));
    }
}

return [
    'errors in the user code map to editor lines with a snippet' => function () {
        $code = implode("\n", ['$a = 1;', '$b = 2;', '$c = 3;', '$d = 4;', '$e = 5;', '$f = 6;', 'throw new RuntimeException("boom", 7);', '$h = 8;', '$i = 9;', '$j = 10;', '$k = 11;', '$l = 12;']);
        list($e, $evalFile) = p2_eval_catch($code);
        $info = ExceptionFormatter::format($e, ['evalFile' => $evalFile, 'lineOffset' => 5, 'userCode' => $code, 'projectPath' => '']);
        t_same('RuntimeException', $info['class']);
        t_same('boom', $info['message']);
        t_same('7', $info['code']);
        t_same('', $info['file']);
        t_same(11, $info['line']);
        t_same(11, $info['userLine']);
        t_same(['startLine' => 7, 'line' => 11, 'lines' => array_slice(explode("\n", $code), 2, 9)], $info['snippet']);
        t_same(null, $info['previous']);
        t_assert(!isset($info['fatal']) && !isset($info['bootstrap']));
    },
    'snippets near the start and end of the code are shifted, not shortened' => function () {
        $code = "throw new LogicException('first');\n\$x = 1;";
        list($e, $evalFile) = p2_eval_catch($code);
        $info = ExceptionFormatter::format($e, ['evalFile' => $evalFile, 'userCode' => $code]);
        t_same(['startLine' => 1, 'line' => 1, 'lines' => ["throw new LogicException('first');", '$x = 1;']], $info['snippet']);
    },
    'user functions, closures and internal callbacks in the trace' => function () {
        $code = "function tinkerbox_ef_thrower(\$v) {\n    throw new InvalidArgumentException('bad ' . \$v);\n}\n\$fn = function (\$x) { return tinkerbox_ef_thrower(\$x); };\narray_map(\$fn, [1]);";
        list($e, $evalFile) = p2_eval_catch($code);
        $info = ExceptionFormatter::format($e, ['evalFile' => $evalFile, 'lineOffset' => 1, 'userCode' => $code]);
        t_same(2, $info['line']);
        t_same(2, $info['userLine']);
        $frames = p2_frames($info);
        t_same(['call' => 'tinkerbox_ef_thrower()', 'line' => 4, 'userCode' => true], $frames[0]);
        t_same(['call' => '{closure}()'], $frames[1]);
        t_same(['call' => 'array_map()', 'line' => 5, 'userCode' => true], $frames[2]);
    },
    'project and vendor frames: relative paths, vendor flags, first project frame snippet' => function () {
        $project = p2_fixture_project();
        $code = "\$service = new TinkerboxFixture\\App\\Service();\n\n\$service->run('deep');";
        list($e, $evalFile) = p2_eval_catch($code);
        $info = ExceptionFormatter::format($e, ['evalFile' => $evalFile, 'lineOffset' => 1, 'userCode' => $code, 'projectPath' => $project . '/']);
        t_same('DomainException', $info['class']);
        t_same('vendor/acme/lib/src/Thrower.php', $info['file']);
        t_same(8, $info['line']);
        t_same(3, $info['userLine']);
        $frames = p2_frames($info);
        t_same(['call' => 'TinkerboxFixture\Acme\Thrower::fail()', 'file' => 'app/Service.php', 'line' => 9], $frames[0]);
        t_same(['call' => 'TinkerboxFixture\App\Service->{closure}()', 'file' => 'vendor/acme/lib/src/Pipeline.php', 'line' => 8, 'vendor' => true], $frames[1]);
        // PHP < 8.2 reports the last line of a multi-line call, PHP 8.2+ its first line.
        t_same(['call' => 'TinkerboxFixture\Acme\Pipeline::through()', 'file' => 'app/Service.php', 'line' => PHP_VERSION_ID < 80200 ? 10 : 8], $frames[2]);
        t_same(['call' => 'TinkerboxFixture\App\Service->run()', 'line' => 3, 'userCode' => true], $frames[3]);
        $snippet = $info['snippet'];
        t_same(4, $snippet['startLine']);
        t_same(9, $snippet['line']);
        t_same(9, count($snippet['lines']));
        t_contains('Thrower::fail($message)', $snippet['lines'][5]);
    },
    'without a project every non-vendor file is a snippet candidate' => function () {
        p2_fixture_project();
        list($e, $evalFile) = p2_eval_catch("(new TinkerboxFixture\\App\\Service())->run('x');");
        $info = ExceptionFormatter::format($e, ['evalFile' => $evalFile, 'userCode' => '']);
        t_same(9, $info['snippet']['line']);
        t_contains('/vendor/acme/lib/src/Thrower.php', $info['file']);
        t_assert(strpos($info['file'], '/') === 0, 'absolute path without a project');
    },
    'previous exceptions are chained (max 5)' => function () {
        $e = null;
        for ($i = 8; $i >= 1; $i--) $e = new RuntimeException('level ' . $i, $i, $e);
        $info = ExceptionFormatter::format($e, ['bootstrap' => true]);
        t_same(true, $info['bootstrap']);
        $depth = 0;
        $node = $info;
        while ($node['previous'] !== null) {
            $node = $node['previous'];
            $depth++;
            t_same('level ' . ($depth + 1), $node['message']);
            t_assert(!isset($node['bootstrap']), 'bootstrap flag only on the top exception');
        }
        t_same(5, $depth);
    },
    'messages referring to the eval()\'d code use editor lines' => function () {
        $code = "function tinkerbox_ef_needs_arg(\$a) { return \$a; }\n\n\ntinkerbox_ef_needs_arg();";
        list($e, $evalFile) = p2_eval_catch($code);
        t_contains("eval()'d code", $e->getMessage());
        $info = ExceptionFormatter::format($e, ['evalFile' => $evalFile, 'lineOffset' => 3, 'userCode' => $code]);
        t_same('ArgumentCountError', $info['class']);
        t_same('Too few arguments to function tinkerbox_ef_needs_arg(), 0 passed on line 6 and exactly 1 expected', $info['message']);
        t_same(3, $info['line'], 'thrown at the function definition (editor line 3)');
        t_same(3, $info['userLine']);
        t_same(['call' => 'tinkerbox_ef_needs_arg()', 'line' => 6, 'userCode' => true], p2_frames($info)[0]);
    },
    'parse errors in the user code' => function () {
        $code = "\$a = 1;\n\$b = ;";
        list($e, $evalFile) = p2_eval_catch($code);
        $info = ExceptionFormatter::format($e, ['evalFile' => $evalFile, 'lineOffset' => 1, 'userCode' => $code]);
        t_same('ParseError', $info['class']);
        t_same('', $info['file']);
        t_same(2, $info['line']);
        t_same(['$a = 1;', '$b = ;'], $info['snippet']['lines']);
    },
    'deep traces are capped' => function () {
        $code = "function tinkerbox_ef_recurse(\$n) { if (\$n === 0) throw new OverflowException('deep'); return tinkerbox_ef_recurse(\$n - 1); }\ntinkerbox_ef_recurse(400);";
        list($e, $evalFile) = p2_eval_catch($code);
        $info = ExceptionFormatter::format($e, ['evalFile' => $evalFile, 'userCode' => $code]);
        t_same(ExceptionFormatter::MAX_FRAMES + 1, count($info['trace']));
        $last = end($info['trace']);
        t_contains('more frames', $last['call']);
        t_same(['call' => 'tinkerbox_ef_recurse()', 'line' => 1, 'userCode' => true], $info['trace'][0]);
    },
    'anonymous exception classes and string codes' => function () {
        $e = new class('anon') extends RuntimeException {
            protected $code = 'HY000';
        };
        $info = ExceptionFormatter::format($e, []);
        t_same(PHP_VERSION_ID < 80000 ? 'class@anonymous' : 'RuntimeException@anonymous', $info['class']);
        t_same('HY000', $info['code']);
        t_assert(json_encode($info) !== false);
    },
    'fatal errors in the user code' => function () {
        $code = "\$a = [];\nwhile (true) {\n    \$a[] = str_repeat('x', 1024);\n}";
        $evalFile = '/srv/runner.php(12) : eval()\'d code';
        $info = ExceptionFormatter::fatal(['type' => E_ERROR, 'message' => 'Allowed memory size of 134217728 bytes exhausted (tried to allocate 4096 bytes)', 'file' => $evalFile, 'line' => 3], ['evalFile' => $evalFile, 'lineOffset' => 2, 'userCode' => $code]);
        t_same('FatalError', $info['class']);
        t_same(true, $info['fatal']);
        t_same('', $info['file']);
        t_same(4, $info['line']);
        t_same(4, $info['userLine']);
        t_same((string) E_ERROR, $info['code']);
        t_same([], $info['trace']);
        t_same(['startLine' => 2, 'line' => 4, 'lines' => explode("\n", $code)], $info['snippet']);
    },
    'fatal parse errors, uncaught messages and project files' => function () {
        $project = p2_fixture_project();
        $parse = ExceptionFormatter::fatal(['type' => E_PARSE, 'message' => 'syntax error', 'file' => $project . '/app/Service.php', 'line' => 6], ['projectPath' => $project, 'bootstrap' => true]);
        t_same('ParseError', $parse['class']);
        t_same('app/Service.php', $parse['file']);
        t_same(6, $parse['snippet']['line']);
        t_same(true, $parse['bootstrap']);
        $uncaught = ExceptionFormatter::fatal(['type' => E_ERROR, 'message' => "Uncaught Exception: x in /a.php:1\nStack trace:\n#0 {main}\n  thrown", 'file' => '/a.php', 'line' => 1], []);
        t_same('Uncaught Exception: x in /a.php:1', $uncaught['message']);
        t_assert(!isset($uncaught['snippet']), 'missing file has no snippet');
        $empty = ExceptionFormatter::fatal([], []);
        t_same('FatalError', $empty['class']);
        t_same(true, $empty['fatal']);
    },
    'bundle run through stdin: runner frames stripped, user frames mapped' => function () {
        $harness = <<<'PHP'
namespace Tinkerbox {
    final class FakeRunner
    {
        public static function run($code, array $ctx)
        {
            $evalFile = __FILE__ . '(' . __LINE__ . ") : eval()'d code"; try { eval($code); } catch (\Throwable $e) { return [ExceptionFormatter::format($e, $ctx + ['evalFile' => $evalFile, 'userCode' => $code]), $evalFile]; }
            return [null, $evalFile];
        }
    }
    final class FakeCapture
    {
        public static function dumpAt($line, $fn, array $values) { throw new \LogicException('inside runner'); }
        public static function callback($v) { throw new \UnexpectedValueException('runner callback'); }
    }
}
namespace {
    $results = [];
    $user = "function p2_user_fn_NAME(\$x) {\n    return p2_user_missing(\$x);\n}\n\n\np2_user_fn_NAME(1);";
    $results['explicit'] = \Tinkerbox\FakeRunner::run(str_replace('NAME', 'a', $user), ['lineOffset' => 10]);
    $results['fallback'] = \Tinkerbox\FakeRunner::run(str_replace('NAME', 'b', $user), ['lineOffset' => 10, 'evalFile' => '']);
    $results['variants'] = ['explicit' => 'a', 'fallback' => 'b'];
    $results['runnerThrow'] = \Tinkerbox\FakeRunner::run("\$a = 1;\n\\Tinkerbox\\FakeCapture::dumpAt(2, 'dump', [\$a]);", []);
    $results['runnerCallback'] = \Tinkerbox\FakeRunner::run("\n\narray_map([\\Tinkerbox\\FakeCapture::class, 'callback'], [1]);", []);
    $results['argCount'] = \Tinkerbox\FakeRunner::run("function p2_need(\$a) {}\np2_need();", ['evalFile' => '', 'lineOffset' => 4]);
    $results['file'] = __FILE__;
    echo "\n__TWJSON__" . json_encode($results);
}
PHP;
        $r = p2_stdin_run($harness);
        t_same('Standard input code', $r['file']);
        foreach (['explicit', 'fallback'] as $variant) {
            list($info, $evalFile) = $r[$variant];
            t_assert(preg_match('/^Standard input code\(\d+\) : eval\(\)\'d code$/', $evalFile) === 1, $evalFile);
            t_same('Error', $info['class'], $variant);
            t_same('Call to undefined function p2_user_missing()', $info['message']);
            t_same('', $info['file']);
            t_same(11, $info['line']);
            $name = 'p2_user_fn_' . $r['variants'][$variant];
            t_same([['call' => $name . '()', 'line' => 15, 'userCode' => true]], $info['trace'], $variant . ': only the user frame survives');
            t_same(['startLine' => 10, 'line' => 11, 'lines' => ['function ' . $name . '($x) {', '    return p2_user_missing($x);', '}', '', '', $name . '(1);']], $info['snippet']);
        }
        // Thrown inside runner code: reported at the user's call site, the call keeps its runner name.
        $runner = $r['runnerThrow'][0];
        t_same('LogicException', $runner['class']);
        t_same('', $runner['file']);
        t_same(2, $runner['line']);
        t_same([['call' => 'Tinkerbox\FakeCapture::dumpAt()', 'line' => 2, 'userCode' => true]], $runner['trace']);
        // Runner internals invoked by the engine are dropped, the user's array_map() call stays.
        $callback = $r['runnerCallback'][0];
        t_same([['call' => 'array_map()', 'line' => 3, 'userCode' => true]], $callback['trace']);
        t_same(3, $callback['line']);
        // Bundle-mode fallback pattern cleans the message.
        t_same('Too few arguments to function p2_need(), 0 passed on line 5 and exactly 1 expected', $r['argCount'][0]['message']);
        t_same(4, $r['argCount'][0]['line']);
        t_same([['call' => 'p2_need()', 'line' => 5, 'userCode' => true]], $r['argCount'][0]['trace']);
    },
];
