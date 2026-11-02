// S2: a missing file is a 404, not the page. S3: a known /api route called with the wrong method is a 405 with Allow, not a 404.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rawHttp, withServer } from './helpers.js';
import { API_ROUTES } from '../src/app.js';

const withDist = async (fn) => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'aip-dist-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>the page</title>');
  fs.mkdirSync(path.join(dist, 'assets')); fs.writeFileSync(path.join(dist, 'assets', 'real.js'), 'console.log(1)');
  try { await withServer(async (url) => fn(url, new URL(url).host), { webDist: dist }); } finally { fs.rmSync(dist, { recursive: true, force: true }); }
};

test('S2: the page answers only for a path that can be a page; a missing file, map, icon or asset is the fixed JSON 404 (for GET and HEAD)', async () => {
  await withDist(async (url, host) => {
    for (const p of ['/', '/policies', '/approvals', '/a/b/c', '/x.y/z']) {
      const r = await rawHttp(`${url}${p}`, { headers: { host, accept: 'text/html' } });
      assert.equal(r.status, 200, p); assert.match(r.headers['content-type'], /text\/html/, p); assert.match(r.text, /the page/, p);
    }
    for (const p of ['/assets/missing.js', '/favicon.ico', '/robots.txt', '/static/x.png', '/foo.map', '/%E0%A4%A', '/.git/config', '/a/.env', '/sitemap.xml', '/api', '/assets/missing.js?x=1']) {
      const r = await rawHttp(`${url}${p}`, { headers: { host, accept: 'text/html' } });
      assert.equal(r.status, 404, p); assert.match(r.headers['content-type'], /application\/json/, p); assert.deepEqual(JSON.parse(r.text), { error: 'not_found' }, p);
    }
    const head = await rawHttp(`${url}/foo.map`, { method: 'HEAD', headers: { host, accept: 'text/html' } });
    assert.equal(head.status, 404);
    const real = await rawHttp(`${url}/assets/real.js`, { headers: { host } });
    assert.equal(real.status, 200); assert.match(real.headers['content-type'], /javascript/); assert.equal(real.text, 'console.log(1)');
  });
});

// A request that is right for its route: what each route takes, so the method that IS allowed is never answered 405.
const GOOD = { GET: [''], POST: ['{}'], PUT: ['{}'] };
const SAMPLE = { story: '/api/story', diagram: '/api/diagram', info: '/api/info', jwks: '/api/jwks', state: '/api/state', canonicalize: '/api/canonicalize', evaluate: '/api/evaluate', token: '/api/token', clock: '/api/clock', reset: '/api/reset' };
// the method each sample path takes, read from the route table (exact keys, and ":name" keys as one segment)
const tableMethod = (p) => { for (const [k, m] of Object.entries(API_ROUTES)) if (new RegExp(`^${k.replace(/:[a-z]+/g, '[^/]+')}$`).test(p)) return m.find((x) => x !== 'HEAD'); return undefined; };
const ROUTES = [...Object.values(SAMPLE), '/api/approvals/apr-0001/decision', '/api/policies/apps', '/api/policies/apps/reset'].map((p) => [p, tableMethod(p)]);

test('S3: every /api route answers 405 with Allow for any other method, and its own method is never 405', async () => {
  await withServer(async (url, ) => {
    const host = new URL(url).host;
    assert.equal(ROUTES.length, 13);
    for (const [p, allowed] of ROUTES) {
      assert.ok(allowed, `${p} is in the route table`);
      for (const m of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']) {
        const r = await rawHttp(`${url}${p}`, { method: m, headers: { host, origin: url, 'content-type': 'application/json' }, body: m === 'GET' ? undefined : '{}' });
        if (m === allowed) assert.notEqual(r.status, 405, `${m} ${p} is the right method`);
        else {
          assert.equal(r.status, 405, `${m} ${p}`);
          assert.equal(r.headers.allow, allowed === 'GET' ? 'GET, HEAD' : allowed, `${m} ${p} Allow`);
          assert.deepEqual(JSON.parse(r.text), { error: 'method_not_allowed' }, `${m} ${p}`);
        }
      }
    }
    const head = await rawHttp(`${url}/api/state?mode=mock`, { method: 'HEAD', headers: { host } });
    assert.equal(head.status, 200, 'HEAD on a GET route is fine');
    const health = await rawHttp(`${url}/api/health`, { method: 'POST', headers: { host, origin: url } });
    assert.equal(health.status, 405); assert.equal(health.headers.allow, 'GET');
  });
});

test('S3: the reported cases, exactly, and an unknown /api path is still 404', async () => {
  await withServer(async (url) => {
    const host = new URL(url).host;
    for (const [m, p] of [['GET', '/api/evaluate'], ['POST', '/api/state'], ['PUT', '/api/state'], ['DELETE', '/api/evaluate'], ['GET', '/api/token'], ['GET', '/api/reset'], ['GET', '/api/approvals/apr-0001/decision'], ['POST', '/api/policies/apps'], ['PUT', '/api/policies/apps/reset'], ['GET', '/API/EVALUATE'], ['GET', '/api/evaluate/']]) {
      const r = await rawHttp(`${url}${p}`, { method: m, headers: { host, origin: url } });
      assert.equal(r.status, 405, `${m} ${p}`);
    }
    for (const [m, p] of [['GET', '/api/nothing'], ['POST', '/api/evaluate/extra'], ['GET', '/api/approvals/apr-0001'], ['GET', '/api/policies']]) {
      const r = await rawHttp(`${url}${p}`, { method: m, headers: { host, origin: url } });
      assert.equal(r.status, 404, `${m} ${p}`); assert.deepEqual(JSON.parse(r.text), { error: 'not_found' });
    }
    const badBody = await rawHttp(`${url}/api/evaluate`, { method: 'GET', headers: { host, 'content-type': 'application/json' }, body: '{not json' });
    assert.equal(badBody.status, 405, 'the method is judged before the body is read');
  });
});
