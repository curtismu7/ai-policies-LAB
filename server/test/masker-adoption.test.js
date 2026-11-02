// The adapter over the shared masker (shared-masker 1.4.0, commit 9bc664a): the leaks and the false positive that the lab's own masker had, the options the adapter sets, the
// two helpers built on top of it (isCredentialKey, cleanUnderKey), and the limits that the shared masker documents and this lab inherits (pinned with literal outputs so the
// README's list of misses cannot drift). Test values are assembled from parts at run time so no secret-shaped literal sits in the repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import { C, get, post, withServer } from './helpers.js';
import { MAX_FREE, cleanFree, cleanUnderKey, isCredentialId, isCredentialKey, looksLikeCredential, maskText } from '../src/credentials.js';
import { maskDeep, maskProse } from '../src/mask.js';
import { shown } from '../src/engine.js';

const H = ['hunter', '2xyz'].join('');
const ch = (n) => String.fromCharCode(n);
const live = (extra = {}) => ({ mode: 'live', vertical: 'finance', ...extra });
const mintGood = async (url) => (await (await post(url, '/api/token', live({ token: { claims: { sub: C.castAgent, surfaces: ['tool'], scope: `${C.castApp}:write ${C.castApp}:read`, department: C.castDept, end_user: C.castUser } } }))).json()).result.labToken;

// Each: [name, text typed]. All of them leaked through the lab's own masker or its canonical-form display.
const LEAKS = [
  ['U+1680 inside the keyword', `pass${ch(0x1680)}word: ${H}`],
  ['TAB inside the keyword', `pass${ch(9)}word: ${H}`],
  ['U+2028 inside the keyword', `pass${ch(0x2028)}word: ${H}`],
  ['login with a slash', `login: bob / ${H}`],
  ['password with a dash', `password - ${H}`],
  ['Bearer then TAB', `Bearer${ch(9)}${H}abcdef`],
  ['password then TAB', `password${ch(9)}${H}`],
];

test('every leak the lab\'s own masker had is masked now, by cleanFree, maskText, maskDeep and looksLikeCredential (literal marks)', () => {
  const marks = { 'U+1680 inside the keyword': 'assignment', 'TAB inside the keyword': 'assignment', 'U+2028 inside the keyword': 'assignment', 'login with a slash': 'pair', 'password with a dash': 'shape', 'Bearer then TAB': 'shape', 'password then TAB': 'shape' };
  for (const [name, text] of LEAKS) {
    assert.equal(cleanFree(text), `[masked:${marks[name]}]`, name);
    assert.equal(maskText(text), `[masked:${marks[name]}]`, name);
    assert.deepEqual(maskDeep({ x: text }), { x: `[masked:${marks[name]}]` }, name);
    assert.equal(looksLikeCredential(text), true, name);
  }
});

test('an object KEY that carries a secret is masked too (the value and the key text), including a nested one and a collision', () => {
  const out = maskDeep({ [`password ${H}`]: 'v', [`token ${H}`]: 1, nested: { [`password ${H}`]: { a: 1 } } });
  assert.equal(JSON.stringify(out).includes(H), false);
  assert.deepEqual(out, { '[masked:shape]': '[masked:assignment]', '[masked:shape]#2': 1, nested: { '[masked:shape]': { a: 1 } } });
  assert.equal(JSON.stringify(maskProse({ [`password ${H}`]: 'v' })).includes(H), false, 'the prose masker masks a secret key as well');
});

test('false positive fixed: a claim note saying "the token is accepted" is ordinary text, in the unit and through the mint', async () => {
  for (const t of ['the token is accepted', 'claim note: the token is accepted', 'the token is accepted by the gateway']) {
    assert.equal(cleanFree(t), t); assert.equal(maskDeep({ x: t }).x, t); assert.equal(looksLikeCredential(t), false);
  }
  await withServer(async (url) => {
    const r = await post(url, '/api/token', live({ token: { claims: { sub: C.castAgent, surfaces: ['tool'], scope: `${C.castApp}:read`, department: C.castDept, note: 'the token is accepted' } } }));
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.equal(b.result.claims.note, 'the token is accepted');
  });
});

test('the leaks typed as ARGUMENT values, as added argument KEYS, as a claim, a comment and a reply never come back, and the canonical form shows none of them', async () => {
  await withServer(async (url, { workspaces }) => {
    for (const [name, text] of LEAKS) {
      await post(url, '/api/reset', {});
      const good = await mintGood(url);
      const route = `/mcp/${C.castApp}`;
      const bodies = [
        ['/api/evaluate', live({ request: { route, tool: C.castToolHold, arguments: { record: text, newValue: 'x' }, token: good } })],
        ['/api/evaluate', live({ request: { route, tool: C.castToolHold, arguments: { record: 'r', newValue: 'x', [text]: 1 }, token: good } })],
        ['/api/evaluate', live({ request: { route, tool: C.castToolRead, arguments: { record: 'r' }, token: good, simulatedReply: `ok ${text}`, headers: { [text]: text } } })],
        ['/api/canonicalize', { arguments: { record: text } }],
        ['/api/token', live({ token: { claims: { note: text } } })],
        ['/api/approvals/apr-0001/decision', live({ decision: { approver: C.castApprover, decision: 'approve', authLevel: 2, comment: text } })],
      ];
      const texts = [];
      for (const [p, b] of bodies) texts.push(await (await post(url, p, b)).text());
      texts.push(await (await get(url, '/api/state?mode=live')).text());
      for (const t of texts) assert.equal(t.includes(H), false, `${name}: ${t.slice(0, 200)}`);
      assert.equal(JSON.stringify(workspaces.peek('default', 'finance')?.snapshot() ?? {}).includes(H), false, `${name}: engine state`);
    }
  });
});

test('shown (the canonical-form display) masks the DATA of the canonical JSON: a TAB written as \\t, a NUL written as \\u0000, a secret key, a quoted passphrase; an ordinary form is shown as hashed', () => {
  const doc = (args) => JSON.stringify({ arguments: args, method: 'tools/call', target: 'tool:payments/change_payee' });
  assert.equal(shown(doc({ record: `password${ch(9)}${H}` }), 600), doc({ record: '[masked:shape]' }));
  assert.equal(shown(doc({ record: `pass${ch(0)}word: ${H}` }), 600), doc({ record: '[masked:assignment]' }));
  assert.equal(shown(doc({ [`password ${H}`]: 1 }), 600), doc({ '[masked:shape]': 1 }));
  assert.equal(shown(doc({ record: 'passphrase = "correct horse battery staple"' }), 600), doc({ record: '[masked:assignment]' }));
  const plain = doc({ record: 'payee-1042' });
  assert.equal(shown(plain, 600), plain);
  assert.equal(shown(plain, 20), plain.slice(0, 20), 'cut after masking');
  assert.equal(shown('not json at all', 600), 'not json at all');
  assert.equal(shown(`not json: password=${H}`, 600).includes(H), false);
});

test('isCredentialKey: credential words as the shared masker reads keys (look-alikes, encodings, numbering), not counts or descriptions', () => {
  for (const k of ['password', 'passwd', 'secret', 'token', 'api_key', 'apiKey', 'client_secret', 'access_token', 'db_password', 'userPassword', 'pin', 'session', 'sid', 'authorization', 'auth', 'pwd', 'pw', 'passphrase', 'PASSWORD', 'pass word', 'p%61ssword', 'password2', `password ${H}`]) assert.equal(isCredentialKey(k), true, k);
  for (const k of ['max_tokens', 'tokens', 'department', 'region', 'sub', 'scope', 'end_user', 'token_type', 'amount', 'record', 'newValue', 'surfaces']) assert.equal(isCredentialKey(k), false, k);
});

test('cleanUnderKey: a credential-word key masks a string, a number and a boolean whatever they look like; any other key cleans the text', () => {
  assert.equal(cleanUnderKey('password', 'x', 300), '[masked:assignment]');
  assert.equal(cleanUnderKey('password', 12, 300), '[masked:assignment]');
  assert.equal(cleanUnderKey('password', true, 300), '[masked:assignment]');
  assert.equal(cleanUnderKey('amount', 12, 300), 12);
  assert.equal(cleanUnderKey('note', 'a\u0000 b', 300), 'a b');
  assert.equal(cleanUnderKey('note', `my password is ${H}`, 300), 'my [masked:phrase]');
  assert.equal(cleanUnderKey('note', 'abcdef', 3), 'abc');
});

test('cleanFree: masks first, then tidies (invisible and control characters deleted, white space collapsed) and cuts; never splits a surrogate pair; never throws', () => {
  assert.equal(cleanFree(`a${ch(0x200b)}b\n\n c\t d `), 'ab c d');
  assert.equal(cleanFree('x'.repeat(2000)).length, MAX_FREE);
  const cut = cleanFree('a'.repeat(399) + '\u{1f600}', 400);
  assert.equal(cut, 'a'.repeat(399), 'the half of an emoji at the cut is dropped, not kept as a lone surrogate');
  assert.equal(cleanFree(`${'a'.repeat(390)} password=${H}`, 400).includes('hunter'), false, 'the secret that straddles the cut is masked, not half shown');
  for (const v of [undefined, null, 5, true, {}, [], () => 1, Symbol('s'), 10n]) assert.doesNotThrow(() => cleanFree(v));
});

test('isCredentialId: a workspace-id-shaped credential is refused, a plain lab name is not', () => {
  for (const id of ['pw-hunter2xyz', 'token-abc', 'password-abc123', 'sk-abcdefgh', 'a'.repeat(24) + '1', 'deadbeef'.repeat(4)]) assert.equal(isCredentialId(id), true, id);
  for (const id of ['default', 'w-laptop', 'echo-hex', 'tab-2', 'w-token-exchange']) assert.equal(isCredentialId(id), false, id);
});

// ---- limits inherited from the shared masker 1.4.0: the lab's own masker used to mask these; the README lists them ----
test('known limits (shared masker 1.4.0, pinned): what is NOT masked any more', () => {
  const same = (t) => assert.equal(cleanFree(t), t, t);
  same('passphrase: correct horse battery');              // a passphrase of plain words: only a quoted one is masked whole
  same(['Zq9Xk2Lm8Rt4Vb7N', 'c1Hd5Fj3Gs6Pw0Y'].join('')); // a bare 31-character key (32 and more are [masked:opaque])
  same('deadbeef'.repeat(6));                              // a bare long hex run with no digit reads as a word
  same(['gh', 'p_shortone1234'].join(''));                 // a ghp_ token shorter than 16 characters after the prefix
  same('password hunter_xyz');                             // an underscore is not a symbol
  same('session: Ab1x23');                                 // a bare session value
  assert.equal(cleanFree('passphrase = correct horse battery staple'), '[masked:assignment] horse battery staple', 'unquoted, only the first word');
  assert.equal(cleanFree(['Zq9Xk2Lm8Rt4Vb7N', 'c1Hd5Fj3Gs6Pw0Y3'].join('')), '[masked:opaque]');
  assert.equal(cleanFree(`a${'1'.repeat(31)}`), '[masked:opaque]', 'the 32-character edge');
  assert.equal(cleanFree('a'.repeat(5000)).length, MAX_FREE, 'a run of letters is a word');
});

test('known false positives (pinned): a 32+ character id with a digit reads as an opaque token, a session value with a digit as a cookie', () => {
  assert.equal(cleanFree('payments-report-2026-q4-final-v2'), '[masked:opaque]');
  assert.equal(cleanFree('Session: Q3-review2'), '[masked:assignment]');
});
