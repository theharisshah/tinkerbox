<?php

use Tinkerbox\Dumper;
use TinkerboxTests\Dumper as F;

require_once __DIR__ . '/support.php';
p2_dumper_load();

return [
    'scalars' => function () {
        t_same('"hello"', Dumper::preview('hello'));
        t_same('42', Dumper::preview(42));
        t_same('3.14', Dumper::preview(3.14));
        t_same('1.0', Dumper::preview(1.0));
        t_same('-INF', Dumper::preview(-INF));
        t_same('true', Dumper::preview(true));
        t_same('false', Dumper::preview(false));
        t_same('null', Dumper::preview(null));
        t_same('""', Dumper::preview(''));
    },
    'strings stay on one line' => function () {
        t_same('"a\nb\tc\x00"', Dumper::preview("a\nb\tc\0"));
        t_same('b"\xFF\xFEok"', Dumper::preview("\xFF\xFEok"));
    },
    'arrays inline when they fit' => function () {
        t_same('[1, 2, 3]', Dumper::preview([1, 2, 3]));
        t_same('[]', Dumper::preview([]));
        t_same('["a" => 1, "b" => [true, null]]', Dumper::preview(['a' => 1, 'b' => [true, null]]));
        t_same('[1 => "x", 5 => "y"]', Dumper::preview([1 => 'x', 5 => 'y']));
    },
    'long arrays collapse to array:N [...]' => function () {
        t_same('array:100 [...]', Dumper::preview(range(1, 100)));
        t_same('array:3 [...]', Dumper::preview([str_repeat('x', 50), str_repeat('y', 50), str_repeat('z', 50)]));
        t_same('[[[array:1 [...]]]]', Dumper::preview([[[[[1, 2, 3]]]]]));
    },
    'generic objects' => function () {
        $o = new F\Linked('x');
        t_same(F\Linked::class . ' {#' . spl_object_id($o) . ' …}', Dumper::preview($o));
        $empty = new stdClass();
        t_same('stdClass {#' . spl_object_id($empty) . '}', Dumper::preview($empty));
        t_same('[stdClass {#' . spl_object_id($empty) . '}]', Dumper::preview([$empty]));
    },
    'dates' => function () {
        t_same('DateTime @2024-01-01 10:00:00', Dumper::preview(new DateTime('2024-01-01 10:00:00')));
        t_same('DateTimeImmutable @2024-01-01 10:00:00', Dumper::preview(new DateTimeImmutable('2024-01-01 10:00:00.5')));
    },
    'enums (PHP 8.1+)' => function () {
        if (PHP_VERSION_ID < 80100) return;
        t_same('TinkerboxTestStatus::Active', Dumper::preview(TinkerboxTestStatus::Active));
        t_same('[TinkerboxTestSuit::Hearts, TinkerboxTestSuit::Spades]', Dumper::preview([TinkerboxTestSuit::Hearts, TinkerboxTestSuit::Spades]));
    },
    'closures show their signature' => function () {
        t_same('fn (int $a, $b = 2): string', Dumper::preview(fn (int $a, $b = 2): string => ''));
        $y = 1;
        t_same('function ($x) use ($y)', Dumper::preview(function ($x) use ($y) {
            return $x + $y;
        }));
    },
    'exceptions, stringables and collections of SPL' => function () {
        $e = new RuntimeException('boom');
        t_same('RuntimeException {#' . spl_object_id($e) . ' message: "boom"}', Dumper::preview($e));
        $s = new F\StringableThing();
        t_same(F\StringableThing::class . ' {#' . spl_object_id($s) . ' "I am stringable"}', Dumper::preview($s));
        $ao = new ArrayObject([1, 2, 3]);
        t_same('ArrayObject {#' . spl_object_id($ao) . ' count: 3}', Dumper::preview($ao));
        $throwing = new F\ThrowingToString();
        t_same(F\ThrowingToString::class . ' {#' . spl_object_id($throwing) . '}', Dumper::preview($throwing));
    },
    'resources' => function () {
        $h = fopen('php://memory', 'r');
        t_same('stream resource @' . (int) $h, Dumper::preview($h));
        fclose($h);
        t_same('closed resource @' . (int) $h, Dumper::preview($h));
    },
    'never exceeds the maximum length' => function () {
        $long = Dumper::preview(str_repeat('a', 500));
        t_same(120, mb_strlen($long, 'UTF-8'));
        t_same('…', mb_substr($long, -1, 1, 'UTF-8'));
        t_same('"aaaaaa…', Dumper::preview(str_repeat('a', 50), 8));
        $multibyte = Dumper::preview(str_repeat('€', 100), 10);
        t_same('"€€€€€€€€…', $multibyte);
        t_assert(preg_match('//u', $multibyte) === 1, 'cut on a character boundary');
        foreach ([1, 2, 5, 30] as $max) {
            foreach (['x', str_repeat('ü', 80), range(1, 50), new F\ChildWithPrivate(), new DateTime(), fn () => 1, 1.23456789e-10] as $value) {
                t_assert(mb_strlen(Dumper::preview($value, $max), 'UTF-8') <= $max, 'max ' . $max . ' exceeded for ' . gettype($value));
            }
        }
    },
    'never throws and never calls magic methods' => function () {
        F\MagicTrap::$calls = 0;
        $o = new F\MagicTrap();
        t_same(F\MagicTrap::class . ' {#' . spl_object_id($o) . ' …}', Dumper::preview($o));
        t_same(0, F\MagicTrap::$calls);
        t_same('""', Dumper::preview('', 0), 'an invalid max falls back to 120');
    },
];
