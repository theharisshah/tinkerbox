<?php

namespace Tinkerbox {
    /**
     * Panels modal data (`panels` data mode, docs/ARCHITECTURE.md §1.8): the driver's panels() normalized to
     * `AppPanel[]` (src/shared/types.ts: { title, sections: [{ title, rows: [{ key, value }] }] }).
     *
     * Drivers build their panels with \Tinkerbox\Panels\Panel, whose toArray() already is an AppPanel; custom drivers
     * may also return Panel objects or looser array shapes, which are normalized here. When a driver yields no usable
     * panel at all, a default panel is shown instead (Laravel's "App Information" while a Laravel / Lumen application
     * is running, else the PHP environment), so the modal is never empty.
     */
    final class Panels
    {
        const DEFAULT_TITLE = 'Panel';

        /** Words rendered upper-case when humanizing snake_case keys. */
        private static $acronyms = [
            'api', 'cdn', 'cli', 'css', 'db', 'html', 'http', 'https', 'id', 'ip', 'js', 'json', 'orm', 'os', 'pdo',
            'php', 'sapi', 'sql', 'ssl', 'tls', 'ui', 'uri', 'url', 'xml',
        ];

        /**
         * @param Drivers\Driver $driver
         * @param string $projectPath
         * @return array AppPanel[]
         */
        public static function forDriver(Drivers\Driver $driver, $projectPath)
        {
            $raw = [];
            try {
                $raw = self::panelList($driver->panels((string) $projectPath));
            } catch (\Throwable $e) {
                // A failing panels() must not leave the modal empty: the default panel is used below.
                self::report('driver panels()', $e);
            }

            $panels = [];
            $index = 0;
            foreach ($raw as $key => $panel) {
                $index++;
                try {
                    $normalized = self::normalizePanel($panel, is_string($key) ? $key : 'Panel ' . $index);
                } catch (\Throwable $e) {
                    // One broken custom panel must not hide the others.
                    self::report('panel ' . $index, $e);
                    continue;
                }
                if ($normalized !== null) {
                    $panels[] = $normalized;
                }
            }

            if (!$panels) {
                try {
                    $default = self::normalizePanel(self::defaultPanel((string) $projectPath), self::DEFAULT_TITLE);
                    if ($default !== null) {
                        $panels[] = $default;
                    }
                } catch (\Throwable $e) {
                    self::report('default panel', $e);
                }
            }

            return $panels;
        }

        /**
         * The fallback panel: Laravel's "App Information" while a Laravel / Lumen application is running, else the
         * PHP environment.
         *
         * @param string $projectPath
         * @return array AppPanel
         */
        public static function defaultPanel($projectPath = '')
        {
            $app = self::laravelApp();
            $panel = $app !== null ? Panels\StandardPanels::laravel($app) : null;

            return $panel !== null ? $panel : Panels\StandardPanels::php((string) $projectPath);
        }

        // -----------------------------------------------------------------------------------------------------
        // Normalization of driver panels
        // -----------------------------------------------------------------------------------------------------

        /**
         * Normalize whatever a driver returns from panels(): AppPanel arrays, Panel objects (toArray()), looser
         * arrays `{title, content: {sections}}` / `{title, rows}`, or a single panel instead of a list.
         *
         * @param mixed $raw
         * @return array AppPanel[]
         */
        public static function normalizeAll($raw)
        {
            $panels = [];
            $index = 0;
            foreach (self::panelList($raw) as $key => $panel) {
                $index++;
                $normalized = self::normalizePanel($panel, is_string($key) ? $key : 'Panel ' . $index);
                if ($normalized !== null) {
                    $panels[] = $normalized;
                }
            }

            return $panels;
        }

        /**
         * panels() result as a list of raw panels.
         *
         * @param mixed $raw
         * @return array
         */
        private static function panelList($raw)
        {
            if ($raw === null || $raw === false || $raw === '') {
                return [];
            }
            if ($raw instanceof \Traversable) {
                return iterator_to_array($raw);
            }
            if (is_object($raw)) {
                // A single Panel object.
                return [$raw];
            }
            if (!is_array($raw)) {
                return [];
            }
            // A single panel array instead of a list.
            if (isset($raw['title']) || isset($raw['content']) || isset($raw['sections'])) {
                return [$raw];
            }

            return $raw;
        }

        /**
         * @param mixed $panel
         * @param string $fallbackTitle
         * @return array|null
         */
        public static function normalizePanel($panel, $fallbackTitle = 'Panel')
        {
            $panel = self::plain($panel);
            if (!is_array($panel)) {
                return null;
            }
            $title = self::firstString($panel, ['title', 'name', 'label', 'heading'], $fallbackTitle);

            if (array_key_exists('sections', $panel)) {
                $sections = self::normalizeSections($panel['sections']);
            } elseif (array_key_exists('content', $panel)) {
                $sections = self::normalizeContent($panel['content']);
            } elseif (array_key_exists('table', $panel)) {
                $sections = self::normalizeContent($panel['table']);
            } elseif (array_key_exists('rows', $panel)) {
                $sections = [['title' => '', 'rows' => self::normalizeRows($panel['rows'])]];
            } else {
                $sections = [];
            }

            return ['title' => $title, 'sections' => $sections];
        }

        /** Panel content: a Table (object / array with sections), a list of sections, rows, or plain text. */
        private static function normalizeContent($content)
        {
            $content = self::plain($content);
            if ($content === null) {
                return [];
            }
            if (is_scalar($content)) {
                $text = trim((string) $content);

                return $text === '' ? [] : [['title' => '', 'rows' => [['key' => '', 'value' => $text]]]];
            }
            if (!is_array($content)) {
                return [];
            }
            if (array_key_exists('sections', $content)) {
                return self::normalizeSections($content['sections']);
            }
            if (array_key_exists('content', $content)) {
                return self::normalizeContent($content['content']);
            }
            if (array_key_exists('rows', $content) && !array_key_exists('title', $content)) {
                return [['title' => '', 'rows' => self::normalizeRows($content['rows'])]];
            }
            if (self::looksLikeSection($content)) {
                return self::normalizeSections([$content]);
            }
            if (self::isList($content) && $content && self::looksLikeSection(self::plain(reset($content)))) {
                return self::normalizeSections($content);
            }
            if (self::isSectionMap($content)) {
                // `['Environment' => ['Name' => 'x'], 'Cache' => ['Driver' => 'redis']]` — sections keyed by title.
                return self::normalizeSections($content);
            }

            // Plain key => value map or list of pairs: one untitled section.
            return [['title' => '', 'rows' => self::normalizeRows($content)]];
        }

        /** @return array list of {title, rows} */
        private static function normalizeSections($sections)
        {
            $sections = self::plain($sections);
            if (!is_array($sections)) {
                return [];
            }
            if (self::looksLikeSection($sections)) {
                $sections = [$sections];
            }
            $out = [];
            foreach ($sections as $key => $section) {
                $section = self::plain($section);
                if (!is_array($section)) {
                    continue;
                }
                if (!self::looksLikeSection($section)) {
                    // `['Environment' => ['Name' => 'x']]` — keyed by title.
                    $out[] = ['title' => is_string($key) ? $key : '', 'rows' => self::normalizeRows($section)];
                    continue;
                }
                $title = self::firstString($section, ['title', 'name', 'label', 'heading'], is_string($key) ? $key : '');
                $rows = [];
                foreach (['rows', 'items', 'data', 'content', 'values'] as $rowsKey) {
                    if (array_key_exists($rowsKey, $section)) {
                        $rows = self::normalizeRows($section[$rowsKey]);
                        break;
                    }
                }
                $out[] = ['title' => $title, 'rows' => $rows];
            }

            return $out;
        }

        /**
         * Rows: list of [key, value] pairs, list of {key|label|name|title, value}, or a key => value map.
         *
         * @return array list of {key, value}
         */
        public static function normalizeRows($rows)
        {
            $rows = self::plain($rows);
            if ($rows === null) {
                return [];
            }
            if (!is_array($rows)) {
                return [['key' => '', 'value' => self::stringify($rows)]];
            }
            if (self::isRowArray($rows)) {
                $rows = [$rows];
            }
            $out = [];
            if (self::isList($rows)) {
                foreach ($rows as $row) {
                    $row = self::plain($row);
                    if (is_array($row) && self::isRowArray($row)) {
                        $key = self::firstString($row, ['key', 'label', 'name', 'title'], '');
                        $out[] = ['key' => $key, 'value' => self::stringify($row['value'])];
                    } elseif (is_array($row) && self::isList($row) && count($row) === 2) {
                        $out[] = ['key' => self::stringify($row[0]), 'value' => self::stringify($row[1])];
                    } elseif (is_array($row) && count($row) === 1 && !self::isList($row)) {
                        $out[] = ['key' => (string) key($row), 'value' => self::stringify(reset($row))];
                    } else {
                        $out[] = ['key' => '', 'value' => self::stringify($row)];
                    }
                }

                return $out;
            }
            foreach ($rows as $key => $value) {
                $out[] = ['key' => (string) $key, 'value' => self::stringify($value)];
            }

            return $out;
        }

        /** Every value is a non-empty key => value map (and the keys are titles): a map of sections. */
        private static function isSectionMap(array $content)
        {
            if (!$content || self::isList($content)) {
                return false;
            }
            foreach ($content as $value) {
                $value = self::plain($value);
                if (!is_array($value) || !$value || self::isList($value)) {
                    return false;
                }
            }

            return true;
        }

        /** A section has a title-ish key and a rows-ish key (or only rows). */
        private static function looksLikeSection($value)
        {
            if (!is_array($value)) {
                return false;
            }
            foreach (['rows', 'items', 'data', 'values'] as $key) {
                if (array_key_exists($key, $value)) {
                    return true;
                }
            }

            return array_key_exists('content', $value) && (array_key_exists('title', $value) || array_key_exists('name', $value));
        }

        /** A single row: {key|label|name|title, value}. */
        private static function isRowArray(array $value)
        {
            if (!array_key_exists('value', $value)) {
                return false;
            }
            foreach (['key', 'label', 'name', 'title'] as $key) {
                if (array_key_exists($key, $value)) {
                    return count($value) <= 3;
                }
            }

            return false;
        }

        /**
         * Display string for a panel value: booleans "true"/"false", lists "a, b", maps "k: v, …", dates, enums,
         * stringables; null → "".
         */
        public static function stringify($value, $depth = 0)
        {
            if ($value === null) {
                return '';
            }
            if (is_bool($value)) {
                return $value ? 'true' : 'false';
            }
            if (is_int($value) || is_float($value)) {
                return (string) $value;
            }
            if (is_string($value)) {
                return trim($value);
            }
            if (is_array($value)) {
                if ($depth > 2) {
                    return '…';
                }
                $parts = [];
                $list = self::isList($value);
                foreach ($value as $key => $item) {
                    $text = self::stringify($item, $depth + 1);
                    $parts[] = $list ? $text : $key . ': ' . $text;
                }

                return implode(', ', $parts);
            }
            if (is_object($value)) {
                if ($value instanceof \DateTimeInterface) {
                    return $value->format('Y-m-d H:i:s T');
                }
                if (interface_exists('UnitEnum', false) && $value instanceof \UnitEnum) {
                    return $value instanceof \BackedEnum ? (string) $value->value : $value->name;
                }
                if ($value instanceof \Closure) {
                    return 'Closure';
                }
                if (method_exists($value, '__toString')) {
                    return trim((string) $value);
                }
                $plain = self::plain($value);

                return is_array($plain) ? self::stringify($plain, $depth + 1) : get_class($value);
            }

            return gettype($value);
        }

        // -----------------------------------------------------------------------------------------------------
        // Helpers
        // -----------------------------------------------------------------------------------------------------

        /** The booted Laravel / Lumen / Acorn application (never creates a container), else null. */
        private static function laravelApp()
        {
            $app = Drivers\Laravel::runningApp();
            if ($app === null) {
                return null;
            }
            if (class_exists('Illuminate\Foundation\Application', false) && $app instanceof \Illuminate\Foundation\Application) {
                return $app;
            }
            if (class_exists('Laravel\Lumen\Application', false) && $app instanceof \Laravel\Lumen\Application) {
                return $app;
            }

            return null;
        }

        /** "blade_icons" → "Blade Icons", "php_version" → "PHP Version"; paths are kept as they are. */
        public static function humanize($key)
        {
            $key = (string) $key;
            if ($key === '' || strpos($key, '/') !== false || strpos($key, '\\') !== false) {
                return $key;
            }
            $words = preg_split('/[_\-\s]+/', $key, -1, PREG_SPLIT_NO_EMPTY);
            foreach ($words as &$word) {
                $lower = strtolower($word);
                $word = in_array($lower, self::$acronyms, true) ? strtoupper($lower) : ucfirst($word);
            }
            unset($word);

            return implode(' ', $words);
        }

        /** Objects (Panel builders, Arrayable, JsonSerializable, plain objects) → arrays. */
        private static function plain($value)
        {
            for ($i = 0; $i < 4 && is_object($value); $i++) {
                if ($value instanceof \Closure) {
                    return null;
                }
                if (method_exists($value, 'toArray')) {
                    $value = $value->toArray();
                } elseif ($value instanceof \JsonSerializable) {
                    $value = $value->jsonSerialize();
                } elseif ($value instanceof \Traversable) {
                    $value = iterator_to_array($value);
                } else {
                    $value = self::objectProperties($value);
                }
            }

            return $value;
        }

        /** All properties (incl. protected / private) without the mangled name prefixes of an (array) cast. */
        private static function objectProperties($object)
        {
            $out = [];
            foreach ((array) $object as $key => $value) {
                $key = (string) $key;
                if ($key !== '' && $key[0] === "\0") {
                    $key = substr($key, strrpos($key, "\0") + 1);
                }
                if (!array_key_exists($key, $out)) {
                    $out[$key] = $value;
                }
            }

            return $out;
        }

        private static function firstString(array $data, array $keys, $fallback)
        {
            foreach ($keys as $key) {
                if (isset($data[$key]) && is_scalar($data[$key]) && trim((string) $data[$key]) !== '') {
                    return trim((string) $data[$key]);
                }
            }

            return (string) $fallback;
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

        /** Degraded panel data is reported on stderr (logged by the main process); stdout carries the envelope. */
        private static function report($label, \Throwable $e)
        {
            if (defined('STDERR') && is_resource(STDERR)) {
                fwrite(STDERR, '[tinkerbox] panels: ' . $label . ' failed: ' . get_class($e) . ': ' . $e->getMessage() . "\n");
            }
        }
    }
}
