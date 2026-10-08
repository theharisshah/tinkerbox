<?php
/**
 * \Tinkerbox\ClassAliasLoader (docs/ARCHITECTURE.md §1.7): Tinker-style short-name aliases for project classes from
 * the Composer class map and a bounded PSR-4 scan, with Laravel's tinker.alias / tinker.dont_alias rules.
 *
 * In-process tests use the unique P3Alias\ namespace; the Laravel config rules run in a separate process.
 */

require_once __DIR__ . '/support.php';

if (!function_exists('p3_alias_project')) {
    /** A temp project: PSR-4 P3Alias\ => app/, a class map with project, vendor and global classes. */
    function p3_alias_project(): string
    {
        static $project = null;
        if ($project !== null) {
            return $project;
        }
        $project = p3_tmpdir('alias');
        $class = function ($namespace, $name, $extra = '') {
            return "<?php\nnamespace $namespace;\n\nclass $name\n{\n    $extra\n}\n";
        };
        p3_write_tree($project, [
            'composer.json' => json_encode([
                'name' => 'acme/alias-fixture',
                'autoload' => ['psr-4' => ['P3Alias\\' => 'app/']],
                'autoload-dev' => ['psr-4' => ['P3Alias\\Tests\\' => 'tests/']],
            ]),
            'app/Models/P3Customer.php' => $class('P3Alias\Models', 'P3Customer', 'public $kind = "model";'),
            'app/Services/P3Customer.php' => $class('P3Alias\Services', 'P3Customer', 'public $kind = "service";'),
            'app/Billing/Deep/P3Invoice.php' => $class('P3Alias\Billing\Deep', 'P3Invoice'),
            'app/P3Invoice.php' => $class('P3Alias', 'P3Invoice'),
            'app/Nova/P3Resource.php' => $class('P3Alias\Nova', 'P3Resource'),
            'app/Support/Exception.php' => $class('P3Alias\Support', 'Exception'),
            'app/Support/123-not-a-class.php' => "<?php\n",
            'app/.hidden/P3Hidden.php' => $class('P3Alias\.hidden', 'P3Hidden'),
            'tests/P3CustomerTest.php' => $class('P3Alias\Tests', 'P3CustomerTest'),
            'unmapped/P3Unmapped.php' => $class('P3Alias\Unmapped', 'P3Unmapped'),
            'vendor/composer/autoload_classmap.php' => "<?php\n\$vendorDir = dirname(__DIR__);\n\$baseDir = dirname(\$vendorDir);\nreturn array(\n"
                . "    'P3Alias\\\\Unmapped\\\\P3Unmapped' => \$baseDir . '/unmapped/P3Unmapped.php',\n"
                . "    'Acme\\\\Vendor\\\\P3VendorThing' => \$vendorDir . '/acme/vendor/src/P3VendorThing.php',\n"
                . "    'P3GlobalPolyfill' => \$vendorDir . '/acme/polyfill/P3GlobalPolyfill.php',\n"
                . "    'Acme\\\\Vendor\\\\P3GlobalPolyfill' => \$baseDir . '/app/P3GlobalPolyfill.php',\n"
                . ");\n",
        ]);
        // The project's own autoloader (what vendor/autoload.php would register).
        spl_autoload_register(function ($name) use ($project) {
            foreach (['P3Alias\\Tests\\' => '/tests/', 'P3Alias\\Unmapped\\' => '/unmapped/', 'P3Alias\\' => '/app/'] as $prefix => $dir) {
                if (strncmp($name, $prefix, strlen($prefix)) === 0) {
                    $file = $project . $dir . str_replace('\\', '/', substr($name, strlen($prefix))) . '.php';
                    if (is_file($file)) {
                        require $file;
                    }

                    return;
                }
            }
        });

        return $project;
    }
}

$tests = [];

$tests['aliases come from the class map and the PSR-4 scan, with Tinker precedence rules'] = function () {
    \Tinkerbox\ClassAliasLoader::register(p3_alias_project());
    $aliases = \Tinkerbox\ClassAliasLoader::aliases();
    t_same('P3Alias\Models\P3Customer', $aliases['P3Customer'], '…\\Models\\… wins over other namespaces');
    t_same('P3Alias\P3Invoice', $aliases['P3Invoice'], 'the shallowest namespace wins');
    t_same('P3Alias\Unmapped\P3Unmapped', $aliases['P3Unmapped'], 'project entries of the class map');
    t_same('P3Alias\Tests\P3CustomerTest', $aliases['P3CustomerTest'], 'autoload-dev PSR-4 folders are scanned');
    t_same('P3Alias\Nova\P3Resource', $aliases['P3Resource'], 'the default dont_alias only excludes App\\Nova');
    t_assert(!isset($aliases['P3VendorThing']), 'vendor classes are not aliased');
    t_assert(!isset($aliases['Exception']), 'names of declared global classes are reserved');
    t_assert(!isset($aliases['P3GlobalPolyfill']), 'global class map names (polyfills) are reserved');
    t_assert(!isset($aliases['P3Hidden']), 'hidden folders are skipped');
    foreach (array_keys($aliases) as $alias) {
        t_assert(preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $alias) === 1, "valid alias: $alias");
    }
    t_same(count($aliases), count(array_unique(array_map('strtolower', array_keys($aliases)))), 'one class per short name');
};

$tests['aliases are created on demand by the autoloader'] = function () {
    \Tinkerbox\ClassAliasLoader::register(p3_alias_project());
    t_assert(!class_exists('P3Customer', false), 'nothing is aliased eagerly');
    t_assert(!class_exists('P3Alias\Models\P3Customer', false), 'nothing is autoloaded eagerly');
    $customer = new P3Customer();
    t_same('P3Alias\Models\P3Customer', get_class($customer));
    t_same('model', $customer->kind);
    t_assert(class_exists('p3invoice'), 'class names are case-insensitive');
    t_same('P3Alias\P3Invoice', get_class(new P3Invoice()));
    t_assert(!class_exists('P3NoSuchAlias'), 'unknown names fall through');
    t_assert(!class_exists('P3Alias\Nope\P3Customer'), 'qualified names are never aliased');
};

$tests['register() with no project clears the aliases; the scan is bounded'] = function () {
    \Tinkerbox\ClassAliasLoader::register('');
    t_same([], \Tinkerbox\ClassAliasLoader::aliases());
    \Tinkerbox\ClassAliasLoader::register('/definitely/missing/project');
    t_same([], \Tinkerbox\ClassAliasLoader::aliases());

    $previous = \Tinkerbox\ClassAliasLoader::$maxScanFiles;
    \Tinkerbox\ClassAliasLoader::$maxScanFiles = 0;
    try {
        \Tinkerbox\ClassAliasLoader::register(p3_alias_project());
        t_same(['P3Unmapped' => 'P3Alias\Unmapped\P3Unmapped'], \Tinkerbox\ClassAliasLoader::aliases(), 'only the class map without a scan budget');
    } finally {
        \Tinkerbox\ClassAliasLoader::$maxScanFiles = $previous;
    }
    $broken = p3_write_tree(p3_tmpdir('alias-broken'), ['composer.json' => '{"autoload": {"psr-4": {"Broken\\\\": ["missing/", 42]}}}']);
    \Tinkerbox\ClassAliasLoader::register($broken);
    t_same([], \Tinkerbox\ClassAliasLoader::aliases());
};

$tests['Laravel tinker.alias / tinker.dont_alias and facade names (separate process)'] = function () {
    $project = p3_write_tree(p3_tmpdir('alias-laravel'), [
        'composer.json' => json_encode(['autoload' => ['psr-4' => ['App\\' => 'app/']]]),
        'app/Models/Post.php' => "<?php\nnamespace App\\Models;\nclass Post {}\n",
        'app/Nova/PostResource.php' => "<?php\nnamespace App\\Nova;\nclass PostResource {}\n",
        'app/Internal/Secret.php' => "<?php\nnamespace App\\Internal;\nclass Secret {}\n",
        'app/Support/DB.php' => "<?php\nnamespace App\\Support;\nclass DB {}\n",
        'vendor/composer/autoload_classmap.php' => "<?php\n\$vendorDir = dirname(__DIR__);\nreturn array('Spatie\\\\Tags\\\\Tag' => \$vendorDir . '/spatie/tags/src/Tag.php', 'Statamic\\\\Facades\\\\Entry' => \$vendorDir . '/statamic/cms/src/Facades/Entry.php', 'Statamic\\\\Support\\\\Str' => \$vendorDir . '/statamic/cms/src/Support/Str.php');\n",
        'vendor/statamic/cms/composer.json' => '{}',
    ]);
    putenv('P3_ALIAS_PROJECT=' . $project);
    $result = p3_php_script(<<<'PHP'
namespace Illuminate\Container {
    class Container {
        protected static $instance;
        public static function setInstance($app) { static::$instance = $app; }
    }
}
namespace Illuminate\Foundation {
    class AliasLoader {
        public static function getInstance() { return new static(); }
        public function getAliases() { return ['DB' => 'Illuminate\Support\Facades\DB']; }
    }
}
namespace {
    class P3Config {
        public function get($key) {
            $values = ['tinker.alias' => ['Spatie\Tags\\'], 'tinker.dont_alias' => ['App\Internal']];
            return isset($values[$key]) ? $values[$key] : null;
        }
    }
    class P3App {
        public function version() { return '12.0.0'; }
        public function bound($id) { return $id === 'config'; }
        public function make($id) { return new P3Config(); }
    }
    \Illuminate\Container\Container::setInstance(new P3App());
    \Tinkerbox\ClassAliasLoader::register(getenv('P3_ALIAS_PROJECT'));
    $GLOBALS['__result'] = \Tinkerbox\ClassAliasLoader::aliases();
}
PHP
        , null, null, true);
    putenv('P3_ALIAS_PROJECT');
    t_same([
        'Entry' => 'Statamic\Facades\Entry',
        'Post' => 'App\Models\Post',
        'PostResource' => 'App\Nova\PostResource',
        'Str' => 'Statamic\Support\Str',
        'Tag' => 'Spatie\Tags\Tag',
    ], $result, 'tinker.alias includes vendor prefixes, dont_alias replaces the App\\Nova default, facade names are reserved, Statamic aliases');
};

return $tests;
