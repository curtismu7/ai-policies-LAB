// Types ONE value into every place a request can carry text, on every endpoint, and returns every answer as text (status, body, headers).
import { C, get, post, put } from './helpers.js';

const live = (extra = {}) => ({ mode: 'live', vertical: 'finance', ...extra });
const route = `/mcp/${C.castApp}`;

export async function sweep(url, v, good) {
    const enc = encodeURIComponent(v);
    const bodies = [
      ['POST', '/api/evaluate', live({ request: { route: v, tool: v, arguments: { record: v, [v]: v }, argumentsText: undefined, token: v, headers: { [v]: v, 'x-scopes': v }, approvalRef: v, simulatedReply: v, labFault: v } })],
      ['POST', '/api/evaluate', live({ request: { route, tool: C.castToolRead, argumentsText: `{"record":"${v.replace(/["\\\n]/g, '')}"}`, token: good, simulatedReply: `x ${v}` } })],
      ['POST', '/api/evaluate', live({ request: { route, tool: C.castToolHold, arguments: { record: v, newValue: `n ${v}` }, token: good, headers: { [v]: v } } })],
      ['POST', '/api/evaluate', live({ request: { route, tool: C.castToolRead, arguments: { record: 'r' }, token: good, [v]: v } })],
      ['POST', '/api/evaluate', live({ request: { route, tool: v, arguments: {}, token: good } })],
      ['POST', '/api/evaluate', live({ request: v, [v]: v })],
      ['POST', '/api/token', live({ token: { claims: { sub: v, scope: v, [v]: v, end_user: v }, ttlMin: v } })],
      ['POST', '/api/token', live({ token: { claims: { note: `a ${v} b` } } })],
      ['POST', '/api/token', live({ token: { [v]: v } })],
      ['POST', `/api/approvals/${enc}/decision`, live({ decision: { approver: v, decision: v, authLevel: v, comment: v, [v]: v } })],
      ['POST', '/api/approvals/apr-0001/decision', live({ decision: { approver: C.castSecurity, decision: 'approve', authLevel: 3, comment: `c ${v}` } })],
      ['POST', '/api/approvals/apr-0001/decision', live({ decision: { approver: C.castApprover, decision: 'deny', authLevel: 2, comment: `c ${v}` } })],
      ['POST', '/api/clock', live({ clock: { minutes: v, [v]: v } })],
      ['PUT', `/api/policies/${enc}`, live({ rules: [{ id: v, app: v, tool: v, users: [v], requiresScope: v, identity: v, surfaces: [v], [v]: v, when: { arg: v, op: v, value: v }, approval: { roles: [v], channel: v, binding: v } }] })],
      ['PUT', '/api/policies/users', live({ rules: [{ id: 'u', app: C.castApp, tool: C.castToolRead, users: [v] }] })],
      ['PUT', '/api/policies/apps', live({ rules: [{ id: 'a', identity: '*', app: C.castApp, requiredClaims: [{ claim: 'region', oneOf: [v] }] }] })],
      ['POST', `/api/policies/${enc}/reset`, live({})],
      ['POST', '/api/canonicalize', { mode: v, vertical: v, argumentsText: `{"a":"${v.replace(/["\\\n]/g, '')}"}`, route: v, tool: v, [v]: v }],
      ['POST', '/api/canonicalize', { arguments: { a: v } }],
      ['POST', '/api/reset', { [v]: v }],
    ];
    const gets = [`/api/state?mode=${enc}`, `/api/state?mode=live&vertical=${enc}&scenario=${enc}`, `/api/state?mode=mock&scenario=${enc}`, `/api/story?vertical=${enc}`, `/api/diagram?name=${enc}&vertical=${enc}`, `/api/${enc}`, `/api/health?x=${enc}`, `/api/jwks?x=${enc}`];
    const texts = [];
    for (const [m, p, b] of bodies) { const r = await (m === 'PUT' ? put : post)(url, p, b); texts.push(`${m} ${p.slice(0, 20)} ${r.status} ${await r.text()} ${[...r.headers.values()].join(' ')}`); }
    for (const g of gets) { const r = await get(url, g); texts.push(`GET ${r.status} ${await r.text()} ${[...r.headers.values()].join(' ')}`); }
    for (const hv of [v, `a ${v}`]) { const r = await get(url, '/api/state?mode=live', { 'x-workspace': hv.slice(0, 40).replace(/[^\x20-\x7e]/g, '?') }); texts.push(`H ${r.status} ${await r.text()}`); }
    return texts;
}
