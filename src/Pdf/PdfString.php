<?php

declare(strict_types=1);

namespace PdfSigner\Pdf;

/**
 * A PDF string: its decoded bytes, and whether it was written in hex so it can be written back the same way.
 */
final class PdfString
{
    /**
     * @param string $bytes The string's bytes, with escapes decoded.
     * @param bool   $hex   Whether it was written as `<…>` rather than `(…)`.
     */
    public function __construct(
        public readonly string $bytes,
        public readonly bool $hex = false,
    ) {
    }
}
