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

const safe = (v) => visible(String(v)).slice(0, 80);
const names = (a) => (Array.isArray(a) && a.length ? a.map(safe).join(", ") : "none");
const has = (a) => Array.isArray(a) && a.length > 0;
const E = (why, next, facts) => ({ why, next, ...(facts ? { facts } : {}) });
const REAPPROVE = "Call again without the reference to open a new request.";

export const VERDICT_TEXT = {
  // not decisions on their own: the marks the layer lines use
  ok: E("This layer passed, so the next one was checked.", ""),
  not_reached: E("This layer was not checked, because an earlier one had already stopped the call.", ""),
  allowed: E("Every layer passed, so the call was made and its result was released.", "Nothing to change."),
  evaluation_error: E("A layer failed while it was checking. A failure is treated as a denial, so the call was stopped (the lab fails closed).", "Nothing in the call itself is wrong. Here it happens when the Lab fault switch is set, or when the lab hits an error of its own: set Lab fault to none and call again."),

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
  "claim_type@action": E("The token's scope claim has the wrong type. It must be one string of space-separated scopes, and a claim of the wrong type is a denial.", "Mint the token with scope as one string, for example \"a:read b:write\"."),
  scope_missing: E("The token does not carry the scope this tool needs. Scopes are read from the verified token only, never from a header or argument the caller sends.", "Add that scope to the token, or call a tool the token's scopes cover.",
    (t) => (has(t?.detail?.lacking) ? `This tool needs: ${names(t.detail.lacking)}. The token carries: ${names(t.detail.tokenScopes)}.` : "")),

  // End-user scope
  "claim_type@end-user": E("The token's end_user claim has the wrong type. It must be text, and a claim of the wrong type is a denial.", "Mint the token with end_user as the person's name."),
  end_user_unresolved: E("A rule on this tool needs a real person, and the token's end_user names nobody the lab knows.", "Put a person the lab knows in the token's end_user claim."),
  end_user_not_permitted: E("The person behind the agent is not one of the people the rule permits for this tool.", "Act for a permitted person, or add this person to the end-user rule on the Policies tab.",
    (t) => (t?.detail?.user ? `The person: ${safe(t.detail.user)}.` : "")),

  // Attended and unattended: hard denial, hold, and the approval problems
  "argument_missing@attended-unattended": E("A hold rule reads an argument that the call does not carry, so the lab cannot tell whether the rule applies, and it denies.", "Include that argument in the call."),
  "argument_type@attended-unattended": E("A hold rule compares an argument of the wrong type, so the lab denies.", "Send that argument with the type the rule compares."),
  attended_refused: E("A rule refuses this call outright, even when a person is there to approve. This is a hard denial: no approval can lift it.", "Nothing the caller sends changes this, and an approval for another call does not help. Change the rule on the Policies tab, or call something else."),
  hold_without_approval: E("A rule asks for this call to be held but names no approval, so nobody could ever lift the hold. A hold that nobody can lift is a denial.", "Add an approval to that rule on the Policies tab."),
  hold_for_approval: E("A rule asks for a person to approve this call before it goes ahead. Nothing is kept waiting: the call was refused now, with a reference and an expiry.", "Have an approver sign the request on the Approvals tab, then make the same call again."),
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

const WORD = { allow: "Allowed", hold: "Held", deny: "Denied", withhold: "Result withheld" };
const KIND = { allow: "allowed", hold: "held", deny: "denied", withhold: "withheld" };

// Why the layers after the stopping one were not checked, for the folded line "N more layers not checked because ...".
export const notCheckedBecause = (d) => (d?.outcome === "hold" ? "the call is held for approval" : d?.stage === "request-inspection" ? "the call was refused before it was made" : "an earlier one refused");

// "Denied at Action scope", but "Denied while reading the call": two of the layer names are sentences, not names.
const WHERE = { request: "while reading the call", call: "while making the call (simulated upstream)" };

// The answer for one decision: { kind, headline, why, next, code, stage, layer }, in plain words. Never throws; an unknown code still gets a plain sentence.
export function verdictFor(d) {
  const outcome = d?.outcome in WORD ? d.outcome : "deny";
  const stage = d?.stage || null;
  const t = (d?.trace || []).find((x) => x.stage === stage) || null;
  const layer = (stage && STAGE_NAME[stage]) || (t?.title ? String(t.title).replace(/^\d+\.\s*/, "") : stage || "an unknown layer");
  const code = d?.code || "";
  const entry = VERDICT_TEXT[`${code}@${stage}`] || VERDICT_TEXT[code] || null;
  const headline = outcome === "allow" ? WORD.allow : `${WORD[outcome]} ${WHERE[stage] || `at ${layer}`}`;
  let why = entry ? entry.why : `The lab stopped this call at ${layer}, and it has no plain-language note for this code yet. The engine's own message is in the line for that layer below.`;
  const facts = entry?.facts ? entry.facts(t, d) : "";
  if (facts) why = `${why} ${facts}`;
  let next = entry ? entry.next : "Read the engine's message below, then change the call, the token or the policy it names.";
  if (code === "hold_for_approval") next = `Have an approver sign ${d?.approval?.ref || "the request"} on the Approvals tab, then make the same call again.`;
  if (d?.failedClosed && code !== "evaluation_error") why = `${why} The lab failed closed here.`;
  return { kind: KIND[outcome], headline, why, next, code, stage, layer, outcome };
}
