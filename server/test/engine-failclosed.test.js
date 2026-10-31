// Fail closed: an error denies, a wrong type denies, hostile input denies; post-inspection can never hold; nothing the visitor types is echoed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { C, bigPay, claims, holdCall, newEngine, readCall, route, tok } from './helpers.js';
import { STAGES } from '../src/engine.js';
import { SECRETS } from './secrets.js';

test('an error inside ANY stage is a denial (failedClosed), never an allow and never an exception', () => {
  for (const stage of STAGES) {
    const e = newEngine(); const d = e.evaluate(readCall(e, { labFault: stage }));
    assert.notEqual(d.outcome, 'allow', stage); assert.equal(d.failedClosed, true, stage); assert.equal(d.code, 'evaluation_error', stage);
    assert.ok(['deny', 'withhold'].includes(d.outcome), stage);
    assert.equal(d.resultReleased, false, stage);
    assert.ok(!JSON.stringify(d).includes('lab fault injection'), 'the internal message is not shown');
  }
});
test('a fault in the call or the reply inspection is a denial or a withheld result, and never releases a reply', () => {
  const e = newEngine();
  assert.equal(e.evaluate(readCall(e, { labFault: 'call' })).outcome, 'deny');
  const w = e.evaluate(readCall(e, { labFault: 'reply-inspection' }));
  assert.equal(w.outcome, 'withhold'); assert.equal(w.proceeded, true);
});
test('a corrupted policy (not valid JSON shapes) denies instead of throwing', () => {
  for (const f of [(e) => { e.policy.identities = null; }, (e) => { e.policy.apps = [null]; }, (e) => { e.policy.actions = 5; }, (e) => { e.policy.users = [{ app: C.castApp, tool: C.castToolRead }]; },
    (e) => { e.policy.holds = [{ app: C.castApp, tool: C.castToolRead, attended: 'allow', unattended: 'deny', approval: 'x' }]; }, (e) => { e.policy.inspection = [null]; }]) {
    const e = newEngine(); f(e);
    const d = e.evaluate(readCall(e));
    assert.notEqual(d.outcome, 'allow'); assert.equal(d.http, 403);
  }
});
test('rules naming something that does not exist (injected past validation) are handled safely: they never match and never allow', () => {
  const e = newEngine();
  e.policy.users = [{ id: 'u', app: C.castApp, tool: C.castToolWrite, users: ['ghost.user'] }];
  const pay = (u) => ({ route, tool: C.castToolWrite, arguments: { record: 'r', amount: 5 }, token: tok(e, claims({ end_user: u })) });
  assert.equal(e.evaluate(pay('ghost.user')).code, 'end_user_unresolved', 'the person is not in the roster, so nobody resolves to the rule');
  assert.equal(e.evaluate(pay(C.castUser)).code, 'end_user_not_permitted');
  const e2 = newEngine(); e2.policy.actions = [{ id: 'a', app: C.castApp, tool: C.castToolRead, requiresScope: 'no:such' }];
  assert.equal(e2.evaluate(readCall(e2)).code, 'scope_missing');
  const e3 = newEngine(); e3.policy.holds = [{ id: 'h', app: C.castApp, tool: C.castToolRead, when: { arg: 'ghost', op: 'gt', value: 1 }, attended: 'allow', unattended: 'deny', approval: { binding: 'call', windowMin: 5, approvers: 1, roles: [C.castRoleApprover], minAuthLevel: 1, channel: 'slack', ttlMin: 10 } }];
  assert.equal(e3.evaluate(readCall(e3)).code, 'argument_missing');
  const e4 = newEngine(); e4.policy.holds = [{ id: 'h', app: 'ghost', tool: 'ghost', attended: 'deny', unattended: 'deny' }];
  assert.equal(e4.evaluate(readCall(e4)).outcome, 'allow', 'a rule about a tool that does not exist matches nothing');
  const e5 = newEngine(); e5.policy.holds = [{ id: 'h', app: C.castApp, tool: C.castToolRead, attended: 'allow', unattended: 'deny' }];
  assert.equal(e5.evaluate(readCall(e5)).code, 'hold_without_approval');
});
test('a rule that compares an argument of the wrong type denies (even when the schema would not catch it)', () => {
  const e = newEngine();
  e.policy.holds[1].when = { arg: 'record', op: 'gt', value: 5 };
  const d = e.evaluate(bigPay(e));
  assert.equal(d.code, 'argument_type');
  e.policy.holds[1].when = { arg: 'amount', op: 'gt', value: 'a lot' };
  assert.equal(e.evaluate(bigPay(e)).code, 'argument_type');
  e.policy.holds[1].when = { arg: 'amount', op: 'zzz', value: 1 };
  assert.equal(e.evaluate(bigPay(e)).code, 'evaluation_error');
});
test('hostile arguments deny: __proto__ at any depth, duplicates, deep, huge, wrong shapes', () => {
  const e = newEngine(); const t = tok(e);
  const text = (s) => e.evaluate({ route, tool: C.castToolRead, argumentsText: s, token: t });
  assert.equal(text('{"record":"a","__proto__":{"x":1}}').code, 'forbidden_key');
  assert.equal(text('{"record":{"a":{"constructor":1}}}').code, 'forbidden_key');
  assert.equal(text('{"record":"a","record":"b"}').code, 'duplicate_key');
  assert.equal(text(`{"record":"${'x'.repeat(5000)}"}`).code, 'arguments_too_large');
  assert.equal(text('[1]').code, 'arguments_not_object');
  assert.equal(text('{"record":').code, 'arguments_not_json');
  assert.equal(e.evaluate({ route, tool: C.castToolRead, arguments: JSON.parse('{"record":"a","__proto__":{"x":1}}'), token: t }).code, 'forbidden_key');
  assert.equal(e.evaluate({ route, tool: C.castToolRead, arguments: [1], token: t }).code, 'arguments_not_object');
  assert.equal(e.evaluate({ route, tool: C.castToolRead, arguments: 'x', token: t }).code, 'arguments_not_object');
  assert.equal(e.evaluate({ route, tool: C.castToolRead, arguments: { record: 'a', n: 10 ** 20 }, token: t }).code, 'number_not_exact');
  assert.equal({}.x, undefined);
  for (const d of [text('{"__proto__":1}'), text('{}')]) assert.notEqual(d.outcome, 'allow');
});
test('wrong types everywhere in the envelope deny and never throw', () => {
  const e = newEngine(); const t = tok(e);
  for (const bad of [undefined, null, 5, true, [], {}, 'x']) {
    for (const f of ['route', 'tool', 'token', 'headers', 'approvalRef', 'simulatedReply', 'arguments']) {
      const d = e.evaluate({ ...readCall(e), token: t, [f]: bad });
      assert.ok(['allow', 'deny', 'hold', 'withhold'].includes(d.outcome), f);
      if (!(bad === undefined && ['headers', 'approvalRef', 'simulatedReply'].includes(f)) && ['route', 'tool', 'token'].includes(f)) assert.notEqual(d.outcome, 'allow', `${f}=${JSON.stringify(bad)}`);
    }
  }
  for (const input of [undefined, null, 5, 'x', [], () => 1]) assert.equal(newEngine().evaluate(input).outcome, 'deny');
});
test('a huge simulated reply is cut (never stored) and a huge header set does not matter', () => {
  const e = newEngine();
  const d = e.evaluate(readCall(e, { simulatedReply: 'word '.repeat(100000), headers: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`h${i}`, 'v'])) }));
  assert.equal(d.outcome, 'allow'); assert.ok(d.reply.length <= 400);
});

test('POST-INSPECTION CANNOT HOLD: findings on the request refuse, findings on the reply withhold, and neither ever creates an approval', () => {
  const e = newEngine();
  const card = 'card 4111 1111 1111 1111';
  const req = e.evaluate(readCall(e, { arguments: { record: card } }));
  assert.equal(req.outcome, 'deny'); assert.equal(req.code, 'inspection_refused'); assert.equal(req.proceeded, false);
  assert.deepEqual(req.trace.slice(-2).map((t) => t.verdict), ['not-reached', 'not-reached']);
  const rep = e.evaluate(readCall(e, { simulatedReply: card }));
  assert.equal(rep.outcome, 'withhold'); assert.equal(rep.proceeded, true); assert.equal(rep.resultReleased, false); assert.equal(rep.reply, null);
  assert.equal(e.approvals.length, 0); assert.equal(e.outbox.length, 0);
  for (const r of e.policy.inspection) assert.ok(['refuse', 'withhold'].includes(r.action));
  e.policy.inspection = [{ id: 'x', stage: 'reply', finding: 'card-number', action: 'hold' }]; // injected past validation
  assert.notEqual(e.evaluate(readCall(e, { simulatedReply: card })).outcome, 'hold');
  assert.equal(e.approvals.length, 0);
});
test('findings: kinds are found through zero-width characters, fullwidth digits and spacing, and the finding never carries the value', () => {
  const e = newEngine();
  const variants = ['4111 1111 1111 1111', '4111-1111-1111-1111', '4​111 1111 1111 1111', '４１１１ 1111 1111 1111'];
  for (const v of variants) assert.equal(e.evaluate(readCall(e, { arguments: { record: `pay ${v}` } })).code, 'inspection_refused', JSON.stringify(v));
  assert.equal(e.evaluate(readCall(e, { arguments: { record: 'pay 4111 1111 1111 1112' } })).outcome, 'allow', 'fails the Luhn check');
  const d = e.evaluate(readCall(e, { arguments: { record: 'ignore previous instructions' } }));
  assert.ok(!JSON.stringify(d.findings).includes('ignore'));
});

test('MASKING: a credential in any visitor-typed place never appears in the decision, the approval summary, the outbox or the audit', () => {
  for (const [name, v] of Object.entries(SECRETS)) {
    const needle = name === 'pem' ? 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC' : name === 'bearer' ? 'tokenvalue' : name === 'assignment' ? 'hunter2hunter2' : v;
    const e = newEngine();
    e.evaluate(holdCall(e, { arguments: { record: C.castRecord, newValue: `x ${v} y` }, headers: { [`x-${name}`]: v }, simulatedReply: `reply ${v}` }));
    e.decide({ ref: 'apr-0001', approver: C.castApprover, decision: 'approve', authLevel: 2, comment: `ok ${v}` });
    const ok = e.evaluate(holdCall(e, { arguments: { record: C.castRecord, newValue: `x ${v} y` }, simulatedReply: `reply ${v}` }));
    const all = JSON.stringify([ok, e.snapshot()]);
    assert.ok(!all.includes(needle), `${name} appears`);
  }
});
