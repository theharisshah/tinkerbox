<?php

namespace Doctrine\DBAL\Logging;

/**
 * Doctrine DBAL 3 SQLLogger interface (same signatures as the real one).
 */
interface SQLLogger
{
    /**
     * @param string $sql
     * @param array|null $params
     * @param array|null $types
     * @return void
     */
    public function startQuery($sql, ?array $params = null, ?array $types = null);

    /**
     * @return void
     */
    public function stopQuery();
}
