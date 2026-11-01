// One Express app. /api = health, info, story, diagram, state, jwks, canonicalize and the action endpoints (evaluate, token, approval decisions, clock, policies,
// reset). Server state per workspace id (X-Workspace) is one engine per vertical, so one visitor's Reset never touches another's.
// Mock reads generated tables and refuses every write; Live drives the engine. Both are loopback-only with zero outbound calls.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { hostCheck, sameOriginWrites } from './safety.js';
import { createHealth } from './health.js';
import { loadCast, verticalFrom } from './cast.js';
import { defaultMode, modeOf } from './config.js';
import { buildStory } from './story.js';
import { DIAGRAM_NAMES, buildDiagram } from './diagramData.js';
import { InputError } from './errors.js';
import { MOCK_TABLE } from './mockTable.js';
import { createWorkspaces, workspaceFrom } from './workspaces.js';
import { liveState, mockState, runAction } from './service.js';
import { buildCatalog, hasApp, hasTool, parseRoute } from './catalog.js';
import { callHash, METHODS, normalizeArguments } from './canon.js';
import { jwks } from './token.js';
import { shown } from './engine.js';
import { maskDeep } from './mask.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = process.env.WEB_DIST || path.resolve(HERE, '../../web/dist');
const CONFIG = process.env.CUSTOMER_CONFIG || path.resolve(HERE, '../../customer.config.json');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Every /api route the lab has and the one method it takes. A known route called with another method answers 405 with Allow (not 404), before the body is read.
export const API_ROUTES = [
  [/^\/(?:story|diagram|info|jwks|state)\/?$/i, 'GET'],
  [/^\/(?:canonicalize|evaluate|token|clock|reset)\/?$/i, 'POST'],
  [/^\/approvals\/[^/]+\/decision\/?$/i, 'POST'],
  [/^\/policies\/[^/]+\/?$/i, 'PUT'],
  [/^\/policies\/[^/]+\/reset\/?$/i, 'POST'],
];
// The single-page app answers only for a path that can be a page: no file extension, no dot-segment, valid percent-encoding. Anything else that is missing is a 404.
const isPagePath = (p) => { try { p = decodeURIComponent(p); } catch { return false; } return !/\.[^/]*$/.test(p) && !/\/\./.test(p); };

export function createApp({ health = createHealth(), configFile = CONFIG, workspaces = createWorkspaces(), table = MOCK_TABLE, webDist = WEB_DIST } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(hostCheck);
  app.use(sameOriginWrites);
  app.use((_req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });

  const api = express.Router();
  // Defence in depth: every JSON answer is masked for credential-shaped values, whatever path produced it.
  api.use((_req, res, next) => { const send = res.json.bind(res); res.json = (b) => send(maskDeep(b)); next(); });
  api.use((req, res, next) => {
    const hit = API_ROUTES.find(([re]) => re.test(req.path));
    if (!hit || req.method === hit[1] || req.method === 'OPTIONS' || (hit[1] === 'GET' && req.method === 'HEAD')) return next();
    return res.set('Allow', hit[1] === 'GET' ? 'GET, HEAD' : hit[1]).status(405).json({ error: 'method_not_allowed' });
  });
  api.use(express.json({ limit: '32kb' }));
  api.use('/health', health.router);
  const verticalOf = (req) => verticalFrom(req.body?.vertical ?? req.query.vertical);
  const castFor = (req) => loadCast(configFile, verticalOf(req));
  const noStore = (res) => res.set('Cache-Control', 'no-store');
  const ws = (req, res) => { const id = workspaceFrom(req); if (!id) res.status(400).json({ error: 'bad_workspace' }); return id; };
  const bodyOf = (req) => (isObj(req.body) ? req.body : {});

  api.get('/story', (req, res) => { noStore(res); res.json(buildStory(castFor(req), verticalOf(req))); });
  api.get('/diagram', (req, res) => { noStore(res); res.json(buildDiagram(castFor(req), DIAGRAM_NAMES.includes(req.query.name) ? req.query.name : DIAGRAM_NAMES[0])); });
  api.get('/info', (_req, res) => { noStore(res); res.json({ mode: defaultMode(), modes: ['mock', 'live'], simulated: true, release: '2026-11-02', unverified: true }); });

  api.get('/state', (req, res) => {
    const id = ws(req, res); if (!id) return;
    noStore(res);
    const mode = modeOf(req.query.mode); if (!mode) return res.status(400).json({ error: 'bad_mode', detail: 'mode must be mock or live' });
    const vertical = verticalOf(req);
    if (mode === 'mock') return res.json({ mode, vertical, workspace: id, ...mockState(table, vertical, req.query.scenario) });
    return res.json({ mode, vertical, workspace: id, state: liveState(id, workspaces, vertical, castFor(req)) });
  });

  // A pure computation, no state: the canonical form and hash of a call. Works in both modes.
  api.post('/canonicalize', (req, res) => {
    noStore(res);
    const b = bodyOf(req);
    if (!Object.keys(b).every((k) => ['mode', 'vertical', 'argumentsText', 'arguments', 'route', 'tool'].includes(k))) return res.status(400).json({ error: 'unknown_field', detail: 'the body carries a field the lab does not take' });
    const cast = castFor(req);
    const r = parseRoute(b.route === undefined ? `/mcp/${cast.castApp}` : b.route);
    const tool = typeof b.tool === 'string' && hasTool(buildCatalog(cast), r?.app, b.tool) ? b.tool : cast.castToolHold;
    if (!r) return res.status(422).json({ ok: false, code: 'route_unknown', reason: 'the route does not begin with /llm/, /mcp/ or /a2a/ followed by an application name' });
    const n = normalizeArguments(b.argumentsText !== undefined ? { text: b.argumentsText } : { object: b.arguments });
    if (!n.ok) return res.status(422).json({ ok: false, code: n.code, reason: n.reason });
    const target = `${r.surface}:${r.app}/${tool}`;
    const h = callHash({ method: METHODS[r.surface], target, arguments: n.value });
    return res.json({ ok: true, method: METHODS[r.surface], target: hasApp(buildCatalog(cast), r.app) ? target : `${r.surface}:(unknown application)/${tool}`, canonical: shown(h.canonical, 600), hash: h.hash });
  });
  api.get('/jwks', (_req, res) => { noStore(res); res.json({ jwks: jwks(), note: 'The lab\'s public key. The private half lives in memory in this process and is never shown or written.' }); });

  // Every write: Live only, strict top-level keys, one trace, hops, and the whole fresh state back.
  const write = (method, route, { op, keys, params }) => {
    api[method](route, (req, res, next) => {
      const id = ws(req, res); if (!id) return;
      noStore(res);
      try {
        if (!isObj(req.body)) return res.status(400).json({ error: 'bad_request' });
        const mode = modeOf(req.body.mode);
        if (!mode) return res.status(400).json({ error: 'bad_mode', detail: 'mode must be mock or live' });
        if (mode === 'mock') return res.status(409).json({ error: 'mock_is_read_only', detail: 'Mock mode only reads tables: switch to Live to act' });
        if (!Object.keys(req.body).every((k) => ['mode', 'vertical', ...keys].includes(k))) return res.status(400).json({ error: 'unknown_field', detail: 'the body carries a field the lab does not take' });
        const vertical = verticalOf(req);
        const r = runAction({ ws: id, workspaces, vertical, cast: castFor(req), op, params: params(req), traceparent: req.headers.traceparent, route: { method: method.toUpperCase(), url: `/api${route}` } });
        res.set('traceparent', r.traceparent);
        const common = { workspace: id, mode, vertical, hops: r.hops, hopsTruncated: r.hopsTruncated, traceId: r.traceId, state: r.state };
        // Honest status codes: an evaluation answers 200 (allow), 401 (a token that does not verify) or 403 (deny, hold, withhold), and says which in the body. A refusal by
        // the engine is its own 4xx. The browser logs each of those 4xx answers as a console message; the README says so.
        if (r.outcome.ok) return res.status(r.status).json({ ok: true, result: r.outcome.result, ...common });
        return res.status(r.outcome.status || 400).json({ ok: false, error: r.outcome.code, detail: r.outcome.detail, ...(r.outcome.errors ? { errors: r.outcome.errors } : {}), ...common });
      } catch (e) { return next(e); }
    });
  };
  const idParam = (req, name) => (typeof req.params[name] === 'string' ? req.params[name] : '');
  write('post', '/evaluate', { op: 'evaluate', keys: ['request'], params: (req) => (isObj(req.body.request) ? req.body.request : { __bad: 1 }) });
  write('post', '/token', { op: 'mint', keys: ['token'], params: (req) => (isObj(req.body.token) ? req.body.token : { __bad: 1 }) });
  write('post', '/approvals/:ref/decision', { op: 'decide', keys: ['decision'], params: (req) => ({ ...(isObj(req.body.decision) ? req.body.decision : { __bad: 1 }), ref: idParam(req, 'ref') }) });
  write('post', '/clock', { op: 'advance', keys: ['clock'], params: (req) => (isObj(req.body.clock) ? req.body.clock : { __bad: 1 }) });
  write('put', '/policies/:layer', { op: 'savePolicy', keys: ['rules'], params: (req) => ({ layer: idParam(req, 'layer'), rules: req.body.rules }) });
  write('post', '/policies/:layer/reset', { op: 'resetPolicy', keys: [], params: (req) => ({ layer: idParam(req, 'layer') }) });

  // Reset clears this workspace's engines (requests, grants, receipts, platform state, outbox, audit, the clock) and nothing else.
  api.post('/reset', (req, res) => { const id = ws(req, res); if (!id) return; noStore(res); workspaces.reset(id); return res.json({ reset: 'ok', workspace: id }); });
  api.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use('/api', api);

  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist));
    app.get(/^\/(?!api(?:\/|$)).*/, (req, res, next) => (isPagePath(req.path) ? res.sendFile(path.join(webDist, 'index.html')) : next()));
  }
  // The last two handlers catch everything that is left, for every method and every path: Express's default answers ("Cannot POST /<path>", or an
  // HTML stack trace with file paths) would echo the path the visitor typed, which may be a token. Fixed JSON, no path.
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = Number(err?.status || err?.statusCode);
    if (err instanceof InputError) return res.status(err.status).json({ error: err.code, detail: err.message });
    if (status === 413) return res.status(413).json({ error: 'payload_too_large' });
    if (status >= 400 && status < 500) return res.status(status).json({ error: 'bad_request' });
    return res.status(500).json({ error: 'internal_error' });
  });
  return app;
}

export function startHttpServer({ port, host, app = createApp() } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve({ server, url: `http://${host}:${server.address().port}/` }));
    server.once('error', reject);
  });
}
