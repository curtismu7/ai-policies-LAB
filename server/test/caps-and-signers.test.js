// S5: the audit cap is a real cap (a decision is refused whole before anything changes). N4: a signer can neither sign twice nor deny what they signed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { C, get, holdCall, newEngine, post, readCall, sign, tok, withServer, bigPay } from './helpers.js';
import { LIMITS } from '../src/engine.js';

const refusal = (fn) => { try { fn(); } catch (err) { return err.code; } return null; };

test('S5: the audit trail never passes 500 entries: 150 held calls and 349 reads fill it to 499, one decision is the 500th, the next decision is refused whole', () => {
  assert.equal(LIMITS.audit, 500); assert.equal(LIMITS.approvals, 200);
  const e = newEngine(); const token = tok(e);
  for (let i = 0; i < 150; i++) assert.equal(e.evaluate(holdCall(e, { token, arguments: { record: C.castRecord, newValue: `value-${i}` } })).outcome, 'hold');
  for (let i = 0; i < 349; i++) assert.equal(e.evaluate(readCall(e, { token })).outcome, 'allow');
  assert.equal(e.audit.length, 499); assert.equal(e.approvals.length, 150);
  assert.equal(sign(e, 'apr-0001').status, 'approved');
  assert.equal(e.audit.length, 500, 'the 500th entry is allowed');
  const before = JSON.stringify(e.snapshot());
  assert.equal(refusal(() => sign(e, 'apr-0002')), 'workspace_full');
  assert.equal(refusal(() => sign(e, 'apr-0003', C.castApprover, 2, 'deny')), 'workspace_full');
  assert.equal(JSON.stringify(e.snapshot()), before, 'a refused decision changed nothing');
  assert.equal(e.approvals[1].status, 'pending');
  assert.equal(refusal(() => e.evaluate(readCall(e, { token }))), 'workspace_full');
  assert.equal(e.audit.length, 500, 'never more than 500');
  for (let i = 3; i < 150; i++) assert.equal(refusal(() => sign(e, `apr-${String(i + 1).padStart(4, '0')}`)), 'workspace_full');
  assert.equal(e.audit.length, 500);
});
test('S5 over HTTP: the refused decision is a 409 workspace_full and the state keeps 500 audit entries', async () => {
  await withServer(async (url, { workspaces }) => {
    const e = workspaces.engine('default', 'finance', C);
    const token = tok(e);
    e.evaluate(holdCall(e, { token }));
    for (let i = 0; i < 498; i++) e.evaluate(readCall(e, { token }));
    assert.equal(e.audit.length, 499);
    const dec = (approver) => post(url, '/api/approvals/apr-0001/decision', { mode: 'live', vertical: 'finance', decision: { approver, decision: 'approve', authLevel: 3 } });
    assert.equal((await dec(C.castApprover)).status, 200);
    const r = await dec(C.castApprover2);
    assert.equal(r.status, 409); assert.equal((await r.json()).error, 'workspace_full');
    const st = await (await get(url, '/api/state?mode=live')).json();
    assert.equal(st.state.audit.length, 500); assert.equal(st.state.counts.audit, 500);
  });
});

test('N4: a signer cannot deny what they signed, and cannot sign twice; another approver still can deny, and a first-time denier is not blocked', () => {
  const e = newEngine();
  assert.equal(e.evaluate(bigPay(e)).outcome, 'hold');
  assert.equal(sign(e, 'apr-0001', C.castApprover, 3).status, 'pending');
  assert.equal(refusal(() => sign(e, 'apr-0001', C.castApprover, 3, 'deny')), 'duplicate_approver');
  assert.equal(refusal(() => sign(e, 'apr-0001', C.castApprover, 3, 'approve')), 'duplicate_approver');
  assert.equal(e.approvals[0].status, 'pending'); assert.equal(e.approvals[0].approvals.length, 1); assert.equal(e.approvals[0].decidedBy, null);
  assert.equal(e.audit.filter((a) => a.kind === 'approval').length, 1, 'the refused attempts wrote nothing');
  assert.equal(sign(e, 'apr-0001', C.castApprover2, 3, 'deny').status, 'denied', 'a different approver may still deny');
  const e2 = newEngine(); e2.evaluate(holdCall(e2));
  assert.equal(sign(e2, 'apr-0001', C.castApprover, 2, 'deny').status, 'denied', 'a person who has not signed can deny');
});
