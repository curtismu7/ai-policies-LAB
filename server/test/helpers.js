import http from 'node:http';
import { createApp, startHttpServer } from '../src/app.js';
import { createHealth } from '../src/health.js';
import { createWorkspaces } from '../src/workspaces.js';
import { Engine } from '../src/engine.js';
import { VERTICALS } from '../src/cast.js';

export const C = VERTICALS.finance;
export const newEngine = (cast = C) => new Engine(cast);

export async function withServer(fn, { configFile = '/nonexistent/customer.config.json', workspaces = createWorkspaces(), webDist, env } = {}) {
  const health = createHealth({ runChecks: async () => [], intervalMs: 3_600_000 });
  await health.ready;
  const { server, url } = await startHttpServer({ port: 0, host: '127.0.0.1', app: createApp({ health, configFile, workspaces, ...(webDist ? { webDist } : {}), ...(env ? { env } : {}) }) });
  try { await fn(url.replace(/\/$/, ''), { workspaces }); } finally { health.stop(); await new Promise((res) => server.close(res)); }
}

export const post = (url, path, body, headers = {}) => fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: url, ...headers }, body: JSON.stringify(body) });
export const put = (url, path, body, headers = {}) => fetch(`${url}${path}`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: url, ...headers }, body: JSON.stringify(body) });
export const get = (url, path, headers = {}) => fetch(`${url}${path}`, { headers });
export const json = async (res) => res.json();

// fetch cannot set Host; node:http can.
export function rawHttp(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, agent: false }, (res) => {
      let data = ''; res.on('data', (c) => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
    });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}

// ---- engine helpers ----
// A caller's claims: payments-agent with read and write, in the finance department, acting for the first user.
export const claims = (o = {}) => ({ sub: C.castAgent, surfaces: ['tool', 'model', 'agent'], scope: `${C.castApp}:read ${C.castApp}:write`, department: C.castDept, end_user: C.castUser, ...o });
export const tok = (e, cl = claims(), ttlMin) => e.mintToken({ claims: cl, ttlMin }).labToken;
export const route = `/mcp/${C.castApp}`;
export const holdCall = (e, o = {}) => ({ route, tool: C.castToolHold, arguments: { record: C.castRecord, newValue: C.castNewValue }, token: tok(e), ...o });
export const bigPay = (e, amount = 25000, o = {}) => ({ route, tool: C.castToolWrite, arguments: { record: C.castRecord, amount }, token: tok(e), ...o });
export const readCall = (e, o = {}) => ({ route, tool: C.castToolRead, arguments: { record: C.castRecord }, token: tok(e), ...o });
export const sign = (e, ref, approver = C.castApprover, authLevel = 2, decision = 'approve') => e.decide({ ref, approver, decision, authLevel });
