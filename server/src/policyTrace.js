// "What Privilege did" for this lab's own simulated gateway (engine.evaluate, the ten-layer pipeline). Mock and Live both run that engine and no real
// Privilege gateway is called here, so the trace is always source 'mock' and every decision is 'checked': engine.evaluate() computed each layer's
// verdict, in order. The request is the call the lab's gateway read (route, tool, arguments, ...), shown as the lab received it: there is no JSON-RPC
// message to invent. The response is the decision it returned, without its `trace` list (that list is the decisions shown beside it). The host is a
// non-real one (.invalid). The token is never shown, only that one was sent. Pass the request masked but whole (service.js scrubWhole): never cut, never the raw one.
import { mockTrace } from './gatewayTrace.js';

const PREFIX = { model: 'llm', tool: 'mcp', agent: 'a2a' };
// A hold is not a pass and not a refusal of the caller's identity: it is held for a person, so it is 'info', which the panel never counts as passed.
const OUTCOME = { pass: 'pass', 'not-reached': 'skipped', hold: 'info', deny: 'fail', refuse: 'fail', withhold: 'fail' };

// tokenNote: a short label for the token that was sent (never the token), or null when the call carried none.
export function policyTrace({ cast, request, tokenNote, decision }) {
  const d = decision;
  const { trace: stages = [], ...reply } = d;
  const path = d.surface && d.app && PREFIX[d.surface] ? `/${PREFIX[d.surface]}/${d.app}` : '/';
  const dash = (v) => (v == null || v === '' ? '-' : v);
  return mockTrace({
    url: `https://gateway.${cast.castHost}.invalid${path}`,
    authorization: tokenNote ? `Bearer <${tokenNote}: not repeated here>` : undefined,
    requestHeaders: { accept: null, ...(tokenNote ? {} : { authorization: null }) },
    rpc: request,
    status: d.http,
    body: reply,
    decisions: stages.map((s) => ({
      id: s.stage,
      label: s.title,
      outcome: OUTCOME[s.verdict] || 'info',
      evidence: s.verdict === 'pass' || s.verdict === 'not-reached' ? s.reason : `${s.verdict} (${s.code}): ${s.reason}`,
    })),
    record: `evaluation ${d.id} identity=${dash(d.identity)} surface=${dash(d.surface)} app=${dash(d.app)} tool=${dash(d.tool)} outcome=${d.outcome} stage=${dash(d.stage)} code=${d.code}`,
  });
}
