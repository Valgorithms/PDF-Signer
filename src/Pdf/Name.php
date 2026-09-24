<?php

declare(strict_types=1);

namespace PdfSigner\Pdf;

/**
 * A PDF name, such as `/Type`, held without its slash and with `#xx` escapes decoded.
 */
final class Name
{
    /**
     * @param string $value The name's bytes, without the leading slash.
     */
    public function __construct(public readonly string $value)
    {
    }
}
