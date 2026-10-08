<?php

namespace Tinkerbox {
    /**
     * Entry point of the PHP runner (docs/ARCHITECTURE.md §1.2–1.4, §1.8).
     *
     * `Runner::main($payload)` runs exactly one mode per process and writes exactly one envelope
     *
     *     \n{nonce}BEGIN\n{json}\n{nonce}END\n
     *
     * to stdout: at the end of the mode, or from the shutdown handler when the process ends early (exit(),
     * die(), dd(), fatal errors, memory exhaustion, the time limit, a framework that exits while bootstrapping).
     *
     * Run mode wires everything together: driver detection + bootstrap, class aliases, dump/query capture,
     * the diagnostics error handler, the CodeTransformer, the isolated eval scope (`__tinkerbox_eval()` in
     * helpers.php, which only sees the driver's variables), buffered or realtime output, coverage, magic
     * comments and the return value. Data modes call the P4 classes (Introspector, LogReader, Panels,
     * ProjectSnippets).
     */
    final class Runner
    {
        const ENVELOPE_VERSION = 1;
        const MAX_DIAGNOSTICS = 100;
        /** Diagnostic messages are cut to this many bytes (PHP puts user data into many warnings). */
        const MAX_DIAGNOSTIC_MESSAGE = 4096;
        /**
         * Peak memory of the CodeTransformer per byte of code: its token arrays plus the TOKEN_PARSE check of the
         * result (measured up to ~200x on PHP 8.2+, ~410x before 8.2 where packed arrays use 32-byte buckets).
         */
        const TRANSFORM_MEMORY_FACTOR = PHP_VERSION_ID >= 80200 ? 240 : 480;
        /** The memory_limit is raised by at most this much while the code is transformed. */
        const MAX_TRANSFORM_MEMORY_RAISE = 536870912;
        /** Freed in the shutdown handler so an out-of-memory run can still build its envelope. */
        const MEMORY_RESERVE_BYTES = 2097152;
        /** Added to memory_limit after "Allowed memory size … exhausted". */
        const MEMORY_HEADROOM_BYTES = 134217728;
        const DATA_MODES = ['environment', 'members', 'detect', 'logs', 'logRead', 'panels', 'snippets'];

        private static $nonce = '';
        private static $mode = 'run';
        /** init → boot → prepare → user → finish → done (run); init → boot → data → done (data modes). */
        private static $phase = 'init';
        private static $emitted = false;
        private static $start = 0.0;
        /** @var array payload as received */
        private static $payload = [];
        /** @var array normalized RunOptions */
        private static $options = [];
        private static $projectPath = '';
        private static $projectReal = '';
        private static $lineOffset = 1;
        /** The user's code as sent by the editor (exception snippets). */
        private static $userCode = '';
        /** The transformed code that is eval()'d. */
        private static $evalCode = '';
        /** File name PHP reports for the eval()'d code: "<file>(<line>) : eval()'d code". */
        private static $evalFile = '';
        private static $bootStart = null;
        private static $bootMs = 0.0;
        private static $evalStart = null;
        private static $evalEnd = null;
        /** @var Drivers\Driver|null */
        private static $driver = null;
        /** @var array|null DriverInfo */
        private static $driverInfo = null;
        /** @var array<string, mixed> variables extracted into the user's scope */
        private static $scope = [];
        /** @var string[] variables of the user's scope linked to the real globals (`global $x`, `$GLOBALS['x']`) */
        private static $globalNames = [];
        /** @var array[] PhpDiagnostic records */
        private static $diagnostics = [];
        /** @var array<string, bool> */
        private static $diagnosticKeys = [];
        private static $droppedDiagnostics = 0;
        /** @var array|null ExceptionInfo recorded before the finishing steps (for the shutdown handler) */
        private static $pendingException = null;
        private static $afterRunCalled = false;
        private static $reserve = null;

        /**
         * Run one mode for a payload (docs/ARCHITECTURE.md §1.2). Never throws; always emits one envelope.
         *
         * @param array|mixed $payload
         * @return void
         */
        public static function main($payload)
        {
            if (self::$phase !== 'init') return; // one mode per process
            self::$start = microtime(true);
            $payload = is_array($payload) ? $payload : [];
            self::$payload = $payload;
            self::$nonce = self::stringField('nonce', '');
            if (self::$nonce === '') self::$nonce = 'tw_' . bin2hex(random_bytes(12));
            self::$mode = self::stringField('mode', 'run');
            self::$options = self::normalizeOptions(isset($payload['options']) && is_array($payload['options']) ? $payload['options'] : []);
            self::$projectPath = self::normalizePath(self::stringField('projectPath', ''));
            self::$lineOffset = isset($payload['lineOffset']) && is_numeric($payload['lineOffset']) ? max(1, (int) $payload['lineOffset']) : 1;

            error_reporting(E_ALL);
            ini_set('display_errors', 'stderr');
            ini_set('log_errors', '0'); // the CLI would print every error a second time on stderr
            ini_set('html_errors', '0');
            if (function_exists('set_time_limit')) {
                @set_time_limit(max(0, (int) ceil(self::$options['timeoutMs'] / 1000)));
            }
            // Some PHP builds (hardened macOS runtimes) cannot allocate PCRE JIT memory: the first regex then warns
            // once and PCRE falls back to the interpreter. Absorb that warning here instead of in the user's run.
            @preg_match('/^tinkerbox$/i', 'Tinkerbox');
            self::$reserve = str_repeat("\0", self::MEMORY_RESERVE_BYTES);
            register_shutdown_function([self::class, 'shutdown']);
            self::$phase = 'boot';

            try {
                if (self::$mode === 'run') {
                    self::run();
                } else {
                    self::data(self::$mode);
                }
            } catch (\Throwable $e) {
                self::internalFailure($e);
            }
        }

        // ------------------------------------------------------------------------------------------------
        // Run mode
        // ------------------------------------------------------------------------------------------------

        private static function run()
        {
            self::$userCode = self::decodeCode();
            Capture::configure(self::$options, self::$lineOffset);
            Magic::configure(self::$start, self::$options);

            $failure = self::boot(true);
            self::driverWarnings();
            if ($failure !== null) {
                self::emitRun(['exception' => ExceptionFormatter::format($failure, self::exceptionContext(true))]);
                return;
            }

            self::$phase = 'prepare';
            $transformed = self::transform(self::$userCode);
            self::registerAliases();
            self::installCaptureHooks(isset($transformed['declaredFunctions']) && is_array($transformed['declaredFunctions']) ? $transformed['declaredFunctions'] : []);
            if (self::$options['captureQueries']) self::listenForQueries();
            set_error_handler([self::class, 'handleError']);

            self::$evalCode = $transformed['code'];
            self::$globalNames = isset($transformed['globals']) && is_array($transformed['globals']) ? array_values(array_filter($transformed['globals'], 'is_string')) : [];
            Capture::setCoverageMap(isset($transformed['coverageMap']) && is_array($transformed['coverageMap']) ? $transformed['coverageMap'] : []);
            if (isset($transformed['coverage']) && $transformed['coverage'] === 'ticks') {
                register_tick_function([Capture::class, 'tick']);
            }
            self::$scope = self::driverVariables();

            if (self::$options['outputType'] !== 'realtime') {
                Capture::startBuffering();
            } else {
                Capture::startRealtime();
            }

            $value = null;
            $exception = null;
            self::$phase = 'user';
            try {
                $value = \__tinkerbox_eval();
            } catch (\Throwable $e) {
                $exception = $e;
            }
            self::$evalEnd = microtime(true);
            self::$phase = 'finish';
            if (isset($transformed['coverage']) && $transformed['coverage'] === 'ticks') {
                unregister_tick_function([Capture::class, 'tick']);
            }

            Capture::flushOutput();
            if ($exception !== null) {
                self::$pendingException = ExceptionFormatter::format($exception, self::exceptionContext(false));
                $exception = null;
            }
            self::afterRun();

            // A value returned by a top-level `return` that is not the last statement counts as well.
            $hasReturnValue = self::$pendingException === null
                && (!empty($transformed['hasReturnValue']) || (!empty($transformed['hasTopLevelReturn']) && $value !== null));
            $returnValue = $hasReturnValue ? Capture::dumpValue($value) : null;
            $value = null;

            self::emitRun([
                'hasReturnValue' => $hasReturnValue,
                'returnValue' => $returnValue,
                'exception' => self::$pendingException,
            ]);
        }

        /**
         * Called by `__tinkerbox_eval()` on the line of its eval() (helpers.php), right before the user's code runs.
         * @internal
         * @param string $evalFile the file name PHP will report for the eval()'d code
         */
        public static function beginEval($evalFile)
        {
            self::$evalFile = (string) $evalFile;
            Capture::setEvalFile(self::$evalFile);
            Dumper::setContext(['evalFile' => self::$evalFile, 'lineOffset' => self::$lineOffset, 'evalCode' => self::$evalCode]);
            self::$evalStart = microtime(true);
            Magic::startClock(self::$evalStart); // /*?.*/ measures the user's code, not the framework bootstrap
        }

        /**
         * Variables of the user's scope (driver variables()); handed out once.
         * @internal
         * @return array<string, mixed>
         */
        public static function scopeVariables()
        {
            $scope = self::$scope;
            self::$scope = [];
            return $scope;
        }

        /**
         * Names `__tinkerbox_eval()` links to the real globals: the user's code runs inside a function, so
         * without this `$config = …; function cfg() { global $config; }` would see null.
         * @internal
         * @return string[]
         */
        public static function globalNames()
        {
            return self::$globalNames;
        }

        /**
         * The transformed user code.
         * @internal
         * @return string
         */
        public static function evalCode()
        {
            return self::$evalCode;
        }

        /** @return array CodeTransformer result (the untouched code when the transformer itself fails) */
        private static function transform($code)
        {
            $untouched = ['code' => CodeTransformer::stripOpenTag($code), 'hasReturnValue' => false, 'returnLine' => null, 'hasTopLevelReturn' => false, 'coverage' => 'none', 'coverageMap' => [], 'declaredFunctions' => [], 'globals' => []];
            // Running out of memory here is a fatal error (not catchable): make room for the transformer first,
            // or run very large code untouched.
            $restore = self::reserveTransformMemory(strlen($code));
            if ($restore === false) {
                self::addDiagnostic('Notice', 'This code is too large for Tinkerbox to prepare within the memory limit (' . ini_get('memory_limit') . '); it runs without magic comments, coverage, echo/dump capture and the automatic return value.', '', 0, null);
                return $untouched;
            }
            try {
                $result = CodeTransformer::transform($code, self::$options, self::$lineOffset);
                if (is_array($result) && isset($result['code']) && is_string($result['code'])) {
                    self::degradationNotice(isset($result['disabled']) && is_array($result['disabled']) ? $result['disabled'] : []);
                    foreach (isset($result['skippedMagicLines']) && is_array($result['skippedMagicLines']) ? $result['skippedMagicLines'] : [] as $line) {
                        self::addDiagnostic('Notice', 'Tinkerbox could not apply the magic comment on this line; it was skipped.', '', (int) $line, (int) $line);
                    }
                    return $result;
                }
            } catch (\Throwable $e) {
                self::addDiagnostic('Warning', 'Tinkerbox could not prepare the code (' . get_class($e) . ': ' . $e->getMessage() . '); it runs without magic comments and coverage.', '', 0, null);
            } finally {
                if (is_string($restore)) @ini_set('memory_limit', $restore);
            }
            return $untouched;
        }

        /**
         * Raise memory_limit for the CodeTransformer when the code is large (its peak is ~TRANSFORM_MEMORY_FACTOR
         * times the code size; the user's own memory_limit applies to the user's code, not to the runner).
         * @return string|null|false the memory_limit to restore afterwards, null when nothing was raised, false
         *   when the code needs more than MAX_TRANSFORM_MEMORY_RAISE
         */
        private static function reserveTransformMemory($codeBytes)
        {
            $original = (string) ini_get('memory_limit');
            $limit = self::iniBytes($original);
            if ($limit <= 0) return null; // unlimited
            $needed = memory_get_usage(true) + $codeBytes * self::TRANSFORM_MEMORY_FACTOR + self::MEMORY_RESERVE_BYTES;
            if ($needed <= $limit) return null;
            if ($needed - $limit > self::MAX_TRANSFORM_MEMORY_RAISE) return false;
            return @ini_set('memory_limit', (string) (int) $needed) === false ? false : $original;
        }

        /** Bytes of an ini size value ("128M", "1G", "-1" → -1). */
        private static function iniBytes($value)
        {
            $value = trim((string) $value);
            if ($value === '' || $value === '-1') return -1;
            $bytes = (float) $value;
            switch (strtolower(substr($value, -1))) {
                case 'g':
                    $bytes *= 1024;
                    // no break
                case 'm':
                    $bytes *= 1024;
                    // no break
                case 'k':
                    $bytes *= 1024;
            }
            return $bytes;
        }

        /**
         * The transformer had to drop features for this code (a construct it cannot rewrite safely): say so, the
         * user would otherwise wonder where their magic comments went. ['all'] = the code has a syntax error,
         * which the ParseError already reports.
         * @param string[] $disabled
         */
        private static function degradationNotice(array $disabled)
        {
            $labels = ['inline' => 'inline magic comments', 'magic' => 'magic comments', 'markers' => 'coverage markers', 'rewrites' => 'echo/dump capture'];
            $names = [];
            foreach ($disabled as $feature) {
                if (isset($labels[$feature])) $names[] = $labels[$feature];
            }
            if ($names) {
                self::addDiagnostic('Notice', 'Tinkerbox could not apply ' . implode(', ', $names) . ' to this code; it runs without them.', '', 0, null);
            }
        }

        /** Driver hook after the user's code (deferred query logs …). Called once. */
        private static function afterRun()
        {
            if (self::$afterRunCalled || self::$driver === null) return;
            self::$afterRunCalled = true;
            try {
                self::$driver->afterRun();
            } catch (\Throwable $e) {
                self::addDiagnostic('Warning', get_class(self::$driver) . '::afterRun() failed: ' . $e->getMessage(), '', 0, null);
            }
            Capture::flushOutput();
        }

        /** @return array<string, mixed> valid variable names only */
        private static function driverVariables()
        {
            if (self::$driver === null) return [];
            try {
                $variables = self::$driver->variables();
            } catch (\Throwable $e) {
                self::addDiagnostic('Warning', get_class(self::$driver) . '::variables() failed: ' . $e->getMessage(), '', 0, null);
                return [];
            }
            if (!is_array($variables)) return [];
            $scope = [];
            foreach ($variables as $name => $value) {
                if (!is_string($name) || $name === 'this' || $name === 'GLOBALS') continue;
                if (!preg_match('/^[A-Za-z_\x80-\xff][A-Za-z0-9_\x80-\xff]*$/', $name)) continue;
                $scope[$name] = $value;
            }
            return $scope;
        }

        private static function registerAliases()
        {
            try {
                ClassAliasLoader::register(self::$projectPath);
            } catch (\Throwable $e) {
                self::addDiagnostic('Warning', 'Class aliases are unavailable: ' . $e->getMessage(), '', 0, null);
            }
        }

        /**
         * Global helpers (dump, dd, tw) and the Symfony VarDumper handler.
         * @param string[] $declared functions the user's code declares itself (no helper of that name)
         */
        private static function installCaptureHooks(array $declared)
        {
            try {
                \__tinkerbox_define_helpers($declared);
            } catch (\Throwable $e) {
                self::addDiagnostic('Warning', 'Tinkerbox helpers are unavailable: ' . $e->getMessage(), '', 0, null);
            }
            $varDumper = 'Symfony\\Component\\VarDumper\\VarDumper';
            try {
                if (class_exists($varDumper) && method_exists($varDumper, 'setHandler')) {
                    // Symfony >= 6.3 passes a label as the second argument.
                    $varDumper::setHandler(static function ($value, $label = null) {
                        Capture::dumpFromHandler($value, $label);
                    });
                }
            } catch (\Throwable $e) {
                self::addDiagnostic('Warning', 'The VarDumper handler could not be installed: ' . $e->getMessage(), '', 0, null);
            }
        }

        /** Query capture: the driver reports executed queries to Capture::query(). */
        private static function listenForQueries()
        {
            if (self::$driver === null) return;
            try {
                self::$driver->listenForQueries([Capture::class, 'query']);
            } catch (\Throwable $e) {
                self::addDiagnostic('Warning', 'Query logging is unavailable: ' . get_class($e) . ': ' . $e->getMessage(), '', 0, null);
            }
        }

        // ------------------------------------------------------------------------------------------------
        // Bootstrap
        // ------------------------------------------------------------------------------------------------

        /**
         * chdir into the project, detect the driver and (optionally) bootstrap it.
         * @return \Throwable|null the bootstrap failure
         */
        private static function boot($bootstrap)
        {
            self::$phase = 'boot';
            if (self::$projectPath !== '') {
                if (!is_dir(self::$projectPath)) {
                    return new \RuntimeException('The project folder does not exist: ' . self::$projectPath);
                }
                if (!@chdir(self::$projectPath)) {
                    return new \RuntimeException('Cannot change into the project folder: ' . self::$projectPath);
                }
                $real = @realpath(self::$projectPath);
                self::$projectReal = is_string($real) && $real !== self::$projectPath ? $real : '';
            }
            try {
                self::$driver = DriverRegistry::detect(self::$projectPath, self::stringField('driver', ''), self::stringField('homePath', ''));
            } catch (\Throwable $e) {
                self::$driver = null;
                return $e;
            }
            self::$driverInfo = self::basicDriverInfo(self::$driver);
            if (!$bootstrap) return null;

            $failure = null;
            self::$bootStart = microtime(true);
            try {
                self::$driver->bootstrap(self::$projectPath);
            } catch (\Throwable $e) {
                $failure = $e;
            }
            self::$bootMs = (microtime(true) - self::$bootStart) * 1000;
            self::$bootStart = null;
            self::$driverInfo = self::fullDriverInfo(self::$driver);
            return $failure;
        }

        /** Non-fatal driver problems (broken custom driver files, unknown forced driver …) become diagnostics. */
        private static function driverWarnings()
        {
            try {
                $warnings = DriverRegistry::warnings();
            } catch (\Throwable $e) {
                return;
            }
            foreach (is_array($warnings) ? $warnings : [] as $warning) {
                if (is_scalar($warning) && (string) $warning !== '') self::addDiagnostic('Warning', (string) $warning, '', 0, null);
            }
        }

        /** id + name only (safe to compute before / without bootstrapping). */
        private static function basicDriverInfo($driver)
        {
            if (!$driver instanceof Drivers\Driver) return null;
            $id = get_class($driver);
            $name = get_class($driver);
            try {
                $value = $driver->id();
                if ($value !== '') $id = $value;
                $value = $driver->name();
                if ($value !== '') $name = $value;
            } catch (\Throwable $e) {
                // keep the class-based fallbacks
            }
            return ['id' => $id, 'name' => $name];
        }

        /** DriverInfo after bootstrapping: id, name, appVersion (version()), usesCollision, logFilesPath. */
        private static function fullDriverInfo($driver)
        {
            if (!$driver instanceof Drivers\Driver) return null;
            try {
                $info = DriverRegistry::info($driver, self::$projectPath);
            } catch (\Throwable $e) {
                return self::basicDriverInfo($driver);
            }
            if (!isset($info['appVersion']) || !is_string($info['appVersion']) || $info['appVersion'] === '') unset($info['appVersion']);
            return $info;
        }

        // ------------------------------------------------------------------------------------------------
        // Data modes
        // ------------------------------------------------------------------------------------------------

        private static function data($mode)
        {
            if (!in_array($mode, self::DATA_MODES, true)) {
                self::emitData(null, 'Unknown runner mode "' . $mode . '"');
                return;
            }
            $error = null;
            $bootFailed = false;
            if ($mode !== 'snippets') {
                $failure = self::boot(true);
                if ($failure !== null) {
                    $error = self::describe($failure);
                    $bootFailed = true;
                }
            }
            self::$phase = 'data';
            if (self::$driver !== null && ($mode === 'environment' || $mode === 'members')) self::registerAliases();

            $level = ob_get_level();
            ob_start(); // data modes print nothing but the envelope
            try {
                $data = self::dataFor($mode, $bootFailed);
            } catch (\Throwable $e) {
                $data = null;
                $error = $error === null ? self::describe($e) : $error . ' / ' . self::describe($e);
            }
            while (ob_get_level() > $level) {
                if (!@ob_end_clean()) break;
            }
            self::emitData($data, $error);
        }

        /** @return mixed the `data` field */
        private static function dataFor($mode, $bootFailed)
        {
            switch ($mode) {
                case 'detect':
                    return ['driver' => self::$driverInfo, 'phpVersionLine' => self::phpVersionLine()];
                case 'snippets':
                    return ProjectSnippets::read(self::$projectPath);
                case 'logs':
                    return LogReader::list(self::logRoot());
                case 'logRead':
                    $limit = isset(self::$payload['logLimit']) && is_numeric(self::$payload['logLimit']) ? (int) self::$payload['logLimit'] : 500;
                    return LogReader::read(self::logRoot(), self::stringField('logFile', ''), $limit);
            }
            if (self::$driver === null) {
                if ($bootFailed) return null;
                throw new \RuntimeException('No driver is available for this project.');
            }
            switch ($mode) {
                case 'environment':
                    return Introspector::environment(self::$driver, self::$projectPath);
                case 'members':
                    return Introspector::members(self::stringField('className', ''), self::$driver, self::$projectPath);
                case 'panels':
                    return Panels::forDriver(self::$driver, self::$projectPath);
            }
            return null;
        }

        /** Log viewer root: the driver's logsPath(), else <project>/storage/logs. */
        private static function logRoot()
        {
            if (is_array(self::$driverInfo) && isset(self::$driverInfo['logFilesPath']) && is_string(self::$driverInfo['logFilesPath']) && self::$driverInfo['logFilesPath'] !== '') {
                return self::$driverInfo['logFilesPath'];
            }
            return self::$projectPath === '' ? '' : self::$projectPath . DIRECTORY_SEPARATOR . 'storage' . DIRECTORY_SEPARATOR . 'logs';
        }

        /** Like the first line of `php -v`, e.g. "PHP 8.3.12 (cli) (NTS)". */
        private static function phpVersionLine()
        {
            $line = 'PHP ' . PHP_VERSION . ' (' . PHP_SAPI . ')';
            $line .= defined('ZEND_THREAD_SAFE') && ZEND_THREAD_SAFE ? ' (ZTS)' : ' (NTS)';
            if (defined('PHP_DEBUG') && PHP_DEBUG) $line .= ' (DEBUG)';
            return $line;
        }

        // ------------------------------------------------------------------------------------------------
        // Diagnostics
        // ------------------------------------------------------------------------------------------------

        /**
         * Error handler installed after bootstrap: warnings, notices and deprecations become diagnostics and the
         * code continues; other handleable errors (E_USER_ERROR, E_RECOVERABLE_ERROR) become ErrorExceptions
         * while the user's code runs.
         * @internal
         */
        public static function handleError($level, $message, $file = '', $line = 0)
        {
            $level = (int) $level;
            if (!(error_reporting() & $level)) return false; // @-silenced: keep PHP's behaviour (error_get_last)
            $name = self::levelName($level);
            if ($name === null) {
                if (self::$phase === 'user') throw new \ErrorException((string) $message, 0, $level, (string) $file, (int) $line);
                return false;
            }
            $file = (string) $file;
            if ($name === 'Deprecated' && $file !== self::$evalFile && (self::isVendorFile($file) || self::isRunnerFile($file))) {
                return true; // framework / runner deprecations are not the user's concern
            }
            $userLine = Capture::userLine();
            if ($userLine === null && self::isRunnerFile($file)) {
                return true; // the runner's own internals (no user code on the stack) are not the user's concern
            }
            if ($file !== '' && $file === self::$evalFile) {
                $editorLine = (int) $line + self::$lineOffset - 1;
                self::addDiagnostic($name, (string) $message, '', $editorLine, $editorLine);
            } elseif ($userLine !== null && self::isRunnerFile($file)) {
                // e.g. "Array to string conversion" inside Capture::echoAt() for `echo [];`
                self::addDiagnostic($name, (string) $message, '', $userLine, $userLine);
            } else {
                self::addDiagnostic($name, (string) $message, self::relativePath($file), (int) $line, $userLine);
            }
            return true;
        }

        private static function levelName($level)
        {
            switch ($level) {
                case E_WARNING:
                case E_USER_WARNING:
                    return 'Warning';
                case E_NOTICE:
                case E_USER_NOTICE:
                    return 'Notice';
                case E_DEPRECATED:
                case E_USER_DEPRECATED:
                    return 'Deprecated';
                case 2048: // E_STRICT (the constant itself is deprecated on PHP 8.4+)
                    return 'Strict Standards';
            }
            return null;
        }

        private static function addDiagnostic($level, $message, $file, $line, $userLine)
        {
            $message = (string) $message;
            $identity = $message;
            if (strlen($message) > self::MAX_DIAGNOSTIC_MESSAGE) {
                // `Undefined array key "<1 MB key>"`: keep a bounded message (deduplicated by a hash of the full one).
                $identity = md5($message) . strlen($message);
                $message = self::cutUtf8($message, self::MAX_DIAGNOSTIC_MESSAGE) . '… (' . strlen($message) . ' bytes)';
            }
            $key = $level . "\0" . $identity . "\0" . $file . "\0" . $line;
            if (isset(self::$diagnosticKeys[$key])) return;
            if (count(self::$diagnostics) >= self::MAX_DIAGNOSTICS) {
                self::$droppedDiagnostics++;
                return;
            }
            self::$diagnosticKeys[$key] = true;
            $diagnostic = ['level' => (string) $level, 'message' => (string) $message, 'file' => (string) $file, 'line' => (int) $line];
            if ($userLine !== null) $diagnostic['userLine'] = (int) $userLine;
            self::$diagnostics[] = $diagnostic;
        }

        private static function cutUtf8($text, $bytes)
        {
            $cut = (string) substr($text, 0, $bytes);
            if (preg_match('//u', $text) !== 1) return $cut;
            while ($cut !== '' && preg_match('//u', $cut) !== 1) $cut = (string) substr($cut, 0, -1);
            return $cut;
        }

        private static function diagnostics()
        {
            $diagnostics = self::$diagnostics;
            if (self::$droppedDiagnostics > 0) {
                $diagnostics[] = ['level' => 'Notice', 'message' => self::$droppedDiagnostics . ' more ' . (self::$droppedDiagnostics === 1 ? 'diagnostic was' : 'diagnostics were') . ' not shown', 'file' => '', 'line' => 0];
            }
            return $diagnostics;
        }

        private static function isVendorFile($file)
        {
            return strpos(str_replace('\\', '/', (string) $file), '/vendor/') !== false;
        }

        /** The runner itself: the bundle (one file name for all sources) or, in development, resources/php/src. */
        private static function isRunnerFile($file)
        {
            $file = (string) $file;
            if ($file === '' || substr($file, -14) === "eval()'d code") return false;
            if ($file === __FILE__) return true;
            return is_file(__FILE__) && strpos($file, dirname(__FILE__) . DIRECTORY_SEPARATOR) === 0;
        }

        private static function relativePath($file)
        {
            foreach ([self::$projectPath, self::$projectReal] as $root) {
                if ($root !== '' && strpos($file, $root . DIRECTORY_SEPARATOR) === 0) {
                    return (string) substr($file, strlen($root) + 1);
                }
            }
            return $file;
        }

        // ------------------------------------------------------------------------------------------------
        // Shutdown (exit, dd, fatal errors, timeouts, memory exhaustion)
        // ------------------------------------------------------------------------------------------------

        /** @internal registered shutdown function */
        public static function shutdown()
        {
            if (self::$emitted || self::$phase === 'init') return;
            self::$reserve = null;
            $fatal = null;
            try {
                $error = error_get_last();
                $fatal = is_array($error) && isset($error['type']) && self::isFatal((int) $error['type']) ? $error : null;
                if ($fatal !== null && strpos((string) $fatal['message'], 'Allowed memory size') !== false) self::raiseMemoryLimit();
                if (self::$bootStart !== null) {
                    self::$bootMs = (microtime(true) - self::$bootStart) * 1000;
                    self::$bootStart = null;
                }

                if (self::$mode !== 'run') {
                    $message = $fatal !== null
                        ? self::fatalMessage($fatal)
                        : 'The runner exited before the ' . self::$mode . ' data was ready (exit() or die() was called' . (self::$phase === 'boot' ? ' while bootstrapping the project' : '') . ').';
                    $data = self::$mode === 'detect' ? ['driver' => self::$driverInfo, 'phpVersionLine' => self::phpVersionLine()] : null;
                    self::emitData($data, $message);
                    return;
                }

                $phase = self::$phase;
                if ($phase === 'boot' || $phase === 'prepare') {
                    $exception = $fatal !== null ? ExceptionFormatter::fatal($fatal, self::exceptionContext(true)) : self::bootstrapExit();
                    self::emitRun(['exception' => $exception, 'exited' => $fatal === null]);
                    return;
                }

                if (self::$evalEnd === null) self::$evalEnd = microtime(true);
                Capture::flushOutput();
                $exception = self::$pendingException;
                if ($fatal !== null) {
                    $exception = ExceptionFormatter::fatal($fatal, self::exceptionContext(false));
                }
                self::afterRun();
                self::emitRun(['exception' => $exception, 'exited' => $fatal === null]);
            } catch (\Throwable $e) {
                self::internalFailure($e);
            } finally {
                if ($fatal !== null) self::endAfterFatal();
            }
        }

        /**
         * After a fatal error the envelope already reports it. End the request here, which skips the shutdown
         * functions registered after the runner's: the handlers frameworks install while bootstrapping (Laravel's
         * HandleExceptions, Whoops, Symfony's ErrorHandler …) would otherwise render the same error a second time
         * outside the envelope — with bogus frames in "Standard input code" — and report it to the project's log.
         * Object destructors still run; the exit status stays 255 like any fatal error.
         */
        private static function endAfterFatal()
        {
            exit(255);
        }

        private static function isFatal($type)
        {
            return in_array($type, [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR, E_RECOVERABLE_ERROR], true);
        }

        private static function fatalMessage(array $error)
        {
            $message = isset($error['message']) ? (string) $error['message'] : 'Fatal error';
            $stack = strpos($message, "\nStack trace:");
            if ($stack !== false) $message = substr($message, 0, $stack);
            $file = isset($error['file']) ? (string) $error['file'] : '';
            if ($file !== '') $message .= ' in ' . self::relativePath($file) . ':' . (isset($error['line']) ? (int) $error['line'] : 0);
            return $message;
        }

        /** ExceptionInfo for a framework that called exit() while bootstrapping (the user's code did not run). */
        private static function bootstrapExit()
        {
            $name = is_array(self::$driverInfo) && isset(self::$driverInfo['name']) ? self::$driverInfo['name'] : 'The application';
            return [
                'class' => 'RuntimeException',
                'message' => $name . ' exited while bootstrapping (exit() or die() was called), so your code did not run.',
                'code' => '0',
                'file' => self::$projectPath,
                'line' => 0,
                'trace' => [],
                'previous' => null,
                'bootstrap' => true,
            ];
        }

        private static function raiseMemoryLimit()
        {
            $bytes = self::iniBytes(ini_get('memory_limit'));
            if ($bytes < 0) return;
            @ini_set('memory_limit', (string) (int) max($bytes + self::MEMORY_HEADROOM_BYTES, memory_get_usage(true) + self::MEMORY_HEADROOM_BYTES));
        }

        /** A bug in the runner itself: report it instead of losing the envelope. */
        private static function internalFailure(\Throwable $e)
        {
            if (self::$emitted) return;
            try {
                if (self::$mode === 'run') {
                    $info = ExceptionFormatter::format($e, self::exceptionContext(self::$phase === 'boot' || self::$phase === 'prepare'));
                    self::emitRun(['exception' => $info]);
                } else {
                    self::emitData(null, self::describe($e));
                }
            } catch (\Throwable $inner) {
                self::emit([
                    'version' => self::ENVELOPE_VERSION,
                    'mode' => self::$mode,
                    'phpVersion' => PHP_VERSION,
                    'driver' => null,
                    'error' => 'Tinkerbox runner failure: ' . self::describe($e),
                ]);
            }
        }

        // ------------------------------------------------------------------------------------------------
        // Envelopes
        // ------------------------------------------------------------------------------------------------

        private static function exceptionContext($bootstrap)
        {
            return [
                'evalFile' => self::$evalFile,
                'lineOffset' => self::$lineOffset,
                'userCode' => self::$userCode,
                'projectPath' => self::$projectPath,
                'bootstrap' => (bool) $bootstrap,
            ];
        }

        /** PhpEnvelope (src/shared/types.ts) with the given fields. */
        private static function emitRun(array $fields)
        {
            if (self::$emitted) return;
            Capture::stopBuffering(); // user buffers are flushed into the capture first
            $durationMs = self::$evalStart !== null ? ((self::$evalEnd !== null ? self::$evalEnd : microtime(true)) - self::$evalStart) * 1000 : 0.0;
            $envelope = array_replace([
                'version' => self::ENVELOPE_VERSION,
                'mode' => 'run',
                'phpVersion' => PHP_VERSION,
                'driver' => self::$driverInfo,
                'events' => [],
                'hasReturnValue' => false,
                'returnValue' => null,
                'magic' => [],
                'coverage' => [],
                'exception' => null,
                'diagnostics' => [],
                'bootMs' => 0.0,
                'durationMs' => 0.0,
                'memoryPeak' => 0,
                'exited' => false,
            ], $fields);
            $envelope['events'] = Capture::events();
            $envelope['magic'] = Magic::values();
            $envelope['coverage'] = Capture::coverage();
            $envelope['diagnostics'] = self::diagnostics();
            $envelope['bootMs'] = round(self::$bootMs, 2);
            if (!array_key_exists('durationMs', $fields)) $envelope['durationMs'] = round(max(0.0, $durationMs), 2);
            $envelope['memoryPeak'] = memory_get_peak_usage(true);
            $envelope['exited'] = !empty($fields['exited']) || Capture::$exited;
            self::emit($envelope);
        }

        /** PhpDataEnvelope (src/shared/types.ts). */
        private static function emitData($data, $error)
        {
            $envelope = [
                'version' => self::ENVELOPE_VERSION,
                'mode' => self::$mode,
                'phpVersion' => PHP_VERSION,
                'driver' => self::$driverInfo,
                'data' => $data,
            ];
            if ($error !== null && $error !== '') $envelope['error'] = (string) $error;
            self::emit($envelope);
        }

        private static function emit(array $envelope)
        {
            if (self::$emitted) return;
            self::$emitted = true;
            self::$phase = 'done';
            $flags = JSON_PARTIAL_OUTPUT_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
                | (defined('JSON_INVALID_UTF8_SUBSTITUTE') ? JSON_INVALID_UTF8_SUBSTITUTE : 0);
            $json = json_encode($envelope, $flags, 4096);
            if (!is_string($json)) {
                $json = json_encode([
                    'version' => self::ENVELOPE_VERSION,
                    'mode' => self::$mode,
                    'phpVersion' => PHP_VERSION,
                    'driver' => null,
                    'error' => 'The runner result could not be encoded as JSON: ' . json_last_error_msg(),
                ], $flags);
            }
            // Everything printed so far must reach stdout before the envelope.
            while (ob_get_level() > 0) {
                if (!@ob_end_flush()) break;
            }
            $text = "\n" . self::$nonce . "BEGIN\n" . $json . "\n" . self::$nonce . "END\n";
            if (ob_get_level() > 0) {
                // A non-removable output buffer (`ob_start(null, 0, 0)`) is still active and would swallow the
                // envelope (PHP flushes it at exit, into the capture handler): write to stdout directly.
                $stdout = defined('STDOUT') ? STDOUT : @fopen('php://stdout', 'wb');
                if (is_resource($stdout) && @fwrite($stdout, $text) !== false) {
                    @fflush($stdout);
                    return;
                }
            }
            echo $text;
            flush();
        }

        // ------------------------------------------------------------------------------------------------
        // Payload helpers
        // ------------------------------------------------------------------------------------------------

        private static function stringField($key, $default)
        {
            return isset(self::$payload[$key]) && is_scalar(self::$payload[$key]) ? (string) self::$payload[$key] : $default;
        }

        private static function decodeCode()
        {
            $code = self::stringField('code', '');
            if ($code === '') return '';
            $decoded = base64_decode($code, true);
            return $decoded === false ? $code : $decoded;
        }

        private static function normalizePath($path)
        {
            $path = trim((string) $path);
            if ($path === '') return '';
            $trimmed = rtrim($path, '/\\');
            return $trimmed === '' ? $path[0] : $trimmed;
        }

        /** RunOptions with defaults (docs/ARCHITECTURE.md §1.2). */
        private static function normalizeOptions(array $options)
        {
            $int = function ($key, $default) use ($options) {
                return isset($options[$key]) && is_numeric($options[$key]) ? (int) $options[$key] : $default;
            };
            $bool = function ($key, $default) use ($options) {
                return array_key_exists($key, $options) ? (bool) $options[$key] : $default;
            };
            return [
                'maxDepth' => max(1, $int('maxDepth', 8)),
                'maxItems' => max(1, $int('maxItems', 500)),
                'maxStringLength' => max(1, $int('maxStringLength', 10000)),
                'captureQueries' => $bool('captureQueries', true),
                'magicComments' => $bool('magicComments', true),
                'coverage' => $bool('coverage', true),
                'strictTypes' => $bool('strictTypes', false),
                'outputType' => isset($options['outputType']) && $options['outputType'] === 'realtime' ? 'realtime' : 'buffered',
                'timeoutMs' => max(0, $int('timeoutMs', 120000)),
            ];
        }

        private static function describe(\Throwable $e)
        {
            $message = $e->getMessage();
            return ($e instanceof \RuntimeException && get_class($e) === 'RuntimeException' ? '' : get_class($e) . ': ') . $message;
        }
    }
}
