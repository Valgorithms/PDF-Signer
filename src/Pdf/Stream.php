<?php

declare(strict_types=1);

namespace PdfSigner\Pdf;

/**
 * A PDF stream: its dictionary and its data, still encoded with whatever `/Filter` the dictionary names.
 */
final class Stream
{
    /**
     * @param Dictionary $dictionary The stream's dictionary. `/Length` is set from the data when it is written.
     * @param string     $data       The stream's bytes as stored in the file.
     */
    public function __construct(
        public readonly Dictionary $dictionary,
        public readonly string $data,
    ) {
    }
}
