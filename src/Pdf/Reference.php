<?php

declare(strict_types=1);

namespace PdfSigner\Pdf;

/**
 * A reference to an indirect object, written `12 0 R`.
 */
final class Reference
{
    /**
     * @param int $number     The object number.
     * @param int $generation The generation number, almost always 0.
     */
    public function __construct(
        public readonly int $number,
        public readonly int $generation = 0,
    ) {
    }
}
