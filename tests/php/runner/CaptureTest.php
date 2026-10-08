<?php
/**
 * Capture helpers in-process: SQL interpolation for query events (docs/ARCHITECTURE.md §1.4 `query()`).
 */

require_once __DIR__ . '/support.php';
t_load_runner_sources();

$tests = [];

$tests['interpolate: positional bindings are quoted, escaped and typed'] = function () {
    $sql = 'select * from t where a = ? and b = ? and c = ? and d = ? and e = ? and f = ?';
    $date = new DateTimeImmutable('2024-02-03 04:05:06', new DateTimeZone('UTC'));
    t_same(
        "select * from t where a = 'O''Reilly' and b = NULL and c = 1 and d = 0 and e = 12 and f = '2024-02-03 04:05:06'",
        \Tinkerbox\Capture::interpolate($sql, ["O'Reilly", null, true, false, 12, $date])
    );
};

$tests['interpolate: placeholders inside quotes and missing bindings are kept, ?? is the escaped ? operator'] = function () {
    t_same(
        "select '?' as q, \"col?\" from t where data ? 'k' and x = 5 and y = ?",
        \Tinkerbox\Capture::interpolate("select '?' as q, \"col?\" from t where data ?? 'k' and x = ? and y = ?", [5])
    );
};

$tests['interpolate: named bindings'] = function () {
    t_same(
        "update t set a = 'x' where id = 3 and b = :missing",
        \Tinkerbox\Capture::interpolate('update t set a = :a where id = :id and b = :missing', [':a' => 'x', 'id' => 3])
    );
};

$tests['binding text: floats, binary strings and arrays'] = function () {
    t_same('1.5', \Tinkerbox\Capture::bindingText(1.5));
    t_same('0xff00', \Tinkerbox\Capture::bindingText("\xff\x00"));
    t_same('[1,"a"]', \Tinkerbox\Capture::bindingText([1, 'a']));
    t_same("it's", \Tinkerbox\Capture::bindingText("it's"));
    t_same('NULL', \Tinkerbox\Capture::bindingText(null));
    t_same('0xff00', \Tinkerbox\Capture::sqlLiteral("\xff\x00"));
};

return $tests;
