<?php

namespace Fixture\Symfony;

/**
 * Fake service container with a "doctrine" registry whose connections call the configured SQLLogger like DBAL 3.
 */
class Container
{
    private $services = [];

    public function __construct($kernel)
    {
        $this->services['kernel'] = $kernel;
        $this->services['doctrine'] = new DoctrineRegistry();
    }

    public function has($id)
    {
        return isset($this->services[$id]);
    }

    public function get($id)
    {
        if (!isset($this->services[$id])) {
            throw new \RuntimeException('Service "' . $id . '" not found.');
        }

        return $this->services[$id];
    }
}

class DoctrineRegistry
{
    private $connections;

    public function __construct()
    {
        $this->connections = ['default' => new Connection()];
    }

    public function getConnections()
    {
        return $this->connections;
    }

    public function getConnection($name = 'default')
    {
        return $this->connections[$name];
    }
}

class Configuration
{
    private $logger;

    public function setSQLLogger($logger)
    {
        $this->logger = $logger;
    }

    public function getSQLLogger()
    {
        return $this->logger;
    }
}

class Connection
{
    private $configuration;

    public function __construct()
    {
        $this->configuration = new Configuration();
    }

    public function getConfiguration()
    {
        return $this->configuration;
    }

    public function executeQuery($sql, array $params = [])
    {
        $logger = $this->configuration->getSQLLogger();
        if ($logger !== null) {
            $logger->startQuery($sql, $params, []);
        }
        usleep(1000);
        if ($logger !== null) {
            $logger->stopQuery();
        }

        return [];
    }
}
