// S6: every limit the README states, asserted with the LITERAL number (N accepted, N + 1 refused), so changing a constant changes a test. canon.test.js reads the
// constants from the source; this file does not. Plus the behaviours that mutation testing showed nothing was pinning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { C, claims, holdCall, newEngine, route, sign, tok } from './helpers.js';
import { normalizeArguments } from '../src/canon.js';
import { MAX_FREE, cleanFree } from '../src/credentials.js';
import { MAX_TOKEN, verifyToken } from '../src/token.js';
import { createWorkspaces } from '../src/workspaces.js';

const refusal = (fn) => { try { fn(); } catch (err) { return err.code; } return null; };
const fromText = (text) => normalizeArguments({ text });
const fromObject = (object) => normalizeArguments({ object });
// both spellings of the same call must agree on every limit
const both = (obj) => [fromText(JSON.stringify(obj)), fromObject(obj)];
const accepted = (obj, what) => both(obj).forEach((r, i) => assert.equal(r.ok, true, `${what} (${i ? 'object' : 'text'}): ${r.code}`));
const refused = (obj, code, what) => both(obj).forEach((r, i) => { assert.equal(r.ok, false, `${what} (${i ? 'object' : 'text'}) should be refused`); assert.equal(r.code, code, `${what} (${i ? 'object' : 'text'})`); });
const nest = (n) => { let v = 1; for (let i = 0; i < n; i++) v = { a: v }; return v; };

test('canon: arguments text of exactly 4096 characters is read, 4097 is refused', () => {
  const pad = (n) => `{"a":1}${' '.repeat(n - 7)}`;
  assert.equal(pad(4096).length, 4096); assert.equal(fromText(pad(4096)).ok, true);
  const over = fromText(pad(4097)); assert.equal(over.ok, false); assert.equal(over.code, 'arguments_too_large'); assert.match(over.reason, /4096/);
});
test('canon: nesting 6 deep is read, 7 deep is refused (text and object)', () => {
  accepted(nest(6), 'depth 6'); refused(nest(7), 'arguments_too_deep', 'depth 7');
  assert.equal(fromText('{"a":[[[[[1]]]]]}').ok, true, 'arrays count as depth too: 6 levels'); assert.equal(fromText('{"a":[[[[[[1]]]]]]}').code, 'arguments_too_deep');
});
test('canon: 40 keys in an object are read, 41 are refused', () => {
  const keys = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
  accepted(keys(40), '40 keys'); refused(keys(41), 'arguments_too_large', '41 keys');
});
test('canon: 50 items in an array are read, 51 are refused', () => {
  accepted({ a: Array.from({ length: 50 }, (_, i) => i) }, '50 items'); refused({ a: Array.from({ length: 51 }, (_, i) => i) }, 'arguments_too_large', '51 items');
});
test('canon: 400 values are read, 401 are refused (the object itself, every array and every item count)', () => {
  // 1 (the object) + 8 arrays + 391 items = 400
  const spread = (items) => { const o = {}; let left = items; for (let k = 0; k < 8; k++) { const n = Math.min(50, left); o[`a${k}`] = Array.from({ length: n }, (_, i) => i); left -= n; } return o; };
  accepted(spread(391), '400 values'); refused(spread(392), 'arguments_too_large', '401 values');
});
test('canon: a string of 1000 characters is read, 1001 is refused (value and key)', () => {
  accepted({ a: 'x'.repeat(1000) }, '1000-char value'); refused({ a: 'x'.repeat(1001) }, 'arguments_too_large', '1001-char value');
  accepted({ ['k'.repeat(1000)]: 1 }, '1000-char key'); refused({ ['k'.repeat(1001)]: 1 }, 'arguments_too_large', '1001-char key');
});
test('canon: a number with 15 significant digits is read, 16 is refused; a whole number up to 2^53 - 1 is read', () => {
  assert.equal(fromText('{"a":1.23456789012345}').ok, true); assert.equal(fromText('{"a":1.234567890123456}').code, 'number_not_exact');
  assert.equal(fromObject({ a: 0.123456789012345 }).ok, true); assert.equal(fromObject({ a: 0.1234567890123456 }).code, 'number_not_exact');
  assert.equal(fromText('{"a":9007199254740991}').ok, true); assert.equal(fromText('{"a":9007199254740992}').code, 'number_not_exact');
});

test('free text: 400 characters are kept and no more; a token is 4096 characters and no more; a workspace holds 500 and forgets an idle one after 3600000 ms', () => {
  assert.equal(MAX_FREE, 400);
  assert.equal(cleanFree('ab '.repeat(300)).length, 400, 'cleanFree cuts to exactly 400');
  assert.equal(cleanFree('ab '.repeat(300), 10).length, 10);
  assert.equal(MAX_TOKEN, 4096);
  const tooLong = verifyToken('a'.repeat(4097), { nowSec: 0 }); assert.equal(tooLong.code, 'token_malformed'); assert.match(tooLong.reason, /exceeds/);
  const atLimit = verifyToken('a'.repeat(4096), { nowSec: 0 }); assert.equal(atLimit.code, 'token_malformed'); assert.doesNotMatch(atLimit.reason, /exceeds/, 'at 4096 it is read (and found malformed for another reason)');
});
test('workspaces: the default cap is 500 (the 501st new id is refused, an old one still works) and the default idle time is exactly one hour', () => {
  const ws = createWorkspaces();
  for (let i = 0; i < 500; i++) ws.engine(`w-${i}`, 'finance', C);
  assert.equal(ws.size(), 500);
  assert.equal(refusal(() => ws.engine('w-500', 'finance', C)), 'workspaces_full');
  assert.doesNotThrow(() => ws.engine('w-0', 'finance', C));
  let t = 1_000_000;
  const timed = createWorkspaces({ now: () => t });
  timed.engine('idle', 'finance', C);
  t += 3_600_000; assert.equal(timed.size(), 1, 'exactly one hour idle: still there');
  t += 1; assert.equal(timed.size(), 0, 'one millisecond past the hour: gone');
});

// ---- policy limits, through savePolicy ----
const save = (e, layer, rules) => { try { e.savePolicy(layer, rules); return null; } catch (err) { return err.errors?.[0]?.code || err.code; } };
const role = C.castRoleApprover;
const holdRule = (over = {}) => ({ id: 'h1', app: C.castApp, tool: C.castToolHold, attended: 'allow', unattended: 'deny', approval: { binding: 'call', windowMin: 15, approvers: 1, roles: [role], minAuthLevel: 2, channel: 'slack', ttlMin: 60 }, ...over });
test('policy: 30 rules in a layer are saved, 31 are refused', () => {
  const rules = (n) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, app: C.castApp, tool: C.castToolRead, requiresScope: `${C.castApp}:read` }));
  const e = newEngine(); assert.equal(save(e, 'actions', rules(30)), null); assert.equal(save(e, 'actions', rules(31)), 'too_many_rules');
});
test('policy: a required claim lists 10 values, not 11; a rule has 6 required claims, not 7', () => {
  const e = newEngine();
  const app = (oneOf, nclaims = 1) => [{ id: 'a1', identity: '*', app: C.castApp, requiredClaims: Array.from({ length: nclaims }, (_, i) => ({ claim: `c${i}`, oneOf })) }];
  const vals = (n) => Array.from({ length: n }, (_, i) => `v${i}`);
  assert.equal(save(e, 'apps', app(vals(10))), null); assert.equal(save(e, 'apps', app(vals(11))), 'bad_values');
  assert.equal(save(e, 'apps', app([], 6)), null); assert.equal(save(e, 'apps', app([], 7)), 'bad_claims');
});
test('policy: a value is 60 characters, not 61', () => {
  const e = newEngine();
  const app = (v) => [{ id: 'a1', identity: '*', app: C.castApp, requiredClaims: [{ claim: 'region', oneOf: [v] }] }];
  // lowercase words joined by hyphens, so the value is not mistaken for a key
  const words = (n) => `${'abc-'.repeat(Math.floor((n - 4) / 4))}${'abcd'}`.padEnd(n, 'e');
  assert.equal(words(60).length, 60); assert.equal(words(61).length, 61);
  assert.equal(save(e, 'apps', app(words(60))), null); assert.equal(save(e, 'apps', app(words(61))), 'bad_values');
});
test('policy: a users rule names 20 people, not 21', () => {
  const e = newEngine();
  const users = (n) => [{ id: 'u1', app: C.castApp, tool: C.castToolRead, users: Array.from({ length: n }, () => C.castUser) }];
  assert.equal(save(e, 'users', users(20)), null); assert.equal(save(e, 'users', users(21)), 'bad_users');
});
test('policy: an approval names 4 roles, not 5', () => {
  const e = newEngine();
  const roles = (n) => [holdRule({ approval: { binding: 'call', windowMin: 15, approvers: 1, roles: Array.from({ length: n }, () => role), minAuthLevel: 2, channel: 'slack', ttlMin: 60 } })];
  assert.equal(save(e, 'holds', roles(4)), null); assert.equal(save(e, 'holds', roles(5)), 'bad_roles');
});
test('policy: an "in" condition lists 10 strings, not 11', () => {
  const e = newEngine();
  const when = (n) => [holdRule({ when: { arg: 'record', op: 'in', value: Array.from({ length: n }, (_, i) => `rec-${i}`) } })];
  assert.equal(save(e, 'holds', when(10)), null); assert.equal(save(e, 'holds', when(11)), 'bad_value_type');
});
test('policy: a rule id is 40 characters, not 41', () => {
  const e = newEngine();
  const r = (id) => [{ id, app: C.castApp, tool: C.castToolRead, requiresScope: `${C.castApp}:read` }];
  const id = (n) => `${'abc-'.repeat(Math.floor((n - 4) / 4))}abcd`.padEnd(n, 'e');
  assert.equal(id(40).length, 40);
  assert.equal(save(e, 'actions', r(id(40))), null); assert.equal(save(e, 'actions', r(id(41))), 'bad_id');
});

// ---- behaviours ----
test('end-user scope: EVERY end-user rule on a tool must permit the person (one rule that does not is a denial)', () => {
  const e = newEngine();
  assert.equal(save(e, 'users', [
    { id: 'u1', app: C.castApp, tool: C.castToolWrite, users: [C.castUser, C.castUser2] },
    { id: 'u2', app: C.castApp, tool: C.castToolWrite, users: [C.castUser2] },
  ]), null);
  const call = (user) => e.evaluate({ route, tool: C.castToolWrite, arguments: { record: C.castRecord, amount: 5 }, token: tok(e, claims({ end_user: user })) });
  const denied = call(C.castUser);
  assert.equal(denied.outcome, 'deny'); assert.equal(denied.code, 'end_user_not_permitted'); assert.equal(denied.stage, 'end-user');
  assert.equal(call(C.castUser2).outcome, 'allow', 'permitted by both rules');
});
test('a pending request is re-used only for the SAME rule: a renamed rule on the same call opens a new request', () => {
  const e = newEngine();
  const first = e.evaluate(holdCall(e)); assert.equal(first.approval.ref, 'apr-0001');
  assert.equal(e.evaluate(holdCall(e)).approval.reused, true, 'same rule: re-used');
  const rules = structuredClone(e.policy.holds); rules[0].id = 'hold-1-renamed';
  assert.equal(save(e, 'holds', rules), null);
  const second = e.evaluate(holdCall(e));
  assert.equal(second.approval.reused, false); assert.equal(second.approval.ref, 'apr-0002'); assert.equal(e.approvals.length, 2); assert.equal(e.approvals[1].ruleId, 'hold-1-renamed');
});
test('the approval summary names at most 12 arguments', () => {
  const e = newEngine();
  const args = { record: C.castRecord, newValue: C.castNewValue, ...Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`extra${String(i).padStart(2, '0')}`, i])) };
  const d = e.evaluate(holdCall(e, { arguments: args }));
  assert.equal(d.outcome, 'hold');
  const names = e.approvals[0].summary.match(/arguments (.*); call hash/)[1].split(', ');
  assert.equal(names.length, 12); assert.deepEqual(names.slice(0, 3), ['record', 'newValue', 'extra00']);
  const few = newEngine(); few.evaluate(holdCall(few));
  assert.equal(few.approvals[0].summary.match(/arguments (.*); call hash/)[1].split(', ').length, 2);
});
test('a grant that has run out is expired at the exact instant (sweep marks it, the snapshot shows it)', () => {
  const e = newEngine(); e.evaluate(holdCall(e)); sign(e, 'apr-0001');
  e.advance({ minutes: 14 }); assert.equal(e.snapshot().approvals[0].status, 'approved');
  e.advance({ minutes: 1 }); assert.equal(e.snapshot().approvals[0].status, 'expired', 'the grant window is 15 minutes, inclusive at the end');
});
