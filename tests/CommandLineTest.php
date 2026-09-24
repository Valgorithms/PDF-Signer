<?php

declare(strict_types=1);

namespace PdfSigner\Tests;

use PdfSigner\Pdf\Document;
use PdfSigner\Tests\Fixtures\PdfBuilder;
use PHPUnit\Framework\TestCase;

final class CommandLineTest extends TestCase
{
    private string $directory;

    protected function setUp(): void
    {
        $this->directory = sys_get_temp_dir().'/pdf-signer-'.bin2hex(random_bytes(4));
        mkdir($this->directory);
        file_put_contents("{$this->directory}/lease.pdf", PdfBuilder::twoPages()->classic());

        $image = imagecreatetruecolor(20, 10);
        ob_start();
        imagepng($image);
        file_put_contents("{$this->directory}/signature.png", ob_get_clean());
    }

    protected function tearDown(): void
    {
        array_map('unlink', glob("{$this->directory}/*"));
        rmdir($this->directory);
    }

    public function testASignedCopyIsWrittenBesideTheDocument(): void
    {
        [$code, $out] = $this->runScript('lease.pdf', 'signature.png', '--at=1:72:600:150', '--at=2:10:10:100');

        $this->assertSame(0, $code, $out);
        $this->assertSame("{$this->directory}/lease-signed.pdf", trim($out));
        $this->assertCount(2, Document::open("{$this->directory}/lease-signed.pdf")->pages());
    }

    public function testWithoutAPlacementItShowsHowToUseIt(): void
    {
        [$code, $out] = $this->runScript('lease.pdf', 'signature.png');

        $this->assertSame(1, $code);
        $this->assertStringContainsString('Usage:', $out);
    }

    public function testAMissingPageIsReported(): void
    {
        [$code, $out] = $this->runScript('lease.pdf', 'signature.png', '--at=9:0:0:10');

        $this->assertSame(1, $code);
        $this->assertStringContainsString('There is no page 9', $out);
    }

    /**
     * Runs the script from the temporary directory, with its output and errors together.
     *
     * @return array{0: int, 1: string}
     */
    private function runScript(string ...$arguments): array
    {
        $arguments = array_map(fn (string $a) => str_starts_with($a, '--') ? $a : "{$this->directory}/{$a}", $arguments);
        $command = escapeshellarg(PHP_BINARY).' '.escapeshellarg(dirname(__DIR__).'/bin/sign-pdf').' '.implode(' ', array_map('escapeshellarg', $arguments)).' 2>&1';
        exec($command, $lines, $code);

        return [$code, implode("\n", $lines)];
    }
}
