<?php

namespace Tinkerbox {
    /** Minimal DumpNode encoder for the fixture runner. */
    final class Node
    {
        public static function of($value)
        {
            if ($value === null) return ['t' => 'null'];
            if (is_bool($value)) return ['t' => 'bool', 'v' => $value];
            if (is_int($value)) return ['t' => 'int', 'v' => (string) $value];
            if (is_float($value)) return ['t' => 'float', 'v' => (string) $value];
            if (is_string($value)) return ['t' => 'string', 'v' => $value, 'len' => strlen($value)];
            if (is_array($value)) {
                $items = [];
                foreach ($value as $k => $v) $items[] = ['k' => $k, 'v' => self::of($v)];
                return ['t' => 'array', 'count' => count($value), 'items' => $items];
            }
            return ['t' => 'object', 'class' => get_class($value), 'id' => spl_object_id($value), 'props' => []];
        }
    }
}
