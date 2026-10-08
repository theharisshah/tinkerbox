<?php

namespace Acme\Shop\Models;

/**
 * Tinkerbox fixture model (aliased as `Order` by the class alias loader).
 */
class Order
{
    public $id;
    public $status;

    public function __construct($id = 0, $status = 'open')
    {
        $this->id = $id;
        $this->status = $status;
    }
}
