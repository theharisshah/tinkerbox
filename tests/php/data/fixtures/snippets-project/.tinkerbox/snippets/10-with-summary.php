<?php
/**
 * Lists the queue size per connection.
 *
 * Second paragraph is not part of the summary.
 */
// comment stays
foreach (['redis', 'sqs'] as $connection) {
    echo Queue::connection($connection)->size(), PHP_EOL;
}
