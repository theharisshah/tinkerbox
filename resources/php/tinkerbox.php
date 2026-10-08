<?php

namespace {
    /**
     * Development entry point of the Tinkerbox PHP runner (docs/ARCHITECTURE.md §1.1).
     *
     *     php -d xdebug.mode=off resources/php/tinkerbox.php payload.json
     *     php -d xdebug.mode=off resources/php/tinkerbox.php - < payload.json
     *
     * Loads the runner sources in manifest order (the app concatenates the same files and pipes them to `php`
     * over stdin) and runs `\Tinkerbox\Runner::main()` with the JSON payload (§1.2: `code` is base64).
     */
    call_user_func(function () {
        $root = __DIR__;
        $manifest = json_decode((string) file_get_contents($root . '/manifest.json'), true);
        if (!is_array($manifest) || !isset($manifest['files']) || !is_array($manifest['files'])) {
            fwrite(STDERR, "Tinkerbox: invalid runner manifest " . $root . "/manifest.json\n");
            exit(2);
        }
        foreach ($manifest['files'] as $file) {
            require_once $root . '/' . $file;
        }
    });

    call_user_func(function () {
        $args = isset($_SERVER['argv']) && is_array($_SERVER['argv']) ? $_SERVER['argv'] : [];
        if (count($args) < 2 || $args[1] === '' || $args[1] === '--help' || $args[1] === '-h') {
            fwrite(STDERR, "Usage: php tinkerbox.php <payload.json | ->\n");
            exit(2);
        }
        $json = $args[1] === '-' ? stream_get_contents(STDIN) : @file_get_contents($args[1]);
        if (!is_string($json)) {
            fwrite(STDERR, "Tinkerbox: cannot read the payload " . $args[1] . "\n");
            exit(2);
        }
        $payload = json_decode($json, true);
        if (!is_array($payload)) {
            fwrite(STDERR, "Tinkerbox: the payload is not valid JSON: " . json_last_error_msg() . "\n");
            exit(2);
        }
        \Tinkerbox\Runner::main($payload);
    });
}
