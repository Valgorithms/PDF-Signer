<?php

declare(strict_types=1);

namespace PdfSigner\Pdf;

/**
 * A PDF that is encrypted. New content added to it would have to be encrypted with the document's key,
 * which is not supported, so the document is refused rather than damaged.
 */
final class EncryptedPdfException extends PdfException
{
    /**
     * The exception for an encrypted document.
     */
    public static function create(): self
    {
        return new self('This PDF is encrypted, so signatures cannot be added to it. Remove its password or restrictions first.');
    }
}
