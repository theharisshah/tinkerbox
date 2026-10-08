<?php

namespace Tinkerbox\Drivers {
    /**
     * Base class of every Tinkerbox driver (docs/ARCHITECTURE.md §1.7).
     *
     * A driver knows how to recognize one kind of project and how to boot it before the user's code runs. The
     * registry (\Tinkerbox\DriverRegistry::detect()) asks the custom drivers first, then the built-ins, and uses the
     * first driver whose canBootstrap() returns true; PlainDriver is the fallback.
     *
     * Life cycle of one run: canBootstrap() → bootstrap() → listenForQueries() (when query capture is on) →
     * variables() → the user's code → afterRun(). Data modes call version(), prettyErrors(), logsPath(), panels(),
     * models() and variables() after bootstrap().
     *
     * Custom drivers are PHP files in `~/.config/tinkerbox/drivers/*.php` (every project) or
     * `<project>/.tinkerbox/drivers/*.php` (one project) declaring a concrete subclass of this class or of a built-in
     * driver (e.g. `class AcmeDriver extends \Tinkerbox\Drivers\LaravelDriver`). A subclass that keeps the parent's
     * id() is reported as that framework; give it its own id() to make it recognizable in the UI.
     */
    abstract class Driver
    {
        /**
         * Stable identifier (DriverInfo.id), e.g. "laravel". Used to force a driver for a project.
         */
        abstract public function id(): string;

        /**
         * Human readable name, e.g. "Laravel".
         */
        abstract public function name(): string;

        /**
         * Whether this driver can boot the project. Must only look at the file system (it runs for every driver
         * until one matches) and must not throw; exceptions are reported as warnings and count as false.
         */
        abstract public function canBootstrap(string $projectPath): bool;

        /**
         * Boot the project so the user's code can use it. The runner has already chdir()ed into the project.
         * Throwing aborts the run with a bootstrap error.
         */
        abstract public function bootstrap(string $projectPath): void;

        /**
         * Footer label with the framework version, e.g. "Laravel 12.20.0". null => the driver name is shown.
         */
        public function version(): ?string
        {
            return null;
        }

        /**
         * Variables injected into the scope of the user's code, e.g. ['app' => $app].
         *
         * @return array<string, mixed>
         */
        public function variables(): array
        {
            return [];
        }

        /**
         * Report executed database queries: call $listener(string $sql, array $bindings, float $timeMs,
         * string $connection) for each one. Called after bootstrap() and before the user's code, only when query
         * capture is enabled.
         */
        public function listenForQueries(callable $listener): void
        {
        }

        /**
         * Called once after the user's code finished (also after exit() / dd()), e.g. to report queries a framework
         * only logs in memory. Must not throw.
         */
        public function afterRun(): void
        {
        }

        /**
         * Panels of the "App Information" modal as AppPanel arrays; build them with \Tinkerbox\Panels\Panel:
         *
         *     return [Panel::make('Shop')->section('Orders', ['Open' => 3, 'Express' => true])->toArray()];
         *
         * The default is the PHP environment panel.
         *
         * @return array[]
         */
        public function panels(string $projectPath): array
        {
            return [\Tinkerbox\Panels\StandardPanels::php($projectPath)];
        }

        /**
         * Root folder of the log viewer: an absolute path or a path relative to the project. null => storage/logs.
         */
        public function logsPath(string $projectPath): ?string
        {
            return null;
        }

        /**
         * Preference for detailed (Collision-style) error output: true / false, or null to follow the global
         * setting.
         */
        public function prettyErrors(): ?bool
        {
            return null;
        }

        /**
         * The project's own PHP files, relative to the project ("app/Models/User.php"), bounded. vendor/,
         * node_modules/ and hidden folders are never included; ignoredFolders() lists further folders to skip.
         *
         * Used by the `environment` data mode: the classes these files declare (outside the composer.json PSR-4
         * folders, which are scanned anyway) are offered for autocompletion. Override it (or ignoredFolders()) to
         * point autocomplete at the right files of a project without Composer autoloading.
         *
         * @return string[]
         */
        public function files(string $projectPath): array
        {
            return Support::projectFiles($projectPath, $this->ignoredFolders());
        }

        /**
         * Models for autocompletion, ModelInfo-shaped: [['class' => 'App\Models\User', 'table' => 'users',
         * 'columns' => [['name' => 'id', 'type' => 'integer'], …], 'relations' => ['posts']], …].
         *
         * @return array[]
         */
        public function models(): array
        {
            return [];
        }

        /**
         * Project-relative folders files() skips besides vendor/, node_modules/ and hidden folders (generated code,
         * caches, uploads, public assets).
         *
         * @return string[]
         */
        protected function ignoredFolders(): array
        {
            return [];
        }
    }
}
