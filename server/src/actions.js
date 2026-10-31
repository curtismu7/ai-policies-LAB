// One dispatch for everything that changes an engine, used by the API, the scripted scenarios and the tests, so they cannot drift apart.
// A refusal from the engine is data ({ ok: false, code, detail, status }), never an exception; anything else is a bug and propagates.
// An evaluation is not a refusal: it ALWAYS returns a decision (allow, deny, hold or withhold), and the decision carries the HTTP status it earns.
import { InputError, refuse } from './errors.js';
import { STAGES } from './engine.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// Strict: a body may carry only the listed keys. The error never says which key was unexpected (it could be a credential).
export function onlyKeys(obj, allowed) { return isObj(obj) && Object.keys(obj).every((k) => allowed.includes(k)); }
export const EVALUATE_KEYS = ['route', 'tool', 'arguments', 'argumentsText', 'token', 'headers', 'approvalRef', 'simulatedReply', 'labFault'];
export const DECISION_KEYS = ['approver', 'decision', 'authLevel', 'comment'];

const OPS = {
  evaluate: (e, p) => {
    if (!onlyKeys(p, EVALUATE_KEYS)) throw refuse('unknown_field', 'the call carries a field the lab does not take');
    if (p.arguments !== undefined && p.argumentsText !== undefined) throw refuse('arguments_ambiguous', 'send the arguments as an object or as text, not both');
    if (p.labFault !== undefined && !STAGES.includes(p.labFault)) throw refuse('bad_fault', 'labFault names one of the pipeline stages');
    return e.evaluate(p);
  },
  mint: (e, p) => { if (!onlyKeys(p, ['claims', 'ttlMin'])) throw refuse('unknown_field', 'the mint call carries a field the lab does not take'); return e.mintToken(p); },
  decide: (e, p) => { if (!onlyKeys(p, ['ref', ...DECISION_KEYS])) throw refuse('unknown_field', 'the decision carries a field the lab does not take'); return e.decide(p); },
  advance: (e, p) => { if (!onlyKeys(p, ['minutes'])) throw refuse('unknown_field', 'the clock call carries a field the lab does not take'); return e.advance(p); },
  savePolicy: (e, p) => { if (!onlyKeys(p, ['layer', 'rules'])) throw refuse('unknown_field', 'the policy call carries a field the lab does not take'); return e.savePolicy(p.layer, p.rules); },
  resetPolicy: (e, p) => { if (!onlyKeys(p, ['layer'])) throw refuse('unknown_field', 'the policy call carries a field the lab does not take'); return e.resetPolicy(p.layer); },
};
export const OP_NAMES = Object.keys(OPS);

export function perform(engine, op, params) {
  if (!Object.hasOwn(OPS, op)) throw new Error(`unknown op ${op}`);
  try { return { ok: true, result: OPS[op](engine, params) }; }
  catch (e) { if (e instanceof InputError) return { ok: false, status: e.status, code: e.code, detail: e.message, ...(e.errors ? { errors: e.errors } : {}) }; throw e; }
}
