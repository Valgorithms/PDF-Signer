<?php

declare(strict_types=1);

namespace PdfSigner\Pdf;

/**
 * A PDF dictionary: keys are names, held without their slash, in the order they were read or set.
 *
 * It is an object rather than a PHP array so that an empty dictionary and an empty array stay different.
 *
 * @implements \IteratorAggregate<string, mixed>
 */
final class Dictionary implements \Countable, \IteratorAggregate
{
    /**
     * @param array<string, mixed> $entries The entries, keyed by name without the slash.
     */
    public function __construct(private array $entries = [])
    {
    }

    /**
     * The value under a key, or null when there is none, which PDF treats the same as a null value.
     *
     * @param string $key The key, without the slash.
     */
    public function get(string $key): mixed
    {
        return $this->entries[$key] ?? null;
    }

    /**
     * Whether the dictionary has a key.
     *
     * @param string $key The key, without the slash.
     */
    public function has(string $key): bool
    {
        return array_key_exists($key, $this->entries);
    }

    /**
     * Sets a key, replacing any value it had.
     *
     * @param string $key   The key, without the slash.
     * @param mixed  $value The new value.
     */
    public function set(string $key, mixed $value): self
    {
        $this->entries[$key] = $value;

        return $this;
    }

    /**
     * Removes a key, if it is there.
     *
     * @param string $key The key, without the slash.
     */
    public function remove(string $key): self
    {
        unset($this->entries[$key]);

        return $this;
    }

    /**
     * The entries, keyed by name without the slash.
     *
     * @return array<string, mixed>
     */
    public function all(): array
    {
        return $this->entries;
    }

    /**
     * Whether a key holds a name with the given value, such as `/Type /Page`.
     *
     * @param string $key  The key, without the slash.
     * @param string $name The name, without the slash.
     */
    public function isName(string $key, string $name): bool
    {
        $value = $this->get($key);

        return $value instanceof Name && $value->value === $name;
    }

    /**
     * @inheritDoc
     */
    public function count(): int
    {
        return count($this->entries);
    }

    /**
     * @inheritDoc
     */
    public function getIterator(): \ArrayIterator
    {
        return new \ArrayIterator($this->entries);
    }
}
