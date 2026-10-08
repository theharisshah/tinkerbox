<?php

use Acme\Shop\Database;
use Acme\Shop\Shop;
use Tinkerbox\Drivers\LaravelDriver;
use Tinkerbox\Panels\Panel;

/**
 * Tinkerbox fixture: a project driver that extends the built-in Laravel driver. The project looks like Laravel
 * (artisan, bootstrap/app.php) but boots itself. The driver adds variables, a version label, a project-relative log
 * folder, query capture through the project's own database hook and its own panels in front of the inherited ones.
 */
class AcmeShopDriver extends LaravelDriver
{
    /** @var Shop|null */
    private $shop;

    public function id(): string
    {
        return 'acme-shop';
    }

    public function name(): string
    {
        return 'Acme Shop';
    }

    public function canBootstrap(string $projectPath): bool
    {
        return file_exists($projectPath . '/acme-shop.json');
    }

    public function bootstrap(string $projectPath): void
    {
        require_once $projectPath . '/src/Database.php';
        require_once $projectPath . '/src/Shop.php';
        require_once $projectPath . '/src/Models/Order.php';
        $this->shop = new Shop(json_decode(file_get_contents($projectPath . '/acme-shop.json'), true));
    }

    public function variables(): array
    {
        return [
            'shop' => $this->shop,
            'acme' => 'Acme Shop',
        ];
    }

    public function version(): ?string
    {
        return $this->shop === null ? null : 'Acme Shop ' . $this->shop->version();
    }

    public function logsPath(string $projectPath): ?string
    {
        return 'storage/logs';
    }

    public function listenForQueries(callable $listener): void
    {
        Database::listen(function ($sql, array $bindings) use ($listener) {
            $listener($sql, $bindings, 0.25, 'acme');
        });
    }

    public function panels(string $projectPath): array
    {
        $shop = Panel::make('Acme Shop')
            ->section('Orders', ['Open' => 3, 'Express' => true])
            ->section('Inventory', ['SKUs' => 1200, 'Warehouse' => null]);
        $deploys = Panel::make('Deploys')->section('Last deploy', ['Commit' => 'abc1234']);

        // The inherited panels follow (Laravel's App Information, or the PHP environment when Laravel is not running).
        return array_merge([$shop->toArray(), $deploys], parent::panels($projectPath));
    }
}
