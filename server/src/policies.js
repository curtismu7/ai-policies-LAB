// The editable policy: six lists of rules, one per layer. LAB-INVENTED shapes (the deck describes the layers and the third outcome, not a rule format).
//   identities  SURFACE SCOPE      the surfaces an identity (and so any key it owns) may touch at all
//   apps        APPLICATION POLICY which applications an identity reaches, and the claims its token must carry first
//   actions     ACTION SCOPE       the scope the VERIFIED TOKEN must carry before a tool may be invoked
//   users       END-USER SCOPE     which people may take an action; a person who cannot be identified is refused WHEN SAVED
//   holds       ATTENDED / UNATTENDED  the two questions every request is asked; allow-then-deny is a HOLD, a refused attended form is a HARD DENIAL
//   inspection  rules that read findings, after the request is examined or after the reply: refuse the call or withhold the result, never hold
// Saving a layer validates EVERY rule and saves nothing if one is wrong (atomic). A rule that names something that does not exist (an unknown user, tool,
// application, scope, role, argument, identity) is refused with the reason: "a rule naming something that does not exist" is handled safely, and the
// slide text is cut off at that point in the PDF, so this is a LAB READING of a partly-cut-off deck line, not the deck's words.
import { cleanFree, findCredentials } from './credentials.js';
import { ARG_TYPES, AUTH_LEVELS, CHANNELS, FINDINGS, SURFACES, hasApp, hasTool } from './catalog.js';
import { FORBIDDEN_KEYS } from './canon.js';

export const LAYERS = ['identities', 'apps', 'actions', 'users', 'holds', 'inspection'];
export const LIMITS = { rulesPerLayer: 30, claimsPerRule: 6, valuesPerClaim: 10, usersPerRule: 20, rolesPerRule: 4, idLength: 40, valueLength: 60 };
export const OPS = { number: ['gt', 'gte', 'lt', 'lte', 'eq', 'ne'], string: ['eq', 'ne', 'in'], boolean: ['eq', 'ne'] };
export const BINDINGS = ['call', 'period'];

// What each field is and where it comes from, for the page ("lab-invented" unless it follows a deck sentence: then "lab reading").
export const EDITABLE_FIELDS = [
  { layer: 'identities', field: 'identity, surfaces', note: 'The surfaces (model, tool, agent) an identity may touch; a key can never exceed them.', source: 'reading' },
  { layer: 'apps', field: 'identity, app, requiredClaims[{claim, oneOf}]', note: 'Which applications an identity reaches, and the claims the presented token must carry first.', source: 'reading' },
  { layer: 'actions', field: 'app, tool, requiresScope', note: 'The scope the verified token must carry before a tool may be invoked.', source: 'reading' },
  { layer: 'users', field: 'app, tool, users[]', note: 'The people who may take an action. An unresolvable person is refused when saved.', source: 'reading' },
  { layer: 'holds', field: 'app, tool, when{arg, op, value}, attended, unattended', note: 'The two questions. attended deny = hard denial; attended allow + unattended deny = hold.', source: 'reading' },
  { layer: 'holds', field: 'approval{binding, windowMin, approvers, roles, minAuthLevel, channel, ttlMin}', note: 'What a hold needs: a single-use grant bound to the exact call, or a fixed period; how many approvers, which roles, the weakest sign-in allowed, where the request goes, and when the request itself expires.', source: 'reading' },
  { layer: 'inspection', field: 'stage, finding, action', note: 'Rules that read inspection findings: refuse the call (request) or withhold the result (reply). Neither can hold.', source: 'reading' },
  { layer: 'all', field: 'id', note: 'A rule id is a lab label.', source: 'invented' },
];

export function defaultPolicy(cast) {
  const c = cast;
  const claims = [{ claim: 'department', oneOf: [c.castDept] }];
  return {
    identities: [
      { id: 'ident-1', identity: c.castAgent, surfaces: ['tool', 'model', 'agent'] },
      { id: 'ident-2', identity: c.castAgent2, surfaces: ['tool'] },
      { id: 'ident-3', identity: c.castAgent3, surfaces: ['model'] },
    ],
    apps: [
      { id: 'app-1', identity: c.castAgent, app: c.castApp, requiredClaims: claims },
      { id: 'app-2', identity: c.castAgent, app: c.castApp2, requiredClaims: [] },
      { id: 'app-3', identity: c.castAgent, app: c.castModelApp, requiredClaims: [] },
      { id: 'app-4', identity: c.castAgent, app: c.castPeerApp, requiredClaims: [] },
      { id: 'app-5', identity: c.castAgent2, app: c.castApp2, requiredClaims: [] },
      { id: 'app-6', identity: c.castAgent3, app: c.castModelApp, requiredClaims: [] },
    ],
    actions: [
      { id: 'act-1', app: c.castApp, tool: c.castToolRead, requiresScope: `${c.castApp}:read` },
      { id: 'act-2', app: c.castApp, tool: c.castToolWrite, requiresScope: `${c.castApp}:write` },
      { id: 'act-3', app: c.castApp, tool: c.castToolHold, requiresScope: `${c.castApp}:write` },
      { id: 'act-4', app: c.castApp, tool: c.castToolHard, requiresScope: `${c.castApp}:admin` },
      { id: 'act-5', app: c.castApp2, tool: c.castToolList, requiresScope: `${c.castApp2}:read` },
      { id: 'act-6', app: c.castModelApp, tool: 'chat', requiresScope: 'model:invoke' },
      { id: 'act-7', app: c.castPeerApp, tool: 'ask', requiresScope: 'agent:ask' },
    ],
    users: [
      { id: 'usr-1', app: c.castApp, tool: c.castToolWrite, users: [c.castUser, c.castUser2, c.castApprover] },
      { id: 'usr-2', app: c.castApp, tool: c.castToolHold, users: [c.castUser, c.castUser2, c.castApprover] },
      { id: 'usr-3', app: c.castApp, tool: c.castToolHard, users: [c.castSecurity] },
    ],
    holds: [
      { id: 'hold-1', app: c.castApp, tool: c.castToolHold, attended: 'allow', unattended: 'deny',
        approval: { binding: 'call', windowMin: 15, approvers: 1, roles: [c.castRoleApprover], minAuthLevel: 2, channel: 'slack', ttlMin: 60 } },
      { id: 'hold-2', app: c.castApp, tool: c.castToolWrite, when: { arg: 'amount', op: 'gt', value: 10000 }, attended: 'allow', unattended: 'deny',
        approval: { binding: 'period', windowMin: 30, approvers: 2, roles: [c.castRoleApprover], minAuthLevel: 3, channel: 'jira', ttlMin: 120 } },
      { id: 'hold-3', app: c.castApp, tool: c.castToolHard, attended: 'deny', unattended: 'deny' },
    ],
    inspection: [
      { id: 'insp-1', stage: 'request', finding: 'card-number', action: 'refuse' },
      { id: 'insp-2', stage: 'request', finding: 'injection', action: 'refuse' },
      { id: 'insp-3', stage: 'reply', finding: 'card-number', action: 'withhold' },
      { id: 'insp-4', stage: 'reply', finding: 'secret', action: 'withhold' },
    ],
  };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const keysOk = (o, allowed) => Object.keys(o).every((k) => allowed.includes(k));

// ctx: { catalog, roster }. -> [{ path, code, reason }]; empty means every rule is valid. Reasons are fixed text and never echo the visitor's values.
export function validateLayer(layer, rules, ctx) {
  const errs = [];
  const err = (path, code, reason) => errs.push({ path, code, reason });
  if (!LAYERS.includes(layer)) return [{ path: '', code: 'unknown_layer', reason: 'that is not one of the policy layers' }];
  if (!Array.isArray(rules)) return [{ path: '', code: 'rules_not_a_list', reason: 'a layer is a list of rules' }];
  if (rules.length > LIMITS.rulesPerLayer) return [{ path: '', code: 'too_many_rules', reason: `a layer holds at most ${LIMITS.rulesPerLayer} rules` }];
  const { catalog, roster } = ctx;
  const humans = roster.filter((r) => r.kind === 'human'); const agents = roster.filter((r) => r.kind === 'agent');
  const ids = new Set();
  const str = (v, max = LIMITS.valueLength) => typeof v === 'string' && v.length > 0 && v.length <= max;
  const plain = (v) => str(v) && findCredentials(v).length === 0 && cleanFree(v, 100) === v;
  const known = (path, v, list, what) => { if (typeof v !== 'string' || !list.includes(v)) { err(path, `unknown_${what}`, what === 'user' ? 'a rule names a person who could never be identified (not in the roster), so it is refused when saved instead of failing silently later' : `a rule names ${what === 'identity' ? 'an' : 'a'} ${what} that does not exist, so it could never match`); return false; } return true; };

  rules.forEach((r, i) => {
    const at = `${layer}[${i}]`;
    if (!isObj(r)) return err(at, 'rule_not_an_object', 'a rule is an object');
    if (Object.keys(r).some((k) => FORBIDDEN_KEYS.includes(k))) return err(at, 'forbidden_key', 'a rule carries a key the lab never accepts');
    const base = ['id'];
    const shape = { identities: ['identity', 'surfaces'], apps: ['identity', 'app', 'requiredClaims'], actions: ['app', 'tool', 'requiresScope'], users: ['app', 'tool', 'users'],
      holds: ['app', 'tool', 'when', 'attended', 'unattended', 'approval'], inspection: ['stage', 'finding', 'action'] }[layer];
    if (!keysOk(r, [...base, ...shape])) err(at, 'unknown_field', 'a rule carries a field this layer does not take');
    if (typeof r.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(r.id) || findCredentials(r.id).length) err(`${at}.id`, 'bad_id', `a rule id is lowercase letters, digits and dashes, at most ${LIMITS.idLength} characters`);
    else if (ids.has(r.id)) err(`${at}.id`, 'duplicate_id', 'two rules in a layer share an id'); else ids.add(r.id);

    if (layer === 'identities') {
      known(`${at}.identity`, r.identity, agents.map((a) => a.id), 'identity');
      if (!Array.isArray(r.surfaces) || r.surfaces.length > SURFACES.length || !r.surfaces.every((s) => SURFACES.includes(s)) || new Set(r.surfaces).size !== r.surfaces.length) err(`${at}.surfaces`, 'bad_surfaces', 'surfaces is a list of model, tool, agent');
    }
    if (layer === 'apps') {
      if (r.identity !== '*') known(`${at}.identity`, r.identity, agents.map((a) => a.id), 'identity');
      if (!hasApp(catalog, r.app)) err(`${at}.app`, 'unknown_app', 'a rule names an application that does not exist');
      if (!Array.isArray(r.requiredClaims) || r.requiredClaims.length > LIMITS.claimsPerRule) err(`${at}.requiredClaims`, 'bad_claims', `requiredClaims is a list of at most ${LIMITS.claimsPerRule} claims`);
      else r.requiredClaims.forEach((c, j) => {
        const cp = `${at}.requiredClaims[${j}]`;
        if (!isObj(c) || !keysOk(c, ['claim', 'oneOf'])) return err(cp, 'bad_claims', 'a required claim is { claim, oneOf }');
        if (typeof c.claim !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(c.claim) || findCredentials(c.claim).length) err(`${cp}.claim`, 'bad_claim_name', 'a claim name is lowercase letters, digits and underscores');
        else if (['exp', 'nbf', 'iat', 'iss', 'aud', 'sub'].includes(c.claim)) err(`${cp}.claim`, 'reserved_claim', 'the registered claims are checked by the token step, not by a rule');
        if (!Array.isArray(c.oneOf) || c.oneOf.length > LIMITS.valuesPerClaim || !c.oneOf.every(plain)) err(`${cp}.oneOf`, 'bad_values', `oneOf is a list of at most ${LIMITS.valuesPerClaim} short plain strings (empty means the claim only has to be present)`);
      });
    }
    if (layer === 'actions' || layer === 'users' || layer === 'holds') {
      const toolOk = hasTool(catalog, r.app, r.tool);
      if (!hasApp(catalog, r.app)) err(`${at}.app`, 'unknown_app', 'a rule names an application that does not exist');
      else if (!toolOk) err(`${at}.tool`, 'unknown_tool', 'a rule names a tool that does not exist in that application');
      if (layer === 'actions' && (typeof r.requiresScope !== 'string' || !catalog.scopes.includes(r.requiresScope))) err(`${at}.requiresScope`, 'unknown_scope', 'a rule requires a scope that does not exist, so no token could ever carry it');
      if (layer === 'users') {
        if (!Array.isArray(r.users) || !r.users.length || r.users.length > LIMITS.usersPerRule) err(`${at}.users`, 'bad_users', `users is a list of 1 to ${LIMITS.usersPerRule} people`);
        else r.users.forEach((u, j) => known(`${at}.users[${j}]`, u, humans.map((h) => h.id), 'user'));
      }
      if (layer === 'holds') {
        if (!['allow', 'deny'].includes(r.attended)) err(`${at}.attended`, 'bad_verdict', 'attended is allow or deny');
        if (!['allow', 'deny'].includes(r.unattended)) err(`${at}.unattended`, 'bad_verdict', 'unattended is allow or deny');
        if (r.when !== undefined) {
          const w = r.when; const argType = toolOk && isObj(w) && typeof w.arg === 'string' && Object.hasOwn(catalog.apps[r.app].tools[r.tool].args, w.arg) ? catalog.apps[r.app].tools[r.tool].args[w.arg] : null;
          if (!isObj(w) || !keysOk(w, ['arg', 'op', 'value'])) err(`${at}.when`, 'bad_when', 'when is { arg, op, value }');
          else if (!argType) err(`${at}.when.arg`, 'unknown_arg', 'a condition names an argument the tool does not have');
          else if (!(OPS[argType] || []).includes(w.op)) err(`${at}.when.op`, 'bad_op', `the operators for a ${argType} argument are ${OPS[argType].join(', ')}`);
          else if (w.op === 'in' ? !Array.isArray(w.value) || !w.value.length || w.value.length > 10 || !w.value.every((x) => typeof x === argType && (argType !== 'string' || plain(x))) : typeof w.value !== argType || (argType === 'number' && !Number.isFinite(w.value)) || (argType === 'string' && !plain(w.value))) err(`${at}.when.value`, 'bad_value_type', `the value must be a ${argType} (a wrong-typed value is refused when saved, and a wrong-typed argument is a denial at run time)`);
        }
        const asksApproval = r.attended === 'allow' && r.unattended === 'deny';
        if (asksApproval && !isObj(r.approval)) err(`${at}.approval`, 'approval_required', 'allow then deny means hold for a person, so the rule must say what the approval needs');
        else if (!asksApproval && r.approval !== undefined) err(`${at}.approval`, 'approval_not_allowed', r.attended === 'deny' ? 'a rule that refuses the attended form is a hard denial: no approval can lift it, so it carries none' : 'a rule that allows both forms holds nothing, so it carries no approval');
        else if (asksApproval) {
          const a = r.approval; const ap = `${at}.approval`;
          if (!keysOk(a, ['binding', 'windowMin', 'approvers', 'roles', 'minAuthLevel', 'channel', 'ttlMin'])) err(ap, 'unknown_field', 'the approval carries a field the lab does not take');
          if (!BINDINGS.includes(a.binding)) err(`${ap}.binding`, 'bad_binding', 'binding is call (single-use, the exact call) or period (a fixed period)');
          const whole = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
          if (!whole(a.windowMin, 1, 1440)) err(`${ap}.windowMin`, 'bad_window', 'windowMin is a whole number of minutes from 1 to 1440 (how long the grant lasts after the last approver signs)');
          if (!whole(a.approvers, 1, 3)) err(`${ap}.approvers`, 'bad_approvers', 'approvers is 1 to 3');
          if (!whole(a.ttlMin, 5, 10080)) err(`${ap}.ttlMin`, 'bad_ttl', 'ttlMin is a whole number of minutes from 5 to 10080 (when the request itself expires)');
          if (!whole(a.minAuthLevel, 1, 3)) err(`${ap}.minAuthLevel`, 'bad_auth_level', `minAuthLevel is 1 to 3 (${Object.entries(AUTH_LEVELS).map(([k, v]) => `${k} ${v}`).join(', ')})`);
          if (typeof a.channel !== 'string' || !Object.hasOwn(CHANNELS, a.channel)) err(`${ap}.channel`, 'bad_channel', `channel is one of ${Object.keys(CHANNELS).join(', ')}`);
          if (!Array.isArray(a.roles) || !a.roles.length || a.roles.length > LIMITS.rolesPerRule) err(`${ap}.roles`, 'bad_roles', 'roles is a list of 1 to 4 role names');
          else {
            let roleOk = true;
            a.roles.forEach((role, j) => { if (!known(`${ap}.roles[${j}]`, role, catalog.roles, 'role')) roleOk = false; });
            if (roleOk && whole(a.approvers, 1, 3) && whole(a.minAuthLevel, 1, 3)) {
              const able = humans.filter((h) => h.roles.some((x) => a.roles.includes(x)) && h.maxAuthLevel >= a.minAuthLevel).length;
              if (able < a.approvers) err(ap, 'unfillable', 'no combination of lab people could ever sign this: fewer people hold a named role at that authentication strength than approvers are required');
            }
          }
        }
      }
    }
    if (layer === 'inspection') {
      if (!['request', 'reply'].includes(r.stage)) err(`${at}.stage`, 'bad_stage', 'stage is request or reply');
      if (!FINDINGS.includes(r.finding)) err(`${at}.finding`, 'unknown_finding', `finding is one of ${FINDINGS.join(', ')}`);
      if (r.action === 'hold') err(`${at}.action`, 'inspection_cannot_hold', 'rules that read inspection findings run after the request has been examined or after the reply has come back; the choice there is refuse the call or withhold the result, and neither can pause for a person');
      else if (r.stage === 'request' && r.action !== 'refuse') err(`${at}.action`, 'bad_action', 'on the request the only choice is refuse');
      else if (r.stage === 'reply' && r.action !== 'withhold') err(`${at}.action`, 'bad_action', 'on the reply the only choice is withhold');
      else if (!['request', 'reply'].includes(r.stage)) err(`${at}.action`, 'bad_action', 'action is refuse (request) or withhold (reply)');
    }
  });
  return errs;
}

export function policyProblems(policy, ctx) {
  return LAYERS.flatMap((l) => validateLayer(l, policy[l], ctx).map((e) => `${e.path}: ${e.code}`));
}

export const ARG_TYPE_NAMES = ARG_TYPES;
