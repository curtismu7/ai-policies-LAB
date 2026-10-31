// The four layers, their order, and where each reads from.
import test from 'node:test';
import assert from 'node:assert/strict';
import { C, bigPay, claims, holdCall, newEngine, readCall, route, tok } from './helpers.js';

const stagesOf = (d) => d.trace.map((t) => `${t.stage}:${t.verdict}`).join(' ');

test('a call that passes every layer is allowed, with the trace in order', () => {
  const e = newEngine(); const d = e.evaluate(readCall(e));
  assert.equal(d.outcome, 'allow'); assert.equal(d.http, 200); assert.equal(d.proceeded, true); assert.equal(d.resultReleased, true);
  assert.deepEqual(d.trace.map((t) => t.stage), ['request', 'token', 'surface', 'application', 'action', 'end-user', 'attended-unattended', 'request-inspection', 'call', 'reply-inspection']);
  assert.ok(d.trace.every((t) => t.verdict === 'pass'));
  assert.match(d.callHash, /^[0-9a-f]{64}$/);
});

test('SURFACE: derived from the route, refused before any policy is consulted; the identity caps the key', () => {
  const e = newEngine();
  const call = { route: `/llm/${C.castModelApp}`, tool: 'chat', arguments: { prompt: 'hi' }, token: tok(e, claims({ sub: C.castAgent2, surfaces: ['tool', 'model'], scope: 'model:invoke' })) };
  const d = e.evaluate(call);
  assert.equal(d.code, 'surface_not_allowed'); assert.equal(d.stage, 'surface'); assert.equal(d.http, 403);
  assert.match(d.trace[2].reason, /key can never exceed its identity/);
  assert.deepEqual(d.trace[2].detail.effective, ['tool']);
  assert.equal(stagesOf(d), 'request:pass token:pass surface:deny application:not-reached action:not-reached end-user:not-reached attended-unattended:not-reached request-inspection:not-reached call:not-reached reply-inspection:not-reached');
});
test('SURFACE: it comes before the application policy: a call that would also fail the application is stopped at the surface', () => {
  const e = newEngine();
  const d = e.evaluate({ route: `/llm/${C.castModelApp}`, tool: 'chat', arguments: { prompt: 'x' }, token: tok(e, claims({ sub: C.castAgent3, surfaces: ['tool'], scope: '' })) });
  assert.equal(d.stage, 'surface');
  assert.equal(d.trace.find((t) => t.stage === 'application').verdict, 'not-reached');
});
test('SURFACE: the key is a cap too (an identity that holds the surface is not enough)', () => {
  const e = newEngine();
  const d = e.evaluate(readCall(e, { token: tok(e, claims({ surfaces: ['model'] })) }));
  assert.equal(d.code, 'surface_not_allowed'); assert.match(d.trace[2].reason, /does not carry this surface/);
});
test('SURFACE: the surface is the route, not a claim of the caller (a header or an argument saying "model" changes nothing)', () => {
  const e = newEngine();
  const d = e.evaluate(readCall(e, { headers: { 'x-surface': 'tool' }, token: tok(e, claims({ sub: C.castAgent3, surfaces: ['model'] })) }));
  assert.equal(d.code, 'surface_not_allowed');
  for (const r of ['/x/payments', '/mcp/', '/mcp/UPPER', '/mcp/a/b', 'mcp/payments', '', null, 5, '/llm/../mcp/payments', `/mcp/${'a'.repeat(60)}`]) assert.equal(e.evaluate(readCall(e, { route: r })).code, 'route_unknown', String(r));
});
test('SURFACE: an unknown identity, and a surfaces claim of the wrong type, are denials', () => {
  const e = newEngine();
  assert.equal(e.evaluate(readCall(e, { token: tok(e, claims({ sub: 'nobody' })) })).code, 'identity_unknown');
  assert.equal(e.evaluate(readCall(e, { token: tok(e, claims({ sub: C.castUser })) })).code, 'identity_unknown', 'a person is not a key owner');
  for (const bad of ['tool', 5, ['tool', 7], ['tools'], true]) assert.equal(e.evaluate(readCall(e, { token: tok(e, claims({ surfaces: bad })) })).code, 'claim_type', JSON.stringify(bad));
});

test('APPLICATION: no policy for this identity and application is a denial', () => {
  const e = newEngine();
  const d = e.evaluate(readCall(e, { token: tok(e, claims({ sub: C.castAgent2, surfaces: ['tool'] })) }));
  assert.equal(d.code, 'no_application_policy'); assert.equal(d.stage, 'application');
});
test('APPLICATION: required claims must be carried by the token, with an allowed value', () => {
  const e = newEngine(); const cl = claims(); delete cl.department;
  const d = e.evaluate(readCall(e, { token: tok(e, cl) }));
  assert.equal(d.code, 'required_claims_missing'); assert.deepEqual(d.trace[3].detail.missing, ['department']);
  assert.equal(e.evaluate(readCall(e, { token: tok(e, claims({ department: 'someone-else' })) })).code, 'required_claims_missing');
  assert.equal(e.evaluate(readCall(e, { token: tok(e, claims({ department: [C.castDept, 'other'] })) })).outcome, 'allow', 'a list claim matches when one item does');
  assert.equal(e.evaluate(readCall(e, { token: tok(e, claims({ department: [] })) })).code, 'claim_type');
});
test('APPLICATION: a route to an application on another surface is refused', () => {
  const e = newEngine();
  assert.equal(e.evaluate({ route: `/llm/${C.castApp}`, tool: C.castToolRead, arguments: { record: 'x' }, token: tok(e) }).code, 'app_unknown');
  assert.equal(e.evaluate({ route: '/mcp/ghost', tool: C.castToolRead, arguments: {}, token: tok(e) }).code, 'app_unknown');
});

test('ACTION: the scope is read from the VERIFIED TOKEN; a header, an argument or a body field that claims it is ignored', () => {
  const e = newEngine();
  const call = { route, tool: C.castToolWrite, arguments: { record: 'r', amount: 5, scope: `${C.castApp}:admin`, end_user: C.castSecurity }, headers: { 'x-scopes': `${C.castApp}:write`, 'x-end-user': C.castUser }, token: tok(e, claims({ scope: `${C.castApp}:read` })) };
  const d = e.evaluate(call);
  assert.equal(d.code, 'scope_missing'); assert.deepEqual(d.trace[4].detail.lacking, [`${C.castApp}:write`]);
  assert.deepEqual(d.ignoredHints.map((h) => `${h.where}:${h.matched}`).sort(), ['argument:scope', 'argument:user', 'header:scope', 'header:user']);
  const ok = e.evaluate({ ...call, token: tok(e, claims()) });
  assert.equal(ok.outcome, 'allow', 'with the scope in the token it passes, whatever the caller supplies');
});
test('ACTION: the scope claim is a space-separated string; any other type is a denial; a missing claim has no scope', () => {
  const e = newEngine();
  for (const bad of [[`${C.castApp}:read`], 7, true]) assert.equal(e.evaluate(readCall(e, { token: tok(e, claims({ scope: bad })) })).code, 'claim_type');
  const cl = claims(); delete cl.scope; assert.equal(e.evaluate(readCall(e, { token: tok(e, cl) })).code, 'claim_type');
  assert.equal(e.evaluate(readCall(e, { token: tok(e, claims({ scope: `  ${C.castApp}:read   x ` })) })).outcome, 'allow');
  assert.equal(e.evaluate(readCall(e, { token: tok(e, claims({ scope: `${C.castApp}:readx` })) })).code, 'scope_missing', 'whole scopes only');
});
test('ACTION: an unknown tool is a denial; a missing or wrong-typed declared argument is a denial', () => {
  const e = newEngine();
  assert.equal(e.evaluate(readCall(e, { tool: 'nope' })).code, 'tool_unknown');
  assert.equal(e.evaluate(readCall(e, { tool: 5 })).code, 'tool_missing');
  assert.equal(e.evaluate(readCall(e, { arguments: {} })).code, 'argument_missing');
  assert.equal(e.evaluate(readCall(e, { arguments: { record: 5 } })).code, 'argument_type');
  assert.equal(e.evaluate(bigPay(e, '50')).code, 'argument_type');
});

test('END USER: a person who cannot be identified is denied when a rule needs one; with no rule the service identity decides', () => {
  const e = newEngine();
  const pay = (cl) => ({ route, tool: C.castToolWrite, arguments: { record: 'r', amount: 5 }, token: tok(e, claims(cl)) });
  assert.equal(e.evaluate(pay({ end_user: 'ghost.user' })).code, 'end_user_unresolved');
  const cl = claims(); delete cl.end_user; assert.equal(e.evaluate(pay2(e, cl)).code, 'end_user_unresolved');
  function pay2(en, c2) { return { route, tool: C.castToolWrite, arguments: { record: 'r', amount: 5 }, token: tok(en, c2) }; }
  assert.equal(e.evaluate(pay({ end_user: C.castAgent })).code, 'end_user_unresolved', 'an agent is not a user');
  assert.equal(e.evaluate(pay({ end_user: C.castSecurity })).code, 'end_user_not_permitted');
  assert.equal(e.evaluate(pay({ end_user: 7 })).code, 'claim_type');
  assert.equal(e.evaluate(readCall(e, { token: tok(e, claims({ end_user: 'ghost.user' })) })).outcome, 'allow', 'no end-user rule on the read tool');
  assert.equal(e.evaluate(pay({})).outcome, 'allow');
});
test('END USER: it is read from the token, not from anything the caller supplies', () => {
  const e = newEngine();
  const d = e.evaluate({ route, tool: C.castToolWrite, arguments: { record: 'r', amount: 5, end_user: C.castUser }, headers: { 'x-end-user': C.castUser }, token: tok(e, claims({ end_user: C.castSecurity })) });
  assert.equal(d.code, 'end_user_not_permitted');
});

test('the layers run in order and each denial names its own stage', () => {
  const e = newEngine();
  const order = [
    [claims({ sub: C.castAgent2, surfaces: ['tool', 'model'] }), { route: `/llm/${C.castModelApp}`, tool: 'chat', arguments: { prompt: 'x' } }, 'surface'],
    [claims({ sub: C.castAgent2, surfaces: ['tool'] }), {}, 'application'],
    [claims({ scope: 'none' }), {}, 'action'],
    [claims({ end_user: 'ghost.user', scope: `${C.castApp}:write` }), { tool: C.castToolWrite, arguments: { record: 'r', amount: 1 } }, 'end-user'],
  ];
  for (const [cl, over, stage] of order) assert.equal(e.evaluate({ ...readCall(e), ...over, token: tok(e, cl) }).stage, stage);
});

test('token failures are 401 and stop everything: nothing after the token is consulted', () => {
  const e = newEngine();
  for (const token of [undefined, '', 'x.y.z', `${tok(e)}x`]) { const d = e.evaluate(readCall(e, { token })); assert.equal(d.http, 401); assert.equal(d.stage, 'token'); assert.equal(d.trace[2].verdict, 'not-reached'); }
  const short = tok(e, claims(), 5); e.advance({ minutes: 5 });
  assert.equal(e.evaluate(readCall(e, { token: short })).code, 'token_expired');
  assert.equal(e.evaluate(readCall(e)).http, 200);
});
test('the answer never names a thing the lab does not know (a typed route, tool or identity is not echoed)', () => {
  const e = newEngine(); const needle = 'zzz-marker-9';
  const strip = (x) => ({ ...x, tokenSummary: undefined }); // the token summary shows the visitor's own claims (masked by the response mask)
  const calls = [readCall(e, { route: `/mcp/${needle}` }), readCall(e, { tool: needle }), readCall(e, { token: tok(e, claims({ sub: needle })) }),
    { route, tool: C.castToolWrite, arguments: { record: 'r', amount: 1 }, token: tok(e, claims({ end_user: needle })) }];
  const d = JSON.stringify(calls.map((c) => strip(e.evaluate(c))));
  assert.ok(!d.includes(needle));
});
