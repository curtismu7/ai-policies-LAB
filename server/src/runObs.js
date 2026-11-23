// Rule 27: this lab's side of the shared run-observability panel. The vendored collector (runObservability.js) is never edited here.
//
// What a run is here. The lab's decisions are made by its own engine (engine.js): evaluate() runs the pipeline once, stamps ONE decision with the lab clock and
// lists every layer it reached, in order; decide() is an approver's signature or refusal. observeAction() reads that answer (and the audit entries the action
// wrote) and turns it into events: nothing is computed twice, nothing is re-run, and a layer the pipeline did not reach has no event. The time of an event is
// the lab clock the engine stamped (it moves only when the visitor moves it, so the events of one evaluation tie; their order is kept).
//
// Mock reads the recorded tables, so its record is built from the events stored in the table when it was generated (scenarios.js runs the same
// observeAction for every scripted step). Nothing runs when a table is read, so Mock writes no stdout line.
// Live (rule 19 Real) runs the engine on the visitor's own actions: each event is one stdout line, written when the action ran. A Real record holds only
// what the lab RECEIVED from the Privilege gateway (the agent key's tools/list and one probe): `response` rows, never `logged`. The lab's own engine
// decides in every mode, so its events are never `response` and never in a Real record.
//
// Stdout line: `<iso> ai-policies-lab decision step=<step> layer=<layer> actor=<who> result=<passed|stopped|unclear|no-reply> cause=<cause> [ev=<id>] [approval=<id>] [labtime=<lab clock>] run=<id>`.
// The family's matchers read words such as refused, denied, rejected, forbidden, failed, invalid, expired, mismatch, token, audience, scope and served,
// so steps and causes come from the tables below (an engine code goes through causeWord) and use none of them. A line never holds a token, an argument, an
// agent key or a gateway address: it carries roster names, step words and ids the lab wrote. A test runs every line kind through the shared classify().
import crypto from 'node:crypto';
import { createMasker, createRunObservability, LAYERS } from './runObservability.js';
import { STAGE_TITLE } from './engine.js';
import { LAYERS as POLICY_LAYERS } from './policies.js';

export const SERVICE = 'ai-policies-lab';
export const KEEP_RUNS = 5; // Real runs kept (complete ones only: a run is stored when it ends, so the open run is never evicted)

// Only safe characters survive, so a typed name cannot add a second key=value pair, a quote or a line.
export const lineValue = (v, n = 64) => String(v ?? '').replace(/[^A-Za-z0-9._:/@-]+/g, '_').slice(0, n) || '-';
// The panel masks emails, addresses and ids in every row, so the stdout line masks them too (then keeps only safe characters).
const { mask } = createMasker();
const field = (v) => lineValue(mask(String(v ?? '')));
// The lab's outcomes are allowed, refused, blocked (its own fail-closed stop, or an inspection rule's withhold) and info.
const RESULT = { allowed: 'passed', refused: 'stopped', blocked: 'stopped', info: 'unclear' };

// An engine code reads as a cause on the line, without the words the shared matchers read.
const SWAP = { refused: 'turned-away', denied: 'turned-away', rejected: 'turned-away', forbidden: 'barred', failed: 'unsuccessful', invalid: 'unusable', expired: 'lapsed', mismatch: 'differs', token: 'credential', audience: 'recipient', scope: 'permission', served: 'delivered' };
export const causeWord = (code) => lineValue(String(code).replace(/_/g, '-')).replace(/refused|denied|rejected|forbidden|failed|invalid|expired|mismatch|token|audience|scope|served/gi, (m) => SWAP[m.toLowerCase()]);

// A recorder that throws must never break the run or the audit: the failure goes to stderr and the run goes on. Only a code (or the error's name) and a fixed
// text are written: the error's own text could carry anything, so it is never logged.
export function reportFailure(where, err) {
  process.stderr.write(`[${SERVICE}] run observability: ${lineValue(where, 40)} ${lineValue(err?.code || err?.name || 'error', 40)} (the error's text is not logged)\n`);
}
export function safely(where, fn) {
  try { return fn(); } catch (err) { reportFailure(where, err); return undefined; }
}

// ---- Engine events ----------------------------------------------------------------------------------------------------------------------------
const iso = (ms) => new Date(ms).toISOString();
const P = { claims: 'lab claim reader (no sign-in)', token: 'lab token check', policy: 'lab policy engine', gateway: 'lab simulated gateway' };

// The pipeline's stages, by who decides them. The three the lab's own gateway runs (reading the call, checking the credential, making the simulated call) decide
// nothing when they pass, so only a stop is a row (a verified credential is information). The seven policy stages are the layers the lab models as Privilege policy.
const GATEWAY_STAGES = { request: 'request-read', token: 'credential-check', call: 'call-made' };
const POLICY_STAGES = { surface: 'surface-check', application: 'application-check', action: 'action-check', 'end-user': 'end-user-check', 'attended-unattended': 'hold-check', 'request-inspection': 'request-scan', 'reply-inspection': 'reply-scan' };
// A code the lab raises because it cannot read a value or a layer broke (it fails closed) is the lab's own stop: `blocked`, not a policy rule saying no.
const OWN_STOPS = new Set(['claim_type', 'argument_type', 'argument_missing', 'inspection_would_refuse', 'hold_unfillable', 'hold_without_approval']);
const FAIL_CLOSED = ' The lab stops the call itself here (it fails closed): this is the lab\'s own rule, not a policy rule.';

function outcomeOf(s) {
  if (s.verdict === 'pass') return 'allowed';
  if (s.verdict === 'hold') return 'info';
  if (s.verdict === 'withhold' || s.failedClosed || OWN_STOPS.has(s.code)) return 'blocked';
  return 'refused';
}

// The approval a stage names (a hold opened or re-used, a grant that lifted it, a grant that was refused): an id the engine wrote.
const approvalOf = (s) => (typeof s.detail?.approval === 'string' ? s.detail.approval : typeof s.detail?.grant === 'string' ? s.detail.grant : null);

const sentence = (t) => (/[.!?]$/.test(t) ? t : `${t}.`);

function stageEvent(d, s, who) {
  const gate = Object.hasOwn(GATEWAY_STAGES, s.stage);
  // Reading the call and the simulated call are the lab's own stops; a credential that does not verify is the gateway turning the call away (HTTP 401).
  const outcome = gate ? (s.stage === 'token' && !s.failedClosed ? 'refused' : 'blocked') : outcomeOf(s);
  const own = outcome === 'blocked' && s.verdict !== 'withhold';
  return {
    layer: gate ? 'gateway' : 'privilege', product: gate ? P.gateway : P.policy, step: gate ? GATEWAY_STAGES[s.stage] : POLICY_STAGES[s.stage],
    outcome, cause: s.verdict === 'pass' ? 'passed' : causeWord(s.code), who, at: d.at, ev: d.id, approval: approvalOf(s),
    message: `${s.title}: ${sentence(s.reason)}${own ? FAIL_CLOSED : ''}${s.stage === 'token' && outcome === 'refused' ? ` The lab's gateway answered HTTP ${d.http}.` : ''}`,
    detail: { ev: d.id, stage: s.stage, reason: s.code },
  };
}

// The person behind the agent, read from the end-user stage's own entry: a name only when the roster has it (the stage never keeps a typed name).
function claimEvent(d, s) {
  const person = typeof s.detail?.user === 'string' ? s.detail.user : typeof s.detail?.resolved === 'string' ? s.detail.resolved : null;
  const what = person ? `names ${person}, who is on the roster, as the person behind the agent`
    : s.code === 'claim_type' ? 'is not a text value, so it names no one'
      : 'names no one the roster knows as the person behind the agent';
  return {
    layer: 'person', product: P.claims, step: 'end-user-claim', outcome: 'info', cause: person ? 'on-roster' : 'no-one', who: person, at: d.at, ev: d.id,
    message: `The token's end_user claim ${what}. The lab has no sign-in: this is a claim in its own token, not an identity provider event.`,
    detail: { ev: d.id },
  };
}

const credentialEvent = (d, who) => ({
  layer: 'agent', product: P.token, step: 'credential-check', outcome: 'info', cause: 'verified', who, at: d.at, ev: d.id,
  message: `The lab verified the token it minted (RS256 signature, issuer, audience and time on the lab clock)${who ? ` for ${who}` : ''}. Verifying a credential is information, not a policy decision.`,
  detail: { ev: d.id },
});

// What the lab's gateway answered, once per evaluation. It restates the decision of the layer that decided, so it is information; a stop of the lab's own gateway
// stages (reading the call, the credential, the simulated call) is already its own row, so it has no restatement.
function answerEvent(d, who) {
  const where = STAGE_TITLE[d.stage] || 'a layer';
  const [cause, said] = d.outcome === 'allow' ? ['released', 'every layer passed and it released the simulated reply to the agent']
    : d.outcome === 'hold' ? ['held', `the call is held for a person${d.approval?.ref ? ` (approval ${d.approval.ref})` : ''}; nothing is held open`]
      : d.outcome === 'withhold' ? ['withheld', 'the call was made and its result was withheld at reply inspection']
        : [`stopped-${d.stage}`, `the call stopped at ${where}`];
  return {
    layer: 'gateway', product: P.gateway, step: 'gateway-answer', outcome: 'info', cause: causeWord(cause), who, at: d.at, ev: d.id, approval: d.approval?.ref || d.grantUsed?.ref || null,
    message: `The lab's gateway answered HTTP ${d.http}: ${said}. This restates the decision above, so it is counted as information.`,
    detail: { ev: d.id, http: d.http, outcome: d.outcome, stoppedAt: d.stage },
  };
}

export function evaluateEvents(d) {
  const who = d.identity ?? null;
  const out = [];
  for (const s of Array.isArray(d.trace) ? d.trace : []) {
    if (s.verdict === 'not-reached') continue;
    const pass = s.verdict === 'pass';
    if (s.stage === 'token' && pass) { out.push(credentialEvent(d, who)); continue; }
    if (pass && Object.hasOwn(GATEWAY_STAGES, s.stage)) continue; // reading the call and the simulated call decide nothing when they pass
    if (s.stage === 'end-user') out.push(claimEvent(d, s));
    out.push(stageEvent(d, s, who));
  }
  if (!(d.outcome === 'deny' && Object.hasOwn(GATEWAY_STAGES, d.stage))) out.push(answerEvent(d, who));
  return out;
}

// An approver's answer. The approver's name and level are typed on the page (the lab has no sign-in), so they are information; the check on them is the decision.
const DECIDE_REFUSALS = { self_approval: 'self-approval', role_missing: 'role-missing', auth_too_weak: 'weak-sign-in', auth_level_not_available: 'level-unavailable', duplicate_approver: 'already-signed', approver_unknown: 'not-an-approver', not_pending: 'already-decided' };

function decideEvents(e, { outcome, before, params }) {
  const person = (who, ref, at, said) => ({
    layer: 'person', product: P.claims, step: 'approver-act', outcome: 'info', cause: '-', who, at, approval: ref,
    message: `${who} ${said} on ${ref}. Typed on the page: the lab has no sign-in and does not check who is at the keyboard.`,
    detail: { approval: ref },
  });
  const decision = (who, ref, at, o, cause, message) => ({ layer: 'privilege', product: P.policy, step: 'approval-step', outcome: o, cause, who, at, approval: ref, message, detail: { approval: ref } });
  if (outcome.ok) {
    const entry = e.audit.slice(before.audit).find((x) => x.kind === 'approval');
    const a = entry && e.approvals.find((x) => x.ref === entry.ref);
    if (!entry || !a) return [];
    const { approver: who, ref, at } = entry;
    const level = a.approvals.find((x) => x.approver === who)?.authLevel;
    const act = entry.outcome === 'denied' ? 'turned the request down' : `signed at authentication level ${level}`;
    const row = entry.outcome === 'denied' ? decision(who, ref, at, 'refused', 'approver-declined', `${who} turned the approval request ${ref} down. A decision by an approver is final.`)
      : entry.outcome === 'approved' ? decision(who, ref, at, 'allowed', 'approved', `${who}'s signature completed ${ref} (${a.approvals.length} of ${a.required.approvers}): the approval is granted until ${a.grantUntil} on the lab clock. It can lift a hold and nothing above it.`)
        : decision(who, ref, at, 'info', 'signed-pending', `${who} signed ${ref}: ${a.approvals.length} of ${a.required.approvers} signatures so far, so the request is still pending.`);
    return [person(who, ref, at, `acted as approver (${act})`), row];
  }
  if (Object.hasOwn(DECIDE_REFUSALS, outcome.code)) {
    const a = e.approvals.find((x) => x.ref === params?.ref);
    if (!a) return [];
    const who = e.human(params.approver)?.id ?? null;
    const at = iso(e.clockMs);
    const rows = [decision(who, a.ref, at, 'refused', DECIDE_REFUSALS[outcome.code], `${who ?? 'The approver'} could not act on ${a.ref}: ${outcome.detail}.`)];
    return who ? [person(who, a.ref, at, 'tried to act as approver'), ...rows] : rows;
  }
  return [];
}

// A policy layer the lab's validator would not save: the lab's own stop. The layer is named only when it is one of the six the lab has.
function savePolicyEvents(e, { outcome, params }) {
  if (outcome.ok || outcome.code !== 'policy_refused') return [];
  const layer = POLICY_LAYERS.includes(params?.layer) ? params.layer : null;
  return [{
    layer: 'privilege', product: P.policy, step: 'policy-save', outcome: 'blocked', cause: 'not-saved', who: null, at: iso(e.clockMs),
    message: `The lab did not save ${layer ? `the ${layer} policy layer` : 'that policy layer'}: its validator stopped the save and nothing was changed. This is the lab's own check on an edit, not a decision about a call.`,
    detail: { policyLayer: layer },
  }];
}

// The state to remember before an action runs: the audit entries after it are the action's.
export const mark = (e) => ({ audit: e.audit.length });

// The events ONE action produced, in the order the engine decided them. `outcome` is what perform() answered ({ ok, result } or { ok: false, ... }).
// `noRun` is the cause of an action that was refused before any layer ran (a body the lab does not take, a full workspace): no events, no run, one line.
const NO_RUN_OPS = new Set(['evaluate', 'decide', 'savePolicy']);
export function observeAction(e, { op, outcome, before, params }) {
  let events = [];
  if (op === 'evaluate' && outcome.ok) events = evaluateEvents(outcome.result);
  else if (op === 'decide') events = decideEvents(e, { outcome, before, params });
  else if (op === 'savePolicy') events = savePolicyEvents(e, { outcome, params });
  const decided = events.length > 0 || outcome.ok || (op === 'decide' && Object.hasOwn(DECIDE_REFUSALS, outcome.code)) || (op === 'savePolicy' && outcome.code === 'policy_refused');
  return { events, noRun: !decided && NO_RUN_OPS.has(op) ? causeWord(outcome.code) : null };
}

// What a table keeps of an event: the row, not the words of the stdout line. A Mock run is a scripted scenario, so the step number is in the visible message.
export const tableEvent = (ev, seq, step) => ({ seq, at: ev.at, layer: ev.layer, product: ev.product, outcome: ev.outcome, message: `Step ${step}: ${ev.message}`, detail: { ...ev.detail, step } });

// ---- Stdout lines ---------------------------------------------------------------------------------------------------------------------------
export function decisionLine(ev, at, runId) {
  const result = ev.noReply ? 'no-reply' : RESULT[ev.outcome];
  const id = (name, v) => (v ? ` ${name}=${lineValue(v)}` : '');
  return `${at} ${SERVICE} decision step=${lineValue(ev.step)} layer=${lineValue(ev.layer, 12)} actor=${field(ev.who)} result=${result} cause=${lineValue(ev.cause)}${id('ev', ev.ev)}${id('approval', ev.approval)}${ev.labtime ? ` labtime=${lineValue(ev.labtime, 30)}` : ''} run=${lineValue(runId)}`;
}

// ---- What the lab receives from the Privilege gateway (Real) ----------------------------------------------------------------------------------
const NO_REPLY = /^MCP HTTP request (?:unreachable|timed out)/;
const UNREAD = /^(?:reply larger than|reply is not JSON)/;
const RECEIVED = 'This is the reply the lab received, not a gateway log line.';
const STEP_TEXT = { 'tools/list': 'tools/list', probe: 'the refusal probe (a tool nothing grants)' };

// One call's answer -> an event, or null when there was no reply (a call that did not connect or timed out). Only the answer in hand is read: nothing
// from an earlier call. The gateway's own words are never copied into a row (they are on the page's gateway card, scrubbed of keys).
// A call the lab completed names its step. A call that failed does not: the shared client does not say which of its requests (the opening handshake or the
// call itself) got the status or the JSON-RPC error, so the row says "while the lab was opening or making" the call and `detail.during` names the call.
export function replyOf(step, r) {
  if (!r || typeof r !== 'object') return null;
  const what = STEP_TEXT[step];
  const done = (outcome, cause, message, detail) => ({ outcome, cause, message: `${message} ${RECEIVED}`, detail: { step, ...detail } });
  if (r.ok === true) {
    if (step === 'tools/list') {
      const n = Array.isArray(r.tools) ? r.tools.length : 0;
      return n > 0
        ? done('allowed', 'tools-listed', `The gateway answered ${what} with ${n} tools for the agent key.`, { tools: n, ms: r.ms })
        : done('info', 'empty-list', `The gateway answered ${what} with no tools, so there is no usable tool list to count as a pass.`, { tools: 0, ms: r.ms });
    }
    if (r.isError === true) return done('refused', 'tool-error', `The gateway answered ${what} with a tool error (isError): the call was not carried out.`, { ms: r.ms });
    return typeof r.text === 'string' && r.text.length > 0
      ? done('allowed', 'tool-ran', `The gateway let ${what} through and returned a tool result. A tool nothing grants should be refused: check the gateway policy.`, { ms: r.ms })
      : done('info', 'no-content', `The gateway answered ${what} with no content, so the lab cannot read it as a tool result.`, { ms: r.ms });
  }
  const f = r.refusal && typeof r.refusal === 'object' ? r.refusal : {};
  const status = Number.isInteger(f.status) ? f.status : null;
  const opening = `while the lab was opening or making ${what}`;
  const failed = (outcome, cause, message, detail) => ({ outcome, cause, message: `${message} ${RECEIVED}`, detail: { during: step, ...detail } });
  if (status === 401) return failed('refused', 'status-401', `The gateway answered HTTP 401 ${opening}: it did not accept the agent key.`, { status, ms: r.ms });
  if (status === 403) return failed('refused', 'status-403', `The gateway answered HTTP 403 ${opening}${step === 'probe' ? '. For a tool nothing grants, that is the answer the probe expects if it came from the call itself' : ''}.`, { status, ms: r.ms });
  if (status !== null) return failed('info', `status-${status}`, `The gateway answered HTTP ${status} ${opening}. That status is not a policy verdict, so it is counted as information.`, { status, ms: r.ms });
  const text = String(f.message ?? '');
  if (NO_REPLY.test(text)) return null;
  if (UNREAD.test(text)) return failed('info', 'unreadable', `The lab could not read the gateway's answer ${opening} as a tool result, so it is counted as information.`, { ms: r.ms });
  return failed('refused', 'jsonrpc-error', `The gateway answered ${opening} with a JSON-RPC error inside a successful HTTP reply: the lab reads that as a refusal.`, { ms: r.ms });
}

// ---- The run log ------------------------------------------------------------------------------------------------------------------------------
// Live: one run per action, lines only (the page's Real record is the gateway hop). Real: one run per gateway check, kept when it ends.
export function createRunLog({ write = (line) => process.stdout.write(`${line}\n`), clock = () => Date.now() } = {}) {
  const part = crypto.randomBytes(3).toString('hex'); // a counter inside one process and random bits across processes: no repeat after a Reset, a restart or in another workspace (the bits make it very unlikely, not impossible)
  let made = 0;
  let runs = [];
  const stamp = () => iso(clock());

  return {
    // The engine events of one Live action: one line each, stamped when written. An action refused before any layer ran is one line with no run.
    live({ events, noRun }) {
      if (!events.length) {
        if (noRun) safely('live-line', () => write(decisionLine({ step: 'request-check', layer: 'gateway', who: null, outcome: 'refused', cause: noRun }, stamp(), null)));
        return;
      }
      const id = `act-${part}-${++made}`;
      // one line at a time: a write that throws drops that line only, never the rest of the action's lines
      for (const ev of events) safely('live-line', () => write(decisionLine({ ...ev, labtime: ev.at }, stamp(), id)));
    },
    // One gateway check. reply() writes the line and keeps the event, both stamped at the moment the reply came in: when the call started (mark()) plus its own
    // duration, never the time after the helper had also closed its session. end() stores the run.
    beginCheck(caller) {
      const run = { id: `gw-${part}-${++made}`, source: 'real', caller, startedAt: stamp(), endedAt: null, events: [], notes: [] };
      return {
        id: run.id,
        mark: () => clock(),
        reply(step, result, startedMs) {
          const at = iso(startedMs + (Number.isFinite(result?.ms) && result.ms >= 0 ? result.ms : 0));
          const r = replyOf(step, result);
          if (!r) {
            // The shared client's "unreachable" and "timed out" words are the only sign of no connection, so a gateway refusal that used those exact words reads the same way.
            run.notes.push(`The ${step === 'probe' ? 'refusal probe' : 'tools/list call'} got no reply (it did not connect, or it timed out), so it has no row. The lab reads a failure carrying exactly the shared client's "unreachable" or "timed out" words as no connection; a gateway refusal that used those exact words could, in rare cases, be read this way. It is never shown as allowed.`);
            write(decisionLine({ step: step === 'probe' ? 'gateway-probe' : 'gateway-list', layer: 'gateway', who: caller, noReply: true, cause: 'no-reply' }, at, run.id));
            return;
          }
          const ev = { ...r, at, layer: 'gateway', product: 'Privilege gateway reply', step: step === 'probe' ? 'gateway-probe' : 'gateway-list', who: caller };
          run.events.push(ev);
          write(decisionLine(ev, at, run.id));
        },
        skipped(note) { run.notes.push(note); },
        end() { run.endedAt = stamp(); runs = [...runs, run].slice(-KEEP_RUNS); },
      };
    },
    // The run with this id (when it is still one of the last few), or the newest.
    get: (id) => (id === undefined ? runs.at(-1) : runs.find((r) => r.id === id)) ?? null,
  };
}

// ---- The records -------------------------------------------------------------------------------------------------------------------------------
const WHY_MOCK = {
  person: 'No call in this scenario reached the end-user layer and no approver acted. The lab has no sign-in: a person is only a name inside a token the lab minted, or an approver name typed on the page.',
  agent: 'No token was verified in this scenario. The lab checks a token it minted itself, and there is no OBO exchange.',
  authorize: 'This lab does not call PingOne Authorize. Its own policy engine decides, and is shown under Privilege.',
  privilege: 'No policy layer decided anything in this scenario. These layers are the lab\'s own policy engine (Ping release claims, UNVERIFIED on our tenant), not PingOne Privilege.',
  gateway: 'The lab\'s simulated gateway stopped or answered nothing in this scenario.',
  resource: 'This lab has no resource or MCP tool server: the call and its reply are simulated inside the lab\'s own engine, so no tool server logged anything and the simulated call has no row.',
};
const WHY_REAL = {
  person: 'The lab calls the gateway with an agent access key, not as a person, and it has no sign-in. Nothing here is a person\'s sign-in.',
  agent: 'The caller is an agent access key (a non-human identity), not an OBO token. The gateway\'s own log of that key is not read by this lab.',
  authorize: 'This lab does not call PingOne Authorize.',
  privilege: 'Privilege\'s policy log (its SIEM index and console activity log) is not read by this lab. The lab\'s own policy engine (the four scope checks, holds, approvals and inspection) stays in the lab in Real too: its decisions are on the Evaluate tab\'s "What Privilege did" (simulated) and on the lab\'s stdout, not in this record.',
  gateway: 'The lab received no reply from the gateway.',
  resource: 'The tool behind the gateway wrote no log the lab can read. This lab has no tool server of its own.',
};

// Ties (the lab clock moves only when the visitor moves it) are put back in the order the events were written; ids are renumbered to match.
function inEventOrder(rec) {
  const stamped = rec.rows.filter((r) => r.at !== null).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.detail.eventSeq - b.detail.eventSeq);
  return { ...rec, rows: [...stamped.map((r, i) => ({ ...r, id: `r${i + 1}` })), ...rec.rows.filter((r) => r.at === null)] };
}

// Mock: the events the engine decided when the table was generated, for one scenario. The first scenario when none is named.
export async function mockRecord(table, vertical, scenarioId, { clock = Date.now } = {}) {
  const v = table.verticals[vertical];
  const sc = (typeof scenarioId === 'string' && v.scenarios.find((s) => s.id === scenarioId)) || v.scenarios[0];
  const events = Array.isArray(sc.events) ? sc.events : [];
  const first = events[0]?.at ?? sc.state.clock.now;
  const last = events.at(-1)?.at ?? sc.state.clock.now;
  const rec = await createRunObservability({ clock }).collectRun({
    runId: `table-${vertical}-${sc.id}`, startedAt: first, endedAt: last, source: 'mock',
    layers: LAYERS.map((layer) => ({
      layer, products: [], reason: WHY_MOCK[layer],
      simulated: events.filter((e) => e.layer === layer).map((e) => ({ at: e.at, product: e.product, outcome: e.outcome, message: e.message, detail: { ...e.detail, eventSeq: e.seq } })),
    })),
  }); // no correlation: nothing is matched against logs here, so no id is declared and names stay readable
  return inEventOrder(rec);
}

// Real: what the lab received from the gateway on one check, as `response` rows. The layers the lab's own engine covers say so.
// No correlation here either: this lab reads no logs, so there is nothing to match, and a declared id would only shorten a name in the lines and rows.
export async function realRecord(run, { clock = Date.now } = {}) {
  const rec = await createRunObservability({ clock }).collectRun({
    runId: run.id, startedAt: run.startedAt, endedAt: run.endedAt, source: 'real',
    layers: LAYERS.map((layer) => ({
      layer, products: [], reason: layer === 'gateway' ? (run.notes.join(' ') || WHY_REAL.gateway) : WHY_REAL[layer],
      responses: layer === 'gateway' ? run.events.map((e, i) => ({ at: e.at, product: e.product, outcome: e.outcome, message: e.message, detail: { ...e.detail, eventSeq: i } })) : [],
    })),
  });
  // A layer that has rows shows no reason of its own, so a call that got no reply or was not sent is named here.
  const note = run.notes.join(' ');
  const out = inEventOrder(rec);
  if (note && run.events.length) out.reasons = { ...out.reasons, gateway: note };
  return out;
}
