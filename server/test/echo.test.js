// A credential the visitor types must come back in NO response field, hop pane, outbox entry, audit entry, log line or error: tested by typing every
// credential shape into every place a request can carry text, on every endpoint, and searching every answer (and the process output) for it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { C, get, post, put, withServer } from './helpers.js';
import { SECRETS } from './secrets.js';
import { sweep as sweepAll } from './sweep.js';

const NEEDLES = Object.fromEntries(Object.entries(SECRETS).map(([k, v]) => [k, { raw: v, probe: k === 'pem' ? 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC' : k === 'bearer' ? 'tokenvalue' : k === 'assignment' ? 'hunter2hunter2' : v }]));
const W = (id) => ({ 'x-workspace': id });
const live = (extra = {}) => ({ mode: 'live', vertical: 'finance', ...extra });
const route = `/mcp/${C.castApp}`;

test('typing every credential shape into every field of every endpoint never echoes it', async () => {
  const out = []; const realOut = process.stdout.write.bind(process.stdout); const realErr = process.stderr.write.bind(process.stderr);
  await withServer(async (url) => {
    const good = (await (await post(url, '/api/token', live({ token: { claims: { sub: C.castAgent, surfaces: ['tool'], scope: `${C.castApp}:write`, department: C.castDept, end_user: C.castUser } } }))).json()).result.labToken;
    await post(url, '/api/evaluate', live({ request: { route, tool: C.castToolHold, arguments: { record: 'r', newValue: 'n' }, token: good } }));
    const sweep = (v) => sweepAll(url, v, good);
    process.stdout.write = (c, ...a) => { out.push(String(c)); return realOut(c, ...a); }; process.stderr.write = (c, ...a) => { out.push(String(c)); return realErr(c, ...a); };
    try {
      for (const [name, n] of Object.entries(NEEDLES)) {
        const texts = await sweep(n.raw);
        const bad = texts.filter((t) => t.includes(n.probe));
        assert.equal(bad.length, 0, `${name}: the raw value is in an answer: ${bad.map((l) => l.slice(0, 200)).join(' | ')}`);
        const state = JSON.stringify(await (await get(url, '/api/state?mode=live')).json());
        assert.ok(!state.includes(n.probe), `${name}: absent from the state`);
      }
    } finally { process.stdout.write = realOut; process.stderr.write = realErr; }
  });
  for (const n of Object.values(NEEDLES)) assert.ok(!out.join('').includes(n.probe), 'nothing was logged');
});

test('a credential in an accepted evaluation is masked in the answer, the hops, the approval summary, the outbox and the audit', async () => {
  await withServer(async (url) => {
    for (const [name, n] of Object.entries(NEEDLES)) {
      const ws = `echo-${name.toLowerCase()}`.slice(0, 30).replace(/[^a-z0-9-]/g, '-');
      const tokenRes = await post(url, '/api/token', live({ token: { claims: { sub: C.castAgent, surfaces: ['tool'], scope: `${C.castApp}:write`, department: C.castDept, end_user: C.castUser } } }), W(ws));
      const token = (await tokenRes.json()).result.labToken;
      const r = await post(url, '/api/evaluate', live({ request: { route, tool: C.castToolHold, arguments: { record: 'r', newValue: `please ${n.raw} thanks` }, token } }), W(ws));
      const body = await r.text();
      assert.equal(r.status, 403, name); assert.ok(!body.includes(n.probe), `${name}: not in the answer`); assert.match(body, /\[masked:/);
      assert.ok(!body.includes(token.slice(20, 60)), 'the token is not echoed by the evaluation either');
      const d = await post(url, '/api/approvals/apr-0001/decision', live({ decision: { approver: C.castApprover, decision: 'approve', authLevel: 2, comment: `ok ${n.raw}` } }), W(ws));
      const db = await d.text(); assert.equal(d.status, 200); assert.ok(!db.includes(n.probe), `${name}: decision`);
      assert.ok(db.includes('"outbox"') && db.includes('"audit"') && db.includes('"hops"') && db.includes('"approvals"'));
    }
  });
});
test('field names are not echoed either: an unknown key that is itself a credential never comes back', async () => {
  await withServer(async (url) => {
    for (const n of Object.values(NEEDLES)) {
      for (const [m, p, b] of [['POST', '/api/evaluate', live({ request: { [n.raw]: 1 } })], ['POST', '/api/token', live({ token: { claims: { [n.raw]: 1 } } })], ['PUT', '/api/policies/users', live({ rules: [{ id: 'x', [n.raw]: 1 }] })], ['POST', '/api/clock', live({ clock: { [n.raw]: 1 } })]]) {
        const r = await (m === 'PUT' ? put : post)(url, p, b); const t = await r.text();
        assert.ok(r.status >= 400, p); assert.ok(!t.includes(n.probe), p);
      }
    }
  });
});
test('the token the visitor holds is never echoed by an evaluation (only a masked trace and the decoded claims)', async () => {
  await withServer(async (url) => {
    const token = (await (await post(url, '/api/token', live({ token: { claims: { sub: C.castAgent, surfaces: ['tool'], scope: `${C.castApp}:read`, department: C.castDept } } }))).json()).result.labToken;
    const r = await (await post(url, '/api/evaluate', live({ request: { route, tool: C.castToolRead, arguments: { record: 'r' }, token } }))).text();
    assert.ok(!r.includes(token) && !r.includes(token.split('.')[2]));
    const tampered = await (await post(url, '/api/evaluate', live({ request: { route, tool: C.castToolRead, arguments: { record: 'r' }, token: `${token}zz` } }))).text();
    assert.ok(!tampered.includes(token.split('.')[2]) && !tampered.includes(token.split('.')[1]));
  });
});

test('defence in depth: a credential that somehow reaches engine state is still masked by the response mask on every answer', async () => {
  await withServer(async (url, { workspaces }) => {
    const e = workspaces.engine('default', 'finance', C);
    for (const [name, n] of Object.entries(NEEDLES)) {
      e.outbox.push({ id: `out-x-${name}`, at: 'now', channel: 'slack', label: 'x', to: [], ref: 'apr-0001', subject: `leak ${n.raw}`, expiresAt: 'x', delivered: false });
      const text = await (await get(url, '/api/state?mode=live')).text();
      assert.ok(!text.includes(n.probe), `${name}: the response mask must catch it`);
      e.outbox.pop();
    }
  });
});
