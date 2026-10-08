# Changelog

## 0.1.0 — First release

### Running code
- Run PHP with ⌘R / Ctrl+R in a fresh PHP process per run, inside your project's framework context.
- Run only the selected code; leading `<?php` is optional; missing trailing semicolons are fine.
- The value of the last expression is shown like `php artisan tinker`.
- Optional `declare(strict_types=1)`, buffered or real-time output, timeouts and stopping a run.
- Laravel Sandbox (a full Laravel app) for tinkering without a project, plus plain PHP mode.

### Frameworks
- Built-in drivers for Laravel, Lumen, Laravel Zero, Statamic, October CMS, Testbench, Symfony,
  WordPress (incl. Bedrock & Radicle), Drupal 7/8+, Craft CMS, Magento 2, Shopware, Kirby, Moodle, PrestaShop,
  TYPO3, CakePHP, CodeIgniter 4, Yii 2, Joomla and any Composer project.
- Custom drivers: PHP classes extending `Tinkerbox\Drivers\Driver` (or a built-in driver) in
  `~/.config/tinkerbox/drivers` and `<project>/.tinkerbox/drivers`, with their own variables, panels and log paths.
- Tinker-style class aliasing (`User::first()` without the namespace).

### Output
- Cards view for every echo, dump, query and the return value, with source line labels.
- CLI mode with PsySH-style output.
- SQL query inspection, Table Preview with CSV export, Object Graph, HTML preview for mailables and views.
- Collision-style exceptions with code snippets.

### Editor
- Monaco editor with magic comments (`//?`, `/*?*/`, `/*?->method()*/`, `/*?.*/`), live code coverage,
  inline errors, project-aware autocompletion, Prettier formatting and an optional Vim keymap.

### Workspace
- Tabs, Open Anything (⇧⌘P), History, Snippets (including project snippets from `.tinkerbox/snippets`),
  Log Viewer, App Information panels, themes (including custom Monaco themes), customizable shortcuts,
  Laravel Herd integration and Share as Gist.
- Xdebug step debugging per project, a `tinkerbox` command line helper and `tinkerbox://open` links.
- Released under the MIT license (see `LICENSE`).
