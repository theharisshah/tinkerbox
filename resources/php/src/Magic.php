<?php

namespace Tinkerbox {
    /**
     * Values recorded by magic comments (docs/ARCHITECTURE.md §1.5 rule 6). The CodeTransformer wraps the
     * commented expression in `Magic::capture()` / `Magic::time()`; both return the original value so the
     * user's code behaves exactly as without the comment. Variables the context takes by reference
     * (`sort($a/*?*\/)`, `foreach ($a/*?*\/ as &$v)`, `$a/*?*\/['k'] = 1`, `return $x;` in `function &f()`) are
     * wrapped in `captureRef()` / `timeRef()`, which return a reference to the variable itself.
     *
     * One record per comment (line + column): the latest value wins, `hits` counts how often it ran (loops).
     * Values are dumped at capture time with maxDepth = min(3, options.maxDepth).
     */
    final class Magic
    {
        const PREVIEW_LENGTH = 120;

        /** @var array<string, array> "line:column" => MagicValue */
        private static $records = [];
        /** @var array<string, mixed> "line:column" => latest scalar value (identical scalars are not re-dumped) */
        private static $scalars = [];
        /** Start (microtime) of the /*?.*\/ timing clock: the moment the user's code starts (after the bootstrap). */
        private static $start = null;
        private static $limits = ['maxDepth' => 3, 'maxItems' => 500, 'maxStringLength' => 10000];

        /**
         * @param float $start   provisional clock start (microtime(true)); startClock() sets the real one
         * @param array $options RunOptions (maxDepth, maxItems, maxStringLength)
         */
        public static function configure($start, array $options = [])
        {
            self::$start = (float) $start;
            self::$limits = [
                'maxDepth' => min(3, isset($options['maxDepth']) ? max(1, (int) $options['maxDepth']) : 3),
                'maxItems' => isset($options['maxItems']) ? max(1, (int) $options['maxItems']) : 500,
                'maxStringLength' => isset($options['maxStringLength']) ? max(1, (int) $options['maxStringLength']) : 10000,
            ];
        }

        /**
         * `EXPR; //?`, `//? label`, `/*?*\/`, `//?->method()`, `/*?->expr*\/`.
         *
         * @param int           $line   editor line of the comment
         * @param int           $column editor column of the comment
         * @param mixed         $value  the wrapped expression's value (returned unchanged)
         * @param callable|null $tap    `fn ($v) => $v->method()` for the `->…` forms: its result is recorded
         * @param string|null   $label
         * @return mixed $value
         */
        public static function capture($line, $column, $value, $tap = null, $label = null)
        {
            $recorded = $value;
            $preview = null;
            if ($tap !== null) {
                try {
                    $recorded = $tap($value);
                } catch (\Throwable $e) {
                    // The tap is only an observation: the statement keeps its value, the failure is shown.
                    $recorded = $e;
                    $preview = get_class($e) . ': ' . $e->getMessage();
                }
            }
            self::record((int) $line, (int) $column, 'value', $recorded, $label, $preview);
            return $value;
        }

        /**
         * Start the timing clock: called right before the user's code runs, so the framework bootstrap is not
         * part of the measured time.
         * @param float $start microtime(true)
         */
        public static function startClock($start)
        {
            self::$start = (float) $start;
        }

        /**
         * Like capture(), for a variable the context takes by reference: the returned reference keeps
         * `sort($a/*?*\/)`, `foreach ($a/*?*\/ as &$v)`, `$a/*?*\/['k'] = 1` and by-reference returns working.
         *
         * @param mixed $value the variable (by reference)
         * @return mixed a reference to $value
         */
        public static function &captureRef($line, $column, &$value, $tap = null, $label = null)
        {
            self::capture($line, $column, $value, $tap, $label);
            return $value;
        }

        /**
         * `/*?.*\/` — seconds since the user's code started ("0.78301s"). Used as a statement (no value) or
         * wrapped around an expression (the value is returned unchanged, timed after it was evaluated).
         *
         * @return mixed $value
         */
        public static function time($line, $column, $value = null)
        {
            $start = self::$start !== null ? self::$start : (isset($_SERVER['REQUEST_TIME_FLOAT']) ? (float) $_SERVER['REQUEST_TIME_FLOAT'] : microtime(true));
            $seconds = max(0.0, microtime(true) - $start);
            self::record((int) $line, (int) $column, 'time', $seconds, null, sprintf('%.5fs', $seconds));
            return $value;
        }

        /**
         * time() for a variable the context takes by reference (see captureRef()).
         * @return mixed a reference to $value
         */
        public static function &timeRef($line, $column, &$value)
        {
            self::time($line, $column);
            return $value;
        }

        private static function record($line, $column, $type, $value, $label, $preview)
        {
            $key = $line . ':' . $column;
            if (isset(self::$records[$key])) {
                self::$records[$key]['hits']++;
                self::$records[$key]['type'] = $type;
                if ($label !== null && $label !== '') self::$records[$key]['label'] = (string) $label;
                // Loops: an identical scalar does not need to be dumped again.
                if ($preview === null && (is_scalar($value) || $value === null)
                    && array_key_exists($key, self::$scalars) && self::$scalars[$key] === $value) {
                    return;
                }
            } else {
                self::$records[$key] = ['line' => $line, 'column' => $column, 'type' => $type, 'preview' => '', 'value' => null, 'hits' => 1];
                if ($label !== null && $label !== '') self::$records[$key]['label'] = (string) $label;
            }

            if ($preview === null) {
                $preview = Capture::quietly(function () use ($value) {
                    try {
                        return Dumper::preview($value, self::PREVIEW_LENGTH);
                    } catch (\Throwable $e) {
                        return is_object($value) ? get_class($value) : gettype($value);
                    }
                });
            }
            self::$records[$key]['preview'] = (string) $preview;
            self::$records[$key]['value'] = Capture::dumpValue($value, self::$limits);
            if (is_scalar($value) || $value === null) {
                self::$scalars[$key] = $value;
            } else {
                unset(self::$scalars[$key]);
            }
        }

        /** @return array[] MagicValue records sorted by line and column */
        public static function values()
        {
            $values = array_values(self::$records);
            usort($values, function ($a, $b) {
                return [$a['line'], $a['column']] <=> [$b['line'], $b['column']];
            });
            return $values;
        }
    }
}
