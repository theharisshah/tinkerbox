<?php

namespace Symfony\Component\Dotenv;

/**
 * Minimal fake of symfony/dotenv (5.1+ API): bootEnv() fills $_SERVER / $_ENV like the real component.
 */
final class Dotenv
{
    private $envKey;
    private $debugKey;

    public function __construct(string $envKey = 'APP_ENV', string $debugKey = 'APP_DEBUG')
    {
        $this->envKey = $envKey;
        $this->debugKey = $debugKey;
    }

    public function bootEnv(string $path, string $defaultEnv = 'dev', array $testEnvs = ['test'], bool $overrideExistingVars = false): void
    {
        foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
            $line = trim($line);
            if ($line === '' || $line[0] === '#' || strpos($line, '=') === false) {
                continue;
            }
            list($key, $value) = explode('=', $line, 2);
            $value = trim($value, "\"'");
            if ($overrideExistingVars || !isset($_SERVER[$key])) {
                $_SERVER[$key] = $_ENV[$key] = $value;
            }
        }
        $env = isset($_SERVER[$this->envKey]) ? $_SERVER[$this->envKey] : $defaultEnv;
        $_SERVER[$this->envKey] = $_ENV[$this->envKey] = $env;
        if (!isset($_SERVER[$this->debugKey])) {
            $_SERVER[$this->debugKey] = $_ENV[$this->debugKey] = $env !== 'prod' ? '1' : '0';
        }
    }
}
