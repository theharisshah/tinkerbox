<?php

/**
 * Tinkerbox fixture: a concrete driver extending an abstract driver declared in another file of the folder (loaded on
 * demand whatever the file order). It never matches (its marker file does not exist) but must load without errors.
 */
class BillingDriver extends ShopBaseDriver
{
    public function id(): string
    {
        return 'billing';
    }

    public function canBootstrap(string $projectPath): bool
    {
        return file_exists($projectPath . '/billing.json');
    }

    public function bootstrap(string $projectPath): void
    {
    }
}
