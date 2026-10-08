<?php
/**
 * Classes reflected by tests/php/data/IntrospectorTest.php (PHP 7.4-compatible syntax). Unique P4Intro\ namespace
 * because every module's tests share the harness process.
 */

namespace P4Intro {
    interface P4IShape
    {
        const DIMENSIONS = 2;

        public function area();
    }

    trait P4ILabels
    {
        /** @var string[] */
        public $labels = [];

        public function label($text)
        {
            $this->labels[] = $text;

            return $this;
        }
    }

    abstract class P4IBase
    {
        private $basePrivate = 1;

        protected function baseProtected()
        {
        }

        private function basePrivateMethod()
        {
        }
    }

    /**
     * A square.
     *
     * @method static string shout(string $text, int $times = 1) Shout a text.
     * @method int perimeter()
     * @property-read int $diagonal Length of the diagonal.
     * @property string|null $color
     * @mixin \P4Intro\P4IHelper
     */
    class P4ISquare extends P4IBase implements P4IShape
    {
        use P4ILabels;

        const SIDES = 4;

        /** Not visible from outside. */
        private const SECRET = 'x';

        /** @var int instances created */
        public static $count = 0;

        /** @var int */
        public $side = 2;

        protected ?string $name = null;

        private $hidden;

        public function __construct(int $side = 2)
        {
            $this->side = $side;
        }

        /**
         * Area of the square.
         *
         * More details that are not part of the summary.
         */
        public function area(): int
        {
            return $this->side ** 2;
        }

        public static function make(int $side = 2, string ...$labels): self
        {
            return new self($side);
        }

        /** @deprecated use area() */
        public function surface(?array $options = null, $flags = \PHP_INT_MAX, $mode = self::SIDES)
        {
            return $this->area();
        }

        private function secret()
        {
        }

        public function __toString()
        {
            return 'square';
        }
    }

    class P4IHelper
    {
        public function help(array $items = ['a' => 1, 'b' => [true, null]], $text = "it's")
        {
        }

        public static function assist()
        {
        }
    }

    final class P4IMacroable
    {
        /** @var array */
        protected static $macros = [];

        public static function macro($name, $macro)
        {
            static::$macros[$name] = $macro;
        }

        public static function upper($value)
        {
            return strtoupper($value);
        }
    }
}

namespace {
    /**
     * Introspector test function.
     *
     * @param string|null $name
     */
    function p4_intro_function(int $id, $name = null, array $options = [], &...$rest): ?array
    {
        return null;
    }
}
