<?php

namespace Tinkerbox {
    /**
     * Run-mode event capture (docs/ARCHITECTURE.md §1.4).
     *
     * Echo output, dump()/dd()/var_dump()/tw() values and database queries become ONE ordered list of
     * `OutputEvent`s with a global `seq`. Values are dumped with `Dumper::dump()` at capture time. Line numbers
     * are editor lines (lineOffset applied).
     *
     * Output capture (buffered mode) uses an output buffer whose handler runs after every write (chunk size 1),
     * so text lands in the event list in exactly the order it was produced, also when dumps or queries are
     * recorded while a user's own `ob_start()` buffer is active. Nested user buffers keep working normally.
     *
     * Also records the coverage markers inserted by the CodeTransformer (`cover()`), with `tick()` as the
     * declare(ticks=1) fallback.
     */
    final class Capture
    {
        const MAX_EVENTS = 1000;
        /** Total echo text kept (bytes); a runaway loop must not exhaust memory before the envelope is written. */
        const MAX_ECHO_BYTES = 10485760;
        const MAX_COVERAGE_LINES = 10000;
        const TRUNCATED_TEXT = '… output truncated';

        /** @var array[] OutputEvent arrays */
        private static $events = [];
        private static $seq = 0;
        /** Events dropped once MAX_EVENTS was reached. */
        private static $dropped = 0;
        private static $echoBytes = 0;
        private static $echoTruncated = false;

        private static $limits = ['maxDepth' => 8, 'maxItems' => 500, 'maxStringLength' => 10000];
        private static $realtime = false;
        private static $captureQueries = true;
        private static $lineOffset = 1;
        /** File name PHP reports for the eval()'d user code (set right before eval). */
        private static $evalFile = null;
        /** @var string[] files/directories of the runner itself (bundle or dev sources) */
        private static $runnerPaths = null;

        /** ob_get_level() of the capture buffer; 0 when not buffering (realtime mode). */
        private static $bufferLevel = 0;
        /** ob_get_level() when the user's code started in realtime mode (buffers above it are the user's). */
        private static $realtimeLevel = 0;
        /** While values are dumped, stray output (e.g. from __toString / render()) is discarded. */
        private static $dumping = 0;

        /** @var array<int, bool> editor lines recorded by cover() / tick() */
        private static $covered = [];
        /** @var array<int, int[]> statement start line => lines covered when it runs (from the transformer) */
        private static $coverageMap = [];

        /** dd() was called (the run ended through exit). */
        public static $exited = false;

        /**
         * @param array $options    RunOptions
         * @param int   $lineOffset editor line of the first evaluated line
         */
        public static function configure(array $options, $lineOffset = 1)
        {
            self::$limits = [
                'maxDepth' => isset($options['maxDepth']) ? max(1, (int) $options['maxDepth']) : 8,
                'maxItems' => isset($options['maxItems']) ? max(1, (int) $options['maxItems']) : 500,
                'maxStringLength' => isset($options['maxStringLength']) ? max(1, (int) $options['maxStringLength']) : 10000,
            ];
            self::$realtime = isset($options['outputType']) && $options['outputType'] === 'realtime';
            self::$captureQueries = !isset($options['captureQueries']) || (bool) $options['captureQueries'];
            self::$lineOffset = max(1, (int) $lineOffset);
        }

        /** @return array{maxDepth: int, maxItems: int, maxStringLength: int} */
        public static function limits()
        {
            return self::$limits;
        }

        public static function setEvalFile($file)
        {
            self::$evalFile = (string) $file;
        }

        /** @param array<int, int[]> $map */
        public static function setCoverageMap(array $map)
        {
            self::$coverageMap = $map;
        }

        // ------------------------------------------------------------------------------------------------
        // Output buffering
        // ------------------------------------------------------------------------------------------------

        /** Start capturing echo output into events (buffered mode). */
        public static function startBuffering()
        {
            if (self::$bufferLevel > 0) return;
            if (ob_start([self::class, 'handleOutput'], 1)) self::$bufferLevel = ob_get_level();
        }

        /** Realtime mode: remember the output buffer level the user's code starts at. */
        public static function startRealtime()
        {
            self::$realtimeLevel = ob_get_level();
        }

        /** True when an output buffer the user's code opened (ob_start()) is active. */
        private static function userBufferActive()
        {
            return ob_get_level() > (self::$bufferLevel > 0 ? self::$bufferLevel : self::$realtimeLevel);
        }

        /**
         * Output handler of the capture buffer: every chunk becomes (or extends) an `echo` event.
         * @internal
         */
        public static function handleOutput($buffer, $phase = 0)
        {
            if ($buffer !== '' && self::$dumping === 0) self::pushEcho($buffer, null);
            return '';
        }

        /** Move pending buffered output into an `echo` event (call before recording any other event). */
        public static function flushOutput()
        {
            if (self::$bufferLevel > 0 && ob_get_level() === self::$bufferLevel) ob_flush();
        }

        /**
         * Close output buffers the user code left open (their content is passed down into the capture buffer,
         * like PHP does at the end of a request), then the capture buffer itself.
         */
        public static function stopBuffering()
        {
            if (self::$bufferLevel === 0) return;
            while (ob_get_level() > self::$bufferLevel) {
                if (@ob_end_flush()) continue;
                // A non-removable user buffer (ob_start(null, 0, 0)) cannot be closed: PHP flushes it at exit,
                // after the envelope. Record what it holds now (pass it down when it is flushable).
                if (ob_get_level() === self::$bufferLevel + 1) {
                    $pending = ob_get_contents();
                    if (is_string($pending) && $pending !== '' && !@ob_flush()) self::pushEcho($pending, null);
                }
                break;
            }
            if (ob_get_level() === self::$bufferLevel) ob_end_flush();
            self::$bufferLevel = 0;
        }

        /** True when echo output is currently going into our capture buffer (not a user buffer). */
        private static function capturing()
        {
            return self::$bufferLevel > 0 && ob_get_level() === self::$bufferLevel;
        }

        // ------------------------------------------------------------------------------------------------
        // Events
        // ------------------------------------------------------------------------------------------------

        /**
         * Rewritten `echo a, b;` statements (`\Tinkerbox\Capture::echoAt(L, a, b)`).
         * @param int $line editor line of the echo statement
         */
        public static function echoAt($line, ...$parts)
        {
            $text = '';
            foreach ($parts as $part) $text .= $part; // same string conversion (and errors) as echo
            if (self::$dumping > 0) {
                // Output of __toString / __debugInfo while the runner dumps a value is not the program's
                // output: plain echo, which the capture buffer discards like any other stray output.
                echo $text;
                return;
            }
            if (!self::capturing()) {
                // Realtime mode, or a user `ob_start()` buffer is active: behave exactly like echo.
                echo $text;
                if (self::$realtime && self::$bufferLevel === 0) flush();
                return;
            }
            self::flushOutput();
            self::pushEcho($text, (int) $line);
        }

        /**
         * Rewritten calls of the global dump() / dd() / var_dump() in the user code.
         * One `dump` event per value (string keys from named arguments become labels).
         *
         * @param int    $line   editor line of the call
         * @param string $fn     dump | dd | var_dump
         * @param array  $values call arguments
         * @return mixed the first value (dump), null (var_dump); dd() does not return
         */
        public static function dumpAt($line, $fn, $values)
        {
            $fn = strtolower((string) $fn);
            $values = is_array($values) ? $values : [$values];
            if (!$values && $fn === 'var_dump') {
                throw new \ArgumentCountError('var_dump() expects at least 1 argument, 0 given');
            }
            if ($fn === 'var_dump' && self::userBufferActive()) {
                // The user's own ob_start() buffer is active (`ob_start(); var_dump($x); $s = ob_get_clean();`):
                // keep var_dump()'s text output so the buffer receives it (buffered and realtime mode).
                \var_dump(...array_values($values));
                return null;
            }
            self::flushOutput();
            // Like Symfony's dump(): a call without arguments dumps a bug marker ("I got here").
            $dumped = $values ? $values : ['🐛'];
            foreach ($dumped as $key => $value) {
                self::pushDump($value, (int) $line, null, true, is_string($key) ? $key : null);
            }
            if ($fn === 'dd') {
                self::$exited = true;
                exit(0);
            }
            if ($fn === 'var_dump' || !$values) return null;
            return reset($values);
        }

        /** Collects call arguments (incl. named arguments) for rewritten dump calls. */
        public static function args(...$args)
        {
            return $args;
        }

        /**
         * dump() reaching Symfony's VarDumper (project code, Collection::dump(), Laravel's dd()…) and the
         * global helpers. The call site comes from the backtrace.
         *
         * @param mixed       $value
         * @param string|null $label VarDumper label (Symfony >= 6.3) or tw() label
         */
        public static function dumpFromHandler($value, $label = null)
        {
            self::flushOutput();
            if ($value instanceof \Symfony\Component\VarDumper\Caster\ScalarStub) $value = $value->value;
            $site = self::callSite();
            self::pushDump($value, $site['line'], $site['file'], $site['userCode'], $label === null ? null : (string) $label);
        }

        /**
         * Implementation of the global dump()/dd() helpers (when the project has no VarDumper).
         * @return mixed first value
         */
        public static function helperDump($fn, array $values)
        {
            self::flushOutput();
            $site = self::callSite();
            foreach ($values ? $values : ['🐛'] as $key => $value) {
                self::pushDump($value, $site['line'], $site['file'], $site['userCode'], is_string($key) ? $key : null);
            }
            if ($fn === 'dd') {
                self::$exited = true;
                exit(0);
            }
            return $values ? reset($values) : null;
        }

        /**
         * Record a database query (the listener drivers receive in listenForQueries()).
         *
         * @param string $sql
         * @param array  $bindings positional (`?`) or named (`:name`) bindings
         * @param float  $timeMs
         * @param string $connection
         */
        public static function query($sql, $bindings = [], $timeMs = 0.0, $connection = 'default')
        {
            if (!self::$captureQueries) return;
            self::flushOutput();
            $bindings = is_array($bindings) ? $bindings : [$bindings];
            $event = [
                'seq' => 0,
                'kind' => 'query',
                'sql' => (string) $sql,
                'bindings' => array_values(array_map([self::class, 'bindingText'], $bindings)),
                'rawSql' => self::interpolate((string) $sql, $bindings),
                'timeMs' => is_numeric($timeMs) && is_finite((float) $timeMs) ? round((float) $timeMs, 3) : 0.0,
                'connection' => $connection === null ? 'default' : (string) $connection,
            ];
            $line = self::userLine();
            if ($line !== null) $event['line'] = $line;
            self::push($event);
        }

        /**
         * Dump a value with the run limits; never throws (a broken __debugInfo must not break the run).
         * @param array|null $limits defaults to the run limits
         * @return array DumpNode
         */
        public static function dumpValue($value, $limits = null)
        {
            self::$dumping++;
            try {
                return Dumper::dump($value, is_array($limits) ? $limits : self::$limits);
            } catch (\Throwable $e) {
                $message = 'Unable to dump value: ' . get_class($e) . ': ' . $e->getMessage();
                return ['t' => 'string', 'v' => $message, 'len' => strlen($message)];
            } finally {
                self::$dumping--;
            }
        }

        /** Discard stray output while running $fn (dumping, previews). */
        public static function quietly(callable $fn)
        {
            self::$dumping++;
            try {
                return $fn();
            } finally {
                self::$dumping--;
            }
        }

        private static function pushEcho($text, $line)
        {
            $text = (string) $text;
            if ($text === '') return;
            if (self::$echoBytes >= self::MAX_ECHO_BYTES) {
                self::$echoTruncated = true;
                return;
            }
            $room = self::MAX_ECHO_BYTES - self::$echoBytes;
            if (strlen($text) > $room) {
                $text = (string) substr($text, 0, $room);
                self::$echoTruncated = true;
            }
            self::$echoBytes += strlen($text);

            // Consecutive output from the same place (loops, print/printf between events) forms one event.
            $last = count(self::$events) - 1;
            if ($last >= 0 && self::$events[$last]['kind'] === 'echo') {
                $lastLine = isset(self::$events[$last]['line']) ? self::$events[$last]['line'] : null;
                if ($lastLine === $line) {
                    self::$events[$last]['text'] .= $text;
                    return;
                }
            }
            $event = ['seq' => 0, 'kind' => 'echo', 'text' => $text];
            if ($line !== null) $event['line'] = $line;
            self::push($event);
        }

        private static function pushDump($value, $line, $file, $userCode, $label)
        {
            if (count(self::$events) >= self::MAX_EVENTS) {
                self::$dropped++;
                return;
            }
            $event = ['seq' => 0, 'kind' => 'dump', 'value' => self::dumpValue($value)];
            if ($line !== null) $event['line'] = (int) $line;
            if ($file !== null && $file !== '') $event['file'] = (string) $file;
            $event['userCode'] = (bool) $userCode;
            if ($label !== null && $label !== '') $event['label'] = (string) $label;
            self::push($event);
        }

        private static function push(array $event)
        {
            if (count(self::$events) >= self::MAX_EVENTS) {
                self::$dropped++;
                return false;
            }
            $event['seq'] = ++self::$seq;
            self::$events[] = $event;
            return true;
        }

        /** @return array[] the ordered events (with a final truncation notice when capped) */
        public static function events()
        {
            $events = self::$events;
            if (self::$dropped > 0 || self::$echoTruncated) {
                $text = self::TRUNCATED_TEXT;
                if (self::$dropped > 0) $text .= ' (' . self::$dropped . ' more ' . (self::$dropped === 1 ? 'event' : 'events') . ')';
                $events[] = ['seq' => self::$seq + 1, 'kind' => 'echo', 'text' => $text];
            }
            return $events;
        }

        // ------------------------------------------------------------------------------------------------
        // Coverage
        // ------------------------------------------------------------------------------------------------

        /**
         * Coverage marker inserted by the CodeTransformer in front of every executable statement (key = editor
         * line) and in front of expression spans (`cover(-K) ?? expr`: negative key, must return null).
         * @return null
         */
        public static function cover($line)
        {
            self::$covered[$line] = true;
            return null;
        }

        /** declare(ticks=1) fallback: records the executing line of the user code. */
        public static function tick()
        {
            $frame = debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS, 1);
            if (isset($frame[0]['file'], $frame[0]['line']) && $frame[0]['file'] === self::$evalFile && count(self::$covered) < self::MAX_COVERAGE_LINES) {
                self::$covered[$frame[0]['line'] + self::$lineOffset - 1] = true;
            }
        }

        /** @return int[] executed editor lines, sorted */
        public static function coverage()
        {
            $lines = [];
            foreach (self::$covered as $line => $unused) {
                if (isset(self::$coverageMap[$line])) {
                    foreach (self::$coverageMap[$line] as $covered) $lines[$covered] = true;
                } elseif ($line > 0) { // negative keys are expression markers, always mapped
                    $lines[$line] = true;
                }
            }
            $lines = array_keys($lines);
            sort($lines, SORT_NUMERIC);
            return array_slice($lines, 0, self::MAX_COVERAGE_LINES);
        }

        // ------------------------------------------------------------------------------------------------
        // Call sites
        // ------------------------------------------------------------------------------------------------

        /** Editor line of the innermost user-code frame on the stack, or null. */
        public static function userLine()
        {
            if (self::$evalFile === null) return null;
            foreach (debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS) as $frame) {
                if (isset($frame['file'], $frame['line']) && $frame['file'] === self::$evalFile) {
                    return $frame['line'] + self::$lineOffset - 1;
                }
            }
            return null;
        }

        /**
         * Where dump() was called: the call site of the outermost dump function (global dump/dd/tw or
         * VarDumper::dump). When that is inside vendor/ (Collection::dump(), Laravel's dd()…) or the runner,
         * the innermost user-code frame (editor line) or project frame is more useful.
         *
         * @return array{file: ?string, line: ?int, userCode: bool}
         */
        private static function callSite()
        {
            $trace = debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS);
            $site = null;
            foreach ($trace as $i => $frame) {
                $function = isset($frame['function']) ? strtolower($frame['function']) : '';
                $class = isset($frame['class']) ? ltrim($frame['class'], '\\') : '';
                if (($class === '' && ($function === 'dump' || $function === 'dd' || $function === 'tw'))
                    || ($class === 'Symfony\\Component\\VarDumper\\VarDumper' && $function === 'dump')) {
                    $site = $i;
                }
            }
            if ($site !== null && isset($trace[$site]['file'], $trace[$site]['line'])) {
                $file = $trace[$site]['file'];
                if ($file === self::$evalFile) {
                    return ['file' => null, 'line' => $trace[$site]['line'] + self::$lineOffset - 1, 'userCode' => true];
                }
                if (!self::isVendorFile($file) && !self::isRunnerFile($file)) {
                    return ['file' => $file, 'line' => (int) $trace[$site]['line'], 'userCode' => false];
                }
            }
            foreach ($trace as $frame) {
                if (isset($frame['file'], $frame['line']) && $frame['file'] === self::$evalFile) {
                    return ['file' => null, 'line' => $frame['line'] + self::$lineOffset - 1, 'userCode' => true];
                }
            }
            foreach ($trace as $frame) {
                if (isset($frame['file'], $frame['line']) && !self::isVendorFile($frame['file']) && !self::isRunnerFile($frame['file'])) {
                    return ['file' => $frame['file'], 'line' => (int) $frame['line'], 'userCode' => false];
                }
            }
            if ($site !== null && isset($trace[$site]['file'], $trace[$site]['line'])) {
                return ['file' => $trace[$site]['file'], 'line' => (int) $trace[$site]['line'], 'userCode' => false];
            }
            return ['file' => null, 'line' => null, 'userCode' => false];
        }

        private static function isVendorFile($file)
        {
            return strpos(str_replace('\\', '/', $file), '/vendor/') !== false;
        }

        /** Runner frames: the bundle ("Standard input code", vapor eval…) or the dev sources directory. */
        private static function isRunnerFile($file)
        {
            if (self::$runnerPaths === null) {
                self::$runnerPaths = [__FILE__];
                if (is_file(__FILE__)) self::$runnerPaths[] = dirname(__FILE__) . DIRECTORY_SEPARATOR;
            }
            if ($file === self::$runnerPaths[0]) return true;
            return isset(self::$runnerPaths[1]) && strpos($file, self::$runnerPaths[1]) === 0;
        }

        // ------------------------------------------------------------------------------------------------
        // SQL interpolation
        // ------------------------------------------------------------------------------------------------

        /**
         * SQL with bindings substituted for display: `?` placeholders (or `:name` for named bindings) outside
         * quoted strings/identifiers; `??` is an escaped literal `?` (PostgreSQL JSON operators).
         * Strings are quoted ('' escaped), null → NULL, bool → 1/0, DateTime → 'Y-m-d H:i:s'.
         */
        public static function interpolate($sql, array $bindings)
        {
            $sql = (string) $sql;
            $named = [];
            $positional = [];
            foreach ($bindings as $key => $value) {
                if (is_string($key)) {
                    $named[ltrim($key, ':')] = $value;
                } else {
                    $positional[] = $value;
                }
            }
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
                    } elseif ($next < count($positional)) {
                        $out .= self::sqlLiteral($positional[$next++]);
                    } else {
                        $out .= '?';
                    }
                    continue;
                }
                if ($char === ':' && $named && $following !== ':' && ($i === 0 || $sql[$i - 1] !== ':')) {
                    $name = '';
                    // [A-Za-z0-9_]+ without ctype (the runner must work on minimal PHP builds).
                    for ($j = $i + 1; $j < $length && strpos('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_', $sql[$j]) !== false; $j++) {
                        $name .= $sql[$j];
                    }
                    if ($name !== '' && array_key_exists($name, $named)) {
                        $out .= self::sqlLiteral($named[$name]);
                        $i = $j - 1;
                        continue;
                    }
                }
                $out .= $char;
            }
            return $out;
        }

        /** SQL literal of a binding for display. */
        public static function sqlLiteral($value)
        {
            if ($value === null) return 'NULL';
            if (is_bool($value)) return $value ? '1' : '0';
            if (is_int($value)) return (string) $value;
            if (is_float($value)) return is_finite($value) ? var_export($value, true) : 'NULL';
            if ($value instanceof \BackedEnum) return self::sqlLiteral($value->value);
            if ($value instanceof \UnitEnum) return self::quote($value->name);
            if ($value instanceof \DateTimeInterface) return self::quote($value->format('Y-m-d H:i:s'));
            if (is_string($value)) {
                return preg_match('//u', $value) ? self::quote($value) : '0x' . bin2hex($value);
            }
            if (is_object($value) && method_exists($value, '__toString')) {
                try {
                    return self::quote((string) $value);
                } catch (\Throwable $e) {
                    return self::quote(get_class($value));
                }
            }
            if (is_array($value)) {
                $json = json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR);
                return self::quote($json === false ? 'Array' : $json);
            }
            if (is_object($value)) return self::quote(get_class($value));
            return self::quote(gettype($value));
        }

        /** Binding as plain text (the `bindings` list of a query event). */
        public static function bindingText($value)
        {
            if ($value === null) return 'NULL';
            if (is_string($value)) return preg_match('//u', $value) ? $value : '0x' . bin2hex($value);
            if ($value instanceof \DateTimeInterface) return $value->format('Y-m-d H:i:s');
            $literal = self::sqlLiteral($value);
            if (strlen($literal) >= 2 && $literal[0] === "'" && substr($literal, -1) === "'") {
                return str_replace("''", "'", (string) substr($literal, 1, -1));
            }
            return $literal;
        }

        private static function quote($text)
        {
            return "'" . str_replace("'", "''", (string) $text) . "'";
        }
    }
}
