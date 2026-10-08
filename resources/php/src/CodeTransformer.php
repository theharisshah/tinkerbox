<?php

namespace Tinkerbox {
    /**
     * Rewrites the editor code before it is eval()'d (docs/ARCHITECTURE.md §1.5).
     *
     * Everything is driven by token_get_all() plus a small structural statement parser: never regex on raw
     * code. Every edit is an insertion or a replacement *within an existing line* (inserted text never
     * contains a newline), so every original line keeps its line number in the evaluated code.
     *
     * Rules implemented:
     *  1. A leading `<?php` / `<?` open tag (and a UTF-8 BOM) is blanked out.
     *  2. Prefix `declare(strict_types=1);` at the start of line 1 when requested (after the user's own leading
     *     `declare` statements when they declare strict_types themselves).
     *  3. `echo a, b;` → `\Tinkerbox\Capture::echoAt(L, a) . \Tinkerbox\Capture::echoAt(L, b);` at any nesting
     *     depth: one call per argument, so `a` is printed before `b` is evaluated (like PHP's own ZEND_ECHO).
     *  4. Calls of the global `dump()` / `dd()` / `var_dump()` → `\Tinkerbox\Capture::dumpAt(L, 'dump', [ARGS])`.
     *  5. The last top-level expression statement gets `return ` (PsySH semantics); a missing trailing `;` is
     *     inserted after the last significant token.
     *  6. Magic comments: `//?`, `//? label`, `#?`, `//?->method()`, `/*?*\/`, `/*?->expr*\/`, `/*? label *\/`
     *     and `/*?.*\/` (timing) → `\Tinkerbox\Magic::capture()` / `\Tinkerbox\Magic::time()` wrappers. Operands
     *     the callee may take by reference (by-ref arguments, `foreach (… as &$v)`, writes through `$a/*?*\/[…]`,
     *     `return` in `function &f()`) use the reference-returning `Magic::captureRef()` / `Magic::timeRef()`;
     *     write targets and constant expressions (property / constant / parameter defaults, attribute arguments,
     *     enum case values, static initializers before PHP 8.3, declare()) are never wrapped.
     *  7. Coverage: `\Tinkerbox\Capture::cover(N);` markers in front of every executable statement (braceless
     *     control-structure bodies are wrapped in `{ … }`). Arrow-function bodies, match arms and ternary
     *     branches on lines of their own get an expression marker (`\Tinkerbox\Capture::cover(-K) ?? expr`,
     *     cover() returns null) so their lines only count when they run. `&&` / `||` / `??` operands keep
     *     statement granularity. `declare(ticks=1)` is only used as a fallback: ticks never fire for `return`
     *     statements (so the auto-returned last line would never be covered), report different lines on PHP 7.4
     *     and 8.x for multi-line statements and cost ~10x more than markers.
     *  8. Names used with `global $x` / `$GLOBALS['x']` are reported (`globals`): the runner links those
     *     variables of the user's scope to the real globals, so file-scope code and functions share them.
     *
     * Safety net: the result is validated with `token_get_all(…, TOKEN_PARSE)`. When the user's own code does
     * not parse it is returned untouched (so PHP reports the real ParseError at the right line); when only the
     * transformed code fails, the magic comments that edited the failing line are skipped first (reported in
     * `skippedMagicLines`), then features are disabled one by one until it parses.
     *
     * Runs on PHP 7.4 → 8.5. Tokens are compared by *name* (token_name()), so tokens that only exist on newer
     * versions (T_NAME_QUALIFIED, T_MATCH, T_ATTRIBUTE, T_ENUM, …) never need global constants — defining
     * those globally would confuse libraries that feature-detect the PHP 8 tokenizer with defined().
     */
    final class CodeTransformer
    {
        const PREFIX = '<?php ';
        const MAX_COVERAGE_LINES = 10000;
        /** Magic comments skipped one by one (by the line PHP reports a ParseError on) before degrading globally. */
        const MAX_SKIPPED_COMMENT_LINES = 8;

        // Insertion levels: lower levels are further outside when several edits share a token.
        const LEVEL_PREFIX = -10;
        const LEVEL_BRACE = -4;
        const LEVEL_MARKER = -3;
        const LEVEL_RETURN = -2;
        const LEVEL_SEMICOLON = -1;
        const LEVEL_ECHO = 0;
        const LEVEL_MAGIC = 1;
        const LEVEL_INLINE = 2;

        /** @var array<int, string> token id => token name cache */
        private static $names = [];

        private static $insignificant = ['T_WHITESPACE' => true, 'T_COMMENT' => true, 'T_DOC_COMMENT' => true, 'T_OPEN_TAG' => true];
        private static $openers = ['(' => true, '[' => true, '{' => true, 'T_CURLY_OPEN' => true, 'T_DOLLAR_OPEN_CURLY_BRACES' => true, 'T_ATTRIBUTE' => true];
        private static $closers = [')' => true, ']' => true, '}' => true];
        private static $terminators = [';' => true, 'T_CLOSE_TAG' => true];
        private static $ampersands = ['&' => true, 'T_AMPERSAND_FOLLOWED_BY_VAR_OR_VARARG' => true, 'T_AMPERSAND_NOT_FOLLOWED_BY_VAR_OR_VARARG' => true];
        private static $memberOperators = ['T_OBJECT_OPERATOR' => true, 'T_NULLSAFE_OBJECT_OPERATOR' => true, 'T_DOUBLE_COLON' => true];
        private static $nameKinds = ['T_STRING' => true, 'T_NAME_QUALIFIED' => true, 'T_NAME_FULLY_QUALIFIED' => true, 'T_NAME_RELATIVE' => true, 'T_STATIC' => true];
        private static $magicConstants = ['T_LINE' => true, 'T_FILE' => true, 'T_DIR' => true, 'T_CLASS_C' => true, 'T_TRAIT_C' => true, 'T_METHOD_C' => true, 'T_FUNC_C' => true, 'T_NS_C' => true, 'T_PROPERTY_C' => true];
        private static $literals = ['T_LNUMBER' => true, 'T_DNUMBER' => true, 'T_CONSTANT_ENCAPSED_STRING' => true];
        /** Language constructs whose parenthesised form is a complete operand: array(…), isset(…), … */
        private static $constructs = ['T_ARRAY' => true, 'T_LIST' => true, 'T_ISSET' => true, 'T_EMPTY' => true, 'T_EXIT' => true, 'T_EVAL' => true];
        private static $controlHeads = ['T_IF' => true, 'T_ELSEIF' => true, 'T_WHILE' => true, 'T_FOR' => true, 'T_FOREACH' => true, 'T_SWITCH' => true, 'T_CATCH' => true, 'T_DECLARE' => true, 'T_MATCH' => true, 'T_FUNCTION' => true, 'T_FN' => true, 'T_USE' => true];
        /** Tokens ending a ternary else-branch at the same bracket depth (besides stops / closers). */
        private static $branchEnds = [',' => true, ';' => true, 'T_DOUBLE_ARROW' => true, 'T_LOGICAL_AND' => true, 'T_LOGICAL_OR' => true, 'T_LOGICAL_XOR' => true, 'T_AS' => true, 'T_CLOSE_TAG' => true];
        /** Superglobals and special variables that are never linked to $GLOBALS. */
        private static $specialVariables = ['this' => true, 'GLOBALS' => true, '_SERVER' => true, '_GET' => true, '_POST' => true, '_FILES' => true, '_COOKIE' => true, '_SESSION' => true, '_REQUEST' => true, '_ENV' => true];
        /** Global functions known to take every argument by value (the runner's helpers may not exist yet). */
        private static $byValueHelpers = ['dump' => true, 'dd' => true, 'var_dump' => true, 'tw' => true];
        private static $writeOperators = [
            '=' => true, 'T_PLUS_EQUAL' => true, 'T_MINUS_EQUAL' => true, 'T_MUL_EQUAL' => true, 'T_DIV_EQUAL' => true,
            'T_CONCAT_EQUAL' => true, 'T_MOD_EQUAL' => true, 'T_AND_EQUAL' => true, 'T_OR_EQUAL' => true, 'T_XOR_EQUAL' => true,
            'T_SL_EQUAL' => true, 'T_SR_EQUAL' => true, 'T_POW_EQUAL' => true, 'T_COALESCE_EQUAL' => true, 'T_INC' => true, 'T_DEC' => true,
        ];
        /** Statement kinds that never get a coverage marker. */
        private static $unmarked = ['empty' => true, 'html' => true, 'decl' => true, 'use' => true, 'namespace' => true, 'nsblock' => true, 'declare' => true, 'declblock' => true, 'label' => true, 'halt' => true, 'tagecho' => true];
        private static $wrappable = ['expr' => true, 'echo' => true, 'print' => true, 'return' => true];
        private static $dumpFunctions = ['dump' => true, 'dd' => true, 'var_dump' => true];

        /** @var array{magic: bool, inline: bool, coverage: bool, markers: bool, rewrites: bool, strict: bool} */
        private $features;
        private $lineOffset;
        private $code;

        // Tokens (parallel arrays): kind (token name or the character itself), text, line. Kept lean on purpose:
        // the transformer must fit large pastes into the memory_limit next to a bootstrapped framework.
        private $k = [];
        private $t = [];
        private $ln = [];
        /** @var int[] token indexes of significant tokens; the parser works on positions in this list */
        private $sig = [];
        /** @var int number of significant tokens */
        private $S = 0;
        /** @var array<int, int> comment token index => position of the last significant token before it (-1 if none) */
        private $commentPrev = [];
        /** @var array<int, int> comment token index => byte offset in $code */
        private $commentOffset = [];
        /** @var array<int, int> bracket position => matching bracket position */
        private $match = [];
        /** @var int[] byte offset of each line start (1-based) */
        private $lineStarts = [];

        /** @var array[] statement records (see stmt()) */
        private $st = [];
        /** @var array[] statement lists: ['open' => ?pos, 'close' => ?pos, 'ids' => int[]] */
        private $lists = [];
        /** @var array<int, int> open brace position => close position of statement bodies and class bodies */
        private $spans = [];
        /** @var array<int, bool> `{` positions of class / interface / trait / enum bodies (constant-expression scope) */
        private $classBodies = [];
        /** @var array<int, bool> `{` positions of PHP 8.4 property hook lists */
        private $hookLists = [];
        /** @var array<int, bool> `{` positions opening statement lists (function / control bodies, switch) */
        private $listBraces = [];
        /** @var array<int, bool> positions of tokens that end a statement or open a statement list (`;`, `}`, `{`, `:`, `?>`) */
        private $boundaries = [];
        /** @var int[] top-level statement ids */
        private $top = [];
        private $halted = false;
        /** Nesting of function bodies while parsing (0 = file scope). */
        private $fnDepth = 0;
        /** The function body being parsed returns by reference (`function &f()`). */
        private $byRefFn = false;
        /** @var array<string, bool> lower-case names of functions declared by the user code */
        private $declaredFunctions = [];
        /** @var array<string, array[]> lower-case function name => parameter list (see parameters()) */
        private $functionParams = [];
        /** @var array<string, array[][]> lower-case method name => parameter lists of the methods with that name */
        private $methodParams = [];
        /** @var array<string, bool> lower-case names imported with `use function` */
        private $importedFunctions = [];
        /** @var array[] namespaces: ['from' => pos, 'to' => pos|null, 'name' => string] */
        private $namespaces = [];
        /** @var array<string, bool> variable names used with `global` / `$GLOBALS['…']` */
        private $globalCandidates = [];
        /** @var array<string, bool> those of them the code also uses as file-scope variables (linked to the globals) */
        private $globalNames = [];
        /** @var array[] [from, to] position ranges of function bodies and class bodies (not file scope) */
        private $scopeRanges = [];
        /** @var int|null id of the last top-level statement (it receives the inserted `return`) */
        private $lastStatement = null;
        /** @var array<int, int> return statement exprStart => statement id */
        private $returnsByExpr = [];
        /** @var array<int, array> arrow function body start => ['end' => pos, 'byRef' => bool] */
        private $arrowBodies = [];
        /**
         * @var array[] expression spans that may get their own coverage marker:
         *   ['from' => pos, 'to' => pos, 'after' => pos (the marker goes after this token)]
         */
        private $exprSpans = [];
        /** @var array<int, int> span start => span end (outermost) of the expression spans that are in use */
        private $exprSpanAt = [];
        private $nextSpanKey = 0;
        /** @var array<int, array<int, bool>> code line holding magic-comment edits => code lines of those comments */
        private $magicEditLines = [];
        /** @var array<int, bool> code lines of `//?->` comments whose tap is not a valid member chain */
        private $invalidMagicLines = [];

        /** @var array<int, array[]> token index => insertions before / after the token */
        private $before = [];
        private $after = [];
        /** @var array<int, string> token index => replacement text */
        private $repl = [];
        private $seq = 0;
        private $prefixText = '';
        /** @var array<int, array<int, bool>> editor start line => editor lines covered when it runs */
        private $coverageMap = [];

        /**
         * @param string $code       editor code (or selection)
         * @param array  $options    RunOptions (magicComments, coverage, strictTypes are used)
         * @param int    $lineOffset editor line of the first code line
         * @return array{code: string, hasReturnValue: bool, returnLine: ?int, hasTopLevelReturn: bool, coverage: string, coverageMap: array<int, int[]>, declaredFunctions: string[], globals: string[], disabled: string[], skippedMagicLines: int[]}
         *   coverage: 'markers' (Capture::cover() calls), 'ticks' (declare(ticks=1) + Capture::tick()) or 'none';
         *   coverageMap: marker key (a statement's editor start line, or a negative key for expression markers)
         *   => editor lines covered when it runs;
         *   declaredFunctions: lower-case names of the functions the code declares (the runner must not define
         *   helpers with those names, or the user's declaration would be a "Cannot redeclare" fatal error);
         *   globals: variable names the code uses with `global` / `$GLOBALS['…']` (linked to the real globals);
         *   skippedMagicLines: editor lines of magic comments that were skipped because they broke the code.
         */
        public static function transform($code, array $options = [], $lineOffset = 1)
        {
            $code = self::stripOpenTag((string) $code);
            $lineOffset = max(1, (int) $lineOffset);
            $magic = !array_key_exists('magicComments', $options) || (bool) $options['magicComments'];
            $coverage = !array_key_exists('coverage', $options) || (bool) $options['coverage'];
            $full = [
                'magic' => $magic,
                'inline' => $magic,
                'coverage' => $coverage,
                'markers' => $coverage,
                'rewrites' => true,
                'strict' => !empty($options['strictTypes']),
            ];

            // 1. Everything on; a magic comment that breaks the code (e.g. an invalid `//?->` tap) is skipped on
            //    its own, by the line PHP reports the ParseError on, so the other comments keep working.
            $skip = [];
            $first = true;
            while (true) {
                $result = self::attempt($code, $full + ['skip' => $skip], $lineOffset);
                $error = $result === null ? 0 : self::parseError($result['code']);
                if ($error === null) return self::finish($result, $full, $full, $skip, $lineOffset);
                if ($first) {
                    $first = false;
                    // Does the user's code parse at all (with a missing trailing semicolon tolerated)? If not,
                    // evaluate it untouched so PHP reports the genuine ParseError at the right line.
                    $minimal = self::attempt($code, ['magic' => false, 'inline' => false, 'coverage' => false, 'markers' => false, 'rewrites' => false, 'strict' => false], $lineOffset);
                    if ($minimal === null || !self::parses($minimal['code'])) {
                        return self::bare($code);
                    }
                }
                if ($result === null || $error < 1 || !isset($result['magicEditLines'][$error]) || count($skip) >= self::MAX_SKIPPED_COMMENT_LINES) break;
                $count = count($skip);
                foreach ($result['magicEditLines'][$error] as $commentLine => $unused) $skip[$commentLine] = true;
                if (count($skip) === $count) break;
            }

            // 2. Progressive degradation: each attempt disables one more feature.
            $features = $full;
            foreach (['inline', 'magic', 'markers', 'rewrites'] as $feature) {
                if (!$features[$feature]) continue;
                $features[$feature] = false;
                $result = self::attempt($code, $features + ['skip' => $skip], $lineOffset);
                if ($result !== null && self::parses($result['code'])) {
                    return self::finish($result, $full, $features, $features['magic'] ? $skip : [], $lineOffset);
                }
            }
            return self::bare($code);
        }

        /** Public result shape: features that had to be dropped and magic comments that were skipped. */
        private static function finish(array $result, array $full, array $features, array $skip, $lineOffset)
        {
            $skip += $features['magic'] ? $result['invalidMagicLines'] : [];
            unset($result['magicEditLines'], $result['invalidMagicLines']);
            $result['disabled'] = [];
            foreach ($full as $feature => $on) {
                if ($on && !$features[$feature]) $result['disabled'][] = $feature;
            }
            $lines = [];
            foreach ($skip as $line => $unused) $lines[] = $line + $lineOffset - 1;
            sort($lines);
            $result['skippedMagicLines'] = $lines;
            return $result;
        }

        /** Untouched code (used when the user's code itself has a syntax error). */
        private static function bare($code)
        {
            return ['code' => $code, 'hasReturnValue' => false, 'returnLine' => null, 'hasTopLevelReturn' => false, 'coverage' => 'none', 'coverageMap' => [], 'declaredFunctions' => [], 'globals' => [], 'disabled' => ['all'], 'skippedMagicLines' => []];
        }

        /** @return array|null null when the transformer itself failed (never let a runner bug break a run) */
        private static function attempt($code, array $features, $lineOffset)
        {
            try {
                $transformer = new self($code, $features, $lineOffset);
                return $transformer->build();
            } catch (\Throwable $e) {
                return null;
            }
        }

        /** True when $code (evaluated in PHP mode, like eval()) is syntactically valid on this PHP version. */
        public static function parses($code)
        {
            return self::parseError($code) === null;
        }

        /** null when $code parses, else the line of the ParseError (0 when unknown). */
        private static function parseError($code)
        {
            try {
                @token_get_all(self::PREFIX . $code, TOKEN_PARSE);
                return null;
            } catch (\ParseError $e) {
                return max(0, (int) $e->getLine());
            }
        }

        /**
         * Blank out a leading `<?php` / `<?` open tag (replaced by spaces so columns stay stable) and drop a
         * UTF-8 BOM. Leading whitespace before the tag is allowed.
         */
        public static function stripOpenTag($code)
        {
            if (strncmp($code, "\xEF\xBB\xBF", 3) === 0) $code = (string) substr($code, 3);
            $ws = strspn($code, " \t\r\n");
            $rest = (string) substr($code, $ws);
            foreach (['<?php', '<?'] as $tag) {
                $len = strlen($tag);
                if (strncasecmp($rest, $tag, $len) !== 0) continue;
                $following = (string) substr($rest, $len, 1);
                if ($following === '' || strpos(" \t\r\n", $following) !== false) {
                    return substr($code, 0, $ws) . str_repeat(' ', $len) . (string) substr($rest, $len);
                }
            }
            return $code;
        }

        private function __construct($code, array $features, $lineOffset)
        {
            $this->code = $code;
            $this->features = $features;
            $this->lineOffset = $lineOffset;
        }

        private function build()
        {
            $this->tokenize();
            $this->computeMatches();
            $this->fnDepth = 0;
            list($this->top) = $this->parseList(0, [], null);
            $this->collectGlobalNames();
            $this->finalizeSpans();

            if ($this->features['rewrites']) {
                $this->rewriteEchos();
                $this->rewriteDumps();
            }
            $return = $this->applyReturn();
            if ($this->features['magic']) $this->applyMagicComments();
            if ($this->features['coverage'] && $this->features['markers']) $this->applyMarkers();
            $this->applyPrefix();

            $map = [];
            foreach ($this->coverageMap as $line => $lines) {
                $lines = array_keys($lines);
                sort($lines);
                $map[$line] = $lines;
            }

            return [
                'code' => $this->render(),
                'hasReturnValue' => $return['hasReturnValue'],
                'returnLine' => $return['returnLine'],
                'hasTopLevelReturn' => $return['hasTopLevelReturn'],
                'coverage' => $this->features['coverage'] ? ($this->features['markers'] ? 'markers' : 'ticks') : 'none',
                'coverageMap' => $map,
                'declaredFunctions' => array_keys($this->declaredFunctions),
                'globals' => array_keys($this->globalNames),
                'magicEditLines' => $this->magicEditLines,
                'invalidMagicLines' => $this->invalidMagicLines,
            ];
        }

        // ------------------------------------------------------------------------------------------------
        // Tokens
        // ------------------------------------------------------------------------------------------------

        private static function tokenName($id)
        {
            if (!isset(self::$names[$id])) self::$names[$id] = token_name($id);
            return self::$names[$id];
        }

        private function tokenize()
        {
            // PHP 7.4 warns about stray bytes / unterminated comments while lexing; PHP itself reports those when
            // the code is evaluated, so the tokenizer must stay silent (no duplicate diagnostics).
            $tokens = @token_get_all(self::PREFIX . $this->code);
            $count = count($tokens);
            $line = 1;
            $offset = -strlen(self::PREFIX);
            $lastSig = -1;
            for ($i = 0; $i < $count; $i++) {
                $token = $tokens[$i];
                // token_get_all()'s arrays take ~3x the memory of the parallel arrays: free them as we go.
                unset($tokens[$i]);
                if (is_array($token)) {
                    $kind = self::tokenName($token[0]);
                    $text = $token[1];
                } else {
                    $kind = $token;
                    $text = $token;
                }
                $this->k[$i] = $kind;
                $this->t[$i] = $text;
                $this->ln[$i] = $line;
                if ($kind === 'T_COMMENT') {
                    $this->commentPrev[$i] = $lastSig;
                    $this->commentOffset[$i] = $offset;
                }
                if (!isset(self::$insignificant[$kind])) {
                    $lastSig = count($this->sig);
                    $this->sig[] = $i;
                }
                $line += substr_count($text, "\n");
                $offset += strlen($text);
            }
            $tokens = null;
            $this->S = count($this->sig);

            $this->lineStarts = [1 => 0];
            $pos = -1;
            $n = 1;
            while (($pos = strpos($this->code, "\n", $pos + 1)) !== false) {
                $this->lineStarts[++$n] = $pos + 1;
            }
        }

        private function computeMatches()
        {
            $stack = [];
            for ($p = 0; $p < $this->S; $p++) {
                $kind = $this->k[$this->sig[$p]];
                if (isset(self::$openers[$kind])) {
                    $stack[] = $p;
                } elseif (isset(self::$closers[$kind]) && $stack) {
                    $open = array_pop($stack);
                    $this->match[$open] = $p;
                    $this->match[$p] = $open;
                }
            }
        }

        /** Kind of the significant token at position $p (null outside the code). */
        private function kd($p)
        {
            return $p >= 0 && $p < $this->S ? $this->k[$this->sig[$p]] : null;
        }

        private function tx($p)
        {
            return $p >= 0 && $p < $this->S ? $this->t[$this->sig[$p]] : '';
        }

        private function tok($p)
        {
            return $this->sig[$p];
        }

        /** Code line (1-based) of the significant token at $p. */
        private function lineOf($p)
        {
            return $this->ln[$this->sig[$p]];
        }

        private function editorLine($codeLine)
        {
            return $codeLine + $this->lineOffset - 1;
        }

        /** Editor column (0-based, UTF-16 code units like Monaco) of the token at index $i. */
        private function column($i)
        {
            $line = $this->ln[$i];
            $start = isset($this->lineStarts[$line]) ? $this->lineStarts[$line] : 0;
            $prefix = (string) substr($this->code, $start, max(0, $this->commentOffset[$i] - $start));
            // Characters = bytes that are not UTF-8 continuation bytes; 4-byte sequences are 2 UTF-16 units.
            return strlen($prefix) - preg_match_all('/[\x80-\xBF]/', $prefix) + preg_match_all('/[\xF0-\xF7]/', $prefix);
        }

        private function isAmp($p)
        {
            return isset(self::$ampersands[(string) $this->kd($p)]);
        }

        private function isIdentifier($p)
        {
            return (bool) preg_match('/^[A-Za-z_\x80-\xff][A-Za-z0-9_\x80-\xff]*$/', $this->tx($p));
        }

        // ------------------------------------------------------------------------------------------------
        // Structural parser
        // ------------------------------------------------------------------------------------------------

        /**
         * @param array    $extra statement fields beyond the defaults
         * @return int statement id
         */
        private function stmt($kind, $start, $end, array $extra = [])
        {
            $this->st[] = $extra + [
                'kind' => $kind,
                'start' => $start,
                'end' => max($start, min($end, $this->S - 1)),
                'term' => null,
                'exprStart' => null,
                'exprEnd' => null,
                'headerEnd' => null,
                'braceless' => false,
                'needsTerm' => false,
                'fileScope' => $this->fnDepth === 0,
                'byRef' => $this->fnDepth > 0 && $this->byRefFn,
                'inner' => null,
            ];
            $id = count($this->st) - 1;
            if ($kind === 'return' && isset($extra['exprStart'])) $this->returnsByExpr[$extra['exprStart']] = $id;
            return $id;
        }

        /**
         * Run $parse inside a function body starting at $from (by-reference or not); returns its result, the
         * position after the body.
         */
        private function inFunction($byRef, $from, callable $parse)
        {
            $saved = $this->byRefFn;
            $this->byRefFn = (bool) $byRef;
            $this->fnDepth++;
            try {
                $next = $parse();
                $this->scopeRanges[] = [$from, $next - 1];
                return $next;
            } finally {
                $this->fnDepth--;
                $this->byRefFn = $saved;
            }
        }

        /**
         * Parse statements until a token whose kind is in $ends (not consumed) or the end of the code.
         * @param int|null $open position of the token that opened the list ('{', ':' …), null for top level
         * @return array{0: int[], 1: int, 2: int} [statement ids, position after the list, list index]
         */
        private function parseList($p, array $ends, $open)
        {
            $ids = [];
            if ($open !== null) $this->boundaries[$open] = true;
            while ($p < $this->S && !$this->halted) {
                if (isset($ends[$this->kd($p)])) break;
                list($id, $next) = $this->parseStatement($p);
                $ids[] = $id;
                $end = $this->st[$id]['end'];
                if (in_array($this->kd($end), [';', '}', ':', 'T_CLOSE_TAG'], true)) $this->boundaries[$end] = true;
                $p = $next > $p ? $next : $p + 1;
            }
            $this->lists[] = ['open' => $open, 'close' => $p < $this->S ? $p : null, 'ids' => $ids];
            return [$ids, $p, count($this->lists) - 1];
        }

        /** Parse a `{ … }` statement body at $open; returns [list index, position after `}`]. */
        private function parseBraces($open)
        {
            $this->listBraces[$open] = true;
            list(, $q, $list) = $this->parseList($open + 1, ['}' => true], $open);
            if ($this->kd($q) === '}') {
                $this->spans[$open] = $q;
                return [$list, $q + 1];
            }
            return [$list, $q];
        }

        /** @return array{0: int, 1: int} [statement id, next position] */
        private function parseStatement($p)
        {
            $kind = $this->kd($p);
            switch ($kind) {
                case ';':
                case 'T_CLOSE_TAG':
                    return [$this->stmt('empty', $p, $p, ['term' => $p]), $p + 1];
                case 'T_INLINE_HTML':
                    return [$this->stmt('html', $p, $p), $p + 1];
                case '{':
                    list($list, $q) = $this->parseBraces($p);
                    return [$this->stmt('braces', $p, $q - 1, ['inner' => $list]), $q];
                case 'T_IF':
                    return $this->parseIf($p);
                case 'T_WHILE':
                case 'T_FOR':
                case 'T_FOREACH':
                    return $this->parseLoop($p);
                case 'T_DO':
                    return $this->parseDo($p);
                case 'T_SWITCH':
                    return $this->parseSwitch($p);
                case 'T_TRY':
                    return $this->parseTry($p);
                case 'T_DECLARE':
                    return $this->parseDeclare($p);
                case 'T_NAMESPACE':
                    if ($this->kd($p + 1) !== 'T_NS_SEPARATOR') return $this->parseNamespace($p);
                    break; // `namespace\foo()` on PHP 7.4 is an expression
                case 'T_FUNCTION':
                    $q = $this->isAmp($p + 1) ? $p + 2 : $p + 1;
                    if ($this->kd($q) !== '(') return $this->parseFunctionDecl($p, $p);
                    break; // closure expression statement
                case 'T_ABSTRACT':
                case 'T_FINAL':
                case 'T_READONLY':
                    $q = $p;
                    while (in_array($this->kd($q), ['T_ABSTRACT', 'T_FINAL', 'T_READONLY'], true)) $q++;
                    if ($this->kd($q) === 'T_CLASS') return $this->parseClassDecl($p, $q);
                    break;
                case 'T_CLASS':
                case 'T_INTERFACE':
                case 'T_TRAIT':
                case 'T_ENUM':
                    return $this->parseClassDecl($p, $p);
                case 'T_ATTRIBUTE':
                    $q = $p;
                    while ($this->kd($q) === 'T_ATTRIBUTE' && isset($this->match[$q])) $q = $this->match[$q] + 1;
                    $after = $this->kd($q);
                    if ($after === 'T_FUNCTION') {
                        $r = $this->isAmp($q + 1) ? $q + 2 : $q + 1;
                        if ($this->kd($r) !== '(') return $this->parseFunctionDecl($p, $q);
                    } elseif (in_array($after, ['T_ABSTRACT', 'T_FINAL', 'T_READONLY', 'T_CLASS', 'T_INTERFACE', 'T_TRAIT', 'T_ENUM'], true)) {
                        $r = $q;
                        while (in_array($this->kd($r), ['T_ABSTRACT', 'T_FINAL', 'T_READONLY'], true)) $r++;
                        return $this->parseClassDecl($p, $r);
                    } elseif ($this->isEnumDecl($q)) {
                        return $this->parseClassDecl($p, $q);
                    }
                    break; // attributed closure / arrow function expression
                case 'T_USE':
                    $this->recordFunctionImports($p);
                    return $this->parseSimple('use', $p);
                case 'T_GLOBAL':
                    for ($q = $p + 1; $q < $this->S && !isset(self::$terminators[$this->kd($q)]); $q++) {
                        if ($this->kd($q) === 'T_VARIABLE' && $this->kd($q - 1) !== '$') $this->addGlobalCandidate(substr($this->tx($q), 1));
                    }
                    return $this->parseSimple('other', $p);
                case 'T_CONST':
                case 'T_UNSET':
                case 'T_GOTO':
                case 'T_BREAK':
                case 'T_CONTINUE':
                case 'T_THROW':
                    return $this->parseSimple('other', $p);
                case 'T_OPEN_TAG_WITH_ECHO':
                    return $this->parseSimple('tagecho', $p);
                case 'T_STATIC':
                    if ($this->kd($p + 1) === 'T_VARIABLE') return $this->parseSimple('other', $p);
                    break; // static::, static fn, static function
                case 'T_ECHO':
                    return $this->parseExpression('echo', $p, $p + 1);
                case 'T_PRINT':
                    return $this->parseExpression('print', $p, $p + 1);
                case 'T_RETURN':
                    return $this->parseExpression('return', $p, $p + 1);
                case 'T_HALT_COMPILER':
                    $q = $p + 1;
                    while ($q < $this->S && $q <= $p + 3 && !isset(self::$terminators[$this->kd($q)])) $q++;
                    $this->halted = true;
                    return [$this->stmt('halt', $p, $q, ['term' => $q < $this->S ? $q : null]), $q + 1];
                case ')':
                case ']':
                case '}':
                    // Stray closer (broken code): consume it so parsing always makes progress.
                    return [$this->stmt('empty', $p, $p), $p + 1];
                case 'T_STRING':
                    if ($this->kd($p + 1) === ':') {
                        $this->boundaries[$p + 1] = true;
                        return [$this->stmt('label', $p, $p + 1), $p + 2];
                    }
                    if ($this->isEnumDecl($p)) return $this->parseClassDecl($p, $p);
                    break;
            }
            return $this->parseExpression('expr', $p, $p);
        }

        /** `enum Name {` / `enum Name: string` / `enum Name implements …` lexed as T_STRING (PHP < 8.1). */
        private function isEnumDecl($p)
        {
            return $this->kd($p) === 'T_STRING' && strtolower($this->tx($p)) === 'enum' && $this->kd($p + 1) === 'T_STRING'
                && in_array($this->kd($p + 2), ['{', ':', 'T_IMPLEMENTS'], true);
        }

        /** Statement made of an optional keyword and an expression up to `;` / `?>` (echo, print, return, expressions). */
        private function parseExpression($kind, $p, $exprStart)
        {
            $q = $this->scanExpr($exprStart, self::$terminators);
            $extra = ['needsTerm' => true];
            if ($q < $this->S && isset(self::$terminators[$this->kd($q)])) {
                $extra['term'] = $q;
                $end = $q;
                $next = $q + 1;
            } else {
                $end = $q - 1;
                $next = $q;
            }
            if ($q - 1 >= $exprStart) {
                $extra['exprStart'] = $exprStart;
                $extra['exprEnd'] = $q - 1;
            }
            return [$this->stmt($kind, $p, max($p, $end), $extra), max($next, $p + 1)];
        }

        private function parseSimple($kind, $p)
        {
            list($id, $next) = $this->parseExpression($kind, $p, $p + 1);
            $this->st[$id]['exprStart'] = null;
            $this->st[$id]['exprEnd'] = null;
            return [$id, $next];
        }

        /**
         * Scan an expression from $p to the first token (at bracket depth 0) whose kind is in $stops, an
         * unmatched closer, or the end. Closure and anonymous-class bodies met on the way are parsed as
         * statement lists (so magic comments, echo and coverage work inside them); arrow-function bodies,
         * match arms and ternary branches are recorded as expression spans (coverage).
         */
        private function scanExpr($p, array $stops)
        {
            // Open ternaries of this bracket level: ['then', start] until their `:`, then ['else', start].
            $ternaries = [];
            while ($p < $this->S) {
                $kind = $this->k[$this->sig[$p]];
                if ($kind === ':' && $ternaries && $this->closeTernaryThen($ternaries, $p)) {
                    $p++;
                    continue;
                }
                if (isset($stops[$kind]) || isset(self::$closers[$kind])) {
                    $this->closeTernaries($ternaries, $p);
                    return $p;
                }
                if (isset(self::$branchEnds[$kind])) {
                    $this->closeTernaries($ternaries, $p);
                } elseif ($kind === '?') {
                    $ternaries[] = ['then', $p + 1];
                } elseif ($kind === 'T_FUNCTION') {
                    $p = $this->parseClosure($p);
                    continue;
                } elseif ($kind === 'T_FN') {
                    $p = $this->parseArrowFunction($p);
                    continue;
                } elseif ($kind === 'T_MATCH' && $this->kd($p + 1) === '(') {
                    $p = $this->parseMatch($p);
                    continue;
                } elseif ($kind === 'T_NEW') {
                    $q = $p + 1;
                    while ($this->kd($q) === 'T_ATTRIBUTE' && isset($this->match[$q])) $q = $this->match[$q] + 1;
                    if ($this->kd($q) === 'T_CLASS') {
                        $p = $this->parseAnonymousClass($q);
                        continue;
                    }
                } elseif (isset(self::$openers[$kind])) {
                    // Nested brackets are scanned on their own level (ternaries / arrow functions inside them).
                    $q = $this->scanExpr($p + 1, []);
                    $p = $q < $this->S && isset(self::$closers[$this->kd($q)]) ? $q + 1 : $q;
                    continue;
                }
                $p++;
            }
            $this->closeTernaries($ternaries, $p);
            return $p;
        }

        /** A `:` at position $p closes the innermost open ternary then-branch; false when none is open. */
        private function closeTernaryThen(array &$ternaries, $p)
        {
            for ($i = count($ternaries) - 1; $i >= 0; $i--) {
                if ($ternaries[$i][0] !== 'then') continue;
                // Else-branches opened after that `?` end before this `:`.
                $this->closeTernaries($ternaries, $p, $i + 1);
                list(, $start) = array_pop($ternaries);
                // A span owns its operator token (`?`, `:`), so a branch on a line of its own is its own.
                if ($start <= $p - 1) $this->exprSpans[] = ['from' => $start - 1, 'to' => $p - 1, 'after' => $start - 1];
                $ternaries[] = ['else', $p + 1];
                return true;
            }
            return false;
        }

        /** End the open ternary branches (from index $from) before position $p. */
        private function closeTernaries(array &$ternaries, $p, $from = 0)
        {
            while (count($ternaries) > $from) {
                list($type, $start) = array_pop($ternaries);
                if ($type === 'else' && $start <= $p - 1) $this->exprSpans[] = ['from' => $start - 1, 'to' => $p - 1, 'after' => $start - 1];
            }
        }

        /** `fn (…) => body` at T_FN position $p; returns the position after the body. */
        private function parseArrowFunction($p)
        {
            $byRef = $this->isAmp($p + 1);
            $q = $byRef ? $p + 2 : $p + 1;
            if ($this->kd($q) !== '(' || !isset($this->match[$q])) return $p + 1;
            $q = $this->skipReturnType($this->match[$q] + 1);
            if ($this->kd($q) !== 'T_DOUBLE_ARROW') return $q;
            // The body is greedy (lowest precedence): it ends at `,` `;` `=>` a closer or a ternary's `:`.
            $end = $this->scanExpr($q + 1, [',' => true, ';' => true, 'T_DOUBLE_ARROW' => true, ':' => true, 'T_CLOSE_TAG' => true]);
            if ($end - 1 >= $q + 1) {
                $this->arrowBodies[$q + 1] = ['end' => $end - 1, 'byRef' => $byRef];
                // `fn&() => $x` must return a variable: no coverage marker in front of it.
                if (!$byRef) $this->exprSpans[] = ['from' => $q, 'to' => $end - 1, 'after' => $q];
            }
            return $end;
        }

        /** `match (…) { arms }` at T_MATCH position $p; every arm is an expression span. */
        private function parseMatch($p)
        {
            $q = $this->skipParens($p + 1);
            if ($this->kd($q) !== '{' || !isset($this->match[$q])) return $q;
            $close = $this->match[$q];
            $arm = $q + 1;
            while ($arm < $close) {
                if ($this->kd($arm) === ',') {
                    $arm++;
                    continue;
                }
                // Conditions (`1, 2 =>`) up to the arm's `=>`.
                $arrow = $arm;
                do {
                    $arrow = $this->scanExpr($arrow, ['T_DOUBLE_ARROW' => true, ',' => true]);
                } while ($this->kd($arrow) === ',' && ++$arrow < $close);
                if ($this->kd($arrow) !== 'T_DOUBLE_ARROW') {
                    $arm = max($arrow, $arm + 1);
                    continue;
                }
                $end = $this->scanExpr($arrow + 1, [',' => true]);
                // The arm owns its trailing `,`.
                if ($end - 1 > $arrow) $this->exprSpans[] = ['from' => $arm, 'to' => $this->kd($end) === ',' ? $end : $end - 1, 'after' => $arrow];
                $arm = max($end, $arm + 1);
            }
            return $close + 1;
        }

        /** Position after the `( … )` group starting at $p (closures inside are parsed); $p when there is none. */
        private function skipParens($p)
        {
            if ($this->kd($p) !== '(') return $p;
            $q = $this->scanExpr($p + 1, []);
            return $this->kd($q) === ')' ? $q + 1 : $q;
        }

        /** Closure at T_FUNCTION position $p; returns the position after its body. */
        private function parseClosure($p)
        {
            $byRef = $this->isAmp($p + 1);
            $q = $byRef ? $p + 2 : $p + 1;
            if ($this->kd($q) !== '(' || !isset($this->match[$q])) return $p + 1;
            $q = $this->match[$q] + 1;
            if ($this->kd($q) === 'T_USE' && $this->kd($q + 1) === '(' && isset($this->match[$q + 1])) {
                $q = $this->match[$q + 1] + 1;
            }
            $q = $this->skipReturnType($q);
            if ($this->kd($q) !== '{') return $q;
            return $this->inFunction($byRef, $q, function () use ($q) {
                list(, $next) = $this->parseBraces($q);
                return $next;
            });
        }

        /**
         * Parameters of the `( … )` list at $open: [['name' => 'x', 'ref' => bool, 'variadic' => bool], …].
         * @return array[]
         */
        private function parameters($open)
        {
            $params = [];
            if (!isset($this->match[$open])) return $params;
            $close = $this->match[$open];
            $ref = false;
            $variadic = false;
            for ($q = $open + 1; $q < $close; $q++) {
                $kind = $this->kd($q);
                if (isset(self::$openers[$kind]) && isset($this->match[$q])) {
                    $q = $this->match[$q];
                    continue;
                }
                if ($kind === 'T_ELLIPSIS') {
                    $variadic = true;
                    if ($this->isAmp($q - 1)) $ref = true;
                } elseif ($kind === 'T_VARIABLE') {
                    if ($this->isAmp($q - 1)) $ref = true;
                    $params[] = ['name' => substr($this->tx($q), 1), 'ref' => $ref, 'variadic' => $variadic];
                    // Skip the default value / property hooks up to the next parameter.
                    while ($q + 1 < $close && $this->kd($q + 1) !== ',') {
                        $q++;
                        if (isset(self::$openers[$this->kd($q)]) && isset($this->match[$q])) $q = $this->match[$q];
                    }
                } elseif ($kind === ',') {
                    $ref = false;
                    $variadic = false;
                }
            }
            return $params;
        }

        private function skipReturnType($q)
        {
            if ($this->kd($q) !== ':') return $q;
            $q++;
            while ($q < $this->S && !in_array($this->kd($q), ['{', ';', 'T_DOUBLE_ARROW', '}'], true)) {
                $q = $this->kd($q) === '(' && isset($this->match[$q]) ? $this->match[$q] + 1 : $q + 1;
            }
            return $q;
        }

        /** Anonymous class at T_CLASS position $p (after `new`); returns the position after its body. */
        private function parseAnonymousClass($p)
        {
            $q = $p + 1;
            if ($this->kd($q) === '(') $q = $this->skipParens($q);
            while ($q < $this->S && $this->kd($q) !== '{' && $this->kd($q) !== ';') $q++;
            if ($this->kd($q) !== '{') return $q;
            return $this->parseClassBody($q);
        }

        private function parseFunctionDecl($start, $fn)
        {
            $byRef = $this->isAmp($fn + 1);
            $q = $byRef ? $fn + 2 : $fn + 1;
            $name = strtolower($this->tx($q));
            $this->declaredFunctions[$name] = true;
            $q++;
            if ($this->kd($q) === '(' && isset($this->match[$q])) {
                $this->functionParams[$name] = $this->parameters($q);
                $q = $this->match[$q] + 1;
            }
            $q = $this->skipReturnType($q);
            if ($this->kd($q) === '{') {
                $next = $this->inFunction($byRef, $q, function () use ($q) {
                    list(, $next) = $this->parseBraces($q);
                    return $next;
                });
                return [$this->stmt('decl', $start, $next - 1), $next];
            }
            return [$this->stmt('decl', $start, $q), $q + 1];
        }

        private function parseClassDecl($start, $keyword)
        {
            $q = $keyword + 1;
            while ($q < $this->S && $this->kd($q) !== '{' && $this->kd($q) !== ';') $q++;
            if ($this->kd($q) !== '{') return [$this->stmt('decl', $start, $q), $q + 1];
            $next = $this->parseClassBody($q);
            return [$this->stmt('decl', $start, $next - 1), $next];
        }

        /** Class / interface / trait / enum body at `{` position $open; returns the position after `}`. */
        private function parseClassBody($open)
        {
            $this->classBodies[$open] = true;
            $q = $open + 1;
            while ($q < $this->S) {
                $kind = $this->kd($q);
                if ($kind === '}') {
                    $this->spans[$open] = $q;
                    $this->scopeRanges[] = [$open, $q];
                    return $q + 1;
                }
                if ($kind === 'T_FUNCTION') {
                    $q = $this->parseMethod($q);
                    continue;
                }
                if ($kind === 'T_USE') {
                    // Trait use, with an optional adaptation block `{ A::foo insteadof B; }`.
                    $q++;
                    while ($q < $this->S && !in_array($this->kd($q), [';', '{', '}'], true)) $q++;
                    if ($this->kd($q) === '{' && isset($this->match[$q])) {
                        $q = $this->match[$q] + 1;
                    } elseif ($this->kd($q) === ';') {
                        $q++;
                    }
                    continue;
                }
                if ($kind === '{' && isset($this->match[$q])) {
                    $q = $this->parseHooks($q); // PHP 8.4 property hooks
                    continue;
                }
                // Property defaults, constant expressions, attributes.
                if (isset(self::$openers[$kind]) && isset($this->match[$q])) {
                    $q = $this->match[$q] + 1;
                    continue;
                }
                $q++;
            }
            return $q;
        }

        /**
         * PHP 8.4 property hooks `{ get { … } set(T $value) => …; }` at `{` position $open: hook bodies are
         * function bodies (statements, markers, magic comments), `=> expr;` hooks are return statements.
         */
        private function parseHooks($open)
        {
            $this->hookLists[$open] = true;
            $close = $this->match[$open];
            $q = $open + 1;
            $byRef = false;
            while ($q < $close) {
                $kind = $this->kd($q);
                if ($kind === 'T_ATTRIBUTE' || $kind === '(') {
                    $q = isset($this->match[$q]) ? $this->match[$q] + 1 : $q + 1;
                    continue;
                }
                if ($this->isAmp($q)) {
                    $byRef = true;
                } elseif ($kind === '{' && isset($this->match[$q])) {
                    $body = $q;
                    $q = $this->inFunction($byRef, $body, function () use ($body) {
                        list(, $next) = $this->parseBraces($body);
                        return $next;
                    });
                    $byRef = false;
                    continue;
                } elseif ($kind === 'T_DOUBLE_ARROW') {
                    $arrow = $q;
                    $q = $this->inFunction($byRef, $arrow, function () use ($arrow) {
                        list(, $next) = $this->parseExpression('return', $arrow, $arrow + 1);
                        return $next;
                    });
                    $byRef = false;
                    continue;
                } elseif ($kind === ';') {
                    $byRef = false;
                }
                $q++;
            }
            return $close + 1;
        }

        private function parseMethod($fn)
        {
            $byRef = $this->isAmp($fn + 1);
            $q = $byRef ? $fn + 2 : $fn + 1;
            $name = null;
            if ($this->kd($q) !== '(') {
                $name = strtolower($this->tx($q)); // method name (may be a semi-reserved word)
                $q++;
            }
            if ($this->kd($q) !== '(' || !isset($this->match[$q])) return $fn + 1;
            if ($name !== null) $this->methodParams[$name][] = $this->parameters($q);
            $q = $this->match[$q] + 1;
            while ($q < $this->S && !in_array($this->kd($q), ['{', ';', '}'], true)) {
                $q = $this->kd($q) === '(' && isset($this->match[$q]) ? $this->match[$q] + 1 : $q + 1;
            }
            if ($this->kd($q) === '{') {
                return $this->inFunction($byRef, $q, function () use ($q) {
                    list(, $next) = $this->parseBraces($q);
                    return $next;
                });
            }
            return $this->kd($q) === ';' ? $q + 1 : $q;
        }

        /** Body of a control structure: a `{}` block or a single (braceless) statement. */
        private function parseBody($p)
        {
            if ($p >= $this->S) return [null, $p];
            list($id, $next) = $this->parseStatement($p);
            if ($this->st[$id]['kind'] !== 'braces') $this->st[$id]['braceless'] = true;
            $end = $this->st[$id]['end'];
            if (in_array($this->kd($end), [';', '}', 'T_CLOSE_TAG'], true)) $this->boundaries[$end] = true;
            return [$id, $next];
        }

        /** Optional terminator after alternative syntax (`endif;`) and do-while. */
        private function terminator($q, array &$extra)
        {
            $extra['needsTerm'] = true;
            if (isset(self::$terminators[$this->kd($q)])) {
                $extra['term'] = $q;
                return $q + 1;
            }
            return $q;
        }

        private function parseIf($p)
        {
            $q = $this->skipParens($p + 1);
            $extra = ['headerEnd' => $q - 1];
            if ($this->kd($q) === ':') {
                $ends = ['T_ELSEIF' => true, 'T_ELSE' => true, 'T_ENDIF' => true];
                list(, $q) = $this->parseList($q + 1, $ends, $q);
                while ($this->kd($q) === 'T_ELSEIF') {
                    $q = $this->skipParens($q + 1);
                    if ($this->kd($q) !== ':') break;
                    list(, $q) = $this->parseList($q + 1, $ends, $q);
                }
                if ($this->kd($q) === 'T_ELSE' && $this->kd($q + 1) === ':') {
                    list(, $q) = $this->parseList($q + 2, ['T_ENDIF' => true], $q + 1);
                }
                if ($this->kd($q) === 'T_ENDIF') $q = $this->terminator($q + 1, $extra);
                return [$this->stmt('control', $p, $q - 1, $extra), $q];
            }
            list(, $q) = $this->parseBody($q);
            while ($this->kd($q) === 'T_ELSEIF') {
                list(, $q) = $this->parseBody($this->skipParens($q + 1));
            }
            if ($this->kd($q) === 'T_ELSE') {
                list(, $q) = $this->parseBody($q + 1);
            }
            return [$this->stmt('control', $p, $q - 1, $extra), $q];
        }

        private function parseLoop($p)
        {
            $endKeyword = ['T_WHILE' => 'T_ENDWHILE', 'T_FOR' => 'T_ENDFOR', 'T_FOREACH' => 'T_ENDFOREACH'][$this->kd($p)];
            $q = $this->skipParens($p + 1);
            $extra = ['headerEnd' => $q - 1];
            if ($this->kd($q) === ':') {
                list(, $q) = $this->parseList($q + 1, [$endKeyword => true], $q);
                if ($this->kd($q) === $endKeyword) $q = $this->terminator($q + 1, $extra);
            } else {
                list(, $q) = $this->parseBody($q);
            }
            return [$this->stmt('control', $p, $q - 1, $extra), $q];
        }

        private function parseDo($p)
        {
            $extra = ['headerEnd' => $p];
            list(, $q) = $this->parseBody($p + 1);
            if ($this->kd($q) === 'T_WHILE') $q = $this->skipParens($q + 1);
            $q = $this->terminator($q, $extra);
            return [$this->stmt('control', $p, $q - 1, $extra), $q];
        }

        private function parseSwitch($p)
        {
            $q = $this->skipParens($p + 1);
            $extra = ['headerEnd' => $q - 1];
            $alt = $this->kd($q) === ':';
            if (!$alt && $this->kd($q) !== '{') return [$this->stmt('control', $p, $q - 1, $extra), $q];
            $this->listBraces[$q] = true;
            $close = $alt ? 'T_ENDSWITCH' : '}';
            $ends = ['T_CASE' => true, 'T_DEFAULT' => true, $close => true];
            $brace = $q;
            $q++;
            while ($q < $this->S && $this->kd($q) !== $close) {
                if ($this->kd($q) === 'T_CASE' || $this->kd($q) === 'T_DEFAULT') {
                    $colon = $this->scanCaseLabel($q + 1);
                    $q = isset(self::$terminators[$this->kd($colon)]) || $this->kd($colon) === ':' ? $colon + 1 : $colon;
                    list(, $q) = $this->parseList($q, $ends, $colon);
                    continue;
                }
                list(, $next) = $this->parseStatement($q); // invalid code before the first case
                $q = max($next, $q + 1);
            }
            if ($this->kd($q) === $close) {
                if (!$alt) $this->spans[$brace] = $q;
                $q++;
                if ($alt) $q = $this->terminator($q, $extra);
            }
            return [$this->stmt('control', $p, $q - 1, $extra), $q];
        }

        /** Position of the `:` (or `;`) ending a `case …` label, skipping ternaries and brackets. */
        private function scanCaseLabel($q)
        {
            $depth = 0;
            $ternary = 0;
            while ($q < $this->S) {
                $kind = $this->kd($q);
                if ($depth === 0) {
                    if ($kind === ';') return $q;
                    if ($kind === ':') {
                        if ($ternary === 0) return $q;
                        $ternary--;
                    } elseif ($kind === '?') {
                        $ternary++;
                    }
                }
                if (isset(self::$openers[$kind])) {
                    $depth++;
                } elseif (isset(self::$closers[$kind])) {
                    if ($depth === 0) return $q;
                    $depth--;
                } elseif ($kind === 'T_FUNCTION') {
                    $q = $this->parseClosure($q);
                    continue;
                }
                $q++;
            }
            return $q;
        }

        private function parseTry($p)
        {
            $q = $p + 1;
            if ($this->kd($q) === '{') list(, $q) = $this->parseBraces($q);
            while ($this->kd($q) === 'T_CATCH') {
                $q = $this->skipParens($q + 1);
                if ($this->kd($q) === '{') list(, $q) = $this->parseBraces($q);
            }
            if ($this->kd($q) === 'T_FINALLY' && $this->kd($q + 1) === '{') list(, $q) = $this->parseBraces($q + 1);
            return [$this->stmt('control', $p, $q - 1, ['headerEnd' => $p]), $q];
        }

        private function parseDeclare($p)
        {
            $q = $this->skipParens($p + 1);
            $extra = ['headerEnd' => $q - 1];
            if ($this->kd($q) === '{') {
                list(, $next) = $this->parseBraces($q);
                return [$this->stmt('declblock', $p, $next - 1, $extra), $next];
            }
            if ($this->kd($q) === ':') {
                list(, $q) = $this->parseList($q + 1, ['T_ENDDECLARE' => true], $q);
                if ($this->kd($q) === 'T_ENDDECLARE') $q = $this->terminator($q + 1, $extra);
                return [$this->stmt('declblock', $p, $q - 1, $extra), $q];
            }
            $q = $this->terminator($q, $extra);
            return [$this->stmt('declare', $p, $q - 1, $extra), $q];
        }

        private function parseNamespace($p)
        {
            $q = $p + 1;
            $name = '';
            while ($q < $this->S && !in_array($this->kd($q), [';', '{', 'T_CLOSE_TAG'], true)) $name .= $this->tx($q++);
            $name = trim($name, '\\');
            // A `namespace X;` statement lasts until the next namespace statement.
            if ($this->namespaces && $this->namespaces[count($this->namespaces) - 1]['to'] === null) {
                $this->namespaces[count($this->namespaces) - 1]['to'] = $p - 1;
            }
            if ($this->kd($q) === '{') {
                $index = count($this->namespaces);
                $this->namespaces[] = ['from' => $q, 'to' => isset($this->match[$q]) ? $this->match[$q] : null, 'name' => $name];
                list($list, $next) = $this->parseBraces($q);
                $this->namespaces[$index]['to'] = $next - 1;
                return [$this->stmt('nsblock', $p, $next - 1, ['inner' => $list]), $next];
            }
            $this->namespaces[] = ['from' => $q, 'to' => null, 'name' => $name];
            $extra = [];
            $q = $this->terminator($q, $extra);
            return [$this->stmt('namespace', $p, $q - 1, $extra), $q];
        }

        /** Namespace (without leading `\`) in effect at position $p ('' for the global namespace). */
        private function namespaceAt($p)
        {
            foreach ($this->namespaces as $ns) {
                if ($p > $ns['from'] && ($ns['to'] === null || $p <= $ns['to'])) return $ns['name'];
            }
            return '';
        }

        /** Remember a variable name used with `global` / `$GLOBALS['…']`. */
        private function addGlobalCandidate($name)
        {
            if ($name !== '' && !isset(self::$specialVariables[$name]) && preg_match('/^[A-Za-z_\x80-\xff][A-Za-z0-9_\x80-\xff]*$/', $name)) {
                $this->globalCandidates[$name] = true;
            }
        }

        /**
         * Names to link to the real globals: used with `global $x` (recorded by the parser) or
         * `$GLOBALS['x']` / `$GLOBALS["x"]` AND used as a variable at file scope (outside function and class
         * bodies), where the runner's eval function would otherwise make it a local.
         */
        private function collectGlobalNames()
        {
            for ($p = 0; $p + 3 < $this->S; $p++) {
                if ($this->kd($p) !== 'T_VARIABLE' || $this->tx($p) !== '$GLOBALS' || $this->kd($p + 1) !== '[') continue;
                if ($this->kd($p + 2) !== 'T_CONSTANT_ENCAPSED_STRING' || $this->kd($p + 3) !== ']') continue;
                $inner = (string) substr($this->tx($p + 2), 1, -1);
                if (strpbrk($inner, "\\\$") === false) $this->addGlobalCandidate($inner);
            }
            if (!$this->globalCandidates) return;
            for ($p = 0; $p < $this->S; $p++) {
                if ($this->kd($p) !== 'T_VARIABLE' || $this->kd($p - 1) === 'T_DOUBLE_COLON') continue;
                $name = substr($this->tx($p), 1);
                if (!isset($this->globalCandidates[$name]) || isset($this->globalNames[$name])) continue;
                $fileScope = true;
                foreach ($this->scopeRanges as $range) {
                    if ($p > $range[0] && $p <= $range[1]) {
                        $fileScope = false;
                        break;
                    }
                }
                if ($fileScope) $this->globalNames[$name] = true;
            }
        }

        /** Remember `use function A\dump;` / `use function A\{dump, dd as x};` imports (they shadow the helpers). */
        private function recordFunctionImports($p)
        {
            if ($this->kd($p + 1) !== 'T_FUNCTION') return;
            for ($q = $p + 2; $q < $this->S && !isset(self::$terminators[$this->kd($q)]); $q++) {
                $text = strtolower($this->tx($q));
                $last = substr($text, (int) strrpos('\\' . $text, '\\'));
                if (isset(self::$dumpFunctions[$last])) $this->importedFunctions[$last] = true;
            }
        }

        // ------------------------------------------------------------------------------------------------
        // Edits
        // ------------------------------------------------------------------------------------------------

        private function insertBefore($token, $text, $level, $span = 0)
        {
            $this->before[$token][] = [$level, $span, ++$this->seq, $text];
        }

        private function insertAfter($token, $text, $level, $span = 0)
        {
            $this->after[$token][] = [$level, $span, ++$this->seq, $text];
        }

        private function render()
        {
            $out = $this->prefixText;
            $count = count($this->t);
            for ($i = 1; $i < $count; $i++) { // token 0 is our own "<?php " prefix
                if (isset($this->before[$i])) {
                    $edits = $this->before[$i];
                    // Outermost first: lower level, then longer span, then insertion order.
                    usort($edits, function ($a, $b) {
                        return [$a[0], -$a[1], $a[2]] <=> [$b[0], -$b[1], $b[2]];
                    });
                    foreach ($edits as $edit) $out .= $edit[3];
                }
                $out .= isset($this->repl[$i]) ? $this->repl[$i] : $this->t[$i];
                if (isset($this->after[$i])) {
                    $edits = $this->after[$i];
                    // Innermost first: higher level, then shorter span, then reverse insertion order.
                    usort($edits, function ($a, $b) {
                        return [-$a[0], $a[1], -$a[2]] <=> [-$b[0], $b[1], -$b[2]];
                    });
                    foreach ($edits as $edit) $out .= $edit[3];
                }
            }
            return $out;
        }

        // ------------------------------------------------------------------------------------------------
        // Rule 2: prefix
        // ------------------------------------------------------------------------------------------------

        private function applyPrefix()
        {
            $ticks = $this->features['coverage'] && !$this->features['markers'];
            if (!$this->features['strict'] && !$ticks) return;

            $userStrict = false;
            $lastDeclare = null;
            foreach ($this->top as $id) {
                $s = $this->st[$id];
                if ($s['kind'] !== 'declare') break;
                for ($q = $s['start']; $q <= $s['end']; $q++) {
                    if ($this->kd($q) === 'T_STRING' && strtolower($this->tx($q)) === 'strict_types') $userStrict = true;
                }
                $lastDeclare = $s;
            }

            if ($userStrict) {
                // strict_types must stay the very first statement: our ticks declare goes after the user's.
                if ($ticks) $this->insertAfter($this->tok($lastDeclare['end']), 'declare(ticks=1);', self::LEVEL_PREFIX);
                return;
            }
            $this->prefixText = ($this->features['strict'] ? 'declare(strict_types=1);' : '') . ($ticks ? 'declare(ticks=1);' : '');
        }

        // ------------------------------------------------------------------------------------------------
        // Rule 3: echo
        // ------------------------------------------------------------------------------------------------

        private function rewriteEchos()
        {
            foreach ($this->st as $s) {
                if ($s['kind'] !== 'echo' || $s['exprStart'] === null) continue;
                $line = $this->editorLine($this->lineOf($s['start']));
                $call = '\\Tinkerbox\\Capture::echoAt(' . $line . ', ';
                $this->repl[$this->tok($s['start'])] = $call;
                // PHP prints each argument of `echo a, b;` before evaluating the next one: one call per argument,
                // joined with `.` (its left operand is evaluated first, echoAt() returns null).
                foreach ($this->topLevelCommas($s['exprStart'], $s['exprEnd']) as $comma) {
                    $this->repl[$this->tok($comma)] = ') . ' . $call;
                }
                $this->insertAfter($this->tok($s['exprEnd']), ')', self::LEVEL_ECHO, $s['exprEnd'] - $s['start']);
            }
        }

        /** @return int[] positions of the `,` separating top-level items in [$from, $to] */
        private function topLevelCommas($from, $to)
        {
            $commas = [];
            $q = $from;
            while ($q <= $to) {
                $kind = $this->kd($q);
                if ($kind === ',') $commas[] = $q;
                $q = isset(self::$openers[$kind]) && isset($this->match[$q]) ? $this->match[$q] + 1 : $q + 1;
            }
            return $commas;
        }

        // ------------------------------------------------------------------------------------------------
        // Rule 4: dump / dd / var_dump
        // ------------------------------------------------------------------------------------------------

        private function rewriteDumps()
        {
            for ($p = 0; $p < $this->S; $p++) {
                $kind = $this->kd($p);
                if ($kind !== 'T_STRING' && $kind !== 'T_NAME_FULLY_QUALIFIED') continue;
                $name = strtolower(ltrim($this->tx($p), '\\'));
                if (!isset(self::$dumpFunctions[$name])) continue;
                if (isset($this->declaredFunctions[$name]) || isset($this->importedFunctions[$name])) continue;
                $open = $p + 1;
                if ($this->kd($open) !== '(' || !isset($this->match[$open])) continue;
                $close = $this->match[$open];

                $prev = $this->kd($p - 1);
                $leadingSlash = null;
                if ($kind === 'T_STRING' && $prev === 'T_NS_SEPARATOR') {
                    // PHP 7.4: `\dump` is T_NS_SEPARATOR + T_STRING; `Foo\dump` / `namespace\dump` are qualified.
                    $before = $this->kd($p - 2);
                    if ($before === 'T_STRING' || $before === 'T_NAMESPACE') continue;
                    $leadingSlash = $p - 1;
                    $prev = $before;
                }
                if (isset(self::$memberOperators[(string) $prev])) continue;
                if (in_array($prev, ['T_FUNCTION', 'T_NEW', 'T_CONST', 'T_ATTRIBUTE', 'T_INSTANCEOF', 'T_GOTO'], true)) continue;
                if (isset(self::$ampersands[(string) $prev]) && $this->kd($p - 2) === 'T_FUNCTION') continue;
                // First-class callable syntax `dump(...)` keeps referring to the real function.
                if ($this->kd($open + 1) === 'T_ELLIPSIS' && $open + 2 === $close) continue;

                $line = $this->editorLine($this->lineOf($p));
                $named = $this->hasNamedArguments($open, $close);
                if ($leadingSlash !== null) $this->repl[$this->tok($leadingSlash)] = '';
                $this->repl[$this->tok($p)] = '\\Tinkerbox\\Capture::dumpAt';
                $this->repl[$this->tok($open)] = '(' . $line . ", '" . $name . "', " . ($named ? '\\Tinkerbox\\Capture::args(' : '[');
                $this->repl[$this->tok($close)] = $named ? '))' : '])';
            }
        }

        /** True when the call arguments between $open and $close use named arguments (`label: $value`). */
        private function hasNamedArguments($open, $close)
        {
            $q = $open + 1;
            $argStart = true;
            while ($q < $close) {
                $kind = $this->kd($q);
                if ($argStart && $this->kd($q + 1) === ':' && $this->isIdentifier($q)) return true;
                $argStart = $kind === ',';
                $q = isset(self::$openers[$kind]) && isset($this->match[$q]) ? $this->match[$q] + 1 : $q + 1;
            }
            return false;
        }

        // ------------------------------------------------------------------------------------------------
        // Rule 5: return the last expression, insert a missing trailing semicolon
        // ------------------------------------------------------------------------------------------------

        private function applyReturn()
        {
            $result = ['hasReturnValue' => false, 'returnLine' => null, 'hasTopLevelReturn' => false];
            foreach ($this->st as $s) {
                if ($s['kind'] === 'return' && $s['fileScope']) $result['hasTopLevelReturn'] = true;
            }

            $ids = $this->top;
            $last = null;
            while (true) {
                $last = null;
                for ($i = count($ids) - 1; $i >= 0; $i--) {
                    $s = $this->st[$ids[$i]];
                    // `__halt_compiler();` ends the code: the statement before it is the last one that runs.
                    if ($s['kind'] === 'empty' || $s['kind'] === 'halt') continue;
                    if ($s['kind'] === 'html' && trim($this->tx($s['start'])) === '') continue;
                    $last = $ids[$i];
                    break;
                }
                // `namespace Foo { …; $x }` — the file-scope code of the last braced namespace counts.
                if ($last !== null && $this->st[$last]['kind'] === 'nsblock' && $this->st[$last]['inner'] !== null) {
                    $ids = $this->lists[$this->st[$last]['inner']]['ids'];
                    continue;
                }
                break;
            }
            if ($last === null) return $result;

            $s = $this->st[$last];
            if ($s['kind'] === 'expr') {
                $this->insertBefore($this->tok($s['start']), 'return ', self::LEVEL_RETURN);
                $result['hasReturnValue'] = true;
                $result['returnLine'] = $this->editorLine($this->lineOf($s['start']));
            } elseif ($s['kind'] === 'return') {
                $result['hasReturnValue'] = true;
                $result['returnLine'] = $this->editorLine($this->lineOf($s['start']));
            }
            if ($s['needsTerm'] && $s['term'] === null) {
                $this->insertAfter($this->tok($s['end']), ';', self::LEVEL_SEMICOLON);
            }
            $this->lastStatement = $last;
            return $result;
        }

        // ------------------------------------------------------------------------------------------------
        // Rule 6: magic comments
        // ------------------------------------------------------------------------------------------------

        private function applyMagicComments()
        {
            // Wrappable statements by the code line they end on.
            $byLine = [];
            foreach ($this->st as $id => $s) {
                if (!isset(self::$wrappable[$s['kind']]) || $s['exprStart'] === null) continue;
                $endPos = $s['term'] !== null ? $s['term'] : $s['exprEnd'];
                $byLine[$this->lineOf($endPos)][] = $id;
            }

            foreach ($this->k as $i => $kind) {
                if ($kind !== 'T_COMMENT') continue;
                $text = rtrim($this->t[$i], "\r\n");
                if (strncmp($text, '//?', 3) === 0) {
                    $block = false;
                    $rest = (string) substr($text, 3);
                } elseif (strncmp($text, '#?', 2) === 0) {
                    $block = false;
                    $rest = (string) substr($text, 2);
                } elseif (strncmp($text, '/*?', 3) === 0 && strlen($text) >= 5 && substr($text, -2) === '*/') {
                    $block = true;
                    $rest = (string) substr($text, 3, -2);
                } else {
                    continue;
                }

                $line = $this->ln[$i];
                if (isset($this->features['skip'][$line])) continue;
                $magic = [
                    'line' => $this->editorLine($line),
                    'column' => $this->column($i),
                    'type' => 'value',
                    'tap' => null,
                    'label' => null,
                    'commentLine' => $line,
                ];
                $rest = trim(str_replace(["\r", "\n"], ' ', $rest));
                if ($block && $rest === '.') {
                    $magic['type'] = 'time';
                } elseif (strncmp($rest, '->', 2) === 0 || strncmp($rest, '?->', 3) === 0) {
                    $magic['tap'] = self::tapExpression($rest);
                    if ($magic['tap'] === null) {
                        $this->invalidMagicLines[$line] = true; // not a valid tap: skip (and report) this comment only
                        continue;
                    }
                } elseif ($rest !== '') {
                    $magic['label'] = $rest;
                }

                $prev = $this->commentPrev[$i];
                if (!$block) {
                    $id = $this->statementEndingOnLine($byLine, $line, $prev);
                    if ($id !== null) {
                        $this->wrapStatement($id, $magic);
                    } elseif ($this->features['inline'] && $prev >= 0 && $this->lineOf($prev) === $line) {
                        $this->wrapChain($prev, $magic);
                    }
                    continue;
                }
                if (!$this->features['inline']) continue;
                $this->applyBlockMagic($prev, $magic, $i);
            }
        }

        /** The wrappable statement that ends last on $line, before the comment. */
        private function statementEndingOnLine(array $byLine, $line, $prev)
        {
            if (!isset($byLine[$line])) return null;
            $best = null;
            $bestEnd = -1;
            foreach ($byLine[$line] as $id) {
                $s = $this->st[$id];
                $endPos = $s['term'] !== null ? $s['term'] : $s['exprEnd'];
                if ($endPos <= $prev && $endPos > $bestEnd) {
                    $best = $id;
                    $bestEnd = $endPos;
                }
            }
            return $best;
        }

        /** Wrappable statement whose terminator is the token at position $p. */
        private function statementTerminatedAt($p)
        {
            foreach ($this->st as $id => $s) {
                if ($s['term'] === $p && isset(self::$wrappable[$s['kind']]) && $s['exprStart'] !== null) return $id;
            }
            return null;
        }

        private function applyBlockMagic($prev, array $magic, $commentToken)
        {
            $prevKind = $this->kd($prev);
            // Only a token that really ends a statement / opens a statement list is a statement position: the
            // `:` of a ternary, `{` of a match or a class body are not (a statement there would split the code).
            $statementPosition = $prev < 0 || isset($this->boundaries[$prev]);
            if (!$statementPosition) {
                $this->wrapChain($prev, $magic);
                return;
            }

            $terminated = $prevKind === ';' ? $this->statementTerminatedAt($prev) : null;
            if ($magic['type'] === 'time') {
                // A statement after `return …;` would never run: time the returned expression instead.
                if ($terminated !== null && ($terminated === $this->lastStatement || $this->st[$terminated]['kind'] === 'return')) {
                    $this->wrapStatement($terminated, $magic);
                    return;
                }
                $this->insertBefore($commentToken, '\\Tinkerbox\\Magic::time(' . $magic['line'] . ', ' . $magic['column'] . ');', self::LEVEL_INLINE);
                $this->magicEditLines[$this->ln[$commentToken]][$magic['commentLine']] = true;
                return;
            }
            // `$x = foo(); /*?*/` — nothing to the left on the same expression: capture the statement.
            if ($terminated !== null) $this->wrapStatement($terminated, $magic);
        }

        private function wrapStatement($id, array $magic)
        {
            $s = $this->st[$id];
            $from = $s['exprStart'];
            $to = $s['exprEnd'];
            if ($s['kind'] === 'echo') $from = $this->lastArgumentStart($from, $to);
            // `return $x;` in `function &f()` returns a reference: keep it one.
            $mode = $s['kind'] === 'return' && $s['byRef'] && $this->isVariableChain($from, $to) ? 'ref' : 'value';
            $this->wrap($from, $to, $magic, $mode, self::LEVEL_MAGIC);
        }

        private function wrapChain($end, array $magic)
        {
            $start = $this->chainStart($end);
            if ($start === null) return;
            $mode = $this->operandMode($start, $end);
            if ($mode !== null) $this->wrap($start, $end, $magic, $mode, self::LEVEL_INLINE);
        }

        private function wrap($from, $to, array $magic, $mode, $level)
        {
            list($open, $close) = $this->magicCall($magic, $mode);
            $span = $to - $from;
            $this->insertBefore($this->tok($from), $open, $level, $span);
            $this->insertAfter($this->tok($to), $close, $level, $span);
            $this->magicEditLines[$this->lineOf($from)][$magic['commentLine']] = true;
            $this->magicEditLines[$this->lineOf($to)][$magic['commentLine']] = true;
        }

        /**
         * @param string $mode 'value' (`Magic::capture(L, C, (expr))`) or 'ref' (`Magic::captureRef(L, C, $var)`,
         *                     returns a reference so by-reference contexts keep working)
         * @return string[] [opening text, closing text] of the Magic call wrapping an expression
         */
        private function magicCall(array $magic, $mode = 'value')
        {
            $ref = $mode === 'ref';
            $position = $magic['line'] . ', ' . $magic['column'] . ', ';
            if ($magic['type'] === 'time') {
                return $ref ? ['\\Tinkerbox\\Magic::timeRef(' . $position, ')'] : ['\\Tinkerbox\\Magic::time(' . $position . '(', '))'];
            }
            $tail = '';
            if ($magic['tap'] !== null || $magic['label'] !== null) {
                $tail = ', ' . ($magic['tap'] !== null ? 'fn ($__twValue) => $__twValue' . $magic['tap'] : 'null');
                if ($magic['label'] !== null) $tail .= ', ' . var_export($magic['label'], true);
            }
            return $ref
                ? ['\\Tinkerbox\\Magic::captureRef(' . $position, $tail . ')']
                : ['\\Tinkerbox\\Magic::capture(' . $position . '(', ')' . $tail . ')'];
        }

        /**
         * The tap of a `//?->expr` comment without a trailing comment (`//?->count() // note`), or null when it
         * is not a valid member chain.
         */
        private static function tapExpression($rest)
        {
            $tap = '';
            foreach (@token_get_all('<?php ' . $rest) as $index => $token) {
                if ($index === 0) continue; // our open tag
                if (is_array($token) && ($token[0] === T_COMMENT || $token[0] === T_DOC_COMMENT)) break;
                $tap .= is_array($token) ? $token[1] : $token;
            }
            $tap = trim($tap);
            if ($tap === '' || !self::parses('fn ($__twValue) => $__twValue' . $tap . ';')) return null;
            return $tap;
        }

        /** Start of the last top-level comma-separated argument in [$from, $to]. */
        private function lastArgumentStart($from, $to)
        {
            $start = $from;
            $q = $from;
            while ($q <= $to) {
                $kind = $this->kd($q);
                if ($kind === ',') $start = $q + 1;
                $q = isset(self::$openers[$kind]) && isset($this->match[$q]) ? $this->match[$q] + 1 : $q + 1;
            }
            return min($start, $to);
        }

        /**
         * Start of the operand chain ending at $p (`collect($x)->map(…)`, `$a['b']->c`, `Foo::bar()`,
         * `new Foo()`, literals…), or null when $p does not end an operand.
         */
        private function chainStart($p)
        {
            while (true) {
                $atom = $this->atomStart($p);
                if ($atom === null) return null;
                $before = $this->kd($atom - 1);
                if (isset(self::$memberOperators[(string) $before])) {
                    $p = $atom - 2;
                    continue;
                }
                if ($before === 'T_NEW') return $atom - 1;
                return $atom;
            }
        }

        /** Start of the single operand ("atom" incl. calls / index access) ending at $p. */
        private function atomStart($p)
        {
            $kind = $this->kd($p);
            if ($kind === ')' || $kind === ']') {
                if (!isset($this->match[$p])) return null;
                $open = $this->match[$p];
                if ($this->kd($open) === 'T_ATTRIBUTE') return null;
                $before = (string) $this->kd($open - 1);
                if ($kind === ')') {
                    if (isset(self::$controlHeads[$before])) return null;
                    if (isset(self::$constructs[$before])) return $open - 1;
                    if ($this->endsOperand($open - 1)) return $this->atomStart($open - 1); // call: callee(…)
                    return $open; // parenthesised expression
                }
                if ($this->endsOperand($open - 1)) return $this->atomStart($open - 1); // index: $x[…]
                return $open; // array literal
            }
            if ($kind === '}') {
                if (!isset($this->match[$p])) return null;
                $open = $this->match[$p];
                $before = (string) $this->kd($open - 1);
                if (isset(self::$memberOperators[$before])) return $open; // ->{…} / ::{…}
                if ($before === '$') return $open - 1; // ${…}
                if ($before === ')' && isset($this->match[$open - 1]) && $this->kd($this->match[$open - 1] - 1) === 'T_MATCH') {
                    return $this->match[$open - 1] - 1;
                }
                return null;
            }
            if ($kind === 'T_VARIABLE') {
                return $this->kd($p - 1) === '$' ? $p - 1 : $p;
            }
            if (isset(self::$nameKinds[(string) $kind]) || isset(self::$magicConstants[(string) $kind])
                || (isset(self::$memberOperators[(string) $this->kd($p - 1)]) && $this->isIdentifier($p))
                || ($kind === 'T_CLASS' && $this->kd($p - 1) === 'T_DOUBLE_COLON')) {
                $start = $p;
                // PHP 7.4 qualified names: Foo\Bar\baz → T_STRING (T_NS_SEPARATOR T_STRING)*
                while ($this->kd($start - 1) === 'T_NS_SEPARATOR') {
                    $part = $this->kd($start - 2);
                    if ($part === 'T_STRING' || $part === 'T_NAMESPACE') {
                        $start -= 2;
                    } else {
                        $start -= 1;
                        break;
                    }
                }
                return $start;
            }
            if (isset(self::$literals[(string) $kind])) return $p;
            if ($kind === '"' || $kind === '`') {
                for ($q = $p - 1; $q >= 0; $q--) {
                    if ($this->kd($q) === $kind) return $q;
                }
                return null;
            }
            if ($kind === 'T_END_HEREDOC') {
                for ($q = $p - 1; $q >= 0; $q--) {
                    if ($this->kd($q) === 'T_START_HEREDOC') return $q;
                }
                return null;
            }
            return null;
        }

        /** True when the token at $p can end an operand that is followed by `(…)` or `[…]`. */
        private function endsOperand($p)
        {
            $kind = (string) $this->kd($p);
            if ($kind === 'T_VARIABLE' || $kind === ')' || $kind === ']' || $kind === '}' || isset(self::$literals[$kind])) return true;
            if ($kind === 'T_STATIC' || $kind === 'T_CLASS') return false;
            if (isset(self::$nameKinds[$kind])) return true;
            return isset(self::$memberOperators[(string) $this->kd($p - 1)]) && $this->isIdentifier($p);
        }

        /**
         * How the operand [$start, $end] can be wrapped in a Magic call: 'value' (`Magic::capture()`), 'ref'
         * (`Magic::captureRef()`, which returns a reference: the context takes the operand by reference) or null.
         *
         * Never wrapped: write targets and constant expressions (compile errors — fatal, not catchable — which
         * the TOKEN_PARSE safety net cannot detect), the variable of a `{$…}` interpolation (the braces would
         * become literal text) and operands that need a reference but are not variables.
         */
        private function operandMode($start, $end)
        {
            $next = (string) $this->kd($end + 1);
            // A bare name followed by `(` / `::` is a callee / class reference, not a value.
            $last = (string) $this->kd($end);
            if (($next === '(' || $next === 'T_DOUBLE_COLON') && $last !== ')' && $last !== ']' && $last !== 'T_VARIABLE') return null;
            if ($this->inDeclarationHeader($start)) return null;

            $context = $this->operandContext($start, $end);
            if ($context['never']) return null;
            $variable = $this->isVariableChain($start, $end);

            if ($next === '[') {
                // `$a/*?*/['k'] = 1`, `sort($a/*?*/['k'])`: the write goes through the wrapped operand.
                $need = $this->referenceNeed($start, $this->extendChain($end), $context);
                if ($need === 'syntax') return null;
                return ($need === 'write' || $need === 'ref') && $variable ? 'ref' : 'value';
            }
            switch ($this->referenceNeed($start, $end, $context)) {
                case 'write':
                case 'syntax':
                    return null;
                case 'ref':
                    return $variable ? 'ref' : null;
                case 'maybe':
                    // Unknown callee: a plain variable keeps working for by-value and by-reference parameters
                    // alike; property / element chains are read by value (a reference would trigger
                    // "Indirect modification" notices on __get / ArrayAccess and fail on readonly properties).
                    return $start === $end && $this->kd($start) === 'T_VARIABLE' && $this->tx($start) !== '$this' ? 'ref' : 'value';
            }
            return 'value';
        }

        /**
         * What the context needs from the (complete) operand [$start, $end]: 'write' (assignment target),
         * 'syntax' (must stay a variable: isset/unset, destructuring, foreach targets, global/static, `&`),
         * 'ref' (taken by reference), 'maybe' (argument of a callee whose signature is unknown) or 'read'.
         */
        private function referenceNeed($start, $end, array $context)
        {
            $next = (string) $this->kd($end + 1);
            $prev = (string) $this->kd($start - 1);
            if (isset(self::$writeOperators[$next]) || $prev === 'T_INC' || $prev === 'T_DEC') return 'write';
            if (isset(self::$ampersands[$prev]) || in_array($prev, ['T_GLOBAL', 'T_STATIC', 'T_AS', 'T_UNSET'], true)) return 'syntax';
            if ($context['syntax'] || ($next === 'T_DOUBLE_ARROW' && $this->insideForeachTarget($start))) return 'syntax';

            // `return $x;` in `function &f()`, the body of `fn &() => $x`.
            if ($prev === 'T_RETURN' && isset($this->returnsByExpr[$start])) {
                $s = $this->st[$this->returnsByExpr[$start]];
                if ($s['exprEnd'] === $end && $s['byRef']) return 'ref';
            }
            if ($prev === 'T_DOUBLE_ARROW' && isset($this->arrowBodies[$start]) && $this->arrowBodies[$start]['end'] === $end && $this->arrowBodies[$start]['byRef']) {
                return 'ref';
            }

            $open = $context['opener'];
            if ($open === null || $this->kd($open) !== '(' || !isset($this->match[$open])) return 'read';
            $close = $this->match[$open];
            // `foreach ($arr/*?*/ as &$v)`
            if ($this->kd($open - 1) === 'T_FOREACH') {
                if ($start - 1 !== $open || $next !== 'T_AS') return 'read';
                for ($q = $end + 2; $q < $close; $q++) {
                    if ($this->isAmp($q)) return 'ref';
                }
                return 'read';
            }
            // A complete call argument: `f($x/*?*/)`, `f($a, $x/*?*/)`, `f(name: $x/*?*/)`, `f(...$x/*?*/)`.
            if ($next !== ',' && $end + 1 !== $close) return 'read';
            $named = null;
            if ($prev === ':' && $this->isIdentifier($start - 2) && ($start - 3 === $open || $this->kd($start - 3) === ',')) {
                $named = $this->tx($start - 2);
                $argStart = $start - 2;
            } elseif ($prev === 'T_ELLIPSIS' && ($start - 2 === $open || $this->kd($start - 2) === ',')) {
                $argStart = $start - 1;
            } elseif ($start - 1 === $open || $prev === ',') {
                $argStart = $start;
            } else {
                return 'read';
            }
            $params = $this->calleeParameters($open);
            if ($params === false) return 'read'; // not a call: a parenthesised expression
            if ($params === null || $prev === 'T_ELLIPSIS') return 'maybe';
            $index = $argStart - 1 === $open ? 0 : count($this->topLevelCommas($open + 1, $argStart - 1));
            $param = null;
            foreach ($params as $i => $candidate) {
                if ($named !== null ? strcasecmp($candidate['name'], $named) === 0 : $i === $index) $param = $candidate;
            }
            if ($param === null && $params) {
                $lastParam = $params[count($params) - 1];
                if ($lastParam['variadic']) $param = $lastParam;
            }
            return $param !== null && $param['ref'] ? 'ref' : 'read';
        }

        /**
         * Parameters of the callee of the `(` at $open (see parameters()): false when the parentheses are not a
         * call, null when the callee is unknown (methods, closures, constructors, functions not defined yet).
         * @return array[]|false|null
         */
        private function calleeParameters($open)
        {
            $before = (string) $this->kd($open - 1);
            if (isset(self::$nameKinds[$before]) || $this->isNamedMember($open - 1)) {
                $nameStart = $this->atomStart($open - 1);
                if ($nameStart === null) return null;
                $prev = (string) $this->kd($nameStart - 1);
                if (isset(self::$memberOperators[$prev])) {
                    // A method declared in the editor code with a by-reference parameter of that name.
                    $method = strtolower($this->tx($open - 1));
                    if (isset($this->methodParams[$method])) {
                        foreach ($this->methodParams[$method] as $params) {
                            foreach ($params as $param) {
                                if ($param['ref']) return $params;
                            }
                        }
                    }
                    return null;
                }
                if ($prev === 'T_NEW' || $before === 'T_STATIC') return null;
                $name = '';
                for ($q = $nameStart; $q < $open; $q++) $name .= $this->tx($q);
                return $this->functionParameters($name, $open);
            }
            if ($before === 'T_CLASS' && $this->kd($open - 2) === 'T_NEW') return null; // new class(…)
            if ($this->endsOperand($open - 1)) return null; // $fn(…), $obj->{…}(…), f()(…)
            return false;
        }

        /** True for an identifier after `->` / `::` (method names may be semi-reserved words). */
        private function isNamedMember($p)
        {
            return isset(self::$memberOperators[(string) $this->kd($p - 1)]) && $this->isIdentifier($p);
        }

        /**
         * Parameters of the function a call by name resolves to: a function declared in the editor code, or one
         * that already exists (internal or loaded by the project, via reflection). null when unknown.
         * @return array[]|null
         */
        private function functionParameters($name, $p)
        {
            $lower = strtolower($name);
            $relative = strncmp($lower, 'namespace\\', 10) === 0; // namespace\foo()
            if ($relative) $lower = substr($lower, 10);
            $fullyQualified = $lower !== '' && $lower[0] === '\\';
            $lower = ltrim($lower, '\\');
            $short = (string) substr($lower, (int) strrpos('\\' . $lower, '\\'));
            if (isset($this->functionParams[$short]) && !$fullyQualified) return $this->functionParams[$short];

            $namespace = strtolower($this->namespaceAt($p));
            $candidates = [];
            if ($fullyQualified) {
                $candidates[] = $lower;
            } elseif ($relative) {
                $candidates[] = $namespace === '' ? $lower : $namespace . '\\' . $lower;
            } else {
                if ($namespace !== '') $candidates[] = $namespace . '\\' . $lower;
                if (strpos($lower, '\\') === false) $candidates[] = $lower;
            }
            foreach ($candidates as $candidate) {
                if (!function_exists($candidate)) continue;
                try {
                    $params = [];
                    foreach ((new \ReflectionFunction($candidate))->getParameters() as $param) {
                        $params[] = ['name' => $param->getName(), 'ref' => $param->isPassedByReference(), 'variadic' => $param->isVariadic()];
                    }
                    return $params;
                } catch (\Throwable $e) {
                    return null;
                }
            }
            // The runner's helpers are defined after the transform; they take every argument by value.
            if (isset(self::$byValueHelpers[$short]) && !isset($this->declaredFunctions[$short])) return [];
            return null;
        }

        /**
         * Walk back from the operand at $start: is it inside a constant expression or a `{$…}` interpolation
         * ('never'), a position that must stay a variable ('syntax'), and which bracket directly contains it
         * ('opener')?
         * @return array{never: bool, syntax: bool, opener: ?int}
         */
        private function operandContext($start, $end)
        {
            $context = ['never' => false, 'syntax' => false, 'opener' => null];
            $never = ['never' => true, 'syntax' => false, 'opener' => null];
            $depth = 0;
            // Passed a call, an index or a parenthesised group: no longer the variable / value itself.
            $crossed = false;
            $staticInitializer = false;

            for ($q = $start - 1; $q >= 0; $q--) {
                $kind = (string) $this->kd($q);
                if (isset(self::$closers[$kind])) {
                    if ($depth === 0 && $kind === '}' && isset($this->boundaries[$q])) break; // previous statement
                    $depth++;
                    continue;
                }
                if (isset(self::$openers[$kind])) {
                    if ($depth > 0) {
                        $depth--;
                        continue;
                    }
                    if ($context['opener'] === null) $context['opener'] = $q;
                    $before = (string) $this->kd($q - 1);
                    if ($kind === 'T_CURLY_OPEN' || $kind === 'T_DOLLAR_OPEN_CURLY_BRACES') {
                        if (!$crossed) return $never; // "{$a/*?*/}" would no longer interpolate
                        continue;
                    }
                    if ($kind === 'T_ATTRIBUTE') return $never;
                    if ($kind === '{') {
                        if (isset($this->classBodies[$q])) return $never; // property / constant / case values
                        if (isset($this->listBraces[$q]) || isset($this->hookLists[$q])) return $this->staticInitializer($context, $staticInitializer);
                        $crossed = true; // match body, ->{…}, ${…}
                        continue;
                    }
                    if ($kind === '[') {
                        if ($this->isIndexBracket($q)) {
                            $crossed = true; // index
                        } elseif (!$crossed && isset($this->match[$q]) && $this->kd($this->match[$q] + 1) === '=') {
                            $context['syntax'] = true; // [$a, $b] = … destructuring
                        }
                        continue;
                    }
                    // `(`
                    if ($before === 'T_DECLARE' || $this->isParameterList($q)) return $never; // declare(ticks=1), defaults
                    if ($before === 'T_USE' || $before === 'T_CATCH') {
                        $context['syntax'] = true;
                        return $context;
                    }
                    if ($before === 'T_ISSET' || $before === 'T_UNSET' || $before === 'T_EMPTY' || $before === 'T_LIST') {
                        if (!$crossed && ($before !== 'T_LIST' || (isset($this->match[$q]) && $this->kd($this->match[$q] + 1) === '='))) {
                            $context['syntax'] = true;
                        }
                        if ($before !== 'T_LIST') $crossed = true;
                        continue;
                    }
                    if ($before === 'T_ARRAY') continue; // array( … ) literal
                    if (isset(self::$controlHeads[$before]) && $before !== 'T_MATCH') return $context; // if ( / foreach ( …
                    $crossed = true; // call arguments / parenthesised expression
                    continue;
                }
                if ($depth > 0) continue;
                // The previous statement ended: the operand's statement is in a statement list (class bodies
                // hold no statements, their members' `;` are not boundaries).
                if (isset($this->boundaries[$q])) break;
                if ($kind === 'T_CONST') return $never;
                if ($kind === 'T_GLOBAL') {
                    $context['syntax'] = true;
                    return $context;
                }
                if ($kind === 'T_AS' && !$crossed) $context['syntax'] = true; // foreach target
                if ($kind === 'T_STATIC' && $this->kd($q + 1) === 'T_VARIABLE') {
                    // `static $a = 1, $b;`: the declared variables themselves must stay variables.
                    if ($context['opener'] === null && $start === $end && $this->kd($start) === 'T_VARIABLE' && in_array($this->kd($start - 1), [',', 'T_STATIC'], true)) {
                        $context['syntax'] = true;
                        return $context;
                    }
                    $staticInitializer = true;
                }
            }

            return $this->staticInitializer($context, $staticInitializer);
        }

        /** Static variable initializers are constant expressions before PHP 8.3. */
        private function staticInitializer(array $context, $staticInitializer)
        {
            if ($staticInitializer && PHP_VERSION_ID < 80300) return ['never' => true, 'syntax' => false, 'opener' => null];
            return $context;
        }

        /**
         * Names in declaration headers are no operands: `function foo(…)`, `class A extends B implements C, D`,
         * `$x instanceof Foo`, `namespace`, `use`, `goto`, `const` names.
         */
        private function inDeclarationHeader($start)
        {
            $prev = (string) $this->kd($start - 1);
            if (in_array($prev, ['T_FUNCTION', 'T_FN', 'T_CLASS', 'T_INTERFACE', 'T_TRAIT', 'T_ENUM', 'T_INSTANCEOF', 'T_NAMESPACE', 'T_USE', 'T_GOTO', 'T_CONST', 'T_NEW'], true)) return true;
            if ($this->isAmp($start - 1) && in_array($this->kd($start - 2), ['T_FUNCTION', 'T_FN'], true)) return true;
            // `extends A, B` / `implements A, B` / `insteadof A, B` name lists.
            $q = $start - 1;
            while ($q >= 0 && ($this->kd($q) === ',' || $this->kd($q) === 'T_NS_SEPARATOR' || isset(self::$nameKinds[(string) $this->kd($q)]))) $q--;
            if (in_array($this->kd($q), ['T_EXTENDS', 'T_IMPLEMENTS', 'T_INSTEADOF'], true)) return true;
            // Return and backing types: `function f(): ?string`, `function () use ($x): int|false`, `enum E: string`.
            $q = $start - 1;
            while ($q >= 0 && (isset(self::$nameKinds[(string) $this->kd($q)]) || $this->isAmp($q) || in_array($this->kd($q), ['T_NS_SEPARATOR', 'T_ARRAY', 'T_CALLABLE', '?', '|'], true))) $q--;
            if ($this->kd($q) !== ':') return false;
            $before = $q - 1;
            if ($this->kd($before) === ')' && isset($this->match[$before])) {
                $open = $this->match[$before];
                return $this->isParameterList($open) || $this->kd($open - 1) === 'T_USE';
            }
            return $this->kd($before - 1) === 'T_ENUM' || ($this->kd($before - 1) === 'T_STRING' && strtolower($this->tx($before - 1)) === 'enum');
        }

        /**
         * True when the `[` at $q indexes the operand before it (`$a[…]`), false for an array literal / a
         * destructuring target, also right after a block (`}`) or a control-structure header (`if (…) [$a] = …`).
         */
        private function isIndexBracket($q)
        {
            $p = $q - 1;
            if (!$this->endsOperand($p)) return false;
            $kind = $this->kd($p);
            if ($kind === '}' && isset($this->boundaries[$p])) return false;
            if ($kind === ')' && isset($this->match[$p]) && isset(self::$controlHeads[(string) $this->kd($this->match[$p] - 1)])) return false;
            return true;
        }

        /** True when the `(` at $q opens the parameter list of a function, method, closure or arrow function. */
        private function isParameterList($q)
        {
            $b = $q - 1;
            if ($this->isAmp($b)) $b--;
            $kind = $this->kd($b);
            if ($kind === 'T_FUNCTION' || $kind === 'T_FN') return true;
            $c = $b - 1;
            if ($this->isAmp($c)) $c--;
            return $this->kd($c) === 'T_FUNCTION' && $this->isIdentifier($b);
        }

        /** True when [$start, $end] is a variable (`$x`, `$$x`, `Foo::$x`, with `[…]` / `->prop` / `::$prop` segments). */
        private function isVariableChain($start, $end)
        {
            $p = $start;
            $kind = $this->kd($p);
            if ($kind === 'T_VARIABLE') {
                $p++;
            } elseif ($kind === '$') {
                if ($this->kd($p + 1) === 'T_VARIABLE') {
                    $p += 2;
                } elseif ($this->kd($p + 1) === '{' && isset($this->match[$p + 1])) {
                    $p = $this->match[$p + 1] + 1;
                } else {
                    return false;
                }
            } else {
                while ($p <= $end && (isset(self::$nameKinds[(string) $this->kd($p)]) || in_array($this->kd($p), ['T_NS_SEPARATOR', 'T_NAMESPACE'], true))) $p++;
                if ($p === $start || $this->kd($p) !== 'T_DOUBLE_COLON' || $this->kd($p + 1) !== 'T_VARIABLE') return false;
                $p += 2;
            }
            while ($p <= $end) {
                $kind = $this->kd($p);
                if ($kind === '[' && isset($this->match[$p])) {
                    $p = $this->match[$p] + 1;
                } elseif ($kind === 'T_OBJECT_OPERATOR' && $this->kd($p + 1) === '{' && isset($this->match[$p + 1])) {
                    $p = $this->match[$p + 1] + 1;
                } elseif ($kind === 'T_OBJECT_OPERATOR' && ($this->kd($p + 1) === 'T_VARIABLE' || $this->isIdentifier($p + 1)) && $this->kd($p + 2) !== '(') {
                    $p += 2;
                } elseif ($kind === 'T_DOUBLE_COLON' && $this->kd($p + 1) === 'T_VARIABLE') {
                    $p += 2;
                } else {
                    return false; // calls, nullsafe chains (never by reference), constants …
                }
            }
            return $p === $end + 1;
        }

        /** End of the chain continuing after $end (`[…]`, `->x`, `?->x`, `::$x`, `::m(…)`, calls). */
        private function extendChain($end)
        {
            $p = $end + 1;
            while ($p < $this->S) {
                $kind = $this->kd($p);
                if (($kind === '[' || $kind === '(') && isset($this->match[$p])) {
                    $p = $this->match[$p] + 1;
                } elseif (isset(self::$memberOperators[$kind]) && $this->kd($p + 1) === '{' && isset($this->match[$p + 1])) {
                    $p = $this->match[$p + 1] + 1;
                } elseif (isset(self::$memberOperators[$kind]) && ($this->kd($p + 1) === 'T_VARIABLE' || $this->isIdentifier($p + 1))) {
                    $p += 2;
                } else {
                    break;
                }
            }
            return $p - 1;
        }

        private function insideForeachTarget($start)
        {
            for ($q = $start - 1; $q >= 0; $q--) {
                $kind = $this->kd($q);
                if ($kind === 'T_AS') return true;
                if ($kind === ';' || $kind === '{' || $kind === '}') return false;
                if ($kind === '(' && $this->kd($q - 1) === 'T_FOREACH') return false;
            }
            return false;
        }

        // ------------------------------------------------------------------------------------------------
        // Rule 7: coverage markers
        // ------------------------------------------------------------------------------------------------

        private function applyMarkers()
        {
            $lines = 0;
            foreach ($this->lists as $list) {
                foreach ($list['ids'] as $id) {
                    $s = $this->st[$id];
                    if (isset(self::$unmarked[$s['kind']]) || $s['kind'] === 'braces' || $s['braceless']) continue;
                    if (!$this->addMarker($id, $lines)) return;
                }
            }
            foreach ($this->st as $id => $s) {
                if (!$s['braceless'] || isset(self::$unmarked[$s['kind']])) continue;
                if (!$this->addMarker($id, $lines, true)) return;
            }
        }

        private function addMarker($id, &$lines, $braceless = false)
        {
            $s = $this->st[$id];
            $line = $this->editorLine($this->lineOf($s['start']));
            if (!isset($this->coverageMap[$line])) {
                if ($lines >= self::MAX_COVERAGE_LINES) return false;
                $lines++;
                $this->coverageMap[$line] = [];
            }
            $last = $s['headerEnd'] !== null ? $s['headerEnd'] : $s['end'];
            list($own, $children) = $this->ownLines($s['start'], $last);
            foreach ($own as $covered => $unused) $this->coverageMap[$line][$covered] = true;
            if (!$this->addSpanMarkers($children, $own, $lines)) return false;

            $marker = '\\Tinkerbox\\Capture::cover(' . $line . ');';
            $first = $this->tok($s['start']);
            if (!$braceless) {
                $this->insertBefore($first, $marker, self::LEVEL_MARKER);
                return true;
            }
            // `if ($x) foo();` → `if ($x) {cover(N);foo();}` — braces keep the single-statement body intact.
            $this->insertBefore($first, '{' . $marker, self::LEVEL_BRACE);
            $last = $this->tok($s['end']);
            if ($this->kd($s['end']) === 'T_CLOSE_TAG') {
                $this->insertBefore($last, ';}', self::LEVEL_BRACE);
            } else {
                $this->insertAfter($last, '}', self::LEVEL_BRACE);
            }
            return true;
        }

        /**
         * Expression markers for the spans directly inside a statement / span: a span whose lines are not all
         * covered by its parent gets `\Tinkerbox\Capture::cover(-K) ?? ` in front (cover() returns null and `??`
         * binds tighter than everything that can follow, so the value is unchanged), with its own lines.
         * @param int[]             $children span start positions
         * @param array<int, bool>  $parent   editor lines the parent covers
         */
        private function addSpanMarkers(array $children, array $parent, &$lines)
        {
            foreach ($children as $from) {
                $span = $this->exprSpanAt[$from];
                list($own, $grandChildren) = $this->ownLines($from, $span['to'], true);
                if (array_diff_key($own, $parent)) {
                    if ($lines >= self::MAX_COVERAGE_LINES) return false;
                    $lines++;
                    $key = -(++$this->nextSpanKey);
                    $this->coverageMap[$key] = $own;
                    $this->insertAfter($this->tok($span['after']), '\\Tinkerbox\\Capture::cover(' . $key . ') ?? ', self::LEVEL_MARKER);
                    $inner = $own;
                } else {
                    $inner = $parent + $own; // nothing of its own: it runs with its parent
                }
                if (!$this->addSpanMarkers($grandChildren, $inner, $lines)) return false;
            }
            return true;
        }

        /**
         * Keep the expression spans that can carry a marker (not in constant expressions, not starting with a
         * construct `??` cannot precede) and index them by start position.
         */
        private function finalizeSpans()
        {
            foreach ($this->exprSpans as $span) {
                $from = $span['from'];
                if (in_array($this->kd($span['after'] + 1), ['T_YIELD', 'T_YIELD_FROM', 'T_INLINE_HTML', 'T_CLOSE_TAG'], true)) continue;
                if ($this->operandContext($from, $span['to'])['never']) continue;
                if (!isset($this->exprSpanAt[$from]) || $this->exprSpanAt[$from]['to'] < $span['to']) $this->exprSpanAt[$from] = $span;
            }
            $this->exprSpans = [];
        }

        /**
         * Editor lines a statement (tokens $first … $last; for control structures only the header) or an
         * expression span covers when it runs: every line holding one of its tokens except a terminating `;`,
         * the interior of nested closure / class bodies (their own statements carry their own markers) and of
         * nested expression spans (returned as children, they may get their own markers).
         * @return array{0: array<int, bool>, 1: int[]} [editor lines, start positions of the child spans]
         */
        private function ownLines($first, $last, $isSpan = false)
        {
            $lines = [];
            $children = [];
            $p = $first;
            while ($p <= $last && $p < $this->S) {
                if (isset($this->exprSpanAt[$p]) && ($p !== $first || !$isSpan)) {
                    $children[] = $p;
                    $p = max($p, $this->exprSpanAt[$p]['to']) + 1;
                    continue;
                }
                $token = $this->tok($p);
                $kind = $this->k[$token];
                if (!(($kind === ';' || $kind === 'T_CLOSE_TAG') && $p === $last && $p !== $first)) {
                    $from = $this->ln[$token];
                    $to = $from + substr_count(rtrim($this->t[$token], "\r\n"), "\n");
                    for ($l = $from; $l <= $to; $l++) $lines[$this->editorLine($l)] = true;
                }
                if (isset($this->spans[$p]) && $p !== $first) {
                    $close = $this->spans[$p];
                    $lines[$this->editorLine($this->lineOf($close))] = true;
                    $p = $close + 1;
                    continue;
                }
                $p++;
            }
            return [$lines, $children];
        }
    }
}
