<?php

namespace Tinkerbox {
    /**
     * Structured, side-effect-free value dumper (docs/ARCHITECTURE.md §1.6).
     *
     * `Dumper::dump($value, $limits)` turns any PHP value into a JSON-serializable `DumpNode` tree
     * (src/shared/types.ts) that the renderer shows VarDumper-style; `Dumper::preview($value)` produces the
     * one-line form used for magic-comment badges and history previews.
     *
     * Rules:
     *  - Object properties are read from the raw property table (`get_mangled_object_vars`), never through
     *    getters, `__get` or property hooks. The only user-level methods ever called are the documented ones,
     *    each guarded with try/catch: `__debugInfo()`, Eloquent `getAttributes()` / `getRelations()` /
     *    `getKeyName()` / `getTable()` / `getConnectionName()`, `Collection::all()`, paginator getters,
     *    builder `toSql()` / `getBindings()` (on a clone), DateTime `format()`, View / Mailable (on a clone) /
     *    MailMessage `render()`, `Htmlable::toHtml()` and `__toString()`.
     *  - Generators, LazyCollections and unknown Traversables are never iterated.
     *  - Output is bounded: depth (`maxDepth`), items per container (`maxItems`), characters per string
     *    (`maxStringLength`), a global node budget (`maxNodes`, default 20 000) and global byte budgets for
     *    strings and rendered HTML, so dumping e.g. the whole Laravel container stays fast and small.
     *
     * Strings: valid UTF-8 strings are measured and truncated in characters (`len` = character count);
     * binary strings in bytes (`len` = byte count) and their value becomes a `\xNN`-escaped preview.
     */
    final class Dumper
    {
        const DEFAULT_MAX_DEPTH = 8;
        const DEFAULT_MAX_ITEMS = 500;
        const DEFAULT_MAX_STRING_LENGTH = 10000;
        /** Nodes per dump; containers stop expanding (and are marked `truncated`) once it is spent. */
        const DEFAULT_MAX_NODES = 20000;
        /** Bytes of string content per dump; once spent, later strings are cut to MIN_STRING_LENGTH. */
        const DEFAULT_MAX_STRING_BYTES = 8388608;
        const MIN_STRING_LENGTH = 64;
        /** Rendered HTML (Views, Mailables, Htmlables): per node, per dump, and number of renders per dump. */
        const MAX_HTML_BYTES = 2097152;
        const MAX_HTML_TOTAL_BYTES = 6291456;
        const MAX_HTML_RENDERS = 10;
        /** Source files larger than this are not read for closure signature detection. */
        const MAX_SOURCE_FILE_BYTES = 2097152;

        /**
         * Run context set by the runner (see setContext()).
         * @var array{evalFile: string, lineOffset: int, evalCode: string}
         */
        private static $context = ['evalFile' => '', 'lineOffset' => 1, 'evalCode' => ''];

        /** @var array<string, array<string, bool>> raw class name => declared public non-static property names */
        private static $publicProps = [];

        /** @var array<string, string[]|null> file => source lines (closure keyword detection) */
        private static $sources = [];

        /** @var array<string, \ReflectionClass> */
        private static $reflections = [];

        private $maxDepth;
        private $maxItems;
        private $maxStringLength;
        private $maxNodes;
        /** Remaining string-content bytes. */
        private $stringBytes;
        /** Remaining rendered-HTML bytes. */
        private $htmlBytes = self::MAX_HTML_TOTAL_BYTES;
        private $htmlRenders = 0;
        private $nodes = 0;
        /** @var array<int, bool> spl_object_id => already expanded in this dump */
        private $seen = [];
        /** @var object[] Keeps every visited object alive so object ids cannot be reused during the dump. */
        private $keep = [];

        /**
         * Optional run context so closures defined in the editor code report editor lines (and `fn` vs
         * `function` can be detected from the evaluated source):
         *   evalFile   — exact file name PHP reports for the eval()'d user code
         *   lineOffset — editor line of the first evaluated line (selection runs), default 1
         *   evalCode   — the evaluated code (same line layout as the editor code)
         */
        public static function setContext(array $context)
        {
            self::$context = [
                'evalFile' => isset($context['evalFile']) ? (string) $context['evalFile'] : '',
                'lineOffset' => isset($context['lineOffset']) && is_numeric($context['lineOffset']) ? max(1, (int) $context['lineOffset']) : 1,
                'evalCode' => isset($context['evalCode']) ? (string) $context['evalCode'] : '',
            ];
            self::$sources = [];
        }

        /**
         * Dump any value into a DumpNode array.
         *
         * @param mixed $value
         * @param array $limits maxDepth, maxItems, maxStringLength (+ optional maxNodes, maxStringBytes)
         * @return array DumpNode
         */
        public static function dump($value, array $limits = [])
        {
            $dumper = new self($limits);
            try {
                return $dumper->node($value, 0);
            } catch (\Throwable $e) {
                // Last line of defence: a dump must never break the run envelope.
                return self::failureNode($value, $e);
            }
        }

        /**
         * VarDumper-flavored one-line preview, never longer than $max characters (cut with "…").
         *
         * @param mixed $value
         * @param int $max
         * @return string
         */
        public static function preview($value, $max = 120)
        {
            $max = is_numeric($max) && (int) $max > 0 ? (int) $max : 120;
            try {
                $text = self::previewValue($value, $max, 0);
            } catch (\Throwable $e) {
                $text = is_object($value) ? self::className($value) . ' {#' . spl_object_id($value) . '}' : gettype($value);
            }
            return self::cut($text, $max);
        }

        private function __construct(array $limits)
        {
            $this->maxDepth = self::limit($limits, 'maxDepth', self::DEFAULT_MAX_DEPTH);
            $this->maxItems = self::limit($limits, 'maxItems', self::DEFAULT_MAX_ITEMS);
            $this->maxStringLength = self::limit($limits, 'maxStringLength', self::DEFAULT_MAX_STRING_LENGTH);
            $this->maxNodes = self::limit($limits, 'maxNodes', self::DEFAULT_MAX_NODES);
            $this->stringBytes = self::limit($limits, 'maxStringBytes', self::DEFAULT_MAX_STRING_BYTES);
        }

        /** Positive integer limit from the (JSON-decoded) limits array, else the default. */
        private static function limit(array $limits, $key, $default)
        {
            if (!isset($limits[$key])) return $default;
            $value = $limits[$key];
            if (is_int($value)) return $value >= 1 ? $value : $default;
            if (is_float($value) && is_finite($value) && $value >= 1 && $value < 1e15) return (int) $value;
            if (is_string($value) && preg_match('/^\d{1,15}$/', $value) && (int) $value >= 1) return (int) $value;
            return $default;
        }

        // -----------------------------------------------------------------------------------------------
        // Nodes
        // -----------------------------------------------------------------------------------------------

        /** @return array DumpNode */
        private function node($value, $depth)
        {
            $this->nodes++;
            if ($value === null) return ['t' => 'null'];
            if (is_bool($value)) return ['t' => 'bool', 'v' => $value];
            if (is_int($value)) return ['t' => 'int', 'v' => (string) $value];
            if (is_float($value)) return ['t' => 'float', 'v' => self::formatFloat($value)];
            if (is_string($value)) return $this->stringNode($value);
            if (is_array($value)) return $this->arrayNode($value, $depth);
            if (is_object($value)) return $this->objectNode($value, $depth);
            return self::resourceNode($value);
        }

        /** Whether a container that already holds $count children must stop adding more. */
        private function full($count)
        {
            return $count >= $this->maxItems || $this->nodes >= $this->maxNodes;
        }

        private function stringNode($string)
        {
            $bytes = strlen($string);
            $limit = $this->maxStringLength;
            if ($this->stringBytes < $limit) $limit = max($this->stringBytes, min(self::MIN_STRING_LENGTH, $limit));

            if ($bytes > 0 && !self::isUtf8($string)) {
                $cut = $bytes > $limit;
                $part = $cut ? substr($string, 0, $limit) : $string;
                $this->stringBytes -= strlen($part);
                $node = ['t' => 'string', 'v' => self::escapeBinary($part), 'len' => $bytes, 'binary' => true];
                if ($cut) $node['truncated'] = true;
                return $node;
            }

            // Character count <= byte count, so short strings never need the (O(n)) character count for the cut.
            $length = $bytes <= 1 ? $bytes : self::utf8Length($string);
            if ($length > $limit) {
                $part = self::utf8Prefix($string, $limit);
                $this->stringBytes -= strlen($part);
                return ['t' => 'string', 'v' => $part, 'len' => $length, 'truncated' => true];
            }
            $this->stringBytes -= $bytes;
            return ['t' => 'string', 'v' => $string, 'len' => $length];
        }

        private function arrayNode(array $array, $depth)
        {
            $count = count($array);
            if ($count > 0 && $depth >= $this->maxDepth) return ['t' => 'max-depth', 'type' => 'array', 'count' => $count];
            $truncated = false;
            $node = ['t' => 'array', 'count' => $count, 'items' => $this->items($array, $depth, $truncated)];
            if ($truncated) $node['truncated'] = true;
            return $node;
        }

        /** @return array DumpItem[] for the first maxItems entries (within the node budget). */
        private function items(array $array, $depth, &$truncated)
        {
            $items = [];
            $n = 0;
            foreach ($array as $key => $value) {
                if ($this->full($n)) {
                    $truncated = true;
                    break;
                }
                $items[] = ['k' => is_int($key) ? $key : self::text((string) $key), 'v' => $this->node($value, $depth + 1)];
                $n++;
            }
            return $items;
        }

        private static function resourceNode($resource)
        {
            $open = is_resource($resource);
            return ['t' => 'resource', 'type' => $open ? get_resource_type($resource) : 'closed', 'id' => (int) $resource];
        }

        private function objectNode($object, $depth)
        {
            $class = self::className($object);
            $id = spl_object_id($object);

            if (self::isUninitializedLazy($object)) {
                // PHP 8.4 lazy ghosts / proxies: reading the property table would initialize them.
                return ['t' => 'object', 'class' => $class, 'id' => $id, 'summary' => 'lazy object (uninitialized)', 'props' => []];
            }
            if ($object instanceof \UnitEnum) {
                $node = ['t' => 'enum', 'class' => $class, 'case' => (string) $object->name];
                if ($object instanceof \BackedEnum) $node['value'] = $object->value;
                return $node;
            }
            if ($object instanceof \Closure) return $this->closureNode($object);

            if (isset($this->seen[$id])) return ['t' => 'ref', 'class' => $class, 'id' => $id];
            if ($depth >= $this->maxDepth) {
                $node = ['t' => 'max-depth', 'type' => 'object', 'class' => $class];
                $count = self::knownCount($object);
                if ($count !== null) $node['count'] = $count;
                return $node;
            }
            $this->seen[$id] = true;
            $this->keep[] = $object;

            $node = ['t' => 'object', 'class' => $class, 'id' => $id];
            try {
                return $this->expand($object, $node, $depth);
            } catch (\Throwable $e) {
                // A special-case handler failed (e.g. a broken accessor or renderer): fall back to the raw properties.
                try {
                    $node = $this->genericNode($object, $node, $depth);
                } catch (\Throwable $inner) {
                    $node['props'] = [];
                }
                $node['props'][] = $this->meta('dumpError', self::className($e) . ': ' . $e->getMessage(), $depth);
                return $node;
            }
        }

        /** Element count of collection-like objects that can be counted without running user code. */
        private static function knownCount($object)
        {
            try {
                if ($object instanceof \Illuminate\Support\Collection) {
                    $all = $object->all();
                    return is_array($all) ? count($all) : null;
                }
                if ($object instanceof \ArrayObject || $object instanceof \ArrayIterator) return count($object->getArrayCopy());
            } catch (\Throwable $e) {
                return null; // count is only a hint on max-depth nodes
            }
            return null;
        }

        /** Route an object to its special-case handler (docs/ARCHITECTURE.md §1.6), else the generic one. */
        private function expand($o, array $node, $depth)
        {
            // Any method call (even method_exists) on an incomplete object throws.
            if ($o instanceof \__PHP_Incomplete_Class) return $this->genericNode($o, $node, $depth);
            if ($o instanceof \Throwable) return $this->exceptionNode($o, $node, $depth);
            if ($o instanceof \Illuminate\Database\Eloquent\Model) return $this->modelNode($o, $node, $depth);
            if ($o instanceof \Illuminate\Support\Collection) {
                // LazyCollection is not a Collection: it falls through to the generic handler and is never iterated.
                $all = $o->all();
                return $this->collectionNode(is_array($all) ? $all : [], $node, $depth, []);
            }
            if ($o instanceof \Illuminate\Pagination\AbstractPaginator || $o instanceof \Illuminate\Pagination\AbstractCursorPaginator) {
                return $this->paginatorNode($o, $node, $depth);
            }
            if ($o instanceof \Illuminate\Database\Eloquent\Builder || $o instanceof \Illuminate\Database\Query\Builder
                || $o instanceof \Illuminate\Database\Eloquent\Relations\Relation) {
                return $this->builderNode($o, $node, $depth);
            }
            if ($o instanceof \DateTimeInterface) return $this->dateTimeNode($o, $node, $depth);
            if ($o instanceof \DateTimeZone) {
                $node['kind'] = 'stringable';
                $node['summary'] = $o->getName();
                $node['props'] = [];
                return $node;
            }
            if ($o instanceof \DateInterval) {
                $node = $this->genericNode($o, $node, $depth);
                $node['kind'] = 'stringable';
                $node['summary'] = self::intervalText($o);
                return $node;
            }
            if ($o instanceof \Illuminate\Support\HtmlString) {
                $node = $this->genericNode($o, $node, $depth);
                $html = (string) $o->toHtml();
                $node['kind'] = 'stringable';
                $node['summary'] = $this->summaryText($html);
                if (strlen($html) <= self::MAX_HTML_BYTES && strlen($html) <= $this->htmlBytes) {
                    $this->htmlBytes -= strlen($html);
                    $node['html'] = $html;
                }
                return $node;
            }
            if ($o instanceof \Illuminate\Contracts\View\View) return $this->viewNode($o, $node, $depth);
            if ($o instanceof \Illuminate\Mail\Mailable) return $this->mailableNode($o, $node, $depth);
            if ($o instanceof \Illuminate\Notifications\Messages\MailMessage) return $this->mailMessageNode($o, $node, $depth);
            if ($o instanceof \Illuminate\Contracts\Support\Htmlable) {
                $node = $this->genericNode($o, $node, $depth);
                return $this->withHtml($node, function () use ($o) {
                    return $o->toHtml();
                }, self::shortClass($node['class']), $depth);
            }
            if ($o instanceof \ArrayObject || $o instanceof \ArrayIterator) {
                $props = $this->genericNode($o, $node, $depth)['props'];
                return $this->collectionNode($o->getArrayCopy(), $node, $depth, $props);
            }
            if ($o instanceof \SplObjectStorage) return $this->objectStorageNode($o, $node, $depth);
            if ($o instanceof \SplDoublyLinkedList || $o instanceof \SplHeap || $o instanceof \SplPriorityQueue) {
                return $this->splIterableNode($o, $node, $depth);
            }
            if ($o instanceof \SplFixedArray) return $this->collectionNode($o->toArray(), $node, $depth, []);
            if ($o instanceof \SplFileInfo) {
                // SplFileObject::__toString() reads a line: only the path is used.
                $node = $this->genericNode($o, $node, $depth);
                $node['kind'] = 'stringable';
                $node['summary'] = $this->summaryText($o->getPathname());
                return $node;
            }
            if ($o instanceof \GMP && function_exists('gmp_strval')) {
                $node['kind'] = 'stringable';
                $node['summary'] = gmp_strval($o);
                $node['props'] = [];
                return $node;
            }
            if ($o instanceof \Generator) return $this->generatorNode($o, $node, $depth);
            if (self::isStringable($o)) {
                $node = $this->genericNode($o, $node, $depth);
                $node['kind'] = 'stringable';
                $node['summary'] = $this->summaryText((string) $o->__toString());
                return $node;
            }
            return $this->genericNode($o, $node, $depth);
        }

        private function genericNode($o, array $node, $depth)
        {
            $truncated = false;
            $node['props'] = $this->props($o, $depth, $truncated);
            if ($truncated) $node['truncated'] = true;
            return $node;
        }

        /**
         * Decode the object's properties: `__debugInfo()` when defined (like var_dump / VarDumper), else the
         * raw property table, where "\0Class\0name" is private (declared by Class) and "\0*\0name" protected.
         *
         * @return array DumpProperty[]
         */
        private function props($o, $depth, &$truncated)
        {
            $raw = get_class($o);
            $vars = null;
            $fromDebugInfo = false;
            $incomplete = $o instanceof \__PHP_Incomplete_Class;
            if (!$incomplete && method_exists($o, '__debugInfo')) {
                try {
                    $info = $o->__debugInfo();
                    if (is_array($info)) {
                        $vars = $info;
                        $fromDebugInfo = true;
                    }
                } catch (\Throwable $e) {
                    $vars = null; // a throwing __debugInfo() falls back to the real property table
                }
            }
            if ($vars === null) $vars = get_mangled_object_vars($o);
            $public = $fromDebugInfo ? [] : self::publicProperties($o, $raw);

            $props = [];
            $n = 0;
            foreach ($vars as $key => $value) {
                $key = (string) $key;
                if ($incomplete && $key === '__PHP_Incomplete_Class_Name') continue;
                if ($this->full($n)) {
                    $truncated = true;
                    break;
                }
                $prop = self::decodeKey($key, $raw, $fromDebugInfo, $public);
                $prop['v'] = $this->node($value, $depth + 1);
                $props[] = $prop;
                $n++;
            }
            return $props;
        }

        /** @return array DumpProperty without `v` */
        private static function decodeKey($key, $rawClass, $fromDebugInfo, array $public)
        {
            if ($key !== '' && $key[0] === "\0") {
                // Anonymous class names contain "\0" themselves, so the property name follows the LAST "\0".
                $pos = strrpos($key, "\0");
                if ($pos > 0) {
                    $owner = substr($key, 1, $pos - 1);
                    $name = self::text((string) substr($key, $pos + 1));
                    if ($owner === '*') return ['name' => $name, 'vis' => 'protected'];
                    $prop = ['name' => $name, 'vis' => 'private'];
                    if ($owner !== $rawClass) $prop['declaringClass'] = self::cleanClass($owner);
                    return $prop;
                }
                $key = (string) substr($key, 1);
            }
            if ($fromDebugInfo) return ['name' => self::text($key), 'vis' => 'public'];
            return ['name' => self::text($key), 'vis' => isset($public[$key]) ? 'public' : 'dynamic'];
        }

        /** Declared public, non-static property names (cached per class) to tell them from dynamic ones. */
        private static function publicProperties($o, $rawClass)
        {
            if (isset(self::$publicProps[$rawClass])) return self::$publicProps[$rawClass];
            $names = [];
            try {
                foreach (self::reflection($o)->getProperties(\ReflectionProperty::IS_PUBLIC) as $property) {
                    if (!$property->isStatic()) $names[$property->getName()] = true;
                }
            } catch (\Throwable $e) {
                $names = []; // unreflectable class: every public property is then reported as dynamic
            }
            return self::$publicProps[$rawClass] = $names;
        }

        private static function reflection($o)
        {
            $raw = get_class($o);
            if (!isset(self::$reflections[$raw])) self::$reflections[$raw] = new \ReflectionClass($o);
            return self::$reflections[$raw];
        }

        private static function isUninitializedLazy($o)
        {
            if (PHP_VERSION_ID < 80400) return false;
            try {
                return self::reflection($o)->isUninitializedLazyObject($o);
            } catch (\Throwable $e) {
                return false;
            }
        }

        /** @return array DumpProperty with vis 'meta' */
        private function meta($name, $value, $depth)
        {
            return ['name' => $name, 'vis' => 'meta', 'v' => $this->node($value, $depth + 1)];
        }

        /** Truncate a summary to the string limit; binary content is escaped. */
        private function summaryText($text)
        {
            $text = (string) $text;
            if ($text !== '' && !self::isUtf8($text)) {
                if (strlen($text) <= $this->maxStringLength) return self::escapeBinary($text);
                return self::escapeBinary(substr($text, 0, $this->maxStringLength)) . '…';
            }
            if (strlen($text) > $this->maxStringLength && self::utf8Length($text) > $this->maxStringLength) {
                return self::utf8Prefix($text, $this->maxStringLength) . '…';
            }
            return $text;
        }

        // ------------------------------------------------------------------ special kinds

        private function exceptionNode(\Throwable $e, array $node, $depth)
        {
            $node['kind'] = 'exception';
            $node['summary'] = $this->summaryText($e->getMessage());
            $props = [
                ['name' => 'message', 'vis' => 'protected', 'v' => $this->node($e->getMessage(), $depth + 1)],
                ['name' => 'code', 'vis' => 'protected', 'v' => $this->node($e->getCode(), $depth + 1)],
                ['name' => 'file', 'vis' => 'protected', 'v' => $this->node($e->getFile(), $depth + 1)],
                ['name' => 'line', 'vis' => 'protected', 'v' => $this->node($e->getLine(), $depth + 1)],
            ];
            $base = $e instanceof \Exception ? 'Exception' : 'Error';
            $previous = $e->getPrevious();
            if ($previous !== null) {
                $prop = ['name' => 'previous', 'vis' => 'private', 'v' => $this->node($previous, $depth + 1)];
                if (get_class($e) !== $base) $prop['declaringClass'] = $base;
                $props[] = $prop;
            }

            // Subclass properties (QueryException::$sql, ValidationException::$validator, …).
            $standard = ["\0*\0message" => 1, "\0*\0code" => 1, "\0*\0file" => 1, "\0*\0line" => 1];
            $raw = get_class($e);
            $public = self::publicProperties($e, $raw);
            $truncated = false;
            $n = 0;
            foreach (get_mangled_object_vars($e) as $key => $value) {
                $key = (string) $key;
                if (isset($standard[$key]) || strpos($key, "\0Exception\0") === 0 || strpos($key, "\0Error\0") === 0) continue;
                if ($this->full($n)) {
                    $truncated = true;
                    break;
                }
                $prop = self::decodeKey($key, $raw, false, $public);
                $prop['v'] = $this->node($value, $depth + 1);
                $props[] = $prop;
                $n++;
            }
            $node['props'] = $props;
            if ($truncated) $node['truncated'] = true;
            return $node;
        }

        private function modelNode($model, array $node, $depth)
        {
            // Raw attributes only: getAttribute()/accessors/casts/lazy loading are never touched.
            $attributes = $model->getAttributes();
            $relations = $model->getRelations();
            $attributes = is_array($attributes) ? $attributes : [];
            $relations = is_array($relations) ? $relations : [];
            $vars = get_mangled_object_vars($model);

            $props = [];
            $truncated = false;
            $n = 0;
            foreach ($attributes as $name => $value) {
                if ($this->full($n)) {
                    $truncated = true;
                    break;
                }
                $props[] = ['name' => self::text((string) $name), 'vis' => 'attribute', 'v' => $this->node($value, $depth + 1)];
                $n++;
            }
            $n = 0;
            foreach ($relations as $name => $value) {
                if ($this->full($n)) {
                    $truncated = true;
                    break;
                }
                $props[] = ['name' => self::text((string) $name), 'vis' => 'relation', 'v' => $this->node($value, $depth + 1)];
                $n++;
            }
            $props[] = $this->meta('exists', array_key_exists('exists', $vars) ? $vars['exists'] : null, $depth);
            $props[] = $this->meta('wasRecentlyCreated', array_key_exists('wasRecentlyCreated', $vars) ? $vars['wasRecentlyCreated'] : null, $depth);
            $props[] = $this->meta('connection', self::attempt(function () use ($model) {
                return $model->getConnectionName();
            }), $depth);
            $props[] = $this->meta('table', self::attempt(function () use ($model) {
                return $model->getTable();
            }), $depth);

            $node['kind'] = 'model';
            $key = self::modelKey($model, $attributes);
            if ($key !== null) $node['summary'] = '#' . $key[1];
            $node['props'] = $props;
            if ($truncated) $node['truncated'] = true;
            return $node;
        }

        /**
         * Primary key name and value (as text) read from the raw attributes, or null when unset / non-scalar.
         * @return array{0: string, 1: string}|null
         */
        private static function modelKey($model, ?array $attributes = null)
        {
            try {
                $name = $model->getKeyName();
                if ($attributes === null) $attributes = $model->getAttributes();
                if (!is_string($name) || !is_array($attributes) || !array_key_exists($name, $attributes)) return null;
                $value = $attributes[$name];
                if (is_int($value) || is_string($value)) return [$name, self::clip((string) $value, 60)];
                if (is_float($value)) return [$name, self::formatFloat($value)];
            } catch (\Throwable $e) {
                return null; // summary is optional
            }
            return null;
        }

        private function collectionNode(array $items, array $node, $depth, array $props)
        {
            $truncated = false;
            $node['kind'] = 'collection';
            $node['count'] = count($items);
            $node['items'] = $this->items($items, $depth, $truncated);
            $node['props'] = $props;
            if ($truncated) $node['truncated'] = true;
            return $node;
        }

        private function paginatorNode($paginator, array $node, $depth)
        {
            $items = $paginator->items();
            $props = [];
            foreach (['currentPage', 'perPage', 'total', 'lastPage'] as $method) {
                if (method_exists($paginator, $method)) {
                    $props[] = $this->meta($method, self::attempt(function () use ($paginator, $method) {
                        return $paginator->{$method}();
                    }), $depth);
                }
            }
            return $this->collectionNode(is_array($items) ? $items : [], $node, $depth, $props);
        }

        private function builderNode($builder, array $node, $depth)
        {
            $info = self::builderInfo($builder);
            $node['kind'] = 'builder';
            $node['summary'] = $this->summaryText($info['raw']);
            $props = [
                $this->meta('sql', $info['sql'], $depth),
                $this->meta('bindings', $info['bindings'], $depth),
            ];
            if ($info['connection'] !== null) $props[] = $this->meta('connection', $info['connection'], $depth);
            if ($info['model'] !== null) $props[] = $this->meta('model', $info['model'], $depth);
            if ($info['eager']) $props[] = $this->meta('with', $info['eager'], $depth);
            $node['props'] = $props;
            return $node;
        }

        /**
         * SQL, bindings and interpolated SQL of an Eloquent / query builder or relation. Works on a clone so
         * "before query" callbacks are not consumed on the user's builder; never touches the database.
         *
         * @return array{sql: string, bindings: array, raw: string, connection: ?string, model: ?string, eager: string[]}
         */
        private static function builderInfo($builder)
        {
            $model = null;
            $eager = [];
            if ($builder instanceof \Illuminate\Database\Eloquent\Relations\Relation) $builder = $builder->getQuery();
            if ($builder instanceof \Illuminate\Database\Eloquent\Builder) {
                $copy = clone $builder;
                $instance = $copy->getModel();
                if (is_object($instance)) $model = self::className($instance);
                $loads = $copy->getEagerLoads();
                if (is_array($loads)) $eager = array_map('strval', array_keys($loads));
                $base = $copy->toBase();
            } else {
                $base = clone $builder;
            }
            $sql = (string) $base->toSql();
            $bindings = $base->getBindings();
            $bindings = is_array($bindings) ? array_values($bindings) : [];
            $connection = null;
            try {
                $conn = $base->getConnection();
                if (is_object($conn) && method_exists($conn, 'getName')) {
                    $name = $conn->getName();
                    if (is_string($name)) $connection = $name;
                }
            } catch (\Throwable $e) {
                $connection = null; // connection name is informational only
            }
            return ['sql' => $sql, 'bindings' => $bindings, 'raw' => self::interpolateSql($sql, $bindings), 'connection' => $connection, 'model' => $model, 'eager' => $eager];
        }

        /**
         * Substitute `?` placeholders outside of quoted strings / identifiers; `??` is an escaped literal `?`
         * (PostgreSQL JSON operators). Extra placeholders without bindings are kept.
         */
        public static function interpolateSql($sql, array $bindings)
        {
            $sql = (string) $sql;
            $bindings = array_values($bindings);
            $out = '';
            $quote = null;
            $next = 0;
            $length = strlen($sql);
            for ($i = 0; $i < $length; $i++) {
                $char = $sql[$i];
                $following = $i + 1 < $length ? $sql[$i + 1] : '';
                if ($quote !== null) {
                    $out .= $char;
                    if ($char === '\\' && $quote !== '`' && $following !== '') {
                        $out .= $following;
                        $i++;
                    } elseif ($char === $quote) {
                        if ($following === $quote) {
                            $out .= $following;
                            $i++;
                        } else {
                            $quote = null;
                        }
                    }
                    continue;
                }
                if ($char === "'" || $char === '"' || $char === '`') {
                    $quote = $char;
                    $out .= $char;
                    continue;
                }
                if ($char === '?') {
                    if ($following === '?') {
                        $out .= '?';
                        $i++;
                        continue;
                    }
                    if ($next < count($bindings)) {
                        $out .= self::sqlValue($bindings[$next++]);
                        continue;
                    }
                }
                $out .= $char;
            }
            return $out;
        }

        /** SQL literal for a binding value (display only). */
        private static function sqlValue($value)
        {
            if ($value === null) return 'NULL';
            if (is_bool($value)) return $value ? '1' : '0';
            if (is_int($value)) return (string) $value;
            if (is_float($value)) return self::formatFloat($value);
            if (is_string($value)) {
                if (!self::isUtf8($value)) return "x'" . bin2hex($value) . "'";
                return "'" . str_replace("'", "''", $value) . "'";
            }
            if ($value instanceof \DateTimeInterface) return "'" . $value->format('Y-m-d H:i:s') . "'";
            if ($value instanceof \BackedEnum) return self::sqlValue($value->value);
            if ($value instanceof \UnitEnum) return "'" . $value->name . "'";
            if (is_object($value) && self::isStringable($value)) {
                try {
                    return self::sqlValue((string) $value->__toString());
                } catch (\Throwable $e) {
                    return '?';
                }
            }
            return '?';
        }

        private function dateTimeNode(\DateTimeInterface $date, array $node, $depth)
        {
            $node['kind'] = 'datetime';
            $node['summary'] = $date->format('Y-m-d H:i:s.u T (P)');
            $timezone = $date->getTimezone();
            $node['props'] = [
                $this->meta('timezone', $timezone instanceof \DateTimeZone ? $timezone->getName() : null, $depth),
                $this->meta('timestamp', self::attempt(function () use ($date) {
                    return $date->getTimestamp();
                }), $depth),
            ];
            return $node;
        }

        /** "+ 1y 2m 3d 04:05:06.5" (VarDumper style). */
        private static function intervalText(\DateInterval $interval)
        {
            $parts = [];
            foreach (['y' => 'y', 'm' => 'm', 'd' => 'd'] as $field => $suffix) {
                if ($interval->{$field}) $parts[] = $interval->{$field} . $suffix;
            }
            $time = sprintf('%02d:%02d:%02d', $interval->h, $interval->i, $interval->s);
            if ($interval->f) $time .= rtrim(substr(sprintf('%.6F', $interval->f), 1), '0');
            $parts[] = $time;
            $text = ($interval->invert ? '- ' : '+ ') . implode(' ', $parts);
            if ($interval->days !== false) $text .= ' (' . $interval->days . ' days)';
            return $text;
        }

        private function viewNode($view, array $node, $depth)
        {
            $name = (string) self::attempt(function () use ($view) {
                return $view->name();
            });
            $props = [$this->meta('view', $name, $depth)];
            if (method_exists($view, 'getPath')) {
                $props[] = $this->meta('path', self::attempt(function () use ($view) {
                    return $view->getPath();
                }), $depth);
            }
            $props[] = $this->meta('data', self::attempt(function () use ($view) {
                return $view->getData();
            }), $depth);
            $node['props'] = $props;
            return $this->withHtml($node, function () use ($view) {
                return $view->render();
            }, $name !== '' ? $name : self::shortClass($node['class']), $depth);
        }

        private function mailableNode($mailable, array $node, $depth)
        {
            $node = $this->genericNode($mailable, $node, $depth);
            // Render a clone: render() hydrates envelope/content on the instance; nothing is ever sent.
            $copy = clone $mailable;
            $node = $this->withHtml($node, function () use ($copy) {
                return $copy->render();
            }, '', $depth);
            $vars = get_mangled_object_vars($copy);
            $subject = isset($vars['subject']) && is_string($vars['subject']) ? $vars['subject'] : '';
            $node['summary'] = $subject !== '' ? $this->summaryText($subject) : self::shortClass($node['class']);
            return $node;
        }

        private function mailMessageNode($message, array $node, $depth)
        {
            $node = $this->genericNode($message, $node, $depth);
            $vars = get_mangled_object_vars($message);
            $subject = isset($vars['subject']) && is_string($vars['subject']) ? $vars['subject'] : '';
            $copy = clone $message;
            return $this->withHtml($node, function () use ($copy) {
                return $copy->render();
            }, $subject !== '' ? $this->summaryText($subject) : self::shortClass($node['class']), $depth);
        }

        /**
         * Render HTML into the node (kind 'html'). Output echoed while rendering is discarded; failures are
         * reported as a `renderError` meta property and the node stays generic.
         */
        private function withHtml(array $node, callable $render, $summary, $depth)
        {
            if (!isset($node['props'])) $node['props'] = [];
            if ($summary !== '') $node['summary'] = $summary;
            if ($this->htmlRenders >= self::MAX_HTML_RENDERS || $this->htmlBytes <= 0) {
                $node['props'][] = $this->meta('renderError', 'HTML preview skipped: render budget of this dump exhausted', $depth);
                return $node;
            }
            $this->htmlRenders++;
            $level = ob_get_level();
            ob_start();
            try {
                $html = $render();
                if (is_object($html)) {
                    if ($html instanceof \Illuminate\Contracts\Support\Htmlable) $html = $html->toHtml();
                    elseif (method_exists($html, '__toString')) $html = $html->__toString();
                }
            } catch (\Throwable $e) {
                $node['props'][] = $this->meta('renderError', self::className($e) . ': ' . $e->getMessage(), $depth);
                return $node;
            } finally {
                while (ob_get_level() > $level) ob_end_clean();
            }
            if (!is_string($html)) {
                $node['props'][] = $this->meta('renderError', 'Rendering returned ' . gettype($html) . ' instead of a string', $depth);
                return $node;
            }
            $max = min(self::MAX_HTML_BYTES, $this->htmlBytes);
            if (strlen($html) > $max) {
                $html = self::utf8SafeCut($html, $max);
                $node['props'][] = $this->meta('htmlTruncated', true, $depth);
            }
            $this->htmlBytes -= strlen($html);
            $node['kind'] = 'html';
            $node['html'] = $html;
            return $node;
        }

        private function objectStorageNode(\SplObjectStorage $storage, array $node, $depth)
        {
            // Iterate a clone so the user's iterator position is untouched.
            $copy = clone $storage;
            $items = [];
            $truncated = false;
            $n = 0;
            foreach ($copy as $index => $object) {
                if ($this->full($n)) {
                    $truncated = true;
                    break;
                }
                $items[] = ['k' => $n, 'v' => $this->node(['object' => $object, 'info' => $copy->getInfo()], $depth + 1)];
                $n++;
            }
            $node['kind'] = 'collection';
            $node['count'] = count($storage);
            $node['items'] = $items;
            $node['props'] = $this->genericNode($storage, [], $depth)['props'];
            if ($truncated) $node['truncated'] = true;
            return $node;
        }

        /** SplDoublyLinkedList / SplQueue / SplStack / SplHeap / SplPriorityQueue — iterated on a clone. */
        private function splIterableNode($list, array $node, $depth)
        {
            $copy = clone $list;
            $items = [];
            $truncated = false;
            $n = 0;
            foreach ($copy as $value) {
                if ($this->full($n)) {
                    $truncated = true;
                    break;
                }
                $items[] = ['k' => $n, 'v' => $this->node($value, $depth + 1)];
                $n++;
            }
            $node['kind'] = 'collection';
            $node['count'] = count($list);
            $node['items'] = $items;
            $node['props'] = [];
            if ($truncated) $node['truncated'] = true;
            return $node;
        }

        /** Generators are never advanced: only where they are suspended is shown. */
        private function generatorNode(\Generator $generator, array $node, $depth)
        {
            $props = [];
            try {
                $reflection = new \ReflectionGenerator($generator);
                $function = $reflection->getFunction();
                $name = $function->getName();
                if (strpos($name, '{closure') !== false) $name = '{closure}';
                if ($function instanceof \ReflectionMethod) $name = self::cleanClass($function->getDeclaringClass()->getName()) . '::' . $name;
                $props[] = $this->meta('function', $name, $depth);
                $props[] = $this->meta('file', $reflection->getExecutingFile(), $depth);
                $props[] = $this->meta('line', $reflection->getExecutingLine(), $depth);
            } catch (\Throwable $e) {
                $props[] = $this->meta('finished', true, $depth); // ReflectionGenerator throws for finished generators
            }
            $node['props'] = $props;
            return $node;
        }

        // ------------------------------------------------------------------ closures

        private function closureNode(\Closure $closure)
        {
            $info = self::closureInfo($closure);
            $node = ['t' => 'closure', 'signature' => $info['signature']];
            if ($info['file'] !== null) {
                if (self::$context['evalFile'] !== '' && $info['file'] === self::$context['evalFile']) {
                    // Defined in the editor code: report the editor line only.
                    $node['line'] = max(1, $info['line'] + self::$context['lineOffset'] - 1);
                } else {
                    $node['file'] = $info['file'];
                    $node['line'] = $info['line'];
                }
            }
            return $node;
        }

        /**
         * Signature like "fn (int $a, $b = 2): string", "static function ($x) use ($y)" or, for closures made
         * from callables, "strlen(string $string): int" / "App\Foo::bar()".
         *
         * @return array{signature: string, file: ?string, line: int}
         */
        private static function closureInfo(\Closure $closure)
        {
            try {
                $rf = new \ReflectionFunction($closure);
            } catch (\Throwable $e) {
                return ['signature' => 'Closure', 'file' => null, 'line' => 0];
            }
            $params = [];
            foreach ($rf->getParameters() as $parameter) $params[] = self::parameterText($parameter);
            $return = '';
            if ($rf->hasReturnType()) $return = ': ' . self::typeText($rf->getReturnType());
            $name = $rf->getName();
            $file = $rf->getFileName();
            $line = (int) $rf->getStartLine();

            if (strpos($name, '{closure') !== false) {
                $keyword = self::closureKeyword($rf);
                $static = method_exists($rf, 'isStatic') && $rf->isStatic();
                $uses = [];
                if ($keyword === 'function') {
                    try {
                        $vars = method_exists($rf, 'getClosureUsedVariables') ? $rf->getClosureUsedVariables() : $rf->getStaticVariables();
                        foreach (array_keys($vars) as $var) $uses[] = '$' . $var;
                    } catch (\Throwable $e) {
                        $uses = [];
                    }
                }
                $signature = ($static ? 'static ' : '') . $keyword . ' (' . implode(', ', $params) . ')'
                    . ($uses ? ' use (' . implode(', ', $uses) . ')' : '') . $return;
            } else {
                $prefix = '';
                $scope = $rf->getClosureScopeClass();
                if ($scope !== null && $scope->hasMethod($name)) $prefix = self::cleanClass($scope->getName()) . '::';
                $signature = $prefix . $name . '(' . implode(', ', $params) . ')' . $return;
            }
            return ['signature' => $signature, 'file' => is_string($file) && $file !== '' ? $file : null, 'line' => $line];
        }

        private static function parameterText(\ReflectionParameter $parameter)
        {
            $text = '';
            if ($parameter->hasType()) $text .= self::typeText($parameter->getType()) . ' ';
            if ($parameter->isPassedByReference()) $text .= '&';
            if ($parameter->isVariadic()) $text .= '...';
            $text .= '$' . $parameter->getName();
            if (!$parameter->isVariadic()) {
                try {
                    if ($parameter->isDefaultValueAvailable()) $text .= ' = ' . self::defaultText($parameter);
                } catch (\Throwable $e) {
                    $text .= ' = …';
                }
            }
            return $text;
        }

        private static function typeText($type)
        {
            if ($type instanceof \ReflectionNamedType && PHP_VERSION_ID < 80000) {
                $name = $type->getName();
                return $type->allowsNull() && $name !== 'mixed' && $name !== 'null' ? '?' . $name : $name;
            }
            return (string) $type;
        }

        /** Default value as source text, without evaluating `new` initializers (PHP 8.1+). */
        private static function defaultText(\ReflectionParameter $parameter)
        {
            try {
                if ($parameter->isDefaultValueConstant()) return (string) $parameter->getDefaultValueConstantName();
            } catch (\Throwable $e) {
                // not a constant expression: fall through to the value
            }
            if (PHP_VERSION_ID >= 80100) {
                // "Parameter #1 [ <optional> $b = new \Foo() ]": the engine prints the AST of the default, so
                // `new` initializers are shown as written instead of being evaluated (= constructed).
                $text = (string) $parameter;
                $marker = '$' . $parameter->getName() . ' = ';
                $pos = strpos($text, $marker);
                if ($pos === false) return '…';
                $default = substr($text, $pos + strlen($marker));
                if (substr($default, -2) === ' ]') $default = substr($default, 0, -2);
                if (preg_match('/\bnew\s/i', $default)) return self::clip($default, 40);
            }
            return self::literal($parameter->getDefaultValue(), 0);
        }

        /** Short PHP source form of a default value. */
        private static function literal($value, $level)
        {
            if ($value === null) return 'null';
            if (is_bool($value)) return $value ? 'true' : 'false';
            if (is_int($value)) return (string) $value;
            if (is_float($value)) return self::formatFloat($value);
            if (is_string($value)) return "'" . self::clip(addcslashes($value, "'\\\n\r\t"), 30) . "'";
            if (is_array($value)) {
                if ($value === []) return '[]';
                if ($level >= 2) return '[…]';
                $list = self::isList($value);
                $parts = [];
                foreach ($value as $key => $item) {
                    $parts[] = ($list ? '' : self::literal($key, $level + 1) . ' => ') . self::literal($item, $level + 1);
                }
                $text = '[' . implode(', ', $parts) . ']';
                return strlen($text) > 40 ? '[…]' : $text;
            }
            if ($value instanceof \UnitEnum) return self::cleanClass(get_class($value)) . '::' . $value->name;
            if (is_object($value)) return 'new \\' . self::cleanClass(get_class($value)) . '()';
            return '…';
        }

        /** "fn" or "function" for an anonymous closure, detected from its source when readable. */
        private static function closureKeyword(\ReflectionFunction $rf)
        {
            $file = $rf->getFileName();
            $start = (int) $rf->getStartLine();
            if (!is_string($file) || $file === '' || $start < 1) return 'function';
            $lines = self::sourceLines($file);
            if ($lines === null || !isset($lines[$start - 1])) return 'function';
            $count = max(1, min((int) $rf->getEndLine() - $start + 1, 40));
            // Fragments may be syntactically incomplete; the tokenizer copes, its warnings are irrelevant here.
            $tokens = @token_get_all('<?php ' . implode("\n", array_slice($lines, $start - 1, $count)));
            if (!is_array($tokens)) return 'function';

            $expected = [];
            foreach ($rf->getParameters() as $parameter) $expected[] = '$' . $parameter->getName();
            $fnToken = defined('T_FN') ? T_FN : -1;
            $candidates = [];
            $total = count($tokens);
            for ($i = 0; $i < $total; $i++) {
                $token = $tokens[$i];
                if (!is_array($token) || ($token[0] !== T_FUNCTION && $token[0] !== $fnToken)) continue;
                $j = self::nextSignificant($tokens, $i + 1);
                if ($j !== null && $tokens[$j] === '&') $j = self::nextSignificant($tokens, $j + 1);
                if ($j === null || $tokens[$j] !== '(') continue; // named function / method / `use function`
                $vars = [];
                $level = 0;
                for ($k = $j; $k < $total; $k++) {
                    $t = $tokens[$k];
                    if ($t === '(') {
                        $level++;
                    } elseif ($t === ')') {
                        if (--$level === 0) break;
                    } elseif ($level === 1 && is_array($t) && $t[0] === T_VARIABLE) {
                        $vars[] = $t[1];
                    }
                }
                $candidates[] = ['keyword' => $token[0] === $fnToken ? 'fn' : 'function', 'vars' => $vars];
            }
            if (!$candidates) return 'function';
            foreach ($candidates as $candidate) {
                if ($candidate['vars'] === $expected) return $candidate['keyword'];
            }
            return $candidates[0]['keyword'];
        }

        private static function nextSignificant(array $tokens, $i)
        {
            $total = count($tokens);
            for (; $i < $total; $i++) {
                $t = $tokens[$i];
                if (is_array($t) && ($t[0] === T_WHITESPACE || $t[0] === T_COMMENT || $t[0] === T_DOC_COMMENT)) continue;
                return $i;
            }
            return null;
        }

        /** @return string[]|null */
        private static function sourceLines($file)
        {
            if (array_key_exists($file, self::$sources)) return self::$sources[$file];
            $lines = null;
            $context = self::$context;
            if ($context['evalFile'] !== '' && $file === $context['evalFile']) {
                if ($context['evalCode'] !== '') $lines = explode("\n", str_replace("\r\n", "\n", $context['evalCode']));
            } elseif (strpos($file, "\0") === false && substr($file, -14) !== "eval()'d code") {
                // @: open_basedir restrictions emit warnings; an unreadable source only disables `fn` detection.
                if (@is_file($file) && @is_readable($file) && (int) @filesize($file) <= self::MAX_SOURCE_FILE_BYTES) {
                    $read = @file($file, FILE_IGNORE_NEW_LINES);
                    if (is_array($read)) $lines = $read;
                }
            }
            if (count(self::$sources) >= 64) self::$sources = [];
            return self::$sources[$file] = $lines;
        }

        // -----------------------------------------------------------------------------------------------
        // Preview
        // -----------------------------------------------------------------------------------------------

        private static function previewValue($value, $max, $level)
        {
            if ($value === null) return 'null';
            if (is_bool($value)) return $value ? 'true' : 'false';
            if (is_int($value)) return (string) $value;
            if (is_float($value)) return self::formatFloat($value);
            if (is_string($value)) return self::previewString($value, $max);
            if (is_array($value)) return self::previewArray($value, $max, $level);
            if (is_object($value)) return self::previewObject($value, $max);
            $open = is_resource($value);
            return ($open ? get_resource_type($value) : 'closed') . ' resource @' . (int) $value;
        }

        private static function previewString($string, $max)
        {
            if ($string !== '' && !self::isUtf8($string)) {
                return 'b"' . self::escapeBinary(strlen($string) > $max ? substr($string, 0, $max) : $string) . '"';
            }
            // Only the visible part is escaped; cut() trims the rest.
            if (strlen($string) > $max + 1) $string = self::utf8Prefix($string, $max + 1);
            $escaped = preg_replace_callback('/[\x00-\x1F\x7F]/', function ($m) {
                $map = ["\n" => '\n', "\r" => '\r', "\t" => '\t'];
                return isset($map[$m[0]]) ? $map[$m[0]] : sprintf('\x%02X', ord($m[0]));
            }, $string);
            return '"' . $escaped . '"';
        }

        private static function previewArray(array $array, $max, $level)
        {
            $count = count($array);
            if ($count === 0) return '[]';
            $short = 'array:' . $count . ' [...]';
            // Every item needs at least 3 characters ("x, "): huge arrays can never fit, skip the key scan.
            if ($level >= 3 || 3 * $count > $max + 2) return $short;
            $list = self::isList($array);
            $parts = [];
            $length = 2;
            foreach ($array as $key => $value) {
                $part = ($list ? '' : (is_int($key) ? $key : self::previewString((string) $key, $max)) . ' => ')
                    . self::previewValue($value, $max, $level + 1);
                $length += strlen($part) + 2;
                if ($length > $max + 2) return $short;
                $parts[] = $part;
            }
            return '[' . implode(', ', $parts) . ']';
        }

        private static function previewObject($o, $max)
        {
            $class = self::className($o);
            if ($o instanceof \UnitEnum) return $class . '::' . $o->name;
            if ($o instanceof \Closure) {
                $info = self::closureInfo($o);
                return $info['signature'];
            }
            $head = $class . ' {#' . spl_object_id($o);
            if ($o instanceof \__PHP_Incomplete_Class) return $head . ' …}';
            if (self::isUninitializedLazy($o)) return $head . ' lazy}';
            try {
                if ($o instanceof \Throwable) return $head . ' message: ' . self::previewString($o->getMessage(), $max) . '}';
                if ($o instanceof \Illuminate\Database\Eloquent\Model) {
                    $key = self::modelKey($o);
                    return $key === null ? $head . '}' : $head . ' ' . $key[0] . ': ' . $key[1] . '}';
                }
                if ($o instanceof \Illuminate\Support\Collection) return $head . ' count: ' . count((array) $o->all()) . '}';
                if ($o instanceof \Illuminate\Pagination\AbstractPaginator || $o instanceof \Illuminate\Pagination\AbstractCursorPaginator) {
                    return $head . ' count: ' . count((array) $o->items()) . '}';
                }
                if ($o instanceof \Illuminate\Database\Eloquent\Builder || $o instanceof \Illuminate\Database\Query\Builder
                    || $o instanceof \Illuminate\Database\Eloquent\Relations\Relation) {
                    $info = self::builderInfo($o);
                    return $head . ' ' . $info['raw'] . '}';
                }
                if ($o instanceof \DateTimeInterface) return $class . ' @' . $o->format('Y-m-d H:i:s');
                if ($o instanceof \DateTimeZone) return $head . ' ' . $o->getName() . '}';
                if ($o instanceof \DateInterval) return $head . ' ' . self::intervalText($o) . '}';
                if ($o instanceof \Illuminate\Support\HtmlString) return $head . ' ' . self::previewString((string) $o->toHtml(), $max) . '}';
                if ($o instanceof \Illuminate\Contracts\View\View) return $head . ' ' . $o->name() . '}';
                if ($o instanceof \Illuminate\Mail\Mailable || $o instanceof \Illuminate\Notifications\Messages\MailMessage) {
                    $vars = get_mangled_object_vars($o);
                    $subject = isset($vars['subject']) && is_string($vars['subject']) ? $vars['subject'] : '';
                    return $subject === '' ? $head . '}' : $head . ' ' . self::previewString($subject, $max) . '}';
                }
                if ($o instanceof \ArrayObject || $o instanceof \ArrayIterator) return $head . ' count: ' . count($o->getArrayCopy()) . '}';
                if ($o instanceof \SplObjectStorage || $o instanceof \SplDoublyLinkedList || $o instanceof \SplHeap
                    || $o instanceof \SplPriorityQueue || $o instanceof \SplFixedArray) {
                    return $head . ' count: ' . count($o) . '}';
                }
                if ($o instanceof \SplFileInfo) return $head . ' ' . self::previewString($o->getPathname(), $max) . '}';
                if ($o instanceof \GMP && function_exists('gmp_strval')) return $head . ' ' . gmp_strval($o) . '}';
                if (!($o instanceof \Illuminate\Contracts\View\View) && !($o instanceof \Illuminate\Contracts\Support\Htmlable)
                    && self::isStringable($o)) {
                    return $head . ' ' . self::previewString((string) $o->__toString(), $max) . '}';
                }
            } catch (\Throwable $e) {
                return $head . '}';
            }
            return get_mangled_object_vars($o) ? $head . ' …}' : $head . '}';
        }

        // -----------------------------------------------------------------------------------------------
        // Helpers
        // -----------------------------------------------------------------------------------------------

        /** Class name for display: anonymous classes lose their "\0file:line$n" suffix. */
        private static function className($o)
        {
            if ($o instanceof \__PHP_Incomplete_Class) {
                $vars = get_mangled_object_vars($o);
                $name = isset($vars['__PHP_Incomplete_Class_Name']) ? (string) $vars['__PHP_Incomplete_Class_Name'] : '?';
                return '__PHP_Incomplete_Class(' . $name . ')';
            }
            return self::cleanClass(get_class($o));
        }

        private static function cleanClass($class)
        {
            $pos = strpos($class, "\0");
            return $pos === false ? $class : substr($class, 0, $pos);
        }

        private static function shortClass($class)
        {
            $pos = strrpos($class, '\\');
            return $pos === false ? $class : substr($class, $pos + 1);
        }

        /** __toString() objects whose cast is a value, not an I/O operation. */
        private static function isStringable($o)
        {
            if ($o instanceof \__PHP_Incomplete_Class || !method_exists($o, '__toString')) return false;
            if ($o instanceof \Illuminate\Database\Eloquent\Model) return false; // toJson() would run accessors
            if ($o instanceof \Traversable) return false; // e.g. LazyCollection::__toString() iterates the source
            if ($o instanceof \Psr\Http\Message\StreamInterface) return false; // reads (and may consume) the stream
            if ($o instanceof \Symfony\Component\HttpFoundation\Request) return false; // reads php://input
            if ($o instanceof \SplFileObject) return false; // reads a line
            return true;
        }

        /** Run a getter; null when it throws (only used for optional, informational values). */
        private static function attempt(callable $fn)
        {
            try {
                return $fn();
            } catch (\Throwable $e) {
                return null;
            }
        }

        private static function failureNode($value, \Throwable $e)
        {
            $message = 'Tinkerbox could not dump this value: ' . self::className($e) . ': ' . $e->getMessage();
            if (is_object($value)) {
                return ['t' => 'object', 'class' => self::className($value), 'id' => spl_object_id($value), 'summary' => $message, 'props' => []];
            }
            $length = self::isUtf8($message) ? self::utf8Length($message) : strlen($message);
            return ['t' => 'string', 'v' => self::text($message), 'len' => $length];
        }

        /** Floats as strings: "1.0", "0.1", "1.0E+25", "-0.0", "INF", "-INF", "NAN" (shortest round-trip form). */
        private static function formatFloat($float)
        {
            if (is_nan($float)) return 'NAN';
            if (is_infinite($float)) return $float > 0 ? 'INF' : '-INF';
            $precision = ini_get('serialize_precision');
            $changed = $precision !== '-1' && $precision !== false;
            if ($changed) ini_set('serialize_precision', '-1');
            $text = var_export($float, true);
            if ($changed) ini_set('serialize_precision', $precision);
            return $text;
        }

        private static function isUtf8($string)
        {
            return preg_match('//u', $string) === 1;
        }

        /** Key / property name made JSON-safe (binary names are escaped). */
        private static function text($string)
        {
            return $string === '' || self::isUtf8($string) ? $string : self::escapeBinary($string);
        }

        private static function escapeBinary($bytes)
        {
            return preg_replace_callback('/[^\x20-\x7E]/', function ($m) {
                return sprintf('\x%02X', ord($m[0]));
            }, $bytes);
        }

        /** Character count of a valid UTF-8 string (mbstring is optional on remote servers). */
        private static function utf8Length($string)
        {
            if (function_exists('mb_strlen')) return mb_strlen($string, 'UTF-8');
            return strlen($string) - (int) preg_match_all('/[\x80-\xBF]/', $string);
        }

        /** First $chars characters of a valid UTF-8 string. */
        private static function utf8Prefix($string, $chars)
        {
            if (function_exists('mb_substr')) return mb_substr($string, 0, $chars, 'UTF-8');
            $length = strlen($string);
            $count = 0;
            for ($i = 0; $i < $length; $i++) {
                if ((ord($string[$i]) & 0xC0) !== 0x80) {
                    if ($count === $chars) return substr($string, 0, $i);
                    $count++;
                }
            }
            return $string;
        }

        /** Cut to at most $bytes bytes without splitting a UTF-8 sequence. */
        private static function utf8SafeCut($string, $bytes)
        {
            $cut = substr($string, 0, $bytes);
            $i = strlen($cut);
            // Back off over continuation bytes, then drop the lead byte if its sequence was cut.
            $back = 0;
            while ($i > 0 && $back < 4 && (ord($cut[$i - 1]) & 0xC0) === 0x80) {
                $i--;
                $back++;
            }
            if ($i > 0 && ord($cut[$i - 1]) >= 0xC0) {
                $lead = ord($cut[$i - 1]);
                $need = $lead >= 0xF0 ? 3 : ($lead >= 0xE0 ? 2 : 1);
                if ($back < $need) return substr($cut, 0, $i - 1);
            }
            return $cut;
        }

        private static function clip($text, $max)
        {
            if (strlen($text) <= $max) return $text;
            $prefix = self::isUtf8($text) ? self::utf8Prefix($text, $max - 1) : substr($text, 0, $max - 1);
            return $prefix . '…';
        }

        /** Cut a preview to $max characters (the last one being "…"). */
        private static function cut($text, $max)
        {
            if (strlen($text) <= $max) return $text;
            if (!self::isUtf8($text)) $text = self::escapeBinary($text);
            if (self::utf8Length($text) <= $max) return $text;
            return self::utf8Prefix($text, $max - 1) . '…';
        }

        private static function isList(array $array)
        {
            $i = 0;
            foreach ($array as $key => $unused) {
                if ($key !== $i++) return false;
            }
            return true;
        }
    }
}
