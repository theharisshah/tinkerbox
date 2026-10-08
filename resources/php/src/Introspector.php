<?php

namespace Tinkerbox {
    /**
     * Editor intelligence for the `environment` and `members` data modes (docs/ARCHITECTURE.md §1.8).
     *
     * Everything here is read-only introspection of the already bootstrapped PHP process: Reflection,
     * Composer's class map and a bounded scan of the project's own PSR-4 directories. Classes are never
     * autoloaded in bulk — `members` loads only the class asked for (plus the facade root / Eloquent builders
     * it forwards to), and `environment` only lists names.
     *
     * Output shapes match `EnvironmentInfo`, `ClassMembers` and `MemberInfo` in src/shared/types.ts.
     */
    final class Introspector
    {
        /** Upper bound for EnvironmentInfo.classes. */
        const MAX_CLASSES = 20000;
        /** Upper bound for files visited by the PSR-4 scan of the project's own namespaces. */
        const MAX_SCAN_FILES = 20000;
        /** Wall-clock budget (seconds) for the PSR-4 scan so huge projects cannot stall autocomplete. */
        const SCAN_BUDGET = 0.75;
        /** Upper bound for models discovered without driver support (each one is autoloaded). */
        const MAX_MODELS = 300;
        /** Max length of a `doc` summary line. */
        const MAX_DOC = 240;

        const FACADE = 'Illuminate\Support\Facades\Facade';
        const MODEL = 'Illuminate\Database\Eloquent\Model';
        const ELOQUENT_BUILDER = 'Illuminate\Database\Eloquent\Builder';
        const QUERY_BUILDER = 'Illuminate\Database\Query\Builder';
        const RELATION = 'Illuminate\Database\Eloquent\Relations\Relation';
        const ATTRIBUTE_CAST = 'Illuminate\Database\Eloquent\Casts\Attribute';
        const SCOPE_ATTRIBUTE = 'Illuminate\Database\Eloquent\Attributes\Scope';

        /** PHP identifier (class / function / constant segment). */
        const IDENT = '[A-Za-z_\x80-\xff][A-Za-z0-9_\x80-\xff]*';

        /** @var array<string, array> per-project scan cache (project root => [classes...]) */
        private static $scanCache = [];

        /**
         * Core constants offered by autocomplete in addition to user-defined ones. Filtered with defined()
         * so only the ones available on the running PHP version are returned.
         *
         * @var string[]
         */
        private static $commonConstants = [
            'PHP_EOL', 'PHP_INT_MAX', 'PHP_INT_MIN', 'PHP_INT_SIZE', 'PHP_FLOAT_EPSILON', 'PHP_FLOAT_MAX', 'PHP_FLOAT_MIN',
            'PHP_FLOAT_DIG', 'PHP_VERSION', 'PHP_VERSION_ID', 'PHP_MAJOR_VERSION', 'PHP_MINOR_VERSION', 'PHP_RELEASE_VERSION',
            'PHP_OS', 'PHP_OS_FAMILY', 'PHP_SAPI', 'PHP_BINARY', 'PHP_MAXPATHLEN', 'DIRECTORY_SEPARATOR', 'PATH_SEPARATOR',
            'E_ALL', 'E_ERROR', 'E_WARNING', 'E_PARSE', 'E_NOTICE', 'E_DEPRECATED', 'E_USER_ERROR', 'E_USER_WARNING',
            'E_USER_NOTICE', 'E_USER_DEPRECATED', 'E_RECOVERABLE_ERROR', 'E_CORE_ERROR', 'E_COMPILE_ERROR',
            'JSON_PRETTY_PRINT', 'JSON_UNESCAPED_SLASHES', 'JSON_UNESCAPED_UNICODE', 'JSON_THROW_ON_ERROR', 'JSON_ERROR_NONE',
            'JSON_HEX_TAG', 'JSON_HEX_AMP', 'JSON_HEX_APOS', 'JSON_HEX_QUOT', 'JSON_FORCE_OBJECT', 'JSON_NUMERIC_CHECK',
            'JSON_PRESERVE_ZERO_FRACTION', 'JSON_PARTIAL_OUTPUT_ON_ERROR', 'JSON_INVALID_UTF8_IGNORE',
            'JSON_INVALID_UTF8_SUBSTITUTE', 'JSON_OBJECT_AS_ARRAY', 'JSON_BIGINT_AS_STRING', 'JSON_UNESCAPED_LINE_TERMINATORS',
            'SORT_REGULAR', 'SORT_NUMERIC', 'SORT_STRING', 'SORT_NATURAL', 'SORT_FLAG_CASE', 'SORT_LOCALE_STRING', 'SORT_ASC',
            'SORT_DESC', 'COUNT_RECURSIVE', 'COUNT_NORMAL', 'ARRAY_FILTER_USE_KEY', 'ARRAY_FILTER_USE_BOTH', 'CASE_LOWER',
            'CASE_UPPER', 'EXTR_OVERWRITE', 'EXTR_SKIP', 'EXTR_PREFIX_ALL',
            'PREG_PATTERN_ORDER', 'PREG_SET_ORDER', 'PREG_OFFSET_CAPTURE', 'PREG_UNMATCHED_AS_NULL', 'PREG_SPLIT_NO_EMPTY',
            'PREG_SPLIT_DELIM_CAPTURE', 'PREG_SPLIT_OFFSET_CAPTURE', 'PREG_GREP_INVERT',
            'ENT_QUOTES', 'ENT_COMPAT', 'ENT_NOQUOTES', 'ENT_HTML401', 'ENT_HTML5', 'ENT_SUBSTITUTE', 'ENT_IGNORE',
            'FILE_APPEND', 'FILE_IGNORE_NEW_LINES', 'FILE_SKIP_EMPTY_LINES', 'FILE_USE_INCLUDE_PATH', 'LOCK_EX', 'LOCK_SH',
            'LOCK_UN', 'LOCK_NB', 'SEEK_SET', 'SEEK_CUR', 'SEEK_END', 'GLOB_BRACE', 'GLOB_ONLYDIR', 'GLOB_MARK', 'GLOB_NOSORT',
            'PATHINFO_DIRNAME', 'PATHINFO_BASENAME', 'PATHINFO_EXTENSION', 'PATHINFO_FILENAME',
            'PHP_URL_SCHEME', 'PHP_URL_HOST', 'PHP_URL_PORT', 'PHP_URL_USER', 'PHP_URL_PASS', 'PHP_URL_PATH', 'PHP_URL_QUERY',
            'PHP_URL_FRAGMENT', 'PHP_QUERY_RFC1738', 'PHP_QUERY_RFC3986',
            'M_PI', 'M_E', 'M_SQRT2', 'M_LN2', 'M_LN10', 'INF', 'NAN', 'PHP_ROUND_HALF_UP', 'PHP_ROUND_HALF_DOWN',
            'PHP_ROUND_HALF_EVEN', 'PHP_ROUND_HALF_ODD', 'STR_PAD_LEFT', 'STR_PAD_RIGHT', 'STR_PAD_BOTH',
            'MB_CASE_UPPER', 'MB_CASE_LOWER', 'MB_CASE_TITLE', 'LC_ALL', 'LC_NUMERIC', 'LC_TIME', 'LC_MONETARY',
            'DATE_ATOM', 'DATE_COOKIE', 'DATE_ISO8601', 'DATE_RFC822', 'DATE_RFC2822', 'DATE_RFC3339', 'DATE_RFC3339_EXTENDED',
            'DATE_RFC7231', 'DATE_RSS', 'DATE_W3C',
            'PASSWORD_DEFAULT', 'PASSWORD_BCRYPT', 'PASSWORD_ARGON2I', 'PASSWORD_ARGON2ID',
            'FILTER_DEFAULT', 'FILTER_VALIDATE_EMAIL', 'FILTER_VALIDATE_INT', 'FILTER_VALIDATE_FLOAT', 'FILTER_VALIDATE_BOOLEAN',
            'FILTER_VALIDATE_BOOL', 'FILTER_VALIDATE_URL', 'FILTER_VALIDATE_IP', 'FILTER_VALIDATE_DOMAIN', 'FILTER_VALIDATE_REGEXP',
            'FILTER_NULL_ON_FAILURE', 'FILTER_FLAG_IPV4', 'FILTER_FLAG_IPV6', 'FILTER_FLAG_NO_PRIV_RANGE',
            'FILTER_FLAG_NO_RES_RANGE', 'FILTER_SANITIZE_NUMBER_INT', 'FILTER_SANITIZE_SPECIAL_CHARS', 'FILTER_UNSAFE_RAW',
            'STDIN', 'STDOUT', 'STDERR', 'PHP_DEBUG', 'PHP_ZTS', 'PHP_EXTRA_VERSION', 'DEFAULT_INCLUDE_PATH',
        ];

        // -----------------------------------------------------------------------------------------------------
        // environment
        // -----------------------------------------------------------------------------------------------------

        /**
         * EnvironmentInfo for autocomplete. Each section degrades independently: a failure in one (e.g. a
         * misbehaving custom driver) is reported on stderr and leaves that section empty.
         *
         * @param Drivers\Driver $driver
         * @param string $projectPath
         * @return array
         */
        public static function environment(Drivers\Driver $driver, $projectPath)
        {
            $root = self::projectRoot($projectPath);
            $composer = self::composerJson($root);

            return [
                'phpVersion' => PHP_VERSION,
                'driver' => self::attempt('driver info', function () use ($driver, $projectPath) {
                    return self::driverInfo($driver, (string) $projectPath);
                }, null),
                'extensions' => self::attempt('extensions', function () {
                    return self::extensions();
                }, []),
                'functions' => self::attempt('functions', function () {
                    return self::functions();
                }, []),
                'classes' => self::attempt('classes', function () use ($root, $composer, $driver, $projectPath) {
                    return self::classes($root, $composer, $driver, (string) $projectPath);
                }, []),
                'aliases' => self::attempt('aliases', function () {
                    return self::aliases();
                }, []),
                'constants' => self::attempt('constants', function () {
                    return self::constants();
                }, []),
                'models' => self::attempt('models', function () use ($driver, $root, $composer) {
                    return self::models($driver, $root, $composer);
                }, []),
                'variables' => self::attempt('variables', function () use ($driver) {
                    return self::variables($driver);
                }, []),
            ];
        }

        /**
         * DriverInfo of a driver instance (id, name, appVersion, usesCollision, logFilesPath).
         *
         * @param mixed $driver
         * @param string $projectPath
         * @return array|null
         */
        public static function driverInfo($driver, $projectPath = '')
        {
            if (!$driver instanceof Drivers\Driver) {
                return null;
            }
            $info = DriverRegistry::info($driver, (string) $projectPath);
            if ($info['appVersion'] === null) {
                unset($info['appVersion']);
            }

            return $info;
        }

        /** @return string[] loaded PHP + Zend extensions, sorted case-insensitively */
        private static function extensions()
        {
            $extensions = array_merge(get_loaded_extensions(), get_loaded_extensions(true));
            $unique = [];
            foreach ($extensions as $ext) {
                $unique[strtolower($ext)] = $ext;
            }
            $list = array_values($unique);
            natcasesort($list);

            return array_values($list);
        }

        /** @return array FunctionInfo[] — user functions first (with doc summary), then internal ones */
        private static function functions()
        {
            $defined = get_defined_functions();
            $groups = ['user' => [], 'internal' => []];
            $seen = [];
            foreach (['user', 'internal'] as $group) {
                $names = isset($defined[$group]) && is_array($defined[$group]) ? $defined[$group] : [];
                foreach ($names as $name) {
                    $lower = strtolower($name);
                    if (isset($seen[$lower]) || self::isRunnerFunction($lower)) {
                        continue;
                    }
                    $seen[$lower] = true;
                    try {
                        $ref = new \ReflectionFunction($name);
                        $entry = ['name' => $ref->getName(), 'signature' => self::signature($ref)];
                        $doc = self::docSummary($ref->getDocComment());
                        if ($doc === null && $ref->isDeprecated()) {
                            $doc = 'Deprecated';
                        }
                        if ($doc !== null) {
                            $entry['doc'] = $doc;
                        }
                        $groups[$group][] = $entry;
                    } catch (\Throwable $e) {
                        // A single unreflectable function (disabled / broken signature) must not hide the rest.
                        continue;
                    }
                }
            }
            foreach ($groups as &$list) {
                usort($list, function ($a, $b) {
                    return strcasecmp($a['name'], $b['name']);
                });
            }
            unset($list);

            return array_merge($groups['user'], $groups['internal']);
        }

        /** Runner internals and Composer bootstrap functions are not offered to the user. */
        private static function isRunnerFunction($lower)
        {
            return strpos($lower, 'tinkerbox\\') === 0
                || strpos($lower, '__tinkerbox') === 0
                || strpos($lower, 'composer\\autoload\\') === 0
                || strpos($lower, 'composerrequire') === 0;
        }

        /**
         * FQCNs for autocomplete: project classes first (PSR-4 scan of composer.json `autoload.psr-4`, classes
         * declared in the driver's project files outside those directories, project entries of the Composer class
         * map, declared classes in project namespaces), then other declared classes, then the rest of the class
         * map. Deduplicated case-insensitively and capped.
         *
         * @return string[]
         */
        private static function classes($root, array $composer, ?Drivers\Driver $driver = null, $projectPath = '')
        {
            $vendorDir = self::vendorDir($root, $composer);
            $psr4 = self::projectPsr4($root, $composer);
            $prefixes = array_keys($psr4);

            $project = [];
            $loaded = [];
            $mapped = [];

            foreach (self::scanProjectClasses($root, $psr4) as $class) {
                $project[$class] = true;
            }
            if ($driver !== null) {
                foreach (self::driverFileClasses($driver, $projectPath, $psr4) as $class) {
                    $project[$class] = true;
                }
            }
            foreach (self::composerClassMap($vendorDir) as $class => $file) {
                if (!is_string($class) || self::isHiddenClass($class)) {
                    continue;
                }
                if (self::isProjectFile((string) $file, $root, $vendorDir)) {
                    $project[$class] = true;
                } else {
                    $mapped[$class] = true;
                }
            }
            foreach (array_merge(get_declared_classes(), get_declared_interfaces(), get_declared_traits()) as $class) {
                // Custom drivers (loaded from .tinkerbox/drivers) are runner configuration, not project code.
                if (self::isHiddenClass($class) || is_subclass_of($class, 'Tinkerbox\Drivers\Driver')) {
                    continue;
                }
                if (self::inNamespaces($class, $prefixes)) {
                    $project[$class] = true;
                } else {
                    $loaded[$class] = true;
                }
            }

            $out = [];
            $seen = [];
            foreach ([$project, $loaded, $mapped] as $group) {
                $names = array_keys($group);
                sort($names, SORT_STRING | SORT_FLAG_CASE);
                foreach ($names as $name) {
                    $key = strtolower($name);
                    if (isset($seen[$key])) {
                        continue;
                    }
                    $seen[$key] = true;
                    $out[] = $name;
                    if (count($out) >= self::MAX_CLASSES) {
                        return $out;
                    }
                }
            }

            return $out;
        }

        /** Runner / bootstrap classes that must never show up in autocomplete. */
        private static function isHiddenClass($class)
        {
            return $class === ''
                || strpos($class, '@anonymous') !== false
                || strpos($class, "\0") !== false
                || strpos($class, 'Tinkerbox\\') === 0
                || strpos($class, 'ComposerAutoloaderInit') === 0
                || strpos($class, 'Composer\\Autoload\\ComposerStaticInit') === 0;
        }

        /**
         * Short name => FQCN aliases: Laravel facade aliases (AliasLoader / config('app.aliases')) win over the
         * Tinker-style project aliases of ClassAliasLoader, exactly like the runtime resolution order.
         *
         * @return array<string, string>
         */
        public static function aliases()
        {
            $aliases = [];

            foreach (self::projectAliases() as $alias => $target) {
                $aliases[$alias] = $target;
            }
            foreach (self::laravelAliases() as $alias => $target) {
                $aliases[$alias] = $target;
            }
            ksort($aliases, SORT_STRING | SORT_FLAG_CASE);

            return $aliases;
        }

        /** @return array<string, string> aliases registered by \Tinkerbox\ClassAliasLoader (P3) */
        private static function projectAliases()
        {
            $out = [];
            if (!class_exists('Tinkerbox\ClassAliasLoader', false) || !method_exists('Tinkerbox\ClassAliasLoader', 'aliases')) {
                return $out;
            }
            $aliases = ClassAliasLoader::aliases();
            if (!is_array($aliases)) {
                return $out;
            }
            foreach ($aliases as $alias => $target) {
                if (is_string($alias) && is_string($target) && $alias !== '' && $target !== '') {
                    $out[ltrim($alias, '\\')] = ltrim($target, '\\');
                }
            }

            return $out;
        }

        /** @return array<string, string> Laravel facade / package aliases */
        private static function laravelAliases()
        {
            $out = [];
            $raw = [];
            if (class_exists('Illuminate\Foundation\AliasLoader', false)) {
                $raw = \Illuminate\Foundation\AliasLoader::getInstance()->getAliases();
            }
            if (!$raw) {
                $app = self::laravelApp();
                if ($app !== null && $app->bound('config')) {
                    $raw = $app->make('config')->get('app.aliases', []);
                }
            }
            if (!is_array($raw)) {
                return $out;
            }
            foreach ($raw as $alias => $target) {
                if (is_string($alias) && is_string($target) && $alias !== '' && $target !== '') {
                    $out[ltrim($alias, '\\')] = ltrim($target, '\\');
                }
            }

            return $out;
        }

        /** @return string[] user-defined constants first, then the curated core constants available here */
        private static function constants()
        {
            $out = [];
            $all = get_defined_constants(true);
            if (isset($all['user']) && is_array($all['user'])) {
                foreach (array_keys($all['user']) as $name) {
                    // T_* fallbacks are defined by the runner's tokenizer shims on older PHP versions.
                    if (strpos($name, 'T_') === 0 || stripos($name, 'TINKERBOX') === 0) {
                        continue;
                    }
                    $out[$name] = true;
                }
            }
            foreach (self::$commonConstants as $name) {
                if (defined($name)) {
                    $out[$name] = true;
                }
            }
            // E_STRICT is deprecated as of PHP 8.4; only offer it where it is still meaningful.
            if (PHP_VERSION_ID < 80400 && defined('E_STRICT')) {
                $out['E_STRICT'] = true;
            }

            return array_keys($out);
        }

        /** @return array ModelInfo[] from the driver, else discovered from the project's Models namespaces */
        private static function models(Drivers\Driver $driver, $root, array $composer)
        {
            $models = [];
            $raw = $driver->models();
            if (is_array($raw) || $raw instanceof \Traversable) {
                foreach ($raw as $model) {
                    $normalized = self::normalizeModel($model);
                    if ($normalized !== null) {
                        $models[strtolower($normalized['class'])] = $normalized;
                    }
                }
            }
            if (!$models) {
                $models = self::discoverModels($root, $composer);
            }

            return array_values($models);
        }

        /**
         * Normalize one ModelInfo-shaped value coming from a (possibly custom) driver.
         *
         * @param mixed $model
         * @return array|null
         */
        public static function normalizeModel($model)
        {
            if (is_string($model)) {
                $model = ['class' => $model];
            }
            $model = self::toArray($model);
            if (!is_array($model) || !isset($model['class']) || !is_string($model['class']) || $model['class'] === '') {
                return null;
            }
            $info = ['class' => ltrim($model['class'], '\\')];
            if (isset($model['table']) && is_string($model['table']) && $model['table'] !== '') {
                $info['table'] = $model['table'];
            }
            $columns = [];
            $rawColumns = isset($model['columns']) ? self::toArray($model['columns']) : [];
            if (is_array($rawColumns)) {
                foreach ($rawColumns as $key => $column) {
                    $column = self::toArray($column);
                    if (is_string($column)) {
                        $column = is_string($key) ? ['name' => $key, 'type' => $column] : ['name' => $column];
                    }
                    if (!is_array($column) || !isset($column['name']) || !is_scalar($column['name']) || (string) $column['name'] === '') {
                        continue;
                    }
                    $entry = ['name' => (string) $column['name']];
                    if (isset($column['type']) && is_scalar($column['type']) && (string) $column['type'] !== '') {
                        $entry['type'] = (string) $column['type'];
                    }
                    $columns[] = $entry;
                }
            }
            $info['columns'] = $columns;
            if (isset($model['relations'])) {
                $relations = [];
                $rawRelations = self::toArray($model['relations']);
                if (is_array($rawRelations)) {
                    foreach ($rawRelations as $key => $relation) {
                        $name = is_string($key) ? $key : (is_scalar($relation) ? (string) $relation : null);
                        if (is_array($relation) && isset($relation['name']) && is_string($relation['name'])) {
                            $name = $relation['name'];
                        }
                        if ($name !== null && $name !== '') {
                            $relations[] = $name;
                        }
                    }
                }
                $info['relations'] = array_values(array_unique($relations));
            }

            return $info;
        }

        /**
         * Fallback model discovery for drivers without models(): Eloquent models in `…\Models\…`
         * namespaces (and direct children of the first project namespace, the Laravel ≤ 7 layout). No database
         * access: columns come from `@property` docblocks and casts / fillable.
         *
         * @return array<string, array>
         */
        private static function discoverModels($root, array $composer)
        {
            $models = [];
            if ($root === '' || !class_exists(self::MODEL, false)) {
                return $models;
            }
            $psr4 = self::projectPsr4($root, $composer);
            $prefixes = array_keys($psr4);
            $first = $prefixes ? $prefixes[0] : null;
            $count = 0;
            foreach (self::scanProjectClasses($root, $psr4) as $class) {
                $inModels = strpos($class, '\\Models\\') !== false;
                $topLevel = $first !== null && strpos($class, $first) === 0 && strpos(substr($class, strlen($first)), '\\') === false;
                if (!$inModels && !$topLevel) {
                    continue;
                }
                if (++$count > self::MAX_MODELS) {
                    break;
                }
                try {
                    if (!class_exists($class) || !is_subclass_of($class, self::MODEL)) {
                        continue;
                    }
                    $ref = new \ReflectionClass($class);
                    if ($ref->isAbstract()) {
                        continue;
                    }
                    $info = ['class' => $ref->getName(), 'columns' => [], 'relations' => []];
                    $instance = self::modelInstance($ref);
                    if ($instance !== null) {
                        $table = $instance->getTable();
                        if (is_string($table) && $table !== '') {
                            $info['table'] = $table;
                        }
                    }
                    $columns = [];
                    foreach (self::classDocTags($ref) as $tag) {
                        if ($tag['kind'] === 'property') {
                            $columns[$tag['name']] = $tag['type'];
                        }
                    }
                    foreach (self::modelAttributeTypes($instance) as $name => $type) {
                        if (!isset($columns[$name]) || $columns[$name] === null) {
                            $columns[$name] = $type;
                        }
                    }
                    foreach ($columns as $name => $type) {
                        $info['columns'][] = $type !== null && $type !== '' ? ['name' => $name, 'type' => $type] : ['name' => $name];
                    }
                    foreach ($ref->getMethods(\ReflectionMethod::IS_PUBLIC) as $method) {
                        if ($method->isStatic() || $method->getNumberOfRequiredParameters() > 0 || !$method->hasReturnType()) {
                            continue;
                        }
                        $type = $method->getReturnType();
                        if ($type instanceof \ReflectionNamedType && !$type->isBuiltin() && is_a($type->getName(), self::RELATION, true)) {
                            $info['relations'][] = $method->getName();
                        }
                    }
                    $models[strtolower($info['class'])] = $info;
                } catch (\Throwable $e) {
                    // A broken model file (parse error, missing parent) is skipped; the others still complete.
                    self::report('model discovery for ' . $class, $e);
                }
            }

            return $models;
        }

        /** @return array driver variables as [{name, type}] (names without the leading `$`) */
        private static function variables(Drivers\Driver $driver)
        {
            $out = [];
            $vars = $driver->variables();
            if (!is_array($vars)) {
                return $out;
            }
            foreach ($vars as $name => $value) {
                if (is_string($name) && preg_match('/^' . self::IDENT . '$/', $name)) {
                    $out[] = ['name' => $name, 'type' => self::debugType($value)];
                }
            }

            return $out;
        }

        // -----------------------------------------------------------------------------------------------------
        // members
        // -----------------------------------------------------------------------------------------------------

        /**
         * ClassMembers for a class, interface, trait or enum; short names are resolved through aliases and the
         * project's classes. Returns null for unknown classes.
         *
         * The optional driver enables model columns from its models(); the optional project path is
         * guessed (Laravel base path, cwd, Composer vendor dir) when omitted.
         *
         * @param string $class
         * @param Drivers\Driver|null $driver
         * @param string|null $projectPath
         * @return array|null
         */
        public static function members($class, $driver = null, $projectPath = null)
        {
            $root = self::projectRoot($projectPath === null || $projectPath === '' ? self::guessProjectRoot() : $projectPath);
            $name = self::resolveClass($class, $root);
            if ($name === null) {
                return null;
            }
            $ref = new \ReflectionClass($name);
            $name = $ref->getName();
            $isFacade = is_subclass_of($name, self::FACADE);
            $isModel = is_subclass_of($name, self::MODEL);

            $list = [];
            $scopes = [];
            self::addOwnMembers($list, $ref, $isModel, $scopes);

            if ($isModel) {
                foreach ($scopes as $scope) {
                    self::addMember($list, $scope, true);
                }
            }

            if ($isFacade) {
                self::attempt('facade root of ' . $name, function () use (&$list, $name) {
                    self::addFacadeRootMembers($list, $name);
                }, null);
            }

            foreach (self::classDocTags($ref) as $tag) {
                if ($isFacade && $tag['kind'] === 'method') {
                    $tag['static'] = true;
                }
                self::addMember($list, self::tagToMember($tag));
            }

            if ($isModel) {
                self::attempt('model attributes of ' . $name, function () use (&$list, $ref, $driver) {
                    self::addModelAttributeMembers($list, $ref, $driver);
                }, null);
                foreach ([self::ELOQUENT_BUILDER, self::QUERY_BUILDER] as $builder) {
                    if (class_exists($builder)) {
                        self::addForwardedMethods($list, new \ReflectionClass($builder), true);
                    }
                }
            }

            foreach (self::mixins($ref) as $mixin) {
                self::addForwardedMethods($list, $mixin, $isModel ? true : null);
            }

            self::addMacros($list, $ref, $isFacade);

            $result = [
                'class' => $name,
                'interfaces' => array_values($ref->getInterfaceNames()),
                'members' => array_values($list),
            ];
            $parent = $ref->getParentClass();
            if ($parent) {
                $result = ['class' => $name, 'parent' => $parent->getName()] + $result;
            }

            return $result;
        }

        /**
         * Resolve a (possibly short / aliased) class name to the declared FQCN, or null when unknown.
         *
         * @param string $class
         * @param string $root project root ('' when unknown)
         * @return string|null
         */
        public static function resolveClass($class, $root = '')
        {
            $name = ltrim(trim((string) $class), '\\');
            if ($name === '' || !preg_match('/^' . self::IDENT . '(?:\\\\' . self::IDENT . ')*$/', $name)) {
                return null;
            }
            if (self::typeExists($name)) {
                return (new \ReflectionClass($name))->getName();
            }

            $lower = strtolower($name);
            foreach (self::aliases() as $alias => $target) {
                if (strtolower($alias) === $lower && self::typeExists($target)) {
                    return (new \ReflectionClass($target))->getName();
                }
            }

            if (strpos($name, '\\') !== false) {
                return null;
            }

            // Short name: prefer the conventional Laravel locations, then any project class, then loaded classes.
            $root = (string) $root;
            $composer = self::composerJson($root);
            $candidates = [];
            foreach (array_keys(self::projectPsr4($root, $composer)) as $prefix) {
                $candidates[] = $prefix . 'Models\\' . $name;
                $candidates[] = $prefix . $name;
            }
            $candidates[] = 'App\\Models\\' . $name;
            $candidates[] = 'App\\' . $name;
            $projectMatches = [];
            foreach (self::scanProjectClasses($root, self::projectPsr4($root, $composer)) as $candidate) {
                if (strtolower(self::shortName($candidate)) === $lower) {
                    $projectMatches[] = $candidate;
                }
            }
            usort($projectMatches, function ($a, $b) {
                return substr_count($a, '\\') - substr_count($b, '\\') ?: strcmp($a, $b);
            });
            $declared = [];
            foreach (array_merge(get_declared_classes(), get_declared_interfaces(), get_declared_traits()) as $candidate) {
                if (!self::isHiddenClass($candidate) && strtolower(self::shortName($candidate)) === $lower) {
                    $declared[] = $candidate;
                }
            }
            foreach (array_merge($candidates, $projectMatches, $declared) as $candidate) {
                try {
                    if (self::typeExists($candidate)) {
                        return (new \ReflectionClass($candidate))->getName();
                    }
                } catch (\Throwable $e) {
                    // Autoloading a broken candidate file: try the next one.
                    continue;
                }
            }

            return null;
        }

        /** Own constants, enum cases, properties and methods of the class (incl. inherited, minus foreign privates). */
        private static function addOwnMembers(array &$list, \ReflectionClass $ref, $isModel, array &$scopes)
        {
            $name = $ref->getName();
            $isEnum = PHP_VERSION_ID >= 80100 && method_exists($ref, 'isEnum') && $ref->isEnum();

            foreach ($ref->getReflectionConstants() as $const) {
                if ($const->isPrivate() && $const->getDeclaringClass()->getName() !== $name) {
                    continue;
                }
                if ($isEnum && method_exists($const, 'isEnumCase') && $const->isEnumCase()) {
                    continue;
                }
                $member = [
                    'name' => $const->getName(),
                    'kind' => 'constant',
                    'static' => true,
                    'visibility' => self::visibility($const),
                ];
                try {
                    $value = $const->getValue();
                    $type = PHP_VERSION_ID >= 80300 && method_exists($const, 'hasType') && $const->hasType()
                        ? self::typeToString($const->getType())
                        : self::debugType($value);
                    $member['signature'] = ' = ' . self::exportValue($value);
                    $member['type'] = $type;
                } catch (\Throwable $e) {
                    // Constant expression referencing an unloadable class: list it without a value.
                }
                $doc = self::docSummary($const->getDocComment());
                if ($doc !== null) {
                    $member['doc'] = $doc;
                }
                $member['declaringClass'] = $const->getDeclaringClass()->getName();
                self::addMember($list, $member);
            }

            if ($isEnum) {
                $enum = new \ReflectionEnum($name);
                $backing = $enum->isBacked() ? self::typeToString($enum->getBackingType()) : null;
                foreach ($enum->getCases() as $case) {
                    $member = ['name' => $case->getName(), 'kind' => 'case', 'static' => true, 'visibility' => 'public'];
                    if ($backing !== null && method_exists($case, 'getBackingValue')) {
                        $member['signature'] = ' = ' . self::exportValue($case->getBackingValue());
                        $member['type'] = $backing;
                    }
                    $doc = self::docSummary($case->getDocComment());
                    if ($doc !== null) {
                        $member['doc'] = $doc;
                    }
                    $member['declaringClass'] = $name;
                    self::addMember($list, $member);
                }
            }

            foreach ($ref->getProperties() as $prop) {
                if ($prop->isPrivate() && $prop->getDeclaringClass()->getName() !== $name) {
                    continue;
                }
                $member = [
                    'name' => $prop->getName(),
                    'kind' => 'property',
                    'static' => $prop->isStatic(),
                    'visibility' => self::visibility($prop),
                ];
                $type = null;
                if (method_exists($prop, 'hasType') && $prop->hasType()) {
                    $type = self::typeToString($prop->getType());
                } else {
                    $type = self::docVarType($prop->getDocComment());
                }
                if ($type !== null) {
                    $member['type'] = $type;
                }
                $doc = self::docSummary($prop->getDocComment());
                if ($doc !== null) {
                    $member['doc'] = $doc;
                }
                $member['declaringClass'] = $prop->getDeclaringClass()->getName();
                self::addMember($list, $member);
            }

            foreach ($ref->getMethods() as $method) {
                if ($method->isPrivate() && $method->getDeclaringClass()->getName() !== $name) {
                    continue;
                }
                if ($isModel) {
                    $scope = self::scopeMember($method);
                    if ($scope !== null) {
                        $scopes[] = $scope;
                        if (!$method->isPublic() && $scope['name'] === $method->getName()) {
                            // `#[Scope] protected function active()` is only reachable as the scope `active`.
                            continue;
                        }
                    }
                }
                self::addMember($list, self::methodMember($method, null));
            }
        }

        /** MemberInfo for a reflected method; $static overrides the static flag (forwarded methods). */
        private static function methodMember(\ReflectionMethod $method, $static)
        {
            $member = [
                'name' => $method->getName(),
                'kind' => 'method',
                'static' => $static === null ? $method->isStatic() : (bool) $static,
                'visibility' => self::visibility($method),
                'signature' => self::signature($method),
            ];
            $type = self::returnType($method);
            if ($type !== null) {
                $member['type'] = $type;
            }
            $doc = self::docSummary($method->getDocComment());
            if ($doc === null && $method->isDeprecated()) {
                $doc = 'Deprecated';
            }
            if ($doc !== null) {
                $member['doc'] = $doc;
            }
            $member['declaringClass'] = $method->getDeclaringClass()->getName();

            return $member;
        }

        /**
         * Eloquent local scopes: `scopeActive($query, …)` → static `active(…)`, and Laravel 12's
         * `#[Scope] protected function active(Builder $query, …)` → static `active(…)`.
         */
        private static function scopeMember(\ReflectionMethod $method)
        {
            $methodName = $method->getName();
            $scopeName = null;
            if (preg_match('/^scope([A-Z_\x80-\xff].*)$/', $methodName, $m)) {
                $scopeName = lcfirst($m[1]);
            } elseif (PHP_VERSION_ID >= 80000 && method_exists($method, 'getAttributes')) {
                foreach ($method->getAttributes() as $attribute) {
                    if (ltrim($attribute->getName(), '\\') === self::SCOPE_ATTRIBUTE) {
                        $scopeName = $methodName;
                        break;
                    }
                }
            }
            if ($scopeName === null || $scopeName === '' || $method->isStatic()) {
                return null;
            }
            $member = [
                'name' => $scopeName,
                'kind' => 'method',
                'static' => true,
                'visibility' => 'public',
                'signature' => self::signature($method, 1, self::ELOQUENT_BUILDER),
                'type' => self::ELOQUENT_BUILDER,
            ];
            $doc = self::docSummary($method->getDocComment());
            $member['doc'] = $doc !== null ? $doc : 'Local query scope';
            $member['declaringClass'] = $method->getDeclaringClass()->getName();

            return $member;
        }

        /** Facade root (the service behind the facade): its public methods are callable statically. */
        private static function addFacadeRootMembers(array &$list, $facade)
        {
            $root = call_user_func([$facade, 'getFacadeRoot']);
            if (!is_object($root)) {
                return;
            }
            $ref = new \ReflectionClass($root);
            self::addForwardedMethods($list, $ref, true);
            self::addMacros($list, $ref, true);
        }

        /**
         * Public, non-magic methods of another class presented on this one (facade root, builders, mixins).
         *
         * @param bool|null $static true = present as static, null = keep the method's own flag
         */
        private static function addForwardedMethods(array &$list, \ReflectionClass $ref, $static)
        {
            foreach ($ref->getMethods(\ReflectionMethod::IS_PUBLIC) as $method) {
                if (strpos($method->getName(), '__') === 0) {
                    continue;
                }
                self::addMember($list, self::methodMember($method, $static));
            }
        }

        /** Eloquent attribute-ish properties: driver columns, relations, accessors, casts, fillable, appends. */
        private static function addModelAttributeMembers(array &$list, \ReflectionClass $ref, $driver)
        {
            $class = $ref->getName();
            $known = null;
            if ($driver instanceof Drivers\Driver) {
                $models = $driver->models();
                if (is_array($models) || $models instanceof \Traversable) {
                    foreach ($models as $model) {
                        $model = self::normalizeModel($model);
                        if ($model !== null && strtolower($model['class']) === strtolower($class)) {
                            $known = $model;
                            break;
                        }
                    }
                }
            }
            if ($known !== null) {
                $table = isset($known['table']) ? $known['table'] : null;
                foreach ($known['columns'] as $column) {
                    $member = ['name' => $column['name'], 'kind' => 'property', 'static' => false, 'visibility' => 'public'];
                    if (isset($column['type'])) {
                        $member['type'] = $column['type'];
                    }
                    $member['doc'] = $table !== null ? 'Column of `' . $table . '`' : 'Database column';
                    $member['declaringClass'] = $class;
                    self::addMember($list, $member, true);
                }
                if (isset($known['relations'])) {
                    foreach ($known['relations'] as $relation) {
                        self::addMember($list, [
                            'name' => $relation, 'kind' => 'property', 'static' => false, 'visibility' => 'public',
                            'doc' => 'Relation', 'declaringClass' => $class,
                        ]);
                    }
                }
            }

            // Accessors: getFullNameAttribute() and (Laravel 9+) `protected function fullName(): Attribute`.
            foreach ($ref->getMethods() as $method) {
                $methodName = $method->getName();
                $property = null;
                $type = null;
                if (preg_match('/^get(.+)Attribute$/', $methodName, $m) && $method->getNumberOfRequiredParameters() <= 1) {
                    $property = self::snake($m[1]);
                    $type = self::returnType($method);
                } elseif (!$method->isStatic() && $method->hasReturnType()) {
                    $returnType = $method->getReturnType();
                    if ($returnType instanceof \ReflectionNamedType && ltrim($returnType->getName(), '\\') === self::ATTRIBUTE_CAST) {
                        $property = self::snake($methodName);
                    }
                }
                if ($property !== null && $property !== '') {
                    $member = ['name' => $property, 'kind' => 'property', 'static' => false, 'visibility' => 'public'];
                    if ($type !== null) {
                        $member['type'] = $type;
                    }
                    $member['doc'] = 'Accessor (' . $methodName . ')';
                    $member['declaringClass'] = $method->getDeclaringClass()->getName();
                    self::addMember($list, $member);
                }
            }

            foreach (self::modelAttributeTypes(self::modelInstance($ref)) as $attribute => $type) {
                $member = ['name' => $attribute, 'kind' => 'property', 'static' => false, 'visibility' => 'public'];
                if ($type !== null) {
                    $member['type'] = $type;
                }
                $member['doc'] = 'Attribute';
                $member['declaringClass'] = $class;
                self::addMember($list, $member);
            }
        }

        /**
         * Instantiate a model for side-effect-free metadata (casts, fillable, table). Booting a model only
         * registers its traits / global scopes; nothing touches the database.
         *
         * @return object|null
         */
        private static function modelInstance(\ReflectionClass $ref)
        {
            if ($ref->isAbstract() || !$ref->isInstantiable()) {
                return null;
            }
            try {
                $constructor = $ref->getConstructor();
                if ($constructor !== null && $constructor->getNumberOfRequiredParameters() > 0) {
                    return null;
                }

                return $ref->newInstance();
            } catch (\Throwable $e) {
                self::report('instantiating ' . $ref->getName(), $e);

                return null;
            }
        }

        /** @return array<string, string|null> attribute name => cast type from casts, fillable, appends, dates */
        private static function modelAttributeTypes($instance)
        {
            $out = [];
            if (!is_object($instance)) {
                return $out;
            }
            $calls = ['getCasts' => true, 'getDates' => false, 'getFillable' => false, 'getAppends' => false];
            foreach ($calls as $method => $withType) {
                if (!method_exists($instance, $method)) {
                    continue;
                }
                try {
                    $values = $instance->{$method}();
                } catch (\Throwable $e) {
                    continue;
                }
                if (!is_array($values)) {
                    continue;
                }
                foreach ($values as $key => $value) {
                    if ($withType) {
                        if (is_string($key) && $key !== '' && $key !== '*') {
                            $out[$key] = is_string($value) ? $value : (isset($out[$key]) ? $out[$key] : null);
                        }
                    } elseif (is_string($value) && $value !== '' && $value !== '*' && !array_key_exists($value, $out)) {
                        $out[$value] = $method === 'getDates' ? 'datetime' : null;
                    }
                }
            }

            return $out;
        }

        /** Runtime macros of Macroable classes (Str, Collection, Arr, …). */
        private static function addMacros(array &$list, \ReflectionClass $ref, $forceStatic)
        {
            if (!$ref->hasProperty('macros')) {
                return;
            }
            $prop = $ref->getProperty('macros');
            if (!$prop->isStatic()) {
                return;
            }
            if (PHP_VERSION_ID < 80100) {
                $prop->setAccessible(true);
            }
            $macros = $prop->getValue();
            if (!is_array($macros) || !$macros) {
                return;
            }
            // Utility classes (every public method static, e.g. Str / Arr) are used statically.
            $static = $forceStatic;
            if (!$static) {
                $static = true;
                foreach ($ref->getMethods(\ReflectionMethod::IS_PUBLIC) as $method) {
                    if (!$method->isStatic() && strpos($method->getName(), '__') !== 0) {
                        $static = false;
                        break;
                    }
                }
            }
            foreach ($macros as $macroName => $macro) {
                if (!is_string($macroName) || $macroName === '') {
                    continue;
                }
                $signature = '(...)';
                $type = null;
                try {
                    if ($macro instanceof \Closure) {
                        $fn = new \ReflectionFunction($macro);
                    } elseif (is_object($macro) && method_exists($macro, '__invoke')) {
                        $fn = new \ReflectionMethod($macro, '__invoke');
                    } else {
                        $fn = null;
                    }
                    if ($fn !== null) {
                        $signature = self::signature($fn);
                        $type = self::returnType($fn);
                    }
                } catch (\Throwable $e) {
                    // Unreflectable callable: keep the generic signature.
                }
                $member = ['name' => $macroName, 'kind' => 'method', 'static' => (bool) $static, 'visibility' => 'public', 'signature' => $signature];
                if ($type !== null) {
                    $member['type'] = $type;
                }
                $member['doc'] = 'Macro';
                $member['declaringClass'] = $ref->getName();
                self::addMember($list, $member);
            }
        }

        /** @return \ReflectionClass[] classes named by `@mixin` tags of the class chain (max 3) */
        private static function mixins(\ReflectionClass $ref)
        {
            $out = [];
            for ($class = $ref; $class; $class = $class->getParentClass()) {
                $doc = $class->getDocComment();
                if (!is_string($doc) || stripos($doc, '@mixin') === false) {
                    continue;
                }
                if (!preg_match_all('/@mixin\s+(\\\\?' . self::IDENT . '(?:\\\\' . self::IDENT . ')*)/', $doc, $m)) {
                    continue;
                }
                foreach ($m[1] as $mixin) {
                    $candidates = [ltrim($mixin, '\\')];
                    if ($mixin[0] !== '\\' && $class->getNamespaceName() !== '') {
                        array_unshift($candidates, $class->getNamespaceName() . '\\' . $mixin);
                    }
                    foreach ($candidates as $candidate) {
                        try {
                            if (self::typeExists($candidate)) {
                                $mixinRef = new \ReflectionClass($candidate);
                                if (strtolower($mixinRef->getName()) !== strtolower($ref->getName())) {
                                    $out[strtolower($mixinRef->getName())] = $mixinRef;
                                }
                                break;
                            }
                        } catch (\Throwable $e) {
                            continue;
                        }
                    }
                    if (count($out) >= 3) {
                        return array_values($out);
                    }
                }
            }

            return array_values($out);
        }

        /**
         * Add a member unless one of the same kind and name exists (methods compare case-insensitively).
         * $replace lets scopes / columns supersede an earlier entry.
         */
        private static function addMember(array &$list, array $member, $replace = false)
        {
            $kind = $member['kind'] === 'case' ? 'constant' : $member['kind'];
            $key = $kind . ':' . ($kind === 'method' ? strtolower($member['name']) : $member['name']);
            if ($replace || !isset($list[$key])) {
                $list[$key] = $member;
            }
        }

        // -----------------------------------------------------------------------------------------------------
        // Docblock tags (@method / @property / @property-read / @property-write)
        // -----------------------------------------------------------------------------------------------------

        /**
         * Parse `@method` and `@property*` tags of the class and its parents (closest class wins).
         *
         * @return array<int, array{kind:string,name:string,static:bool,type:?string,params:?string,doc:?string,declaringClass:string}>
         */
        public static function classDocTags(\ReflectionClass $ref)
        {
            $tags = [];
            $seen = [];
            for ($class = $ref; $class; $class = $class->getParentClass()) {
                foreach (self::parseDocTags($class->getDocComment()) as $tag) {
                    $key = $tag['kind'] . ':' . ($tag['kind'] === 'method' ? strtolower($tag['name']) : $tag['name']);
                    if (isset($seen[$key])) {
                        continue;
                    }
                    $seen[$key] = true;
                    $tag['declaringClass'] = $class->getName();
                    $tags[] = $tag;
                }
            }

            return $tags;
        }

        /**
         * @param string|false $doc
         * @return array list of tags (without declaringClass)
         */
        public static function parseDocTags($doc)
        {
            $tags = [];
            if (!is_string($doc) || (stripos($doc, '@method') === false && stripos($doc, '@property') === false)) {
                return $tags;
            }
            $lines = [];
            foreach (preg_split('/\R/', $doc) as $line) {
                $line = preg_replace('#^\s*/\*\*+\s?|\s*\*+/\s*$#', '', $line);
                $lines[] = trim(preg_replace('/^\s*\*\s?/', '', $line));
            }
            $count = count($lines);
            for ($i = 0; $i < $count; $i++) {
                $line = $lines[$i];
                if (!preg_match('/^@(method|property(?:-read|-write)?)\s+(.*)$/i', $line, $m)) {
                    continue;
                }
                $body = $m[2];
                // Multi-line @method signatures: join until the parentheses balance.
                while (strtolower($m[1]) === 'method' && substr_count($body, '(') > substr_count($body, ')') && $i + 1 < $count) {
                    $next = $lines[++$i];
                    if ($next !== '' && $next[0] === '@') {
                        $i--;
                        break;
                    }
                    $body .= ' ' . $next;
                }
                $tag = strtolower($m[1]) === 'method' ? self::parseMethodTag($body) : self::parsePropertyTag($body);
                if ($tag !== null) {
                    $tags[] = $tag;
                }
            }

            return $tags;
        }

        /** `@method [static] [ReturnType] name(params) [description]` */
        private static function parseMethodTag($body)
        {
            $body = trim($body);
            $static = false;
            if (preg_match('/^static\s+(.*)$/is', $body, $m)) {
                $static = true;
                $body = $m[1];
            }
            $returnType = null;
            if (!preg_match('/^' . self::IDENT . '\s*\(/', $body)) {
                list($type, $rest) = self::readType($body);
                $returnType = $type;
                $body = ltrim($rest);
            }
            if (!preg_match('/^(' . self::IDENT . ')\s*\(/', $body, $m)) {
                // `@method static foo` without parentheses is malformed but common enough: accept the name.
                if ($static && $returnType !== null && preg_match('/^' . self::IDENT . '$/', $returnType) && $body === '') {
                    return ['kind' => 'method', 'name' => $returnType, 'static' => true, 'type' => null, 'params' => '()', 'doc' => null];
                }

                return null;
            }
            $name = $m[1];
            $open = strpos($body, '(');
            $depth = 0;
            $len = strlen($body);
            $close = null;
            for ($i = $open; $i < $len; $i++) {
                if ($body[$i] === '(') {
                    $depth++;
                } elseif ($body[$i] === ')') {
                    $depth--;
                    if ($depth === 0) {
                        $close = $i;
                        break;
                    }
                }
            }
            if ($close === null) {
                $params = substr($body, $open + 1);
                $description = '';
            } else {
                $params = substr($body, $open + 1, $close - $open - 1);
                $description = trim(substr($body, $close + 1));
            }
            $params = self::normalizeType(trim(preg_replace('/\s+/', ' ', $params)));
            if ($returnType !== null) {
                $returnType = self::normalizeType($returnType);
            }

            return [
                'kind' => 'method',
                'name' => $name,
                'static' => $static,
                'type' => $returnType,
                'params' => '(' . $params . ')',
                'doc' => $description !== '' ? self::truncate($description, self::MAX_DOC) : null,
            ];
        }

        /** `@property[-read|-write] [Type] $name [description]` */
        private static function parsePropertyTag($body)
        {
            $body = trim($body);
            $type = null;
            if ($body !== '' && $body[0] !== '$') {
                list($type, $rest) = self::readType($body);
                $body = ltrim($rest);
                $type = self::normalizeType($type);
            }
            if (!preg_match('/^\$(' . self::IDENT . ')\s*(.*)$/s', $body, $m)) {
                return null;
            }
            $description = trim($m[2]);

            return [
                'kind' => 'property',
                'name' => $m[1],
                'static' => false,
                'type' => $type !== '' ? $type : null,
                'params' => null,
                'doc' => $description !== '' ? self::truncate($description, self::MAX_DOC) : null,
            ];
        }

        /** MemberInfo from a parsed docblock tag. */
        private static function tagToMember(array $tag)
        {
            $member = ['name' => $tag['name'], 'kind' => $tag['kind'], 'static' => (bool) $tag['static'], 'visibility' => 'public'];
            if ($tag['kind'] === 'method') {
                $member['signature'] = $tag['params'] . ($tag['type'] !== null ? ': ' . $tag['type'] : '');
            }
            if ($tag['type'] !== null) {
                $member['type'] = $tag['type'];
            }
            if ($tag['doc'] !== null) {
                $member['doc'] = $tag['doc'];
            }
            if (isset($tag['declaringClass'])) {
                $member['declaringClass'] = $tag['declaringClass'];
            }

            return $member;
        }

        // -----------------------------------------------------------------------------------------------------
        // Signatures & types
        // -----------------------------------------------------------------------------------------------------

        /**
         * "(int $id, array $columns = ['*']): ?static" — native types, docblock types for untyped parameters
         * and return values, by-ref, variadic and defaults.
         *
         * @param int $skip number of leading parameters to omit (scope $query)
         * @param string|null $returnOverride
         */
        public static function signature(\ReflectionFunctionAbstract $fn, $skip = 0, $returnOverride = null)
        {
            $docTypes = self::docParamTypes($fn->getDocComment());
            $params = [];
            foreach ($fn->getParameters() as $index => $param) {
                if ($index < $skip) {
                    continue;
                }
                $params[] = self::renderParameter($param, $docTypes);
            }
            $return = $returnOverride !== null ? $returnOverride : self::returnType($fn);

            return '(' . implode(', ', $params) . ')' . ($return !== null ? ': ' . $return : '');
        }

        /** Native (or tentative) return type, else the `@return` docblock type. */
        public static function returnType(\ReflectionFunctionAbstract $fn)
        {
            if ($fn->hasReturnType()) {
                return self::typeToString($fn->getReturnType());
            }
            if (PHP_VERSION_ID >= 80100 && method_exists($fn, 'hasTentativeReturnType') && $fn->hasTentativeReturnType()) {
                return self::typeToString($fn->getTentativeReturnType());
            }
            $doc = $fn->getDocComment();
            if (is_string($doc) && preg_match('/@return\s+(.+)$/m', $doc, $m)) {
                list($type) = self::readType(preg_replace('#\s*\*+/\s*$#', '', $m[1]));
                $type = self::normalizeType($type);
                if ($type !== '' && $type[0] !== '$' || $type === '$this') {
                    return $type;
                }
            }

            return null;
        }

        private static function renderParameter(\ReflectionParameter $param, array $docTypes)
        {
            $type = null;
            if ($param->hasType()) {
                $type = self::typeToString($param->getType());
            } elseif (isset($docTypes[$param->getName()])) {
                $type = $docTypes[$param->getName()];
            }
            $out = ($type !== null && $type !== '' ? $type . ' ' : '')
                . ($param->isPassedByReference() ? '&' : '')
                . ($param->isVariadic() ? '...' : '')
                . '$' . $param->getName();
            $default = self::parameterDefault($param);

            return $default !== null ? $out . ' = ' . $default : $out;
        }

        /**
         * Default value as source-like text. On PHP ≥ 8.1 `new` initializers are read from Reflection's string
         * form instead of being evaluated (evaluating would run a constructor). Optional parameters of internal
         * functions without default information (PHP 7.4) render as `= ?`.
         */
        private static function parameterDefault(\ReflectionParameter $param)
        {
            if ($param->isVariadic()) {
                return null;
            }
            try {
                if (!$param->isDefaultValueAvailable()) {
                    return $param->isOptional() ? '?' : null;
                }
                if ($param->isDefaultValueConstant()) {
                    return self::constantName($param->getDefaultValueConstantName());
                }
                if (PHP_VERSION_ID >= 80100) {
                    $expression = self::defaultExpression($param);
                    if ($expression !== null && stripos($expression, 'new ') === 0) {
                        return $expression;
                    }
                }

                return self::exportValue($param->getDefaultValue());
            } catch (\Throwable $e) {
                $expression = self::defaultExpression($param);

                return $expression !== null ? $expression : '?';
            }
        }

        /** Default expression as printed by ReflectionParameter::__toString() ("… $x = <expr> ]"). */
        private static function defaultExpression(\ReflectionParameter $param)
        {
            if (PHP_VERSION_ID < 80000) {
                return null;
            }
            $text = (string) $param;
            if (preg_match('/\s=\s(.*)\s\]$/s', $text, $m)) {
                return $m[1];
            }

            return null;
        }

        /** Unqualified constants in namespaced code are reported namespaced (Foo\PHP_INT_MAX): use the global one. */
        private static function constantName($name)
        {
            if (strpos($name, '::') === false && strpos($name, '\\') !== false && !defined($name)) {
                $short = substr($name, strrpos($name, '\\') + 1);
                if (defined($short)) {
                    return $short;
                }
            }

            return $name;
        }

        /** Render a ReflectionType without relying on ReflectionType::__toString() (deprecated on PHP 7.4). */
        public static function typeToString($type)
        {
            if ($type === null) {
                return null;
            }
            if ($type instanceof \ReflectionNamedType) {
                $name = $type->getName();

                return $type->allowsNull() && $name !== 'mixed' && $name !== 'null' ? '?' . $name : $name;
            }

            // Union / intersection / DNF types only exist on PHP ≥ 8.0, where __toString() is not deprecated.
            return (string) $type;
        }

        /** @return array<string, string> `@param` types by parameter name */
        private static function docParamTypes($doc)
        {
            $types = [];
            if (!is_string($doc) || stripos($doc, '@param') === false) {
                return $types;
            }
            if (!preg_match_all('/@param\s+(.+)$/m', $doc, $m)) {
                return $types;
            }
            foreach ($m[1] as $line) {
                $line = trim(preg_replace('#\s*\*+/\s*$#', '', $line));
                if ($line === '' || $line[0] === '$' || $line[0] === '&' || strpos($line, '...') === 0) {
                    continue;
                }
                list($type, $rest) = self::readType($line);
                if (preg_match('/^\s*&?\s*(?:\.\.\.)?\s*\$(' . self::IDENT . ')/', $rest, $pm)) {
                    $types[$pm[1]] = self::normalizeType($type);
                }
            }

            return $types;
        }

        /** `@var Type` of a property docblock. */
        private static function docVarType($doc)
        {
            if (!is_string($doc) || !preg_match('/@var\s+(.+)$/m', $doc, $m)) {
                return null;
            }
            list($type) = self::readType(preg_replace('#\s*\*+/\s*$#', '', $m[1]));
            $type = self::normalizeType($type);

            return $type !== '' && $type[0] !== '$' ? $type : null;
        }

        /**
         * Read one phpdoc type expression from the start of $text, honoring generics / shapes / callable
         * signatures that contain spaces (`array<string, int>`, `array{a: int}`, `Closure(int): void`).
         *
         * @return array{0:string,1:string} [type, rest]
         */
        private static function readType($text)
        {
            $text = ltrim((string) $text);
            $len = strlen($text);
            $depth = 0;
            $i = 0;
            for (; $i < $len; $i++) {
                $c = $text[$i];
                if ($c === '<' || $c === '(' || $c === '{' || $c === '[') {
                    $depth++;
                } elseif ($c === '>' || $c === ')' || $c === '}' || $c === ']') {
                    if ($depth > 0) {
                        $depth--;
                    }
                } elseif ($depth === 0 && ($c === ' ' || $c === "\t")) {
                    $prev = rtrim(substr($text, 0, $i));
                    $next = ltrim(substr($text, $i));
                    // `callable(int): void` — the return type follows the colon; `int | string` unions.
                    if (substr($prev, -1) === ':' || substr($prev, -1) === '|' || ($next !== '' && $next[0] === '|')) {
                        continue;
                    }
                    break;
                }
            }

            return [preg_replace('/\s+/', ' ', trim(substr($text, 0, $i))), substr($text, $i)];
        }

        /** Drop leading backslashes of fully qualified names (`\Illuminate\Support\Collection` → `Illuminate\…`). */
        private static function normalizeType($type)
        {
            return preg_replace('/(?<![A-Za-z0-9_\x80-\xff\\\\])\\\\(?=[A-Za-z_\x80-\xff])/', '', (string) $type);
        }

        // -----------------------------------------------------------------------------------------------------
        // Small public helpers (also used by other runner modules / tests)
        // -----------------------------------------------------------------------------------------------------

        /** get_debug_type() equivalent that also works on PHP 7.4. */
        public static function debugType($value)
        {
            if ($value === null) {
                return 'null';
            }
            if (is_bool($value)) {
                return 'bool';
            }
            if (is_int($value)) {
                return 'int';
            }
            if (is_float($value)) {
                return 'float';
            }
            if (is_string($value)) {
                return 'string';
            }
            if (is_array($value)) {
                return 'array';
            }
            if (is_object($value)) {
                $class = get_class($value);
                if (strpos($class, '@anonymous') === false) {
                    return $class;
                }
                $parent = get_parent_class($value);
                if ($parent) {
                    return $parent . '@anonymous';
                }
                $interfaces = class_implements($value);

                return ($interfaces ? reset($interfaces) : 'class') . '@anonymous';
            }
            if (is_resource($value)) {
                return 'resource (' . get_resource_type($value) . ')';
            }
            $type = gettype($value);

            return $type === 'resource (closed)' ? 'resource (closed)' : $type;
        }

        /** Short, source-like rendering of a value (defaults, constants). */
        public static function exportValue($value, $depth = 0)
        {
            if ($value === null) {
                return 'null';
            }
            if ($value === true) {
                return 'true';
            }
            if ($value === false) {
                return 'false';
            }
            if (is_int($value)) {
                return (string) $value;
            }
            if (is_float($value)) {
                if (is_nan($value)) {
                    return 'NAN';
                }
                if (is_infinite($value)) {
                    return $value > 0 ? 'INF' : '-INF';
                }

                return var_export($value, true);
            }
            if (is_string($value)) {
                $short = strlen($value) > 60 ? self::truncate($value, 57) : $value;
                if (preg_match('/[\x00-\x1f]/', $short)) {
                    return '"' . addcslashes($short, "\0..\37\"\\\$") . '"';
                }

                return "'" . addcslashes($short, "'\\") . "'";
            }
            if (is_array($value)) {
                if (!$value) {
                    return '[]';
                }
                if ($depth >= 2) {
                    return '[...]';
                }
                $isList = self::isList($value);
                $parts = [];
                $i = 0;
                foreach ($value as $key => $item) {
                    if (++$i > 5) {
                        $parts[] = '...';
                        break;
                    }
                    $parts[] = ($isList ? '' : self::exportValue($key) . ' => ') . self::exportValue($item, $depth + 1);
                }

                return '[' . implode(', ', $parts) . ']';
            }
            if (is_object($value)) {
                if (interface_exists('UnitEnum', false) && $value instanceof \UnitEnum) {
                    return get_class($value) . '::' . $value->name;
                }

                return 'new ' . get_class($value) . '()';
            }

            return gettype($value);
        }

        /** First summary line of a docblock (null when there is none). */
        public static function docSummary($doc)
        {
            if (!is_string($doc) || $doc === '') {
                return null;
            }
            $summary = null;
            foreach (preg_split('/\R/', $doc) as $line) {
                $line = preg_replace('#^\s*/\*\*+|\*+/\s*$#', '', $line);
                $line = trim(preg_replace('/^\s*\*+\s?/', '', $line));
                if ($line === '') {
                    continue;
                }
                if ($line[0] === '@' || stripos($line, '{@inheritdoc}') === 0) {
                    break;
                }
                $summary = $line;
                break;
            }
            if (stripos($doc, '@deprecated') !== false) {
                $summary = 'Deprecated' . ($summary !== null ? '. ' . $summary : '');
            }

            return $summary !== null ? self::truncate($summary, self::MAX_DOC) : null;
        }

        /** Truncate without splitting a UTF-8 sequence. */
        public static function truncate($text, $max)
        {
            $text = (string) $text;
            if (strlen($text) <= $max) {
                return $text;
            }
            $cut = substr($text, 0, $max);
            // Drop a trailing multi-byte sequence that the cut left incomplete.
            $len = strlen($cut);
            for ($i = 1; $i <= 4 && $i <= $len; $i++) {
                $byte = ord($cut[$len - $i]);
                if (($byte & 0xC0) === 0x80) {
                    continue;
                }
                if ($byte >= 0xC0) {
                    $need = $byte >= 0xF0 ? 4 : ($byte >= 0xE0 ? 3 : 2);
                    if ($need > $i) {
                        $cut = substr($cut, 0, $len - $i);
                    }
                }
                break;
            }

            return rtrim($cut) . '…';
        }

        // -----------------------------------------------------------------------------------------------------
        // Project / Composer helpers
        // -----------------------------------------------------------------------------------------------------

        private static function projectRoot($projectPath)
        {
            $path = is_string($projectPath) ? trim($projectPath) : '';
            if ($path === '') {
                return '';
            }
            $real = realpath($path);
            $path = $real !== false ? $real : $path;

            return $path === '/' ? $path : rtrim($path, '/\\');
        }

        /** Project root when members() is called without one: Laravel base path, cwd, Composer vendor dir. */
        private static function guessProjectRoot()
        {
            $app = self::laravelApp();
            if ($app !== null && method_exists($app, 'basePath')) {
                try {
                    $base = $app->basePath();
                    if (is_string($base) && $base !== '' && is_dir($base)) {
                        return $base;
                    }
                } catch (\Throwable $e) {
                    // Fall through to the other strategies.
                }
            }
            $cwd = getcwd();
            if (is_string($cwd) && $cwd !== '' && is_file($cwd . '/composer.json')) {
                return $cwd;
            }
            if (class_exists('Composer\Autoload\ClassLoader', false) && method_exists('Composer\Autoload\ClassLoader', 'getRegisteredLoaders')) {
                foreach (array_keys(\Composer\Autoload\ClassLoader::getRegisteredLoaders()) as $vendorDir) {
                    $root = dirname($vendorDir);
                    if (is_file($root . '/composer.json')) {
                        return $root;
                    }
                }
            }

            return '';
        }

        /** @return array decoded composer.json of the project ([] when missing / invalid) */
        private static function composerJson($root)
        {
            static $cache = [];
            if ($root === '' || !is_file($root . '/composer.json')) {
                return [];
            }
            if (isset($cache[$root])) {
                return $cache[$root];
            }
            $raw = is_readable($root . '/composer.json') ? file_get_contents($root . '/composer.json') : false;
            $data = is_string($raw) ? json_decode($raw, true) : null;

            return $cache[$root] = is_array($data) ? $data : [];
        }

        private static function vendorDir($root, array $composer)
        {
            if ($root === '') {
                return '';
            }
            $dir = isset($composer['config']['vendor-dir']) && is_string($composer['config']['vendor-dir'])
                ? $composer['config']['vendor-dir']
                : 'vendor';
            if (!self::isAbsolutePath($dir)) {
                $dir = $root . '/' . $dir;
            }
            $real = realpath($dir);

            return $real !== false ? $real : $dir;
        }

        /** @return array<string, string[]> project PSR-4 prefixes (composer.json autoload.psr-4) => absolute dirs */
        private static function projectPsr4($root, array $composer)
        {
            $map = [];
            if ($root === '' || !isset($composer['autoload']['psr-4']) || !is_array($composer['autoload']['psr-4'])) {
                return $map;
            }
            foreach ($composer['autoload']['psr-4'] as $prefix => $dirs) {
                if (!is_string($prefix)) {
                    continue;
                }
                $prefix = $prefix === '' ? '' : rtrim(ltrim($prefix, '\\'), '\\') . '\\';
                foreach ((array) $dirs as $dir) {
                    if (!is_string($dir)) {
                        continue;
                    }
                    $abs = self::isAbsolutePath($dir) ? $dir : $root . '/' . $dir;
                    $map[$prefix][] = rtrim($abs, '/\\');
                }
            }

            return $map;
        }

        /**
         * Bounded scan of the project's own PSR-4 directories (no vendor): file path → FQCN. Files are not
         * loaded; names that are not valid class names (e.g. `*.blade.php`) are skipped.
         *
         * @return string[]
         */
        private static function scanProjectClasses($root, array $psr4)
        {
            $cacheKey = $root . '|' . md5(serialize($psr4));
            if (isset(self::$scanCache[$cacheKey])) {
                return self::$scanCache[$cacheKey];
            }
            $classes = [];
            $deadline = microtime(true) + self::SCAN_BUDGET;
            $files = 0;
            $skip = ['vendor' => true, 'node_modules' => true];
            foreach ($psr4 as $prefix => $dirs) {
                foreach ($dirs as $dir) {
                    if (!is_dir($dir)) {
                        continue;
                    }
                    $base = rtrim(str_replace('\\', '/', $dir), '/') . '/';
                    try {
                        $filter = new \RecursiveCallbackFilterIterator(
                            new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS),
                            function ($file) use ($skip) {
                                $name = $file->getFilename();
                                if ($file->isDir()) {
                                    return $name[0] !== '.' && !isset($skip[$name]);
                                }

                                return substr($name, -4) === '.php';
                            }
                        );
                        $iterator = new \RecursiveIteratorIterator($filter, \RecursiveIteratorIterator::LEAVES_ONLY, \RecursiveIteratorIterator::CATCH_GET_CHILD);
                        $iterator->setMaxDepth(12);
                        foreach ($iterator as $file) {
                            if (++$files > self::MAX_SCAN_FILES || microtime(true) > $deadline) {
                                break 3;
                            }
                            $path = str_replace('\\', '/', $file->getPathname());
                            if (strpos($path, $base) !== 0) {
                                continue;
                            }
                            $class = $prefix . str_replace('/', '\\', substr($path, strlen($base), -4));
                            if (preg_match('/^' . self::IDENT . '(?:\\\\' . self::IDENT . ')*$/', $class)) {
                                $classes[] = $class;
                            }
                        }
                    } catch (\Throwable $e) {
                        // Unreadable directory: keep what was collected so far.
                        self::report('PSR-4 scan of ' . $dir, $e);
                    }
                }
            }

            return self::$scanCache[$cacheKey] = array_values(array_unique($classes));
        }

        /**
         * Classes declared in the driver's project files (Driver::files(), which skips vendor/, hidden folders and
         * the driver's ignoredFolders()) outside the PSR-4 directories already scanned: projects without Composer
         * autoloading (WordPress plugins and themes, Drupal modules, plain PHP) get their own classes in autocomplete
         * too. Files are tokenized, never loaded; bounded by SCAN_BUDGET.
         *
         * @param array<string, string[]> $psr4
         * @return string[]
         */
        private static function driverFileClasses(Drivers\Driver $driver, $projectPath, array $psr4)
        {
            $base = Drivers\Support::path((string) $projectPath);
            if ($base === '' || !is_dir($base)) {
                return [];
            }
            $scanned = [];
            foreach ($psr4 as $dirs) {
                foreach ($dirs as $dir) {
                    $real = realpath($dir);
                    $scanned[] = rtrim(str_replace('\\', '/', $real !== false ? $real : $dir), '/') . '/';
                }
            }
            $classes = [];
            try {
                $deadline = microtime(true) + self::SCAN_BUDGET;
                foreach ($driver->files($base) as $relative) {
                    if (microtime(true) > $deadline) {
                        break;
                    }
                    $file = $base . '/' . ltrim(str_replace('\\', '/', (string) $relative), '/');
                    $real = realpath($file);
                    $path = str_replace('\\', '/', $real !== false ? $real : $file);
                    foreach ($scanned as $dir) {
                        if (strpos($path, $dir) === 0) {
                            continue 2;
                        }
                    }
                    foreach (Drivers\Support::declaredClassesInFile($file, 1048576) as $class) {
                        if (!self::isHiddenClass($class)) {
                            $classes[] = $class;
                        }
                    }
                }
            } catch (\Throwable $e) {
                // A custom driver's files() failed: keep what was collected.
                self::report('driver files', $e);
            }

            return $classes;
        }

        /**
         * Composer class map: from the registered ClassLoader instances (already in memory), else from
         * vendor/composer/autoload_classmap.php of the project.
         *
         * @return array<string, string> class => file
         */
        private static function composerClassMap($vendorDir)
        {
            $map = [];
            $found = false;
            $functions = spl_autoload_functions();
            if (is_array($functions)) {
                foreach ($functions as $function) {
                    if (is_array($function) && isset($function[0]) && is_object($function[0])
                        && $function[0] instanceof \Composer\Autoload\ClassLoader) {
                        $found = true;
                        $map += $function[0]->getClassMap();
                    }
                }
            }
            if (!$found && $vendorDir !== '' && is_file($vendorDir . '/composer/autoload_classmap.php')) {
                $file = $vendorDir . '/composer/autoload_classmap.php';
                $loaded = (static function ($__file) {
                    return require $__file;
                })($file);
                if (is_array($loaded)) {
                    $map = $loaded;
                }
            }

            return $map;
        }

        private static function isProjectFile($file, $root, $vendorDir)
        {
            if ($root === '' || $file === '') {
                return false;
            }
            $file = str_replace('\\', '/', $file);
            $rootPrefix = rtrim(str_replace('\\', '/', $root), '/') . '/';
            if (strpos($file, $rootPrefix) !== 0) {
                // Composer may store paths relative through symlinks; resolve once.
                $real = realpath($file);
                if ($real === false) {
                    return false;
                }
                $file = str_replace('\\', '/', $real);
                if (strpos($file, $rootPrefix) !== 0) {
                    return false;
                }
            }
            $vendorPrefix = rtrim(str_replace('\\', '/', $vendorDir), '/') . '/';

            return $vendorDir === '' || strpos($file, $vendorPrefix) !== 0;
        }

        private static function inNamespaces($class, array $prefixes)
        {
            foreach ($prefixes as $prefix) {
                if ($prefix !== '' && strncasecmp($class, $prefix, strlen($prefix)) === 0) {
                    return true;
                }
            }

            return false;
        }

        private static function typeExists($name)
        {
            return class_exists($name) || interface_exists($name) || trait_exists($name)
                || (function_exists('enum_exists') && enum_exists($name));
        }

        private static function shortName($class)
        {
            $pos = strrpos($class, '\\');

            return $pos === false ? $class : substr($class, $pos + 1);
        }

        private static function isAbsolutePath($path)
        {
            return $path !== '' && ($path[0] === '/' || $path[0] === '\\' || preg_match('#^[A-Za-z]:[/\\\\]#', $path));
        }

        private static function isList(array $array)
        {
            $i = 0;
            foreach ($array as $key => $_) {
                if ($key !== $i++) {
                    return false;
                }
            }

            return true;
        }

        private static function snake($value)
        {
            if (class_exists('Illuminate\Support\Str', false)) {
                return \Illuminate\Support\Str::snake($value);
            }

            return strtolower(preg_replace('/(?<!^)[A-Z]/', '_$0', str_replace(' ', '', ucwords($value))));
        }

        private static function visibility($reflector)
        {
            if ($reflector->isPrivate()) {
                return 'private';
            }

            return $reflector->isProtected() ? 'protected' : 'public';
        }

        /** The Laravel application container when Laravel is booted, else null. */
        private static function laravelApp()
        {
            // The running application only: Container::getInstance() would create an empty container as a side effect.
            $app = Drivers\Laravel::runningApp();

            return $app !== null && method_exists($app, 'bound') ? $app : null;
        }

        /** Convert Arrayable / JsonSerializable / plain objects (driver value objects) to arrays. */
        private static function toArray($value)
        {
            if (!is_object($value)) {
                return $value;
            }
            if (method_exists($value, 'toArray')) {
                return $value->toArray();
            }
            if ($value instanceof \JsonSerializable) {
                return $value->jsonSerialize();
            }
            if ($value instanceof \Traversable) {
                return iterator_to_array($value);
            }

            return get_object_vars($value);
        }

        /** Run one introspection section; failures are reported and replaced by $fallback (partial > nothing). */
        private static function attempt($label, \Closure $fn, $fallback)
        {
            try {
                return $fn();
            } catch (\Throwable $e) {
                self::report($label, $e);

                return $fallback;
            }
        }

        /**
         * Report a degraded section on stderr: the main process logs stderr of data modes, and stdout must stay
         * clean for the envelope.
         */
        private static function report($label, \Throwable $e)
        {
            if (defined('STDERR') && is_resource(STDERR)) {
                fwrite(STDERR, '[tinkerbox] introspection: ' . $label . ' failed: ' . get_class($e) . ': ' . $e->getMessage() . "\n");
            }
        }
    }
}
