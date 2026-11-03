// S1: URL userinfo without a scheme, two passphrases in one text, a keyword followed by a plain space and a value, session cookies, four rounds of percent-encoding,
// and the ordinary sentences that must stay readable (the false-positive side of the same trade).
import test from 'node:test';
import assert from 'node:assert/strict';
import { C, get, post, put, withServer } from './helpers.js';
import { sweep } from './sweep.js';
import { cleanFree, looksLikeCredential, normalizeForMatching } from '../src/credentials.js';
import { maskDeep } from '../src/mask.js';
import { PLAIN } from './secrets.js';

const live = (extra = {}) => ({ mode: 'live', vertical: 'finance', ...extra });
const mintGood = async (url) => (await (await post(url, '/api/token', live({ token: { claims: { sub: C.castAgent, surfaces: ['tool'], scope: `${C.castApp}:write ${C.castApp}:read`, department: C.castDept, end_user: C.castUser } } }))).json()).result.labToken;

// [text, the part that must not survive]. The two "api key" lines are joined at run time so no key-shaped line sits in the repository.
const MUST_MASK = [
  // (a) URL userinfo with no scheme
  ['alice:Tr0ub4dorXq06@host.example/x', 'Tr0ub4dorXq06'],
  ['connect to bob:Pa55w0rdXyz@db.internal.example:5432/app now', 'Pa55w0rdXyz'],
  ['postgres via carol:hunter2hunter2@localhost', 'hunter2hunter2'],
  ['https://alice:Tr0ub4dorXq07@host.example/x', 'Tr0ub4dorXq07'],
  // (b) passphrases: every occurrence, in the same text
  ['passphrase is AAA111zz x passphrase is BBB222zz y', 'AAA111zz'],
  ['passphrase is AAA111zz x passphrase is BBB222zz y', 'BBB222zz'],
  ['{"a":"passphrase is Tr0ub4dorXq51 and more","b":"passphrase is Tr0ub4dorXq52 and more"}', 'Tr0ub4dorXq51'],
  ['{"a":"passphrase is Tr0ub4dorXq51 and more","b":"passphrase is Tr0ub4dorXq52 and more"}', 'Tr0ub4dorXq52'],
  // quoted, the whole phrase is masked. The sweep helper strips the quotes when it embeds a text in JSON, and unquoted the shared masker takes only the first word (a known
  // limit, pinned in masker-limits.test.js), so the probe is that first word
  ['passphrase = "correct horse battery staple"', 'correct'],
  // (c) a keyword, a plain space and a value
  ['password Tr0ub4dorXq03', 'Tr0ub4dorXq03'],
  ['pw Tr0ub4dorXq04', 'Tr0ub4dorXq04'],
  ['token Tr0ub4dorXq05', 'Tr0ub4dorXq05'],
  ['secret Tr0ub4dorXq08', 'Tr0ub4dorXq08'],
  [['api ', 'key Tr0ub4dorXq09'].join(''), 'Tr0ub4dorXq09'],
  ['credentials Tr0ub4dorXq10', 'Tr0ub4dorXq10'],
  ['passphrase Tr0ub4dorXq11', 'Tr0ub4dorXq11'],
  ['db pwd Tr0ub4dorXq12', 'Tr0ub4dorXq12'],
  [['the ', 'key is Tr0ub4dorXq13'].join(''), 'Tr0ub4dorXq13'],
  [['my api ', 'key is Tr0ub4dorXq14'].join(''), 'Tr0ub4dorXq14'],
  ['use the password Tr0ub4dorXq15 for the login', 'Tr0ub4dorXq15'],
  [['PASS', 'WORD   Tr0ub4dorXq16'].join(''), 'Tr0ub4dorXq16'],
  // (d) session cookies
  ['Cookie: session=Sx9Qz2Lm8Rt4', 'Sx9Qz2Lm8Rt4'],
  ['Cookie: theme=dark; session=Sx9Qz2Lm8Rt5; lang=en', 'Sx9Qz2Lm8Rt5'],
  ['sid=ab12cd34', 'ab12cd34'],
  ['sessionid: ab12cd35', 'ab12cd35'],
  ['{"session":"Sx9Qz2Lm8Rt6"}', 'Sx9Qz2Lm8Rt6'],
  ['JSESSIONID=Sx9Qz2Lm8Rt7', 'Sx9Qz2Lm8Rt7'],
];
// Sentences that must come back exactly as written (the trade: a bare keyword followed by an ordinary word is prose).
const MUST_STAY = [
  ...PLAIN,
  'the password policy is in the handbook',
  'the token requirements changed in the last release',
  'a secret santa exchange for the whole team',
  'we reset the password for maya.chen on Monday',
  'the key is to review the change before the release',
  'the key is important',
  'credentials are stored by the vault team',
  'api key rotation is quarterly',
  'pw policy review is due',
  'Session: planning for the release (2026-11-02)',
  'session expires at 10:30',
  'the session is open',
  'note: maya.chen@fabrikam.example approved it',
  'contact maya.chen@fabrikam.example or lee.park@fabrikam.example',
  'time 10:30 on the call with priya.nair',
  'passphrase policy: twelve words',
  '{"record":"payee-1042","newValue":"payee-9917"}',
];

test('each secret shape is masked and each ordinary sentence is left exactly as it was (cleanFree and the response mask)', () => {
  for (const [text, probe] of MUST_MASK) {
    assert.ok(!cleanFree(text).includes(probe), `cleanFree: ${text} -> ${cleanFree(text)}`);
    assert.ok(!JSON.stringify(maskDeep({ x: text })).includes(probe), `maskDeep: ${text}`);
    assert.ok(looksLikeCredential(text), `looksLikeCredential: ${text}`);
  }
  for (const t of MUST_STAY) {
    assert.equal(cleanFree(t), t, `cleanFree changed: ${t} -> ${cleanFree(t)}`);
    assert.equal(maskDeep({ x: t }).x, t, `maskDeep changed: ${t}`);
    assert.ok(!looksLikeCredential(t), `looksLikeCredential: ${t}`);
  }
});

test('two passphrases in one text are each masked on their own (S1b: the first one no longer swallows the second)', () => {
  const out = cleanFree('passphrase is AAA111zz x passphrase is BBB222zz y');
  assert.equal(out, '[masked:phrase] x [masked:phrase] y');
  assert.ok(!out.includes('AAA111zz') && !out.includes('BBB222zz'));
});

test('the shapeless-keyword rule is bounded: a bare keyword masks only a value that looks like a secret (six characters and a digit, a capital inside, or a symbol)', () => {
  assert.equal(cleanFree('password Tr0ub4'), '[masked:shape]', 'six characters with a digit');
  assert.equal(cleanFree('password Ab1'), 'password Ab1', 'under six characters');
  assert.equal(cleanFree('password Ab1x2'), 'password Ab1x2', 'five characters are still too short');
  assert.equal(cleanFree('password Ab1x23'), '[masked:shape]', 'six characters');
  assert.equal(cleanFree('password hunterxyz'), 'password hunterxyz', 'a lowercase word is prose: the README states this miss');
  assert.equal(cleanFree('password hunterXyz'), '[masked:shape]', 'a capital inside the word');
  assert.equal(cleanFree('password hunter_xyz'), 'password hunter_xyz', 'an underscore is not a symbol to the shared masker: a new miss (1.4.0), the README states it');
  assert.equal(cleanFree('password 2026-11-02'), 'password 2026-11-02', 'a date is not a secret');
  assert.equal(cleanFree('Session: standup'), 'Session: standup');
  assert.equal(cleanFree('session: Ab1x2'), 'session: Ab1x2', 'a session value of five characters is not enough');
  assert.equal(cleanFree('session: Ab1x23'), 'session: Ab1x23', 'a bare session value is judged as prose by the shared masker whatever its length: a new miss (1.4.0), the README states it');
  assert.equal(cleanFree('Session: Q3-review2'), '[masked:assignment]', 'a session value with a digit is treated as a cookie: a known false positive');
});

test('S1e: four rounds of percent-encoding are decoded and masked; a fifth is not (documented)', () => {
  const enc = (s, n) => { let v = s; for (let i = 0; i < n; i++) v = encodeURIComponent(v); return v; };
  for (let n = 0; n <= 4; n++) assert.ok(!cleanFree(enc('my password is Tr0ub4dorXq17', n)).includes('Tr0ub4dorXq17'), `${n} rounds`);
  assert.equal(normalizeForMatching(enc('a b', 4)), 'a b');
  assert.notEqual(normalizeForMatching(enc('a b', 5)), 'a b', 'a fifth round is left encoded');
});

test('every new shape typed into every free-text field of every endpoint never comes back (answers, state)', async () => {
  await withServer(async (url, { workspaces }) => {
    for (const [text, probe] of MUST_MASK) {
      await post(url, '/api/reset', {});
      const good = await mintGood(url);
      const texts = await sweep(url, text, good);
      const bad = texts.filter((t) => t.includes(probe));
      assert.equal(bad.length, 0, `${text} leaked: ${bad.map((x) => x.slice(0, 220)).join(' | ')}`);
      const state = await (await get(url, '/api/state?mode=live')).text();
      assert.ok(!state.includes(probe), `${text}: in the state afterwards`);
      assert.ok(!JSON.stringify(workspaces.peek('default', 'finance')?.snapshot() ?? {}).includes(probe), `${text}: in the engine`);
    }
  });
});

test('S1b through the API: a passphrase typed into both arguments of a held change_payee never reaches the decision, the canonical form or the state', async () => {
  await withServer(async (url) => {
    const good = await mintGood(url);
    const v = 'passphrase is Tr0ub4dorXq52 and more';
    const r = await (await post(url, '/api/evaluate', live({ request: { route: `/mcp/${C.castApp}`, tool: C.castToolHold, arguments: { record: v, newValue: v }, token: good } }))).json();
    assert.equal(r.result.outcome, 'hold');
    assert.ok(!JSON.stringify(r).includes('Tr0ub4dorXq52'), r.result.canonical);
    assert.equal((r.result.canonical.match(/\[masked:phrase\]/g) || []).length, 2, r.result.canonical);
    const st = await (await get(url, '/api/state?mode=live')).text();
    assert.ok(!st.includes('Tr0ub4dorXq52'));
  });
});

test('a key NAMED session (or sid) hides its value whatever the value looks like, in every shown copy; and cannot be a claim name', async () => {
  await withServer(async (url) => {
    const good = await mintGood(url);
    const r = await post(url, '/api/evaluate', live({ request: { route: `/mcp/${C.castApp}`, tool: C.castToolRead, arguments: { record: 'x' }, token: good, headers: { session: 'Sx9Qz2Lm8Rt8', sid: 'ab12cd36' } } }));
    const t = await r.text();
    assert.ok(!t.includes('Sx9Qz2Lm8Rt8') && !t.includes('ab12cd36'), t.slice(0, 400));
    for (const name of ['session', 'sid', 'passphrase']) {
      const m = await post(url, '/api/token', live({ token: { claims: { [name]: 'x' } } }));
      assert.equal(m.status, 400, name); assert.equal((await m.json()).error, 'bad_claim_name', name);
    }
  });
});

test('one masker for what is typed in and what is shown: a 32+ character run with a digit is [masked:opaque] in both, so a rule id of that shape is refused at save', async () => {
  const id = 'payments-report-2026-q4-final-v2';
  assert.equal(id.length, 32);
  assert.equal(maskDeep({ x: id }).x, '[masked:opaque]');
  assert.equal(cleanFree(id), '[masked:opaque]');
  await withServer(async (url) => {
    const r = await put(url, '/api/policies/users', live({ rules: [{ id, app: C.castApp, tool: C.castToolRead, users: [C.castUser] }] }));
    assert.equal(r.status, 422);
    assert.ok((await r.json()).errors.some((e) => e.code === 'bad_id'));
  });
});
