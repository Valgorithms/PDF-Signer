<?php

declare(strict_types=1);

// Loads PdfSigner classes from src/ for the command-line script when Composer has not been run.

spl_autoload_register(static function (string $class): void {
    if (str_starts_with($class, 'PdfSigner\\')) {
        $file = __DIR__.'/../src/'.str_replace('\\', '/', substr($class, 10)).'.php';

        if (is_file($file)) {
            require $file;
        }
    }
});
