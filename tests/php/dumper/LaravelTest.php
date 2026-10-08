<?php
/**
 * Laravel-specific dump kinds verified against a REAL Laravel application, bootstrapped read-only in a
 * subprocess (see p2_laravel_run() in support.php: caches, compiled views, logs, sessions, mail and the database
 * are redirected to a temp dir / in-memory drivers). Skipped (with a note) when no project or PHP is available.
 */

require_once __DIR__ . '/support.php';
p2_dumper_load();

if (!function_exists('p2_laravel_results')) {
    function p2_laravel_results()
    {
        static $results = false;
        if ($results !== false) return $results;
        $code = <<<'PHP'
use Illuminate\Support\Facades\DB;

DB::enableQueryLog();
$queries = 0;
DB::listen(function () use (&$queries) { $queries++; });
$userClass = class_exists('App\Models\User') ? 'App\Models\User' : null;
$results['userClass'] = $userClass;

// Models -----------------------------------------------------------------------------------------------
$user = new $userClass(['name' => 'Ada', 'email' => 'ada@example.com']);
$results['model'] = $dump($user);
$results['modelPreview'] = $preview($user);

$saved = (new $userClass)->forceFill(['id' => 5, 'name' => 'Grace']);
$saved->exists = true;
$saved->setRelation('friends', new Illuminate\Database\Eloquent\Collection([new $userClass(['name' => 'Linus'])]));
$saved->setRelation('manager', null);
$results['modelWithRelations'] = $dump($saved);
$results['modelWithRelationsPreview'] = $preview($saved);

$trap = new class extends Illuminate\Database\Eloquent\Model {
    public static $touched = [];
    protected $table = 'trap_rows';
    protected $guarded = [];
    protected $appends = ['shout'];
    protected $casts = ['meta' => 'array'];
    public function getNameAttribute($value) { static::$touched[] = 'accessor'; return strtoupper((string) $value); }
    public function getShoutAttribute() { static::$touched[] = 'append'; return 'LOUD'; }
    public function friends() { static::$touched[] = 'relation'; return $this->hasMany(static::class); }
};
$trap->forceFill(['id' => 1, 'name' => 'quiet', 'meta' => ['a' => 1]]);
$results['trap'] = $dump($trap);
$results['trapPreview'] = $preview($trap);
$results['trapTouched'] = $trap::$touched;

// Collections --------------------------------------------------------------------------------------------
$results['collection'] = $dump(collect([1, 'two', ['three' => 3]]));
$results['collectionPreview'] = $preview(collect([1, 2, 3, 4, 5]));
$results['eloquentCollection'] = $dump(new Illuminate\Database\Eloquent\Collection([$user, $user]));
$lazyIterated = false;
$lazy = Illuminate\Support\LazyCollection::make(function () use (&$lazyIterated) { $lazyIterated = true; yield 1; });
$results['lazy'] = $dump($lazy);
$results['lazyPreview'] = $preview($lazy);
$results['lazyIterated'] = $lazyIterated;
$results['paginator'] = $dump(new Illuminate\Pagination\LengthAwarePaginator(['a', 'b', 'c'], 30, 3, 2));

// Dates & strings ------------------------------------------------------------------------------------------
$results['carbon'] = $dump(Illuminate\Support\Carbon::create(2024, 1, 2, 3, 4, 5, 'UTC'));
$results['carbonPreview'] = $preview(Illuminate\Support\Carbon::create(2024, 1, 2, 3, 4, 5, 'UTC'));
$results['now'] = $dump(now());
$results['stringable'] = $dump(Illuminate\Support\Str::of('Hello Tinkerbox'));
$results['stringablePreview'] = $preview(Illuminate\Support\Str::of('Hello Tinkerbox'));
$results['htmlString'] = $dump(new Illuminate\Support\HtmlString('<b>bold</b>'));

// Builders (no database access) -----------------------------------------------------------------------------
$results['queryBuilder'] = $dump(DB::table('users')->where('id', 1)->where('name', "O'Brien")->whereNull('deleted_at'));
$results['queryBuilderPreview'] = $preview(DB::table('users')->where('id', 1));
$eloquent = $userClass::query()->where('email', 'like', '%@example.com')->with('friends')->latest();
$results['eloquentBuilder'] = $dump($eloquent);
$results['relation'] = $dump($saved->hasMany($userClass, 'manager_id'));
$beforeCalls = 0;
$withCallback = DB::table('users')->beforeQuery(function ($q) use (&$beforeCalls) { $beforeCalls++; $q->where('tenant', 9); });
$results['beforeQuery'] = $dump($withCallback);
$results['beforeQueryCallbacksLeft'] = count((new ReflectionProperty($withCallback, 'beforeQueryCallbacks'))->getValue($withCallback));
$results['queriesRun'] = $queries + count(DB::getQueryLog());

// HTML: views, mailables, mail messages --------------------------------------------------------------------
file_put_contents($tmp . '/views/tinkerbox_dumper_test.blade.php', "<h1>Hello {{ \$name }}</h1>\n<?php echo 'echoed'; ?>");
view()->addLocation($tmp . '/views');
$results['compiledPath'] = app('blade.compiler')->getCompiledPath($tmp . '/views/tinkerbox_dumper_test.blade.php');
$results['view'] = $dump(view()->make('tinkerbox_dumper_test', ['name' => 'Tinkerbox']));
$results['viewPreview'] = $preview(view()->make('tinkerbox_dumper_test', ['name' => 'Tinkerbox']));
$results['brokenView'] = $dump(view()->file($tmp . '/views/tinkerbox_dumper_test.blade.php', []));

$mailable = new class extends Illuminate\Mail\Mailable {
    public function build()
    {
        return $this->subject('Welcome aboard')->html('<p>Hello from a mailable</p>');
    }
};
$results['mailable'] = $dump($mailable);
$results['mailableSubjectAfterDump'] = $mailable->subject;
$transport = app('mailer')->getSymfonyTransport();
$results['mailsSent'] = method_exists($transport, 'messages') ? count($transport->messages()) : -1;
$results['mailMessage'] = $dump((new Illuminate\Notifications\Messages\MailMessage)->subject('Invoice paid')->line('Thanks for your payment!')->action('View invoice', 'https://example.com/invoices/1'));

// Exceptions from user code (in-memory sqlite: the query fails because the table does not exist) -----------
$results['sqlite'] = [DB::connection()->getDriverName(), DB::connection()->getDatabaseName()];
if ($results['sqlite'] === ['sqlite', ':memory:']) {
    $userCode = "\$id = 42;\n\n" . $userClass . "::query()->findOrFail(\$id);";
    $evalFile = __FILE__ . '(' . __LINE__ . ") : eval()'d code"; try { eval($userCode); } catch (\Throwable $e) { $results['exception'] = \Tinkerbox\ExceptionFormatter::format($e, ['evalFile' => $evalFile, 'lineOffset' => 1, 'userCode' => $userCode, 'projectPath' => base_path()]); }
}

// The whole application container: bounded and fast --------------------------------------------------------
$countNodes = function ($node) use (&$countNodes) {
    $n = 1;
    foreach (isset($node['items']) ? $node['items'] : [] as $item) $n += $countNodes($item['v']);
    foreach (isset($node['props']) ? $node['props'] : [] as $prop) $n += $countNodes($prop['v']);
    return $n;
};
foreach (['default' => [], 'deep' => ['maxDepth' => 30, 'maxItems' => 1000], 'budget' => ['maxDepth' => 30, 'maxNodes' => 1000]] as $name => $limits) {
    $start = microtime(true);
    $node = $dump($app, $limits);
    $ms = (microtime(true) - $start) * 1000;
    $json = json_encode($node, JSON_PARTIAL_OUTPUT_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE | JSON_UNESCAPED_SLASHES);
    $results['app'][$name] = ['ms' => $ms, 'bytes' => strlen($json), 'nodes' => $countNodes($node), 'class' => $node['class'], 'truncated' => !empty($node['truncated']), 'json' => $json !== false];
}
$results['appPreview'] = $preview($app);
PHP;
        $results = p2_laravel_run($code);
        if ($results === null) fwrite(STDERR, "  (LaravelTest: no Laravel project with vendor/ or no compatible PHP found — Laravel kinds skipped)\n");
        return $results;
    }

    /** Run $assert($results) unless Laravel is unavailable. */
    function p2_with_laravel(callable $assert)
    {
        $results = p2_laravel_results();
        if ($results === null) return;
        $assert($results);
    }
}

return [
    'subprocess boots Laravel read-only without errors' => function () {
        p2_with_laravel(function ($r) {
            t_assert(version_compare($r['laravel'], '8.0', '>='), 'Laravel ' . $r['laravel']);
            t_assert(strpos($r['__stderr'], 'resources/php/src') === false, "no warnings/deprecations from the dumper:\n" . $r['__stderr']);
            $all = json_encode($r);
            t_assert(strpos($all, 'dumpError') === false, 'no special-case handler failed: ' . substr($all, max(0, strpos($all, 'dumpError') - 300), 600));
            t_same(['sqlite', ':memory:'], $r['sqlite']);
            t_assert(strpos($r['compiledPath'], sys_get_temp_dir()) === 0 || strpos($r['compiledPath'], realpath(sys_get_temp_dir())) === 0, 'views compile into the temp dir: ' . $r['compiledPath']);
        });
    },
    'unsaved model: attributes and meta, no summary' => function () {
        p2_with_laravel(function ($r) {
            $m = $r['model'];
            t_same('object', $m['t']);
            t_same($r['userClass'], $m['class']);
            t_same('model', $m['kind']);
            t_assert(!isset($m['summary']), 'unsaved model has no key');
            t_same('Ada', p2_prop($m, 'name', 'attribute')['v']['v']);
            t_same('ada@example.com', p2_prop($m, 'email', 'attribute')['v']['v']);
            t_same(false, p2_prop($m, 'exists', 'meta')['v']['v']);
            t_same(false, p2_prop($m, 'wasRecentlyCreated', 'meta')['v']['v']);
            t_same('users', p2_prop($m, 'table', 'meta')['v']['v']);
            t_assert(p2_has_prop($m, 'connection'));
            t_same($r['userClass'] . ' {#' . $m['id'] . '}', $r['modelPreview']);
        });
    },
    'model with key and relations' => function () {
        p2_with_laravel(function ($r) {
            $m = $r['modelWithRelations'];
            t_same('#5', $m['summary']);
            t_same('5', p2_prop($m, 'id', 'attribute')['v']['v']);
            t_same(true, p2_prop($m, 'exists', 'meta')['v']['v']);
            $friends = p2_prop($m, 'friends', 'relation')['v'];
            t_same('Illuminate\Database\Eloquent\Collection', $friends['class']);
            t_same('collection', $friends['kind']);
            t_same('Linus', p2_prop($friends['items'][0]['v'], 'name', 'attribute')['v']['v']);
            t_same(['t' => 'null'], p2_prop($m, 'manager', 'relation')['v']);
            t_same($r['userClass'] . ' {#' . $m['id'] . ' id: 5}', $r['modelWithRelationsPreview']);
        });
    },
    'accessors, appends, casts and relations are never invoked' => function () {
        p2_with_laravel(function ($r) {
            t_same([], $r['trapTouched']);
            $m = $r['trap'];
            t_same('quiet', p2_prop($m, 'name', 'attribute')['v']['v'], 'raw attribute, not the accessor');
            t_same('{"a":1}', p2_prop($m, 'meta', 'attribute')['v']['v'], 'raw (JSON-encoded) attribute, not the cast array');
            t_assert(!p2_has_prop($m, 'shout'), 'appends are not evaluated');
            t_same('#1', $m['summary']);
            t_same('trap_rows', p2_prop($m, 'table', 'meta')['v']['v']);
            t_contains(' id: 1}', $r['trapPreview']);
        });
    },
    'collections, eloquent collections, lazy collections and paginators' => function () {
        p2_with_laravel(function ($r) {
            $c = $r['collection'];
            t_same('Illuminate\Support\Collection', $c['class']);
            t_same('collection', $c['kind']);
            t_same(3, $c['count']);
            t_same('two', $c['items'][1]['v']['v']);
            t_same('three', $c['items'][2]['v']['items'][0]['k']);
            t_same('Illuminate\Support\Collection {#', substr($r['collectionPreview'], 0, 32));
            t_contains(' count: 5}', $r['collectionPreview']);
            $e = $r['eloquentCollection'];
            t_same(2, $e['count']);
            t_same('model', $e['items'][0]['v']['kind']);
            t_same('ref', $e['items'][1]['v']['t'], 'same model twice → ref');
            t_same(false, $r['lazyIterated'], 'LazyCollection must not be iterated');
            t_same('Illuminate\Support\LazyCollection', $r['lazy']['class']);
            t_assert(!isset($r['lazy']['kind']), 'LazyCollection is generic');
            $p = $r['paginator'];
            t_same('collection', $p['kind']);
            t_same(3, $p['count']);
            t_same('30', p2_prop($p, 'total', 'meta')['v']['v']);
            t_same('2', p2_prop($p, 'currentPage', 'meta')['v']['v']);
        });
    },
    'Carbon dates' => function () {
        p2_with_laravel(function ($r) {
            $c = $r['carbon'];
            t_same('Illuminate\Support\Carbon', $c['class']);
            t_same('datetime', $c['kind']);
            t_same('2024-01-02 03:04:05.000000 UTC (+00:00)', $c['summary']);
            t_same('UTC', p2_prop($c, 'timezone', 'meta')['v']['v']);
            t_same('Illuminate\Support\Carbon @2024-01-02 03:04:05', $r['carbonPreview']);
            t_same('datetime', $r['now']['kind']);
            t_same(2, count($r['now']['props']), 'Carbon internals are not dumped');
        });
    },
    'Str::of() and HtmlString are stringable' => function () {
        p2_with_laravel(function ($r) {
            $s = $r['stringable'];
            t_same('Illuminate\Support\Stringable', $s['class']);
            t_same('stringable', $s['kind']);
            t_same('Hello Tinkerbox', $s['summary']);
            t_same('Hello Tinkerbox', p2_prop($s, 'value', 'protected')['v']['v']);
            t_contains('"Hello Tinkerbox"}', $r['stringablePreview']);
            $h = $r['htmlString'];
            t_same('stringable', $h['kind']);
            t_same('<b>bold</b>', $h['summary']);
            t_same('<b>bold</b>', $h['html']);
        });
    },
    'query builder, eloquent builder and relations show SQL with bindings' => function () {
        p2_with_laravel(function ($r) {
            $q = $r['queryBuilder'];
            t_same('Illuminate\Database\Query\Builder', $q['class']);
            t_same('builder', $q['kind']);
            t_same('select * from "users" where "id" = 1 and "name" = \'O\'\'Brien\' and "deleted_at" is null', $q['summary']);
            t_same('select * from "users" where "id" = ? and "name" = ? and "deleted_at" is null', p2_prop($q, 'sql', 'meta')['v']['v']);
            t_same(2, p2_prop($q, 'bindings')['v']['count']);
            t_same('sqlite', p2_prop($q, 'connection')['v']['v']);
            t_contains('select * from "users" where "id" = 1}', $r['queryBuilderPreview']);
            $e = $r['eloquentBuilder'];
            t_same('Illuminate\Database\Eloquent\Builder', $e['class']);
            t_same('select * from "users" where "email" like \'%@example.com\' order by "created_at" desc', $e['summary']);
            t_same($r['userClass'], p2_prop($e, 'model', 'meta')['v']['v']);
            t_same('friends', p2_prop($e, 'with', 'meta')['v']['items'][0]['v']['v']);
            $rel = $r['relation'];
            t_same('builder', $rel['kind']);
            t_contains('"manager_id" = 5', $rel['summary']);
            t_same(0, $r['queriesRun'], 'building / dumping queries must not execute them');
        });
    },
    'beforeQuery callbacks run on a clone only' => function () {
        p2_with_laravel(function ($r) {
            t_same('select * from "users" where "tenant" = 9', $r['beforeQuery']['summary']);
            t_same(1, $r['beforeQueryCallbacksLeft'], 'the user\'s builder keeps its callback');
        });
    },
    'views render to html' => function () {
        p2_with_laravel(function ($r) {
            $v = $r['view'];
            t_same('Illuminate\View\View', $v['class']);
            t_same('html', $v['kind']);
            t_same('tinkerbox_dumper_test', $v['summary']);
            t_same("<h1>Hello Tinkerbox</h1>\nechoed", $v['html']);
            t_same('tinkerbox_dumper_test', p2_prop($v, 'view', 'meta')['v']['v']);
            t_same('Tinkerbox', p2_prop($v, 'data', 'meta')['v']['items'][0]['v']['v']);
            t_contains('{#', $r['viewPreview']);
            t_contains(' tinkerbox_dumper_test}', $r['viewPreview']);
            // Rendering errors keep the node generic and report the error.
            $broken = $r['brokenView'];
            t_assert(!isset($broken['kind']) || $broken['kind'] !== 'html', 'failed render is not html');
            t_contains('Undefined variable', p2_prop($broken, 'renderError', 'meta')['v']['v']);
        });
    },
    'mailables render without sending' => function () {
        p2_with_laravel(function ($r) {
            $m = $r['mailable'];
            t_same('html', $m['kind']);
            t_same('Welcome aboard', $m['summary']);
            t_same('<p>Hello from a mailable</p>', $m['html']);
            t_same(null, $r['mailableSubjectAfterDump'], 'the user\'s mailable is not mutated (a clone is rendered)');
            t_same(0, $r['mailsSent']);
            $mm = $r['mailMessage'];
            t_same('Illuminate\Notifications\Messages\MailMessage', $mm['class']);
            t_same('html', $mm['kind']);
            t_same('Invoice paid', $mm['summary']);
            t_contains('Thanks for your payment!', $mm['html']);
            t_contains('https://example.com/invoices/1', $mm['html']);
            t_same('Invoice paid', p2_prop($mm, 'subject', 'public')['v']['v']);
        });
    },
    'exceptions from user code in a Laravel app' => function () {
        p2_with_laravel(function ($r) {
            $e = $r['exception'];
            t_same('Illuminate\Database\QueryException', $e['class']);
            t_contains('no such table: users', $e['message']);
            t_same(0, strpos($e['file'], 'vendor/laravel/framework/src/Illuminate/Database/'), 'relative vendor path: ' . $e['file']);
            t_same(3, $e['userLine']);
            $user = array_values(array_filter($e['trace'], function ($f) { return !empty($f['userCode']); }));
            t_same(3, $user[0]['line']);
            t_assert(!isset($user[0]['file']));
            $vendor = array_filter($e['trace'], function ($f) { return !empty($f['vendor']); });
            t_assert(count($vendor) >= 3, 'vendor frames are flagged');
            t_same(['startLine' => 1, 'line' => 3, 'lines' => ['$id = 42;', '', $r['userClass'] . '::query()->findOrFail($id);']], $e['snippet']);
            t_same('PDOException', $e['previous']['class']);
        });
    },
    'dumping the whole application container is fast and bounded' => function () {
        p2_with_laravel(function ($r) {
            foreach ($r['app'] as $name => $stats) {
                t_same(true, $stats['json'], $name);
                t_assert($stats['ms'] < 300, $name . ': ' . round($stats['ms']) . ' ms');
                t_assert($stats['nodes'] <= Tinkerbox\Dumper::DEFAULT_MAX_NODES + 50, $name . ': ' . $stats['nodes'] . ' nodes');
                t_assert($stats['bytes'] < 8 * 1024 * 1024, $name . ': ' . $stats['bytes'] . ' bytes');
                t_contains('Application', $stats['class']);
            }
            t_same(true, $r['app']['budget']['truncated'], 'a small node budget truncates the container dump');
            t_assert($r['app']['budget']['nodes'] <= 1000 + 50, 'budget respected: ' . $r['app']['budget']['nodes']);
            t_contains('Application {#', $r['appPreview']);
        });
    },
];
