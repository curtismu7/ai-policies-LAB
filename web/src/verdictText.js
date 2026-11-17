// The plain words for a decision, from ONE table keyed by the engine's code (and, where one code reads differently per layer, "code@stage").
// Each entry says why the call stopped and what would make it pass, the way a user would say it. The code stays on the page as small supporting detail.
// web/src/verdictText.test.js fails if any code the engine can emit (engine.js, token.js, canon.js) has no entry here, so a raw code is never the only
// explanation. Everything here describes what THIS LAB computes (a simulation of Ping release claims, UNVERIFIED on our tenant); none of it states how
// Ping's product behaves. The numbers quoted are the engine's own limits (the test compares them with canon.js and token.js).
import { visible } from "./safeText";

// Layer names as a reader says them: the engine's titles without the stray "1." "2." "3." "4." that numbered only four of the ten.
// The test compares these with STAGE_TITLE in server/src/engine.js.
export const STAGE_NAME = {
  request: "The call is read", token: "Token verification", surface: "Surface scope", application: "Application policy", action: "Action scope", "end-user": "End-user scope",
  "attended-unattended": "Attended and unattended", "request-inspection": "Request inspection", call: "The call is made (simulated upstream)", "reply-inspection": "Reply inspection",
};

// One sentence per layer on what it is for, in the lab's own words and true to what the lab computes (server/src/engine.js). Shown in the banner (for the
// layer that stopped the call) and in every layer's Detail: the engine's jargon names a layer, this says what it does.
export const STAGE_GLOSS = {
  request: "Reading the call checks that a tool is named and that the arguments are one valid JSON object within the lab's limits.",
  token: "Token verification checks that the token is genuine (RS256 signature), from this lab's issuer, meant for this gateway and within its time limits.",
  surface: "Surface scope checks that the kind of call (model, tool or agent) is one that both the key and the identity that owns it allow.",
  application: "Application policy checks that this identity may reach this application and that the token carries the claims the application requires.",
  action: "Action scope checks that the tool exists, that its arguments fit, and that the token carries the scope this tool requires.",
  "end-user": "End-user scope checks that the person the agent acts for is one the rules permit for this tool.",
  "attended-unattended": "Attended and unattended checks whether a rule refuses the call outright or holds it until a person approves it.",
  "request-inspection": "Request inspection looks in the arguments for content that a rule says to refuse, such as a card number.",
  call: "The call is made to a simulated upstream: nothing leaves the lab.",
  "reply-inspection": "Reply inspection looks in the reply for content that a rule says to withhold. The call has already been made by then.",
};

// A scope is a word the reader may not know; said once wherever the text names one.
const SCOPE_GLOSS = "A scope is a permission written into the token.";
// Where a scope is added in Live: the Evaluate form's Token panel (EvaluateTab.jsx: the Claims box, then Mint token).
const SCOPE_WHERE = 'In Live, add it to the "scope" value in the Claims box of the Token panel, press Mint token, then Evaluate.';

const safe = (v) => visible(String(v)).slice(0, 80);
const names = (a) => (Array.isArray(a) && a.length ? a.map(safe).join(", ") : "none");
const has = (a) => Array.isArray(a) && a.length > 0;
// a hold that needs more than one approver (the count is the approval record's own)
const many = (d) => Number.isInteger(d?.approval?.approvers) && d.approval.approvers > 1;
const E = (why, next, facts) => ({ why, next, ...(facts ? { facts } : {}) });
const REAPPROVE = "Call again without the reference to open a new request.";

export const VERDICT_TEXT = {
  // not decisions on their own: the marks the layer lines use
  ok: E("This layer passed, so the next one was checked.", ""),
  not_reached: E("This layer was not checked, because an earlier one had already stopped the call.", ""),
  allowed: E("Every layer passed, so the call was made and its result was released.", "Nothing to change."),
  evaluation_error: E("A layer failed while it was checking. A failure is treated as a denial, so the call was stopped (the lab fails closed).", "Set Lab fault to none and call again. If it was already none, the lab hit an error of its own: call again."),
  // The call is made before the reply is checked, so a failure at Reply inspection does not stop the call: it withholds the result.
  "evaluation_error@reply-inspection": E("The call was made, but the lab could not inspect the reply, so the result was not released. A reply that cannot be inspected is withheld (the lab fails closed).", "Set Lab fault to none and call again. If it was already none, the reply may be too long to inspect in full: call again with a shorter simulated reply."),

  // The call is read
  tool_missing: E("The call did not name a tool.", "Give the call a tool name."),
  arguments_not_json: E("The arguments are not valid JSON, so the lab could not read them.", "Fix the JSON (quotes, commas, braces, escapes) and call again."),
  arguments_not_object: E("The arguments must be one JSON object, like {\"record\": \"a\"}, and they are not.", "Send the arguments as a single JSON object."),
  arguments_too_large: E("The arguments are bigger than the lab reads: at most 4096 characters of text, 400 values, 40 keys in an object, 50 items in a list, and 1000 characters in a string.", "Send fewer or shorter values."),
  arguments_too_deep: E("The arguments nest deeper than the lab reads (at most 6 levels).", "Flatten the arguments."),
  duplicate_key: E("Two keys in the arguments are the same (after the lab normalises them), so it cannot tell which one is meant.", "Keep one of the two keys."),
  forbidden_key: E("The arguments contain a key the lab never accepts (__proto__, constructor or prototype).", "Remove that key."),
  lone_surrogate: E("A string in the arguments holds a broken character (a lone surrogate) that has no UTF-8 form.", "Fix or remove that character."),
  number_not_exact: E("A number in the arguments cannot be held exactly (more than 15 significant digits, or a whole number above 2^53 - 1).", "Use a shorter number, or send it as text if the tool takes text."),

  // Token verification (the lab's 401)
  token_missing: E("No token came with the call.", "Send a token with the call (on the Evaluate form, Mint token fills it in)."),
  token_malformed: E("The token cannot be read as a token: it needs three parts joined by dots, with JSON inside, and no more than 4096 characters.", "Mint a new token and send it unchanged."),
  token_alg: E("The token is not signed with RS256. The lab accepts only RS256, so a token with alg none or HS256 is refused.", "Mint a new token."),
  token_kid: E("The token names a signing key the lab does not have.", "Mint a new token."),
  token_signature: E("The signature does not match: the token was changed after it was signed, or it was not minted by this lab.", "Mint a new token and send it unchanged."),
  token_claims: E("The token's time claims (exp, nbf, iat) are missing or not numbers, or it holds a key the lab never accepts (__proto__, constructor, prototype).", "Mint a new token."),
  token_issuer: E("The token says it comes from an issuer other than the lab's own.", "Use a token minted by this lab."),
  token_audience: E("The token was issued for a different audience, not for this gateway.", "Use a token minted by this lab."),
  token_not_yet_valid: E("The token is not valid yet: its not-before time is later than the lab clock.", "Move the lab clock forward (Approvals tab), or mint a new token."),
  token_expired: E("The token has expired on the lab clock.", "Mint a new token. The lab clock only moves forward."),
  token_error: E("The lab could not check the token.", "Mint a new token and call again."),

  // Surface scope (claim_type is the one code four layers can emit; each has its own line below, this one is the fallback)
  claim_type: E("A claim in the token has the wrong type, and a claim of the wrong type is a denial.", "Mint the token with that claim in the shape the layer expects."),
  route_unknown: E("The route does not start with /llm/, /mcp/ or /a2a/ followed by an application name, so the lab cannot tell which surface the call is for.", "Use a route like /mcp/<application>."),
  identity_unknown: E("The token names no agent the lab knows, so there is no ceiling to hold the key against and the key can touch nothing.", "Use a token whose sub claim is one of the lab's agents."),
  "claim_type@surface": E("The token's surfaces claim has the wrong shape. It must be a list made only of model, tool and agent, and a claim of the wrong type is a denial.", "Mint the token with surfaces as a list, for example [\"tool\"]."),
  surface_not_allowed: E("The call is for a surface that the key and its identity together do not allow. A key can never exceed the identity that owns it.", "Call a surface that both the key and its identity hold, or change the identity's surfaces on the Policies tab.",
    (t) => (t?.detail ? `The route is on: ${safe(t.detail.routeSurface)}. The key claims: ${names(t.detail.keySurfaces)}. Its identity allows: ${names(t.detail.identityCeiling)}.` : "")),

  // Application policy
  app_unknown: E("The route names no application on that surface.", "Use the name of an application that exists on that surface."),
  no_application_policy: E("No application policy lets this identity reach this application.", "Call an application this identity may reach, or add an application policy for it on the Policies tab."),
  "claim_type@application": E("A claim the application requires has the wrong type. It must be text, a number, true or false, or a list of those, and a claim of the wrong type is a denial.", "Mint the token with that claim in one of those forms.",
    (t) => (has(t?.detail?.missing) ? `Claim: ${names(t.detail.missing)}.` : "")),
  required_claims_missing: E("The token does not carry the claims this application requires before it can be reached.", "Mint a token that carries those claims, with values the policy accepts.",
    (t) => (has(t?.detail?.missing) ? `Missing: ${names(t.detail.missing)}.` : "")),

  // Action scope
  tool_unknown: E("The application has no tool with that name.", "Call one of the application's tools."),
  argument_missing: E("The call leaves out an argument that is required.", "Add the missing argument to the call."),
  argument_type: E("An argument has the wrong type, and an argument of the wrong type is a denial.", "Send the argument with the type it needs.",
    (t) => (t?.detail?.argument ? `Argument ${safe(t.detail.argument)} must be a ${safe(t.detail.expected)}.` : "")),
  "claim_type@action": E(`The token's scope claim has the wrong type. It must be one string of space-separated scopes, and a claim of the wrong type is a denial. ${SCOPE_GLOSS}`, "Mint the token with scope as one string, for example \"a:read b:write\"."),
  scope_missing: E("The token does not carry the scope this tool needs. Scopes are read from the verified token only, never from a header or argument the caller sends.", `Add that scope to the token, or call a tool the token's scopes cover. ${SCOPE_WHERE}`,
    (t) => {
      const d = t?.detail; if (!d) return "";
      // what the tool needs is detail.required (every scope its rules name); lacking is only the part the token does not hold
      const need = has(d.required) ? d.required : d.lacking;
      if (!has(need)) return "";
      const missing = has(d.lacking) && has(d.required) && d.lacking.length < d.required.length ? ` Missing: ${names(d.lacking)}.` : "";
      return `This tool needs: ${names(need)}. The token carries: ${names(d.tokenScopes)}.${missing} ${SCOPE_GLOSS}`;
    }),

  // End-user scope
  "claim_type@end-user": E("The token's end_user claim has the wrong type. It must be text, and a claim of the wrong type is a denial.", "Mint the token with end_user as the person's name."),
  end_user_unresolved: E("A rule on this tool needs a real person, and the token's end_user names nobody the lab knows.", "Put a person the lab knows in the token's end_user claim."),
  end_user_not_permitted: E("The person behind the agent is not one of the people the rule permits for this tool.", "Act for a permitted person, or add this person to the end-user rule on the Policies tab.",
    (t) => (t?.detail?.user ? `The person: ${safe(t.detail.user)}.` : "")),

  // Attended and unattended: hard denial, hold, and the approval problems
  "argument_missing@attended-unattended": E("A hold rule reads an argument that the call does not carry, so the lab cannot tell whether the rule applies, and it denies.", "Include that argument in the call."),
  "argument_type@attended-unattended": E("A hold rule compares an argument of the wrong type, so the lab denies.", "Send that argument with the type the rule compares."),
  attended_refused: E("A rule refuses this call outright, even when a person is there to approve. This is a hard denial: no approval can lift it.", "No. Nothing the caller sends changes this, and an approval for another call does not help. Only a change to the rule on the Policies tab does, or call something else."),
  hold_without_approval: E("A rule asks for this call to be held but names no approval, so nobody could ever lift the hold. A hold that nobody can lift is a denial.", "Add an approval to that rule on the Policies tab."),
  hold_for_approval: E("A rule asks for a person to approve this call before it goes ahead. Nothing is kept waiting: the call was refused now, with a reference and an expiry.", "Have an approver sign the request on the Approvals tab, then make the same call again.",
    (t, d) => (many(d) ? `It needs ${d.approval.approvers} approvers, not one.` : "")),
  approval_unknown: E("The approval reference is not one this workspace issued.", "Use a reference from a hold in this workspace (like apr-0001), or call without one."),
  approval_other_requester: E("The approval was given for a different person.", REAPPROVE),
  approval_other_call: E("The approval was given for a different tool or a different call. An approval for one exact call does not cover changed arguments.", REAPPROVE),
  approval_pending: E("The approval has not been signed yet.", "Have an approver sign it on the Approvals tab, then call again."),
  approval_denied: E("The approval was denied by an approver.", REAPPROVE),
  approval_consumed: E("The approval was single-use and has already been spent. A replay is refused.", REAPPROVE),
  approval_expired: E("The approval has expired.", REAPPROVE),
  approval_policy_changed: E("The policy now asks for more than this approval was given for.", "Call again without the reference to open a new request under the current policy."),
  inspection_would_refuse: E("The call would be held, but request inspection would refuse it again on every retry, so the lab did not open an approval for a person to sign. This is a lab reading of the deck, not the deck's order.", "Take that content out of the arguments, or change the inspection rule on the Policies tab, then call again.",
    (t) => (has(t?.detail?.findings) ? `Finding: ${names(t.detail.findings)}.` : "")),
  hold_unfillable: E("This hold could never complete: too few people could sign it. The person the call acts for may not approve their own call.", "Change the approval rule (fewer approvers or other roles) on the Policies tab, or act for a different person.",
    (t) => (t?.detail?.required ? `People who could sign: ${safe(t.detail.eligible)}. Needed: ${safe(t.detail.required)}.` : "")),

  // Request and reply inspection
  inspection_refused: E("A finding on the request matches an inspection rule, so the call was refused before it was made. Inspection rules can refuse a call or withhold a result; they cannot hold it for a person.", "Take that content out of the arguments, or change the inspection rule on the Policies tab.",
    (t) => (has(t?.detail?.findings) ? `Finding: ${names(t.detail.findings)}.` : "")),
  reply_withheld: E("The call was made, but a finding in the reply matches an inspection rule, so the result was not released.", "Change the inspection rule on the Policies tab, or make a call whose reply does not carry that finding.",
    (t) => (has(t?.detail?.findings) ? `Finding: ${names(t.detail.findings)}.` : "")),
};

const NEXT_LABEL = { allow: "Next", hold: "What happens next", deny: "What would make it pass", withhold: "What would release the result" };

// The next step for a hold. One approver: unchanged. More: say how many people it takes, and how many are still missing if some have signed.
function holdNext(d) {
  const ref = d?.approval?.ref || "the request";
  if (!many(d)) return `Have an approver sign ${ref} on the Approvals tab, then make the same call again.`;
  const n = d.approval.approvers; const done = Number.isInteger(d.approval.signatures) ? Math.max(0, d.approval.signatures) : 0;
  if (done === 0) return `This needs ${n} approvers: have an approver sign ${ref} on the Approvals tab, then ${n === 2 ? "a second, different approver" : `${n - 1} more different approvers`} must sign it too. Then make the same call again.`;
  const left = Math.max(1, n - done);
  return `This needs ${n} approvers and has ${done} of ${n} signatures so far: ${left === 1 ? "one more, different approver" : `${left} more different approvers`} must sign ${ref} on the Approvals tab. Then make the same call again.`;
}

const WORD = { allow: "Allowed", hold: "Held", deny: "Denied", withhold: "Result withheld" };
const KIND = { allow: "allowed", hold: "held", deny: "denied", withhold: "withheld" };

// Why the layers after the stopping one were not checked, for the folded line "N more layers not checked because ...".
export const notCheckedBecause = (d) => (d?.outcome === "hold" ? "the call is held for approval" : d?.stage === "request-inspection" ? "the call was refused before it was made" : "an earlier one refused");

// "Denied at Action scope", but "Denied while reading the call": two of the layer names are sentences, not names.
const WHERE = { request: "while reading the call", call: "while making the call (simulated upstream)" };

// In Mock (read-only tables) there is no token form, Lab fault switch or policy editor, so a fix is something to try in Live; the sentence says so first.
const MOCK_FIX = "Mock is read-only; to try the fix, switch to Live.";

// The answer for one decision: { kind, headline, why, next, code, stage, layer }, in plain words. Never throws; an unknown code still gets a plain sentence.
export function verdictFor(d, { mock = false } = {}) {
  const outcome = d?.outcome in WORD ? d.outcome : "deny";
  const stage = d?.stage || null;
  const t = (d?.trace || []).find((x) => x.stage === stage) || null;
  const layer = (stage && STAGE_NAME[stage]) || (t?.title ? String(t.title).replace(/^\d+\.\s*/, "") : stage || "an unknown layer");
  const code = d?.code || "";
  const entry = VERDICT_TEXT[`${code}@${stage}`] || VERDICT_TEXT[code] || null;
  const hardStop = code === "attended_refused"; // no input from the caller can change it, so "what would make it pass" would mislead
  const headline = outcome === "allow" ? WORD.allow : `${WORD[outcome]} ${WHERE[stage] || `at ${layer}`}`;
  let why = entry ? entry.why : `The lab stopped this call at ${layer}, and it has no plain-language note for this code yet. The engine's own message is in the line for that layer below.`;
  const facts = entry?.facts ? entry.facts(t, d) : "";
  if (facts) why = `${why} ${facts}`;
  let next = entry ? entry.next : "Read the engine's message below, then change the call, the token or the policy it names.";
  if (code === "hold_for_approval") next = holdNext(d);
  if (mock && (outcome === "deny" || outcome === "withhold")) next = hardStop ? `${next} Mock is read-only, so the rule can only be changed in Live.` : `${MOCK_FIX} ${next}`;
  if (d?.failedClosed && code !== "evaluation_error") why = `${why} The lab failed closed here.`;
  const gloss = outcome === "allow" ? "" : STAGE_GLOSS[stage] || "";
  return { kind: KIND[outcome], headline, why, next, nextLabel: hardStop ? "Can the caller fix it?" : NEXT_LABEL[outcome], gloss, code, stage, layer, outcome };
}
