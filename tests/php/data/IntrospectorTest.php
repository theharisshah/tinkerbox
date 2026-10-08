<?php
/**
 * \Tinkerbox\Introspector (docs/ARCHITECTURE.md §1.8): `members` for plain classes / facades / Eloquent models /
 * collections and `environment` (functions, classes, aliases, constants, models, variables) — in-process for
 * reflection details, and against a real read-only Laravel project (TINKERBOX_TEST_LARAVEL) through the real Laravel driver.
 */

require_once __DIR__ . '/support/helpers.php';
t_load_runner_sources();
require_once __DIR__ . '/support/introspection_fixtures.php';

if (!function_exists('p4_member')) {
    /** First member with this name and kind (null when missing). */
    function p4_member(array $classMembers, string $name, string $kind = 'method'): ?array
    {
        foreach ($classMembers['members'] as $member) {
            if ($member['name'] === $name && $member['kind'] === $kind) {
                return $member;
            }
        }

        return null;
    }

    /** The read-only Laravel project used for integration tests, or null (with a skip notice). */
    function p4_laravel_project(): ?string
    {
        $project = t_laravel_project();
        if (!is_file($project . '/vendor/autoload.php') || !is_file($project . '/artisan')) {
            p4_skip('no Laravel project with vendor/ at ' . $project);

            return null;
        }
        if (p4_php(80200) === null) {
            p4_skip('no PHP >= 8.2 for Laravel 12');

            return null;
        }

        return $project;
    }

    /**
     * Run a data mode through the real runner bundle (real Laravel driver) with the safe environment, asserting
     * that the project's storage / cache / database folders are untouched.
     */
    function p4_laravel_bundle(array $payload): array
    {
        $project = p4_laravel_project();
        $before = p4_snapshot(p4_project_dirs($project));
        $payload += ['projectPath' => $project, 'homePath' => p4_tmpdir('home')];
        $envelope = p4_with_safe_laravel_env(function () use ($payload) {
            return t_run_bundle($payload, null, p4_php(80200));
        });
        t_same($before, p4_snapshot(p4_project_dirs($project)), 'the Laravel project must not be written to');
        t_assert(!isset($envelope['error']) || $envelope['error'] === null, 'data mode error: ' . json_encode(isset($envelope['error']) ? $envelope['error'] : null) . "\n" . $envelope['__stderr']);

        return $envelope;
    }
}

$tests = [];

$tests['members(): constants, properties, methods, docblock tags and @mixin of a plain class'] = function () {
    $cm = \Tinkerbox\Introspector::members('\P4Intro\P4ISquare');
    p4_assert_class_members($cm);
    t_same('P4Intro\P4ISquare', $cm['class']);
    t_same('P4Intro\P4IBase', $cm['parent']);
    t_assert(in_array('P4Intro\P4IShape', $cm['interfaces'], true));

    t_same(['name' => 'SIDES', 'kind' => 'constant', 'static' => true, 'visibility' => 'public', 'signature' => ' = 4', 'type' => 'int', 'declaringClass' => 'P4Intro\P4ISquare'], p4_member($cm, 'SIDES', 'constant'));
    t_same('private', p4_member($cm, 'SECRET', 'constant')['visibility']);
    t_same('P4Intro\P4IShape', p4_member($cm, 'DIMENSIONS', 'constant')['declaringClass']);
    t_same(['name' => 'count', 'kind' => 'property', 'static' => true, 'visibility' => 'public', 'type' => 'int', 'declaringClass' => 'P4Intro\P4ISquare'], p4_member($cm, 'count', 'property'));
    t_same('?string', p4_member($cm, 'name', 'property')['type']);
    t_same('string[]', p4_member($cm, 'labels', 'property')['type'], 'trait properties with @var types');
    t_same(null, p4_member($cm, 'basePrivate', 'property'), 'private members of parents are not reachable');
    t_same(null, p4_member($cm, 'basePrivateMethod'));
    t_same('protected', p4_member($cm, 'baseProtected')['visibility']);

    t_same(['name' => 'area', 'kind' => 'method', 'static' => false, 'visibility' => 'public', 'signature' => '(): int', 'type' => 'int', 'doc' => 'Area of the square.', 'declaringClass' => 'P4Intro\P4ISquare'], p4_member($cm, 'area'));
    // PHP 8.5 reflection reports `self` return types resolved to the class name.
    t_assert(in_array(p4_member($cm, 'make')['signature'], ['(int $side = 2, string ...$labels): self', '(int $side = 2, string ...$labels): P4Intro\P4ISquare'], true), p4_member($cm, 'make')['signature']);
    t_same(true, p4_member($cm, 'make')['static']);
    t_same('(?array $options = null, $flags = PHP_INT_MAX, $mode = self::SIDES)', p4_member($cm, 'surface')['signature']);
    t_same('private', p4_member($cm, 'secret')['visibility']);

    // @method / @property tags (static flag, return type, description) and @mixin methods.
    t_same(['name' => 'shout', 'kind' => 'method', 'static' => true, 'visibility' => 'public', 'signature' => '(string $text, int $times = 1): string', 'type' => 'string', 'doc' => 'Shout a text.', 'declaringClass' => 'P4Intro\P4ISquare'], p4_member($cm, 'shout'));
    t_same(false, p4_member($cm, 'perimeter')['static']);
    t_same(['name' => 'diagonal', 'kind' => 'property', 'static' => false, 'visibility' => 'public', 'type' => 'int', 'doc' => 'Length of the diagonal.', 'declaringClass' => 'P4Intro\P4ISquare'], p4_member($cm, 'diagonal', 'property'));
    t_same('string|null', p4_member($cm, 'color', 'property')['type']);
    t_same("(array \$items = ['a' => 1, 'b' => [true, null]], \$text = 'it\\'s')", p4_member($cm, 'help')['signature']);
    t_same('P4Intro\P4IHelper', p4_member($cm, 'help')['declaringClass']);

    $names = [];
    foreach ($cm['members'] as $member) {
        $key = $member['kind'] . ':' . strtolower($member['name']);
        t_assert(!isset($names[$key]), 'duplicate member ' . $key);
        $names[$key] = true;
    }
};

$tests['members(): macros, interfaces, unknown and invalid names'] = function () {
    \P4Intro\P4IMacroable::macro('twice', function (string $value, int $times = 2): string {
        return str_repeat($value, $times);
    });
    $cm = \Tinkerbox\Introspector::members('P4Intro\P4IMacroable');
    p4_assert_class_members($cm);
    t_same(['name' => 'twice', 'kind' => 'method', 'static' => true, 'visibility' => 'public', 'signature' => '(string $value, int $times = 2): string', 'type' => 'string', 'doc' => 'Macro', 'declaringClass' => 'P4Intro\P4IMacroable'], p4_member($cm, 'twice'));
    t_assert(!array_key_exists('parent', $cm), 'no parent key for root classes');

    $interface = \Tinkerbox\Introspector::members('P4Intro\P4IShape');
    p4_assert_class_members($interface);
    t_same('()', p4_member($interface, 'area')['signature']);
    t_same(' = 2', p4_member($interface, 'DIMENSIONS', 'constant')['signature']);
    t_same(null, \Tinkerbox\Introspector::members('P4INoSuchClass'));
    t_same(null, \Tinkerbox\Introspector::members('not a class!'));
    t_same(null, \Tinkerbox\Introspector::members(''));
    t_same('ArrayObject', \Tinkerbox\Introspector::members('arrayobject')['class'], 'case-insensitive names resolve to the declared name');
    t_same('P4Intro\P4ISquare', \Tinkerbox\Introspector::resolveClass('P4ISquare'), 'short names resolve to declared classes');
};

$tests['signatures: native types, docblock types, defaults, by-ref variadics'] = function () {
    t_same('(int $id, string|null $name = null, array $options = [], &...$rest): ?array', \Tinkerbox\Introspector::signature(new ReflectionFunction('p4_intro_function')));
    $strlen = \Tinkerbox\Introspector::signature(new ReflectionFunction('strlen'));
    t_assert(strpos($strlen, '(') === 0 && strpos($strlen, '$str') !== false, $strlen);
    if (PHP_VERSION_ID >= 80000) {
        t_same('(string $string): int', $strlen);
    }
    $tags = \Tinkerbox\Introspector::parseDocTags("/**\n * @method static \\Illuminate\\Database\\Eloquent\\Builder|static where(string \$column,\n *     mixed \$value = null) Multi-line.\n * @property-write array<string, int> \$counts\n * @method foo\n */");
    t_same('where', $tags[0]['name']);
    t_same(true, $tags[0]['static']);
    t_same('(string $column, mixed $value = null)', $tags[0]['params']);
    t_same('Multi-line.', $tags[0]['doc']);
    t_same('counts', $tags[1]['name']);
    t_same('array<string, int>', $tags[1]['type']);
    t_same(2, count($tags), 'malformed @method without parentheses is ignored');
};

$tests['environment(): shape, functions, classes, constants and driver info without a framework'] = function () {
    $start = microtime(true);
    $env = \Tinkerbox\Introspector::environment(\Tinkerbox\DriverRegistry::detect('', '', p4_tmpdir('home')), '');
    $elapsed = microtime(true) - $start;
    p4_assert_environment($env);
    t_assert($elapsed < 2.0, 'environment() took ' . round($elapsed, 2) . 's');
    t_same(PHP_VERSION, $env['phpVersion']);
    t_same('none', $env['driver']['id']);
    t_assert(in_array('Core', $env['extensions'], true));
    $functions = array_column($env['functions'], 'signature', 'name');
    t_assert(isset($functions['strlen'], $functions['p4_intro_function']), 'internal and user functions');
    t_same('(int $id, string|null $name = null, array $options = [], &...$rest): ?array', $functions['p4_intro_function']);
    foreach (array_keys($functions) as $name) {
        t_assert(stripos($name, 'tinkerbox') === false, "runner function leaked: $name");
    }
    t_assert(in_array('ArrayObject', $env['classes'], true) && in_array('P4Intro\P4ISquare', $env['classes'], true));
    foreach ($env['classes'] as $class) {
        t_assert(strpos($class, 'Tinkerbox\\') !== 0, "runner class leaked: $class");
    }
    t_assert(count($env['classes']) <= \Tinkerbox\Introspector::MAX_CLASSES);
    t_assert(in_array('PHP_EOL', $env['constants'], true) && in_array('E_ALL', $env['constants'], true));
    t_same([], $env['models']);
    t_same([], $env['variables']);
};

$tests['normalizeModel(): ModelInfo from custom driver values'] = function () {
    t_same(['class' => 'App\Models\User', 'columns' => []], \Tinkerbox\Introspector::normalizeModel('\App\Models\User'));
    t_same(
        ['class' => 'App\Post', 'table' => 'posts', 'columns' => [['name' => 'id', 'type' => 'integer'], ['name' => 'title', 'type' => 'varchar'], ['name' => 'body']], 'relations' => ['author', 'comments']],
        \Tinkerbox\Introspector::normalizeModel(['class' => 'App\Post', 'table' => 'posts', 'columns' => [['name' => 'id', 'type' => 'integer'], 'title' => 'varchar', 'body', ['type' => 'nameless']], 'relations' => ['author', 'comments' => 'hasMany', ['name' => 'author']]])
    );
    t_same(null, \Tinkerbox\Introspector::normalizeModel(['table' => 'x']));
    t_same(null, \Tinkerbox\Introspector::normalizeModel(42));
};

$tests['Laravel: environment through the real driver is complete and fast (< 2 s)'] = function () {
    $project = p4_laravel_project();
    if ($project === null) {
        return;
    }
    $before = p4_snapshot(p4_project_dirs($project));
    $probe = p4_probe(__DIR__ . '/support/laravel_probe.php', [$project, 'environment'], p4_php(80200));
    t_same($before, p4_snapshot(p4_project_dirs($project)), 'the Laravel project must not be written to');
    t_assert($probe['elapsedMs'] < 2000, 'environment() took ' . round($probe['elapsedMs']) . ' ms');
    $env = $probe['data'];
    p4_assert_environment($env);
    t_same('laravel', $env['driver']['id']);
    t_contains('Laravel ', $env['driver']['appVersion']);
    $functions = array_column($env['functions'], 'signature', 'name');
    t_assert(isset($functions['app'], $functions['config'], $functions['collect']), 'Laravel helpers');
    t_assert(array_search('app', array_column($env['functions'], 'name'), true) < array_search('strlen', array_column($env['functions'], 'name'), true), 'user functions come first');
    t_assert(in_array('App\Models\User', $env['classes'], true), 'project classes');
    t_assert(in_array('Illuminate\Support\Collection', $env['classes'], true), 'vendor classes');
    t_assert(count($env['classes']) > 1000, 'class map classes: ' . count($env['classes']));
    t_same('Illuminate\Support\Facades\DB', $env['aliases']['DB']);
    t_same('App\Models\User', $env['aliases']['User'], 'Tinker-style project aliases');
    t_same(['app'], array_column($env['variables'], 'name'));
    t_contains('Application', $env['variables'][0]['type']);
    $models = array_column($env['models'], null, 'class');
    t_assert(isset($models['App\Models\User']), 'models from the driver');
    t_same('users', $models['App\Models\User']['table']);
};

$tests['Laravel: members of the DB facade are the facade root methods, static'] = function () {
    if (p4_laravel_project() === null) {
        return;
    }
    $cm = p4_laravel_bundle(['mode' => 'members', 'className' => 'DB'])['data'];
    p4_assert_class_members($cm);
    t_same('Illuminate\Support\Facades\DB', $cm['class']);
    t_same('Illuminate\Support\Facades\Facade', $cm['parent']);
    foreach (['table', 'select', 'connection', 'transaction', 'listen', 'enableQueryLog', 'getDefaultConnection'] as $method) {
        $member = p4_member($cm, $method);
        t_assert($member !== null, "DB::$method");
        t_same(true, $member['static'], "DB::$method is static");
    }
    t_same('Illuminate\Database\DatabaseManager', p4_member($cm, 'connection')['declaringClass']);
    t_contains('string', p4_member($cm, 'table')['signature']);
};

$tests['Laravel: members of App\Models\User include Eloquent / query builder methods as static'] = function () {
    if (p4_laravel_project() === null) {
        return;
    }
    $cm = p4_laravel_bundle(['mode' => 'members', 'className' => 'User'])['data'];
    p4_assert_class_members($cm);
    t_same('App\Models\User', $cm['class']);
    foreach (['where', 'first', 'find', 'create', 'whereIn', 'orderBy', 'paginate', 'query', 'all'] as $method) {
        $member = p4_member($cm, $method);
        t_assert($member !== null, "User::$method");
        t_same(true, $member['static'], "User::$method is static");
    }
    foreach (['save', 'delete', 'fill', 'toArray'] as $method) {
        t_same(false, p4_member($cm, $method)['static'], "\$user->$method() is an instance method");
    }
    t_same('Illuminate\Database\Eloquent\Builder', p4_member($cm, 'where')['declaringClass']);
    t_assert(p4_member($cm, 'email', 'property') !== null, 'fillable attributes are properties');
    t_assert(p4_member($cm, 'password', 'property') !== null);
};

$tests['Laravel: local scopes (scopeX and #[Scope]), casts and accessors of a model'] = function () {
    $project = p4_laravel_project();
    if ($project === null) {
        return;
    }
    $cm = p4_probe(__DIR__ . '/support/laravel_probe.php', [$project, 'scoped-members'], p4_php(80200))['data'];
    p4_assert_class_members($cm);
    t_same('App\Models\P4ScopedPost', $cm['class']);
    t_same(['name' => 'published', 'kind' => 'method', 'static' => true, 'visibility' => 'public', 'signature' => '($flag = true): Illuminate\Database\Eloquent\Builder', 'type' => 'Illuminate\Database\Eloquent\Builder', 'doc' => 'Only published posts.', 'declaringClass' => 'App\Models\P4ScopedPost'], p4_member($cm, 'published'));
    if (class_exists('Illuminate\Database\Eloquent\Attributes\Scope') || is_file($project . '/vendor/laravel/framework/src/Illuminate/Database/Eloquent/Attributes/Scope.php')) {
        $popular = p4_member($cm, 'popular');
        t_same(true, $popular['static']);
        t_same('public', $popular['visibility']);
        t_same('(int $minViews = 100): Illuminate\Database\Eloquent\Builder', $popular['signature']);
    }
    t_same('datetime', p4_member($cm, 'published_at', 'property')['type']);
    t_same('array', p4_member($cm, 'meta', 'property')['type']);
    t_assert(p4_member($cm, 'title_upper', 'property') !== null, 'accessor property');
    t_same(true, p4_member($cm, 'where')['static']);
};

$tests['Laravel: members of Illuminate\Support\Collection'] = function () {
    if (p4_laravel_project() === null) {
        return;
    }
    $cm = p4_laravel_bundle(['mode' => 'members', 'className' => 'Illuminate\Support\Collection'])['data'];
    p4_assert_class_members($cm);
    t_same('Illuminate\Support\Collection', $cm['class']);
    foreach (['map', 'filter', 'pluck', 'first', 'sum', 'toArray', 'each'] as $method) {
        t_same(false, p4_member($cm, $method)['static'], "Collection::$method");
    }
    foreach (['make', 'times', 'macro', 'wrap'] as $method) {
        t_same(true, p4_member($cm, $method)['static'], "Collection::$method is static");
    }
    t_assert(in_array('ArrayAccess', $cm['interfaces'], true) && in_array('IteratorAggregate', $cm['interfaces'], true));
    t_same(null, p4_laravel_bundle(['mode' => 'members', 'className' => 'P4\Definitely\Missing'])['data']);
};

$tests['environment(): classes declared in Driver::files() outside the PSR-4 folders, honouring ignoredFolders()'] = function () {
    $project = p4_tmpdir('p4-driver-files');
    $files = [
        'composer.json' => '{"autoload": {"psr-4": {"P4Files\\\\": "src/"}}}',
        'src/Mapped.php' => "<?php\nnamespace P4Files;\nclass Mapped {}\n",
        'lib/Legacy.php' => "<?php\nclass P4LegacyWidget {}\ninterface P4LegacyContract {}\n",
        'storage/Cached.php' => "<?php\nclass P4CachedCompiled {}\n",
        '.tinkerbox/drivers/Hidden.php' => "<?php\nclass P4HiddenDriverFile {}\n",
    ];
    foreach ($files as $path => $content) {
        @mkdir(dirname($project . '/' . $path), 0777, true);
        file_put_contents($project . '/' . $path, $content);
    }
    $driver = new class extends \Tinkerbox\Drivers\Driver {
        public function id(): string { return 'p4-files'; }
        public function name(): string { return 'P4 Files'; }
        public function canBootstrap(string $projectPath): bool { return true; }
        public function bootstrap(string $projectPath): void {}
        protected function ignoredFolders(): array { return ['storage']; }
    };
    $classes = \Tinkerbox\Introspector::environment($driver, $project)['classes'];
    foreach (['P4Files\Mapped', 'P4LegacyWidget', 'P4LegacyContract'] as $class) {
        t_assert(in_array($class, $classes, true), "$class is offered");
    }
    t_assert(!in_array('P4CachedCompiled', $classes, true), 'ignoredFolders() is honoured');
    t_assert(!in_array('P4HiddenDriverFile', $classes, true), 'hidden folders are skipped');
    t_assert(!class_exists('P4LegacyWidget', false), 'files are tokenized, never loaded');
};

return $tests;
