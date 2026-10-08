<?php

require_once __DIR__ . '/support/helpers.php';
t_load_runner_sources();

use Tinkerbox\ProjectSnippets;

return [
    'reads .tinkerbox/snippets/*.php sorted by file name' => function () {
        $project = p4_fixtures('snippets-project');
        $snippets = ProjectSnippets::read($project);
        t_same(['01-count-users.php', '02_recentOrders.php', '3-inline.php', '10-with-summary.php'], array_map('basename', array_column($snippets, 'file')), 'natural order, no hidden / non-php files');
        foreach ($snippets as $snippet) {
            p4_assert_keys($snippet, ['name', 'description', 'code', 'file'], [], 'project snippet');
            t_assert(is_string($snippet['name']) && is_string($snippet['description']) && is_string($snippet['code']), 'string fields');
            t_same(realpath($project . '/.tinkerbox/snippets/' . basename($snippet['file'])), realpath($snippet['file']), 'file is the absolute path');
        }

        t_same('Count users', $snippets[0]['name']);
        t_same('Shows how many users exist, continued on the next line.', $snippets[0]['description']);
        t_same('User::count();', $snippets[0]['code']);

        t_same('Recent orders', $snippets[1]['name'], 'name falls back to the humanized file name');
        t_same('', $snippets[1]['description']);
        t_same('Order::latest()->take(5)->get();', $snippets[1]['code']);

        t_same('Inline label', $snippets[2]['name']);
        t_same("echo 'hello';", $snippets[2]['code'], 'open tag + inline docblock + closing tag removed');

        t_same('With summary', $snippets[3]['name']);
        t_same('Lists the queue size per connection.', $snippets[3]['description'], 'docblock summary used when there is no @description');
        t_same("// comment stays\nforeach (['redis', 'sqs'] as \$connection) {\n    echo Queue::connection(\$connection)->size(), PHP_EOL;\n}", $snippets[3]['code']);
    },

    'missing project / folder yields no snippets' => function () {
        t_same([], ProjectSnippets::read(''));
        t_same([], ProjectSnippets::read('/definitely/not/a/project'));
        t_same([], ProjectSnippets::read(p4_fixtures('logs')));
    },

    'CRLF, BOM, short open tags and code that starts with a later docblock' => function () {
        $project = p4_tmpdir('snippets');
        mkdir($project . '/.tinkerbox/snippets', 0777, true);
        file_put_contents($project . '/.tinkerbox/snippets/windows.php', "\xEF\xBB\xBF<?php\r\n/**\r\n * @label Windows file\r\n */\r\n\$a = 1;\r\n\$a++;\r\n");
        file_put_contents($project . '/.tinkerbox/snippets/later-doc.php', "<?php\n\$x = 1;\n/** @label not leading */\n\$x;\n");
        file_put_contents($project . '/.tinkerbox/snippets/no-tag.php', "  \$plain = true;\n");
        file_put_contents($project . '/.tinkerbox/snippets/huge.php', "<?php\n" . str_repeat('// filler' . "\n", 120000));
        $snippets = ProjectSnippets::read($project);
        $byFile = [];
        foreach ($snippets as $snippet) {
            $byFile[basename($snippet['file'])] = $snippet;
        }
        t_assert(!isset($byFile['huge.php']), 'files over 1 MB are skipped');
        t_same('Windows file', $byFile['windows.php']['name']);
        t_same("\$a = 1;\n\$a++;", $byFile['windows.php']['code']);
        t_same('Later doc', $byFile['later-doc.php']['name'], 'only a leading docblock is metadata');
        t_same("\$x = 1;\n/** @label not leading */\n\$x;", $byFile['later-doc.php']['code']);
        t_same('  $plain = true;', $byFile['no-tag.php']['code'], 'indentation of the first line is kept');
    },

    'humanized names' => function () {
        t_same('Count active users', ProjectSnippets::humanize('count-active_users.php'));
        t_same('List recent orders', ProjectSnippets::humanize('listRecentOrders.php'));
        t_same('Top10 customers', ProjectSnippets::humanize('top10Customers.php'));
        t_same('Report v2', ProjectSnippets::humanize('report.v2.php'));
        t_same('Recent orders', ProjectSnippets::humanize('02_recentOrders.php'), 'ordering prefix dropped');
        t_same('2024', ProjectSnippets::humanize('2024.php'), 'a purely numeric name is kept');
    },
];
