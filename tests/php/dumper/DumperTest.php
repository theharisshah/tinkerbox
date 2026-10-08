<?php

use Tinkerbox\Dumper;
use TinkerboxTests\Dumper as F;

require_once __DIR__ . '/support.php';
p2_dumper_load();

return [
    // ------------------------------------------------------------------ scalars
    'null and booleans' => function () {
        t_same(['t' => 'null'], p2_dump(null));
        t_same(['t' => 'bool', 'v' => true], p2_dump(true));
        t_same(['t' => 'bool', 'v' => false], p2_dump(false));
    },
    'integers are strings (64-bit safe)' => function () {
        t_same(['t' => 'int', 'v' => '42'], p2_dump(42));
        t_same(['t' => 'int', 'v' => '0'], p2_dump(0));
        t_same(['t' => 'int', 'v' => (string) PHP_INT_MAX], p2_dump(PHP_INT_MAX));
        t_same(['t' => 'int', 'v' => (string) PHP_INT_MIN], p2_dump(PHP_INT_MIN));
    },
    'floats use the shortest round-trip form' => function () {
        t_same('1.5', p2_dump(1.5)['v']);
        t_same('1.0', p2_dump(1.0)['v']);
        t_same('-0.0', p2_dump(-0.0)['v']);
        t_same('1.0E+25', p2_dump(1e25)['v']);
        t_same('0.30000000000000004', p2_dump(0.1 + 0.2)['v']);
        t_same('float', p2_dump(3.14)['t']);
    },
    'INF, -INF and NAN' => function () {
        t_same(['t' => 'float', 'v' => 'INF'], p2_dump(INF));
        t_same(['t' => 'float', 'v' => '-INF'], p2_dump(-INF));
        t_same(['t' => 'float', 'v' => 'NAN'], p2_dump(NAN));
    },
    'float formatting ignores and restores serialize_precision' => function () {
        $old = ini_get('serialize_precision');
        ini_set('serialize_precision', '17');
        try {
            t_same('0.1', p2_dump(0.1)['v']);
            t_same('17', ini_get('serialize_precision'));
        } finally {
            ini_set('serialize_precision', $old);
        }
    },

    // ------------------------------------------------------------------ strings
    'strings report their character length' => function () {
        t_same(['t' => 'string', 'v' => 'hello', 'len' => 5], p2_dump('hello'));
        t_same(['t' => 'string', 'v' => 'héllo wörld €', 'len' => 13], p2_dump('héllo wörld €'));
        t_same(['t' => 'string', 'v' => '', 'len' => 0], p2_dump(''));
        $nul = p2_dump("a\0b");
        t_same("a\0b", $nul['v']);
        t_assert(empty($nul['binary']), 'NUL bytes are valid UTF-8');
    },
    'long strings are truncated on a character boundary' => function () {
        $node = p2_dump(str_repeat('é', 30), ['maxStringLength' => 10]);
        t_same(str_repeat('é', 10), $node['v']);
        t_same(30, $node['len']);
        t_same(true, $node['truncated']);
        $exact = p2_dump(str_repeat('a', 10), ['maxStringLength' => 10]);
        t_assert(!isset($exact['truncated']), 'a string of exactly maxStringLength is not truncated');
    },
    'binary strings are escaped and measured in bytes' => function () {
        $node = p2_dump("PNG\x89\x00\xFF ok");
        t_same('string', $node['t']);
        t_same(true, $node['binary']);
        t_same(9, $node['len']);
        t_same('PNG\x89\x00\xFF ok', $node['v']);
        t_assert(json_encode($node) !== false, 'binary dump must be valid JSON');
    },
    'binary strings are truncated in bytes' => function () {
        $node = p2_dump(str_repeat("\xFF", 100), ['maxStringLength' => 4]);
        t_same('\xFF\xFF\xFF\xFF', $node['v']);
        t_same(100, $node['len']);
        t_same(true, $node['truncated']);
    },
    'the global string byte budget bounds output size' => function () {
        $big = array_fill(0, 50, str_repeat('x', 10000));
        $node = p2_dump($big, ['maxStringBytes' => 100000]);
        $total = 0;
        foreach ($node['items'] as $item) $total += strlen($item['v']['v']);
        t_assert($total <= 100000 + 50 * Dumper::MIN_STRING_LENGTH, 'string budget exceeded: ' . $total);
        t_same(10000, $node['items'][0]['v']['len']);
        t_same(true, $node['items'][49]['v']['truncated']);
        t_same(Dumper::MIN_STRING_LENGTH, strlen($node['items'][49]['v']['v']));
    },

    // ------------------------------------------------------------------ arrays
    'nested arrays keep keys and counts' => function () {
        $node = p2_dump(['a' => 1, 5 => [true, null], 'nested' => ['x' => ['y' => 'z']]]);
        t_same('array', $node['t']);
        t_same(3, $node['count']);
        t_same('a', $node['items'][0]['k']);
        t_same(5, $node['items'][1]['k']);
        t_same(2, $node['items'][1]['v']['count']);
        t_same(['t' => 'bool', 'v' => true], $node['items'][1]['v']['items'][0]['v']);
        t_same('z', $node['items'][2]['v']['items'][0]['v']['items'][0]['v']['v']);
        t_assert(!isset($node['truncated']));
    },
    'arrays are cut at maxItems' => function () {
        $node = p2_dump(range(1, 1000), ['maxItems' => 10]);
        t_same(1000, $node['count']);
        t_same(10, count($node['items']));
        t_same(true, $node['truncated']);
        t_same('10', $node['items'][9]['v']['v']);
    },
    'max depth stops expansion' => function () {
        $value = ['l1' => ['l2' => ['l3' => [1, 2, 3]]], 'empty' => ['e' => []]];
        $node = p2_dump($value, ['maxDepth' => 2]);
        $l2 = $node['items'][0]['v']['items'][0]['v'];
        t_same(['t' => 'max-depth', 'type' => 'array', 'count' => 1], $l2);
        // empty arrays have nothing to hide and stay arrays
        t_same(['t' => 'array', 'count' => 0, 'items' => []], $node['items'][1]['v']['items'][0]['v']);
        $object = p2_dump([[new F\Linked('deep')]], ['maxDepth' => 2]);
        t_same(['t' => 'max-depth', 'type' => 'object', 'class' => F\Linked::class], $object['items'][0]['v']['items'][0]['v']);
    },
    'binary array keys stay JSON-safe' => function () {
        $node = p2_dump(["\xFFkey" => 1]);
        t_same('\xFFkey', $node['items'][0]['k']);
        t_assert(json_encode($node) !== false);
    },
    'limits accept JSON strings and ignore invalid values' => function () {
        $node = Dumper::dump(range(1, 20), ['maxItems' => '3', 'maxDepth' => 'nope', 'maxStringLength' => -5]);
        t_same(3, count($node['items']));
        $deep = Dumper::dump([[[[[[[[['x']]]]]]]]], ['maxDepth' => 0]);
        t_same('array', $deep['t'], 'maxDepth 0 is invalid and falls back to the default');
    },

    // ------------------------------------------------------------------ objects
    'repeated objects become refs' => function () {
        $o = new F\Linked('a');
        $node = p2_dump([$o, $o]);
        $first = $node['items'][0]['v'];
        t_same('object', $first['t']);
        t_same(spl_object_id($o), $first['id']);
        t_same(['t' => 'ref', 'class' => F\Linked::class, 'id' => spl_object_id($o)], $node['items'][1]['v']);
    },
    'cycles terminate with refs' => function () {
        $a = new F\Linked('a');
        $b = new F\Linked('b');
        $a->next = $b;
        $b->next = $a;
        $a->children = [$a];
        $node = p2_dump($a);
        $next = p2_prop($node, 'next')['v'];
        t_same('b', p2_prop($next, 'name')['v']['v']);
        t_same(['t' => 'ref', 'class' => F\Linked::class, 'id' => spl_object_id($a)], p2_prop($next, 'next')['v']);
        t_same('ref', p2_prop($node, 'children')['v']['items'][0]['v']['t']);
    },
    'visibility decoding incl. parent private properties' => function () {
        $node = p2_dump(new F\ChildWithPrivate());
        t_same(F\ChildWithPrivate::class, $node['class']);
        t_same('child-secret', p2_prop($node, 'secret', 'private', null)['v']['v']);
        $parent = p2_prop($node, 'secret', 'private', F\ParentWithPrivate::class);
        t_same('parent-secret', $parent['v']['v']);
        t_same('protected', p2_prop($node, 'prot')['vis']);
        t_same('public', p2_prop($node, 'pub')['vis']);
        t_same('public', p2_prop($node, 'own')['vis']);
    },
    'dynamic properties are marked' => function () {
        $o = new F\Dynamic();
        $o->added = 'dyn';
        $node = p2_dump($o);
        t_same('public', p2_prop($node, 'declared')['vis']);
        t_same('dynamic', p2_prop($node, 'added')['vis']);
        $std = new stdClass();
        $std->a = 1;
        $std->{'with space'} = 2;
        $stdNode = p2_dump($std);
        t_same('dynamic', p2_prop($stdNode, 'a')['vis']);
        t_same('2', p2_prop($stdNode, 'with space')['v']['v']);
    },
    'uninitialized typed properties are skipped' => function () {
        $node = p2_dump(new F\Typed());
        t_same('1', p2_prop($node, 'initialized')['v']['v']);
        t_same(['t' => 'null'], p2_prop($node, 'nullable')['v']);
        t_same(['t' => 'null'], p2_prop($node, 'untyped')['v']);
        t_assert(!p2_has_prop($node, 'uninitialized'), 'uninitialized typed property must be skipped');
    },
    'readonly properties (PHP 8.1+)' => function () {
        if (PHP_VERSION_ID < 80100) return;
        $node = p2_dump(new TinkerboxTestReadonly(7, 's'));
        t_same('7', p2_prop($node, 'id', 'public')['v']['v']);
        t_same('s', p2_prop($node, 'secret', 'private')['v']['v']);
    },
    '__debugInfo output is preferred' => function () {
        $node = p2_dump(new F\WithDebugInfo());
        t_same('visible', p2_prop($node, 'name', 'public')['v']['v']);
        t_same('***', p2_prop($node, 'masked', 'public')['v']['v']);
        t_same('debug', p2_prop($node, 'kind', 'protected')['v']['v']);
        t_assert(!p2_has_prop($node, 'password'), '__debugInfo hides the real property');
    },
    'a throwing __debugInfo falls back to the property table' => function () {
        $node = p2_dump(new F\ThrowingDebugInfo());
        t_same('real', p2_prop($node, 'real', 'public')['v']['v']);
    },
    'magic methods are never invoked' => function () {
        F\MagicTrap::$calls = 0;
        $node = p2_dump(new F\MagicTrap());
        Dumper::preview(new F\MagicTrap());
        t_same(0, F\MagicTrap::$calls);
        t_same('1', p2_prop($node, 'real')['v']['v']);
        t_same(1, count($node['props']));
    },
    'static properties are not dumped' => function () {
        $node = p2_dump(new F\WithStatic());
        t_same(1, count($node['props']));
        t_same('instance', $node['props'][0]['name']);
    },
    'anonymous classes get clean names' => function () {
        $o = new class extends F\Linked {
            private $hidden = 'h';

            public function __construct()
            {
                parent::__construct('anon');
            }
        };
        $node = p2_dump($o);
        t_assert(strpos($node['class'], "\0") === false, 'class name must not contain NUL');
        t_contains('@anonymous', $node['class']);
        $hidden = p2_prop($node, 'hidden', 'private');
        t_assert(!isset($hidden['declaringClass']), 'own private property has no declaringClass');
        t_same('anon', p2_prop($node, 'name')['v']['v']);
        t_assert(json_encode($node) !== false);
    },
    'incomplete classes show their original name' => function () {
        $o = unserialize('O:23:"Some\Missing\ClassName1":1:{s:1:"a";i:1;}');
        $node = p2_dump($o);
        t_same('__PHP_Incomplete_Class(Some\Missing\ClassName1)', $node['class']);
        t_same(1, count($node['props']));
        t_same('a', $node['props'][0]['name']);
    },

    // ------------------------------------------------------------------ enums & closures
    'enums (PHP 8.1+)' => function () {
        if (PHP_VERSION_ID < 80100) return;
        t_same(['t' => 'enum', 'class' => 'TinkerboxTestStatus', 'case' => 'Active', 'value' => 'active'], p2_dump(TinkerboxTestStatus::Active));
        t_same(['t' => 'enum', 'class' => 'TinkerboxTestSuit', 'case' => 'Hearts'], p2_dump(TinkerboxTestSuit::Hearts));
        t_same(10, p2_dump(TinkerboxTestLevel::High)['value']);
        $node = p2_dump([TinkerboxTestSuit::Hearts, TinkerboxTestSuit::Hearts]);
        t_same('enum', $node['items'][1]['v']['t'], 'enums are never refs');
    },
    'arrow function signature' => function () {
        $fn = fn (int $a, $b = 2): string => (string) ($a + $b);
        $node = p2_dump($fn);
        t_same('closure', $node['t']);
        t_same('fn (int $a, $b = 2): string', $node['signature']);
        t_same(__FILE__, $node['file']);
        t_same(__LINE__ - 5, $node['line']);
    },
    'closure signature with use, references, variadics and defaults' => function () {
        $y = 1;
        $z = 2;
        $c = function (?array &$list, string ...$rest) use ($y, &$z) {
            return $y;
        };
        t_same('function (?array &$list, string ...$rest) use ($y, $z)', p2_dump($c)['signature']);
        $d = function ($a = null, $b = [], $c = 'it\'s', $e = PHP_EOL, $f = true, $g = 1.5) {
        };
        t_same("function (\$a = null, \$b = [], \$c = 'it\\'s', \$e = PHP_EOL, \$f = true, \$g = 1.5)", p2_dump($d)['signature']);
    },
    'static closures (PHP 8.1+ reflection)' => function () {
        $c = static fn () => 1;
        $signature = p2_dump($c)['signature'];
        t_same(PHP_VERSION_ID >= 80100 ? 'static fn ()' : 'fn ()', $signature);
    },
    'two closures on one line are told apart by their parameters' => function () {
        $pair = [function ($first) { return $first; }, fn ($second) => $second];
        t_same('function ($first)', p2_dump($pair[0])['signature']);
        t_same('fn ($second)', p2_dump($pair[1])['signature']);
    },
    'closures from callables' => function () {
        $strlen = p2_dump(Closure::fromCallable('strlen'));
        t_contains('strlen(', $strlen['signature']);
        t_assert(!isset($strlen['file']), 'internal functions have no file');
        $method = p2_dump(Closure::fromCallable([new F\Methods(), 'greet']));
        t_same(F\Methods::class . '::greet(string $name, int $times = 1): string', $method['signature']);
    },
    'closures in the eval()\'d editor code map to editor lines' => function () {
        $code = "\$x = 1;\n\n\$f = fn (\$v) => \$v * 2;\nreturn \$f;";
        $evalFile = null;
        $closure = (function () use ($code) {
            return eval($code);
        })();
        $evalFile = (new ReflectionFunction($closure))->getFileName();
        Dumper::setContext(['evalFile' => $evalFile, 'lineOffset' => 10, 'evalCode' => $code]);
        try {
            $node = p2_dump($closure);
        } finally {
            Dumper::setContext([]);
        }
        t_same(['t' => 'closure', 'signature' => 'fn ($v)', 'line' => 12], $node);
        // Without context the raw eval file is kept and the keyword cannot be read from source.
        $raw = p2_dump($closure);
        t_same($evalFile, $raw['file']);
        t_same(3, $raw['line']);
    },

    // ------------------------------------------------------------------ dates, exceptions, resources
    'DateTime and DateTimeImmutable with time zones' => function () {
        $date = new DateTime('2024-01-02 03:04:05.678901', new DateTimeZone('Europe/Paris'));
        $node = p2_dump($date);
        t_same('datetime', $node['kind']);
        t_same('2024-01-02 03:04:05.678901 CET (+01:00)', $node['summary']);
        t_same('Europe/Paris', p2_prop($node, 'timezone', 'meta')['v']['v']);
        t_same((string) $date->getTimestamp(), p2_prop($node, 'timestamp')['v']['v']);
        $immutable = p2_dump(new DateTimeImmutable('2024-07-01 12:00:00', new DateTimeZone('America/New_York')));
        t_same('2024-07-01 12:00:00.000000 EDT (-04:00)', $immutable['summary']);
        $offset = p2_dump(new DateTimeImmutable('2024-07-01 12:00:00+05:30'))['summary'];
        t_assert(strpos($offset, '2024-07-01 12:00:00.000000 ') === 0 && substr($offset, -9) === ' (+05:30)', $offset);
    },
    'DateTimeZone and DateInterval summaries' => function () {
        t_same('Asia/Tokyo', p2_dump(new DateTimeZone('Asia/Tokyo'))['summary']);
        $interval = p2_dump(new DateInterval('P1Y2DT3H4M5S'));
        t_same('stringable', $interval['kind']);
        t_same('+ 1y 2d 03:04:05', $interval['summary']);
        $diff = (new DateTime('2024-01-10'))->diff(new DateTime('2024-01-01'));
        t_same('- 9d 00:00:00 (9 days)', p2_dump($diff)['summary']);
    },
    'exceptions show message, code, file, line, previous and own properties' => function () {
        $previous = new LogicException('inner', 3);
        $e = new F\CustomException('outer', 42, $previous);
        $node = p2_dump($e);
        t_same('exception', $node['kind']);
        t_same('outer', $node['summary']);
        t_same('outer', p2_prop($node, 'message', 'protected')['v']['v']);
        t_same('42', p2_prop($node, 'code')['v']['v']);
        t_same(__FILE__, p2_prop($node, 'file')['v']['v']);
        t_same((string) $e->getLine(), p2_prop($node, 'line')['v']['v']);
        $prev = p2_prop($node, 'previous', 'private', 'Exception');
        t_same('LogicException', $prev['v']['class']);
        t_same('inner', $prev['v']['summary']);
        t_same('5', p2_prop($node, 'context', 'public')['v']['items'][0]['v']['v']);
        t_same('h', p2_prop($node, 'hidden', 'private')['v']['v']);
        t_assert(!p2_has_prop($node, 'trace') && !p2_has_prop($node, 'string'), 'internal Exception state is not dumped');
        $error = p2_dump(new TypeError('type'));
        t_same('exception', $error['kind']);
        t_assert(!p2_has_prop($error, 'previous'));
    },
    'open and closed resources' => function () {
        $handle = fopen('php://memory', 'r+');
        $node = p2_dump($handle);
        t_same(['t' => 'resource', 'type' => 'stream', 'id' => (int) $handle], $node);
        fclose($handle);
        t_same(['t' => 'resource', 'type' => 'closed', 'id' => (int) $handle], p2_dump($handle));
        t_same('stream resource @' . (int) STDIN, Dumper::preview(STDIN));
    },

    // ------------------------------------------------------------------ containers
    'ArrayObject and ArrayIterator dump their storage' => function () {
        $node = p2_dump(new ArrayObject(['a' => 1, 'b' => 2]));
        t_same('collection', $node['kind']);
        t_same(2, $node['count']);
        t_same('b', $node['items'][1]['k']);
        $iterator = new ArrayIterator([1, 2, 3]);
        $iterator->next();
        $it = p2_dump($iterator);
        t_same(3, $it['count']);
        t_same(2, $iterator->current(), 'iterator position untouched');
    },
    'SplObjectStorage is dumped without moving its cursor' => function () {
        $storage = new SplObjectStorage();
        $a = new F\Linked('a');
        $b = new F\Linked('b');
        $storage[$a] = 'info-a';
        $storage[$b] = null;
        $storage->rewind();
        $storage->next();
        $node = p2_dump($storage);
        t_same('collection', $node['kind']);
        t_same(2, $node['count']);
        $entry = $node['items'][0]['v'];
        t_same('object', $entry['items'][0]['k']);
        t_same(F\Linked::class, $entry['items'][0]['v']['class']);
        t_same('info-a', $entry['items'][1]['v']['v']);
        t_same($b, $storage->current(), 'cursor untouched');
    },
    'SPL lists, heaps and fixed arrays' => function () {
        $stack = new SplStack();
        $stack->push(1);
        $stack->push(2);
        $node = p2_dump($stack);
        t_same('collection', $node['kind']);
        t_same(['2', '1'], [$node['items'][0]['v']['v'], $node['items'][1]['v']['v']]);
        $heap = new SplMinHeap();
        foreach ([5, 1, 3] as $n) $heap->insert($n);
        $heapNode = p2_dump($heap);
        t_same(['1', '3', '5'], array_map(function ($i) { return $i['v']['v']; }, $heapNode['items']));
        t_same(3, count($heap), 'the heap itself is not drained');
        $fixed = SplFixedArray::fromArray([7, 8]);
        t_same(2, p2_dump($fixed)['count']);
    },
    'generators are never advanced' => function () {
        $ran = false;
        $gen = (function () use (&$ran) {
            $ran = true;
            yield 1;
        })();
        $node = p2_dump($gen);
        t_same(false, $ran, 'generator body must not run');
        t_same('Generator', $node['class']);
        t_same('{closure}', p2_prop($node, 'function', 'meta')['v']['v']);
        Dumper::preview($gen);
        t_same(false, $ran);
    },
    'unknown Traversables are not iterated' => function () {
        F\TrackingAggregate::$iterated = false;
        $node = p2_dump(new F\TrackingAggregate());
        t_same(false, F\TrackingAggregate::$iterated);
        t_same(3, p2_prop($node, 'items')['v']['count']);
        t_assert(!isset($node['kind']), 'generic object');
    },
    'stringable objects' => function () {
        $node = p2_dump(new F\StringableThing());
        t_same('stringable', $node['kind']);
        t_same('I am stringable', $node['summary']);
        t_same('x', p2_prop($node, 'inner')['v']['v']);
    },
    'a throwing __toString falls back to the raw properties' => function () {
        $node = p2_dump(new F\ThrowingToString());
        t_same('object', $node['t']);
        t_same('1', p2_prop($node, 'value')['v']['v']);
        t_contains('cannot stringify', p2_prop($node, 'dumpError', 'meta')['v']['v']);
    },
    'SplFileObject is not read' => function () {
        $file = new SplFileObject(__FILE__);
        $file->seek(3);
        $node = p2_dump($file);
        t_same('stringable', $node['kind']);
        t_same(__FILE__, $node['summary']);
        t_same(3, $file->key(), 'file position untouched');
    },

    // ------------------------------------------------------------------ budgets
    'node budget bounds huge graphs' => function () {
        $root = [];
        for ($i = 0; $i < 300; $i++) {
            $o = new F\Linked('n' . $i);
            $o->children = range(1, 300);
            $root[] = $o;
        }
        $start = microtime(true);
        $node = Dumper::dump($root, ['maxDepth' => 8, 'maxItems' => 500, 'maxStringLength' => 10000, 'maxNodes' => 5000]);
        $ms = (microtime(true) - $start) * 1000;
        $count = p2_count_nodes($node);
        t_assert($count <= 5000 + 20, 'node budget exceeded: ' . $count);
        t_assert($count >= 4900, 'budget should be used: ' . $count);
        t_same(true, $node['truncated']);
        t_assert($ms < 300, 'dump took ' . round($ms) . ' ms');
    },
    'default budget keeps a deep wide graph fast and small' => function () {
        $make = function ($depth) use (&$make) {
            $o = new F\Linked('d' . $depth);
            if ($depth < 6) $o->children = [$make($depth + 1), $make($depth + 1), $make($depth + 1), $make($depth + 1)];
            $o->next = str_repeat('payload ', 20);
            return $o;
        };
        $graph = $make(0); // ~5 500 objects
        $start = microtime(true);
        $node = p2_dump($graph, ['maxDepth' => 20]);
        $ms = (microtime(true) - $start) * 1000;
        $json = json_encode($node);
        $count = p2_count_nodes($node);
        t_assert($count <= Dumper::DEFAULT_MAX_NODES + 20 && $count > Dumper::DEFAULT_MAX_NODES - 100, 'nodes: ' . $count);
        t_assert($ms < 300, 'dump took ' . round($ms) . ' ms');
        t_assert(strlen($json) < 4 * 1024 * 1024, 'json size ' . strlen($json));
    },
    'dumps are always JSON encodable' => function () {
        $o = new stdClass();
        $o->{"bin\xFF"} = "\xFE\xFF";
        $value = [$o, "\xC3\x28", ["\x80" => NAN], new F\ChildWithPrivate(), fn () => 1];
        t_assert(json_encode(p2_dump($value)) !== false, json_last_error_msg());
    },

    // ------------------------------------------------------------------ SQL interpolation (builders)
    'SQL interpolation quotes and escapes bindings' => function () {
        $sql = 'select * from "users" where "name" = ? and "active" = ? and "deleted_at" is ? and "score" > ? and "id" in (?, ?)';
        t_same(
            'select * from "users" where "name" = \'O\'\'Brien\' and "active" = 1 and "deleted_at" is NULL and "score" > 1.5 and "id" in (1, 2)',
            Dumper::interpolateSql($sql, ["O'Brien", true, null, 1.5, 1, 2])
        );
        t_same("select '?' as q, `a?b`, 5", Dumper::interpolateSql("select '?' as q, `a?b`, ?", [5]));
        t_same('select data ?| array[\'a\']', Dumper::interpolateSql('select data ??| array[?]', ['a']));
        t_same("where d = '2024-01-02 03:04:05' and b = x'ff00' and m = ?", Dumper::interpolateSql('where d = ? and b = ? and m = ?', [new DateTime('2024-01-02 03:04:05'), "\xFF\x00"]));
        t_same("where s = 'it\\'s ?' and x = 1", Dumper::interpolateSql("where s = 'it\\'s ?' and x = ?", [1]));
    },
];
