<?php

declare(strict_types=1);

namespace PdfSigner\Pdf;

/**
 * A page of a document, with the attributes it inherits from the page tree already applied.
 */
final class Page
{
    /**
     * @param ?Reference           $reference  The page object, or null for a page the file stores directly in its parent, which cannot be revised.
     * @param Dictionary           $dictionary The page dictionary.
     * @param mixed                $resources  Its resources, which may be inherited, still unresolved.
     * @param array{float, float, float, float} $mediaBox The media box, normalised to lower-left and upper-right.
     * @param ?array{float, float, float, float} $cropBox The crop box, normalised, if one is set.
     * @param int                  $rotation   Clockwise rotation when displayed: 0, 90, 180 or 270.
     */
    public function __construct(
        public readonly ?Reference $reference,
        public readonly Dictionary $dictionary,
        public readonly mixed $resources,
        public readonly array $mediaBox,
        public readonly ?array $cropBox,
        public readonly int $rotation,
    ) {
    }

    /**
     * The area that is displayed: the crop box where it overlaps the media box, as PDF viewers show it.
     *
     * @return array{float, float, float, float} Lower-left x and y, upper-right x and y.
     */
    public function viewBox(): array
    {
        if (null === $this->cropBox) {
            return $this->mediaBox;
        }

        $box = [
            max($this->cropBox[0], $this->mediaBox[0]),
            max($this->cropBox[1], $this->mediaBox[1]),
            min($this->cropBox[2], $this->mediaBox[2]),
            min($this->cropBox[3], $this->mediaBox[3]),
        ];

        return $box[0] < $box[2] && $box[1] < $box[3] ? $box : $this->mediaBox;
    }
}
