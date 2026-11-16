// The glue between the HTTP layer and the engine: Mock reads tables, Live drives the workspace's engine. Every action gets one W3C
// trace and a list of hops (the raw request and response panes), with anything credential-shaped masked.
import { Engine } from './engine.js';
import { perform } from './actions.js';
import { cleanFree, cleanUnderKey } from './credentials.js';
import { newTrace, formatTraceparent } from './trace.js';
import { policyTrace } from './policyTrace.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A copy of the visitor's parameters that is safe to show: strings cleaned and masked (a token is credential-shaped, so it shows as [masked:jwt]), nothing else changed. Iterative and depth-limited.
// SHOWN is the cut the hop panes use. WHOLE is for the Rule 25 trace, which shows the exact request, never capped: no length, count or key cut (only a depth stop of 32,
// far past the engine's own limit of 6, so a call the engine accepts is shown whole and hostile nesting cannot overflow the stack). Masking runs before any cut either way.
const SHOWN = { text: 300, key: 40, items: 10, keys: 20, depth: 3 };
const WHOLE = { text: Infinity, key: Infinity, items: Infinity, keys: Infinity, depth: 32 };
export function scrub(value, depth = 0, cut = SHOWN) {
  if (typeof value === 'string') return cleanFree(value, cut.text);
  if (Array.isArray(value)) return depth > cut.depth ? [] : value.slice(0, cut.items).map((v) => scrub(v, depth + 1, cut));
  if (isObj(value)) return depth > cut.depth ? {} : Object.fromEntries(Object.keys(value).slice(0, cut.keys).map((k) => [cleanFree(k, cut.key), typeof value[k] === 'string' || typeof value[k] === 'number' || typeof value[k] === 'boolean' ? cleanUnderKey(k, value[k], cut.text) : scrub(value[k], depth + 1, cut)]));
  return typeof value === 'number' || typeof value === 'boolean' || value === null ? value : undefined;
}
export const scrubWhole = (value) => scrub(value, 0, WHOLE);

// "What Privilege did" for one Mock step: built here, at read time, from the step's call and the decision the lab's own engine recorded (the table is not regenerated).
// Only an evaluation is a call to the gateway; the other ops (decide, advance, save a policy) are lab actions and get no trace.
const withTrace = (cast) => (s) => (s.op === 'evaluate' && s.result?.trace ? { ...s, trace: policyTrace({ cast, request: s.request, tokenNote: s.claims ? `lab-minted RS256 token${s.tampered ? ', one character changed after signing' : ''}` : null, decision: s.result }) } : s);

export function mockState(table, vertical, scenarioId, cast) {
  const v = table.verticals[vertical];
  const sc = (typeof scenarioId === 'string' && v.scenarios.find((s) => s.id === scenarioId)) || v.scenarios[0];
  return { state: sc.state, scenario: { id: sc.id, title: sc.title, say: sc.say, steps: cast ? sc.steps.map(withTrace(cast)) : sc.steps }, scenarios: v.scenarios.map((s) => ({ id: s.id, title: s.title, say: s.say })), canonicalExamples: v.canonicalExamples };
}

export function liveState(ws, workspaces, vertical, cast) {
  const e = workspaces.peek(ws, vertical) || new Engine(cast);
  return e.snapshot();
}

// Runs one engine action for a workspace with a trace. Returns { outcome, hops, traceparent, state }.
export function runAction({ ws, workspaces, vertical, cast, op, params, traceparent, route }) {
  const e = workspaces.engine(ws, vertical, cast);
  const t = newTrace(traceparent);
  const root = t.span();
  e.trace = { traceId: t.traceId, span: t.span }; e.hops = []; e.hopsTruncated = false;
  let outcome;
  try { outcome = perform(e, op, params); } finally { e.trace = null; }
  const status = outcome.ok ? (outcome.result?.http ?? 200) : outcome.status;
  const first = { n: 1, label: 'browser to the lab API', request: { method: route.method, url: route.url, headers: { traceparent: formatTraceparent(t.traceId, root), 'x-workspace': ws }, body: scrub(params) }, response: { status, body: outcome.ok ? { ok: true } : { error: outcome.code } } };
  const hops = [first, ...e.hops.map((h, i) => ({ ...h, n: i + 2 }))];
  const truncated = e.hopsTruncated; e.hops = [];
  return { outcome, status, hops, hopsTruncated: truncated, traceparent: formatTraceparent(t.traceId, root), traceId: t.traceId, state: e.snapshot() };
}
