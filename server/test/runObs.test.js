// Rule 27: the lab's half of the run-observability panel (runObs.js, the route, the table events). The vendored collector has its own tests in the shared folder.
// Real is tested against an in-process fake Privilege gateway on loopback only; the shared settings file is pointed at a file that does not exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { C, claims, tok, readCall, holdCall, newEngine, get, post, rawHttp, withServer } from './helpers.js';
import { VERTICALS } from '../src/cast.js';
import { MOCK_TABLE } from '../src/mockTable.js';
import { buildMockTable } from '../src/scenarios.js';
import { perform } from '../src/actions.js';
import { assertRunObservability, classify, layerMatchers, createMasker, LAYERS } from '../src/runObservability.js';
import { causeWord, createRunLog, decisionLine, evaluateEvents, KEEP_RUNS, lineValue, mark, mockRecord, observeAction, realRecord, replyOf } from '../src/runObs.js';
import { createWorkspaces } from '../src/workspaces.js';
import { maskDeep } from '../src/mask.js';

const NO_ENV = '/nonexistent/none.env'; // the shared settings file is read live by gatewayReal.js: never the owner's
const W = (id) => ({ 'x-workspace': id });
const live = (extra = {}) => ({ mode: 'live', vertical: 'finance', ...extra });
// What the shared matchers read, whole line, no field stripped (an `actor=` that was stripped once hid six hits).
const WORDS = /refused|denied|rejected|forbidden|failed|invalid|expired|mismatch|token|audience|scope|served|unauthorized|insufficient|not allowed/i;
const LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z ai-policies-lab decision step=[A-Za-z0-9._:/@-]+ layer=[a-z]+ actor=[A-Za-z0-9._:/@-]+ result=(?:passed|stopped|unclear|no-reply) cause=[A-Za-z0-9._:/@-]+(?: ev=ev-\d+)?(?: approval=apr-\d+)?(?: labtime=[A-Za-z0-9._:/@-]+)? run=[A-Za-z0-9._:/@-]+$/;
const PRODUCTS = [...new Set(layerMatchers.map((m) => m.product))];
const fragments = (...p) => p.join('');
const KEY = fragments('fake-agent-key-', 'qqqqqqqqqq', '-end');
const rows = (rec) => rec.rows.filter((r) => r.origin !== 'not-logged');
const noMatcherReads = (line, at = line.split(' ')[0]) => { for (const product of PRODUCTS) assert.equal(classify({ product, message: line, at: Date.parse(at), atExact: at }, []), null, `${product}: ${line}`); };
// Every shape a stdout line can reach a shared matcher in: bare, logback, the Privilege gateway's logfmt, the PingFederate audit prefix, and JSON with the line in a
// message field. The OpenIG access matcher keys on eventName OPENIG-HTTP-ACCESS, which a line this lab writes never carries, so the JSON form has no eventName.
const wrapped = (line) => { const at = line.split(' ')[0]; const body = line.split(' ').slice(1).join(' '); return { at, forms: [line, `[${at}] INFO: ${body}`, `time=${at} level=info msg="${line}"`, `/opt/out/instance/log/audit.log: ${at} | tid: ${body}`, JSON.stringify({ level: 'info', msg: line })] }; };
const clean = (line) => { assert.match(line, LINE, line); assert.ok(!WORDS.test(line), line); const { at, forms } = wrapped(line); for (const form of forms) noMatcherReads(form, at); };
const stderrOf = async (fn) => {
  const written = []; const realWrite = process.stderr.write;
  process.stderr.write = (c, ...rest) => { written.push(String(c)); return typeof rest.at(-1) === 'function' ? rest.at(-1)() : true; };
  try { await fn(); } finally { process.stderr.write = realWrite; }
  return written.join('');
};
const scenario = (v, id) => MOCK_TABLE.verticals[v].scenarios.find((s) => s.id === id);
const stepRows = (rec, n) => rows(rec).filter((r) => r.detail.step === n);

// ---- A fake Privilege gateway on loopback: the MCP calls the lab's client makes, answered by a script ------------------------------------------
async function fakeGateway({ closeDelayMs = 0 } = {}) {
  const g = { script: { list: null, call: null }, seen: [], url: '', port: 0, initFail: 0, notifyFail: 0, initRpcError: false, initEmpty: false };
  const json = (res, obj, status = 200, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'DELETE') { setTimeout(() => { res.writeHead(200); res.end(); }, closeDelayMs); return undefined; }
      let m; try { m = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
      g.seen.push({ method: m.method, auth: req.headers.authorization });
      if (m.method === 'initialize' && g.initEmpty) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(); }
      if (m.method === 'initialize' && g.initFail) return json(res, { message: 'handshake refused' }, g.initFail);
      if (m.method === 'initialize' && g.initRpcError) return json(res, { jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'no handshake' } });
      if (m.method === 'notifications/initialized' && g.notifyFail) return json(res, { message: 'handshake refused' }, g.notifyFail);
      if (m.method === 'initialize') return json(res, { jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'fake-gateway' }, capabilities: {} } }, 200, { 'mcp-session-id': 's1' });
      if (m.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
      const step = m.method === 'tools/list' ? g.script.list : g.script.call;
      return step({ m, res, req, json: (o, s, h) => json(res, o, s, h) });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  g.port = server.address().port; g.url = `http://127.0.0.1:${g.port}`;
  g.close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return g;
}
const tools = (n) => ({ m, json }) => json({ jsonrpc: '2.0', id: m.id, result: { tools: Array.from({ length: n }, (_x, i) => ({ name: `tool_${i}`, description: 'a tool' })) } });
const status = (code, text = 'nope') => ({ json }) => json({ message: text }, code);
const rpcResult = (result) => ({ m, json }) => json({ jsonrpc: '2.0', id: m.id, result });
const rpcError = (message) => ({ m, json }) => json({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message } });
const drop = ({ req }) => req.socket.destroy();
const rawText = ({ res }) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('<html>not json</html>'); };

// gatewayReal's door settings come from process.env (APL_GW_*) over the shared file, which is pointed at a file that does not exist.
async function withEnv(vars, fn) {
  const old = {};
  for (const [k, v] of Object.entries(vars)) { old[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
async function withGateway(fn, { runLog, closeDelayMs, key = 'LAB_AGENT' } = {}) {
  const gw = await fakeGateway({ closeDelayMs });
  try { await withEnv({ STANDALONE_ENV: NO_ENV, APL_GW_URL: gw.url, APL_GW_APPS: 'door-a', [`APL_GW_KEY_${key}`]: KEY }, () => withServer(async (url, ctx) => fn(url, gw, ctx), { runLog })); } finally { await gw.close(); }
}
const toReal = (url) => post(url, '/api/mode', { source: 'real' });
const toMock = (url) => post(url, '/api/mode', { source: 'mock' });
const check = async (url) => (await post(url, '/api/gateway-check', {})).json();
const record = async (url, q = '') => (await get(url, `/api/run-observability${q}`)).json();

// ---- Mock: the recorded scenarios -------------------------------------------------------------------------------------------------------------
test('every recorded scenario of every vertical has a Mock record that passes the shared contract, is all simulated, names its step, and comes through the response mask unchanged', async () => {
  await withServer(async (url) => {
    for (const [v, vv] of Object.entries(MOCK_TABLE.verticals)) {
      for (const sc of vv.scenarios) {
        const res = await get(url, `/api/run-observability?vertical=${v}&scenario=${sc.id}`);
        assert.equal(res.status, 200, `${v}/${sc.id}`);
        const { record: rec } = await res.json();
        assert.deepEqual(assertRunObservability(rec), [], `${v}/${sc.id}`);
        assert.equal(rec.source, 'mock'); assert.equal(rec.runId, `table-${v}-${sc.id}`);
        assert.ok(rows(rec).length > 0);
        assert.ok(rows(rec).every((r) => r.origin === 'simulated' && !r.basis && !r.matchedBy), 'no row is presented as read from a log');
        assert.deepEqual(Object.keys(rec.coverage).sort(), [...LAYERS].sort());
        assert.equal(rec.coverage.authorize, 'not-logged'); assert.equal(rec.coverage.resource, 'not-logged');
        // a scripted run merges steps, so every row names its step
        for (const r of rows(rec)) assert.match(r.message, new RegExp(`^Step ${r.detail.step}: `), `${v}/${sc.id}`);
        assert.ok(rows(rec).every((r) => r.detail.step >= 1 && r.detail.step <= sc.steps.length));
        // the route's answer is exactly the record the lab built: the response mask changed no word of it
        assert.deepEqual(rec, JSON.parse(JSON.stringify(await mockRecord(MOCK_TABLE, v, sc.id))));
        assert.deepEqual(maskDeep({ record: rec }), { record: rec });
        assert.equal(rec.rows.length, rows(rec).length + Object.values(rec.coverage).filter((c) => c === 'not-logged').length);
      }
    }
    // no scenario named: the first one
    assert.equal((await record(url)).record.runId, `table-finance-${MOCK_TABLE.verticals.finance.scenarios[0].id}`);
  });
});

test('Mock events are the engine\'s own decisions: each evaluation\'s rows follow the stages it reached, in order, with its id and its lab-clock time, and no stage it did not reach', () => {
  for (const [v, vv] of Object.entries(MOCK_TABLE.verticals)) {
    for (const sc of vv.scenarios) {
      assert.deepEqual(sc.events.map((e) => e.seq), sc.events.map((_e, i) => i + 1));
      sc.steps.forEach((st, i) => {
        const mine = sc.events.filter((e) => e.detail.step === i + 1);
        if (st.op !== 'evaluate') return;
        const d = st.result;
        const reached = d.trace.filter((s) => s.verdict !== 'not-reached').map((s) => s.stage);
        const stages = mine.filter((e) => e.detail.stage).map((e) => e.detail.stage); // the gateway's answer names where it stopped as stoppedAt, not as a stage of its own
        assert.deepEqual(stages, reached.filter((s) => stages.includes(s)), `${v}/${sc.id}/${i + 1}: stage rows are in the engine's order`);
        assert.ok(stages.every((s) => reached.includes(s)), `${v}/${sc.id}/${i + 1}: no row for a stage the engine did not reach`);
        assert.ok(mine.every((e) => e.at === d.at), 'the time is the lab clock the engine stamped');
        assert.ok(mine.every((e) => e.detail.ev === d.id));
        for (const s of ['surface', 'application', 'action', 'end-user', 'attended-unattended', 'request-inspection', 'reply-inspection']) assert.equal(stages.includes(s), reached.includes(s), `${v}/${sc.id}/${i + 1}: ${s}`);
        assert.equal(mine.some((e) => e.layer === 'agent'), reached.includes('token') && d.trace.find((s) => s.stage === 'token').verdict === 'pass');
        assert.equal(mine.some((e) => e.layer === 'person' && e.detail.ev), reached.includes('end-user'));
      });
    }
  }
});

test('the table was generated from the engine: regenerating it gives the same events (a drifting table fails here and in the doctor)', () => {
  assert.equal(JSON.stringify(buildMockTable()), JSON.stringify(MOCK_TABLE));
});

test('four-layers: each call is credential, the layers it reached, the gateway\'s answer; the first layer that says no ends it, and nothing after it has a row', async () => {
  const rec = await mockRecord(MOCK_TABLE, 'finance', 'four-layers');
  assert.deepEqual(stepRows(rec, 1).map((r) => [r.layer, r.outcome]), [['agent', 'info'], ['privilege', 'refused'], ['gateway', 'info']], 'a surface the identity does not hold: refused at the first layer');
  assert.match(stepRows(rec, 1)[1].message, /^Step 1: 1\. Surface scope: .*a key can never exceed its identity/);
  assert.deepEqual(stepRows(rec, 2).map((r) => r.layer), ['agent', 'privilege', 'privilege', 'gateway']);
  assert.deepEqual(stepRows(rec, 2).map((r) => r.outcome), ['info', 'allowed', 'refused', 'info']);
  assert.deepEqual(stepRows(rec, 6).map((r) => [r.layer, r.outcome]), [['agent', 'info'], ['privilege', 'allowed'], ['privilege', 'allowed'], ['privilege', 'allowed'], ['person', 'info'], ['privilege', 'allowed'], ['privilege', 'allowed'], ['privilege', 'allowed'], ['privilege', 'allowed'], ['gateway', 'info']]);
  assert.ok(!stepRows(rec, 1).some((r) => r.detail.stage === 'application'), 'the application layer was never consulted');
  // a header that claims a scope is not a scope: the action layer refuses on the token
  assert.match(stepRows(rec, 4).find((r) => r.outcome === 'refused').message, /verified token does not carry the scope/);
  // the person is a claim in the lab's own token: a name on the roster, or nobody
  const [ghost, ok] = rows(rec).filter((r) => r.layer === 'person');
  assert.match(ghost.message, /names no one the roster knows/); assert.match(ok.message, /names maya\.chen, who is on the roster/);
  assert.ok(rows(rec).filter((r) => r.layer === 'agent').every((r) => /verified the token it minted.*information, not a policy decision/.test(r.message)));
  assert.ok(rows(rec).filter((r) => r.layer === 'person').every((r) => r.outcome === 'info' && /no sign-in/.test(r.message)));
  assert.equal(rec.coverage.person, 'simulated'); assert.equal(rec.coverage.agent, 'simulated'); assert.equal(rec.coverage.gateway, 'simulated'); assert.equal(rec.coverage.privilege, 'simulated');
});

test('only a policy point says allowed, refused or blocked: a verified credential, the person, an approver\'s typed name and the gateway\'s restatement are information, never a pass', () => {
  for (const [v, vv] of Object.entries(MOCK_TABLE.verticals)) {
    for (const sc of vv.scenarios) {
      for (const e of sc.events) {
        if (e.layer === 'agent' || e.layer === 'person') assert.equal(e.outcome, 'info', `${v}/${sc.id}/${e.seq} ${e.layer}`);
        if (e.layer === 'gateway' && e.detail.http !== undefined) assert.equal(e.outcome, 'info', 'the gateway\'s answer restates the layer that decided');
        if (e.layer === 'gateway' && e.detail.stage) assert.ok(['request', 'token', 'call'].includes(e.detail.stage));
        assert.ok(['privilege', 'gateway', 'agent', 'person'].includes(e.layer), 'no resource or Authorize row: the lab has neither');
        assert.ok(!/dispatch|tool server (ran|answered)|tool ran/i.test(e.message), 'no narrated hop that does not exist');
      }
    }
  }
});

test('hold-and-retry: a hold is information (never a pass), each refused approver is a refusal, the signature that completes it is allowed, the retry names the approval it used, the replay is refused', async () => {
  const rec = await mockRecord(MOCK_TABLE, 'finance', 'hold-and-retry');
  const hold = stepRows(rec, 1).find((r) => r.detail.stage === 'attended-unattended');
  assert.equal(hold.outcome, 'info'); assert.match(hold.message, /held for a person.*nothing is held open/);
  assert.match(stepRows(rec, 1).at(-1).message, /HTTP 403: the call is held for a person \(approval apr-0001\)/);
  for (const [n, re] of [[3, /person the call acts for cannot approve it/], [4, /does not hold a role the request names/], [5, /weaker authentication than the request demands/]]) {
    const [p, d] = stepRows(rec, n);
    assert.deepEqual([p.layer, p.outcome, d.layer, d.outcome], ['person', 'info', 'privilege', 'refused']); assert.match(d.message, re); assert.match(p.message, /Typed on the page.*no sign-in/);
  }
  const [signer, grant] = stepRows(rec, 6);
  assert.deepEqual([signer.outcome, grant.outcome], ['info', 'allowed']); assert.match(signer.message, /signed at authentication level 2/); assert.match(grant.message, /completed apr-0001 \(1 of 1\)/);
  const used = stepRows(rec, 8).find((r) => r.detail.stage === 'attended-unattended');
  assert.deepEqual([used.outcome, /approval apr-0001 applies as an input/.test(used.message)], ['allowed', true]);
  assert.equal(stepRows(rec, 7).find((r) => r.detail.stage === 'attended-unattended').outcome, 'info', 'changed arguments are a different call: a new hold');
  assert.deepEqual([stepRows(rec, 9).find((r) => r.outcome === 'refused').detail.stage, stepRows(rec, 9).find((r) => r.outcome === 'refused').message.includes('already been used')], ['attended-unattended', true]);
  assert.ok(rec.summary.info > 0 && rec.summary.refused === 4);
  assert.deepEqual(assertRunObservability(rec), []);
});

test('period-approval and hard-denial: the first of two signatures is information, the second completes it; a hard denial stays refused when an approval is offered', async () => {
  const period = await mockRecord(MOCK_TABLE, 'finance', 'period-approval');
  assert.deepEqual(stepRows(period, 2).map((r) => r.outcome), ['info', 'info']); assert.match(stepRows(period, 2)[1].message, /1 of 2 signatures so far, so the request is still pending/);
  assert.equal(stepRows(period, 3).at(-1).outcome, 'refused'); assert.match(stepRows(period, 3).at(-1).message, /already signed|already has signed|counts once/);
  assert.match(stepRows(period, 5).at(-1).message, /completed apr-0001 \(2 of 2\)/);
  assert.equal(period.rows.some((r) => /^Step 8:/.test(r.message)), false, 'moving the clock is not a decision: no row');
  const hard = await mockRecord(MOCK_TABLE, 'finance', 'hard-denial');
  assert.match(stepRows(hard, 1).find((r) => r.outcome === 'refused').message, /refuses the attended form: this is a hard denial/);
  assert.equal(stepRows(hard, 4).find((r) => r.detail.stage === 'attended-unattended').outcome, 'refused');
});

test('the lab\'s own stops are `blocked`, not a policy saying no: a wrong-typed argument, a layer that throws, a withheld reply, a rule the validator will not save, a duplicate key; a tampered credential is the gateway turning the call away', async () => {
  const fc = await mockRecord(MOCK_TABLE, 'finance', 'fail-closed');
  assert.deepEqual(stepRows(fc, 1).map((r) => [r.layer, r.outcome]), [['agent', 'info'], ['privilege', 'allowed'], ['privilege', 'allowed'], ['privilege', 'blocked'], ['gateway', 'info']]);
  assert.match(stepRows(fc, 1).find((r) => r.outcome === 'blocked').message, /wrong type.*fails closed/s);
  assert.match(stepRows(fc, 2).find((r) => r.outcome === 'blocked').message, /failure is a denial.*fails closed/s);
  assert.equal(stepRows(fc, 3).find((r) => r.detail.stage === 'action').outcome, 'refused', 'a tool that is not in the catalog is a refusal');
  assert.deepEqual(stepRows(fc, 4).map((r) => [r.layer, r.outcome, r.detail.stage]), [['gateway', 'blocked', 'request']], 'a duplicate key: the lab\'s own parser stops it before any layer, and there is no restatement');
  assert.deepEqual(stepRows(fc, 5).map((r) => [r.layer, r.outcome, r.detail.stage]), [['gateway', 'refused', 'token']], 'a tampered credential never verified: no agent row, no layer after it');
  assert.match(stepRows(fc, 5)[0].message, /signature does not verify.*answered HTTP 401/s);
  assert.deepEqual(stepRows(fc, 6).concat(stepRows(fc, 7)).map((r) => [r.layer, r.outcome]), [['privilege', 'blocked'], ['privilege', 'blocked']]);
  assert.match(stepRows(fc, 6)[0].message, /did not save the users policy layer.*not a decision about a call/s);
  const pi = await mockRecord(MOCK_TABLE, 'finance', 'post-inspection');
  assert.equal(stepRows(pi, 1).find((r) => r.detail.stage === 'request-inspection').outcome, 'refused');
  const withheld = stepRows(pi, 2).find((r) => r.detail.stage === 'reply-inspection');
  assert.equal(withheld.outcome, 'blocked'); assert.match(withheld.message, /the call was made, and the result is withheld/);
  assert.equal(stepRows(pi, 3).find((r) => r.detail.stage === 'reply-inspection').outcome, 'allowed');
  assert.deepEqual(stepRows(pi, 4).map((r) => r.outcome), ['blocked'], 'a rule that tries to hold on a finding is not saved');
});

test('the lanes say why they have no row: no sign-in, no OBO, no Authorize, no tool server', async () => {
  const rec = await mockRecord(MOCK_TABLE, 'finance', 'four-layers');
  assert.match(rec.reasons.authorize, /does not call PingOne Authorize/);
  assert.match(rec.reasons.resource, /no resource or MCP tool server.*simulated call has no row/s);
  assert.equal(rec.coverage.resource, 'not-logged');
  const hold = await mockRecord(MOCK_TABLE, 'finance', 'hard-denial');
  assert.ok(hold.rows.filter((r) => r.layer === 'resource').length === 1 && hold.rows.find((r) => r.layer === 'resource').origin === 'not-logged');
});

// ---- Engine events, straight from the engine ----------------------------------------------------------------------------------------------
const decide = (e, params) => { const before = mark(e); const outcome = perform(e, 'decide', params); return { outcome, ...observeAction(e, { op: 'decide', outcome, before, params }) }; };
const evaluate = (e, params) => { const before = mark(e); const outcome = perform(e, 'evaluate', params); return { outcome, ...observeAction(e, { op: 'evaluate', outcome, before, params }) }; };

test('outcomes straight from the engine: a refusal by a rule, the lab\'s own stops, a hold and a withhold', () => {
  const e = newEngine();
  const kind = (params) => { const r = evaluate(e, params); return r.events.filter((x) => x.layer === 'privilege' || x.layer === 'gateway').map((x) => `${x.layer}:${x.step}:${x.outcome}:${x.cause}`); };
  assert.deepEqual(kind({ ...readCall(e), token: tok(e, claims({ scope: `${C.castApp}:read` })), tool: C.castToolWrite, arguments: { record: C.castRecord, amount: 5 } }).slice(-2), ['privilege:action-check:refused:permission-missing', 'gateway:gateway-answer:info:stopped-action']);
  assert.ok(kind({ ...readCall(e), token: tok(e, claims({ surfaces: 'tool' })) }).includes('privilege:surface-check:blocked:claim-type'), 'a claim of the wrong type is a fail-closed stop');
  assert.ok(kind(readCall(e, { arguments: { record: 5 } })).includes('privilege:action-check:blocked:argument-type'));
  assert.ok(kind(readCall(e, { labFault: 'surface' })).includes('privilege:surface-check:blocked:evaluation-error'));
  const faulted = kind(readCall(e, { labFault: 'call' }));
  assert.equal(faulted.at(-1), 'gateway:call-made:blocked:evaluation-error'); assert.ok(!faulted.some((x) => x.includes('gateway-answer')), 'a fault in the simulated call is the lab\'s own row, with no restatement');
  assert.ok(kind(readCall(e, { simulatedReply: `card ${'4111 1111 1111 1111'}` })).includes('privilege:reply-scan:blocked:reply-withheld'));
  assert.deepEqual(kind(holdCall(e)).slice(-2), ['privilege:hold-check:info:hold-for-approval', 'gateway:gateway-answer:info:held']);
  assert.ok(kind(readCall(e, { token: `${tok(e).slice(0, -4)}AAAA` })).includes('gateway:credential-check:refused:credential-signature'), 'a credential that does not verify');
});

test('an evaluation that stops at a stage has no row for a later one, and the person row names nobody the roster does not hold', () => {
  const e = newEngine();
  const r = evaluate(e, readCall(e, { token: tok(e, claims({ end_user: 'ghost.user' })), tool: C.castToolWrite, arguments: { record: C.castRecord, amount: 5 } }));
  assert.equal(r.outcome.result.code, 'end_user_unresolved');
  const steps = r.events.map((x) => x.step);
  assert.deepEqual(steps, ['credential-check', 'surface-check', 'application-check', 'action-check', 'end-user-claim', 'end-user-check', 'gateway-answer']);
  const person = r.events.find((x) => x.layer === 'person');
  assert.equal(person.who, null); assert.ok(!person.message.includes('ghost'), 'a name that is not on the roster is never written');
  assert.ok(evaluateEvents({ trace: [], outcome: 'allow', http: 200, id: 'ev-9999', at: '2026-11-02T09:00:00.000Z' }).every((x) => x.step === 'gateway-answer'), 'no stages, no stage rows');
});

test('approvals straight from the engine: the signer is information, the check on the signature is the decision; a refusal that is request validation is no decision at all', () => {
  const e = newEngine();
  const h = evaluate(e, holdCall(e));
  const ref = h.outcome.result.approval.ref;
  const bad = decide(e, { ref, approver: C.castApprover, decision: 'approve', authLevel: 1 });
  assert.deepEqual(bad.events.map((x) => [x.layer, x.outcome, x.cause]), [['person', 'info', '-'], ['privilege', 'refused', 'weak-sign-in']]);
  const unknown = decide(e, { ref, approver: 'someone <b>typed</b>', decision: 'approve', authLevel: 2 });
  assert.deepEqual(unknown.events.map((x) => [x.layer, x.outcome, x.cause, x.who]), [['privilege', 'refused', 'not-an-approver', null]], 'a typed name that is not a person is not written');
  const ok = decide(e, { ref, approver: C.castApprover, decision: 'approve', authLevel: 2 });
  assert.deepEqual(ok.events.map((x) => [x.layer, x.outcome, x.cause]), [['person', 'info', '-'], ['privilege', 'allowed', 'approved']]);
  const again = decide(e, { ref, approver: C.castApprover2, decision: 'approve', authLevel: 3 });
  assert.deepEqual(again.events.map((x) => [x.outcome, x.cause]).slice(-1), [['refused', 'already-decided']]);
  const e2 = newEngine(); const h2 = evaluate(e2, holdCall(e2));
  for (const params of [{ ref: 'apr-9999', approver: C.castApprover, decision: 'approve', authLevel: 2 }, { ref: h2.outcome.result.approval.ref, approver: C.castApprover, decision: 'maybe' }, { ref: h2.outcome.result.approval.ref, approver: C.castApprover, decision: 'approve', authLevel: 9 }, { ref, bogus: 1 }]) {
    const r = decide(e2, params);
    assert.deepEqual(r.events, [], JSON.stringify(params)); assert.ok(r.noRun, 'no run begins'); assert.match(r.noRun, /^[a-z0-9-]+$/);
  }
  const second = decide(e2, { ref: h2.outcome.result.approval.ref, approver: C.castApprover, decision: 'deny' });
  assert.deepEqual(second.events.map((x) => [x.layer, x.outcome, x.cause]), [['person', 'info', '-'], ['privilege', 'refused', 'approver-declined']]);
});

// ---- The route ------------------------------------------------------------------------------------------------------------------------------
test('the route answers errors as {error, message} JSON, takes only its own parameters, and is GET only', async () => {
  await withServer(async (url) => {
    const cases = [['?bogus=1', 400, 'unknown_field'], ['?scenario=nope', 404, 'unknown_scenario'], ['?vertical=nope', 400, 'bad_vertical'], ['?scenario=a&scenario=b', 404, 'unknown_scenario'], ['?vertical=finance&vertical=health', 400, 'bad_vertical']];
    for (const [q, st, code] of cases) {
      const r = await get(url, `/api/run-observability${q}`); const b = await r.json();
      assert.equal(r.status, st, q); assert.equal(b.error, code); assert.equal(typeof b.message, 'string');
    }
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await fetch(`${url}/api/run-observability`, { method: m, headers: { origin: url, 'content-type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 405, m); assert.equal(r.headers.get('allow'), 'GET, HEAD'); assert.equal(await r.text(), '{"error":"method_not_allowed"}');
    }
    assert.equal((await get(url, '/api/run-observability')).headers.get('cache-control'), 'no-store');
    // a foreign Host is refused like on every other route
    const foreign = await rawHttp(`${url}/api/run-observability`, { headers: { host: 'attacker.invalid' } });
    assert.ok(foreign.status >= 400 && foreign.status < 500, String(foreign.status));
    assert.ok(!foreign.text.includes('record'));
  });
});

test('the route follows the server mode: Mock answers a Mock record, Real answers Real runs, and neither answers in the other\'s words', async () => {
  await withGateway(async (url, gw) => {
    gw.script.list = tools(2); gw.script.call = status(403);
    assert.equal((await record(url)).record.source, 'mock');
    assert.equal((await record(url, '?runId=gw-000000-1')).record.source, 'mock', 'a run id in Mock is not a Real run');
    await toReal(url);
    assert.deepEqual(await record(url), { record: null, message: 'No gateway check has run in Real yet: nothing was received from the gateway, so there is nothing to show.' });
    const first = await check(url);
    assert.equal((await record(url)).record.runId, first.runId);
    await toMock(url);
    const m = await record(url, `?runId=${first.runId}&vertical=finance&scenario=four-layers`);
    assert.equal(m.record.source, 'mock'); assert.notEqual(m.record.runId, first.runId);
    assert.ok(m.record.rows.filter((r) => r.origin === 'simulated').every((r) => !/Privilege gateway|reply the lab received/.test(r.message)), 'a Mock row never says what a Real one does');
    assert.equal((await post(url, '/api/gateway-check', {})).status, 409);
    await toReal(url);
    assert.equal((await record(url, `?runId=${first.runId}`)).record.source, 'real');
    assert.deepEqual(await record(url, '?runId=gw-000000-1'), { record: null, message: 'That gateway check is no longer kept (the lab keeps the last few).' });
    assert.equal((await get(url, '/api/run-observability?runId=a&runId=b')).status, 400);
  });
});

test('a Live engine action never becomes a Real record or changes the Mock one, and Reset leaves a gateway check record alone', async () => {
  const lines = [];
  await withGateway(async (url, gw) => {
    gw.script.list = tools(2); gw.script.call = status(403);
    const mockBefore = JSON.stringify(await record(url, '?vertical=finance&scenario=hold-and-retry'));
    await toReal(url);
    const out = await check(url);
    const before = JSON.stringify(await record(url, `?runId=${out.runId}`));
    const t = (await (await post(url, '/api/token', live({ token: { claims: claims() } }), W('keep'))).json()).result.labToken;
    const ev = await post(url, '/api/evaluate', live({ request: { route: `/mcp/${C.castApp}`, tool: C.castToolHold, arguments: { record: C.castRecord, newValue: C.castNewValue }, token: t } }), W('keep'));
    assert.equal(ev.status, 403);
    assert.ok(lines.some((l) => / step=hold-check /.test(l)), 'the engine\'s decisions are on stdout');
    assert.equal(JSON.stringify(await record(url, `?runId=${out.runId}`)), before, 'the Real record holds only what the gateway said');
    assert.ok(rows((await record(url, `?runId=${out.runId}`)).record).every((r) => r.origin === 'response' && r.layer === 'gateway'));
    assert.equal((await post(url, '/api/reset', {}, W('keep'))).status, 200);
    assert.equal(JSON.stringify(await record(url, `?runId=${out.runId}`)), before, 'Reset clears the engine, not the gateway check');
    await toMock(url);
    assert.equal(JSON.stringify(await record(url, '?vertical=finance&scenario=hold-and-retry')), mockBefore, 'Mock is a recorded table: a Live action changes nothing in it');
  }, { runLog: createRunLog({ write: (l) => lines.push(l) }) });
});

// ---- Live: one stdout line per decision --------------------------------------------------------------------------------------------------------
const act = (url, ws, route, body, method = 'POST') => (method === 'PUT' ? fetch(`${url}${route}`, { method, headers: { 'content-type': 'application/json', origin: url, ...W(ws) }, body: JSON.stringify(live(body)) }) : post(url, route, live(body), W(ws)));
async function liveSession(url, ws) {
  const answers = []; const go = async (...a) => { const r = await act(url, ws, ...a); answers.push(r.status); return r.json(); };
  const minted = async (cl) => (await go('/api/token', { token: { claims: cl } })).result.labToken;
  const t = await minted(claims());
  const call = (token, o = {}) => ({ request: { route: `/mcp/${C.castApp}`, tool: C.castToolRead, arguments: { record: C.castRecord }, token, ...o } });
  await go('/api/evaluate', call(t));                                                                                                       // allowed
  const hold = await go('/api/evaluate', call(t, { tool: C.castToolHold, arguments: { record: C.castRecord, newValue: C.castNewValue } })); // held
  const ref = hold.result.approval.ref;
  await go(`/api/approvals/${ref}/decision`, { decision: { approver: C.castUser, decision: 'approve', authLevel: 2 } });                    // self-approval refused
  await go(`/api/approvals/${ref}/decision`, { decision: { approver: C.castApprover, decision: 'approve', authLevel: 2 } });               // approved
  await go('/api/evaluate', call(t, { tool: C.castToolHold, arguments: { record: C.castRecord, newValue: C.castNewValue } }));             // retry under the grant
  await go('/api/evaluate', call(t, { tool: C.castToolHold, arguments: { record: C.castRecord, newValue: C.castNewValue }, approvalRef: ref })); // replay refused
  await go('/api/evaluate', call(`${t.slice(0, -4)}AAAA`));                                                                                // credential does not verify
  await go('/api/evaluate', call(t, { argumentsText: '{"record":"a","record":"b"}', arguments: undefined }));                              // duplicate key
  await go('/api/evaluate', call(t, { labFault: 'action' }));                                                                               // a layer throws
  await go('/api/evaluate', call(t, { simulatedReply: 'card 4111 1111 1111 1111' }));                                                       // reply withheld
  await go('/api/evaluate', { request: { bogus: 1 } });                                                                                     // validation: no run
  await go('/api/clock', { clock: { minutes: 5 } });                                                                                        // not a decision
  await act(url, ws, `/api/policies/users`, { rules: [{ id: 'usr-ghost', app: C.castApp, tool: C.castToolWrite, users: ['ghost.user'] }] }, 'PUT'); // not saved
  answers.push(0);
  return { answers, ref };
}

test('Live: each decision the engine makes is one stdout line, one run id per action, no word a shared matcher reads, and no shared matcher reads any line', async () => {
  const lines = [];
  await withServer(async (url) => {
    const { ref } = await liveSession(url, 'obs-live');
    for (const l of lines) clean(l);
    const steps = new Set(lines.map((l) => / step=(\S+)/.exec(l)[1]));
    for (const s of ['credential-check', 'surface-check', 'application-check', 'action-check', 'end-user-claim', 'end-user-check', 'hold-check', 'request-scan', 'reply-scan', 'gateway-answer', 'approver-act', 'approval-step', 'request-read', 'policy-save', 'request-check']) assert.ok(steps.has(s), `${s} was written`);
    // one run id per action; an action's lines share it; ids are unique; a mint, a clock move and a validation failure begin no run
    const byRun = Map.groupBy(lines, (l) => / run=(\S+)$/.exec(l)[1]);
    assert.equal(byRun.get('-').length, 1, 'one line for the evaluation that was refused before any layer ran');
    assert.match(byRun.get('-')[0], / step=request-check layer=gateway actor=- result=stopped cause=unknown-field /);
    assert.equal(byRun.size - 1, 9 + 2, 'nine evaluations, two approver answers... and the policy save: one id each');
    // the first (allowed) evaluation: ten lines, every layer it reached, ending with the gateway's answer
    const first = [...byRun.values()][0];
    assert.deepEqual(first.map((l) => / step=(\S+)/.exec(l)[1]), ['credential-check', 'surface-check', 'application-check', 'action-check', 'end-user-claim', 'end-user-check', 'hold-check', 'request-scan', 'reply-scan', 'gateway-answer']);
    assert.ok(first.every((l) => / ev=ev-0001 /.test(l)));
    // a decision that says no is `stopped`, a hold and a restatement and a verified credential are `unclear`, never `passed`
    assert.ok(lines.some((l) => / step=approval-step .* result=stopped cause=self-approval approval=apr-0001 /.test(l)));
    assert.ok(lines.some((l) => / step=approval-step .* result=passed cause=approved approval=apr-0001 /.test(l)));
    assert.ok(lines.some((l) => / step=hold-check .* result=unclear cause=hold-for-approval ev=ev-0002 approval=apr-0001 /.test(l)));
    assert.ok(lines.filter((l) => / step=(credential-check|gateway-answer|end-user-claim|approver-act) /.test(l) && !/cause=(credential-|stopped)/.test(l)).every((l) => / result=unclear /.test(l)));
    assert.ok(lines.some((l) => / step=credential-check .* result=stopped cause=credential-signature /.test(l)), 'a credential that does not verify is the gateway turning the call away');
    assert.ok(lines.some((l) => / step=reply-scan .* result=stopped cause=reply-withheld /.test(l)));
    assert.ok(lines.some((l) => / step=policy-save layer=privilege actor=- result=stopped cause=not-saved /.test(l)));
    assert.ok(lines.some((l) => / step=hold-check .* result=passed cause=passed ev=ev-0003 approval=apr-0001 /.test(l)), 'the retry names the approval it used');
    // the lab clock is in the line as labtime (the engine's stamp), the line's own time is the wall clock
    assert.ok(lines.every((l) => !/labtime=/.test(l) || /labtime=2026-11-02T09:/.test(l)));
    assert.ok(lines.filter((l) => /step=request-check/.test(l)).every((l) => !/labtime=/.test(l)));
    assert.ok(ref);
    // nothing is written for a read, for a Mock table, a Mock write, or an unknown id
    const before = lines.length;
    await get(url, '/api/state?mode=mock&vertical=finance'); await get(url, '/api/state?mode=live', W('obs-live')); await get(url, '/api/run-observability');
    await post(url, '/api/evaluate', { mode: 'mock', vertical: 'finance', request: {} }, W('obs-live'));
    assert.equal(lines.length, before);
  }, { runLog: createRunLog({ write: (l) => lines.push(l) }) });
});

test('hostile values never reach a line or a record: typed names, forged key=value pairs, matcher words, an email or an address as an approver, an end user or a tool, and secret-shaped values in every field', async () => {
  const lines = [];
  const bearer = fragments('sk_', 'live_', 'a1B2c3D4e5F6g7H8i9J0k1L2'); const apiKey = fragments('AKIA', 'ABCDEFGHIJKLMNOP');
  await withServer(async (url) => {
    const ws = 'obs-hostile';
    const mint = async (cl) => (await (await act(url, ws, '/api/token', { token: { claims: cl } })).json()).result?.labToken;
    const typed = ['evil result=passed cause=x', 'refused denied token audience scope', 'a@b.example.com', '10.1.2.3', 'x'.repeat(300), '\n2026-11-02T09:00:00.000Z ai-policies-lab decision step=forged result=passed run=1'];
    for (const who of typed) {
      const t = (await mint(claims({ end_user: who }))) ?? await mint(claims()); // a name the lab will not put in a token (too long, credential-shaped) never reaches the engine
      await act(url, ws, '/api/evaluate', { request: { route: `/mcp/${C.castApp}`, tool: C.castToolWrite, arguments: { record: C.castRecord, amount: 5 }, token: t } });
      await act(url, ws, '/api/evaluate', { request: { route: `/mcp/${C.castApp}`, tool: who, arguments: { record: who, note: bearer }, token: t, headers: { 'x-scopes': apiKey } } });
      const h = await (await act(url, ws, '/api/evaluate', { request: { route: `/mcp/${C.castApp}`, tool: C.castToolHold, arguments: { record: C.castRecord, newValue: C.castNewValue }, token: await mint(claims()) } })).json();
      await act(url, ws, `/api/approvals/${h.result?.approval?.ref ?? 'apr-0001'}/decision`, { decision: { approver: who, decision: 'approve', authLevel: 2, comment: bearer } });
      await act(url, ws, '/api/evaluate', { request: { route: who, tool: C.castToolRead, arguments: { record: 1 }, token: t, labFault: who } });
    }
    await act(url, ws, '/api/evaluate', { request: { route: `/mcp/${C.castApp}`, tool: C.castToolRead, arguments: { record: bearer }, token: fragments('eyJhbGciOi', 'JSUzI1NiJ9.e30.', 'abcdefghij1234567890') } });
    const text = lines.join('\n');
    assert.ok(lines.length > 50);
    for (const s of [bearer, apiKey, 'someone', 'forged', 'attacker']) assert.ok(!text.includes(s), `${s} reached a line`);
    for (const l of lines) { clean(l); assert.ok(!l.includes('\n')); }
    assert.equal(lines.filter((l) => /step=forged|cause=x |result=passed cause=x/.test(l)).length, 0);
    assert.ok(lines.every((l) => (l.match(/ result=/g) || []).length === 1 && (l.match(/ run=/g) || []).length === 1), 'a typed name cannot add a second result or run');
    // the same through the line builder
    const masker = createMasker().mask;
    assert.equal(decisionLine({ step: 'approver-act', layer: 'person', who: 'a@b.example.com', outcome: 'info', cause: '-' }, '2026-11-02T09:00:00.000Z', 'run-1'), '2026-11-02T09:00:00.000Z ai-policies-lab decision step=approver-act layer=person actor=_email_ result=unclear cause=- run=run-1');
    assert.equal(masker('10.1.2.3'), '<ip>');
    assert.equal(decisionLine({ step: 's', layer: 'person', who: '10.1.2.3', outcome: 'info', cause: '-' }, 'T', 'r'), 'T ai-policies-lab decision step=s layer=person actor=_ip_ result=unclear cause=- run=r');
    assert.equal(decisionLine({ step: 's', layer: 'person', who: 'a b\nresult=passed run=x', outcome: 'info', cause: '-' }, 'T', 'r').split(' ').filter((p) => p.startsWith('result=')).length, 1);
  }, { runLog: createRunLog({ write: (l) => lines.push(l) }), env: { STANDALONE_ENV: NO_ENV } });
  assert.equal(lineValue('a b\nc=d'), 'a_b_c_d'); assert.equal(lineValue(''), '-'); assert.equal(lineValue(undefined), '-');
});

test('every step and cause the lab can write passes the shared matchers: each engine code, each approval refusal, every reply kind, with a matcher word as the actor too', () => {
  const read = (f) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
  const found = new Set();
  const grab = (text, re) => { for (const m of text.matchAll(re)) found.add(m[1]); };
  const engine = read('engine.js'); const token = read('token.js'); const canon = read('canon.js'); const actions = read('actions.js');
  grab(engine, /deny\('([a-z_]+)'/g); grab(engine, /return \['([a-z_]+)', /g); grab(engine, /\bcode: '([a-z_]+)'/g); grab(engine, /refuse\('([a-z_]+)'/g);
  grab(token, /fail\('([a-z_]+)'/g); grab(canon, /bad\('([a-z_]+)'/g); grab(canon, /\bcode: '([a-z_]+)'/g); grab(actions, /refuse\('([a-z_]+)'/g);
  assert.ok(found.size >= 60, `the scan found ${found.size} codes`);
  for (const c of ['scope_missing', 'token_expired', 'token_audience', 'attended_refused', 'approval_expired', 'inspection_refused', 'unknown_field']) assert.ok(found.has(c), c);
  const at = '2026-11-02T09:00:00.000Z';
  const evs = [];
  for (const code of found) {
    for (const step of ['credential-check', 'surface-check', 'hold-check', 'request-read', 'approval-step', 'request-check']) evs.push({ step, cause: causeWord(code), layer: 'privilege', outcome: 'refused', who: 'payments-agent' });
    assert.ok(!WORDS.test(causeWord(code)), `${code} -> ${causeWord(code)}`);
  }
  for (const [step, cause, outcome] of [['credential-check', 'verified', 'info'], ['hold-check', 'passed', 'allowed'], ['gateway-answer', 'released', 'info'], ['gateway-answer', 'held', 'info'], ['gateway-answer', 'withheld', 'info'], ['gateway-answer', causeWord('stopped-attended-unattended'), 'info'], ['end-user-claim', 'on-roster', 'info'], ['end-user-claim', 'no-one', 'info'], ['approval-step', 'approved', 'allowed'], ['approval-step', 'signed-pending', 'info'], ['approval-step', 'approver-declined', 'refused'], ['policy-save', 'not-saved', 'blocked'], ...['self-approval', 'role-missing', 'weak-sign-in', 'level-unavailable', 'already-signed', 'not-an-approver', 'already-decided'].map((c) => ['approval-step', c, 'refused'])]) evs.push({ step, cause, outcome, layer: 'privilege', who: 'priya.nair', approval: 'apr-0001', ev: 'ev-0001', labtime: at });
  const replies = [['tools/list', { ok: true, tools: [{}] }], ['tools/list', { ok: true, tools: [] }], ['tools/list', { ok: false, refusal: { status: 401 } }], ['tools/list', { ok: false, refusal: { status: 403 } }], ['tools/list', { ok: false, refusal: { status: 500 } }], ['probe', { ok: true, isError: true, text: 'x' }], ['probe', { ok: true, isError: false, text: 'x' }], ['probe', { ok: true, isError: false, text: '' }], ['probe', { ok: false, refusal: { status: null, message: 'boom' } }], ['probe', { ok: false, refusal: { status: null, message: 'reply is not JSON' } }], ['probe', { ok: false, refusal: { status: 403 } }]];
  for (const [step, r] of replies) evs.push({ ...replyOf(step, r), step: step === 'probe' ? 'gateway-probe' : 'gateway-list', layer: 'gateway', who: 'lab_agent' });
  evs.push({ step: 'gateway-list', layer: 'gateway', who: 'lab_agent', noReply: true, cause: 'no-reply' });
  for (const ev of evs) for (const who of [ev.who, 'refused', 'token', 'scope.audience']) {
    const line = decisionLine({ ...ev, who }, at, 'act-abc123-1');
    // a matcher word as the actor is the one place the words may appear (a roster name is never one); the test still reads the line whole through the matchers
    assert.match(line, LINE); if (who === ev.who) assert.ok(!WORDS.test(line), line); noMatcherReads(line);
  }
  assert.match(decisionLine(evs.at(-1), at, 'r'), / result=no-reply cause=no-reply run=r$/);
  assert.equal(causeWord('token_expired'), 'credential-lapsed'); assert.equal(causeWord('scope_missing'), 'permission-missing'); assert.equal(causeWord('attended_refused'), 'attended-turned-away');
});

// ---- Real: what the lab received from the Privilege gateway ---------------------------------------------------------------------------------------
test('Real: a gateway check is one stdout line and one `response` row per reply, stamped when the reply came in (not after the session close); the key and the gateway address are in neither', async () => {
  const lines = [];
  let t = Date.UTC(2026, 10, 22, 12, 0, 0);
  const runLog = createRunLog({ write: (l) => lines.push(l), clock: () => { t += 1000; return t; } }); // begin 12:00:01, list started 12:00:02, probe started 12:00:03, end 12:00:04
  await withGateway(async (url, gw) => {
    const echo = ({ json }) => json({ message: `denied for ${KEY} at ${gw.url}` }, 403);
    gw.script.list = ({ m, json }) => json({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: `tool-${KEY}`, description: `see ${gw.url}` }, { name: 'b', description: 'c' }] } });
    gw.script.call = echo;
    assert.equal((await post(url, '/api/gateway-check', {})).status, 409);
    assert.equal((await record(url)).record.source, 'mock');
    await toReal(url);
    const out = await check(url);
    assert.equal(out.listing.ok, true); assert.equal(out.refusal.ok, false); assert.match(out.runId, /^gw-[0-9a-f]{6}-\d+$/);
    const { record: rec } = await record(url, `?runId=${out.runId}`);
    assert.deepEqual(assertRunObservability(rec), []);
    assert.equal(rec.source, 'real'); assert.equal(rec.runId, out.runId);
    assert.deepEqual(rows(rec).map((r) => [r.layer, r.outcome, r.origin]), [['gateway', 'allowed', 'response'], ['gateway', 'refused', 'response']]);
    assert.ok(rec.rows.every((r) => r.origin !== 'logged' && r.origin !== 'simulated' && !r.basis && !r.matchedBy));
    assert.deepEqual(rec.coverage, { person: 'not-logged', agent: 'not-logged', authorize: 'not-logged', privilege: 'not-logged', gateway: 'response', resource: 'not-logged' });
    assert.match(rec.reasons.privilege, /stays in the lab in Real too.*"What Privilege did" \(simulated\)/s);
    assert.match(rows(rec)[0].message, /2 tools/); assert.match(rows(rec)[1].message, /HTTP 403 while the lab was opening or making the refusal probe.*answer the probe expects/s);
    assert.match(rows(rec)[0].message, /reply the lab received, not a gateway log line/);
    const everything = JSON.stringify(rec) + lines.join('\n');
    assert.ok(!everything.includes(KEY) && !everything.includes('127.0.0.1') && !everything.includes(`:${gw.port}`), 'no key and no gateway address');
    assert.equal(gw.seen.find((s) => s.method === 'tools/list').auth, `Bearer ${KEY}`, 'the lab did send the key to the gateway');
    // the time of a row is when the call started plus how long it took: the helper's own close (a DELETE) is after the reply and is not in it
    const base = Date.UTC(2026, 10, 22, 12, 0, 0);
    assert.equal(Date.parse(rows(rec)[0].at), base + 2000 + out.listing.ms); assert.equal(Date.parse(rows(rec)[1].at), base + 3000 + out.refusal.ms);
    assert.equal(lines.length, 2); lines.forEach((l) => clean(l));
    assert.deepEqual(lines.map((l) => l.split(' ')[0]), rows(rec).map((r) => r.atExact), 'the row time is the stdout line time');
    assert.match(lines[0], / step=gateway-list layer=gateway actor=lab_agent result=passed cause=tools-listed run=gw-/);
    assert.match(lines[1], / step=gateway-probe .* result=stopped cause=status-403 run=gw-/);
  }, { runLog });
});

test('Real: a slow session close does not move a row\'s time: it is the reply\'s, however long the helper keeps the connection after it', async () => {
  const lines = [];
  await withGateway(async (url, gw) => {
    gw.script.list = tools(2); gw.script.call = status(403);
    await toReal(url);
    const started = Date.now();
    const out = await check(url);
    const ended = Date.now();
    assert.ok(ended - started >= 1500, `the check took ${ended - started} ms because each call waits for the close`);
    const { record: rec } = await record(url, `?runId=${out.runId}`);
    for (const r of rows(rec)) assert.ok(Date.parse(r.at) <= ended - 700, `${r.at} is not after the close`);
    for (const l of lines) assert.ok(Date.parse(l.split(' ')[0]) <= ended - 700);
  }, { closeDelayMs: 800, runLog: createRunLog({ write: (l) => lines.push(l) }) });
});

test('Real: how each kind of reply is read (401 and 403 refused, a usable 200 allowed, a JSON-RPC error or isError refused, an unparsed body or another status information)', async () => {
  const cases = [
    { name: 'list 401', list: status(401), want: [['refused', 'status-401']], probeSent: false },
    { name: 'list 403', list: status(403), want: [['refused', 'status-403']], probeSent: false },
    { name: 'list 500', list: status(500), want: [['info', 'status-500']], probeSent: false },
    { name: 'list not JSON', list: rawText, want: [['info', 'unreadable']], probeSent: false },
    { name: 'list JSON-RPC error', list: rpcError('no'), want: [['refused', 'jsonrpc-error']], probeSent: false },
    { name: 'list empty', list: tools(0), call: status(403), want: [['info', 'empty-list'], ['refused', 'status-403']] },
    { name: 'probe 401', list: tools(2), call: status(401), want: [['allowed', 'tools-listed'], ['refused', 'status-401']] },
    { name: 'probe isError', list: tools(2), call: rpcResult({ isError: true, content: [{ type: 'text', text: 'no' }] }), want: [['allowed', 'tools-listed'], ['refused', 'tool-error']] },
    { name: 'probe JSON-RPC error', list: tools(2), call: rpcError('policy says no'), want: [['allowed', 'tools-listed'], ['refused', 'jsonrpc-error']] },
    { name: 'probe 200 with a result', list: tools(2), call: rpcResult({ content: [{ type: 'text', text: 'ok' }] }), want: [['allowed', 'tools-listed'], ['allowed', 'tool-ran']] },
    { name: 'probe 200 with nothing to read', list: tools(2), call: rpcResult({ content: [] }), want: [['allowed', 'tools-listed'], ['info', 'no-content']] },
    { name: 'probe 502', list: tools(2), call: status(502), want: [['allowed', 'tools-listed'], ['info', 'status-502']] },
    { name: 'probe not JSON', list: tools(2), call: rawText, want: [['allowed', 'tools-listed'], ['info', 'unreadable']] },
  ];
  for (const c of cases) {
    const lines = [];
    await withGateway(async (url, gw) => {
      gw.script.list = c.list; gw.script.call = c.call || status(418, 'the probe must not be sent');
      await toReal(url);
      const out = await check(url);
      const { record: rec } = await record(url, `?runId=${out.runId}`);
      assert.deepEqual(assertRunObservability(rec), [], c.name);
      assert.deepEqual(rows(rec).map((r) => r.outcome), c.want.map((w) => w[0]), c.name);
      assert.deepEqual(lines.map((l) => /cause=(\S+)/.exec(l)[1]), c.want.map((w) => w[1]), c.name);
      if (c.probeSent === false) {
        assert.ok(!gw.seen.some((s) => s.method === 'tools/call'), c.name);
        assert.match(rec.reasons.gateway, /only sent after tools\/list is answered with a tool list/, c.name);
      }
      assert.ok(rows(rec).every((r) => r.origin === 'response'));
    }, { runLog: createRunLog({ write: (l) => lines.push(l) }) });
  }
});

test('Real: a call that got no reply is no row and no pass: a no-reply line, and the layer says why; an earlier status is never borrowed', async () => {
  const lines = [];
  await withGateway(async (url, gw) => {
    await toReal(url);
    gw.script.list = drop; gw.script.call = status(403);
    let out = await check(url);
    assert.equal(out.listing.ok, false);
    let { record: rec } = await record(url, `?runId=${out.runId}`);
    assert.equal(rows(rec).length, 0); assert.equal(rec.coverage.gateway, 'not-logged'); assert.match(rec.reasons.gateway, /tools\/list call got no reply/);
    assert.deepEqual(assertRunObservability(rec), []);
    assert.match(lines.at(-1), / step=gateway-list .* result=no-reply cause=no-reply run=gw-/);
    gw.script.list = tools(3); gw.script.call = drop;
    out = await check(url);
    ({ record: rec } = await record(url, `?runId=${out.runId}`));
    assert.deepEqual(rows(rec).map((r) => r.outcome), ['allowed']);
    assert.equal(rec.coverage.gateway, 'response'); assert.match(rec.reasons.gateway, /refusal probe got no reply/);
    assert.match(lines.at(-1), / step=gateway-probe .* result=no-reply /);
    assert.deepEqual(assertRunObservability(rec), []);
  }, { runLog: createRunLog({ write: (l) => lines.push(l) }) });
});

test('Real runs are kept in a bounded list, newest last, with ids that never repeat; the id is unique across checks, Live actions, Resets and workspaces', async () => {
  await withGateway(async (url, gw) => {
    gw.script.list = tools(1); gw.script.call = status(403);
    await toReal(url);
    const ids = [];
    for (let i = 0; i < KEEP_RUNS + 2; i += 1) ids.push((await check(url)).runId);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal((await record(url)).record.runId, ids.at(-1));
    assert.equal((await record(url, `?runId=${ids.at(-KEEP_RUNS)}`)).record.runId, ids.at(-KEEP_RUNS), 'the oldest kept run is still there');
    assert.equal((await record(url, `?runId=${ids[0]}`)).record, null, 'an evicted run says so');
    const out = []; const log = createRunLog({ write: (l) => out.push(l) });
    const a = log.beginCheck('lab-agent'); const b = log.beginCheck('lab-agent'); a.end(); b.end();
    log.live({ events: [{ step: 'gateway-answer', layer: 'gateway', who: null, outcome: 'info', cause: 'released' }] });
    log.live({ events: [{ step: 'gateway-answer', layer: 'gateway', who: null, outcome: 'info', cause: 'released' }] });
    const all = [a.id, b.id, ...out.map((l) => / run=(\S+)$/.exec(l)[1])];
    assert.equal(new Set(all).size, 4);
    assert.notEqual(createRunLog().beginCheck('x').id, createRunLog().beginCheck('x').id, 'two processes never share an id');
    const open = log.beginCheck('lab-agent'); for (let i = 0; i < KEEP_RUNS + 2; i += 1) log.beginCheck('x').end();
    assert.equal(log.get(open.id), null); open.end(); assert.equal(log.get(open.id).id, open.id);
  });
});

test('a recorder that throws never breaks the run or the audit: the lab answers as before and says why on stderr, with a code and a fixed text', async () => {
  const boom = (code) => () => { throw Object.assign(new Error(`recorder is broken for ${KEY} and https://gateway.example.invalid`), { code }); };
  const baseline = async () => {
    const workspaces = createWorkspaces(); let answers;
    await withServer(async (url) => { answers = (await liveSession(url, 'obs-boom')).answers; }, { workspaces, runLog: createRunLog({ write: () => {} }) });
    return { answers, audit: JSON.stringify(workspaces.peek('obs-boom', 'finance').audit) };
  };
  const base = await baseline();
  const workspaces = createWorkspaces(); let thrown;
  const err = await stderrOf(async () => {
    await withGateway(async (url, gw, ctx) => {
      thrown = (await liveSession(url, 'obs-boom')).answers;
      gw.script.list = tools(1); gw.script.call = status(403);
      await toReal(url);
      const out = await check(url);
      assert.equal(out.listing.ok, true); assert.equal(out.runId, undefined, 'no run was kept, and the answer says nothing about one');
      const rec = await get(url, '/api/run-observability');
      assert.equal(rec.status, 500); assert.deepEqual(Object.keys(await rec.json()).sort(), ['error', 'message']);
      assert.ok(ctx.workspaces.peek('obs-boom', 'finance').audit.length > 0);
    }, { runLog: { live: boom('E_BOOM'), beginCheck: boom('E_BEGIN'), get: boom('E_GET') } });
  });
  assert.deepEqual(thrown, base.answers, 'every answer is the baseline\'s');
  assert.match(err, /run observability: live-decisions E_BOOM \(the error's text is not logged\)/);
  assert.match(err, /run observability: begin-check E_BEGIN/); assert.match(err, /run observability: record E_GET/);
  assert.ok(!/recorder is broken|gateway\.example|fake-agent/.test(err), 'the error text is not on stderr');
  assert.ok(workspaces);
  // the audit trail with a throwing recorder is the baseline's
  const audit = async (runLog) => { const ws = createWorkspaces(); await withServer(async (url) => { await liveSession(url, 'obs-boom'); }, { workspaces: ws, runLog }); return JSON.stringify(ws.peek('obs-boom', 'finance').audit); };
  let thrownAudit; await stderrOf(async () => { thrownAudit = await audit({ live: boom('E_BOOM'), beginCheck: boom('E'), get: boom('E') }); });
  assert.equal(thrownAudit, base.audit);
});

test('one failed write does not drop the rest of an action\'s lines; the answers and the audit trail are the baseline\'s', async () => {
  const run = async (write) => {
    const workspaces = createWorkspaces(); let answers;
    await withServer(async (url) => { answers = (await liveSession(url, 'obs-write')).answers; }, { runLog: createRunLog({ write }), workspaces });
    return { answers, audit: JSON.stringify(workspaces.peek('obs-write', 'finance').audit) };
  };
  const base = []; const baseline = await run((l) => base.push(l));
  const got = []; let n = 0; let thrown;
  const err = await stderrOf(async () => { thrown = await run((l) => { if (++n === 3) throw new Error('disk full'); got.push(l); }); });
  assert.equal(n, base.length, 'every line was still tried');
  const same = (l) => l.split(' ').slice(1).join(' ').replace(/ run=\S+$/, '');
  assert.deepEqual(got.map(same), base.filter((_l, i) => i !== 2).map(same), 'all lines but the one that could not be written');
  assert.deepEqual(thrown.answers, baseline.answers); assert.equal(thrown.audit, baseline.audit);
  assert.equal([...err.matchAll(/run observability: live-line /g)].length, 1, 'the failure is reported once, on stderr');
  assert.ok(!/disk full/.test(err));
});

test('the lab keeps the key and the gateway address out of the record when a reply carries them in every field it could', async () => {
  const text = {};
  await withGateway(async (url, gw) => {
    const dirty = (code) => ({ json }) => json({ jsonrpc: '2.0', id: 1, error: { code, message: `${KEY} ${gw.url} Bearer ${KEY}` }, message: `${KEY} ${gw.url}` }, 403);
    gw.script.list = ({ m, json }) => json({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: KEY, description: gw.url }] } });
    for (const call of [dirty(403), rpcResult({ isError: true, content: [{ type: 'text', text: `${KEY} ${gw.url}` }] }), rpcError(`${KEY} ${gw.url}`)]) {
      gw.script.call = call;
      await toReal(url);
      const out = await check(url);
      text[out.runId] = JSON.stringify((await record(url, `?runId=${out.runId}`)).record);
    }
  });
  assert.equal(Object.keys(text).length, 3);
  for (const t of Object.values(text)) assert.ok(!t.includes(KEY) && !t.includes('127.0.0.1') && !/Bearer \w/.test(t));
});

test('a Real record is built from the lab\'s own events alone and keeps no word of the gateway\'s', async () => {
  const run = { id: 'gw-abcdef-1', source: 'real', caller: 'lab_agent', startedAt: '2026-11-22T12:00:00.000Z', endedAt: '2026-11-22T12:00:01.000Z', notes: [], events: [{ ...replyOf('tools/list', { ok: true, tools: [{ name: 'x' }], ms: 5 }), at: '2026-11-22T12:00:00.500Z', layer: 'gateway', product: 'Privilege gateway reply', who: 'lab_agent' }] };
  const rec = await realRecord(run);
  assert.deepEqual(assertRunObservability(rec), []);
  assert.deepEqual(rows(rec).map((r) => r.detail), [{ step: 'tools/list', tools: 1, ms: 5, eventSeq: 0 }]);
  assert.equal(replyOf('probe', null), null); assert.equal(replyOf('probe', 'text'), null);
});

test('a refusal that arrives while the lab is opening a call is not worded as the answer to tools/list: the shared client does not say which request got it', async () => {
  const cases = [
    { name: 'initialize 403', set: (g) => { g.initFail = 403; }, cause: 'status-403' },
    { name: 'initialize 401', set: (g) => { g.initFail = 401; }, cause: 'status-401' },
    { name: 'notifications/initialized 401', set: (g) => { g.notifyFail = 401; }, cause: 'status-401' },
    { name: 'initialize JSON-RPC error', set: (g) => { g.initRpcError = true; }, cause: 'jsonrpc-error' },
  ];
  for (const c of cases) {
    const lines = [];
    await withGateway(async (url, gw) => {
      c.set(gw); gw.script.list = tools(2); gw.script.call = status(403);
      await toReal(url);
      const out = await check(url);
      assert.ok(!gw.seen.some((s) => s.method === 'tools/list'), `${c.name}: tools/list was never sent`);
      const [row] = rows((await record(url, `?runId=${out.runId}`)).record);
      assert.equal(row.outcome, 'refused', c.name);
      assert.match(row.message, /while the lab was opening or making tools\/list/, c.name);
      assert.ok(!/answered tools\/list with/.test(row.message), c.name);
      assert.notEqual(row.detail.step, 'tools/list', `${c.name}: a step the lab does not know is not claimed`);
      assert.equal(row.detail.during, 'tools/list');
      assert.match(lines[0], new RegExp(`cause=${c.cause} `));
    }, { runLog: createRunLog({ write: (l) => lines.push(l) }) });
  }
  assert.equal(replyOf('tools/list', { ok: true, tools: [{}], ms: 1 }).detail.step, 'tools/list');
  assert.equal(replyOf('probe', { ok: true, isError: true, text: 'x', ms: 1 }).detail.step, 'probe');
});

test('a gateway refusal that uses the shared client\'s own "unreachable" or "timed out" words is read as no connection: the layer says so, and it is never shown as allowed', async () => {
  for (const words of ['MCP HTTP request unreachable (ECONNREFUSED)', 'MCP HTTP request timed out after 15000ms']) {
    await withGateway(async (url, gw) => {
      gw.script.list = rpcError(words); gw.script.call = status(403);
      await toReal(url);
      const out = await check(url);
      const { record: rec } = await record(url, `?runId=${out.runId}`);
      assert.equal(rows(rec).length, 0, 'no row, so nothing shown as allowed');
      assert.ok(!rec.rows.some((r) => r.outcome === 'allowed'));
      assert.match(rec.reasons.gateway, /did not connect, or it timed out/);
      assert.match(rec.reasons.gateway, /exactly the shared client's "unreachable" or "timed out" words as no connection.*could, in rare cases, be read this way.*never shown as allowed/s);
      assert.deepEqual(assertRunObservability(rec), []);
    });
  }
});

test('Real: a fault with no HTTP status that is not a JSON-RPC error is information, never a gateway refusal (the reply is cut short mid-body)', async () => {
  const lines = [];
  // The status and headers arrive, then the connection drops while the body is read: the client rethrows that fault with no code of its own.
  const cutShort = ({ res }) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"jsonrpc":"2.0","id":'); setTimeout(() => res.destroy(), 20); };
  await withGateway(async (url, gw) => {
    gw.script.list = cutShort; gw.script.call = status(403);
    await toReal(url);
    const out = await check(url);
    assert.equal(out.listing.ok, false);
    const { record: rec } = await record(url, `?runId=${out.runId}`);
    assert.deepEqual(rows(rec).map((r) => r.outcome), ['info'], 'a dropped reply is not shown as a refusal');
    assert.equal(lines.length, 1);
    assert.match(lines[0], / result=unclear cause=transport-fault /);
    assert.ok(!lines.some((l) => / result=stopped /.test(l)));
    assert.deepEqual(assertRunObservability(rec), []);
  }, { runLog: createRunLog({ write: (l) => lines.push(l) }) });
  // the reading itself: only a JSON-RPC error is a refusal; a fault with no status and no code is information, and "no reply" is no row
  const fault = replyOf('tools/list', { ok: false, refusal: { status: null, code: null, message: 'socket hang up' } });
  assert.deepEqual([fault.outcome, fault.cause], ['info', 'transport-fault']);
  assert.equal(replyOf('tools/list', { ok: false, refusal: { status: null, code: 'mcp_rpc_error', message: 'no' } }).cause, 'jsonrpc-error');
  assert.equal(replyOf('tools/list', { ok: false, refusal: { status: null, code: 'mcp_no_reply', message: 'MCP HTTP reply had no result' } }), null);
});

test('Real: an empty reply to a call that expects one is no reply, never an empty tool list or an answer (a tools/list or a probe)', async () => {
  const lines = [];
  const empty = ({ res }) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(); };
  await withGateway(async (url, gw) => {
    gw.script.list = empty; gw.script.call = status(403);
    await toReal(url);
    const out = await check(url);
    assert.equal(out.listing.ok, false);
    const { record: rec } = await record(url, `?runId=${out.runId}`);
    assert.equal(rows(rec).length, 0, 'an empty reply is not a listing of zero tools');
    assert.match(rec.reasons.gateway, /tools\/list call got no reply/);
    assert.match(lines.at(-1), / step=gateway-list .* result=no-reply cause=no-reply /);
    assert.deepEqual(assertRunObservability(rec), []);
    assert.ok(!gw.seen.some((s) => s.method === 'tools/call'), 'the probe waits for a tool list');
  }, { runLog: createRunLog({ write: (l) => lines.push(l) }) });
  lines.length = 0;
  await withGateway(async (url, gw) => {
    gw.script.list = tools(2); gw.script.call = empty;
    await toReal(url);
    const out = await check(url);
    const { record: rec } = await record(url, `?runId=${out.runId}`);
    assert.deepEqual(rows(rec).map((r) => r.outcome), ['allowed'], 'the tool list is a real answer; the empty probe reply is not');
    assert.match(rec.reasons.gateway, /refusal probe got no reply/);
    assert.match(lines.at(-1), / step=gateway-probe .* result=no-reply /);
    assert.deepEqual(assertRunObservability(rec), []);
  }, { runLog: createRunLog({ write: (l) => lines.push(l) }) });
});

test('a result-less initialize reply is accepted as before (the handshake takes its defaults); only tools/list and the probe count an empty reply as no reply', async () => {
  const lines = [];
  const empty = ({ res }) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(); };
  await withGateway(async (url, gw) => {
    gw.initEmpty = true; gw.script.list = tools(2); gw.script.call = status(403);
    await toReal(url);
    const out = await check(url);
    assert.equal(out.listing.ok, true, 'a result-less initialize is not a failed handshake');
    const { record: rec } = await record(url, `?runId=${out.runId}`);
    assert.deepEqual(rows(rec).map((r) => r.outcome), ['allowed', 'refused'], 'the tool list and the probe are read as before');
    assert.deepEqual(assertRunObservability(rec), []);
  }, { runLog: createRunLog({ write: (l) => lines.push(l) }) });
  lines.length = 0;
  await withGateway(async (url, gw) => {
    gw.initEmpty = true; gw.script.list = empty; gw.script.call = status(403);
    await toReal(url);
    const out = await check(url);
    assert.equal(out.listing.ok, false);
    const { record: rec } = await record(url, `?runId=${out.runId}`);
    assert.equal(rows(rec).length, 0, 'a result-less tools/list is a no-reply, not an empty listing');
    assert.match(rec.reasons.gateway, /tools\/list call got no reply/);
    assert.match(lines.at(-1), / step=gateway-list .* result=no-reply cause=no-reply /);
    assert.deepEqual(assertRunObservability(rec), []);
  }, { runLog: createRunLog({ write: (l) => lines.push(l) }) });
});

test('the Real record and the stdout line do not depend on a declared caller id: rows are identical for any caller label, and a label that looks like a key is masked, never shortened', async () => {
  const label = fragments('SK_LIVE_', 'A1B2C3D4E5F6G7H8'); const secretLike = fragments('sk_live_', 'a1b2c3d4e5f6g7h8');
  const seen = {};
  for (const [name, key] of [['plain', 'LAB_AGENT'], ['secretLike', label]]) {
    const lines = [];
    await withGateway(async (url, gw) => {
      gw.script.list = tools(2); gw.script.call = status(403);
      await toReal(url);
      const out = await check(url);
      assert.equal(out.listing.ok, true);
      seen[name] = { rec: (await record(url, `?runId=${out.runId}`)).record, lines: [...lines] };
    }, { key, runLog: createRunLog({ write: (l) => lines.push(l) }) });
  }
  const strip = (rec) => rec.rows.map(({ id, at, atExact, detail, ...r }) => ({ ...r, detail: { ...detail, ms: 0 } }));
  assert.deepEqual(strip(seen.plain.rec), strip(seen.secretLike.rec), 'rows do not carry the caller label at all');
  assert.ok(seen.plain.lines.every((l) => / actor=lab_agent /.test(l)), 'a plain label stays readable (not lab__nt)');
  for (const l of seen.secretLike.lines) { assert.match(l, / actor=sk__ /, 'a key-shaped label is masked whole'); assert.ok(!l.includes(secretLike) && !/sk_l|_ef /.test(l)); }
  assert.ok(!JSON.stringify(seen.secretLike.rec).includes(secretLike));
});

test('validation failures begin no run: no rows, no run id, one line with no run; the Mock record route never returns a run id it cannot find', async () => {
  const lines = [];
  await withServer(async (url) => {
    const r = await act(url, 'obs-val', '/api/evaluate', { request: { bogus: 1 } });
    assert.equal(r.status, 400); const b = await r.json();
    assert.equal(b.runId, undefined); assert.equal(lines.length, 1); assert.match(lines[0], / run=-$/);
    const body = await (await act(url, 'obs-val', '/api/clock', { clock: { minutes: 0 } })).json();
    assert.equal(body.ok, false); assert.equal(lines.length, 1, 'a refused clock move is not a decision and writes nothing');
    assert.equal(JSON.stringify(await record(url)).includes('obs-val'), false);
  }, { runLog: createRunLog({ write: (l) => lines.push(l) }) });
});

test('no server file but the vendored core names a log reader, and the compose file, the example settings and the Dockerfile carry no run-observability setting and no Docker socket', () => {
  for (const f of ['docker-compose.yml', '.env.example', 'Dockerfile']) {
    const text = fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
    assert.ok(!/docker\.sock|RUN_OBS_/.test(text), f);
  }
  assert.ok(fs.existsSync(new URL('../src/runObs.js', import.meta.url)));
  assert.ok(!fs.existsSync(new URL('../src/runObservabilityReaders.js', import.meta.url)));
});
