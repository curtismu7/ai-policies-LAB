import test from 'node:test';
import assert from 'node:assert/strict';
import { VERTICALS } from '../src/cast.js';
import { EXPECTED, buildMockTable, canonicalExamples, runScenario, scenarioList } from '../src/scenarios.js';
import { MOCK_TABLE } from '../src/mockTable.js';
import { mockState } from '../src/service.js';
import { findCredentials } from '../src/credentials.js';
import { scanHosts } from '../src/safety.js';

test('every scripted step gives the result the story says it does, in every vertical', () => {
  for (const [v, cast] of Object.entries(VERTICALS)) for (const sc of scenarioList(cast)) {
    const { steps } = runScenario(cast, sc);
    assert.deepEqual(steps.map((s) => s.got), EXPECTED[sc.id], `${v}/${sc.id}`);
  }
  assert.equal(Object.keys(EXPECTED).length, 6);
});
test('Mock parity: the committed Mock table is exactly what the engine generates (a drift test)', () => {
  assert.deepEqual(MOCK_TABLE, buildMockTable());
});
test('the Mock table keeps no token string and no signature, and the claims are the minted ones', () => {
  const t = JSON.stringify(MOCK_TABLE);
  assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\./.test(t)); assert.ok(!t.includes('labToken'));
  const s = mockState(MOCK_TABLE, 'finance', 'four-layers').scenario.steps[3];
  assert.equal(s.claims.scope, 'payments:read'); assert.equal(s.got, 'deny:scope_missing');
});
test('the story is in the table: hold, signed, retry proceeds, replay refused, changed arguments need a new approval', () => {
  const sc = mockState(MOCK_TABLE, 'finance', 'hold-and-retry');
  const got = sc.scenario.steps.map((s) => s.got);
  assert.deepEqual(got, ['hold:hold_for_approval', 'hold:hold_for_approval', 'refused:self_approval', 'refused:role_missing', 'refused:auth_too_weak', 'ok:approved', 'hold:hold_for_approval', 'allow:allowed', 'deny:approval_consumed']);
  assert.equal(sc.scenario.steps[0].result.approval.ref, sc.scenario.steps[1].result.approval.ref);
  assert.notEqual(sc.scenario.steps[0].result.callHash, sc.scenario.steps[6].result.callHash);
  assert.equal(sc.scenario.steps[0].result.callHash, sc.scenario.steps[7].result.callHash, 'key order and spacing do not change the hash');
  assert.equal(sc.state.approvals[0].status, 'consumed');
});
test('the hard denial scenario: an approval is offered and still refused', () => {
  const sc = mockState(MOCK_TABLE, 'finance', 'hard-denial').scenario.steps;
  assert.deepEqual(sc.map((s) => s.got), ['deny:attended_refused', 'hold:hold_for_approval', 'ok:approved', 'deny:attended_refused']);
  assert.equal(sc[3].result.noApprovalPath, true);
});
test('the canonical examples: four spellings, one hash; a different value, another hash; refused inputs say why', () => {
  const ex = canonicalExamples(VERTICALS.finance);
  assert.equal(ex[0].hash, ex[1].hash); assert.equal(ex[0].hash, ex[2].hash); assert.notEqual(ex[0].hash, ex[3].hash); assert.notEqual(ex[0].hash, ex[4].hash);
  assert.equal(ex[5].code, 'duplicate_key'); assert.equal(ex[6].hash, ex[7].hash); assert.equal(ex[6].hash, ex[8].hash); assert.notEqual(ex[6].hash, ex[9].hash); assert.equal(ex[10].code, 'number_not_exact');
});
test('the Mock table carries no credential-shaped text and no real host', () => {
  const t = JSON.stringify(MOCK_TABLE).replace(/"(hash|callHash)":"[0-9a-f]{64}"/g, '').replace(/"bound":\{"kind":"call","callHash":"[0-9a-f]{64}"/g, '');
  assert.deepEqual(findCredentials(t), []); assert.deepEqual(scanHosts(t), []);
});
