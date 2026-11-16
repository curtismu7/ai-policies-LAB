// Rule 25, "What Privilege did": this lab's gateway is its own simulation (engine.evaluate), so every trace is source 'mock' and every decision 'checked'.
// A Mock step and a Live evaluation both carry one; the contract (assertTrace) holds for all of them; nothing secret is in a trace.
import test from 'node:test';
import assert from 'node:assert/strict';
import { C, get, json, post, withServer } from './helpers.js';
import { SECRETS } from './secrets.js';
import { assertTrace } from '../src/gatewayTrace.js';
import { STAGES } from '../src/engine.js';
import { policyTrace } from '../src/policyTrace.js';
import { VERTICALS } from '../src/cast.js';
import { MOCK_TABLE } from '../src/mockTable.js';

const live = (extra = {}) => ({ mode: 'live', vertical: 'finance', ...extra });
const cl = (o = {}) => ({ sub: C.castAgent, surfaces: ['tool', 'model', 'agent'], scope: `${C.castApp}:read ${C.castApp}:write`, department: C.castDept, end_user: C.castUser, ...o });
const mint = async (url, claims = cl()) => (await json(await post(url, '/api/token', live({ token: { claims } })))).result.labToken;
const evalReq = async (url, request) => { const r = await post(url, '/api/evaluate', live({ request })); return { status: r.status, body: await r.json() }; };
const readCall = (token, o = {}) => ({ route: `/mcp/${C.castApp}`, tool: C.castToolRead, arguments: { record: C.castRecord }, token, ...o });
const holdCall = (token, o = {}) => ({ route: `/mcp/${C.castApp}`, tool: C.castToolHold, arguments: { record: C.castRecord, newValue: C.castNewValue }, token, ...o });
const outcomes = (t) => Object.fromEntries(t.decisions.map((d) => [d.id, d.outcome]));

test('Mock: every evaluation step of every scenario in every vertical carries a trace that meets the contract, all checked; other ops carry none', async () => {
  await withServer(async (url) => {
    let seen = 0;
    for (const v of Object.keys(VERTICALS)) {
      const { scenarios } = await json(await get(url, `/api/state?mode=mock&vertical=${v}`));
      for (const sc of scenarios) {
        const { scenario } = await json(await get(url, `/api/state?mode=mock&vertical=${v}&scenario=${sc.id}`));
        for (const s of scenario.steps) {
          if (s.op !== 'evaluate') { assert.equal(s.trace, undefined, `${sc.id}: ${s.op} is not a gateway call`); continue; }
          seen += 1;
          assert.deepEqual(assertTrace(s.trace), [], `${v}/${sc.id}/${s.title}`);
          assert.equal(s.trace.source, 'mock');
          assert.ok(s.trace.decisions.every((d) => d.basis === 'checked'));
          assert.deepEqual(s.trace.decisions.map((d) => d.id), STAGES, 'one decision per pipeline layer, in order');
          assert.equal(s.trace.response.status, s.result.http);
          assert.equal(s.trace.response.body.trace, undefined, 'the layer list is the decisions, not repeated in the response');
          assert.match(new URL(s.trace.request.url).hostname, /\.invalid$/);
        }
      }
    }
    assert.ok(seen >= 6, `saw ${seen} evaluation steps`);
  });
});

test('Mock: a hold is info (never counted as passed), a refusal fails, the layers after it are not reached', async () => {
  await withServer(async (url) => {
    const { scenario } = await json(await get(url, '/api/state?mode=mock&vertical=finance&scenario=hold-and-retry'));
    const held = scenario.steps.find((s) => s.result?.outcome === 'hold');
    const o = outcomes(held.trace);
    assert.equal(o['attended-unattended'], 'info');
    assert.equal(o['request-inspection'], 'skipped'); assert.equal(o.call, 'skipped');
    assert.equal(o.surface, 'pass');
    const four = (await json(await get(url, '/api/state?mode=mock&vertical=finance&scenario=four-layers'))).scenario.steps[0];
    assert.equal(outcomes(four.trace).surface, 'fail');
    assert.equal(four.trace.decisions.find((d) => d.id === 'surface').evidence.startsWith('deny (surface_not_allowed): '), true);
  });
});

test('Live: an allowed call, a held call and a bad token each return a trace; the token and a typed key never appear in it', async () => {
  await withServer(async (url) => {
    const token = await mint(url);
    const key = SECRETS.openai;
    const ok = await evalReq(url, readCall(token));
    assert.equal(ok.status, 200);
    assert.deepEqual(assertTrace(ok.body.trace), []);
    assert.equal(ok.body.trace.response.status, 200);
    assert.ok(Object.values(outcomes(ok.body.trace)).every((x) => x === 'pass'));
    assert.deepEqual(ok.body.trace.request.body, { route: `/mcp/${C.castApp}`, tool: C.castToolRead, arguments: { record: C.castRecord } });

    const held = await evalReq(url, holdCall(token));
    assert.equal(held.status, 403);
    assert.equal(outcomes(held.body.trace)['attended-unattended'], 'info');
    assert.deepEqual(assertTrace(held.body.trace), []);

    const sneaky = await evalReq(url, readCall(token, { arguments: { record: C.castRecord, note: key }, headers: { 'x-api-key': key } }));
    const bad = await evalReq(url, readCall(`${token}x`, { simulatedReply: key }));
    assert.equal(bad.status, 401);
    assert.equal(outcomes(bad.body.trace).token, 'fail');
    assert.equal(outcomes(bad.body.trace).surface, 'skipped');

    for (const r of [ok, held, sneaky, bad]) {
      const text = JSON.stringify(r.body.trace);
      assert.ok(!text.includes(token), 'the token is never in a trace');
      assert.ok(!text.includes(key), 'a typed key is never in a trace');
      assert.ok(!/Bearer eyJ/.test(text));
      assert.deepEqual(assertTrace(r.body.trace), []);
      assert.equal(r.body.trace.source, 'mock');
      assert.ok(r.body.trace.decisions.every((d) => d.basis === 'checked'));
    }
    assert.match(ok.body.trace.request.headers.authorization, /^Bearer <.*not repeated here>$/);
  });
});

test('Live: a call without a token sends no Authorization header; a refused evaluation (not a gateway call) carries no trace', async () => {
  await withServer(async (url) => {
    const none = await evalReq(url, readCall(undefined));
    assert.equal(none.status, 401);
    assert.equal(none.body.trace.request.headers.authorization, undefined);
    assert.deepEqual(assertTrace(none.body.trace), []);
    const refused = await evalReq(url, { ...readCall(await mint(url)), nonsense: 1 });
    assert.equal(refused.status, 400); assert.equal(refused.body.ok, false); assert.equal(refused.body.trace, undefined);
    const mintRes = await json(await post(url, '/api/token', live({ token: { claims: cl() } })));
    assert.equal(mintRes.trace, undefined, 'minting a token is not a gateway call');
  });
});

test('policyTrace: the Mock table is the single source (an unknown route still builds a valid trace on the root path)', () => {
  const step = MOCK_TABLE.verticals.finance.scenarios.flatMap((s) => s.steps).find((s) => s.op === 'evaluate');
  const t = policyTrace({ cast: VERTICALS.finance, request: step.request, tokenNote: 'x', decision: { ...step.result, surface: undefined, app: undefined } });
  assert.equal(new URL(t.request.url).pathname, '/');
  assert.deepEqual(assertTrace(t), []);
});
