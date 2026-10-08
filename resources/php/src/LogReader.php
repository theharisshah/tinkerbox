<?php

namespace Tinkerbox {
    /**
     * Log viewer data modes (`logs` / `logRead`, docs/ARCHITECTURE.md §1.8).
     *
     * - list($root): every *.log / *.txt below the log root (recursive, bounded), grouped by directory.
     * - read($root, $file, $limit): newest-first LogEntry[] parsed from the tail (≤ 5 MB) of one file.
     *
     * Formats: Laravel / Monolog line format (`[datetime] channel.LEVEL: message {context} {extra}` incl.
     * multi-line messages, `[stacktrace]` blocks and ISO-8601 datetimes), Monolog JSON lines, nginx error,
     * Apache error, php-fpm, PHP error_log, queue worker / Horizon output, syslog and plain text (level detected
     * by keywords). Paths are confined to the log root (realpath check) and only .log / .txt files are read.
     */
    final class LogReader
    {
        /** Only the last 5 MB of a file are read. */
        const TAIL_BYTES = 5242880;
        /** First tail window; grows ×4 until enough entries are found. */
        const MIN_WINDOW = 262144;
        const MAX_FILES = 2000;
        const MAX_DEPTH = 8;
        const DEFAULT_LIMIT = 500;
        const MAX_LIMIT = 10000;
        const MAX_MESSAGE = 20000;
        const MAX_CONTEXT = 50000;
        const MAX_STACK = 200000;
        /** JSON candidates tried per entry when splitting message / context. */
        const MAX_JSON_CANDIDATES = 24;

        const LEVELS = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'];

        const MONTHS = ['jan' => '01', 'feb' => '02', 'mar' => '03', 'apr' => '04', 'may' => '05', 'jun' => '06',
            'jul' => '07', 'aug' => '08', 'sep' => '09', 'oct' => '10', 'nov' => '11', 'dec' => '12'];

        /** ISO-8601-ish datetime: date, T or space, time, optional fraction and timezone. */
        const ISO = '\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:\s?(?:Z|[+-]\d{2}:?\d{2}|UTC|GMT))?';

        // -----------------------------------------------------------------------------------------------------
        // Listing
        // -----------------------------------------------------------------------------------------------------

        /**
         * LogListing for a log root. A missing root yields an empty listing (the app shows "no log files").
         *
         * @param string $root
         * @return array{root:string,files:array}
         */
        public static function list($root)
        {
            $root = rtrim((string) $root, '/\\');
            $listing = ['root' => $root, 'files' => []];
            $real = $root !== '' ? realpath($root) : false;
            if ($real === false || !is_dir($real)) {
                return $listing;
            }
            $base = self::slashes($real);
            $base = rtrim($base, '/') . '/';

            $files = [];
            try {
                $filter = new \RecursiveCallbackFilterIterator(
                    new \RecursiveDirectoryIterator($real, \FilesystemIterator::SKIP_DOTS),
                    function ($file) {
                        $name = $file->getFilename();
                        if ($name === '' || $name[0] === '.') {
                            return false;
                        }

                        return $file->isDir() || self::isLogFileName($name);
                    }
                );
                $iterator = new \RecursiveIteratorIterator($filter, \RecursiveIteratorIterator::LEAVES_ONLY, \RecursiveIteratorIterator::CATCH_GET_CHILD);
                $iterator->setMaxDepth(self::MAX_DEPTH);
                foreach ($iterator as $file) {
                    if (!$file->isFile()) {
                        continue;
                    }
                    $path = self::slashes($file->getPathname());
                    // Symlinks pointing outside of the root are not offered (read() would refuse them anyway).
                    $target = realpath($file->getPathname());
                    if ($target === false || strpos(self::slashes($target), $base) !== 0 || strpos($path, $base) !== 0) {
                        continue;
                    }
                    $relative = substr($path, strlen($base));
                    $slash = strrpos($relative, '/');
                    $files[] = [
                        'path' => $relative,
                        'name' => $slash === false ? $relative : substr($relative, $slash + 1),
                        'dir' => $slash === false ? '' : substr($relative, 0, $slash),
                        'size' => (int) $file->getSize(),
                        'modifiedAt' => (int) $file->getMTime() * 1000,
                    ];
                    if (count($files) >= self::MAX_FILES) {
                        break;
                    }
                }
            } catch (\Throwable $e) {
                // Unreadable sub-directories are skipped by CATCH_GET_CHILD; anything else ends the walk with
                // what was collected so far.
                if (defined('STDERR') && is_resource(STDERR)) {
                    fwrite(STDERR, '[tinkerbox] logs: listing ' . $root . ' stopped: ' . $e->getMessage() . "\n");
                }
            }

            // Root files first, then directories alphabetically; newest file first inside a directory.
            usort($files, function ($a, $b) {
                if ($a['dir'] !== $b['dir']) {
                    if ($a['dir'] === '') {
                        return -1;
                    }
                    if ($b['dir'] === '') {
                        return 1;
                    }

                    return strnatcasecmp($a['dir'], $b['dir']);
                }
                if ($a['modifiedAt'] !== $b['modifiedAt']) {
                    return $b['modifiedAt'] < $a['modifiedAt'] ? -1 : 1;
                }

                return strnatcasecmp($a['name'], $b['name']);
            });
            $listing['files'] = $files;

            return $listing;
        }

        // -----------------------------------------------------------------------------------------------------
        // Reading
        // -----------------------------------------------------------------------------------------------------

        /**
         * Newest-first entries of one log file (path relative to the root).
         *
         * @param string $root
         * @param string $file
         * @param int $limit
         * @return array LogEntry[]
         * @throws \RuntimeException for paths outside the root, missing / unreadable / non-log files
         */
        public static function read($root, $file, $limit = self::DEFAULT_LIMIT)
        {
            $path = self::resolve($root, $file);
            $limit = (int) $limit;
            if ($limit <= 0) {
                $limit = self::DEFAULT_LIMIT;
            }
            $limit = min($limit, self::MAX_LIMIT);

            list($text, $cut) = self::tail($path, $limit);
            $entries = self::parse($text, $cut, $limit);

            return array_reverse($entries);
        }

        /**
         * Resolve a log path safely: no NUL bytes, no escaping `..`, realpath inside the root, .log / .txt only.
         *
         * @return string absolute real path
         */
        public static function resolve($root, $file)
        {
            $root = (string) $root;
            $file = (string) $file;
            if ($file === '' || trim($file) === '') {
                throw new \InvalidArgumentException('No log file selected.');
            }
            if (strpos($file, "\0") !== false || strpos($root, "\0") !== false) {
                throw new \InvalidArgumentException('Invalid log file name.');
            }
            $rootReal = $root !== '' ? realpath($root) : false;
            if ($rootReal === false || !is_dir($rootReal)) {
                throw new \RuntimeException('Log directory not found: ' . $root);
            }
            $base = rtrim(self::slashes($rootReal), '/') . '/';
            $normalized = self::slashes($file);

            if (self::isAbsolute($normalized)) {
                $candidate = $normalized;
            } else {
                // Lexical check first: a relative path may never climb above the root.
                $depth = 0;
                foreach (explode('/', $normalized) as $segment) {
                    if ($segment === '..') {
                        if (--$depth < 0) {
                            throw new \RuntimeException('Refusing to read a file outside of the log directory: ' . $file);
                        }
                    } elseif ($segment !== '' && $segment !== '.') {
                        $depth++;
                    }
                }
                $candidate = $base . ltrim($normalized, '/');
            }

            $real = realpath($candidate);
            if ($real !== false && strpos(self::slashes($real), $base) !== 0) {
                throw new \RuntimeException('Refusing to read a file outside of the log directory: ' . $file);
            }
            if ($real === false || !is_file($real)) {
                throw new \RuntimeException('Log file not found: ' . $file);
            }
            if (!self::isLogFileName(basename($real))) {
                throw new \RuntimeException('Only .log and .txt files can be opened in the log viewer: ' . $file);
            }
            if (!is_readable($real)) {
                throw new \RuntimeException('Log file is not readable: ' . $file);
            }

            return $real;
        }

        /**
         * Read the end of a file: small files whole, big files in growing windows from the end (≤ TAIL_BYTES)
         * until more than $limit entries are visible.
         *
         * @return array{0:string,1:bool} [text, whether the start of the text was cut]
         */
        private static function tail($path, $limit)
        {
            clearstatcache(true, $path);
            $size = filesize($path);
            $handle = fopen($path, 'rb');
            if ($handle === false) {
                throw new \RuntimeException('Log file could not be opened: ' . basename($path));
            }
            try {
                if ($size === false || $size <= self::MIN_WINDOW) {
                    $text = stream_get_contents($handle);

                    return [is_string($text) ? $text : '', false];
                }
                $buffer = '';
                $offset = $size;
                $window = min(self::TAIL_BYTES, max(self::MIN_WINDOW, $limit * 2048));
                while (true) {
                    $start = max(0, $size - $window);
                    $buffer = self::readRange($handle, $start, $offset - $start) . $buffer;
                    $offset = $start;
                    if ($offset === 0 || $window >= self::TAIL_BYTES) {
                        break;
                    }
                    $visible = self::countHeaders($buffer);
                    if ($visible === 0) {
                        $visible = substr_count($buffer, "\n");
                    }
                    if ($visible > $limit) {
                        break;
                    }
                    $window = min(self::TAIL_BYTES, $window * 4);
                }

                if ($offset > 0) {
                    // The window starts inside the file: drop the first line unless the window happens to begin
                    // exactly at a line start (the byte before it is a newline).
                    $previous = self::readRange($handle, $offset - 1, 1);
                    if ($previous !== "\n") {
                        $newline = strpos($buffer, "\n");
                        $buffer = $newline === false ? '' : substr($buffer, $newline + 1);
                    }
                }

                return [$buffer, $offset > 0];
            } finally {
                fclose($handle);
            }
        }

        private static function readRange($handle, $start, $length)
        {
            if ($length <= 0) {
                return '';
            }
            if (fseek($handle, $start) !== 0) {
                throw new \RuntimeException('Log file could not be read (seek failed).');
            }
            $data = '';
            while (strlen($data) < $length && !feof($handle)) {
                $chunk = fread($handle, min(1048576, $length - strlen($data)));
                if ($chunk === false || $chunk === '') {
                    break;
                }
                $data .= $chunk;
            }

            return $data;
        }

        /** Approximate number of entry header lines in a buffer (used to size the tail window). */
        private static function countHeaders($text)
        {
            return (int) preg_match_all(
                '/^(?:\[\d{4}-\d{2}-\d{2}[T ]|\[\d{2}-[A-Za-z]{3}-\d{4} |\d{4}\/\d{2}\/\d{2} |\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) |[ \t]*\d{4}-\d{2}-\d{2}[T ]\d{2}:|\{")/m',
                $text
            );
        }

        /**
         * Parse log text into entries (oldest first).
         *
         * @param string $text
         * @param bool $cut the text does not start at the beginning of the file (it starts at a line boundary):
         *                  lines before the first entry header belong to an entry whose header was not read and
         *                  are dropped
         * @param int $limit only the last $limit entries are fully parsed
         * @return array LogEntry[]
         */
        public static function parse($text, $cut = false, $limit = self::MAX_LIMIT)
        {
            $text = str_replace("\r\n", "\n", (string) $text);
            // UTF-8 BOM at the start of a file.
            if (strncmp($text, "\xEF\xBB\xBF", 3) === 0) {
                $text = substr($text, 3);
            }
            if ($text === '') {
                return [];
            }
            $lines = explode("\n", $text);
            if (end($lines) === '') {
                array_pop($lines);
            }

            $raw = [];
            $preamble = [];
            $current = null;
            foreach ($lines as $line) {
                $header = self::matchHeader($line);
                if ($header !== null) {
                    if ($current !== null) {
                        $raw[] = $current;
                    }
                    $current = $header;
                    $current['lines'] = [];
                    continue;
                }
                if ($current === null) {
                    $preamble[] = $line;
                    continue;
                }
                if ($current['format'] === 'json' || ($current['format'] === 'generic' && !self::isContinuation($line))) {
                    // Line-based formats only continue with stack traces / indented lines (JSON lines never do);
                    // anything else is a stand-alone line (e.g. "Horizon started successfully." between worker lines).
                    if (trim($line) !== '') {
                        $raw[] = $current;
                        $current = self::plainRaw($line);
                    }
                    continue;
                }
                $current['lines'][] = $line;
            }
            if ($current !== null) {
                $raw[] = $current;
            }

            if (!$raw) {
                // Plain text: one entry per non-empty line.
                $plain = [];
                foreach ($preamble as $line) {
                    if (trim($line) !== '') {
                        $plain[] = $line;
                    }
                }
                $entries = [];
                foreach (array_slice($plain, -$limit) as $line) {
                    $entries[] = self::finish(self::plainRaw($line));
                }

                return $entries;
            }

            // Lines before the first header belong to an older entry when the start was cut; otherwise they are
            // stand-alone plain lines at the top of the file.
            $entries = [];
            if (!$cut) {
                $plain = [];
                foreach ($preamble as $line) {
                    if (trim($line) !== '') {
                        $plain[] = self::plainRaw($line);
                    }
                }
                $raw = array_merge($plain, $raw);
            }
            foreach (array_slice($raw, -$limit) as $item) {
                $entries[] = self::finish($item);
            }

            return $entries;
        }

        // -----------------------------------------------------------------------------------------------------
        // Header detection
        // -----------------------------------------------------------------------------------------------------

        /**
         * Detect an entry header line.
         *
         * @return array|null ['format', 'datetime', 'level', 'message', 'env'?]
         */
        private static function matchHeader($line)
        {
            if ($line === '') {
                return null;
            }
            $first = $line[0];
            if ($first === '#') {
                // Stack trace frame.
                return null;
            }
            if ($first === '[') {
                $second = isset($line[1]) ? $line[1] : '';
                if ($second >= '0' && $second <= '9') {
                    if (preg_match('/^\[(' . self::ISO . ')\]\s+([^\s\[\]]+?)\.(DEBUG|INFO|NOTICE|WARNING|ERROR|CRITICAL|ALERT|EMERGENCY)\s*:\s?(.*)$/i', $line, $m)) {
                        return ['format' => 'monolog', 'datetime' => $m[1], 'env' => $m[2], 'level' => self::normalizeLevel($m[3]), 'message' => $m[4]];
                    }
                    // php-fpm: [01-May-2024 12:00:00] WARNING: [pool www] …
                    if (preg_match('/^\[(\d{2}-[A-Za-z]{3}-\d{4} \d{2}:\d{2}:\d{2}(?:\.\d+)?)\]\s+(DEBUG|INFO|NOTICE|WARNING|ERROR|ALERT)\s*:\s+(.*)$/', $line, $m)) {
                        return ['format' => 'generic', 'datetime' => self::fromDayMonthYear($m[1]), 'level' => self::normalizeLevel($m[2]), 'message' => $m[3]];
                    }
                    // PHP error_log: [01-May-2024 12:00:00 UTC] PHP Fatal error:  …
                    if (preg_match('/^\[(\d{2}-[A-Za-z]{3}-\d{4} \d{2}:\d{2}:\d{2})(?:\s+([A-Za-z][\w\/+-]*))?\]\s+(.*)$/', $line, $m)) {
                        $datetime = self::fromDayMonthYear($m[1]) . ($m[2] !== '' ? ' ' . $m[2] : '');
                        $message = $m[3];
                        $level = null;
                        if (preg_match('/^PHP\s+(Fatal error|Parse error|Recoverable fatal error|Catchable fatal error|Warning|Notice|Deprecated|Strict Standards)\s*:\s*(.*)$/i', $message, $pm)) {
                            $level = self::normalizeLevel($pm[1]);
                            $message = $pm[1] . ': ' . $pm[2];
                        }

                        return ['format' => 'generic', 'datetime' => $datetime, 'level' => $level !== null ? $level : self::detectLevel($message), 'message' => $message];
                    }
                    // Bracketed ISO datetime without a Monolog channel (queue worker < Laravel 9, custom formats).
                    if (preg_match('/^\[(' . self::ISO . ')\]\s*(.*)$/', $line, $m)) {
                        return ['format' => 'generic', 'datetime' => $m[1], 'level' => self::detectLevel($m[2]), 'message' => $m[2]];
                    }

                    return null;
                }
                // Apache 2.4: [Wed May 01 12:00:00.123456 2024] [php:error] [pid 1] [client …] message
                // Apache 2.2: [Wed May 01 12:00:00 2024] [error] [client …] message
                if (preg_match('/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +(\d{1,2}) (\d{2}:\d{2}:\d{2})(\.\d+)? (\d{4})\] \[(?:([\w-]+):)?([\w-]+)\] ?(.*)$/', $line, $m)) {
                    $datetime = $m[5] . '-' . self::MONTHS[strtolower($m[1])] . '-' . str_pad($m[2], 2, '0', STR_PAD_LEFT) . ' ' . $m[3] . $m[4];
                    $message = preg_replace('/^\[pid \d+(?::tid \d+)?\]\s*/', '', $m[8]);
                    $entry = ['format' => 'generic', 'datetime' => $datetime, 'level' => self::normalizeLevel($m[7]), 'message' => $message];
                    if ($m[6] !== '') {
                        $entry['env'] = $m[6];
                    }

                    return $entry;
                }

                return null;
            }
            if ($first === '{') {
                return self::matchJsonLine($line);
            }
            if ($first >= '0' && $first <= '9') {
                // nginx: 2024/05/01 12:00:00 [error] 123#0: *1 message
                if (preg_match('#^(\d{4})/(\d{2})/(\d{2}) (\d{2}:\d{2}:\d{2}) \[(debug|info|notice|warn|error|crit|alert|emerg)\] (.*)$#', $line, $m)) {
                    return ['format' => 'generic', 'datetime' => $m[1] . '-' . $m[2] . '-' . $m[3] . ' ' . $m[4], 'level' => self::normalizeLevel($m[5]), 'message' => $m[6]];
                }
                if (preg_match('/^(' . self::ISO . ')\s*(.*)$/', $line, $m)) {
                    return self::isoHeader($m[1], $m[2]);
                }

                return null;
            }
            if ($first === ' ' || $first === "\t") {
                // Queue worker / Horizon output (Laravel ≥ 9): "  2024-05-01 12:00:00 App\Jobs\X ...... 3ms DONE"
                if (preg_match('/^[ \t]+(' . self::ISO . ')\s+(.*)$/', $line, $m)) {
                    return self::isoHeader($m[1], $m[2]);
                }

                return null;
            }
            // syslog: May  1 12:00:00 host program[123]: message
            if (preg_match('/^((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) +\d{1,2} \d{2}:\d{2}:\d{2}) (\S+) ([^:\[\s]+)(?:\[\d+\])?: (.*)$/', $line, $m)) {
                $message = $m[3] . ': ' . $m[4];

                return ['format' => 'generic', 'datetime' => $m[1], 'level' => self::detectLevel($m[4]), 'message' => $message];
            }

            return null;
        }

        private static function isoHeader($datetime, $message)
        {
            // Collapse the dot leaders of console task output ("App\Jobs\X ........ 3ms DONE").
            $message = preg_replace('/\s*\.{4,}\s*/', ' … ', $message);

            return ['format' => 'generic', 'datetime' => $datetime, 'level' => self::detectLevel($message), 'message' => $message];
        }

        /** Monolog JsonFormatter lines and other JSON-per-line logs with a message field. */
        private static function matchJsonLine($line)
        {
            $data = json_decode($line, true);
            if (!is_array($data)) {
                return null;
            }
            $message = self::firstScalar($data, ['message', 'msg', 'text']);
            $datetime = self::firstScalar($data, ['datetime', 'time', 'timestamp', '@timestamp', 'date', 'ts']);
            $levelRaw = self::firstScalar($data, ['level_name', 'levelname', 'level', 'severity', 'loglevel']);
            // A JSON payload printed inside a multi-line message is not a log record: require a message plus a
            // datetime or level field.
            if ($message === null || ($datetime === null && $levelRaw === null)) {
                return null;
            }
            if ($levelRaw !== null && is_numeric($levelRaw)) {
                $levelRaw = self::monologNumericLevel((int) $levelRaw);
            }
            $entry = [
                'format' => 'json',
                'datetime' => $datetime !== null ? (string) $datetime : '',
                'level' => $levelRaw !== null ? self::normalizeLevel((string) $levelRaw) : self::detectLevel((string) $message),
                'message' => (string) $message,
                'data' => $data,
            ];
            $channel = self::firstScalar($data, ['channel', 'env', 'environment']);
            if ($channel !== null && $channel !== '') {
                $entry['env'] = (string) $channel;
            }

            return $entry;
        }

        // -----------------------------------------------------------------------------------------------------
        // Entry building
        // -----------------------------------------------------------------------------------------------------

        private static function finish(array $raw)
        {
            $entry = ['datetime' => $raw['datetime']];
            if (isset($raw['env'])) {
                $entry['env'] = $raw['env'];
            }
            $entry['level'] = $raw['level'];

            if ($raw['format'] === 'json') {
                return self::finishJson($entry, $raw);
            }

            $body = $raw['message'];
            if ($raw['lines']) {
                $body .= "\n" . implode("\n", $raw['lines']);
            }
            $body = rtrim($body);

            $context = null;
            $stack = null;
            if ($raw['format'] === 'monolog') {
                list($message, $context, $stack) = self::splitMonolog($body);
            } else {
                list($message, $stack) = self::splitStackTrace($body);
            }

            $entry['message'] = self::truncate($message, self::MAX_MESSAGE);
            if ($context !== null && $context !== '') {
                $entry['context'] = self::truncate($context, self::MAX_CONTEXT);
            }
            if ($stack !== null && $stack !== '') {
                $entry['stack'] = self::truncate($stack, self::MAX_STACK);
            }

            return $entry;
        }

        /** Raw entry for a line without a recognizable header (no datetime, level from keywords). */
        private static function plainRaw($line)
        {
            $line = rtrim($line);

            return ['format' => 'generic', 'datetime' => '', 'level' => self::detectLevel($line), 'message' => $line, 'lines' => []];
        }

        /** Continuation of a line-based entry: indented lines, stack frames and PHP's exception trailer lines. */
        private static function isContinuation($line)
        {
            return $line === ''
                || $line[0] === ' '
                || $line[0] === "\t"
                || (bool) preg_match('/^(?:#\d|Stack trace:|PHP Stack trace:|PHP\s+\d+\.|thrown in|Next [A-Za-z\\\\_]|Caused by|\{main\})/', $line);
        }

        private static function finishJson(array $entry, array $raw)
        {
            $data = $raw['data'];
            $entry['message'] = self::truncate($raw['message'], self::MAX_MESSAGE);
            $context = isset($data['context']) ? $data['context'] : null;
            $extra = isset($data['extra']) ? $data['extra'] : null;
            if ($context === null && $extra === null) {
                // Generic JSON log: everything except the fields shown elsewhere is context.
                $context = array_diff_key($data, array_flip(['message', 'msg', 'text', 'datetime', 'time', 'timestamp', '@timestamp', 'date', 'ts', 'level_name', 'levelname', 'level', 'severity', 'loglevel', 'channel']));
            }
            $stack = null;
            if (is_array($context)) {
                list($context, $stack) = self::extractException($context);
            }
            $contextText = self::contextText($context, $extra);
            if ($contextText !== '') {
                $entry['context'] = self::truncate($contextText, self::MAX_CONTEXT);
            }
            if ($stack !== null && $stack !== '') {
                $entry['stack'] = self::truncate($stack, self::MAX_STACK);
            }

            return $entry;
        }

        /**
         * Split a Monolog line body (`message {context} {extra}`, possibly spanning lines) into message, pretty
         * context JSON and stack trace.
         *
         * @return array{0:string,1:?string,2:?string}
         */
        private static function splitMonolog($body)
        {
            $length = strlen($body);
            $tries = 0;
            $offset = 0;
            while ($offset < $length && $tries < self::MAX_JSON_CANDIDATES) {
                $position = strcspn($body, '{[', $offset) + $offset;
                if ($position >= $length) {
                    break;
                }
                $offset = $position + 1;
                if ($position > 0 && strpos(" \n\t\r", $body[$position - 1]) === false) {
                    continue;
                }
                $tries++;
                $end = self::jsonValueEnd($body, $position);
                if ($end === null) {
                    continue;
                }
                $rest = trim(substr($body, $end + 1));
                $extra = null;
                if ($rest !== '') {
                    $restEnd = ($rest[0] === '{' || $rest[0] === '[') ? self::jsonValueEnd($rest, 0) : null;
                    if ($restEnd === null || $restEnd !== strlen($rest) - 1) {
                        continue;
                    }
                    $extra = self::decodeJson($rest);
                    if ($extra === null) {
                        continue;
                    }
                }
                $context = self::decodeJson(substr($body, $position, $end - $position + 1));
                if ($context === null) {
                    continue;
                }
                $message = rtrim(substr($body, 0, $position));
                list($context, $stack) = self::extractException($context);
                $contextText = self::contextText($context, $extra);

                return [$message, $contextText !== '' ? $contextText : null, $stack];
            }

            // No parseable context (truncated / malformed JSON): recover message and stack textually.
            $marker = strpos($body, '[stacktrace]');
            if ($marker !== false) {
                $head = rtrim(substr($body, 0, $marker));
                $stack = trim(substr($body, $marker + strlen('[stacktrace]')));
                $stack = preg_replace('/"\s*\}\s*(?:\[\]|\{\})?\s*$/', '', $stack);
                $stack = self::unescapeJsonText(rtrim($stack));
                $exceptionAt = strpos($head, ' {"exception":"');
                $context = null;
                if ($exceptionAt !== false) {
                    $summary = self::unescapeJsonText(substr($head, $exceptionAt + strlen(' {"exception":"')));
                    $head = rtrim(substr($head, 0, $exceptionAt));
                    $context = self::encodePretty(['exception' => rtrim($summary)]);
                }

                return [$head, $context, $stack !== '' ? $stack : null];
            }
            list($message, $stack) = self::splitStackTrace($body);

            return [$message, null, $stack];
        }

        /**
         * Pull the stack trace out of a normalized exception in the context: Laravel's
         * "[object] (Class(code: 0): msg at file:line)\n[stacktrace]\n#0 …" strings and NormalizerFormatter arrays
         * ({class, message, code, file, trace: []}).
         *
         * @return array{0:mixed,1:?string} [context without the trace, stack]
         */
        private static function extractException($context)
        {
            if (!is_array($context) || !isset($context['exception'])) {
                return [$context, null];
            }
            $exception = $context['exception'];
            if (is_string($exception)) {
                $marker = strpos($exception, '[stacktrace]');
                if ($marker !== false) {
                    $context['exception'] = rtrim(substr($exception, 0, $marker));
                    $stack = trim(substr($exception, $marker + strlen('[stacktrace]')));

                    return [$context, $stack !== '' ? $stack : null];
                }

                return [$context, null];
            }
            if (is_array($exception) && isset($exception['trace']) && is_array($exception['trace'])) {
                $frames = [];
                foreach (array_values($exception['trace']) as $index => $frame) {
                    $frames[] = '#' . $index . ' ' . (is_scalar($frame) ? (string) $frame : self::encodeCompact($frame));
                }
                unset($exception['trace']);
                $context['exception'] = $exception;

                return [$context, $frames ? implode("\n", $frames) : null];
            }

            return [$context, null];
        }

        /** Pretty JSON of context (+ extra); '' when both are empty. */
        private static function contextText($context, $extra)
        {
            $parts = [];
            if ($context !== null && $context !== [] && $context !== '') {
                $parts[] = is_array($context) ? self::encodePretty($context) : (string) $context;
            }
            if ($extra !== null && $extra !== [] && $extra !== '') {
                $parts[] = is_array($extra) ? self::encodePretty($extra) : (string) $extra;
            }

            return implode("\n", $parts);
        }

        /**
         * Split "message\nStack trace:\n#0 …" (PHP uncaught exceptions) / "[stacktrace]" blocks.
         *
         * @return array{0:string,1:?string}
         */
        private static function splitStackTrace($body)
        {
            if (preg_match('/^(.*?)\n(?:PHP\s+)?(?:Stack trace:|\[stacktrace\])\s*\n(.*)$/s', $body, $m)) {
                return [rtrim($m[1]), trim($m[2]) !== '' ? trim($m[2]) : null];
            }

            return [$body, null];
        }

        // -----------------------------------------------------------------------------------------------------
        // JSON helpers
        // -----------------------------------------------------------------------------------------------------

        /**
         * Index of the bracket closing the JSON object / array starting at $start (string-aware), or null.
         * Uses strcspn jumps so long stack traces inside JSON strings are skipped quickly.
         */
        private static function jsonValueEnd($text, $start)
        {
            $length = strlen($text);
            $depth = 0;
            $i = $start;
            while ($i < $length) {
                $char = $text[$i];
                if ($char === '"') {
                    $i++;
                    while (true) {
                        if ($i >= $length) {
                            return null;
                        }
                        $i += strcspn($text, '"\\', $i);
                        if ($i >= $length) {
                            return null;
                        }
                        if ($text[$i] === '\\') {
                            $i += 2;
                            continue;
                        }
                        break;
                    }
                    $i++;
                } elseif ($char === '{' || $char === '[') {
                    $depth++;
                    $i++;
                } elseif ($char === '}' || $char === ']') {
                    $depth--;
                    if ($depth === 0) {
                        return $i;
                    }
                    if ($depth < 0) {
                        return null;
                    }
                    $i++;
                } else {
                    $i++;
                }
                if ($i < $length) {
                    $i += strcspn($text, '"{}[]', $i);
                }
            }

            return null;
        }

        /**
         * Decode JSON that may contain raw line breaks inside strings (Monolog's allowInlineLineBreaks).
         *
         * @return array|null
         */
        private static function decodeJson($json)
        {
            $data = json_decode($json, true, 512, JSON_BIGINT_AS_STRING);
            if (is_array($data)) {
                return $data;
            }
            if (strpbrk($json, "\n\r\t") === false) {
                return null;
            }
            $data = json_decode(str_replace(["\r", "\n", "\t"], ['\r', '\n', '\t'], $json), true, 512, JSON_BIGINT_AS_STRING);

            return is_array($data) ? $data : null;
        }

        /** Undo JSON string escaping in text recovered from a broken JSON context. */
        private static function unescapeJsonText($text)
        {
            return preg_replace_callback('/\\\\(["\\\\\/bfnrt]|u[0-9a-fA-F]{4})/', function ($m) {
                $map = ['"' => '"', '\\' => '\\', '/' => '/', 'b' => "\x08", 'f' => "\f", 'n' => "\n", 'r' => "\r", 't' => "\t"];
                if (isset($map[$m[1]])) {
                    return $map[$m[1]];
                }
                $decoded = json_decode('"\\' . $m[1] . '"');

                return is_string($decoded) ? $decoded : $m[0];
            }, $text);
        }

        private static function encodePretty($value)
        {
            $flags = JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE;
            $json = json_encode($value, $flags);

            return is_string($json) ? $json : '';
        }

        private static function encodeCompact($value)
        {
            $json = json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE);

            return is_string($json) ? $json : '';
        }

        // -----------------------------------------------------------------------------------------------------
        // Levels & small helpers
        // -----------------------------------------------------------------------------------------------------

        /** Map format-specific level names onto debug / info / notice / warning / error / critical / alert / emergency. */
        public static function normalizeLevel($level)
        {
            $level = strtolower(trim((string) $level));
            static $map = [
                'warn' => 'warning', 'err' => 'error', 'crit' => 'critical', 'emerg' => 'emergency', 'fatal' => 'critical',
                'fatal error' => 'critical', 'parse error' => 'critical', 'recoverable fatal error' => 'error',
                'catchable fatal error' => 'error', 'deprecated' => 'notice', 'strict standards' => 'notice',
                'exception' => 'error', 'fail' => 'error', 'failed' => 'error', 'failure' => 'error', 'trace' => 'debug',
                'verbose' => 'debug', 'information' => 'info', 'informational' => 'info', 'severe' => 'critical',
            ];
            if (in_array($level, self::LEVELS, true)) {
                return $level;
            }
            if (isset($map[$level])) {
                return $map[$level];
            }
            if (preg_match('/^trace\d$/', $level)) {
                return 'debug';
            }

            return 'info';
        }

        /** Level of a free-text line: the first severity keyword wins; no keyword → info. */
        public static function detectLevel($text)
        {
            if (preg_match('/\b(emergency|emerg|alert|critical|crit|fatal|error|err|exception|fail(?:ed|ure)?|warning|warn|deprecated|notice|info|debug)\b/i', (string) $text, $m)) {
                return self::normalizeLevel($m[1]);
            }

            return 'info';
        }

        private static function monologNumericLevel($level)
        {
            if ($level >= 600) {
                return 'emergency';
            }
            if ($level >= 550) {
                return 'alert';
            }
            if ($level >= 500) {
                return 'critical';
            }
            if ($level >= 400) {
                return 'error';
            }
            if ($level >= 300) {
                return 'warning';
            }
            if ($level >= 250) {
                return 'notice';
            }

            return $level >= 200 ? 'info' : 'debug';
        }

        /** "01-May-2024 12:00:00" → "2024-05-01 12:00:00" */
        private static function fromDayMonthYear($value)
        {
            if (preg_match('/^(\d{2})-([A-Za-z]{3})-(\d{4}) (.*)$/', $value, $m) && isset(self::MONTHS[strtolower($m[2])])) {
                return $m[3] . '-' . self::MONTHS[strtolower($m[2])] . '-' . $m[1] . ' ' . $m[4];
            }

            return $value;
        }

        private static function firstScalar(array $data, array $keys)
        {
            foreach ($keys as $key) {
                if (isset($data[$key]) && is_scalar($data[$key])) {
                    return $data[$key];
                }
            }

            return null;
        }

        private static function isLogFileName($name)
        {
            $dot = strrpos($name, '.');
            if ($dot === false) {
                return false;
            }
            $extension = strtolower(substr($name, $dot + 1));

            return $extension === 'log' || $extension === 'txt';
        }

        private static function slashes($path)
        {
            return str_replace('\\', '/', (string) $path);
        }

        private static function isAbsolute($path)
        {
            return $path !== '' && ($path[0] === '/' || preg_match('#^[A-Za-z]:/#', $path));
        }

        /** Truncate long text without splitting a UTF-8 sequence. */
        private static function truncate($text, $max)
        {
            $text = (string) $text;
            if (strlen($text) <= $max) {
                return $text;
            }

            return Introspector::truncate($text, $max);
        }
    }
}
