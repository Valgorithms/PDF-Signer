// The typed-signature styles: every bundled font must be shipped with the page, with its licence.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { STYLES, SUBSETS } from '../../web/signatures.js';

const bundled = Object.entries(STYLES).filter(([, style]) => style.bundled);

test('the signature fonts come first, so the dialog opens on one', () => {
  assert.ok(bundled.length >= 3);
  assert.deepEqual(Object.keys(STYLES).slice(0, bundled.length), bundled.map(([key]) => key));
});

test('each bundled style draws with its own font first', () => {
  for (const [key, { font, bundled: { family } }] of bundled) {
    assert.ok(font.startsWith(`"${family}",`), `${key} leads with ${family}`);
  }
  assert.equal(new Set(bundled.map(([, style]) => style.bundled.family)).size, bundled.length);
});

test('every bundled font is shipped in each subset, as WOFF2, with its licence', () => {
  for (const [key, { bundled: { folder } }] of bundled) {
    const base = new URL(`../../web/fonts/${folder}/`, import.meta.url);
    for (const subset of Object.keys(SUBSETS)) {
      const file = readFileSync(new URL(`${subset}.woff2`, base));
      assert.equal(file.subarray(0, 4).toString('latin1'), 'wOF2', `${key}: ${subset}.woff2`);
    }
    assert.match(readFileSync(new URL('OFL.txt', base), 'utf8'), /SIL Open Font License, Version 1\.1/, `${key}: OFL.txt`);
  }
});
