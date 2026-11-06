// The edge of the HTTP app (shared-masker docs/EXPRESS-RECIPE.md): a charset problem is a 415 with a fixed body, a known route with the wrong method is a 405 with Allow from
// ONE route table, a credential-looking workspace id is a 400 bad_workspace before any slot exists and is never echoed, the last handlers answer fixed JSON that never
// holds input, and the response mask covers values AND keys on every answer. Secret-shaped values are assembled at run time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { C, get, post, put, rawHttp, withServer } from './helpers.js';
import { API_ROUTES } from '../src/app.js';
import { scrub } from '../src/service.js';

const H = ['hunter', '2xyz'].join('');
const live = (extra = {}) => ({ mode: 'live', vertical: 'finance', ...extra });
const clock = live({ clock: { minutes: 1 } });
const capture = async (fn) => {
  const out = []; const w1 = process.stdout.write.bind(process.stdout); const w2 = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c, ...a) => { out.push(String(c)); return w1(c, ...a); }; process.stderr.write = (c, ...a) => { out.push(String(c)); return w2(c, ...a); };
  try { await fn(); } finally { process.stdout.write = w1; process.stderr.write = w2; }
  return out.join('');
};

test('415: a charset other than utf-8 is answered with a fixed body on any method and any path, and nothing typed is answered or logged', async () => {
  const typed = [`utf-16`, `latin1`, `"${H}"`, `x${H}`, 'utf-8; charset=utf-16'];
  await withServer(async (url, { workspaces }) => {
    const logged = await capture(async () => {
      for (const cs of typed) {
        for (const [m, p] of [['POST', '/api/evaluate'], ['POST', '/api/clock'], ['PUT', '/api/policies/apps'], ['GET', '/api/state'], ['POST', '/nowhere'], ['GET', '/api/health']]) {
          const r = await fetch(`${url}${p}`, { method: m, headers: { origin: url, 'content-type': `application/json; charset=${cs}` }, body: m === 'GET' ? undefined : '{}' });
          assert.equal(r.status, 415, `${m} ${p} ${cs}`);
          assert.equal(await r.text(), '{"error":"unsupported_charset"}', `${m} ${p}`);
        }
      }
    });
    assert.equal(logged.includes(H), false, 'nothing typed was logged');
    assert.equal(workspaces.size(), 0, 'no slot was taken');
    for (const ok of ['application/json', 'application/json; charset=utf-8', 'application/json; charset="UTF-8"']) {
      const r = await fetch(`${url}/api/clock`, { method: 'POST', headers: { origin: url, 'content-type': ok }, body: JSON.stringify(clock) });
      assert.equal(r.status, 200, ok);
    }
  });
});

test('405: the route table is the one place the methods live: every route, every other method, Allow from the table, HEAD wherever GET is', async () => {
  const entries = Object.entries(API_ROUTES);
  assert.equal(entries.length, 14);
  assert.deepEqual(Object.values(API_ROUTES).map((m) => m.join('')).sort(), ['GET', 'GET', 'GET', 'GET', 'GET', 'POST', 'POST', 'POST', 'POST', 'POST', 'POST', 'POST', 'POST', 'PUT']);
  await withServer(async (url) => {
    const host = new URL(url).host;
    for (const [key, methods] of entries) {
      const p = key.replace(/:[a-z]+/g, 'x-1');
      const allow = methods[0] === 'GET' ? 'GET, HEAD' : methods[0];
      for (const m of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']) {
        const r = await rawHttp(`${url}${p}`, { method: m, headers: { host, origin: url, 'content-type': 'application/json' }, body: m === 'GET' ? undefined : '{}' });
        if (m === methods[0]) assert.notEqual(r.status, 405, `${m} ${p}`);
        else { assert.equal(r.status, 405, `${m} ${p}`); assert.equal(r.headers.allow, allow, `${m} ${p}`); assert.equal(r.text, '{"error":"method_not_allowed"}'); }
      }
    }
    for (const p of ['/api/nothing', '/api/evaluate/x', '/api/policies', '/api/approvals/apr-0001']) {
      const r = await rawHttp(`${url}${p}`, { method: 'DELETE', headers: { host, origin: url } });
      assert.equal(r.status, 404, p); assert.equal(r.text, '{"error":"not_found"}', p);
    }
  });
});

test('400 bad_workspace: a credential-looking workspace id is refused on every route that takes one, before a slot exists, and is never echoed', async () => {
  const ids = [['pw-', H].join(''), 'token-abc', ['password', '-abc123'].join(''), ['sk', '-abcdefghijkl'].join(''), 'a'.repeat(24) + '1', 'deadbeef'.repeat(4), ['glpat', '-abcdefghijkl'].join(''), `bearer-${H}`];
  await withServer(async (url, { workspaces }) => {
    const good = await (await post(url, '/api/token', live({ token: { claims: { sub: C.castAgent, surfaces: ['tool'], scope: `${C.castApp}:read`, department: C.castDept } } }), { 'x-workspace': 'good-ws' })).json();
    assert.equal(workspaces.size(), 1);
    for (const id of ids) {
      const w = { 'x-workspace': id };
      const answers = [
        await get(url, '/api/state?mode=live', w), await get(url, '/api/state?mode=mock', w),
        await post(url, '/api/reset', {}, w), await post(url, '/api/clock', clock, w), await post(url, '/api/token', live({ token: { claims: { sub: C.castAgent } } }), w),
        await post(url, '/api/evaluate', live({ request: { route: `/mcp/${C.castApp}`, tool: C.castToolRead, arguments: { record: 'r' }, token: good.result.labToken } }), w),
        await post(url, '/api/approvals/apr-0001/decision', live({ decision: { approver: C.castApprover, decision: 'approve', authLevel: 2 } }), w),
        await put(url, '/api/policies/users', live({ rules: [] }), w), await post(url, '/api/policies/users/reset', live({}), w),
      ];
      for (const r of answers) { assert.equal(r.status, 400, id); const t = await r.text(); assert.equal(t, '{"error":"bad_workspace"}', id); }
    }
    assert.equal(workspaces.size(), 1, 'no refused id took a slot');
    assert.equal(workspaces.peek('good-ws', 'finance') !== null, true);
    // ordinary ids that merely contain a credential word are fine
    for (const id of ['default', 'w-password-reset', 'w-token-exchange', 'ws-a1']) assert.equal((await post(url, '/api/clock', clock, { 'x-workspace': id })).status, 200, id);
  });
});

test('the catch-all handlers answer fixed JSON: malformed JSON 400, too large 413, a thrown error 500, an unknown path 404; none holds what was typed', async () => {
  await withServer(async (url) => {
    const bad = await fetch(`${url}/api/clock`, { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: `{"password":"${H}` });
    assert.equal(bad.status, 400); assert.equal(await bad.text(), '{"error":"bad_request"}');
    const big = await fetch(`${url}/api/clock`, { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: JSON.stringify({ x: `password=${H}`.padEnd(40000, 'a') }) });
    assert.equal(big.status, 413); assert.equal(await big.text(), '{"error":"payload_too_large"}');
    const nope = await fetch(`${url}/${H}/${encodeURIComponent(`password=${H}`)}`, { method: 'POST', headers: { origin: url } });
    assert.equal(nope.status, 404); assert.equal(await nope.text(), '{"error":"not_found"}');
  });
  const exploding = { engine() { throw new Error(`boom password=${H}`); }, peek: () => null, reset() {}, size: () => 0 };
  await withServer(async (url) => {
    const logged = await capture(async () => {
      const r = await post(url, '/api/clock', clock);
      assert.equal(r.status, 500); assert.equal(await r.text(), '{"error":"internal_error"}');
    });
    assert.equal(logged.includes(H), false);
  }, { workspaces: exploding });
});

test('the response mask covers values AND object keys on every answer: a secret that reaches engine state under a key or a value never comes back', async () => {
  await withServer(async (url, { workspaces }) => {
    const e = workspaces.engine('default', 'finance', C);
    e.outbox.push({ id: 'out-x', at: 'now', channel: 'slack', label: 'x', to: [], ref: 'apr-0001', subject: 'plain', expiresAt: 'x', delivered: false, [`password ${H}`]: 'v', [`token ${H}`]: 1 });
    e.audit.push({ id: 'aud-x', kind: 'evaluation', note: `login: bob / ${H}`, [`api_key ${H}`]: { nested: `Bearer${String.fromCharCode(9)}${H}abcdef` } });
    const t = await (await get(url, '/api/state?mode=live')).text();
    assert.equal(t.includes(H), false);
    assert.match(t, /"\[masked:shape\]"/);
    assert.match(t, /\[masked:pair\]/);
  });
});

test('answers that carry visitor text are masked with credential-word KEYS read: a short value under a key named password or token never comes back; the lab\'s own prose is masked as prose', async () => {
  await withServer(async (url, { workspaces }) => {
    const e = workspaces.engine('default', 'finance', C);
    e.outbox.push({ id: 'out-y', at: 'now', channel: 'slack', label: 'x', to: [], ref: 'apr-0001', subject: 'plain', expiresAt: 'x', delivered: false, password: 'ab', token: 'cd', nested: { api_key: 'ef' } });
    const live1 = await (await get(url, '/api/state?mode=live')).json();
    const row = live1.state.outbox.at(-1);
    assert.deepEqual([row.password, row.token, row.nested.api_key, row.subject], ['[masked:assignment]', '[masked:assignment]', '[masked:assignment]', 'plain']);
    const story = await (await get(url, '/api/story?vertical=finance')).json();
    assert.deepEqual(story.authLevels, { 1: 'password', 2: 'push approval', 3: 'hardware key' }, 'the story is prose: the word password in it is a word');
    const mock = await (await get(url, '/api/state?mode=mock')).json();
    assert.equal(mock.state.roster.length > 0, true);
  });
});

test('scrub (the first hop\'s request body): values and keys are cleaned and masked before the response mask sees them', () => {
  const out = scrub({ route: `/mcp/x`, tool: 't', arguments: { [`password ${H}`]: `my password is ${H}`, note: `pass${String.fromCharCode(9)}word: ${H}`, ok: 'fine' } });
  assert.equal(JSON.stringify(out).includes(H), false);
  assert.deepEqual(out, { route: '/mcp/x', tool: 't', arguments: { '[masked:shape]': '[masked:assignment]', note: '[masked:assignment]', ok: 'fine' } });
});
