// The shared masker's corpora (copied from shared-masker 1.4.0, test/corpus/: leaks.json, ordinary.json, options.json; commit 9bc664a) run through the lab's ADAPTER (mask.js and
// credentials.js), not through the vendored module: a leak must not survive, an ordinary string must come out unchanged. Probes are stored as fragments of at most 4 characters
// (gitleaks) and joined here at run time. options.json is run through the vendored createMasker as written, which proves the copy behaves like the canonical module.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMasker } from '../src/shared/mask.js';
import { cleanFree, looksLikeCredential, maskText } from '../src/credentials.js';
import { maskDeep } from '../src/mask.js';

const load = (name) => JSON.parse(readFileSync(new URL(`./corpus/${name}.json`, import.meta.url), 'utf8'));
const leaks = load('leaks'); const ordinary = load('ordinary'); const options = load('options');
const join = (a) => a.join('');
const expand = (row) => `${row.fillBefore ? `${'a'.repeat(row.fillBefore)} ` : ''}${join(row.input)}${row.fillAfter ? ` ${'a'.repeat(row.fillAfter)}` : ''}`;
const isDeep = (row) => row.api === 'deep';
// what cleanFree does to a string that holds no secret: control and bidi-control characters become one space each, white space collapses and is trimmed
const tidy = (s) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();

test('corpus sizes: the copy is whole (3754 leak probes of which 338 structured, 1926 ordinary strings of which 109 structured, 35 option rows)', () => {
  assert.equal(leaks.length, 3754); assert.equal(leaks.filter(isDeep).length, 338);
  assert.equal(ordinary.length, 1926); assert.equal(ordinary.filter(isDeep).length, 109);
  assert.equal(options.length, 35);
  for (const row of [...leaks, ...ordinary]) for (const f of [...row.input, ...(row.secret || [])]) assert.ok(Array.from(f).length <= 4, row.id);
});

test('leaks.json through the adapter: the secret never survives maskText, cleanFree or maskDeep (value and key position), and looksLikeCredential says so', () => {
  const failures = [];
  for (const row of leaks) {
    if (isDeep(row)) continue;
    const input = expand(row); const secret = join(row.secret);
    if (maskText(input).includes(secret)) failures.push(`${row.id} ${row.family}/${row.enc} maskText`);
    if (cleanFree(input, 100000).includes(secret)) failures.push(`${row.id} ${row.family}/${row.enc} cleanFree`);
    if (!looksLikeCredential(input)) failures.push(`${row.id} ${row.family}/${row.enc} looksLikeCredential`);
    if (input.length <= 5000) {
      if (JSON.stringify(maskDeep({ note: input, list: [input] })).includes(secret)) failures.push(`${row.id} ${row.family}/${row.enc} maskDeep value`);
      if (JSON.stringify(maskDeep({ [input]: 1 })).includes(secret)) failures.push(`${row.id} ${row.family}/${row.enc} maskDeep key`);
    }
  }
  assert.deepEqual(failures, [], `${failures.length} failed:\n${failures.slice(0, 30).join('\n')}`);
});

test('leaks.json structured probes through maskDeep: the secret is gone and the input is not mutated', () => {
  const deep = leaks.filter(isDeep);
  const failures = [];
  for (const row of deep) {
    const value = JSON.parse(join(row.input)); const snapshot = JSON.stringify(value);
    const out = maskDeep(value);
    if (JSON.stringify(value) !== snapshot) failures.push(`${row.id} mutated`);
    if (JSON.stringify(out).includes(join(row.secret))) failures.push(`${row.id} ${row.family}/${row.enc}`);
  }
  assert.deepEqual(failures, [], failures.slice(0, 30).join('\n'));
});

test('ordinary.json through the adapter: every string stays as it was (cleanFree only tidies white space), every structure is unchanged', () => {
  const changed = [];
  for (const row of ordinary) {
    const input = join(row.input);
    if (isDeep(row)) { const value = JSON.parse(input); if (JSON.stringify(maskDeep(value)) !== JSON.stringify(value)) changed.push(`${row.id} maskDeep ${input}`); continue; }
    if (maskText(input) !== input) changed.push(`${row.id} maskText ${JSON.stringify(input)} -> ${JSON.stringify(maskText(input))}`);
    if (cleanFree(input, 100000) !== tidy(input)) changed.push(`${row.id} cleanFree ${JSON.stringify(input)}`);
    if (looksLikeCredential(input)) changed.push(`${row.id} looksLikeCredential ${JSON.stringify(input)}`);
    if (maskDeep({ x: input }).x !== input) changed.push(`${row.id} maskDeep ${JSON.stringify(input)}`);
  }
  assert.deepEqual(changed, [], `${changed.length} of ${ordinary.length} changed:\n${changed.slice(0, 30).join('\n')}`);
});

const toOptions = (spec) => {
  const o = {};
  if (spec.opaqueKeys) o.opaqueKeys = new Set(spec.opaqueKeys);
  if (spec.opaqueKeysRegex) o.opaqueKeys = new RegExp(spec.opaqueKeysRegex[0], spec.opaqueKeysRegex[1]);
  if (spec.opaquePaths) o.opaque = (key, p) => spec.opaquePaths.includes(p);
  for (const k of ['keyMode', 'markStyle', 'tooLongText', 'maxLength']) if (spec[k] !== undefined) o[k] = spec[k];
  if (spec.pathRules) o.pathRules = spec.pathRules.map((r) => ({ match: new RegExp(r.match[0], r.match[1]), ...(r.keyMode ? { keyMode: r.keyMode } : {}), ...(r.opaque === undefined ? {} : { opaque: Array.isArray(r.opaque) ? new Set(r.opaque) : r.opaque }) }));
  return o;
};
test('options.json through the vendored createMasker: every row gives exactly the written output (the copy is the canonical module)', () => {
  const failures = [];
  for (const r of options) {
    const m = createMasker(toOptions(r.options));
    const input = join(r.input); const expected = join(r.expected);
    const got = r.api === 'text' ? m.maskText(input) : JSON.stringify(m.maskDeep(JSON.parse(input)));
    if (got !== expected) failures.push(`${r.id} ${r.option}: ${r.name}`);
  }
  assert.deepEqual(failures, []);
});
