import test from 'node:test';
import assert from 'node:assert/strict';
import { C, get, json, post, put, rawHttp, withServer } from './helpers.js';
import { installNetguard } from '../src/netguard.js';

const guard = installNetguard();
const W = (id) => ({ 'x-workspace': id });
const live = (extra = {}) => ({ mode: 'live', vertical: 'finance', ...extra });
const mint = async (url, claims, ws = 'default', ttlMin) => (await json(await post(url, '/api/token', live({ token: { claims, ttlMin } }), W(ws)))).result.labToken;
const cl = (o = {}) => ({ sub: C.castAgent, surfaces: ['tool', 'model', 'agent'], scope: `${C.castApp}:read ${C.castApp}:write`, department: C.castDept, end_user: C.castUser, ...o });
const evalReq = (url, request, ws = 'default') => post(url, '/api/evaluate', live({ request }), W(ws));
const holdReq = (token, o = {}) => ({ route: `/mcp/${C.castApp}`, tool: C.castToolHold, arguments: { record: C.castRecord, newValue: C.castNewValue }, token, ...o });

test('health, info, story, jwks answer; the story fills every token for every vertical', async () => {
  await withServer(async (url) => {
    const h = await json(await get(url, '/api/health'));
    assert.equal(h.schema, 'demo-health/1'); assert.equal(h.demo.id, 'ai-policies-lab');
    const info = await json(await get(url, '/api/info'));
    assert.deepEqual([info.simulated, info.unverified, info.release], [true, true, '2026-11-02']);
    for (const v of ['finance', 'health', 'retail']) { const s = await json(await get(url, `/api/story?vertical=${v}`)); assert.ok(!/\{\{/.test(JSON.stringify(s)), v); assert.equal(s.vertical, v); assert.equal(s.scenarios.length, 6); }
    assert.equal((await json(await get(url, '/api/story?vertical=__proto__'))).vertical, 'finance');
    const k = (await json(await get(url, '/api/jwks'))).jwks.keys[0]; assert.equal(k.alg, 'RS256'); assert.equal(k.d, undefined);
    assert.equal((await get(url, '/api/diagram?name=where-it-runs')).status, 200);
    assert.equal((await json(await get(url, '/api/diagram?name=nope'))).name, 'layers-and-hold');
  });
});
test('the state: Mock gives a generated scenario, Live gives the workspace engine, both the same shape', async () => {
  await withServer(async (url) => {
    const m = await json(await get(url, '/api/state?mode=mock&vertical=finance&scenario=hold-and-retry'));
    const l = await json(await get(url, '/api/state?mode=live&vertical=finance'));
    assert.equal(m.scenario.id, 'hold-and-retry'); assert.equal(m.scenarios.length, 6); assert.equal(m.canonicalExamples.length, 11);
    assert.deepEqual(Object.keys(m.state).sort(), Object.keys(l.state).sort(), 'one shape for both');
    assert.equal(l.state.approvals.length, 0);
    assert.equal((await json(await get(url, '/api/state?mode=mock&scenario=nope'))).scenario.id, 'four-layers');
    assert.equal((await get(url, '/api/state?mode=prod')).status, 400); assert.equal((await get(url, '/api/state')).status, 400);
    assert.equal((await get(url, '/api/state?mode=live', W('Bad Id'))).status, 400);
  });
});
test('Mock is read-only: every write is refused with 409 and changes nothing', async () => {
  await withServer(async (url) => {
    const body = { mode: 'mock', vertical: 'finance' };
    const calls = [post(url, '/api/evaluate', { ...body, request: {} }), post(url, '/api/token', { ...body, token: {} }), post(url, '/api/approvals/apr-0001/decision', { ...body, decision: {} }), post(url, '/api/clock', { ...body, clock: { minutes: 5 } }), put(url, '/api/policies/users', { ...body, rules: [] }), post(url, '/api/policies/users/reset', body)];
    for (const r of await Promise.all(calls)) { assert.equal(r.status, 409); assert.equal((await r.json()).error, 'mock_is_read_only'); }
    assert.equal((await json(await get(url, '/api/state?mode=live'))).state.audit.length, 0);
  });
});
test('writes need a mode, an object body and only known top-level keys', async () => {
  await withServer(async (url) => {
    assert.equal((await post(url, '/api/clock', { vertical: 'finance', clock: { minutes: 1 } })).status, 400);
    assert.equal((await post(url, '/api/clock', { mode: 'prod', clock: { minutes: 1 } })).status, 400);
    assert.equal((await post(url, '/api/clock', [1])).status, 400);
    assert.equal((await post(url, '/api/clock', live({ clock: { minutes: 1 }, token: 'x' }))).status, 400);
    assert.equal((await post(url, '/api/clock', live({ clock: { minutes: 1, extra: 1 } }))).status, 400);
    assert.equal((await post(url, '/api/clock', live({ clock: { minutes: 1 } }))).status, 200);
    assert.equal((await post(url, '/api/clock', live({ clock: 5 }))).status, 400);
  });
});
test('honest status codes: allow 200, a bad token 401, deny 403, hold 403 with the reference, a withheld result 403; the body says which', async () => {
  await withServer(async (url) => {
    const t = await mint(url, cl());
    const ok = evalReq(url, { route: `/mcp/${C.castApp}`, tool: C.castToolRead, arguments: { record: 'r' }, token: t });
    const r1 = await ok; const b1 = await r1.json(); assert.equal(r1.status, 200); assert.equal(b1.ok, true); assert.equal(b1.result.outcome, 'allow');
    const r2 = await evalReq(url, { route: `/mcp/${C.castApp}`, tool: C.castToolRead, arguments: { record: 'r' }, token: `${t}x` }); assert.equal(r2.status, 401); assert.equal((await r2.json()).result.code, 'token_signature');
    const r3 = await evalReq(url, { route: `/mcp/${C.castApp}`, tool: C.castToolWrite, arguments: { record: 'r', amount: '5' }, token: t }); assert.equal(r3.status, 403); assert.equal((await r3.json()).result.code, 'argument_type');
    const r4 = await evalReq(url, holdReq(t)); const b4 = await r4.json(); assert.equal(r4.status, 403); assert.equal(b4.result.outcome, 'hold'); assert.equal(b4.result.approval.ref, 'apr-0001'); assert.ok(b4.result.approval.expiresAt);
    const r5 = await evalReq(url, { route: `/mcp/${C.castApp}`, tool: C.castToolRead, arguments: { record: 'r' }, token: t, simulatedReply: 'card 4111 1111 1111 1111' }); assert.equal(r5.status, 403); assert.equal((await r5.json()).result.outcome, 'withhold');
    assert.equal((await evalReq(url, { route: 1, bogus: 1 })).status, 400);
    assert.equal((await evalReq(url, { route: '/mcp/x', arguments: {}, argumentsText: '{}' })).status, 400);
    assert.equal((await evalReq(url, { labFault: 'nope' })).status, 400);
  });
});
test('the full cycle over HTTP: mint, hold, a wrong approver, a right one, retry, replay refused, hops carry traceparent', async () => {
  await withServer(async (url) => {
    const t = await mint(url, cl());
    const first = await json(await evalReq(url, holdReq(t)));
    assert.match(first.hops[0].request.headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    assert.ok(first.hops.every((h) => /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/.test(h.request.headers.traceparent)));
    assert.ok(first.hops.some((h) => /outbox/.test(h.label)) && first.hops.some((h) => /token check/.test(h.label)));
    assert.equal(first.hops[0].request.body.token, '[masked:assignment]', 'the token is masked in the hop pane (its key is a credential word)');
    const dec = (approver, authLevel = 2, decision = 'approve') => post(url, '/api/approvals/apr-0001/decision', live({ decision: { approver, decision, authLevel } }));
    const self = await dec(C.castUser); assert.equal(self.status, 403); assert.equal((await self.json()).error, 'self_approval');
    assert.equal((await dec(C.castSecurity, 3)).status, 403);
    assert.equal((await (await dec(C.castApprover, 1)).json()).error, 'auth_too_weak');
    const good = await dec(C.castApprover); assert.equal(good.status, 200);
    const retry = await evalReq(url, holdReq(t)); assert.equal(retry.status, 200);
    const replay = await evalReq(url, holdReq(t, { approvalRef: 'apr-0001' })); assert.equal(replay.status, 403); assert.equal((await replay.json()).result.code, 'approval_consumed');
    assert.equal((await post(url, '/api/approvals/apr-0099/decision', live({ decision: { approver: C.castApprover } }))).status, 404);
    assert.equal((await dec(C.castApprover2)).status, 409);
    const st = (await json(await get(url, '/api/state?mode=live'))).state; assert.equal(st.approvals[0].status, 'consumed'); assert.ok(st.audit.length >= 4);
  });
});
test('mint: a token carries the lab clock, claims are validated, credential-shaped values are refused; the answer says it is mock-issued', async () => {
  await withServer(async (url) => {
    const r = await json(await post(url, '/api/token', live({ token: { claims: cl(), ttlMin: 5 } })));
    assert.match(r.result.label, /mock-issued/); assert.equal(r.result.claims.exp - r.result.claims.iat, 300); assert.equal(r.result.header.alg, 'RS256');
    assert.match(r.result.labToken, /^[\w-]+\.[\w-]+\.[\w-]+$/);
    const bad = async (t) => (await post(url, '/api/token', live({ token: t }))).status;
    assert.equal(await bad({ claims: { exp: 1 } }), 400); assert.equal(await bad({ claims: { sub: { a: 1 } } }), 400); assert.equal(await bad({ claims: { Bad: 1 } }), 400);
    assert.equal(await bad({ claims: cl(), ttlMin: 0 }), 400); assert.equal(await bad({ claims: cl(), ttlMin: 1441 }), 400); assert.equal(await bad({ claims: { sub: ['gh', 'p_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('') } }), 400); assert.equal(await bad({}), 400);
    assert.equal(await bad({ claims: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`c${i}`, 1])) }), 400);
  });
});
test('policies over HTTP: a good save, a refusal on save with the reasons (422), reset', async () => {
  await withServer(async (url) => {
    const state = async () => (await json(await get(url, '/api/state?mode=live'))).state;
    const rules = (await state()).policy.users; rules[0].users.push('ghost.user');
    const r = await put(url, '/api/policies/users', live({ rules })); const b = await r.json();
    assert.equal(r.status, 422); assert.equal(b.error, 'policy_refused'); assert.equal(b.errors[0].code, 'unknown_user'); assert.ok(!JSON.stringify(b.errors).includes('ghost'), 'the reasons never repeat what was typed');
    assert.ok(!(await state()).policy.users[0].users.includes('ghost.user'));
    rules[0].users.pop(); rules[0].users = [C.castSecurity];
    assert.equal((await put(url, '/api/policies/users', live({ rules }))).status, 200);
    assert.deepEqual((await state()).policy.users[0].users, [C.castSecurity]);
    assert.equal((await post(url, '/api/policies/users/reset', live({}))).status, 200);
    assert.notDeepEqual((await state()).policy.users[0].users, [C.castSecurity]);
    assert.equal((await put(url, '/api/policies/nope', live({ rules: [] }))).status, 422);
    assert.equal((await put(url, '/api/policies/users', live({ rules: 'x' }))).status, 422);
  });
});
test('canonicalize: a pure computation that works in both modes and agrees with the evaluation hash', async () => {
  await withServer(async (url) => {
    const a = await json(await post(url, '/api/canonicalize', { mode: 'mock', argumentsText: `{"record":"${C.castRecord}","newValue":"${C.castNewValue}"}` }));
    const b = await json(await post(url, '/api/canonicalize', { mode: 'live', arguments: { newValue: C.castNewValue, record: C.castRecord } }));
    assert.equal(a.hash, b.hash); assert.match(a.target, /^tool:payments\/change_payee$/);
    const t = await mint(url, cl()); const ev = await json(await evalReq(url, holdReq(t)));
    assert.equal(ev.result.callHash, a.hash, 'the same hash the evaluation binds an approval to');
    assert.equal((await post(url, '/api/canonicalize', { argumentsText: '{"a":1,"a":2}' })).status, 422);
    assert.equal((await post(url, '/api/canonicalize', { argumentsText: '{}', route: 'x' })).status, 422);
    assert.equal((await post(url, '/api/canonicalize', { argumentsText: '{}', extra: 1 })).status, 400);
  });
});
test('X-Workspace isolates state, Reset clears one workspace only', async () => {
  await withServer(async (url) => {
    await post(url, '/api/clock', live({ clock: { minutes: 30 } }), W('a'));
    assert.equal((await json(await get(url, '/api/state?mode=live', W('a')))).state.clock.minutesSinceStart, 30);
    assert.equal((await json(await get(url, '/api/state?mode=live', W('b')))).state.clock.minutesSinceStart, 0);
    await post(url, '/api/clock', live({ clock: { minutes: 5 } }), W('b'));
    assert.equal((await post(url, '/api/reset', {}, W('a'))).status, 200);
    assert.equal((await json(await get(url, '/api/state?mode=live', W('a')))).state.clock.minutesSinceStart, 0);
    assert.equal((await json(await get(url, '/api/state?mode=live', W('b')))).state.clock.minutesSinceStart, 5);
  });
});
test('CONCURRENCY: parallel identical evaluations open exactly one request, parallel approvals count once, parallel retries spend the grant once', async () => {
  await withServer(async (url) => {
    const t = await mint(url, cl());
    const holds = await Promise.all(Array.from({ length: 12 }, () => evalReq(url, holdReq(t))));
    assert.deepEqual([...new Set((await Promise.all(holds.map((r) => r.json()))).map((b) => b.result.approval.ref))], ['apr-0001']);
    const dec = () => post(url, '/api/approvals/apr-0001/decision', live({ decision: { approver: C.castApprover, decision: 'approve', authLevel: 2 } }));
    const decs = await Promise.all(Array.from({ length: 8 }, dec));
    assert.equal(decs.filter((r) => r.status === 200).length, 1); assert.ok(decs.filter((r) => r.status !== 200).every((r) => r.status === 409));
    const tries = await Promise.all(Array.from({ length: 10 }, () => evalReq(url, holdReq(t))));
    const bodies = await Promise.all(tries.map((r) => r.json()));
    assert.equal(bodies.filter((b) => b.result.outcome === 'allow').length, 1, 'a single-use grant is spent once');
    assert.equal((await json(await get(url, '/api/state?mode=live'))).state.approvals.filter((a) => a.status === 'pending').length, 1, 'the losers opened one new request between them');
  });
});
test('the final 404 and the error handler answer fixed JSON; a malformed or oversized body is a 4xx without a stack', async () => {
  await withServer(async (url) => {
    const host = new URL(url).host;
    assert.deepEqual(await json(await get(url, '/api/nope')), { error: 'not_found' });
    const bad = await rawHttp(`${url}/api/clock`, { method: 'POST', headers: { host, origin: url, 'content-type': 'application/json' }, body: '{not json' });
    assert.equal(bad.status, 400); assert.ok(!/SyntaxError|at /.test(bad.text));
    const big = await rawHttp(`${url}/api/clock`, { method: 'POST', headers: { host, origin: url, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'live', pad: 'x'.repeat(40000) }) });
    assert.equal(big.status, 413);
    assert.equal((await rawHttp(`${url}/api/health`, { method: 'POST', headers: { host, origin: url } })).status, 405);
  });
});
test('Host and same-origin checks hold on the real server', async () => {
  await withServer(async (url) => {
    assert.equal((await rawHttp(`${url}/api/health`, { headers: { host: 'evil.example.invalid' } })).status, 403);
    assert.equal((await post(url, '/api/clock', live({ clock: { minutes: 1 } }), { origin: 'http://evil.example.invalid' })).status, 403);
    assert.equal((await post(url, '/api/clock', live({ clock: { minutes: 1 } }), { 'sec-fetch-site': 'cross-site' })).status, 403);
  });
});
test('ZERO outbound: the netguard recorded no attempt across all of the above', () => { assert.deepEqual(guard.attempts, []); });

test('WORKSPACE CAP: a flood of new ids is refused (503, fixed JSON) and never evicts anyone; existing workspaces keep working; Reset frees a slot', async () => {
  const { createWorkspaces } = await import('../src/workspaces.js');
  await withServer(async (url, { workspaces }) => {
    const t = await mint(url, cl(), 'cap-0');
    assert.equal((await evalReq(url, holdReq(t), 'cap-0')).status, 403);
    const flood = await Promise.all(Array.from({ length: 24 }, (_, i) => post(url, '/api/clock', live({ clock: { minutes: 1 } }), W(`flood-${i}`))));
    const codes = flood.map((r) => r.status);
    assert.equal(codes.filter((c) => c === 200).length, 3, 'only the free slots were given out');
    assert.equal(codes.filter((c) => c === 503).length, 21);
    const refused = await flood.find((r) => r.status === 503).json();
    assert.equal(refused.error, 'workspaces_full'); assert.match(refused.detail, /maximum of 4 workspaces/);
    assert.equal(workspaces.size(), 4);
    const st = (await json(await get(url, '/api/state?mode=live', W('cap-0')))).state;
    assert.equal(st.approvals.length, 1, 'the first visitor\'s state was not wiped by the flood');
    assert.equal((await post(url, '/api/clock', live({ clock: { minutes: 1 } }), W('cap-0'))).status, 200, 'an existing workspace still works');
    assert.equal((await post(url, '/api/clock', live({ clock: { minutes: 1 } }), W('brand-new'))).status, 503);
    assert.equal((await json(await get(url, '/api/state?mode=live', W('brand-new')))).state.clock.minutesSinceStart, 0, 'a read never creates or refuses');
    assert.equal((await post(url, '/api/reset', {}, W('flood-0'))).status, 200);
    assert.equal((await post(url, '/api/clock', live({ clock: { minutes: 1 } }), W('brand-new'))).status, 200, 'a Reset freed a slot');
  }, { workspaces: createWorkspaces({ max: 4 }) });
});
