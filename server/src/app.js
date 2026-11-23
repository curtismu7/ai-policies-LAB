// One Express app. /api = health, info, story, diagram, state, jwks, canonicalize and the action endpoints (evaluate, token, approval decisions, clock, policies,
// reset). Server state per workspace id (X-Workspace) is one engine per vertical, so one visitor's Reset never touches another's.
// Mock reads generated tables and refuses every write; Live drives the engine. Both are loopback-only with zero outbound calls.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { makeHostCheck, makeSameOriginWrites, parseAllowedHosts, resolvePort } from './safety.js';
import { createHealth } from './health.js';
import { loadCast, verticalFrom } from './cast.js';
import { defaultMode, modeOf } from './config.js';
import { buildStory } from './story.js';
import { DIAGRAM_NAMES, buildDiagram } from './diagramData.js';
import { InputError } from './errors.js';
import { MOCK_TABLE } from './mockTable.js';
import { shelfInfo } from './shelfLink.js';
import { createWorkspaces, workspaceFrom } from './workspaces.js';
import { liveState, mockState, runAction, scrubWhole } from './service.js';
import { policyTrace } from './policyTrace.js';
import { buildCatalog, hasApp, hasTool, parseRoute } from './catalog.js';
import { callHash, METHODS, normalizeArguments } from './canon.js';
import { jwks } from './token.js';
import { shown } from './engine.js';
import { maskDeep, maskProse } from './mask.js';
import { buildMethodTable, charsetProblem, isPageAddress, methodNotAllowed } from './shared/hygiene.js';
import { readFileSettings, doorConfig, createRealDoor } from './gatewayReal.js';
import { traceFromDoor } from './gatewayTrace.js';
import { setAllowedOrigins } from './netguard.js';
import { RunObsError } from './runObservability.js';
import { createRunLog, mockRecord, realRecord, reportFailure, safely } from './runObs.js';

// Real mode = the shared gateway hop: an agent key from the shared settings file calling a live Privilege door.
// The environment wins over the file: APL_* variables overlay the parsed file text.
export function realDoorFrom(env = process.env) {
  const p = env.STANDALONE_ENV || `${env.HOME || ''}/Development/.env`;
  let text = '';
  try { text = fs.readFileSync(p, 'utf8'); } catch { /* the environment may still carry the keys */ }
  for (const [k, v] of Object.entries(env)) if (k.startsWith('APL_GW_') && v) text += `\n${k}=${v}`;
  const cfg = doorConfig(text, 'APL');
  return cfg.ok ? createRealDoor({ config: cfg, capture: true, clientInfo: { name: 'ai-policies-lab', version: '0.1.0' } }) : null;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = process.env.WEB_DIST || path.resolve(HERE, '../../web/dist');
const CONFIG = process.env.CUSTOMER_CONFIG || path.resolve(HERE, '../../customer.config.json');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Every /api route the lab has and the methods it takes: ONE table, used for the 405 (with Allow) and nowhere else. ":name" matches one path segment; HEAD is allowed wherever
// GET is. /api/health is not listed: its router answers its own 405. A path that is not in the table is a 404, never a 405.
export const API_ROUTES = {
  '/api/story': ['GET'], '/api/diagram': ['GET'], '/api/info': ['GET'], '/api/jwks': ['GET'], '/api/state': ['GET'], '/api/mode': ['POST'], '/api/gateway-check': ['POST'], '/api/run-observability': ['GET'],
  '/api/canonicalize': ['POST'], '/api/evaluate': ['POST'], '/api/token': ['POST'], '/api/clock': ['POST'], '/api/reset': ['POST'],
  '/api/approvals/:ref/decision': ['POST'],
  '/api/policies/:layer': ['PUT'],
  '/api/policies/:layer/reset': ['POST'],
};
const METHODS_OF = buildMethodTable(API_ROUTES);

export function createApp({ health = createHealth(), configFile = CONFIG, workspaces = createWorkspaces(), table = MOCK_TABLE, webDist = WEB_DIST, env = process.env, allowedHosts = parseAllowedHosts(env), port = resolvePort(env), runLog = createRunLog() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // Defence in depth: every JSON answer, from any handler and any status, is masked for credential-shaped values and keys before it leaves. The answers that hold only the
  // lab's own text (story, diagram, info, the Mock tables; /jwks keeps the strong reading because the shared masker knows a public JWK) set res.locals.labData and are masked
  // as prose (see mask.js); every other answer, including everything that carries what a visitor typed, is masked with credential-word keys read.
  app.use((_req, res, next) => { const send = res.json.bind(res); res.json = (b) => send((res.locals.labData ? maskProse : maskDeep)(b)); next(); });
  app.use(makeHostCheck({ allowed: allowedHosts, port }));
  app.use(makeSameOriginWrites({ allowed: allowedHosts, port }));
  app.use((_req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });
  // A charset other than utf-8 is a 415 with a fixed body: charsetProblem returns a fixed code, so nothing the visitor typed is answered or logged.
  app.use((req, res, next) => (charsetProblem(req.headers['content-type']) ? res.status(415).json({ error: 'unsupported_charset' }) : next()));

  const api = express.Router();
  api.use((req, res, next) => {
    const miss = methodNotAllowed(METHODS_OF, req.method, `/api${req.path}`);
    return miss ? res.set('Allow', miss.allow.join(', ')).status(405).json({ error: 'method_not_allowed' }) : next();
  });
  api.use(express.json({ limit: '32kb' }));
  api.use('/health', health.router);
  api.get('/shelf', (_req, res) => { noStore(res); labData(res); res.json(shelfInfo(env)); });
  const verticalOf = (req) => verticalFrom(req.body?.vertical ?? req.query.vertical);
  const castFor = (req) => loadCast(configFile, verticalOf(req));
  const noStore = (res) => res.set('Cache-Control', 'no-store');
  const labData = (res) => { res.locals.labData = true; };
  const ws = (req, res) => { const id = workspaceFrom(req); if (!id) res.status(400).json({ error: 'bad_workspace' }); return id; };
  const bodyOf = (req) => (isObj(req.body) ? req.body : {});

  api.get('/story', (req, res) => { noStore(res); labData(res); res.json(buildStory(castFor(req), verticalOf(req))); });
  api.get('/diagram', (req, res) => { noStore(res); labData(res); res.json(buildDiagram(castFor(req), DIAGRAM_NAMES.includes(req.query.name) ? req.query.name : DIAGRAM_NAMES[0])); });
  // Rule 19: the server holds the Mock/Real mode. Both are available: mock reads generated tables, live drives the loopback engine.
  // The wire value of source is mock|real; this lab's internal mode is mock|live, and real means live here.
  let current = defaultMode();
  const toSource = (m) => (m === 'live' ? 'real' : m);
  const toMode = (s) => (s === 'real' ? 'live' : s);
  api.get('/info', (_req, res) => { noStore(res); labData(res); res.json({ mode: current, source: toSource(current), realAvailable: true, realReason: null, modes: ['mock', 'live'], simulated: true, release: '2026-11-02', unverified: true }); });
  // Rule 19: switching is server-side. The body is exactly { source: "mock" | "real" }.
  api.post('/mode', (req, res) => {
    noStore(res); labData(res);
    const b = isObj(req.body) ? req.body : {};
    const next = b.source;
    if (next !== 'mock' && next !== 'real') return res.status(400).json({ error: 'bad_mode', detail: 'source must be exactly "mock" or "real"' });
    if (!Object.keys(b).every((k) => k === 'source')) return res.status(400).json({ error: 'unknown_field', detail: 'the body takes only source' });
    current = toMode(next);
    return res.json({ mode: current, source: toSource(current), realAvailable: true, realReason: null });
  });


  // One real gateway check: tools/list through the door with the agent key, then the gateway's refusal
  // for a tool nothing grants. Independent of the lab's local Live engine.
  api.post('/gateway-check', async (req, res) => {
    noStore(res);
    if (current !== 'live') return res.status(409).json({ error: 'mock_mode', message: 'Mock never calls a gateway. Switch to Real to run the gateway check.' });
    const door = realDoorFrom();
    if (!door) return res.status(409).json({ error: 'real_not_available', message: 'Set APL_GW_URL, APL_GW_APPS and at least one APL_GW_KEY_<NAME> in the shared settings file.' });
    if (req.body && Object.keys(req.body).some((k) => !['app', 'caller'].includes(k))) return res.status(400).json({ error: 'bad_request', detail: 'the only accepted body fields are { "app", "caller" }' });
    const app = String(req.body?.app || door.apps[0]);
    if (!door.apps.includes(app)) return res.status(400).json({ error: 'bad_app', detail: `app must be one of ${door.apps.join(', ')}` });
    const caller = req.body?.caller && door.callers.some((c) => c.id === req.body.caller) ? req.body.caller : door.callers[0].id;
    setAllowedOrigins([door.origin]); // the netguard lets the Real hop reach exactly this gateway origin and nothing else
    // Rule 27: each answer the lab receives is one stdout line and one `response` row of this run, stamped when the reply came in (the helper also closes its session
    // after the reply, so the time after the await is not the reply's). The run's id goes back so the page asks for THIS run's record.
    const check = safely('begin-check', () => runLog.beginCheck(caller));
    const listStarted = check?.mark();
    const { wire: listWire, ...listing } = await door.list(app, caller);
    safely('tools-list-reply', () => check?.reply('tools/list', listing, listStarted));
    const out = { app, caller, gateway: door.origin, listing };
    // "What Privilege did" (Rule 25): a Real trace is built from the hop's own capture, so every decision is observed or inferred, never checked.
    const trace = { listing: traceFromDoor({ ...listing, wire: listWire }, { rpcMethod: 'tools/list' }) };
    if (listing.ok) {
      // An aggregate door names every tool <server>__<name> and rejects any other shape before it judges the call, which would show the shape error and not a
      // refusal. So the probe borrows the server prefix of the first listed tool; a plain-named door keeps the plain name. The name exists nowhere, so nothing runs.
      const first = listing.tools?.[0]?.name;
      const server = typeof first === 'string' && first.includes('__') ? first.split('__')[0] : '';
      const probeStarted = check?.mark();
      const { wire: probeWire, ...probe } = await door.call(app, caller, `${server ? `${server}__` : ''}ai_policies_refusal_probe_tool`, {});
      safely('probe-reply', () => check?.reply('probe', probe, probeStarted));
      out.refusal = probe;
      trace.refusal = traceFromDoor({ ...probe, wire: probeWire }, { rpcMethod: 'tools/call' });
    } else safely('probe-skipped', () => check?.skipped('The refusal probe is only sent after tools/list is answered with a tool list; it was not sent.'));
    safely('end-check', () => check?.end());
    res.json({ ...out, ...(check ? { runId: check.id } : {}), trace });
  });

  // The record of one run (rule 27). Mock: the recorded scenario's events. Real: what the lab received on a gateway check (the newest, or ?runId=). A run is only ever
  // returned in the mode it was made in: the route follows the server's current mode, and a Real run is never built from a Mock table or the other way round.
  // The wire value of the mode is mock|real; this lab's internal mode is mock|live, and Live is Real. The two are answered by name, so a third value would get a plain note.
  api.get('/run-observability', async (req, res) => {
    noStore(res);
    const q = req.query;
    if (!Object.keys(q).every((k) => ['vertical', 'scenario', 'runId'].includes(k))) return res.status(400).json({ error: 'unknown_field', message: 'the query carries a parameter the lab does not take' });
    try {
      const source = toSource(current);
      if (source === 'real') {
        if (q.runId !== undefined && typeof q.runId !== 'string') return res.status(400).json({ error: 'bad_run_id', message: 'runId must be one id' });
        const run = runLog.get(q.runId);
        if (!run) return res.json({ record: null, message: q.runId === undefined ? 'No gateway check has run in Real yet: nothing was received from the gateway, so there is nothing to show.' : 'That gateway check is no longer kept (the lab keeps the last few).' });
        return res.json({ record: await realRecord(run) });
      }
      if (source === 'mock') {
        if (q.vertical !== undefined && (typeof q.vertical !== 'string' || !Object.hasOwn(table.verticals, q.vertical))) return res.status(400).json({ error: 'bad_vertical', message: 'the lab has no such vertical' });
        const vertical = verticalOf(req);
        const sc = q.scenario;
        if (sc !== undefined && (typeof sc !== 'string' || !table.verticals[vertical].scenarios.some((s) => s.id === sc))) return res.status(404).json({ error: 'unknown_scenario', message: 'there is no such scenario in this pack' });
        return res.json({ record: await mockRecord(table, vertical, sc) });
      }
      return res.json({ record: null, message: 'The lab is in a mode that has no run record.' });
    } catch (err) {
      if (err instanceof RunObsError) return res.status(err.status).json({ error: err.code, message: err.message });
      reportFailure('record', err);
      return res.status(500).json({ error: 'run_record_failed', message: 'The record of this run could not be built; the server log says why.' });
    }
  });
  api.get('/state', (req, res) => {
    const id = ws(req, res); if (!id) return;
    noStore(res);
    const mode = modeOf(req.query.mode); if (!mode) return res.status(400).json({ error: 'bad_mode', detail: 'mode must be mock or live' });
    const vertical = verticalOf(req);
    if (mode === 'mock') { labData(res); return res.json({ mode, vertical, workspace: id, ...mockState(table, vertical, req.query.scenario, castFor(req)) }); }
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
        const r = runAction({ ws: id, workspaces, vertical, cast: castFor(req), op, params: params(req), traceparent: req.headers.traceparent, route: { method: method.toUpperCase(), url: `/api${route}` }, observe: (r) => runLog.live(r) });
        res.set('traceparent', r.traceparent);
        const common = { workspace: id, mode, vertical, hops: r.hops, hopsTruncated: r.hopsTruncated, traceId: r.traceId, state: r.state };
        // Honest status codes: an evaluation answers 200 (allow), 401 (a token that does not verify) or 403 (deny, hold, withhold), and says which in the body. A refusal by
        // the engine is its own 4xx. The browser logs each of those 4xx answers as a console message; the README says so.
        // Rule 25: an evaluation is the one call to the (simulated) gateway, so it carries "What Privilege did". The request is shown whole (masked, never cut) and without the token.
        if (r.outcome.ok && op === 'evaluate') {
          const { token, ...rest } = params(req);
          return res.status(r.status).json({ ok: true, result: r.outcome.result, trace: policyTrace({ cast: castFor(req), request: scrubWhole(rest), tokenNote: token === undefined ? null : 'lab token as sent', decision: r.outcome.result }), ...common });
        }
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
    // Real files only: no directory index, no redirect, dotfiles ignored. The page shell is for PAGE ADDRESSES only (isPageAddress) asked for by a client that accepts HTML;
    // a missing asset, map, icon or dotfile is the JSON 404 below, never a 200 HTML page.
    app.use(express.static(webDist, { index: false, dotfiles: 'ignore', redirect: false, fallthrough: true }));
    app.use((req, res, next) => ((req.method === 'GET' || req.method === 'HEAD') && (req.get('accept') ?? '').includes('text/html') && isPageAddress(req.path) ? res.sendFile(path.join(webDist, 'index.html')) : next()));
  }
  // The last two handlers catch everything that is left, for every method and every path: Express's default answers ("Cannot POST /<path>", or an
  // HTML stack trace with file paths) would echo the path the visitor typed, which may be a token. Fixed JSON, no path.
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof InputError) return res.status(err.status).json({ error: err.code, detail: err.message });
    if (res.headersSent) return res.end();
    // a short whitelist of statuses and FIXED codes: err.message, err.stack and anything typed are never sent
    const status = [400, 413, 415].includes(Number(err?.status || err?.statusCode)) ? Number(err.status || err.statusCode) : 500;
    return res.status(status).json({ error: { 400: 'bad_request', 413: 'payload_too_large', 415: 'unsupported_charset', 500: 'internal_error' }[status] });
  });
  return app;
}

export function startHttpServer({ port, host, app = createApp() } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve({ server, url: `http://${host}:${server.address().port}/` }));
    server.once('error', reject);
  });
}
