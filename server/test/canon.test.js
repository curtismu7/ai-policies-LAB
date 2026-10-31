// The canonical form of a call and the hash an approval is bound to. Each test pins one rule that stops one approval covering a call it was not given for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, callHash, canonicalJson, normalizeArguments } from '../src/canon.js';

const h = (text, target = 'tool:payments/change_payee', method = 'tools/call') => {
  const n = normalizeArguments({ text });
  assert.ok(n.ok, `${text}: ${n.code}`);
  return callHash({ method, target, arguments: n.value }).hash;
};
const refused = (text) => { const n = normalizeArguments({ text }); assert.equal(n.ok, false, text.slice(0, 60)); return n.code; };

test('key order and whitespace do not change the hash; array order does', () => {
  assert.equal(h('{"a":1,"b":[1,2]}'), h('{ "b": [1, 2],\n "a": 1 }'));
  assert.notEqual(h('{"b":[1,2]}'), h('{"b":[2,1]}'));
});
test('numbers: 100, 100.0, 1e2, 1E+2 and 100.00 agree; minus zero is zero; "100" the string differs', () => {
  const base = h('{"n":100}');
  for (const f of ['100.0', '1e2', '1E+2', '100.00', '1.0e2']) assert.equal(h(`{"n":${f}}`), base, f);
  assert.equal(h('{"n":-0}'), h('{"n":0}'));
  assert.notEqual(h('{"n":"100"}'), base);
  assert.notEqual(h('{"n":100.5}'), base);
});
test('numbers a double cannot hold exactly are refused (two different amounts must not share a hash)', () => {
  assert.equal(refused('{"n":10000000000000001}'), 'number_not_exact');
  assert.equal(refused('{"n":9007199254740993}'), 'number_not_exact');
  assert.equal(refused('{"n":0.1000000000000000055511151231257827}'), 'number_not_exact');
  assert.equal(refused('{"n":1e999}'), 'number_not_exact');
  assert.ok(normalizeArguments({ text: '{"n":9007199254740991}' }).ok);
  assert.equal(refused('{"n":01}'), 'arguments_not_json');
  assert.equal(refused('{"n":NaN}'), 'arguments_not_json');
  assert.equal(normalizeArguments({ object: { n: Infinity } }).ok, false);
  assert.equal(normalizeArguments({ object: { n: 2 ** 60 } }).code, 'number_not_exact');
});
test('unicode: canonically equivalent spellings agree (NFC); compatibility look-alikes and zero-width characters do NOT', () => {
  assert.equal(h('{"k":"caf\\u00e9"}'), h('{"k":"cafe\\u0301"}'));
  assert.equal(h('{"caf\\u00e9":1}'), h('{"cafe\\u0301":1}'));
  assert.notEqual(h('{"k":"100"}'), h('{"k":"\\uff11\\uff10\\uff10"}'), 'fullwidth digits are a different string (NFKC is not used)');
  assert.notEqual(h('{"k":"ab"}'), h('{"k":"a\\u200bb"}'), 'a zero-width character is a different string');
  assert.equal(h('{"k":"A"}'), h('{"k":"\\u0041"}'), 'an escape and the letter agree');
  assert.equal(h('{"k":"a/b"}'), h('{"k":"a\\/b"}'));
});
test('duplicate keys are refused, including two keys that are equal after NFC', () => {
  assert.equal(refused('{"a":1,"a":2}'), 'duplicate_key');
  assert.equal(refused('{"caf\\u00e9":1,"cafe\\u0301":2}'), 'duplicate_key');
  assert.equal(refused('{"o":{"a":1,"a":1}}'), 'duplicate_key');
  assert.equal(normalizeArguments({ object: { 'café': 1, 'café': 2 } }).code, 'duplicate_key');
});
test('__proto__, constructor and prototype keys are refused at every level, as text and as an object', () => {
  for (const k of ['__proto__', 'constructor', 'prototype']) {
    assert.equal(refused(`{"${k}":1}`), 'forbidden_key');
    assert.equal(refused(`{"a":{"b":[{"${k}":1}]}}`), 'forbidden_key');
    assert.equal(normalizeArguments({ object: JSON.parse(`{"a":{"${k}":1}}`) }).code, 'forbidden_key');
  }
  const n = normalizeArguments({ text: '{"a":1}' });
  assert.equal(Object.getPrototypeOf(n.value), null, 'objects have no prototype');
  assert.equal({}.polluted, undefined);
});
test('the method and the target are part of the hash', () => {
  const a = '{"r":"x"}';
  assert.notEqual(h(a), h(a, 'tool:payments/close_account'));
  assert.notEqual(h(a), h(a, 'tool:payments/change_payee', 'message/send'));
  assert.match(h(a), /^[0-9a-f]{64}$/);
});
test('the canonical text is sorted, compact JSON', () => {
  const n = normalizeArguments({ text: '{ "b": [true, null, "x"], "a": 1.50 }' });
  assert.equal(canonicalJson(n.value), '{"a":1.5,"b":[true,null,"x"]}');
  assert.equal(callHash({ method: 'tools/call', target: 't', arguments: n.value }).canonical, '{"arguments":{"a":1.5,"b":[true,null,"x"]},"method":"tools/call","target":"t"}');
});
test('malformed and hostile text is refused, never guessed', () => {
  for (const t of ['', '[]', '1', 'null', '{"a":1} x', '{"a":1,}', '{a:1}', "{'a':1}", '{"a":"\u0001"}', '{"a":"\\x"}', '{"a":"\\ud800"}', '{"a":1', '{"a" 1}', '{"a":tru}']) assert.equal(normalizeArguments({ text: t }).ok, false, JSON.stringify(t));
  assert.equal(normalizeArguments({ text: 5 }).ok, false);
  assert.equal(normalizeArguments({ object: [1] }).ok, false);
  assert.equal(normalizeArguments({ object: 'x' }).ok, false);
  assert.equal(normalizeArguments({}).ok, false);
  assert.equal(normalizeArguments({ object: { a: undefined } }).ok, false);
  assert.equal(normalizeArguments({ object: { a: 'x\ud800' } }).code, 'lone_surrogate');
});
test('huge and deep arguments are refused, not truncated', () => {
  assert.equal(refused(`{"a":"${'x'.repeat(LIMITS.text)}"}`), 'arguments_too_large');
  assert.equal(refused(`{"a":"${'x'.repeat(LIMITS.string + 5)}"}`.slice(0, LIMITS.text)), 'arguments_too_large');
  assert.equal(refused('['.repeat(2000)), 'arguments_too_deep');
  assert.equal(refused(`{"a":${'['.repeat(LIMITS.depth + 2)}${']'.repeat(LIMITS.depth + 2)}}`), 'arguments_too_deep');
  assert.ok(normalizeArguments({ text: `{"a":${'['.repeat(LIMITS.depth - 1)}${']'.repeat(LIMITS.depth - 1)}}` }).ok);
  const manyKeys = `{${Array.from({ length: LIMITS.keys + 1 }, (_, i) => `"k${i}":1`).join(',')}}`;
  assert.equal(refused(manyKeys), 'arguments_too_large');
  assert.equal(refused(`{"a":[${Array.from({ length: LIMITS.items + 1 }, () => '1').join(',')}]}`), 'arguments_too_large');
  let deep = {}; for (let i = 0; i < 20000; i++) deep = { d: deep };
  assert.equal(normalizeArguments({ object: deep }).code, 'arguments_too_deep');
  const t0 = Date.now(); normalizeArguments({ text: `{"a":"${'\\u0041'.repeat(600)}"}` }); assert.ok(Date.now() - t0 < 1000);
});
test('the canonical hash does not depend on where the arguments came from (text or object)', () => {
  const a = normalizeArguments({ text: '{"b":2,"a":"x"}' }).value; const b = normalizeArguments({ object: { a: 'x', b: 2 } }).value;
  assert.equal(canonicalJson(a), canonicalJson(b));
});
