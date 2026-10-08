<?php

/**
 * Tinkerbox fixture: abstract drivers are never instantiated.
 */
abstract class ShopBaseDriver extends \Tinkerbox\Drivers\Driver
{
    public function name(): string
    {
        return 'Shop base';
    }

    public function canBootstrap(string $projectPath): bool
    {
        return true;
    }
}
