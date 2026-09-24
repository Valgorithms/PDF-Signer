// Moving between bytes and binary strings, and zlib compression, with the browser's own streams.

/** A binary string with one character per byte. */
export function toBinary(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return out;
}

/** The bytes of a binary string. */
export function toBytes(binary) {
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i) & 0xff;
  }
  return out;
}

/** Compresses to zlib format, which is what /FlateDecode reads. */
export async function deflate(bytes) {
  return pipe(bytes, new CompressionStream('deflate'));
}

/**
 * Inflates zlib data, falling back to a raw deflate stream as some writers produce. Bytes after the end of
 * the compressed data, which some writers leave, are ignored.
 */
export async function inflate(binary) {
  const bytes = toBytes(binary);
  for (const format of ['deflate', 'deflate-raw']) {
    const out = await pipe(bytes, new DecompressionStream(format), true);
    if (out !== null) {
      return out;
    }
  }
  return null;
}

/**
 * Runs bytes through a transform stream and returns the output as a binary string.
 * When `lenient`, an error after some output keeps that output, and an error before any gives null.
 */
async function pipe(bytes, transform, lenient = false) {
  const reader = new Blob([bytes]).stream().pipeThrough(transform).getReader();
  let out = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return out;
      }
      out += toBinary(value);
    }
  } catch (error) {
    if (!lenient) {
      throw error;
    }
    return out === '' ? null : out;
  }
}
