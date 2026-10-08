<?php

namespace Acme\Shop;

/**
 * Tinkerbox fixture: a fake database whose listeners receive every "executed" statement.
 */
class Database
{
    /** @var callable[] */
    private static $listeners = [];

    public static function listen(callable $listener)
    {
        self::$listeners[] = $listener;
    }

    public function select($sql, array $bindings = [])
    {
        foreach (self::$listeners as $listener) {
            $listener($sql, $bindings);
        }

        return [new Models\Order(7, 'open'), new Models\Order(9, 'open')];
    }
}
