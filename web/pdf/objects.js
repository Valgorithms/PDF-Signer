// PDF values, as in src/Pdf: names, references, strings, dictionaries and streams.
// Strings of bytes are "binary strings": one character per byte, codes 0–255.

/** A name, such as /Type, held without its slash and with #xx escapes decoded. */
export class Name {
  constructor(value) {
    this.value = value;
  }
}

/** A reference to an indirect object: 12 0 R. */
export class Reference {
  constructor(number, generation = 0) {
    this.number = number;
    this.generation = generation;
  }
}

/** A string's bytes, and whether it was written as <…> so it can be written back the same way. */
export class PdfString {
  constructor(bytes, hex = false) {
    this.bytes = bytes;
    this.hex = hex;
  }
}

/** A dictionary, keyed by names without their slash, in the order they were read or set. */
export class Dictionary {
  constructor(entries = {}) {
    this.entries = new Map(Object.entries(entries));
  }

  get(key) {
    return this.entries.get(key) ?? null;
  }

  has(key) {
    return this.entries.has(key);
  }

  set(key, value) {
    this.entries.set(key, value);
    return this;
  }

  /** Whether a key holds a name with the given value, such as /Type /Page. */
  isName(key, name) {
    const value = this.get(key);
    return value instanceof Name && value.value === name;
  }

  /** A new dictionary with the same entries. */
  copy() {
    const copy = new Dictionary();
    for (const [key, value] of this.entries) {
      copy.set(key, value);
    }
    return copy;
  }
}

/** A stream: its dictionary, and its data as a binary string, still encoded with its /Filter. */
export class Stream {
  constructor(dictionary, data) {
    this.dictionary = dictionary;
    this.data = data;
  }
}

/** A PDF that could not be read, or cannot be changed safely. */
export class PdfError extends Error {}

/** An encrypted PDF, which is refused rather than damaged. */
export class EncryptedPdfError extends PdfError {
  constructor() {
    super('This PDF is encrypted, so signatures cannot be added to it. Remove its password or restrictions first.');
  }
}
