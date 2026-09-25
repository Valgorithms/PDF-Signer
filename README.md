# PDF-Signer

Adds your signature on top of the pages of an existing PDF: drawn, typed, or a picture of it.

The signed copy is the original PDF with an **incremental update** appended. The original bytes are left exactly as they were, and the signatures are added after them. Forms, links, bookmarks and anything else the PDF held survive untouched, including an earlier digital signature, which stays valid for the revision it signed.

This places a visible signature. It is not a cryptographic digital signature.

It comes in two forms that produce the same file:

- **In the browser**, as a page published with GitHub Pages. The PDF is read and signed on your own computer and never uploaded.
- **In PHP**, as a command-line script and a library, with no Composer dependencies beyond PHP's `gd` and `zlib` extensions.

## In the browser

1. Open the site, and choose or drop a PDF.
2. Make a signature. You can **Draw** it with a mouse, pen or finger, with an eraser and tools for lines, rectangles and ellipses (hold Shift to keep a line to steps of 45°, or a shape square or round), **Type** it in one of three signature fonts (or a handwriting font your device has, or plain text for dates and initials), or **Upload** a picture of it, with the white paper made transparent.
3. Choose the signature, then click where it goes on a page. Drag it to move it, drag its corner to resize it, and use × to remove it. With the keyboard, the arrow keys move it, `+` and `-` resize it, and Delete removes it.
4. Click **Download signed PDF**.

Signatures are kept in the page until it is closed. Tick **Remember my signatures in this browser** to keep them, stored in this browser only.

A PDF that is encrypted or password-protected is refused, since adding to it would damage it. For a PDF that is already digitally signed, you're told that viewers will report it changed after it was signed.

The page is plain HTML and JavaScript modules in [`web/`](web), with no build step. Pages are displayed with [pdf.js](https://mozilla.github.io/pdf.js/), loaded from cdnjs and checked against pinned SHA-384 hashes before it runs; the signing itself is this repository's own code.

The signature fonts are served with the page from [`web/fonts/`](web/fonts), so they look the same on every device and typing a signature fetches nothing from anywhere else. They are free fonts under the SIL Open Font License 1.1, whose text sits beside each one: *Mr Dafoe* and *Herr Von Muellerhoff* by Alejandro Paul (Sudtipos), and *Great Vibes* by the Great Vibes Pro Project Authors. They were taken from the [Fontsource](https://fontsource.org) packages, version 5.3.0. The two Sudtipos fonts have Western European letters but not Central European ones such as ą, č, ő or ż. A name that needs one is drawn wholly in Great Vibes instead, and the dialog says so, since a signature that changes font partway through looks wrong.

The [Publish site](.github/workflows/pages.yml) workflow publishes the site to the `gh-pages` branch whenever `web/` or `src/` changes on `main`, and on each release. The signer is the site's root page; the PHP class reference is under `/reference/`. To serve it, set **Settings → Pages → Source** to *Deploy from a branch*, with `gh-pages` and `/ (root)`.

To try it locally, serve the folder, since browsers only load modules over HTTP:

```bash
php -S 127.0.0.1:8080 -t web
```

## PHP requirements

- PHP 8.1 or later.
- The `gd` and `zlib` extensions. On Windows, `gd` may need `extension=gd` enabled in `php.ini`; `php -m` lists what is loaded.

## Command line

```bash
php bin/sign-pdf lease.pdf signature.png --at=3:72:640:160
```

This writes `lease-signed.pdf` beside the document and prints its path. Each `--at=PAGE:X:Y:WIDTH` places the signature once. X and Y are its top-left corner, in points from the top-left of the page as displayed, after any rotation or crop. WIDTH is its width in points; its height keeps the image's proportions. Repeat `--at` to sign several places.

- `--remove-white` makes a photographed signature's white paper transparent and trims it to the ink.
- `--output=signed.pdf` chooses where the copy goes.

The script exits with `1` and a message on standard error when something goes wrong, such as a missing page or an encrypted PDF.

## Library

```php
use PdfSigner\SignatureImage;
use PdfSigner\Signer;

$signature = SignatureImage::fromFile('signature.jpg')->withoutWhiteBackground()->trimmed();

Signer::open('lease.pdf')
    ->stamp($signature, page: 3, x: 72, y: 640, width: 160)
    ->stamp($signature, page: 5, x: 72, y: 700, width: 160)
    ->save('lease-signed.pdf');
```

- `Signer::pageCount()` and `pageSize($page)` give each page's displayed size in points.
- `hasDigitalSignatures()` says whether the PDF was already digitally signed.
- `stampWithMatrix()` takes a transformation matrix in the page's own coordinates, for callers that work those out themselves.
- `open()` and `fromString()` throw a `PdfSigner\Pdf\EncryptedPdfException` for an encrypted PDF, and a `PdfException` for one that can't be read.

## How it works

- `PdfSigner\Pdf\Document` reads just enough of a PDF to revise it. It follows the chain of cross-reference sections, both classic tables and the compressed streams modern writers use, and reads objects packed into object streams. It walks the page tree with the attributes pages inherit. Where an offset is wrong, it finds objects by scanning the file, as PDF viewers do.
- Each signed page gets a new revision. Its own content is wrapped in `q … Q`, so a transformation it leaves behind can't move the signature. The signature is drawn after it, and the page's resources name the signature image.
- `PdfSigner\Pdf\IncrementalUpdate` appends the new objects with a cross-reference section of the same kind the file already uses, whose `/Prev` points back to the previous one.
- `web/` holds the same code in JavaScript, and the two produce the same PDF, object for object. Only the compressed image bytes can differ, since browsers and PHP ship different builds of zlib.

## Tests

```bash
composer install
composer test
```

The browser version's tests use Node's built-in test runner and need Node 22 or later:

```bash
composer test-web
```

## Coding standards and documentation

The PHP code is formatted with php-cs-fixer, using [`.php-cs-fixer.dist.php`](.php-cs-fixer.dist.php); the Coding Standards workflow fails a push that isn't formatted.

```bash
composer cs
```

The class reference is built with [phpDocumentor](https://phpdoc.org) from [`phpdoc.dist.xml`](phpdoc.dist.xml) into `build/reference/`. To build it locally, install phpDocumentor (for example with `phive install phpDocumentor`) and run it from the repository root:

```bash
tools/phpDocumentor --config phpdoc.dist.xml
```
