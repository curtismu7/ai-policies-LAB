// The final check (shared-masker docs/ADOPTION.md step 7): about 60 credential-shaped payloads are typed into every place a request carries text, on every endpoint: the free-text
// fields, object KEYS, path segments, the query, and the headers (workspace, traceparent, authorization, cookie, user-agent, referer, content type). None may come back in any
// answer (status line, body, headers), in the state afterwards, in the engine, or in stdout / stderr. The payloads are rows of the shared corpus (stratified by family, joined
// from fragments at run time) plus the seven leaks this adoption fixed. Light on purpose: no load, no bursts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { C, get, post, rawHttp, withServer } from './helpers.js';
import { sweep } from './sweep.js';

const leaks = JSON.parse(readFileSync(new URL('./corpus/leaks.json', import.meta.url), 'utf8'));
const join = (a) => a.join('');
const H = ['hunter', '2xyz'].join('');
const ch = (n) => String.fromCharCode(n);
const live = (extra = {}) => ({ mode: 'live', vertical: 'finance', ...extra });

// 53 corpus rows: up to 3 per family, the secret printable ASCII without white space (so it can be searched for in a JSON answer, a URL and a header), text probes only. The
// sweep helper removes a double quote, a backslash and a line feed from the text it embeds in JSON (argumentsText), which would change the shape of the probe, so a text with one
// of them is left out here (the corpus tests above type those through maskText / maskDeep directly)
const printable = (r) => r.api !== 'deep' && !r.fillBefore && !r.fillAfter && /^[\x21-\x7e]{6,60}$/.test(join(r.secret)) && join(r.input).length <= 200 && !/["\\\n]/.test(join(r.input));
const byFamily = new Map();
for (const r of leaks.filter(printable)) { const l = byFamily.get(r.family) ?? []; if (l.length < 3) { l.push(r); byFamily.set(r.family, l); } }
const corpusPayloads = [...byFamily.values()].flat().slice(0, 53).map((r) => ({ name: `${r.id} ${r.family}/${r.enc}`, text: join(r.input), probe: join(r.secret) }));
const KNOWN = [
  [`pass${ch(0x1680)}word: ${H}`], [`pass${ch(9)}word: ${H}`], [`pass${ch(0x2028)}word: ${H}`], [`login: bob / ${H}`], [`password - ${H}`], [`Bearer${ch(9)}${H}abcdef`], [`password${ch(9)}${H}`],
].map(([text], i) => ({ name: `known leak ${i + 1}`, text, probe: H }));
const PAYLOADS = [...corpusPayloads, ...KNOWN];

const forms = (probe) => [probe, JSON.stringify(probe).slice(1, -1), encodeURIComponent(probe)];
const headerSafe = (t) => /^[\x20-\x7e]*$/.test(t);

test('the payload set is about 60 and covers many families', () => {
  assert.equal(corpusPayloads.length, 53);
  assert.equal(PAYLOADS.length, 60);
  assert.ok(new Set(corpusPayloads.map((p) => p.name.split(' ')[1].split('/')[0])).size >= 15, 'families');
});

test('about 60 payloads typed into free-text fields, keys, path segments, query and headers never come back in an answer, the state, the engine or the process output', async () => {
  const out = []; const realOut = process.stdout.write.bind(process.stdout); const realErr = process.stderr.write.bind(process.stderr);
  await withServer(async (url, { workspaces }) => {
    process.stdout.write = (c, ...a) => { out.push(String(c)); return realOut(c, ...a); }; process.stderr.write = (c, ...a) => { out.push(String(c)); return realErr(c, ...a); };
    try {
      const host = new URL(url).host;
      for (const p of PAYLOADS) {
        await post(url, '/api/reset', {});
        const good = (await (await post(url, '/api/token', live({ token: { claims: { sub: C.castAgent, surfaces: ['tool'], scope: `${C.castApp}:write ${C.castApp}:read`, department: C.castDept, end_user: C.castUser } } }))).json()).result.labToken;
        const texts = await sweep(url, p.text, good); // fields, keys, path segments (approvals, policies), query, x-workspace
        // headers: traceparent, authorization, cookie, user-agent, referer, a custom header, on a read and on a write
        if (headerSafe(p.text)) {
          const hv = { traceparent: p.text, authorization: p.text, cookie: p.text, 'user-agent': p.text, referer: p.text, 'x-note': p.text, 'x-forwarded-for': p.text };
          for (const m of ['GET', 'POST']) {
            const r = await rawHttp(`${url}/api/${m === 'GET' ? 'state?mode=live' : 'clock'}`, { method: m, headers: { host, origin: url, 'content-type': 'application/json', ...hv }, body: m === 'POST' ? JSON.stringify(live({ clock: { minutes: 1 } })) : undefined });
            texts.push(`${r.status} ${r.text} ${JSON.stringify(r.headers)}`);
          }
          const cs = await rawHttp(`${url}/api/clock`, { method: 'POST', headers: { host, origin: url, 'content-type': `application/json; charset=${p.text}` }, body: '{}' });
          texts.push(`${cs.status} ${cs.text} ${JSON.stringify(cs.headers)}`);
        }
        // a path segment on an unknown path and on the page address space
        for (const path of [`/api/${encodeURIComponent(p.text)}`, `/${encodeURIComponent(p.text)}/x`]) { const r = await get(url, path); texts.push(`${r.status} ${await r.text()}`); }
        const state = await (await get(url, '/api/state?mode=live')).text();
        texts.push(state);
        const bad = texts.filter((t) => forms(p.probe).some((f) => t.includes(f)));
        assert.equal(bad.length, 0, `${p.name} leaked: ${bad.map((x) => x.slice(0, 160)).join(' | ')}`);
        assert.equal(forms(p.probe).some((f) => JSON.stringify(workspaces.peek('default', 'finance')?.snapshot() ?? {}).includes(f)), false, `${p.name}: the engine state`);
      }
    } finally { process.stdout.write = realOut; process.stderr.write = realErr; }
  });
  const logged = out.join('');
  for (const p of PAYLOADS) assert.equal(forms(p.probe).some((f) => logged.includes(f)), false, `${p.name} was logged`);
});
