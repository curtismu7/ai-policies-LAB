// The evaluation engine: one deterministic pipeline, no I/O, one Engine per workspace and vertical. The only randomness is the RSA signature of a token the
// visitor mints; no decision depends on it. Every step is LAB-INVENTED machinery for Ping release claims (deck slide 52, UNVERIFIED on our tenant).
//
//   request        the arguments are parsed strictly and canonicalised (canon.js); a bad one is a denial
//   token          the presented token is VERIFIED (RS256, issuer, audience, not-before and expiry on the lab clock). Every later layer reads the verified claims only
//   surface        1. SURFACE SCOPE: derived from the ROUTE, refused before any policy is consulted; the identity caps the key
//   application    2. APPLICATION POLICY: which applications the identity reaches, and the claims the token must carry first
//   action         3. ACTION SCOPE: the scope the verified token must carry before the tool may be invoked
//   end-user       4. END-USER SCOPE: the person behind the agent must resolve to the roster and be permitted
//   pair           the two questions: may it proceed ATTENDED, may it proceed UNATTENDED. deny = hard denial; allow then deny = HOLD (the third outcome)
//   request-inspection / call / reply-inspection   rules that read findings: refuse the call, or withhold the result. Neither can hold.
//
// Fail closed: any stage that throws, and any argument of the wrong type, is a DENIAL. A hold returns at once (no held connection) with a reference and an
// owning expiry; an approver signs; the agent retries; the grant is an INPUT to the retry's evaluation, never a bypass of the earlier layers.
import { InputError, refuse } from './errors.js';
import { buildCatalog, hasApp, hasTool, parseRoute, SURFACES, CHANNELS } from './catalog.js';
import { buildRoster } from './cast.js';
import { callHash, canonicalJson, METHODS, normalizeArguments } from './canon.js';
import { cleanFree, cleanUnderKey, findCredentials, isCredentialKey, looksLikeCredential, normalizeForMatching } from './credentials.js';
import { findingKinds, findingsIn, normalizeText } from './inspect.js';
import { defaultPolicy, validateLayer, LAYERS, OPS } from './policies.js';
import { mint, verifyToken, MAX_TTL_MIN } from './token.js';
import { formatTraceparent } from './trace.js';

export const LIMITS = { approvals: 200, audit: 500, outbox: 300, hops: 40, comment: 200, reply: 2000, claims: 20, claimItems: 10, claimString: 120 };
export const LAB_EPOCH_MS = Date.parse('2026-11-02T09:00:00.000Z');
export const ADVANCE_MAX_MIN = 10080;
export const STAGES = ['request', 'token', 'surface', 'application', 'action', 'end-user', 'attended-unattended', 'request-inspection', 'call', 'reply-inspection'];
export const STAGE_TITLE = {
  request: 'The call is read', token: 'Token verification', surface: '1. Surface scope', application: '2. Application policy', action: '3. Action scope', 'end-user': '4. End-user scope',
  'attended-unattended': 'Attended and unattended', 'request-inspection': 'Request inspection', call: 'The call is made (simulated upstream)', 'reply-inspection': 'Reply inspection',
};
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const iso = (ms) => new Date(ms).toISOString();
const scalar = (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
const HINT = /scope|user|role|claim|admin|approv/i;

export class Engine {
  constructor(cast) {
    this.cast = cast;
    this.catalog = buildCatalog(cast);
    this.roster = buildRoster(cast);
    this.policy = defaultPolicy(cast);
    this.clockMs = LAB_EPOCH_MS;
    this.approvals = []; this.outbox = []; this.audit = [];
    this.n = { ev: 0, apr: 0, out: 0 };
    this.trace = null; this.hops = []; this.hopsTruncated = false;
  }

  now() { return this.clockMs; }
  nowSec() { return Math.floor(this.clockMs / 1000); }
  ctx() { return { catalog: this.catalog, roster: this.roster }; }
  human(id) { return typeof id === 'string' ? this.roster.find((r) => r.kind === 'human' && r.id === id) || null : null; }
  agent(id) { return typeof id === 'string' ? this.roster.find((r) => r.kind === 'agent' && r.id === id) || null : null; }

  hop(label, request, response) {
    if (!this.trace) return;
    if (this.hops.length >= LIMITS.hops) { this.hopsTruncated = true; return; }
    this.hops.push({ n: this.hops.length + 1, label, request: { ...request, headers: { traceparent: formatTraceparent(this.trace.traceId, this.trace.span()), ...(request.headers || {}) } }, response });
  }

  // ---- the lab clock: forward only ----
  advance(p) {
    const m = p?.minutes;
    if (!Number.isInteger(m) || m < 1 || m > ADVANCE_MAX_MIN) throw refuse('bad_minutes', `the clock moves forward by a whole number of minutes from 1 to ${ADVANCE_MAX_MIN}; it never moves back`);
    this.clockMs += m * 60000;
    this.sweep();
    return { now: iso(this.clockMs), moved: m };
  }
  // Pending requests past their owning expiry expire; a grant past its window expires. The boundary is inclusive: at the instant of expiry it is already expired.
  sweep() {
    for (const a of this.approvals) {
      if (a.status === 'pending' && this.clockMs >= a.expiresAtMs) a.status = 'expired';
      else if (a.status === 'approved' && this.clockMs >= a.grantUntilMs) a.status = 'expired';
    }
  }

  // ---- tokens ----
  mintToken(p) {
    if (!isObj(p) || !isObj(p.claims)) throw refuse('bad_claims', 'tokens are minted from a claims object');
    const ttlMin = p.ttlMin === undefined ? 60 : p.ttlMin;
    if (!Number.isInteger(ttlMin) || ttlMin < 1 || ttlMin > MAX_TTL_MIN) throw refuse('bad_ttl', `ttlMin is a whole number of minutes from 1 to ${MAX_TTL_MIN}`);
    const keys = Object.keys(p.claims);
    if (keys.length > LIMITS.claims) throw refuse('too_many_claims', `a token carries at most ${LIMITS.claims} claims`);
    const claims = {};
    for (const k of keys) {
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(k) || looksLikeCredential(k) || isCredentialKey(k)) throw refuse('bad_claim_name', 'a claim name is lowercase letters, digits and underscores, starting with a letter, and is not a credential word (the lab never puts a credential in a token)');
      if (['iss', 'aud', 'iat', 'nbf', 'exp'].includes(k)) throw refuse('reserved_claim', 'iss, aud, iat, nbf and exp are set by the lab\'s issuer');
      const v = p.claims[k];
      const clean = (x) => {
        if (typeof x !== 'string') return x;
        if (x.length > LIMITS.claimString) throw refuse('claim_too_long', `a claim string is at most ${LIMITS.claimString} characters`);
        if (looksLikeCredential(x)) throw refuse('credential_shaped', 'a claim value looks like a credential; the lab never puts one in a token');
        return cleanFree(x, LIMITS.claimString);
      };
      if (Array.isArray(v)) { if (v.length > LIMITS.claimItems || !v.every((x) => scalar(x) && (typeof x !== 'number' || Number.isFinite(x)))) throw refuse('bad_claim_value', `a claim is a string, number, boolean or a list of at most ${LIMITS.claimItems} of them`); claims[k] = v.map(clean); }
      else if (scalar(v) && (typeof v !== 'number' || Number.isFinite(v))) claims[k] = clean(v);
      else throw refuse('bad_claim_value', `a claim is a string, number, boolean or a list of at most ${LIMITS.claimItems} of them`);
    }
    const t = mint(claims, { nowSec: this.nowSec(), ttlMin });
    this.hop('lab issuer (in process): sign with the throwaway RSA key', { method: 'POST', url: 'https://issuer.lab.example/token (simulated, never sent)', body: { claims: Object.keys(claims) } }, { status: 200, body: { alg: 'RS256', kid: t.header.kid, expiresAt: iso((this.nowSec() + ttlMin * 60) * 1000) } });
    return { labToken: t.token, header: t.header, claims: t.payload, expiresAt: iso((this.nowSec() + ttlMin * 60) * 1000), label: 'mock-issued by the lab\'s own throwaway RSA key (RS256): not a credential for anything' };
  }

  // ---- policy ----
  savePolicy(layer, rules) {
    const errors = validateLayer(layer, rules, this.ctx());
    if (errors.length) { const e = new InputError('policy_refused', `the layer was not saved: ${errors.length} problem${errors.length === 1 ? '' : 's'} (nothing was changed)`, 422); e.errors = errors.slice(0, 20); throw e; }
    this.policy[layer] = structuredClone(rules);
    return { layer, rules: rules.length };
  }
  resetPolicy(layer) {
    if (!LAYERS.includes(layer)) throw refuse('unknown_layer', 'that is not one of the policy layers');
    this.policy[layer] = defaultPolicy(this.cast)[layer];
    return { layer, rules: this.policy[layer].length };
  }

  // ---- approvals ----
  // Every requirement a hold needs is FROZEN into the approval when it is created (the decisions below are judged against the frozen values), and checked
  // AGAIN when a retry would consume the grant: a policy tightened in between needs a new approval.
  eligibleApprovers(required, exclude) {
    return this.roster.filter((r) => r.kind === 'human' && !exclude.includes(r.id) && r.roles.some((x) => required.roles.includes(x)) && r.maxAuthLevel >= required.minAuthLevel).map((r) => r.id);
  }
  approvalView(a) {
    return {
      ref: a.ref, status: a.status, createdAt: a.createdAt, expiresAt: a.expiresAt, requester: a.requester, identity: a.identity, endUser: a.endUser, app: a.app, tool: a.tool, ruleId: a.ruleId,
      bound: a.bound, grantUntil: a.grantUntil, required: a.required, summary: a.summary, approvals: a.approvals, decidedBy: a.decidedBy, decidedAt: a.decidedAt, uses: a.uses, consumedAt: a.consumedAt,
      eligible: a.status === 'pending' ? this.eligibleApprovers(a.required, [a.requester, a.endUser].filter(Boolean)) : [],
    };
  }

  decide(p) {
    this.sweep();
    if (!isObj(p)) throw refuse('bad_request', 'a decision is an object');
    const a = typeof p.ref === 'string' ? this.approvals.find((x) => x.ref === p.ref) : null;
    if (!a) throw refuse('approval_unknown', 'there is no approval request with that reference', 404);
    if (a.status !== 'pending') throw refuse('not_pending', a.status === 'expired' ? 'the request has expired (or its grant window has closed); nothing can be decided on it' : `the request is already ${a.status}; a decision is final`, 409);
    if (p.decision !== 'approve' && p.decision !== 'deny') throw refuse('bad_decision', 'a decision is approve or deny');
    const who = this.human(p.approver);
    if (!who) throw refuse('approver_unknown', 'the approver is not a person in the roster (an agent can never approve)', 403);
    if (who.id === a.requester || who.id === a.endUser) throw refuse('self_approval', 'the person the call acts for cannot approve it', 403);
    if (!who.roles.some((r) => a.required.roles.includes(r))) throw refuse('role_missing', 'the approver does not hold a role the request names', 403);
    const comment = cleanFree(p.comment ?? '', LIMITS.comment);
    if (p.decision === 'deny') {
      a.status = 'denied'; a.decidedBy = who.id; a.decidedAt = iso(this.clockMs);
      this.log('approval', { ref: a.ref, approver: who.id, outcome: 'denied' });
      this.hop('approver decision (simulated console)', { method: 'POST', url: `lab://approvals/${a.ref}/decision`, body: { approver: who.id, decision: 'deny', comment } }, { status: 200, body: { status: 'denied' } });
      return { ref: a.ref, status: a.status };
    }
    const level = p.authLevel;
    if (!Number.isInteger(level) || level < 1 || level > 3) throw refuse('bad_auth_level', 'authLevel is 1 (password), 2 (push approval) or 3 (hardware key)');
    if (level > who.maxAuthLevel) throw refuse('auth_level_not_available', 'the approver cannot present an authentication stronger than their roster entry allows', 403);
    if (level < a.required.minAuthLevel) throw refuse('auth_too_weak', 'the approver signed in with a weaker authentication than the request demands', 403);
    if (a.approvals.some((x) => x.approver === who.id)) throw refuse('duplicate_approver', 'that approver has already signed this request; a second signature from the same person counts once', 409);
    a.approvals.push({ approver: who.id, authLevel: level, at: iso(this.clockMs), comment });
    if (a.approvals.length >= a.required.approvers) {
      a.status = 'approved'; a.decidedAt = iso(this.clockMs); a.decidedBy = a.approvals.map((x) => x.approver);
      a.grantUntilMs = this.clockMs + a.required.windowMin * 60000; a.grantUntil = iso(a.grantUntilMs);
      a.bound = a.bound.kind === 'period' ? { ...a.bound, from: a.decidedAt, until: a.grantUntil } : { ...a.bound, until: a.grantUntil };
    }
    this.log('approval', { ref: a.ref, approver: who.id, outcome: a.status === 'approved' ? 'approved' : 'signed' });
    this.hop('approver decision (simulated console)', { method: 'POST', url: `lab://approvals/${a.ref}/decision`, body: { approver: who.id, decision: 'approve', authLevel: level, comment } }, { status: 200, body: { status: a.status, signatures: a.approvals.length, required: a.required.approvers } });
    return { ref: a.ref, status: a.status, signatures: a.approvals.length, required: a.required.approvers };
  }

  // Whether an approval may be used for THIS call under THIS rule. A fixed list of reasons, checked in a fixed order.
  grantProblem(a, ctx, rule) {
    if (a.requester !== ctx.requester) return ['approval_other_requester', 'the approval was given for a different person'];
    if (a.app !== ctx.app || a.tool !== ctx.tool) return ['approval_other_call', 'the approval was given for a different tool'];
    if (a.status === 'pending') return ['approval_pending', 'the approval has not been signed yet'];
    if (a.status === 'denied') return ['approval_denied', 'the approval was denied'];
    if (a.status === 'consumed') return ['approval_consumed', 'the approval was single-use and has already been used: a replay is refused'];
    if (a.status === 'expired' || a.status !== 'approved' || this.clockMs >= a.grantUntilMs) return ['approval_expired', 'the approval has expired'];
    if (a.bound.kind === 'call' && a.bound.callHash !== ctx.hash) return ['approval_other_call', 'the approval is bound to a different call (the canonical hash of method, target and arguments differs)'];
    const f = a.required; const r = rule.approval;
    if (f.binding !== r.binding || f.approvers < r.approvers || f.minAuthLevel < r.minAuthLevel || !r.roles.every((x) => f.roles.includes(x))) return ['approval_policy_changed', 'the policy asks for more than this approval was given for: a new approval is needed'];
    return null;
  }

  newApproval(ctx, rule, summary) {
    const r = rule.approval; const id = `apr-${String(++this.n.apr).padStart(4, '0')}`;
    const expiresAtMs = this.clockMs + r.ttlMin * 60000;
    const a = {
      ref: id, status: 'pending', createdAt: iso(this.clockMs), expiresAt: iso(expiresAtMs), expiresAtMs, requester: ctx.requester, identity: ctx.identity, endUser: ctx.endUser, app: ctx.app, tool: ctx.tool, ruleId: rule.id,
      bound: r.binding === 'call' ? { kind: 'call', callHash: ctx.hash } : { kind: 'period', windowMin: r.windowMin },
      required: { binding: r.binding, windowMin: r.windowMin, approvers: r.approvers, roles: [...r.roles], minAuthLevel: r.minAuthLevel, channel: r.channel, ttlMin: r.ttlMin },
      summary, approvals: [], decidedBy: null, decidedAt: null, grantUntil: null, grantUntilMs: 0, uses: [], consumedAt: null,
    };
    this.approvals.push(a);
    const to = this.eligibleApprovers(a.required, [ctx.requester, ctx.endUser].filter(Boolean));
    const entry = { id: `out-${String(++this.n.out).padStart(4, '0')}`, at: iso(this.clockMs), channel: r.channel, label: CHANNELS[r.channel], to, ref: id, subject: `Approval needed: ${ctx.tool} on ${ctx.app}`, expiresAt: a.expiresAt, delivered: false };
    this.outbox.push(entry);
    this.hop(`${CHANNELS[r.channel]} (simulated: written to the outbox, never sent)`, { method: 'POST', url: `https://${r.channel}.${this.cast.castHost}.example/outbox`, body: { to, ref: id, bound: a.bound.kind, expiresAt: a.expiresAt } }, { status: 200, body: { id: entry.id, delivered: false } });
    return a;
  }

  log(kind, o) {
    this.audit.push({ n: this.audit.length + 1, at: iso(this.clockMs), kind, ...o });
  }

  // ---- the pipeline ----
  evaluate(input) {
    if (this.audit.length >= LIMITS.audit || this.approvals.length >= LIMITS.approvals || this.outbox.length >= LIMITS.outbox) throw refuse('workspace_full', 'this workspace is full (the audit trail, the approvals or the outbox reached its limit): Reset to start again', 409);
    this.sweep();
    const inp = isObj(input) ? input : {};
    const ev = `ev-${String(++this.n.ev).padStart(4, '0')}`;
    const trace = []; const c = { ev, inp, stage: null, requester: null, identity: null, endUser: null, grant: null };
    const known = (cond, v) => (cond ? v : null); // a name is shown only when it is one the lab knows
    const d = { id: ev, at: iso(this.clockMs), outcome: 'allow', http: 200, proceeded: false, resultReleased: false, code: 'allowed', reason: 'every layer passed', stage: null, failedClosed: false, noApprovalPath: false, trace, findings: [], ignoredHints: [], approval: null, grantUsed: null, reply: null };

    const run = (stage, fn) => {
      let r;
      c.stage = stage;
      try {
        if (inp.labFault === stage) throw new Error('lab fault injection');
        r = fn() || { verdict: 'pass', reason: '' };
      } catch (e) {
        if (e instanceof InputError) throw e;
        r = { verdict: 'deny', code: 'evaluation_error', reason: 'the evaluation failed inside this layer, and a failure is a denial', failedClosed: true };
      }
      trace.push({ stage, title: STAGE_TITLE[stage], ...r, ...(r.detail ? { detail: r.detail } : {}) });
      return r;
    };
    const pass = (reason, detail) => ({ verdict: 'pass', code: 'ok', reason, ...(detail ? { detail } : {}) });
    const deny = (code, reason, detail, extra = {}) => ({ verdict: 'deny', code, reason, ...(detail ? { detail } : {}), ...extra });

    let args = null; let claims = null; let route = null; let tool = null; let tokenInfo = null;
    const stages = {
      request: () => {
        if (typeof inp.tool !== 'string') return deny('tool_missing', 'no tool name was given');
        const given = inp.argumentsText !== undefined ? { text: inp.argumentsText } : { object: inp.arguments === undefined ? Object.create(null) : inp.arguments };
        const n = normalizeArguments(given);
        if (!n.ok) return deny(n.code, n.reason);
        args = n.value;
        for (const k of Object.keys(args)) if (HINT.test(k)) { const m = HINT.exec(k)[0].toLowerCase(); if (!d.ignoredHints.some((x) => x.where === 'argument' && x.matched === m)) d.ignoredHints.push({ where: 'argument', matched: m }); }
        if (isObj(inp.headers)) for (const k of Object.keys(inp.headers)) if (HINT.test(k)) { const m = HINT.exec(k)[0].toLowerCase(); if (!d.ignoredHints.some((x) => x.where === 'header' && x.matched === m)) d.ignoredHints.push({ where: 'header', matched: m }); }
        return pass('the arguments are one JSON object and were canonicalised', { argumentCount: Object.keys(args).length });
      },
      token: () => {
        const v = verifyToken(inp.token, { nowSec: this.nowSec() });
        this.hop('token check (JWKS, RS256: simulated issuer, verified in process)', { method: 'GET', url: 'https://issuer.lab.example/.well-known/jwks.json (simulated, never fetched)' }, { status: 200, body: { kid: 'lab-key-1', alg: 'RS256', result: v.ok ? 'verified' : v.code } });
        if (!v.ok) { d.http = 401; return deny(v.code, v.reason, v.header ? { header: v.header } : undefined); }
        claims = v.claims; tokenInfo = { header: v.header, claims: v.claims };
        return pass('RS256 signature, issuer, audience, not-before and expiry are valid on the lab clock', { header: v.header });
      },
      surface: () => {
        route = parseRoute(inp.route);
        if (!route) return deny('route_unknown', 'the route does not begin with /llm/, /mcp/ or /a2a/ followed by an application name, so no surface can be derived');
        d.surface = route.surface;
        const id = claims.sub; const ident = this.agent(id);
        if (!ident) return deny('identity_unknown', 'the token names no identity in the roster, so no ceiling exists and the key can touch nothing');
        c.identity = ident.id; d.identity = ident.id;
        const ks = claims.surfaces;
        if (!Array.isArray(ks) || !ks.every((s) => typeof s === 'string' && SURFACES.includes(s))) return deny('claim_type', 'the surfaces claim must be a list made of model, tool and agent: a claim of the wrong type is a denial');
        const ceiling = [...new Set(this.policy.identities.filter((r) => r.identity === ident.id).flatMap((r) => r.surfaces))];
        const effective = ks.filter((s) => ceiling.includes(s));
        const detail = { routeSurface: route.surface, keySurfaces: ks, identityCeiling: ceiling, effective };
        if (!effective.includes(route.surface)) return deny('surface_not_allowed', ks.includes(route.surface) ? 'the key claims this surface, but its owning identity does not hold it: a key can never exceed its identity' : 'the key does not carry this surface', detail, { noApplicationPolicyConsulted: true });
        return pass('the surface comes from the route and is inside both the key and its identity', detail);
      },
      application: () => {
        if (!hasApp(this.catalog, route.app) || this.catalog.apps[route.app].surface !== route.surface) return deny('app_unknown', 'the route names no application on that surface');
        c.app = route.app; d.app = route.app;
        const matches = this.policy.apps.filter((r) => (r.identity === c.identity || r.identity === '*') && r.app === route.app);
        if (!matches.length) return deny('no_application_policy', 'no application policy lets this identity reach this application');
        let wrongType = false;
        const missingOf = (m) => {
          const missing = [];
          for (const rc of m.requiredClaims) {
            if (!Object.hasOwn(claims, rc.claim)) { missing.push(rc.claim); continue; }
            const v = claims[rc.claim]; const vs = Array.isArray(v) ? v : [v];
            if (!vs.length || !vs.every(scalar)) { wrongType = true; missing.push(rc.claim); continue; }
            if (rc.oneOf.length && !vs.some((x) => rc.oneOf.includes(String(x)))) missing.push(rc.claim);
          }
          return missing;
        };
        let firstMissing = null;
        for (const m of matches) { const miss = missingOf(m); if (!miss.length) return pass(`policy ${m.id} lets this identity reach the application and the token carries the claims it requires`, { policy: m.id, requiredClaims: m.requiredClaims.map((x) => x.claim) }); firstMissing ||= miss; }
        if (wrongType) return deny('claim_type', 'a claim the application requires has the wrong type (it must be a string, number, boolean or a list of them): a claim of the wrong type is a denial', { missing: firstMissing });
        return deny('required_claims_missing', 'the token does not carry the claims this application requires before it is reachable', { missing: firstMissing });
      },
      action: () => {
        if (!hasTool(this.catalog, c.app, inp.tool)) return deny('tool_unknown', 'the application has no such tool');
        tool = inp.tool; c.tool = tool; d.tool = tool;
        const spec = this.catalog.apps[c.app].tools[tool].args;
        for (const [name, type] of Object.entries(spec)) {
          if (!Object.hasOwn(args, name)) return deny('argument_missing', `a required argument is missing (${name})`);
          const v = args[name];
          if (typeof v !== type || (type === 'number' && !Number.isFinite(v))) return deny('argument_type', `the argument ${name} must be a ${type}: an argument of the wrong type is a denial`, { argument: name, expected: type });
        }
        const rules = this.policy.actions.filter((r) => r.app === c.app && r.tool === tool);
        if (!rules.length) return pass('no action rule names this tool, so it is not scope-gated', { rules: [] });
        if (typeof claims.scope !== 'string') return deny('claim_type', 'the scope claim must be one string of space-separated scopes: a claim of the wrong type is a denial');
        const held = claims.scope.split(/\s+/).filter(Boolean);
        const need = rules.map((r) => r.requiresScope); const lacking = need.filter((s) => !held.includes(s));
        const detail = { required: need, tokenScopes: held.filter((s) => this.catalog.scopes.includes(s)) };
        if (lacking.length) return deny('scope_missing', 'the verified token does not carry the scope this tool requires (scopes are read from the token, never from anything the caller supplies)', { ...detail, lacking });
        return pass('the verified token carries every scope the rules require', detail);
      },
      'end-user': () => {
        if (claims.end_user !== undefined && typeof claims.end_user !== 'string') return deny('claim_type', 'the end_user claim must be a string: a claim of the wrong type is a denial');
        const eu = this.human(claims.end_user);
        c.endUser = eu ? eu.id : null;
        c.requester = c.endUser || c.identity;
        d.requester = c.requester;
        const rules = this.policy.users.filter((r) => r.app === c.app && r.tool === tool);
        if (!rules.length) return pass('no end-user rule names this tool, so the service identity alone decides', { resolved: c.endUser });
        if (!eu) return deny('end_user_unresolved', 'the token names no person who resolves to the roster, and a rule on this tool needs one: the only layer that reaches past the service identity cannot proceed without a real user');
        if (!rules.every((r) => r.users.includes(eu.id))) return deny('end_user_not_permitted', 'the person behind the agent is not one of the people the rule permits', { user: eu.id });
        return pass('the person resolves to the roster and the rule permits them', { user: eu.id });
      },
      'attended-unattended': () => {
        const h = callHash({ method: METHODS[route.surface], target: `${route.surface}:${c.app}/${tool}`, arguments: args });
        c.hash = h.hash; c.canonical = h.canonical; d.callHash = c.hash; d.method = METHODS[route.surface]; d.target = `${route.surface}:${c.app}/${tool}`;
        const rules = this.policy.holds.filter((r) => r.app === c.app && r.tool === tool);
        const matching = [];
        for (const r of rules) {
          if (r.when) {
            const w = r.when;
            if (!Object.hasOwn(args, w.arg)) return deny('argument_missing', 'a rule reads an argument the call does not carry', { rule: r.id });
            const v = args[w.arg]; const type = w.op === 'in' ? 'string' : typeof w.value;
            if (typeof v !== type || (type === 'number' && !Number.isFinite(v))) return deny('argument_type', 'a rule compares an argument of the wrong type: the evaluation denies', { rule: r.id, argument: w.arg, expected: type });
            if (!Object.hasOwn(OPS, type) || !OPS[type].includes(w.op)) throw new Error('operator does not fit the type');
            const hit = { gt: v > w.value, gte: v >= w.value, lt: v < w.value, lte: v <= w.value, eq: v === w.value, ne: v !== w.value, in: Array.isArray(w.value) && w.value.includes(v) }[w.op];
            if (!hit) continue;
          }
          matching.push(r);
        }
        const attended = matching.some((r) => r.attended === 'deny') ? 'deny' : 'allow';
        const unattended = matching.some((r) => r.unattended === 'deny') || attended === 'deny' ? 'deny' : 'allow';
        const base = { attended, unattended, matchedRules: matching.map((r) => r.id) };
        if (attended === 'deny') { d.noApprovalPath = true; return deny('attended_refused', 'a rule refuses the attended form: this is a hard denial, and no approval can lift it', { ...base, reading: 'hard denial' }); }
        if (unattended === 'allow') return pass('the call may proceed attended and unattended: nothing to hold', { ...base, reading: 'allow' });
        const rule = matching.find((r) => r.unattended === 'deny');
        if (!isObj(rule.approval)) return deny('hold_without_approval', 'a rule asks for a hold but names no approval: a hold that nobody can lift is a denial');
        const detail = { ...base, reading: 'hold for a human', rule: rule.id };
        const need = rule.approval;
        // a grant is an INPUT to this evaluation: it can lift a hold, never a layer above or a hard denial
        const ref = inp.approvalRef;
        if (ref !== undefined && (typeof ref !== 'string' || !/^apr-\d{4,}$/.test(ref))) return deny('approval_unknown', 'the approval reference is not one this workspace issued', detail);
        const ctx2 = { requester: c.requester, app: c.app, tool, hash: c.hash };
        if (ref !== undefined) {
          const a = this.approvals.find((x) => x.ref === ref);
          if (!a) return deny('approval_unknown', 'the approval reference is not one this workspace issued', detail);
          const problem = this.grantProblem(a, ctx2, rule);
          if (problem) return deny(problem[0], `${problem[1]} (nothing new was opened: call again without the reference to start a new request)`, { ...detail, approval: a.ref });
          c.grant = a;
        } else {
          c.grant = this.approvals.find((a) => a.status === 'approved' && !this.grantProblem(a, ctx2, rule)) || null;
        }
        if (c.grant) return pass(`approval ${c.grant.ref} applies as an input to this evaluation (${c.grant.bound.kind === 'call' ? 'single-use, bound to this exact call' : 'a fixed period'}); it lifted the hold and nothing above it`, { ...detail, grant: c.grant.ref });
        // nothing usable. LAB READING (not the deck's order): a hold that request inspection would refuse on every retry is never opened. It is the same idea as the
        // unfillable-hold refusal below: a flow that can never complete is refused now, instead of opening an approval nobody can usefully sign. The findings are shown
        // by kind only, and nothing the visitor typed is stored or echoed.
        const ahead = findingsIn(args);
        const aheadKinds = [...new Set(ahead.map((f) => f.kind))];
        const refusing = this.policy.inspection.find((r) => r.stage === 'request' && aheadKinds.includes(r.finding));
        if (refusing) { d.findings.push(...aheadKinds.map((k) => ({ stage: 'request', kind: k }))); return deny('inspection_would_refuse', `held calls are not opened when request inspection would refuse the retry (finding ${refusing.finding}, rule ${refusing.id}): nothing was opened for a person. This is a lab reading, not the deck's order`, { ...detail, findings: aheadKinds, rule: refusing.id }); }
        // open (or re-use) a request, and refuse NOW; nothing is held open
        const eligible = this.eligibleApprovers({ roles: need.roles, minAuthLevel: need.minAuthLevel }, [c.requester, c.endUser].filter(Boolean));
        if (eligible.length < need.approvers) return deny('hold_unfillable', 'this hold could never complete: too few people could sign it (the person the call acts for may not approve their own call)', { ...detail, eligible: eligible.length, required: need.approvers });
        let a = this.approvals.find((x) => x.status === 'pending' && x.requester === c.requester && x.app === c.app && x.tool === tool && x.ruleId === rule.id && (x.bound.kind === 'period' || x.bound.callHash === c.hash));
        const reused = !!a;
        a ||= this.newApproval({ requester: c.requester, identity: c.identity, endUser: c.endUser, app: c.app, tool, hash: c.hash }, rule, `${tool} on ${c.app}: arguments ${Object.keys(args).slice(0, 12).map((k) => cleanFree(k, 40)).join(', ') || '(none)'}; call hash ${c.hash.slice(0, 16)}`);
        d.approval = { ref: a.ref, status: a.status, expiresAt: a.expiresAt, bound: a.bound, approvers: a.required.approvers, roles: a.required.roles, minAuthLevel: a.required.minAuthLevel, channel: a.required.channel, reused, signatures: a.approvals.length };
        return { verdict: 'hold', code: 'hold_for_approval', reason: `held for a person: refused now with a reference and an owning expiry, nothing is held open. An approver signs, then call again.`, detail: { ...detail, approval: a.ref } };
      },
      'request-inspection': () => {
        const found = findingsIn(args);
        const kinds = [...new Set(found.map((f) => f.kind))];
        d.findings.push(...kinds.map((k) => ({ stage: 'request', kind: k })));
        const rule = this.policy.inspection.find((r) => r.stage === 'request' && kinds.includes(r.finding));
        if (rule) return { verdict: 'refuse', code: 'inspection_refused', reason: `a finding on the request (${rule.finding}) matches rule ${rule.id}: the call is refused before it is made. A rule that reads findings can refuse the call; it cannot hold it for a person`, detail: { findings: kinds, rule: rule.id } };
        return pass(kinds.length ? 'findings exist but no rule acts on them' : 'nothing found on the request', { findings: kinds });
      },
    };

    // reply-inspection and call are run together after the grant is consumed
    const order = ['request', 'token', 'surface', 'application', 'action', 'end-user', 'attended-unattended', 'request-inspection'];
    let stop = null;
    for (const s of order) {
      const r = run(s, stages[s]);
      if (r.verdict !== 'pass') { stop = { stage: s, ...r }; break; }
    }
    if (stop) {
      d.stage = stop.stage; d.code = stop.code; d.reason = stop.reason; d.failedClosed = !!stop.failedClosed;
      if (stop.verdict === 'hold') { d.outcome = 'hold'; d.http = 403; } else { d.outcome = 'deny'; if (d.http !== 401) d.http = 403; }
      for (const s of STAGES.slice(STAGES.indexOf(stop.stage) + 1)) trace.push({ stage: s, title: STAGE_TITLE[s], verdict: 'not-reached', code: 'not_reached', reason: stop.verdict === 'hold' ? 'the call was not made: it is held until an approver signs and the agent retries' : stop.stage === 'request-inspection' ? 'the call was refused before it was made' : 'an earlier layer already refused: nothing past it is consulted' });
    } else {
      // the call proceeds: consume the grant now, then reply inspection
      let reply = typeof inp.simulatedReply === 'string' ? inp.simulatedReply.slice(0, LIMITS.reply) : `ok: ${tool} completed (simulated upstream)`;
      const callRes = run('call', () => {
        if (c.grant) {
          const g = c.grant;
          g.uses.push({ ev, at: iso(this.clockMs) });
          if (g.bound.kind === 'call') { g.status = 'consumed'; g.consumedAt = iso(this.clockMs); }
          d.grantUsed = { ref: g.ref, binding: g.bound.kind, consumed: g.bound.kind === 'call', uses: g.uses.length };
        }
        d.proceeded = true;
        this.hop('upstream tool (simulated, never sent)', { method: 'POST', url: `https://${c.app}.${this.cast.castHost}.example/${tool}`, body: { arguments: Object.keys(args).length } }, { status: 200, body: { ok: true } });
        return pass(c.grant ? `the call was made under approval ${c.grant.ref}` : 'the call was made', { grant: c.grant ? c.grant.ref : null });
      });
      let rep = callRes.verdict === 'pass' ? run('reply-inspection', () => {
        const kinds = findingKinds(reply);
        d.findings.push(...kinds.map((k) => ({ stage: 'reply', kind: k })));
        const rule = this.policy.inspection.find((r) => r.stage === 'reply' && kinds.includes(r.finding));
        if (rule) return { verdict: 'withhold', code: 'reply_withheld', reason: `a finding on the reply (${rule.finding}) matches rule ${rule.id}: the call was made, and the result is withheld. A rule that reads findings can withhold the result; it cannot hold it for a person`, detail: { findings: kinds, rule: rule.id } };
        return pass(kinds.length ? 'findings exist but no rule acts on them' : 'nothing found on the reply', { findings: kinds });
      }) : callRes;
      if (callRes.verdict !== 'pass') { d.stage = 'call'; d.outcome = 'deny'; d.http = 403; d.code = callRes.code; d.reason = callRes.reason; d.failedClosed = !!callRes.failedClosed; }
      else if (rep.verdict === 'withhold') { d.stage = 'reply-inspection'; d.outcome = 'withhold'; d.http = 403; d.code = rep.code; d.reason = rep.reason; }
      else if (rep.verdict !== 'pass') { d.stage = 'reply-inspection'; d.outcome = 'withhold'; d.http = 403; d.code = rep.code; d.reason = 'the reply could not be inspected, so the result is withheld'; d.failedClosed = !!rep.failedClosed; }
      else { d.stage = 'reply-inspection'; d.resultReleased = true; d.reply = cleanFree(reply, 400); }
    }

    d.requester = c.requester || null;
    d.identity = c.identity || (isObj(claims) ? known(!!this.agent(claims.sub), claims.sub) : null);
    d.tokenSummary = tokenInfo ? { header: tokenInfo.header, claims: summariseClaims(tokenInfo.claims) } : null;
    if (c.canonical || args) d.canonical = shown(c.canonical || canonicalJson(args), 600);
    this.hop('policy decision point (in process)', { method: 'POST', url: 'policy://evaluate', body: { surface: d.surface || null, app: d.app || null, tool: d.tool || null, requester: d.requester, callHash: d.callHash || null } }, { status: d.http, body: { outcome: d.outcome, stage: d.stage, code: d.code } });
    this.log('evaluation', { ev, identity: d.identity, surface: d.surface || null, app: d.app || null, tool: d.tool || null, outcome: d.outcome, stage: d.stage, code: d.code, approval: d.approval?.ref || d.grantUsed?.ref || null });
    return d;
  }

  // ---- views ----
  snapshot() {
    this.sweep();
    const c = this.catalog;
    return {
      clock: { now: iso(this.clockMs), start: iso(LAB_EPOCH_MS), minutesSinceStart: Math.round((this.clockMs - LAB_EPOCH_MS) / 60000) },
      roster: this.roster, catalog: { apps: Object.values(c.apps).map((a) => ({ id: a.id, surface: a.surface, tools: Object.entries(a.tools).map(([name, t]) => ({ name, args: t.args, scope: t.scope })) })), scopes: c.scopes, roles: c.roles },
      policy: this.policy, approvals: this.approvals.map((a) => this.approvalView(a)), outbox: this.outbox, audit: this.audit,
      counts: { approvals: this.approvals.length, audit: this.audit.length, outbox: this.outbox.length }, limits: LIMITS,
    };
  }
}

// The text the page shows for the canonical form: as it is hashed, unless it hides a credential-shaped value (zero-width characters interleaved, say): then
// the masked copy is shown instead. Masked BEFORE it is cut.
export function shown(text, max) {
  return findCredentials(normalizeForMatching(text)).length ? cleanFree(text, max) : text.slice(0, max);
}

// The claims as shown on the page: only well-known claim values are shown as they are, the rest as types; credential-shaped strings never reach here (mint refuses them).
function summariseClaims(cl) {
  const out = {};
  for (const k of Object.keys(cl).slice(0, 30)) { const v = cl[k]; out[k.slice(0, 40)] = cleanUnderKey(k, v, 120); }
  return out;
}
export { normalizeText };
