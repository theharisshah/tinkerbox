<?php
/**
 * Fake Composer autoloader of the Symfony fixture: App\ (PSR-4, src/) plus tiny fakes of the framework classes the
 * Tinkerbox Symfony driver touches (Dotenv, HttpKernel\Kernel, a container with a Doctrine-style registry).
 */
spl_autoload_register(function ($class) {
    $map = [
        'Symfony\\Component\\Dotenv\\Dotenv' => __DIR__ . '/symfony/dotenv/Dotenv.php',
        'Symfony\\Component\\HttpKernel\\Kernel' => __DIR__ . '/symfony/http-kernel/Kernel.php',
        'Doctrine\\DBAL\\Logging\\SQLLogger' => __DIR__ . '/doctrine/dbal/src/Logging/SQLLogger.php',
        'Fixture\\Symfony\\Container' => __DIR__ . '/fixture/Container.php',
    ];
    if (isset($map[$class])) {
        require $map[$class];

        return;
    }
    if (strpos($class, 'App\\') === 0) {
        $file = dirname(__DIR__) . '/src/' . str_replace('\\', '/', substr($class, 4)) . '.php';
        if (is_file($file)) {
            require $file;
        }
    }
});

return new stdClass(); // stands in for Composer's ClassLoader
