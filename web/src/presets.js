// Quick starts for the request builder: each one fills the claims and the request, and says what the lab will answer. Built from the cast so the names match the vertical.
export function buildPresets(c) {
  const claims = (o = {}) => ({ sub: c.castAgent, surfaces: ["tool", "model", "agent"], scope: `${c.castApp}:read ${c.castApp}:write`, department: c.castDept, end_user: c.castUser, ...o });
  const call = (tool, args, o = {}) => ({ route: `/mcp/${c.castApp}`, tool, argumentsText: JSON.stringify(args), ...o });
  const holdArgs = { record: c.castRecord, newValue: c.castNewValue };
  return [
    { id: "allowed", group: "Layers", label: "A call that passes every layer", expect: "allow", claims: claims(), request: call(c.castToolRead, { record: c.castRecord }) },
    { id: "surface", group: "Layers", label: "1 Surface: the key claims more than its identity holds", expect: "deny: surface_not_allowed", claims: claims({ sub: c.castAgent2, surfaces: ["tool", "model"], scope: "model:invoke" }), request: { route: `/llm/${c.castModelApp}`, tool: "chat", argumentsText: '{"prompt":"hello"}' } },
    { id: "application", group: "Layers", label: "2 Application: no policy for this identity", expect: "deny: no_application_policy", claims: claims({ sub: c.castAgent2, surfaces: ["tool"] }), request: call(c.castToolRead, { record: c.castRecord }) },
    { id: "claims", group: "Layers", label: "2 Application: a required claim is missing", expect: "deny: required_claims_missing", claims: (() => { const x = claims(); delete x.department; return x; })(), request: call(c.castToolRead, { record: c.castRecord }) },
    { id: "action", group: "Layers", label: "3 Action: scope missing (a header claims it)", expect: "deny: scope_missing", claims: claims({ scope: `${c.castApp}:read` }), request: call(c.castToolWrite, { record: c.castRecord, amount: 50 }, { headers: { "x-scopes": `${c.castApp}:write` } }) },
    { id: "end-user", group: "Layers", label: "4 End user: the person cannot be identified", expect: "deny: end_user_unresolved", claims: claims({ end_user: "ghost.user" }), request: call(c.castToolWrite, { record: c.castRecord, amount: 50 }) },
    { id: "hold", group: "Hold", label: `Hold: ${c.castToolHold} (allow then deny)`, expect: "hold: reference and expiry", claims: claims(), request: call(c.castToolHold, holdArgs) },
    { id: "hold-reordered", group: "Hold", label: "Retry the same call (key order changed)", expect: "allow once approved", claims: claims(), request: call(c.castToolHold, { newValue: c.castNewValue, record: c.castRecord }) },
    { id: "hold-changed", group: "Hold", label: "Retry with changed arguments", expect: "hold: a new request", claims: claims(), request: call(c.castToolHold, { record: c.castRecord, newValue: "something-else-1" }) },
    { id: "period", group: "Hold", label: `A fixed period: ${c.castToolWrite} above ${c.castLimit}`, expect: "hold: two approvers", claims: claims(), request: call(c.castToolWrite, { record: c.castRecord, amount: 25000 }) },
    { id: "hard", group: "Hard denial", label: `Hard denial: ${c.castToolHard}`, expect: "deny: attended_refused", claims: claims({ scope: `${c.castApp}:admin`, end_user: c.castSecurity }), request: call(c.castToolHard, { record: c.castRecord }) },
    { id: "req-finding", group: "Where it runs", label: "A finding on the request (card number)", expect: "deny: inspection_refused", claims: claims(), request: call(c.castToolRead, { record: "card 4111 1111 1111 1111" }) },
    { id: "rep-finding", group: "Where it runs", label: "A finding on the reply (card number)", expect: "withhold", claims: claims(), request: call(c.castToolRead, { record: c.castRecord }, { simulatedReply: "balance ok, card 4111 1111 1111 1111" }) },
    { id: "wrong-type", group: "Fail closed", label: "An argument of the wrong type", expect: "deny: argument_type", claims: claims(), request: call(c.castToolWrite, { record: c.castRecord, amount: "50" }) },
    { id: "fault", group: "Fail closed", label: "An evaluation error (lab fault in the action layer)", expect: "deny: evaluation_error", claims: claims(), request: call(c.castToolRead, { record: c.castRecord }, { labFault: "action" }) },
    { id: "dup", group: "Fail closed", label: "Duplicate keys in the arguments", expect: "deny: duplicate_key", claims: claims(), request: { route: `/mcp/${c.castApp}`, tool: c.castToolRead, argumentsText: `{"record":"a","record":"b"}` } },
    { id: "proto", group: "Fail closed", label: "A __proto__ key in the arguments", expect: "deny: forbidden_key", claims: claims(), request: { route: `/mcp/${c.castApp}`, tool: c.castToolRead, argumentsText: `{"record":"a","__proto__":{"x":1}}` } },
    { id: "tamper", group: "Fail closed", label: "A tampered token", expect: "401: token_signature", claims: claims(), tamper: true, request: call(c.castToolRead, { record: c.castRecord }) },
  ];
}
// Changes one character in the middle of the payload, so the signature no longer verifies.
export function tamper(token) {
  const [h, p, s] = String(token).split(".");
  if (!p) return token;
  const i = Math.floor(p.length / 2);
  return `${h}.${p.slice(0, i)}${p[i] === "A" ? "B" : "A"}${p.slice(i + 1)}.${s}`;
}
export const toForm = (p) => ({ claimsText: JSON.stringify(p.claims, null, 2), ttl: "60", token: "", route: p.request.route, tool: p.request.tool, argumentsText: p.request.argumentsText, headersText: p.request.headers ? JSON.stringify(p.request.headers) : "", approvalRef: "", simulatedReply: p.request.simulatedReply || "", labFault: p.request.labFault || "" });
