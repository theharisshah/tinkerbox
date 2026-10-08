<?php

namespace Tinkerbox {
    /**
     * Fixture runner implementing the envelope protocol (docs/ARCHITECTURE.md §1.2–1.3) just enough to
     * exercise the main-process pipeline. The decoded payload is echoed back as `payload`.
     */
    final class Runner
    {
        public static function main(array $p)
        {
            $nonce = $p['nonce'];
            if ($p['projectPath'] !== '') chdir($p['projectPath']);
            $driver = ['id' => $p['driver'] !== '' ? $p['driver'] : 'none', 'name' => 'PHP', 'appVersion' => null];
            if ($p['mode'] !== 'run') {
                self::emit($nonce, ['version' => 1, 'mode' => $p['mode'], 'phpVersion' => PHP_VERSION, 'driver' => $driver, 'data' => self::data($p), 'payload' => $p]);
                return;
            }
            $realtime = $p['options']['outputType'] === 'realtime';
            if (!$realtime) ob_start();
            $exception = null;
            $value = null;
            $start = microtime(true);
            try {
                $value = eval(base64_decode($p['code']));
            } catch (\Throwable $e) {
                $exception = ['class' => get_class($e), 'message' => $e->getMessage(), 'code' => (string) $e->getCode(), 'file' => '', 'line' => $e->getLine(), 'trace' => []];
            }
            $out = $realtime ? '' : (string) ob_get_clean();
            self::emit($nonce, [
                'version' => 1, 'mode' => 'run', 'phpVersion' => PHP_VERSION, 'driver' => $driver,
                'events' => $out === '' ? [] : [['seq' => 1, 'kind' => 'echo', 'text' => $out]],
                'hasReturnValue' => $value !== null, 'returnValue' => Node::of($value),
                'magic' => [], 'coverage' => [], 'exception' => $exception, 'diagnostics' => [],
                'bootMs' => 0, 'durationMs' => (microtime(true) - $start) * 1000, 'memoryPeak' => memory_get_peak_usage(true),
                'payload' => $p,
            ]);
        }

        private static function data(array $p)
        {
            switch ($p['mode']) {
                case 'detect':
                    return ['driver' => ['id' => 'none', 'name' => 'PHP', 'appVersion' => 'Plain PHP'], 'phpVersionLine' => 'PHP ' . PHP_VERSION];
                case 'environment':
                    return ['phpVersion' => PHP_VERSION, 'driver' => null, 'extensions' => get_loaded_extensions(), 'functions' => [['name' => 'strlen', 'signature' => '(string $string): int']], 'classes' => ['ArrayObject'], 'aliases' => [], 'constants' => ['PHP_VERSION'], 'models' => [], 'variables' => []];
                case 'members':
                    return $p['className'] === 'Missing' ? null : ['class' => $p['className'], 'interfaces' => [], 'members' => []];
                case 'snippets':
                    $out = [];
                    foreach (glob($p['projectPath'] . '/.tinkerbox/snippets/*.php') ?: [] as $file) {
                        $src = (string) file_get_contents($file);
                        preg_match('/@label\s+(.+)/', $src, $l);
                        preg_match('/@description\s+(.+)/', $src, $d);
                        $out[] = ['name' => isset($l[1]) ? trim($l[1]) : '', 'description' => isset($d[1]) ? trim($d[1]) : '', 'code' => trim(preg_replace('#^<\?php\s*/\*\*.*?\*/\s*#s', '', $src)), 'file' => $file];
                    }
                    return $out;
                case 'logs':
                    return ['root' => $p['projectPath'] . '/storage/logs', 'files' => []];
                case 'logRead':
                    return [['datetime' => '2026-01-01 00:00:00', 'level' => 'info', 'message' => $p['logFile'] . ':' . $p['logLimit']]];
                case 'panels':
                    return [['title' => 'App Information', 'sections' => []]];
            }
            return null;
        }

        private static function emit($nonce, array $data)
        {
            echo "\n" . $nonce . "BEGIN\n" . json_encode($data, JSON_PARTIAL_OUTPUT_ON_ERROR | JSON_UNESCAPED_SLASHES) . "\n" . $nonce . "END\n";
        }
    }
}
