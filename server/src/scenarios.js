// Scripted scenarios. Each is a list of steps run through the SAME dispatch the API uses (actions.js) on a fresh Engine, so the Mock tables cannot say anything
// the engine does not do: `npm run mock-table` writes them, and a doctor check and a test fail if they drift. Each step carries the result the story says it
// gives (`expect`); the doctor and a test check it in every vertical. A step that mints a token lists its CLAIMS: the signature is random (a fresh RSA key per
// process), so no token string is ever kept in a table.
import { Engine } from './engine.js';
import { perform } from './actions.js';
import { VERTICALS } from './cast.js';
import { callHash, canonicalJson, METHODS, normalizeArguments } from './canon.js';

const base = (c, o = {}) => ({ sub: c.castAgent, surfaces: ['tool', 'model', 'agent'], scope: `${c.castApp}:read ${c.castApp}:write`, department: c.castDept, end_user: c.castUser, ...o });
const route = (c) => `/mcp/${c.castApp}`;

const ev = (title, say, claims, request, expect, o = {}) => ({ title, say, op: 'evaluate', claims, request, expect, ...o });
const dc = (title, say, params, expect) => ({ title, say, op: 'decide', params, expect });
const adv = (title, say, minutes, expect = 'ok') => ({ title, say, op: 'advance', params: { minutes }, expect });
const save = (title, say, params, expect) => ({ title, say, op: 'savePolicy', params, expect });

export const scenarioList = (c) => [
  {
    id: 'four-layers', title: 'Four layers, one at a time',
    say: `Four scope checks run in order, and each stops the call on its own. ${c.castAgent2}'s key claims the model surface, but its identity does not hold it. Then an application ${c.castAgent2} was never given, then a claim the application needs, then a scope the token lacks (a header that claims the scope is ignored), then a person who cannot be identified. The last call passes every layer.`,
    steps: [
      ev('Surface: the key claims more than its identity holds', `${c.castAgent2} presents a key that claims the model surface. The surface comes from the route (/llm/), and the identity caps the key, so this is refused before any policy is consulted.`,
        base(c, { sub: c.castAgent2, surfaces: ['tool', 'model'], scope: 'model:invoke' }), { route: `/llm/${c.castModelApp}`, tool: 'chat', arguments: { prompt: 'hello' } }, 'deny:surface_not_allowed'),
      ev('Application: no policy lets this identity reach it', `${c.castAgent2} holds the tool surface, but no application policy lets it reach ${c.castApp}.`,
        base(c, { sub: c.castAgent2, surfaces: ['tool'] }), { route: route(c), tool: c.castToolRead, arguments: { record: c.castRecord } }, 'deny:no_application_policy'),
      ev('Application: the token lacks a required claim', `${c.castAgent} may reach ${c.castApp}, but only with a department claim of ${c.castDept}. This token has none.`,
        (() => { const x = base(c); delete x.department; return x; })(), { route: route(c), tool: c.castToolRead, arguments: { record: c.castRecord } }, 'deny:required_claims_missing'),
      ev('Action: the token lacks the scope (a caller-supplied header is ignored)', `Sending ${c.castApp}:write is not the same as holding it. The header says the scope, the verified token does not, and only the token counts.`,
        base(c, { scope: `${c.castApp}:read` }), { route: route(c), tool: c.castToolWrite, arguments: { record: c.castRecord, amount: 50 }, headers: { 'x-scopes': `${c.castApp}:write ${c.castApp}:admin` } }, 'deny:scope_missing'),
      ev('End user: the person cannot be identified', `The key and the scope are fine, but a rule on ${c.castToolWrite} needs a person, and the token's end_user is nobody in the roster.`,
        base(c, { end_user: 'ghost.user' }), { route: route(c), tool: c.castToolWrite, arguments: { record: c.castRecord, amount: 50 } }, 'deny:end_user_unresolved'),
      ev('All four layers pass, allowed', `${c.castUser} is on the rule, the scope is held, the department matches, the surface is inside the key and its identity, and the amount is under ${c.castLimit}.`,
        base(c), { route: route(c), tool: c.castToolWrite, arguments: { record: c.castRecord, amount: 50 } }, 'allow:allowed'),
    ],
  },
  {
    id: 'hold-and-retry', title: 'Hold for a human, sign, retry',
    say: `${c.castChange} is allowed attended and refused unattended, so the call is held: it is refused at once with a reference and an expiry, nothing stays open. Wrong approvers are refused (the requester, a missing role, too weak a sign-in), one signs, the agent retries and proceeds. The same approval cannot be replayed, and changed arguments need a new one.`,
    steps: [
      ev('The call is held', `${c.castAgent} acting for ${c.castUser} asks for ${c.castToolHold}. Allow-then-deny means hold for a human: refused now, with a reference and an owning expiry.`,
        base(c), { route: route(c), tool: c.castToolHold, argumentsText: `{"record":"${c.castRecord}","newValue":"${c.castNewValue}"}` }, 'hold:hold_for_approval'),
      ev('Retry before anyone signs: the same request, not a second one', 'The agent calls again at once. Nothing was held open, so there is no connection to resume: the same request is returned, still unsigned.',
        base(c), { route: route(c), tool: c.castToolHold, argumentsText: `{"newValue":"${c.castNewValue}","record":"${c.castRecord}"}` }, 'hold:hold_for_approval'),
      dc('The requester tries to approve it', `${c.castUser} is the person the call acts for. Self-approval is refused.`, { ref: 'apr-0001', approver: c.castUser, decision: 'approve', authLevel: 2 }, 'refused:self_approval'),
      dc('An approver without the role tries', `${c.castSecurity} is a person, but holds ${c.castRoleSecurity}, not ${c.castRoleApprover}.`, { ref: 'apr-0001', approver: c.castSecurity, decision: 'approve', authLevel: 3 }, 'refused:role_missing'),
      dc('An approver signs in too weakly', `${c.castApprover} holds the role but signed with a password (level 1); the request demands at least a push approval (level 2).`, { ref: 'apr-0001', approver: c.castApprover, decision: 'approve', authLevel: 1 }, 'refused:auth_too_weak'),
      dc('An approver signs', `${c.castApprover} signs with a push approval (level 2). One approver is enough here.`, { ref: 'apr-0001', approver: c.castApprover, decision: 'approve', authLevel: 2 }, 'ok:approved'),
      ev('Changed arguments are a different call', `The agent retries with a different new value. The approval is bound to the canonical hash of the exact call, so it does not cover this one: a new request opens.`,
        base(c), { route: route(c), tool: c.castToolHold, arguments: { record: c.castRecord, newValue: 'something-else-1' } }, 'hold:hold_for_approval'),
      ev('The original call retries: it proceeds', 'The agent calls again with the exact arguments that were approved (key order and spacing do not matter). The grant is an input to this evaluation, and the call is made.',
        base(c), { route: route(c), tool: c.castToolHold, argumentsText: `{ "record": "${c.castRecord}", "newValue": "${c.castNewValue}" }` }, 'allow:allowed'),
      ev('The same approval is replayed: refused', 'The approval was single-use. Presented again for the same call, it is spent.',
        base(c), { route: route(c), tool: c.castToolHold, arguments: { record: c.castRecord, newValue: c.castNewValue }, approvalRef: 'apr-0001' }, 'deny:approval_consumed'),
    ],
  },
  {
    id: 'hard-denial', title: 'A hard denial no approval can lift',
    say: `${c.castToolHard} is refused in the attended form, so it is a hard denial, not a hold: there is no approval path. Even a valid, signed approval for another call changes nothing.`,
    steps: [
      ev('Hard denial', `${c.castSecurity} is on the end-user rule, the token carries the admin scope, and the rule still refuses the attended form. Nothing was opened for a person.`,
        base(c, { scope: `${c.castApp}:admin`, end_user: c.castSecurity }), { route: route(c), tool: c.castToolHard, arguments: { record: c.castRecord } }, 'deny:attended_refused'),
      ev('Meanwhile a different call is held', `For contrast, ${c.castToolHold} is a hold.`, base(c), { route: route(c), tool: c.castToolHold, arguments: { record: c.castRecord, newValue: c.castNewValue } }, 'hold:hold_for_approval'),
      dc('It is approved', `${c.castApprover} signs the hold.`, { ref: 'apr-0001', approver: c.castApprover, decision: 'approve', authLevel: 2 }, 'ok:approved'),
      ev('The approval is offered for the hard denial: still refused', `The grant is an input to the evaluation, not a bypass: it can lift a hold, and nothing above or beside it.`,
        base(c, { scope: `${c.castApp}:admin`, end_user: c.castSecurity }), { route: route(c), tool: c.castToolHard, arguments: { record: c.castRecord }, approvalRef: 'apr-0001' }, 'deny:attended_refused'),
    ],
  },
  {
    id: 'period-approval', title: 'A fixed period, two approvers',
    say: `${c.castAction} is held, and the approval is for a fixed period instead of one exact call: two different approvers at a hardware-key level (a duplicate counts once). While the period runs, calls to that tool proceed; when it ends, the next one is held again.`,
    steps: [
      ev('The call is held', `A payment above ${c.castLimit} is held. The request goes to a Jira ticket (simulated outbox).`, base(c), { route: route(c), tool: c.castToolWrite, arguments: { record: c.castRecord, amount: 25000 } }, 'hold:hold_for_approval'),
      dc('First approver signs', `${c.castApprover} signs at level 3. Two signatures are needed.`, { ref: 'apr-0001', approver: c.castApprover, decision: 'approve', authLevel: 3 }, 'ok:pending'),
      dc('The same approver signs again', 'A second signature from the same person counts once.', { ref: 'apr-0001', approver: c.castApprover, decision: 'approve', authLevel: 3 }, 'refused:duplicate_approver'),
      ev('Retry with one signature: still held', 'One of two. The call is held and the same request is returned.', base(c), { route: route(c), tool: c.castToolWrite, arguments: { record: c.castRecord, amount: 25000 } }, 'hold:hold_for_approval'),
      dc('Second approver signs', `${c.castApprover2} signs at level 3. The period starts now.`, { ref: 'apr-0001', approver: c.castApprover2, decision: 'approve', authLevel: 3 }, 'ok:approved'),
      ev('Retry: proceeds under the period', 'The call proceeds. The approval is a period, so it is not spent.', base(c), { route: route(c), tool: c.castToolWrite, arguments: { record: c.castRecord, amount: 25000 } }, 'allow:allowed'),
      ev('A different amount, same period: proceeds', 'A period covers any call to the tool by the same person until it ends, which is why a period grant is the broader choice.', base(c), { route: route(c), tool: c.castToolWrite, arguments: { record: c.castRecord, amount: 40000 } }, 'allow:allowed'),
      adv('The lab clock moves 31 minutes', 'The period was 30 minutes.', 31),
      ev('The period has ended: held again', 'A new request opens.', base(c), { route: route(c), tool: c.castToolWrite, arguments: { record: c.castRecord, amount: 25000 } }, 'hold:hold_for_approval'),
    ],
  },
  {
    id: 'post-inspection', title: 'Where it can run: findings cannot hold',
    say: 'Rules that read inspection findings run only after the request has been examined or after the reply has come back. The choice there is refuse the call or withhold the result. Neither can pause for a person, and a rule that tries is refused when saved.',
    steps: [
      ev('A finding on the request refuses the call', 'A card number in an argument is found on the examined request; the rule refuses the call before it is made.', base(c), { route: route(c), tool: c.castToolRead, arguments: { record: 'card 4111 1111 1111 1111' } }, 'deny:inspection_refused'),
      ev('A finding on the reply withholds the result', 'The call is made; the reply carries a card number, and the result is withheld. The call happened, the caller does not see it.', base(c), { route: route(c), tool: c.castToolRead, arguments: { record: c.castRecord }, simulatedReply: 'balance ok, card 4111 1111 1111 1111' }, 'withhold:reply_withheld'),
      ev('A clean reply is released', 'The same call with a clean reply.', base(c), { route: route(c), tool: c.castToolRead, arguments: { record: c.castRecord }, simulatedReply: 'balance 120.00' }, 'allow:allowed'),
      save('A rule that tries to hold on a finding is refused', 'Neither inspection stage can pause for a person, so a rule that asks for a hold is refused when it is saved.', { layer: 'inspection', rules: [{ id: 'insp-x', stage: 'reply', finding: 'secret', action: 'hold' }] }, 'refused:policy_refused'),
    ],
  },
  {
    id: 'fail-closed', title: 'Fail closed',
    say: 'An evaluation error denies. An argument of the wrong type denies. A tampered token denies. A rule naming something that does not exist is refused when saved, and anything that slips past is handled safely (a lab reading of a partly-cut-off deck line, not the deck\'s words).',
    steps: [
      ev('An argument of the wrong type', 'amount must be a number. A string that looks like one is not one.', base(c), { route: route(c), tool: c.castToolWrite, arguments: { record: c.castRecord, amount: '50' } }, 'deny:argument_type'),
      ev('An evaluation error', 'A lab fault makes the action layer throw. The evaluator does not guess: the call is denied.', base(c), { route: route(c), tool: c.castToolRead, arguments: { record: c.castRecord }, labFault: 'action' }, 'deny:evaluation_error'),
      ev('A tool that does not exist', 'There is no such tool in the application.', base(c), { route: route(c), tool: 'no_such_tool', arguments: {} }, 'deny:tool_unknown'),
      ev('Duplicate keys in the arguments', 'The arguments text names the same key twice. A parser that keeps the last one would let a reviewer see one value and an agent send another, so the lab refuses.', base(c), { route: route(c), tool: c.castToolRead, argumentsText: `{"record":"a","record":"b"}` }, 'deny:duplicate_key'),
      ev('A tampered token', 'One character of the payload was changed after signing. The signature no longer verifies.', base(c), { route: route(c), tool: c.castToolRead, arguments: { record: c.castRecord } }, 'deny:token_signature', { tamper: true }),
      save('A rule naming a person who cannot be identified', 'The roster has no such person, so the rule could never match. It is refused when saved rather than failing silently later.', { layer: 'users', rules: [{ id: 'usr-ghost', app: c.castApp, tool: c.castToolWrite, users: ['ghost.user'] }] }, 'refused:policy_refused'),
      save('A rule naming a scope that does not exist', 'No token could ever carry it.', { layer: 'actions', rules: [{ id: 'act-x', app: c.castApp, tool: c.castToolRead, requiresScope: 'no:such-scope' }] }, 'refused:policy_refused'),
    ],
  },
];

export const EXPECTED = Object.fromEntries(scenarioList(VERTICALS.finance).map((s) => [s.id, s.steps.map((x) => x.expect)]));

const tamper = (token) => { const [h, p, s] = token.split('.'); const i = Math.floor(p.length / 2); return `${h}.${p.slice(0, i)}${p[i] === 'A' ? 'B' : 'A'}${p.slice(i + 1)}.${s}`; };
const tag = (r, op) => {
  if (!r.ok) return `refused:${r.code}`;
  if (op === 'evaluate') return `${r.result.outcome}:${r.result.code}`;
  if (op === 'decide') return `ok:${r.result.status}`;
  return 'ok';
};

// Runs one scenario on a fresh engine. Returns { engine, steps } with each step's result, compact and free of any token string.
export function runScenario(cast, sc) {
  const e = new Engine(cast); const steps = [];
  for (const s of sc.steps) {
    let params = s.params; let shownClaims = null;
    if (s.op === 'evaluate') {
      const t = e.mintToken({ claims: s.claims, ttlMin: s.ttl });
      shownClaims = s.claims;
      params = { ...s.request, token: s.tamper ? tamper(t.labToken) : t.labToken };
    }
    const r = perform(e, s.op, params);
    steps.push({
      title: s.title, say: s.say, op: s.op, expect: s.expect, got: tag(r, s.op),
      request: s.op === 'evaluate' ? s.request : s.params, claims: shownClaims, tampered: !!s.tamper,
      result: r.ok ? (s.op === 'evaluate' ? r.result : r.result) : { code: r.code, detail: r.detail, status: r.status, ...(r.errors ? { errors: r.errors } : {}) },
      ok: r.ok,
    });
  }
  return { engine: e, steps };
}

// Canonical-form examples (pure computation): the same call written several ways gives one hash, a different call gives another.
export function canonicalExamples(c) {
  const t = `tool:${c.castApp}/${c.castToolHold}`;
  const forms = [
    ['The arguments as first sent', `{"record":"${c.castRecord}","newValue":"${c.castNewValue}"}`],
    ['Keys in another order, with spaces', `{ "newValue": "${c.castNewValue}", "record": "${c.castRecord}" }`],
    ['A letter written as an escape', `{"record":"${c.castRecord.replace('e', '\\u0065')}","newValue":"${c.castNewValue}"}`],
    ['A different new value', `{"record":"${c.castRecord}","newValue":"${c.castNewValue}0"}`],
    ['The same keys, an extra argument', `{"record":"${c.castRecord}","newValue":"${c.castNewValue}","note":"x"}`],
    ['Duplicate keys', `{"record":"${c.castRecord}","record":"${c.castRecord}","newValue":"${c.castNewValue}"}`],
    ['A number written four ways: 100', '{"amount":100}'], ['100.0', '{"amount":100.0}'], ['1e2', '{"amount":1e2}'], ['100 as a string', '{"amount":"100"}'],
    ['A number a double cannot hold', '{"amount":10000000000000001}'],
  ];
  return forms.map(([label, text]) => {
    const n = normalizeArguments({ text });
    return n.ok ? { label, text, ok: true, ...callHash({ method: METHODS.tool, target: t, arguments: n.value }) } : { label, text, ok: false, code: n.code, reason: n.reason };
  });
}

export function buildMockTable() {
  const verticals = {};
  for (const [id, cast] of Object.entries(VERTICALS)) {
    const list = scenarioList(cast);
    verticals[id] = {
      canonicalExamples: canonicalExamples(cast),
      scenarios: list.map((sc) => {
        const { engine, steps } = runScenario(cast, sc);
        return { id: sc.id, title: sc.title, say: sc.say, steps, state: engine.snapshot() };
      }),
    };
  }
  return { schema: 'ai-policies-mock-table/1', note: 'Generated by npm run mock-table from the lab engine. No token string is kept.', verticals };
}
export { canonicalJson };
