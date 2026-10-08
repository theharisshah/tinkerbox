<?php

namespace {
    if (!function_exists('__tinkerbox_eval')) {
        /**
         * Isolated scope of the user's code (docs/ARCHITECTURE.md §1.4 step 8): a plain function, so the code has
         * no `$this`, no class scope and sees only the driver's variables (Driver::variables()).
         *
         * Because the code runs inside this function, its file-scope variables are locals. The names the code uses
         * with `global $x` or `$GLOBALS['x']` (CodeTransformer `globals`) are therefore linked to the real globals
         * first, so `$config = …; function cfg() { global $config; … }` works like in a PHP script (a driver
         * variable of that name becomes the global's value).
         *
         * `Runner::beginEval()` MUST stay on the same line as `eval()`: it receives the exact file name PHP
         * reports for the eval()'d code ("<file>(<line>) : eval()'d code"), which maps frames to editor lines.
         *
         * @internal
         * @return mixed the value returned by the user's code
         */
        function __tinkerbox_eval()
        {
            extract(\Tinkerbox\Runner::scopeVariables(), EXTR_SKIP);
            foreach (\Tinkerbox\Runner::globalNames() as $__tinkerboxGlobal) {
                if (array_key_exists($__tinkerboxGlobal, get_defined_vars())) $GLOBALS[$__tinkerboxGlobal] = $$__tinkerboxGlobal;
                global $$__tinkerboxGlobal;
            }
            unset($__tinkerboxGlobal);
            \Tinkerbox\Runner::beginEval(__FILE__ . '(' . __LINE__ . ") : eval()'d code"); return eval(\Tinkerbox\Runner::evalCode());
        }
    }

    if (!function_exists('__tinkerbox_define_helpers')) {
        /**
         * Declares Tinkerbox's global helpers when the project does not define them itself
         * (docs/ARCHITECTURE.md §1.4 step 5). Called by the runner AFTER the framework bootstrapped, so a
         * project's own dump()/dd() (Symfony VarDumper, Laravel) always wins and an unguarded project
         * definition can never trigger "Cannot redeclare".
         *
         * - dump(...$vars)  records one dump event per value (call site from the backtrace); returns the first.
         * - dd(...$vars)    like dump(), then ends the run (the envelope reports `exited`).
         * - tw($value, $label = null)  labelled dump; returns $value.
         *
         * Calls written in the editor code itself are rewritten by the CodeTransformer (exact editor lines);
         * these functions catch the remaining calls (callbacks such as array_map('dump', …), project code).
         *
         * @param string[] $skip names the user's code declares itself (CodeTransformer `declaredFunctions`)
         */
        function __tinkerbox_define_helpers(array $skip = [])
        {
            $skip = array_change_key_case(array_flip(array_map('strval', $skip)), CASE_LOWER);

            if (!function_exists('dump') && !isset($skip['dump'])) {
                function dump(...$vars)
                {
                    return \Tinkerbox\Capture::helperDump('dump', $vars);
                }
            }

            if (!function_exists('dd') && !isset($skip['dd'])) {
                function dd(...$vars)
                {
                    \Tinkerbox\Capture::helperDump('dd', $vars);
                }
            }

            if (!function_exists('tw') && !isset($skip['tw'])) {
                function tw($value, $label = null)
                {
                    \Tinkerbox\Capture::dumpFromHandler($value, $label);
                    return $value;
                }
            }
        }
    }
}
