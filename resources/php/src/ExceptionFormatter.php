<?php

namespace Tinkerbox {
    /**
     * Collision-style exception data for the renderer (`ExceptionInfo` in src/shared/types.ts,
     * docs/ARCHITECTURE.md §1.6).
     *
     * $ctx keys (all optional):
     *   evalFile    exact file name PHP reports for the eval()'d user code, e.g. "Standard input code(812) : eval()'d code".
     *               When empty, code eval()'d directly by the runner bundle / runner sources is detected by pattern.
     *   lineOffset  editor line of the first evaluated line (selection runs); editorLine = evalLine + lineOffset - 1
     *   userCode    the original code that was run (snippet source for user-code errors)
     *   projectPath project root: project files are reported relative to it
     *   bootstrap   the error happened while bootstrapping the framework
     *
     * Frames of the runner itself (the bundle piped through stdin — "Standard input code" — or the
     * resources/php sources in development) and `Tinkerbox\` internals are stripped. Errors located in the user's
     * code report `file: ''` with `line`/`userLine` set to the editor line; their trace frames have `userCode: true`
     * and no `file`.
     */
    final class ExceptionFormatter
    {
        const MAX_PREVIOUS = 5;
        const MAX_FRAMES = 150;
        const MAX_MESSAGE_LENGTH = 65536;
        /** Lines shown before / after the failing line (9 lines in total). */
        const SNIPPET_RADIUS = 4;
        const MAX_SNIPPET_LINE_LENGTH = 1000;
        const MAX_SNIPPET_FILE_BYTES = 5242880;

        /** @var string[] Known runner calls made from rewritten user code, shown as the user wrote them. */
        private static $runnerCalls = [
            'Tinkerbox\\Capture::dumpAt' => 'dump()',
            'Tinkerbox\\Capture::echoAt' => 'echo',
            'Tinkerbox\\Magic::capture' => '{magic comment}',
            'Tinkerbox\\Magic::captureRef' => '{magic comment}',
            'Tinkerbox\\Magic::time' => '{magic comment}',
            'Tinkerbox\\Magic::timeRef' => '{magic comment}',
        ];

        /**
         * @param \Throwable $e
         * @param array $ctx see class docblock
         * @return array ExceptionInfo
         */
        public static function format(\Throwable $e, array $ctx = [])
        {
            $ctx = self::context($ctx);
            try {
                $info = self::build($e, $ctx, 0);
            } catch (\Throwable $inner) {
                // The formatter is the safety net of the envelope: degrade to the bare facts.
                $info = self::minimal(get_class($e), $e->getMessage(), (string) $e->getCode(), (string) $e->getFile(), (int) $e->getLine());
            }
            if ($ctx['bootstrap']) $info['bootstrap'] = true;
            return $info;
        }

        /**
         * Shutdown-handler fatal error (from error_get_last()).
         *
         * @param array $error ['type' => int, 'message' => string, 'file' => string, 'line' => int]
         * @param array $ctx see class docblock
         * @return array ExceptionInfo with fatal: true
         */
        public static function fatal(array $error, array $ctx = [])
        {
            $ctx = self::context($ctx);
            $type = isset($error['type']) ? (int) $error['type'] : E_ERROR;
            $file = isset($error['file']) ? (string) $error['file'] : '';
            $line = isset($error['line']) ? (int) $error['line'] : 0;
            $message = isset($error['message']) ? (string) $error['message'] : '';
            // Uncaught exceptions are reported as "Uncaught X: msg in file:line\nStack trace:\n#0 …".
            $stack = strpos($message, "\nStack trace:");
            if ($stack !== false) $message = substr($message, 0, $stack);

            try {
                $info = [
                    'class' => $type === E_PARSE ? 'ParseError' : 'FatalError',
                    'message' => self::cleanMessage($message, $ctx),
                    'code' => (string) $type,
                    'file' => $file,
                    'line' => $line,
                    'trace' => [],
                    'previous' => null,
                ];
                $origin = ['abs' => $file, 'line' => $line, 'user' => self::isUserFile($file, $ctx), 'vendor' => self::isVendor($file)];
                if ($origin['user']) {
                    $info['file'] = '';
                    $info['line'] = self::editorLine($line, $ctx);
                    $info['userLine'] = $info['line'];
                } else {
                    $info['file'] = self::relative($file, $ctx);
                }
                $snippet = self::snippetFor($origin, $ctx);
                if ($snippet !== null) $info['snippet'] = $snippet;
            } catch (\Throwable $inner) {
                $info = self::minimal($type === E_PARSE ? 'ParseError' : 'FatalError', $message, (string) $type, $file, $line);
            }
            $info['fatal'] = true;
            if ($ctx['bootstrap']) $info['bootstrap'] = true;
            return $info;
        }

        // -----------------------------------------------------------------------------------------------

        private static function context(array $ctx)
        {
            $projectPath = isset($ctx['projectPath']) ? rtrim((string) $ctx['projectPath'], '/\\') : '';
            $real = '';
            if ($projectPath !== '') {
                $resolved = @realpath($projectPath); // @: open_basedir warnings; realpath is only a fallback
                if (is_string($resolved) && $resolved !== $projectPath) $real = rtrim($resolved, '/\\');
            }
            return [
                'evalFile' => isset($ctx['evalFile']) ? (string) $ctx['evalFile'] : '',
                'lineOffset' => isset($ctx['lineOffset']) && is_numeric($ctx['lineOffset']) ? max(1, (int) $ctx['lineOffset']) : 1,
                'userCode' => isset($ctx['userCode']) ? (string) $ctx['userCode'] : '',
                'projectPath' => $projectPath,
                'projectReal' => $real,
                'bootstrap' => !empty($ctx['bootstrap']),
            ];
        }

        private static function build(\Throwable $e, array $ctx, $level)
        {
            $file = (string) $e->getFile();
            $line = (int) $e->getLine();
            $frames = self::frames($e->getTrace(), $ctx);

            // Where the error is reported: the throw site, unless that is runner code (then the nearest caller).
            $origin = ['abs' => $file, 'line' => $line, 'user' => self::isUserFile($file, $ctx), 'vendor' => false];
            if (!$origin['user'] && self::isRunnerFile($file)) {
                foreach ($frames as $frame) {
                    if ($frame['abs'] !== null) {
                        $origin = ['abs' => $frame['abs'], 'line' => $frame['rawLine'], 'user' => $frame['user'], 'vendor' => $frame['vendor']];
                        break;
                    }
                }
            }
            $origin['vendor'] = !$origin['user'] && self::isVendor($origin['abs']);

            $info = [
                'class' => self::cleanClass(get_class($e)),
                'message' => self::cleanMessage((string) $e->getMessage(), $ctx),
                'code' => (string) $e->getCode(),
                'file' => $origin['user'] ? '' : self::relative($origin['abs'], $ctx),
                'line' => $origin['user'] ? self::editorLine($origin['line'], $ctx) : $origin['line'],
            ];
            if ($origin['user']) {
                $info['userLine'] = $info['line'];
            } else {
                foreach ($frames as $frame) {
                    if ($frame['user']) {
                        $info['userLine'] = $frame['out']['line'];
                        break;
                    }
                }
            }

            // Collision: show the code where it went wrong — the user's code or the first non-vendor project
            // file on the way out, else the throw site itself.
            $snippet = null;
            $candidates = array_merge([$origin], array_map(function ($frame) {
                return ['abs' => $frame['abs'], 'line' => $frame['rawLine'], 'user' => $frame['user'], 'vendor' => $frame['vendor']];
            }, $frames));
            foreach ($candidates as $candidate) {
                if ($candidate['abs'] === null) continue;
                if ($candidate['user'] || (!$candidate['vendor'] && self::isProjectFile($candidate['abs'], $ctx))) {
                    $snippet = self::snippetFor($candidate, $ctx);
                    if ($snippet !== null) break;
                }
            }
            if ($snippet === null) $snippet = self::snippetFor($origin, $ctx);
            if ($snippet !== null) $info['snippet'] = $snippet;

            $trace = [];
            foreach ($frames as $frame) $trace[] = $frame['out'];
            if (count($trace) > self::MAX_FRAMES) {
                $hidden = count($trace) - self::MAX_FRAMES;
                $trace = array_slice($trace, 0, self::MAX_FRAMES);
                $trace[] = ['call' => '… ' . $hidden . ' more frames'];
            }
            $info['trace'] = $trace;

            $previous = $e->getPrevious();
            $info['previous'] = $previous !== null && $level < self::MAX_PREVIOUS ? self::build($previous, $ctx, $level + 1) : null;
            return $info;
        }

        /**
         * Process getTrace() frames: drop runner frames, classify user / vendor frames, map editor lines.
         *
         * @return array<int, array{abs: ?string, rawLine: int, user: bool, vendor: bool, out: array}>
         */
        private static function frames(array $trace, array $ctx)
        {
            $frames = [];
            foreach ($trace as $frame) {
                if (!is_array($frame)) continue;
                $file = isset($frame['file']) && is_string($frame['file']) ? $frame['file'] : null;
                $line = isset($frame['line']) ? (int) $frame['line'] : 0;
                $class = isset($frame['class']) && is_string($frame['class']) ? $frame['class'] : '';
                $function = isset($frame['function']) && is_string($frame['function']) ? $frame['function'] : '';
                $type = isset($frame['type']) && is_string($frame['type']) ? $frame['type'] : '::';

                $user = $file !== null && self::isUserFile($file, $ctx);
                if (!$user && $file !== null && self::isRunnerFile($file)) continue;
                $internal = strpos($class, 'Tinkerbox\\') === 0 || strpos($function, 'Tinkerbox\\') === 0;
                if ($internal && !$user) continue; // runner internals invoked by the engine or by vendor code

                $call = self::callText($class, $type, $function);
                if ($user && $internal && isset(self::$runnerCalls[$class . '::' . $function])) {
                    $call = self::$runnerCalls[$class . '::' . $function];
                }
                $out = ['call' => $call];
                $vendor = false;
                if ($file !== null) {
                    if ($user) {
                        $out['line'] = self::editorLine($line, $ctx);
                        $out['userCode'] = true;
                    } else {
                        $out['file'] = self::relative($file, $ctx);
                        $out['line'] = $line;
                        $vendor = self::isVendor($file);
                        if ($vendor) $out['vendor'] = true;
                    }
                }
                $frames[] = ['abs' => $file, 'rawLine' => $line, 'user' => $user, 'vendor' => $vendor, 'out' => $out];
            }
            return $frames;
        }

        /** "App\Models\User::find()", "App\Service->run()", "{closure}()", "array_map()". */
        private static function callText($class, $type, $function)
        {
            // "{closure}", namespaced "App\{closure}" (< 8.4) and "{closure:App\Foo::bar():12}" (8.4+).
            if (strpos($function, '{closure') !== false) $function = '{closure}';
            if ($function === '') $function = '{main}';
            if ($class === '') return $function . '()';
            return self::cleanClass($class) . ($type === '->' ? '->' : '::') . $function . '()';
        }

        /**
         * Code excerpt (SNIPPET_RADIUS lines around the line) from the user's code or a readable file.
         *
         * @param array{abs: ?string, line: int, user: bool} $location
         * @return array|null CodeSnippet
         */
        private static function snippetFor(array $location, array $ctx)
        {
            $line = (int) $location['line'];
            if ($line < 1) return null;
            if ($location['user']) {
                if ($ctx['userCode'] === '') return null;
                $lines = preg_split('/\r\n|\n|\r/', $ctx['userCode']);
                $offset = $ctx['lineOffset'] - 1;
            } else {
                $file = $location['abs'];
                if (!is_string($file) || $file === '' || strpos($file, "\0") !== false || substr($file, -14) === "eval()'d code") return null;
                // @: unreadable / open_basedir-restricted files simply have no snippet.
                if (!@is_file($file) || !@is_readable($file) || (int) @filesize($file) > self::MAX_SNIPPET_FILE_BYTES) return null;
                $lines = @file($file, FILE_IGNORE_NEW_LINES);
                if (!is_array($lines)) return null;
                $offset = 0;
            }
            $total = count($lines);
            if ($line > $total) return null;
            $first = max(1, $line - self::SNIPPET_RADIUS);
            $last = min($total, $first + 2 * self::SNIPPET_RADIUS);
            $first = max(1, $last - 2 * self::SNIPPET_RADIUS);
            $excerpt = [];
            for ($i = $first; $i <= $last; $i++) {
                $text = rtrim((string) $lines[$i - 1], "\r");
                if (strlen($text) > self::MAX_SNIPPET_LINE_LENGTH) $text = self::cutUtf8($text, self::MAX_SNIPPET_LINE_LENGTH) . '…';
                $excerpt[] = $text;
            }
            return ['startLine' => $first + $offset, 'line' => $line + $offset, 'lines' => $excerpt];
        }

        // ------------------------------------------------------------------ classification

        /** The eval()'d user code (exact ctx evalFile, else code eval()'d directly by runner code). */
        private static function isUserFile($file, array $ctx)
        {
            if (!is_string($file) || $file === '') return false;
            if ($ctx['evalFile'] !== '') return $file === $ctx['evalFile'];
            if (!preg_match('/^(.*)\(\d+\) : eval\(\)\'d code$/s', $file, $m)) return false;
            return self::isRunnerFile($m[1]);
        }

        /**
         * Runner code: the bundle (all runner sources share one file name when piped through stdin, e.g.
         * "Standard input code", or an eval()'d name on Vapor) or, in development, files under resources/php/.
         */
        private static function isRunnerFile($file)
        {
            if (!is_string($file) || $file === '') return false;
            if ($file === __FILE__) return true;
            $root = self::runnerRoot();
            if ($root === null || strpos($file, $root) !== 0) return false;
            // Code eval()'d by a runner file is not runner code (that is the user's code).
            return substr($file, -14) !== "eval()'d code";
        }

        /** resources/php/ (with trailing separator) when the runner runs from its source files, else null. */
        private static function runnerRoot()
        {
            static $root = false;
            if ($root !== false) return $root;
            $root = null;
            if (@is_file(__FILE__)) {
                $dir = dirname(__FILE__);
                if (basename($dir) === 'src') $dir = dirname($dir);
                $root = $dir . DIRECTORY_SEPARATOR;
            }
            return $root;
        }

        private static function isVendor($file)
        {
            if (!is_string($file)) return false;
            $file = str_replace('\\', '/', $file);
            return strpos($file, '/vendor/') !== false || strpos($file, 'vendor/') === 0;
        }

        /** Inside the project (or anywhere for plain-PHP runs without a project). */
        private static function isProjectFile($file, array $ctx)
        {
            if ($ctx['projectPath'] === '') return true;
            return self::relative($file, $ctx) !== $file;
        }

        private static function relative($file, array $ctx)
        {
            $file = (string) $file;
            foreach ([$ctx['projectPath'], $ctx['projectReal']] as $root) {
                if ($root === '') continue;
                $length = strlen($root);
                if (strlen($file) > $length + 1 && strncmp($file, $root, $length) === 0 && ($file[$length] === '/' || $file[$length] === '\\')) {
                    return substr($file, $length + 1);
                }
            }
            return $file;
        }

        private static function editorLine($line, array $ctx)
        {
            return max(1, (int) $line + $ctx['lineOffset'] - 1);
        }

        // ------------------------------------------------------------------ text

        /**
         * Replace references to the eval()'d buffer ("… in Standard input code(12) : eval()'d code on line 3")
         * with editor lines, and cap the length.
         */
        private static function cleanMessage($message, array $ctx)
        {
            $pattern = self::evalPattern($ctx);
            if ($pattern !== null && strpos($message, "eval()'d code") !== false) {
                $map = function ($m) use ($ctx) {
                    return self::editorLine((int) $m[1], $ctx);
                };
                $message = preg_replace_callback('/ in ' . $pattern . ' on line (\d+)/', function ($m) use ($map) {
                    return ' on line ' . $map($m);
                }, $message);
                $message = preg_replace_callback('/ in ' . $pattern . ':(\d+)/', function ($m) use ($map) {
                    return ' on line ' . $map($m);
                }, $message);
                $message = preg_replace_callback('/' . $pattern . '(?: on line |:)(\d+)/', function ($m) use ($map) {
                    return 'line ' . $map($m);
                }, $message);
                $message = preg_replace('/' . $pattern . '/', 'your code', $message);
            }
            if (strlen($message) > self::MAX_MESSAGE_LENGTH) $message = self::cutUtf8($message, self::MAX_MESSAGE_LENGTH) . '…';
            return $message;
        }

        /** Regex (without delimiters, "/"-safe, no capture groups) matching the user code's eval file name. */
        private static function evalPattern(array $ctx)
        {
            if ($ctx['evalFile'] !== '') return preg_quote($ctx['evalFile'], '/');
            $suffix = '\(\d+\) : eval\(\)\'d code';
            $alternatives = [preg_quote(__FILE__, '/')];
            $root = self::runnerRoot();
            if ($root !== null) $alternatives[] = preg_quote($root, '/') . '[^\n]*?\.php';
            return '(?:' . implode('|', $alternatives) . ')' . $suffix;
        }

        private static function cleanClass($class)
        {
            $pos = strpos($class, "\0");
            return $pos === false ? $class : substr($class, 0, $pos);
        }

        /** Cut to at most $bytes bytes without splitting a UTF-8 sequence. */
        private static function cutUtf8($text, $bytes)
        {
            $cut = substr($text, 0, $bytes);
            if (preg_match('//u', $text) !== 1) return $cut;
            while ($cut !== '' && preg_match('//u', $cut) !== 1) $cut = substr($cut, 0, -1);
            return $cut;
        }

        private static function minimal($class, $message, $code, $file, $line)
        {
            return [
                'class' => self::cleanClass((string) $class),
                'message' => (string) $message,
                'code' => (string) $code,
                'file' => (string) $file,
                'line' => (int) $line,
                'trace' => [],
                'previous' => null,
            ];
        }
    }
}
