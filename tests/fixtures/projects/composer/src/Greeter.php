<?php

namespace Acme\Greeter;

/**
 * Tinkerbox fixture class (autoloaded through the fixture's vendor/autoload.php, aliased as `Greeter`).
 */
class Greeter
{
    public function greet($name)
    {
        return 'Hello, ' . $name . '!';
    }
}
