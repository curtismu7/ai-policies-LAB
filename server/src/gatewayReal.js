// gateway-real/gatewayClient.js — the shared real Privilege-gateway hop for standalone labs.
//
// One dependency-free MCP-over-HTTP client plus a settings loader. Real mode in a lab means:
// an agent access key from the one shared settings file (~/Development/.env, or STANDALONE_ENV)
// calling a live Privilege MCP door (https://<gateway>/<app>/mcp). This is the wire that
// mcp-tools-LAB, aggregate-entitlement-LAB and privilege-logging-LAB measured live (2026-11).
//
// Rules carried over from the family's measured client:
// - redirects are never followed (never forward an auth header to a redirect target)
// - replies are capped in size and time
// - the agent key is write-only: it is scrubbed from every message, error and log line
// - a 404 mid-session restarts the session once (the spec's "session not found" signal)
//
// No dependencies. ESM. Node >= 22.

export const PROTOCOL_VERSION = '2025-06-18';
const MAX_BYTES = 4 * 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

const APP = /^[a-z0-9][a-z0-9-]{0,62}$/;
const NAME = /^[A-Z0-9][A-Z0-9_]{0,31}$/;

export function rpcError(message, code, extra = {}) {
  return Object.assign(new Error(String(message).slice(0, 300)), { code, ...extra });
}

// Messages in an SSE body: each event's data lines joined, parsed as JSON.
export function sseMessages(text) {
  const out = [];
  for (const ev of text.split(/\r?\n\r?\n/)) {
    const data = ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data) continue;
    try { out.push(JSON.parse(data)); } catch { /* not JSON: ignore */ }
  }
  return out;
}

async function readReply(res, id) {
  const sse = /text\/event-stream/i.test(res.headers.get('content-type') || '');
  const reader = res.body?.getReader();
  if (!reader) return undefined;
  const dec = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_BYTES) throw rpcError(`reply larger than ${MAX_BYTES} bytes`, 'mcp_reply_too_large');
      text += dec.decode(value, { stream: true });
      if (sse && sseMessages(text).some((m) => m && m.id === id)) break; // a stream that stays open is not waited on
    }
  } finally { reader.cancel().catch(() => {}); }
  text = text.trim();
  if (!text) return undefined;
  if (sse) { const msgs = sseMessages(text); return msgs.find((m) => m && m.id === id) ?? msgs.at(-1); }
  try { return JSON.parse(text); } catch { throw rpcError('reply is not JSON', 'mcp_bad_reply'); }
}

// ---- Wire capture (additive; off unless asked) ----------------------------------------------------
// With `onWire`, the client reports every HTTP exchange it makes: what was sent, what came back, how long it took.
// Redaction happens HERE, at capture, so nothing downstream ever holds a credential: the auth header's value is
// replaced by its length, the session id is shortened, and response headers are an allowlist (never a cookie).
const RESPONSE_HEADERS = ['content-type', 'www-authenticate', 'retry-after', 'x-request-id', 'request-id', 'x-correlation-id', 'date', 'server'];
const shortSession = (v) => (String(v).length > 8 ? `${String(v).slice(0, 8)}… (shortened)` : String(v));

export function wireRequestHeaders(headers, authName) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const lower = k.toLowerCase();
    if (lower === 'mcp-session-id') out[k] = shortSession(v);
    else if (lower === String(authName || '').toLowerCase() || lower === 'authorization') {
      const scheme = /^(Bearer|DPoP|Basic) /i.exec(String(v));
      out[k] = `${scheme ? `${scheme[1]} ` : ''}<agent key, ${String(v).length - (scheme ? scheme[0].length : 0)} characters, kept on the server>`;
    } else out[k] = String(v);
  }
  return out;
}

export function wireResponseHeaders(headers) {
  const out = {};
  for (const name of RESPONSE_HEADERS) { const v = headers?.get?.(name); if (v) out[name] = String(v).slice(0, 300); }
  const sid = headers?.get?.('mcp-session-id');
  if (sid) out['mcp-session-id'] = shortSession(sid);
  return out;
}

const parsedOrText = (raw) => { try { return JSON.parse(raw); } catch { return raw; } };
// A captured body bigger than this is replaced by a note saying so (never cut in the middle).
export const MAX_CAPTURED_BODY = 256 * 1024;

export function createHttpClient({ url, getAuth, timeoutMs = 15_000, clientInfo = { name: 'standalone-lab', version: '0.1.0' }, onWire }) {
  const state = { sessionId: null, protocolVersion: null, initialized: false, pending: null, info: null };
  let msgId = 0;

  async function post(method, params, id) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    const auth = getAuth?.();
    if (auth) headers[auth[0]] = auth[1];
    if (state.sessionId) headers['Mcp-Session-Id'] = state.sessionId;
    if (method !== 'initialize') headers['MCP-Protocol-Version'] = state.protocolVersion || PROTOCOL_VERSION;
    const envelope = id === undefined ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params };
    const rec = onWire ? { http: 'POST', url, rpcMethod: method, request: { headers: wireRequestHeaders(headers, auth?.[0]), body: envelope }, response: null, at: new Date().toISOString() } : null;
    const started = Date.now();
    try {
      let res;
      try {
        res = await fetch(url, { method: 'POST', headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), body: JSON.stringify(envelope) });
      } catch (err) {
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw rpcError(`MCP HTTP request timed out after ${timeoutMs}ms`, 'mcp_timeout');
        throw rpcError(`MCP HTTP request unreachable (${err?.cause?.code || err?.code || 'network error'})`, 'mcp_unreachable');
      }
      if (rec) rec.response = { status: res.status, headers: wireResponseHeaders(res.headers), body: null };
      if (res.status >= 300 && res.status < 400) { res.body?.cancel().catch(() => {}); throw rpcError(`MCP HTTP ${res.status}: redirects are not followed`, 'mcp_http_error', { httpStatus: res.status }); }
      if (!res.ok) {
        const full = await res.text().catch(() => '');
        const raw = full.slice(0, 2000);
        if (rec) rec.response.body = full ? parsedOrText(full.slice(0, MAX_CAPTURED_BODY)) : null; // cut after the scrub, in createRealDoor
        const body = raw.slice(0, 300);
        throw rpcError(`MCP HTTP ${res.status}${body ? `: ${body}` : ''}`, 'mcp_http_error', { httpStatus: res.status });
      }
      const sid = res.headers.get('mcp-session-id');
      if (sid) state.sessionId = sid;
      const json = id === undefined ? (res.body?.cancel().catch(() => {}), undefined) : await readReply(res, id);
      if (rec) rec.response.body = json ?? null;
      if (json?.error) throw rpcError(json.error.message || 'MCP JSON-RPC error', 'mcp_rpc_error', { mcpCode: json.error.code });
      // a call that expects an answer and got none (an empty body, or a stream with no matching reply) is no reply, never an empty result
      if (id !== undefined && json?.result === undefined) throw rpcError('MCP HTTP reply had no result', 'mcp_no_reply');
      return json?.result;
    } catch (err) {
      if (rec && !rec.response) rec.error = String(err?.message || 'failed').slice(0, 300);
      throw err;
    } finally {
      if (rec) { rec.ms = Date.now() - started; try { onWire(rec); } catch { /* a capture hook never breaks the call */ } }
    }
  }

  async function handshake() {
    const result = await post('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo }, ++msgId);
    state.protocolVersion = result?.protocolVersion || PROTOCOL_VERSION;
    state.info = { protocolVersion: state.protocolVersion, serverInfo: result?.serverInfo || null, capabilities: result?.capabilities || {} };
    await post('notifications/initialized', {});
    state.initialized = true;
  }
  const ensure = () => {
    if (state.initialized) return Promise.resolve();
    state.pending ||= handshake().finally(() => { state.pending = null; });
    return state.pending;
  };

  async function rpc(method, params = {}) {
    await ensure();
    try { return await post(method, params, ++msgId); } catch (err) {
      if (err.httpStatus === 404 && state.sessionId) {
        state.initialized = false; state.sessionId = null;
        await ensure();
        return post(method, params, ++msgId);
      }
      throw err;
    }
  }

  return {
    ensure, rpc,
    info: () => state.info,
    async close() {
      if (!state.sessionId) return;
      const headers = { 'Mcp-Session-Id': state.sessionId };
      const auth = getAuth?.();
      if (auth) headers[auth[0]] = auth[1];
      const rec = onWire ? { http: 'DELETE', url, rpcMethod: 'session close', request: { headers: wireRequestHeaders(headers, auth?.[0]), body: null }, response: null, at: new Date().toISOString() } : null;
      const started = Date.now();
      const res = await fetch(url, { method: 'DELETE', headers, redirect: 'manual', signal: AbortSignal.timeout(3000) }).catch(() => null);
      if (rec) { rec.response = res ? { status: res.status, headers: wireResponseHeaders(res.headers), body: null } : null; if (!res) rec.error = 'no answer'; rec.ms = Date.now() - started; try { onWire(rec); } catch { /* ignore */ } }
      res?.body?.cancel().catch(() => {});
      state.sessionId = null; state.initialized = false;
    },
  };
}

// ---- Settings from the one shared settings file ---------------------------------------------------

export function readFileSettings(file, prefix) {
  const out = {};
  try {
    const re = new RegExp(`^${prefix}_GW_[A-Z0-9_]+=(.*)$`);
    for (const line of String(file ?? '').split('\n')) {
      const m = line.match(re);
      if (m) out[re.exec(line)[0].split('=')[0]] = m[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* no file */ }
  return out;
}

// -> { ok:true, origin, apps, callers:[{id,label,key}], version } | { ok:false, problem }
export function doorConfig(text, prefix) {
  const s = { ...readFileSettings(text, prefix) };
  const notSet = `Set ${prefix}_GW_URL, ${prefix}_GW_APPS and at least one ${prefix}_GW_KEY_<NAME> in ~/Development/.env (or STANDALONE_ENV). Mock keeps working.`;
  if (!s[`${prefix}_GW_URL`]) return { ok: false, problem: `Real is not configured: no gateway URL. ${notSet}` };
  let url;
  try { url = new URL(s[`${prefix}_GW_URL`]); } catch { return { ok: false, problem: `Real is not configured: ${prefix}_GW_URL is not a URL. ${notSet}` }; }
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname)))) return { ok: false, problem: 'Real is not configured: the gateway URL must be https (http only on loopback).' };
  const apps = String(s[`${prefix}_GW_APPS`] || '').split(',').map((a) => a.trim()).filter(Boolean);
  if (!apps.length || apps.some((a) => !APP.test(a))) return { ok: false, problem: `Real is not configured: ${prefix}_GW_APPS must list door names (lowercase letters, digits, dashes), comma-separated. ${notSet}` };
  const callers = Object.entries(s).filter(([k]) => k.startsWith(`${prefix}_GW_KEY_`)).map(([k, key]) => ({ id: k.slice(`${prefix}_GW_KEY_`.length), key }))
    .filter((c) => NAME.test(c.id) && c.key && !/[\s\u0000-\u001f]/.test(c.key))
    .map((c) => ({ ...c, id: c.id.toLowerCase(), label: c.id.charAt(0) + c.id.slice(1).toLowerCase().replace(/_/g, ' ') }));
  if (!callers.length) return { ok: false, problem: `Real is not configured: no agent key. ${notSet}` };
  const version = /^[A-Za-z0-9._+-]{1,40}$/.test(s[`${prefix}_GW_VERSION`] || '') ? s[`${prefix}_GW_VERSION`] : null;
  return { ok: true, origin: url.origin, apps, callers, version };
}

// Scrub every key occurrence from a message (a key is never shown, logged or echoed).
export function scrub(text, keys) {
  let out = String(text ?? '');
  // Longest first: a key that is a prefix of another must not leave the rest of the longer one behind.
  for (const k of [...keys].filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(k).join('<redacted>');
  return out;
}

// The same, over every string inside a value (not over its JSON text: a key holding a quote or backslash would not match
// the escaped form, and a key such as `200` or `null` would rewrite a number or a null and break the JSON).
export function scrubDeep(value, keys) {
  if (typeof value === 'string') return scrub(value, keys);
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, keys));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [scrub(k, keys), scrubDeep(v, keys)]));
  return value;
}

// Which layer a gateway refusal came from. Our reading of the gateway's words, not a field it sends.
export function readRefusal(err) {
  const msg = String(err?.message || '');
  if (err?.httpStatus === 401) return 'key';
  if (/refused by policy|blocked by policy|not allowed|forbidden|Access Denied|content_blocked/i.test(msg) || err?.httpStatus === 403) return 'policy';
  if (/failed to connect|unreachable|connection refused|timed out/i.test(msg)) return 'unreachable';
  if (/unknown tool|tool not found|no such tool/i.test(msg)) return 'unknown';
  return 'other';
}

// ---- The lab-facing API ---------------------------------------------------------------------------

// text = the full shared settings file contents. Each lab wires: read file -> doorConfig(text, 'XYZ').
export function createRealDoor({ config, client = createHttpClient, clientInfo, capture = false } = {}) {
  if (!config?.ok) return null;
  const secrets = () => config.callers.map((c) => c.key);
  // `code` says which fault it was: only a JSON-RPC error inside a successful HTTP reply (mcp_rpc_error) is the gateway's own answer; a fault with no status is not.
  const refusal = (err) => ({ status: err?.httpStatus ?? null, code: err?.code ?? null, message: scrub(err?.message || 'the gateway refused', secrets()).slice(0, 400), layer: readRefusal(err) });

  // `capture: true` adds a `wire` array to every result (additive): each HTTP exchange of the call, redacted at capture.
  const sized = (w) => {
    const b = w?.response?.body;
    const n = b == null ? 0 : typeof b === 'string' ? b.length : JSON.stringify(b).length;
    return n > MAX_CAPTURED_BODY ? { ...w, response: { ...w.response, body: { note: `the reply is ${n} characters: too large to show` } } } : w;
  };
  // Scrub first, then size, so a key can never be left half-cut by a size limit. It never throws: a capture is a view of the call, not part of it.
  const scrubWire = (wire) => { try { return scrubDeep(wire, secrets()).map(sized); } catch { return []; } };
  function open(app, callerId, wire) {
    const c = config.callers.find((x) => x.id === callerId) ?? config.callers[0];
    const base = { url: `${config.origin}/${app}/mcp`, getAuth: () => ['Authorization', `Bearer ${c.key}`], clientInfo };
    return client(wire ? { ...base, onWire: (w) => wire.push(w) } : base);
  }

  // One tools/list through the door. -> { ok, tools, ms } | { ok:false, refusal, ms }
  async function list(app, callerId) {
    const wire = capture ? [] : null;
    const mcp = open(app, callerId, wire);
    const started = Date.now();
    try {
      const r = await mcp.rpc('tools/list', {});
      const tools = (Array.isArray(r?.tools) ? r.tools : []).slice(0, 400).map((t) => ({ name: String(t?.name ?? '').slice(0, 160), description: String(t?.description ?? '').slice(0, 300) }));
      const ok = { ok: true, tools: JSON.parse(scrub(JSON.stringify(tools), secrets())), ms: Date.now() - started, serverInfo: mcp.info()?.serverInfo ?? null };
      await mcp.close().catch(() => {});
      return wire ? { ...ok, wire: scrubWire(wire) } : ok;
    } catch (err) {
      const bad = { ok: false, refusal: refusal(err), ms: Date.now() - started };
      await mcp.close().catch(() => {});
      return wire ? { ...bad, wire: scrubWire(wire) } : bad;
    }
  }

  // One tools/call through the door. -> { ok, isError, text, ms } | { ok:false, refusal, ms }
  async function call(app, callerId, tool, args = {}) {
    const wire = capture ? [] : null;
    const mcp = open(app, callerId, wire);
    const started = Date.now();
    try {
      const r = await mcp.rpc('tools/call', { name: tool, arguments: args });
      const text = Array.isArray(r?.content) ? r.content.map((x) => (x?.type === 'text' ? x.text : `[${x?.type}]`)).join('\n') : '';
      const ok = { ok: true, isError: r?.isError === true, text: scrub(text, secrets()).slice(0, 800), ms: Date.now() - started };
      await mcp.close().catch(() => {});
      return wire ? { ...ok, wire: scrubWire(wire) } : ok;
    } catch (err) {
      const bad = { ok: false, refusal: refusal(err), ms: Date.now() - started };
      await mcp.close().catch(() => {});
      return wire ? { ...bad, wire: scrubWire(wire) } : bad;
    }
  }

  return { origin: config.origin, apps: config.apps, callers: config.callers.map(({ id, label }) => ({ id, label })), version: config.version, list, call };
}

// Standard /api/info fields for a lab whose real mode is this hop.
export function rule19View(door, wantedMode) {
  return {
    source: wantedMode,
    realAvailable: Boolean(door),
    realReason: door ? null : 'Real needs the gateway settings (see the README): gateway URL, door names and an agent key in the shared settings file.',
  };
}
