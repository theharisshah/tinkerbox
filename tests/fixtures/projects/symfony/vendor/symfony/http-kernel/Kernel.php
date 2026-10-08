<?php

namespace Symfony\Component\HttpKernel;

/**
 * Minimal fake of Symfony's Kernel.
 */
abstract class Kernel
{
    const VERSION = '7.1.0';

    protected $environment;
    protected $debug;
    protected $booted = false;
    protected $container;

    public function __construct(string $environment, bool $debug)
    {
        $this->environment = $environment;
        $this->debug = $debug;
    }

    public function boot()
    {
        if (!$this->booted) {
            $this->container = new \Fixture\Symfony\Container($this);
            $this->booted = true;
        }
    }

    public function getContainer()
    {
        return $this->container;
    }

    public function getEnvironment()
    {
        return $this->environment;
    }

    public function isDebug()
    {
        return $this->debug;
    }

    public function getProjectDir()
    {
        return dirname(__DIR__, 3);
    }

    public function getCacheDir()
    {
        return $this->getProjectDir() . '/var/cache/' . $this->environment;
    }

    public function getLogDir()
    {
        return $this->getProjectDir() . '/var/log';
    }

    public function getBundles()
    {
        return ['FrameworkBundle' => null];
    }
}
