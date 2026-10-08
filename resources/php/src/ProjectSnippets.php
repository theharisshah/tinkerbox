<?php

namespace Tinkerbox {
    /**
     * Project snippets (`snippets` data mode, docs/ARCHITECTURE.md §1.8): `<project>/.tinkerbox/snippets/*.php`,
     * code a team keeps in its repository (shown read-only next to the user's own snippets).
     *
     *     <?php
     *     /**
     *      * @label Count users
     *      * @description Shows how many users signed up today
     *      *\/
     *     User::whereDate('created_at', today())->count();
     *
     * Result: [{ name, description, code, file }] sorted by file name. `code` is the file without the leading
     * `<?php` tag and the leading docblock; `name` falls back to the humanized file name, `description` to the
     * docblock summary.
     */
    final class ProjectSnippets
    {
        /** Snippet folder, relative to the project. */
        const FOLDER = '.tinkerbox' . DIRECTORY_SEPARATOR . 'snippets';

        /** Snippet files larger than this are skipped (they are code snippets, not data dumps). */
        const MAX_FILE_BYTES = 1048576;
        const MAX_SNIPPETS = 500;

        /**
         * @param string $projectPath
         * @return array list of {name, description, code, file}
         */
        public static function read($projectPath)
        {
            $projectPath = rtrim((string) $projectPath, '/\\');
            if ($projectPath === '') {
                return [];
            }
            $dir = $projectPath . DIRECTORY_SEPARATOR . self::FOLDER;
            if (!is_dir($dir) || !is_readable($dir)) {
                return [];
            }
            $names = scandir($dir);
            if ($names === false) {
                return [];
            }
            $files = [];
            foreach ($names as $name) {
                if ($name === '' || $name[0] === '.' || strtolower(substr($name, -4)) !== '.php') {
                    continue;
                }
                $path = $dir . DIRECTORY_SEPARATOR . $name;
                if (is_file($path)) {
                    $files[] = $name;
                }
            }
            usort($files, 'strnatcasecmp');

            $snippets = [];
            foreach (array_slice($files, 0, self::MAX_SNIPPETS) as $name) {
                $path = $dir . DIRECTORY_SEPARATOR . $name;
                $size = filesize($path);
                if ($size === false || $size > self::MAX_FILE_BYTES || !is_readable($path)) {
                    continue;
                }
                $source = file_get_contents($path);
                if (!is_string($source)) {
                    continue;
                }
                $snippets[] = self::parse($source, $name) + ['file' => $path];
            }

            return $snippets;
        }

        /**
         * Parse one snippet file.
         *
         * @param string $source file contents
         * @param string $fileName used for the fallback name
         * @return array{name:string,description:string,code:string}
         */
        public static function parse($source, $fileName)
        {
            $code = str_replace("\r\n", "\n", (string) $source);
            if (strncmp($code, "\xEF\xBB\xBF", 3) === 0) {
                $code = substr($code, 3);
            }
            // Leading open tag (and the rest of its line when it is otherwise empty).
            $code = preg_replace('/^\s*<\?php\b[ \t]*\n?/i', '', $code, 1);
            $code = preg_replace('/^\s*<\?(?!xml)[ \t]*\n?/i', '', $code, 1);
            // Trailing close tag.
            $code = preg_replace('/\?>\s*$/', '', $code);

            $label = null;
            $description = null;
            $summary = null;
            if (preg_match('#^\s*/\*\*(.*?)\*/[ \t]*\n?#s', $code, $m)) {
                list($label, $description, $summary) = self::parseDocblock($m[1]);
                $code = substr($code, strlen($m[0]));
            }

            $code = rtrim(ltrim($code, "\n"));
            // Strip leading blank lines but keep the indentation of the first code line.
            $code = preg_replace('/^(?:[ \t]*\n)+/', '', $code);

            return [
                'name' => $label !== null && $label !== '' ? $label : self::humanize($fileName),
                'description' => $description !== null ? $description : ($summary !== null ? $summary : ''),
                'code' => $code,
            ];
        }

        /**
         * @param string $body docblock contents between `/**` and `*\/`
         * @return array{0:?string,1:?string,2:?string} [label, description, summary]
         */
        private static function parseDocblock($body)
        {
            $lines = [];
            foreach (explode("\n", $body) as $line) {
                $lines[] = rtrim(preg_replace('/^\s*\*?\s?/', '', $line));
            }
            $label = null;
            $description = null;
            $summary = [];
            $current = null;
            $inTags = false;
            foreach ($lines as $line) {
                $trimmed = trim($line);
                if (preg_match('/^@(\w[\w-]*)\s*(.*)$/', $trimmed, $m)) {
                    $inTags = true;
                    $tag = strtolower($m[1]);
                    $current = $tag === 'label' || $tag === 'description' ? $tag : null;
                    if ($tag === 'label') {
                        $label = trim($m[2]);
                    } elseif ($tag === 'description') {
                        $description = trim($m[2]);
                    }
                    continue;
                }
                if ($inTags) {
                    // Multi-line @description continues until the next tag or a blank line.
                    if ($trimmed === '') {
                        $current = null;
                    } elseif ($current === 'description') {
                        $description = trim($description . ' ' . $trimmed);
                    } elseif ($current === 'label') {
                        $label = trim($label . ' ' . $trimmed);
                    }
                    continue;
                }
                if ($trimmed !== '') {
                    $summary[] = $trimmed;
                } elseif ($summary) {
                    // The summary is the first paragraph.
                    $inTags = true;
                }
            }

            return [$label, $description, $summary ? implode(' ', $summary) : null];
        }

        /**
         * "count-active_users.php" → "Count active users", "listRecentOrders.php" → "List recent orders",
         * "02_recentOrders.php" → "Recent orders".
         */
        public static function humanize($fileName)
        {
            $name = preg_replace('/\.php$/i', '', basename((string) $fileName));
            // Numeric prefixes only order the files ("01-count-users", "10_report"): not part of the name.
            $unprefixed = preg_replace('/^\d+[\s_\-.]+/', '', $name);
            if ($unprefixed !== '' && $unprefixed !== null) {
                $name = $unprefixed;
            }
            $name = preg_replace('/(?<=[a-z0-9])(?=[A-Z])/', ' ', $name);
            $name = trim(preg_replace('/[\s_\-.]+/', ' ', $name));
            if ($name === '') {
                return (string) $fileName;
            }
            $name = strtolower($name);

            return strtoupper($name[0]) . substr($name, 1);
        }
    }
}
