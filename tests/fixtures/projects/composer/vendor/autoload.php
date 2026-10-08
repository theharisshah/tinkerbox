<?php
/**
 * Tinkerbox fixture: stands in for Composer's generated autoloader (PSR-4 for Acme\Greeter\ + a class map).
 */
spl_autoload_register(function ($class) {
    $prefix = 'Acme\\Greeter\\';
    if (strncmp($class, $prefix, strlen($prefix)) === 0) {
        $file = dirname(__DIR__) . '/src/' . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
        if (is_file($file)) {
            require $file;
        }
    }
});

return new stdClass();
