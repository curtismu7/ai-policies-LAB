// Masking must hold against every way a credential can be hidden from a pattern: invisible and format characters between its letters, percent-encoding (once or
// twice), key-aware shapes (a credential word as a JSON key, in any quoting), adjacent assignments, and a credential that reaches a stored summary.
// A leak is searched for in the NORMALISED answer (invisible characters deleted, percent-decoded), because a leak would come back still hidden.
import test from 'node:test';
import assert from 'node:assert/strict';
import { C, get, post, withServer } from './helpers.js';
import { sweep } from './sweep.js';
import { cleanFree, findCredentials, normalizeForMatching } from '../src/credentials.js';
import { maskDeep } from '../src/mask.js';
import { shown } from '../src/engine.js';

const INVISIBLE = [0x3164, 0xffa0, 0x115f, 0x1160, 0x034f, 0x180e, 0xfe00, 0xfe0f, 0xe0020, 0x061c, 0x2065, 0x206a, 0x206f, 0x17b4, 0x17b5, 0xfffd, 0x00ad, 0x200b, 0x200d, 0x2060, 0xfeff, 0x202e, 0x2062, 0x2066, 0x200e, 0x0600, 0x0601, 0x06dd, 0x070f, 0x08e2, 0x110bd, 0x1d173].map((n) => String.fromCodePoint(n));
const J = (a, b, c) => [a, b, c].join('.');
const SHAPES = [
  { name: 'jwt', raw: J('eyJhbGciOiJSUzI1NiJ9', 'eyJzdWIiOiJhYmNkZWYifQ', 'abcdefghij1234567890XYZ'), probe: 'eyJzdWIiOiJhYmNkZWYifQ' },
  { name: 'password sentence', raw: 'my password is hunter2hunter2', probe: 'hunter2hunter2' },
  { name: 'bearer', raw: ['Bear', 'er abcdEFGH1234567890.tokenvalue'].join(''), probe: 'tokenvalue' },
  { name: 'sk key', raw: ['sk', '-proj-Zy9Xw8Vv7Uu6Tt5Ss4Rr3Qq2Pp1'].join(''), probe: 'Zy9Xw8Vv7Uu6Tt5Ss4Rr3Qq2Pp1' },
];
const unhide = (t) => {
  let s = String(t);
  for (let i = 0; i < 4; i++) s = s.replace(/(?:%[0-9a-fA-F]{2})+/g, (r) => { try { return decodeURIComponent(r); } catch { return r; } });
  return s.replace(/[\p{Default_Ignorable_Code_Point}\p{Cf}�]/gu, '');
};
const live = (extra = {}) => ({ mode: 'live', vertical: 'finance', ...extra });
const interleave = (s, ch) => [...s].join(ch);
const mintGood = async (url) => (await (await post(url, '/api/token', live({ token: { claims: { sub: C.castAgent, surfaces: ['tool'], scope: `${C.castApp}:write ${C.castApp}:read`, department: C.castDept, end_user: C.castUser } } }))).json()).result.labToken;

test('cleanFree and the response mask see through every invisible character interleaved into every shape (unit)', () => {
  assert.ok(INVISIBLE.length >= 24);
  for (const ch of INVISIBLE) for (const s of SHAPES) {
    const hidden = interleave(s.raw, ch);
    assert.ok(!unhide(cleanFree(hidden)).includes(s.probe), `${s.name} with U+${ch.codePointAt(0).toString(16)}`);
    assert.ok(!unhide(JSON.stringify(maskDeep({ a: hidden }))).includes(s.probe), `mask: ${s.name} with U+${ch.codePointAt(0).toString(16)}`);
  }
});

test('every invisible character interleaved into every credential shape, typed into every field of every endpoint, never comes back (answers, state, stdout, stderr)', async () => {
  const out = []; const realOut = process.stdout.write.bind(process.stdout); const realErr = process.stderr.write.bind(process.stderr);
  await withServer(async (url) => {
    const good = await mintGood(url);
    process.stdout.write = (c, ...a) => { out.push(String(c)); return realOut(c, ...a); }; process.stderr.write = (c, ...a) => { out.push(String(c)); return realErr(c, ...a); };
    try {
      for (const ch of INVISIBLE) for (const s of SHAPES) {
        await post(url, '/api/reset', {});
        const g = await mintGood(url);
        const texts = await sweep(url, interleave(s.raw, ch), g);
        const bad = texts.filter((t) => unhide(t).includes(s.probe));
        assert.equal(bad.length, 0, `${s.name} with U+${ch.codePointAt(0).toString(16)} leaked: ${bad.map((x) => x.slice(0, 160)).join(' | ')}`);
        const state = await (await get(url, '/api/state?mode=live')).text();
        assert.ok(!unhide(state).includes(s.probe), `${s.name} with U+${ch.codePointAt(0).toString(16)}: in the state afterwards`);
      }
    } finally { process.stdout.write = realOut; process.stderr.write = realErr; }
  });
  assert.ok(!unhide(out.join('')).includes('hunter2hunter2') && !out.join('').includes('Zy9Xw8Vv7Uu6'), 'nothing was logged');
});

test('percent-encoded credentials (plain, once, twice) typed into every field of every endpoint never come back', async () => {
  const shapes = [...SHAPES, { name: 'url userinfo', raw: ['https://alice:', 's3cretPW99@host.example/x'].join(''), probe: 's3cretPW99' }];
  await withServer(async (url) => {
    for (const s of shapes) for (const times of [0, 1, 2]) {
      let v = s.raw; for (let i = 0; i < times; i++) v = encodeURIComponent(v);
      await post(url, '/api/reset', {});
      const g = await mintGood(url);
      const texts = await sweep(url, v, g);
      const bad = texts.filter((t) => unhide(t).includes(s.probe));
      assert.equal(bad.length, 0, `${s.name} encoded ${times}x leaked: ${bad.map((x) => x.slice(0, 160)).join(' | ')}`);
      assert.ok(!unhide(await (await get(url, '/api/state?mode=live')).text()).includes(s.probe), `${s.name} ${times}x in the state`);
    }
  });
});
test('the encoded forms are shown decoded and masked, not as typed', () => {
  assert.equal(cleanFree('my%20password%20is%20hunter2hunter2'), 'my [masked:assignment]');
  assert.ok(!cleanFree('my%2520password%2520is%2520hunter2hunter2').includes('hunter2'));
  assert.ok(!cleanFree('https%3A%2F%2Falice%3As3cretPW99%40host.example').includes('s3cretPW99'));
  assert.equal(cleanFree('100%25 sure'), '100% sure', 'a literal percent sign survives');
  assert.equal(cleanFree('%E0%A4%A bad'), '%E0%A4%A bad', 'malformed encoding is left alone');
});

// ---- key-aware masking and adjacent assignments (B2) ----
const SECRET_SHAPES = [
  ['{"password":"hunter2hunter2"}', 'hunter2hunter2'], ['{"password" : "hunter2hunter2"}', 'hunter2hunter2'], ["{'password': 'hunter2hunter2'}", 'hunter2hunter2'], ['password: "hunter2hunter2"', 'hunter2hunter2'],
  ['{"passwd":"Tr0ub4dor&3"}', 'Tr0ub4dor&3'], ['{"secret":"s3cr3tvalue"}', 's3cr3tvalue'], ['{"api_key":"AAAA-bbbb-cccc"}', 'AAAA-bbbb-cccc'], ['{"apiKey":"qqqq-wwww-eeee"}', 'qqqq-wwww-eeee'],
  ['{"token":"short.tok"}', 'short.tok'], ['{"authorization":"Basic zzzz9999"}', 'zzzz9999'], ['{"pin":"481516"}', '481516'], ['{"client_secret":"cs-77aa88bb"}', 'cs-77aa88bb'],
  ['{"private_key":"pk-1111"}', 'pk-1111'], ['{"credential":"cred-4242"}', 'cred-4242'], ['{"cred":{"password":"nested-pw-1"}}', 'nested-pw-1'], ['{"passcode":"pc-90909"}', 'pc-90909'],
  ['{"a":"password: x1x1x1","b":"password: zq81xkzq"}', 'zq81xkzq'], ['{"a":"password: x1x1x1","b":"password: zq81xkzq"}', 'x1x1x1'], ['password=aaa111,password=bbb222;pass=ccc333', 'bbb222'], ['password=aaa111,password=bbb222;pass=ccc333', 'ccc333'],
  ['{"a":"password is x1x1x1","b":"password is zq81xkzq"}', 'zq81xkzq'], ['{"a":"password is x1x1x1","b":"password is zq81xkzq"}', 'x1x1x1'],
  ['{"a":"token: t1t1t1","b":"secret: s2s2s2","c":"api_key=k3k3k3"}', 's2s2s2'], ['{"a":"token: t1t1t1","b":"secret: s2s2s2","c":"api_key=k3k3k3"}', 'k3k3k3'],
];
test('key-aware masking: a credential word as a key masks its value in any quoting; adjacent assignments each match (unit)', () => {
  for (const [text, probe] of SECRET_SHAPES) {
    assert.ok(!cleanFree(text).includes(probe), `cleanFree: ${text}`);
    assert.ok(!JSON.stringify(maskDeep({ x: text })).includes(probe), `mask: ${text}`);
  }
  assert.ok(findCredentials('{"password":"hunter2hunter2"}').length > 0);
});
test('key-aware masking leaves ordinary JSON, ids and prose alone (no false positives)', () => {
  for (const t of ['{"record":"payee-1042","newValue":"payee-9917"}', '{"query":"the token requirements and the password policy"}', 'passing the review needs sign-off', '{"amount":25000,"note":"pin the release"}', 'the pin is required', '{"author":"maya.chen"}']) assert.equal(cleanFree(t), t, t);
});
test('hostile repetition around the new detectors stays linear', () => {
  const t0 = Date.now();
  for (const bad of ['password"'.repeat(5000), '"password" '.repeat(3000), 'password:'.repeat(5000), "token='".repeat(4000), '{"pin":'.repeat(3000), 'authorization'.repeat(3000) + ':', `${'"password": "'.repeat(2000)}`]) cleanFree(bad);
  assert.ok(Date.now() - t0 < 4000, `${Date.now() - t0} ms`);
});

test('keyed secrets typed as ARGUMENTS (object and text), as a held call, as a reply, a claim, a comment and a canonical-hash request never come back, and the approval summary stores no value', async () => {
  await withServer(async (url, { workspaces }) => {
    const g = await mintGood(url);
    for (const [text, probe] of SECRET_SHAPES) {
      await post(url, '/api/reset', {});
      const g2 = await mintGood(url);
      const asObject = (() => { try { return JSON.parse(text); } catch { return null; } })();
      const calls = [
        asObject && !Array.isArray(asObject) ? { route: `/mcp/${C.castApp}`, tool: C.castToolHold, arguments: { record: C.castRecord, newValue: 'x', ...asObject }, token: g2 } : null,
        { route: `/mcp/${C.castApp}`, tool: C.castToolHold, arguments: { record: C.castRecord, newValue: text }, token: g2 },
        { route: `/mcp/${C.castApp}`, tool: C.castToolRead, argumentsText: asObject && !Array.isArray(asObject) ? JSON.stringify({ record: 'r', ...asObject }) : JSON.stringify({ record: text }), token: g2 },
        { route: `/mcp/${C.castApp}`, tool: C.castToolRead, arguments: { record: 'r' }, token: g2, simulatedReply: text, headers: { 'x-note': text } },
      ].filter(Boolean);
      const texts = [];
      for (const request of calls) { const r = await post(url, '/api/evaluate', live({ request })); texts.push(await r.text()); }
      texts.push(await (await post(url, '/api/token', live({ token: { claims: { note: text } } }))).text());
      texts.push(await (await post(url, '/api/canonicalize', { argumentsText: asObject ? text : JSON.stringify({ a: text }) })).text());
      texts.push(await (await post(url, '/api/approvals/apr-0001/decision', live({ decision: { approver: C.castApprover, decision: 'approve', authLevel: 2, comment: text } }))).text());
      texts.push(await (await get(url, '/api/state?mode=live')).text());
      const bad = texts.filter((t) => unhide(t).includes(probe));
      assert.equal(bad.length, 0, `${text}: ${bad.map((x) => x.slice(0, 200)).join(' | ')}`);
      const eng = workspaces.peek('default', 'finance');
      assert.ok(!JSON.stringify(eng.snapshot()).includes(probe), `${text}: the engine state`);
    }
  });
});
test('the approval summary of a held call never stores a value, whatever the arguments say', async () => {
  await withServer(async (url) => {
    const g = await mintGood(url);
    for (const args of [{ record: C.castRecord, newValue: 'x', password: 'hunter2hunter2' }, { record: C.castRecord, newValue: 'password: zq81xkzq' }, { record: 'plain-unique-value-55', newValue: 'plain-unique-value-66' }]) {
      await post(url, '/api/reset', {});
      const g2 = await mintGood(url);
      const r = await (await post(url, '/api/evaluate', live({ request: { route: `/mcp/${C.castApp}`, tool: C.castToolHold, arguments: args, token: g2 } }))).json();
      assert.equal(r.result.outcome, 'hold');
      const st = await (await get(url, '/api/state?mode=live')).text();
      for (const v of ['hunter2hunter2', 'zq81xkzq', 'plain-unique-value-55', 'plain-unique-value-66']) assert.ok(!st.includes(v), v);
      assert.match(JSON.parse(st).state.approvals[0].summary, /^change_payee on payments: arguments .*; call hash [0-9a-f]{16}$/);
    }
  });
});
test('normalizeForMatching: deletes every Default_Ignorable, Cf and replacement character, decodes up to four rounds, applies NFKC', () => {
  for (const ch of INVISIBLE) assert.equal(normalizeForMatching(`a${ch}b`), 'ab', `U+${ch.codePointAt(0).toString(16)}`);
  assert.equal(normalizeForMatching('%25252541'), 'A', 'four rounds are decoded');
  assert.equal(normalizeForMatching('%2525252541'), '%41', 'and no more than four');
  assert.equal(normalizeForMatching('ｐａｓｓ'), 'pass');
  assert.equal(normalizeForMatching(undefined), '');
});

test('the canonical-form display (shown) sees through hidden credentials on its own, not only through the response mask behind it', () => {
  for (const ch of INVISIBLE) for (const sh of SHAPES) assert.ok(!unhide(shown(`{"arguments":{"x":"${interleave(sh.raw, ch)}"}}`, 600)).includes(sh.probe), `${sh.name} U+${ch.codePointAt(0).toString(16)}`);
  const plain = '{"arguments":{"record":"payee-1042"},"method":"tools/call"}';
  assert.equal(shown(plain, 600), plain, 'an ordinary canonical form is shown exactly as it is hashed');
});
test('a credential-shaped claim value or claim name, even hidden, is REFUSED at mint (not just masked), and so is a credential-word claim name', async () => {
  await withServer(async (url) => {
    const bad = async (claims) => post(url, '/api/token', live({ token: { claims } }));
    for (const ch of ['\u3164', '\u200b', '\u{e0020}', '\u0600']) for (const sh of SHAPES.filter((x) => x.raw.length * 2 < 118)) { const r = await bad({ note: interleave(sh.raw, ch) }); assert.equal(r.status, 400, `${sh.name} ${ch.codePointAt(0)}`); assert.equal((await r.json()).error, 'credential_shaped'); }
    for (const name of ['password', 'api_key', 'client_secret', 'access_token', 'authorization', 'pin', 'db_password']) { const r = await bad({ [name]: 'x' }); assert.equal(r.status, 400, name); assert.equal((await r.json()).error, 'bad_claim_name', name); }
    assert.equal((await bad({ department: 'finance', max_tokens: 4096 })).status, 200, 'ordinary claims, including max_tokens, are fine');
  });
});
