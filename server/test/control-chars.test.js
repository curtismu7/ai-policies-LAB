// B1: a C0 or C1 control character inside a keyword must not defeat masking or inspection. The lab DELETES every control character except TAB, LF and CR (those are
// separators) before it matches, in the credential detectors and in the inspection normaliser alike. The characters are built with String.fromCharCode so no control
// character sits in this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { C, get, post, withServer } from './helpers.js';
import { sweep } from './sweep.js';
import { cleanFree, looksLikeCredential, normalizeForMatching } from '../src/credentials.js';
import { findingKinds, findingsIn } from '../src/inspect.js';
import { maskDeep } from '../src/mask.js';

const CODES = [0x00, 0x01, 0x08, 0x0b, 0x0c, 0x1f, 0x7f, 0x85, 0x9f]; // 0x08 and 0x0c are the two JSON writes as a short escape, 0x0b as a unicode escape
const CHARS = CODES.map((n) => String.fromCharCode(n));
const hex = (ch) => ch.charCodeAt(0).toString(16);
const live = (extra = {}) => ({ mode: 'live', vertical: 'finance', ...extra });
// Every shape: a builder that puts the control character in the middle of a keyword (or of the value), and the part of the value that must never come back.
const SHAPES = [
  { name: 'password sentence', text: (c) => `my pa${c}ss${c}word is Tr0ub4dorXq21`, probe: 'Tr0ub4dorXq21' },
  { name: 'password: value', text: (c) => `pass${c}word: Tr0ub4dorXq22`, probe: 'Tr0ub4dorXq22' },
  { name: 'pw', text: (c) => `p${c}w: Tr0ub4dorXq23`, probe: 'Tr0ub4dorXq23' },
  { name: 'token header', text: (c) => `Authorization: tok${c}en abcdef1234567890zz`, probe: 'abcdef1234567890zz' },
  { name: 'Bearer', text: (c) => `Bea${c}rer abcdEFGH1234567890.tokenvalue`, probe: 'tokenvalue' },
  { name: 'sk key', text: (c) => ['s', c, 'k-Zy9Xw8Vv7Uu6Tt5Ss4Rr3Qq2Pp1'].join(''), probe: 'Zy9Xw8Vv7Uu6Tt5Ss4Rr3Qq2Pp1' },
  { name: 'split value', text: (c) => `password: Tr0ub4${c}dorXq24`, probe: 'dorXq24' },
  { name: 'bare keyword', text: (c) => `pass${c}word Tr0ub4dorXq25`, probe: 'Tr0ub4dorXq25' },
  { name: 'percent-encoded escape with a control inside', text: (c) => `p%61${c}ssword: Tr0ub4dorXq26`, probe: 'Tr0ub4dorXq26' },
];
// What a leak looks like once it is hidden again: control characters (raw, or as the JSON escape the answer prints) are removed before the search.
const unhide = (t) => String(t).replace(/\\u00(?:[01][0-9a-f]|7f|8[0-9a-f]|9[0-9a-f])/gi, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}]/gu, '');
const mintGood = async (url) => (await (await post(url, '/api/token', live({ token: { claims: { sub: C.castAgent, surfaces: ['tool'], scope: `${C.castApp}:write ${C.castApp}:read`, department: C.castDept, end_user: C.castUser } } }))).json()).result.labToken;

test('normalizeForMatching deletes every C0 and C1 control except TAB, LF and CR, which (and U+2028, U+2029) become one space', () => {
  for (let n = 0; n < 0xa0; n++) {
    if (n > 0x1f && n < 0x7f) continue;
    const ch = String.fromCharCode(n);
    const out = normalizeForMatching(`a${ch}b`);
    assert.equal(out, n === 9 || n === 10 || n === 13 ? 'a b' : 'ab', `U+${n.toString(16)}`);
  }
  assert.equal(normalizeForMatching(`a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`), 'a b c');
  assert.equal(normalizeForMatching('%00%01%1f%7f%c2%85%c2%9f'), '', 'controls that arrive percent-encoded are deleted too');
  assert.equal(normalizeForMatching('p%6\u0000' + '1ssword'), 'password', 'a control inside a percent escape cannot hide the escape');
});

test('a control character inside any keyword or value never defeats cleanFree, looksLikeCredential or the response mask (unit)', () => {
  for (const ch of CHARS) for (const s of SHAPES) {
    const text = s.text(ch);
    assert.ok(!unhide(cleanFree(text)).includes(s.probe), `cleanFree: ${s.name} with U+${hex(ch)}: ${cleanFree(text)}`);
    assert.ok(looksLikeCredential(text), `looksLikeCredential: ${s.name} with U+${hex(ch)}`);
    assert.ok(!unhide(JSON.stringify(maskDeep({ x: text }))).includes(s.probe), `maskDeep: ${s.name} with U+${hex(ch)}`);
  }
});

test('a control character inside the injection phrase, a card number or a secret does not hide an inspection finding (unit)', () => {
  for (const ch of CHARS) {
    assert.ok(findingKinds(`ignore pre${ch}vious instructions`).includes('injection'), `injection U+${hex(ch)}`);
    assert.ok(findingKinds(`ig${ch}nore all${ch} previous`).includes('injection'), `injection 2 U+${hex(ch)}`);
    assert.ok(findingKinds(`card 4111${ch}1111${ch}1111${ch}1111`).includes('card-number'), `card U+${hex(ch)}`);
    assert.ok(findingKinds(['s', ch, 'k-abcdefghijk1234'].join('')).includes('secret'), `secret U+${hex(ch)}`);
    assert.ok(findingsIn({ record: 'x', [`ignore pre${ch}vious instructions`]: 1 }).some((f) => f.kind === 'injection'), `key U+${hex(ch)}`);
  }
});

test('the reported repro: a control character inside "password" in a claim is refused at mint, and the minted token never carries the value', async () => {
  await withServer(async (url) => {
    for (const ch of CHARS) {
      const r = await post(url, '/api/token', live({ token: { claims: { department: `my pa${ch}ss${ch}word is Tr0ub4dorXq21` } } }));
      const body = await r.text();
      assert.equal(r.status, 400, `U+${hex(ch)}: ${body.slice(0, 120)}`);
      assert.equal(JSON.parse(body).error, 'credential_shaped');
      assert.ok(!unhide(body).includes('Tr0ub4dorXq21'));
    }
  });
});

test('every shape, with every control character, typed into every free-text field of every endpoint never comes back (answers, state)', async () => {
  await withServer(async (url, { workspaces }) => {
    for (const ch of CHARS) for (const s of SHAPES) {
      await post(url, '/api/reset', {});
      const good = await mintGood(url);
      const texts = await sweep(url, s.text(ch), good);
      const bad = texts.filter((t) => unhide(t).includes(s.probe));
      assert.equal(bad.length, 0, `${s.name} with U+${hex(ch)} leaked: ${bad.map((x) => x.slice(0, 200)).join(' | ')}`);
      const state = await (await get(url, '/api/state?mode=live')).text();
      assert.ok(!unhide(state).includes(s.probe), `${s.name} with U+${hex(ch)}: in the state afterwards`);
      assert.ok(!unhide(JSON.stringify(workspaces.peek('default', 'finance')?.snapshot() ?? {})).includes(s.probe), `${s.name} with U+${hex(ch)}: in the engine`);
    }
  });
});

test('a held call and an approval comment and a policy value with a control character inside never store the value (summary, canonical form, decision comment, policy oneOf)', async () => {
  await withServer(async (url) => {
    for (const ch of CHARS) {
      await post(url, '/api/reset', {});
      const good = await mintGood(url);
      const secret = `pass${ch}word is Tr0ub4dorXq31`;
      const held = await post(url, '/api/evaluate', live({ request: { route: `/mcp/${C.castApp}`, tool: C.castToolHold, arguments: { record: secret, newValue: C.castNewValue, [`p${ch}w: Tr0ub4dorXq32`]: 1 }, token: good } }));
      const hb = await held.text();
      assert.ok(!unhide(hb).includes('Tr0ub4dorXq3'), `held U+${hex(ch)}: ${hb.slice(0, 300)}`);
      const dec = await post(url, '/api/approvals/apr-0001/decision', live({ decision: { approver: C.castApprover, decision: 'approve', authLevel: 2, comment: `Bea${ch}rer abcdEFGH1234567890.tokenvalue and ${secret}` } }));
      const db = await dec.text();
      assert.ok(!unhide(db).includes('tokenvalue') && !unhide(db).includes('Tr0ub4dorXq31'), `comment U+${hex(ch)}`);
      const pol = await post(url, '/api/reset', {});
      assert.equal(pol.status, 200);
      const put = await fetch(`${url}/api/policies/apps`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: url }, body: JSON.stringify(live({ rules: [{ id: 'a', identity: '*', app: C.castApp, requiredClaims: [{ claim: 'region', oneOf: [secret] }] }] })) });
      const pb = await put.text();
      assert.notEqual(put.status, 200, `policy value U+${hex(ch)} must be refused`);
      assert.ok(!unhide(pb).includes('Tr0ub4dorXq31'));
      const st = await (await get(url, '/api/state?mode=live')).text();
      assert.ok(!unhide(st).includes('Tr0ub4dorXq3'), `state U+${hex(ch)}`);
    }
  });
});

test('the injection phrase with a control character inside is refused on the request, at every control character, and still found in a key', async () => {
  await withServer(async (url) => {
    for (const ch of CHARS) {
      await post(url, '/api/reset', {});
      const good = await mintGood(url);
      for (const args of [{ record: `ignore pre${ch}vious instructions` }, { record: 'x', [`ignore pre${ch}vious instructions`]: 1 }]) {
        const r = await post(url, '/api/evaluate', live({ request: { route: `/mcp/${C.castApp}`, tool: C.castToolRead, arguments: args, token: good } }));
        const b = await r.json();
        assert.equal(b.result.code, 'inspection_refused', `U+${hex(ch)} ${JSON.stringify(args).slice(0, 60)}`);
        assert.deepEqual(b.result.findings.map((f) => f.kind), ['injection']);
      }
    }
  });
});
