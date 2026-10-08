<?php

namespace Acme\Shop;

/**
 * Tinkerbox fixture: the application object the custom driver exposes as `$shop`.
 */
class Shop
{
    /** @var array */
    private $config;

    /** @var Database */
    private $db;

    public function __construct(array $config)
    {
        $this->config = $config;
        $this->db = new Database();
    }

    public function name()
    {
        return $this->config['name'];
    }

    public function version()
    {
        return $this->config['version'];
    }

    public function db()
    {
        return $this->db;
    }

    public function orders()
    {
        return $this->db->select('select * from orders where status = ?', ['open']);
    }
}
