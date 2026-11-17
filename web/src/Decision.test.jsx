// The decision explains itself in this order: the answer (allowed, held or denied, where, why, what next), then one compact line per layer, then the
// provenance tags inside each layer's Detail. These tests render the real Decision with decisions from the lab's real engine (no stand-ins).
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { VERTICALS } from "../../server/src/cast.js";
import { Engine } from "../../server/src/engine.js";
import Decision from "./components/Decision";
import { buildPresets, tamper } from "./presets";
import { setJsonView } from "./components/JsonPane";
import { VERDICT_TEXT, verdictFor } from "./verdictText";

const C = VERTICALS.finance;
const presets = buildPresets(C);
afterEach(cleanup);

// One preset, run through a fresh engine exactly as the API runs it (a real RS256 token minted by the lab's throwaway key).
function decide(id, { before } = {}) {
  const eng = new Engine(C);
  if (before) before(eng);
  const p = presets.find((x) => x.id === id);
  const minted = eng.mintToken({ claims: p.claims });
  return eng.evaluate({ token: p.tamper ? tamper(minted.labToken) : minted.labToken, ...p.request });
}
const show = (d) => { setJsonView("raw"); return render(<Decision decision={{ result: d, http: d.http }} />); };
const verdict = () => screen.getByTestId("verdict");
const rows = () => within(screen.getByTestId("trace")).getAllByTestId(/^trace-(?!unchecked|summary)/);
const row = (stage) => screen.getByTestId(`trace-${stage}`);
const KNOWN = ["deck claim", "lab reading", "lab-invented"];

describe("the verdict comes first", () => {
  it("a call denied at Action scope (scope_missing, the owner's case): where, why, and what to do, in plain words", () => {
    const d = decide("action"); expect(d.code).toBe("scope_missing"); expect(d.stage).toBe("action");
    show(d);
    const v = verdict();
    expect(v).toHaveAttribute("data-outcome", "deny");
    expect(within(v).getByTestId("verdict-headline")).toHaveTextContent(/^Denied at Action scope$/);
    expect(within(v).getByTestId("verdict-why")).toHaveTextContent("The token does not carry the scope this tool needs.");
    expect(within(v).getByTestId("verdict-why")).toHaveTextContent(new RegExp(`needs: ${C.castApp}:write`));
    expect(within(v).getByTestId("verdict-why")).toHaveTextContent(new RegExp(`carries: ${C.castApp}:read`));
    expect(within(v).getByTestId("verdict-next")).toHaveTextContent("Add that scope to the token, or call a tool the token's scopes cover.");
    // the code is small supporting detail, never the explanation: it lives in the stopping layer's Detail now, not in the banner
    expect(within(v).queryByTestId("decision-code")).toBeNull();
    expect(within(row("action")).getByTestId("decision-code")).toHaveTextContent(/^scope_missing$/);
    expect(v.textContent).not.toMatch(/layer \d|pipeline/i);
  });
  it("the verdict sits before the checklist, and the checklist before nothing else of the trace", () => {
    show(decide("action"));
    expect(verdict().compareDocumentPosition(screen.getByTestId("trace")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("decision").firstElementChild.tagName).toBe("H2"); // the panel title, then the answer
    expect(screen.getByTestId("decision").children[1]).toBe(verdict());
  });
  it("allowed: every layer passed, the call was made, the result released", () => {
    const d = decide("allowed"); show(d);
    expect(verdict()).toHaveAttribute("data-outcome", "allow");
    expect(screen.getByTestId("verdict-headline")).toHaveTextContent(/^Allowed$/);
    expect(screen.getByTestId("verdict-why")).toHaveTextContent("Every layer passed, so the call was made and its result was released.");
    expect(screen.getByTestId("verdict-next")).toHaveTextContent("Nothing to change.");
  });
  it("held: says where, that nothing is kept waiting, and the reference to sign", () => {
    const d = decide("hold"); expect(d.outcome).toBe("hold"); show(d);
    expect(verdict()).toHaveAttribute("data-outcome", "hold");
    expect(screen.getByTestId("verdict-headline")).toHaveTextContent(/^Held at Attended and unattended$/);
    expect(screen.getByTestId("verdict-why")).toHaveTextContent(/A rule asks for a person to approve this call before it goes ahead/);
    expect(screen.getByTestId("verdict-why")).toHaveTextContent(/Nothing is kept waiting/);
    expect(screen.getByTestId("verdict-next")).toHaveTextContent(new RegExp(`Have an approver sign ${d.approval.ref} on the Approvals tab, then make the same call again`));
  });
  it("a hard denial says no approval can lift it", () => {
    show(decide("hard"));
    expect(screen.getByTestId("verdict-headline")).toHaveTextContent(/^Denied at Attended and unattended$/);
    expect(screen.getByTestId("verdict-why")).toHaveTextContent(/hard denial: no approval can lift it/);
  });
  it("a result withheld: the call was made, the result was not released", () => {
    const d = decide("rep-finding"); expect(d.outcome).toBe("withhold"); show(d);
    expect(verdict()).toHaveAttribute("data-outcome", "withhold");
    expect(screen.getByTestId("verdict-headline")).toHaveTextContent(/^Result withheld at Reply inspection$/);
    expect(screen.getByTestId("verdict-why")).toHaveTextContent(/The call was made, but/);
    expect(screen.getByTestId("verdict-why")).toHaveTextContent(/card-number/);
  });
  it("refused by request inspection: refused before it was made", () => {
    show(decide("req-finding"));
    expect(screen.getByTestId("verdict-headline")).toHaveTextContent(/^Denied at Request inspection$/);
    expect(screen.getByTestId("verdict-why")).toHaveTextContent(/refused before it was made/);
  });
  it.each([
    ["tamper", "token_signature", /^Denied at Token verification$/, /changed after it was signed/],
    ["surface", "surface_not_allowed", /^Denied at Surface scope$/, /key and its identity together do not allow/],
    ["application", "no_application_policy", /^Denied at Application policy$/, /No application policy lets this identity reach/],
    ["claims", "required_claims_missing", /^Denied at Application policy$/, /Missing: department/],
    ["end-user", "end_user_unresolved", /^Denied at End-user scope$/, /needs a real person/],
    ["wrong-type", "argument_type", /^Denied at Action scope$/, /wrong type/],
    ["fault", "evaluation_error", /^Denied at Action scope$/, /A failure is treated as a denial/],
    ["dup", "duplicate_key", /^Denied while reading the call$/, /Two keys in the arguments are the same/],
    ["proto", "forbidden_key", /^Denied while reading the call$/, /never accepts/],
  ])("denied (%s -> %s): headline, plain reason, and the code only as supporting detail", (id, code, headline, why) => {
    const d = decide(id); expect(d.code).toBe(code); show(d);
    expect(screen.getByTestId("verdict-headline")).toHaveTextContent(headline);
    expect(screen.getByTestId("verdict-why")).toHaveTextContent(why);
    expect(screen.getByTestId("verdict-next").textContent.length).toBeGreaterThan(10);
    expect(screen.getByTestId("decision-code")).toHaveTextContent(new RegExp(`^${code}$`));
    expect(screen.getByTestId("verdict-why").textContent).not.toContain(code);
  });
  it("a bad-token denial is the lab's 401, and the wording says so", () => {
    const d = decide("tamper"); expect(d.http).toBe(401); show(d);
    expect(screen.getByTestId("verdict-why")).toHaveTextContent(/not minted by this lab|was not minted here|not minted/i);
  });
  it("every code in the table renders its own words in the banner for a decision that stopped on it", () => {
    for (const [code, e] of Object.entries(VERDICT_TEXT)) {
      if (code === "allowed" || code === "ok" || code === "not_reached" || code.includes("@")) continue;
      const stage = code === "hold_for_approval" ? "attended-unattended" : code === "reply_withheld" ? "reply-inspection" : code === "inspection_refused" ? "request-inspection" : "action";
      const outcome = code === "hold_for_approval" ? "hold" : code === "reply_withheld" ? "withhold" : "deny";
      const t = [{ stage, title: stage, verdict: outcome === "hold" ? "hold" : outcome === "withhold" ? "withhold" : "deny", code, reason: "x" }];
      const { unmount } = render(<Decision decision={{ result: { outcome, stage, code, http: 403, trace: t, reason: "x", approval: null }, http: 403 }} />);
      expect(screen.getByTestId("verdict-why").textContent.length, code).toBeGreaterThan(20);
      const own = VERDICT_TEXT[`${code}@${stage}`] || e; // a few codes read differently per layer
      expect(screen.getByTestId("verdict-why").textContent, code).toContain(own.why.split(" ").slice(0, 3).join(" "));
      unmount();
    }
  });
});

// A lab fault in one layer, run through the real engine (the Lab fault switch, Live only).
function faulted(labFault) {
  const eng = new Engine(C); const p = presets.find((x) => x.id === "allowed");
  return eng.evaluate({ token: eng.mintToken({ claims: p.claims }).labToken, ...p.request, labFault });
}
describe("an evaluation error reads true for the layer it happened in", () => {
  it("at Reply inspection the call WAS made: the banner says the result was withheld, never that the call was stopped", () => {
    const d = faulted("reply-inspection"); expect(d.code).toBe("evaluation_error"); expect(d.proceeded).toBe(true); show(d);
    expect(screen.getByTestId("verdict-headline")).toHaveTextContent(/^Result withheld at Reply inspection$/);
    const why = screen.getByTestId("verdict-why");
    expect(why).toHaveTextContent(/The call was made, but the lab could not inspect the reply, so the result was not released/);
    expect(why.textContent).not.toMatch(/call was stopped/);
    expect(screen.getByTestId("decision")).toHaveTextContent(/The call was made\. The result was withheld\./); // the panel and the banner agree
  });
  it("at the call layer the call was NOT made, so 'the call was stopped' is true", () => {
    const d = faulted("call"); expect(d.code).toBe("evaluation_error"); expect(d.proceeded).toBe(false); show(d);
    expect(screen.getByTestId("verdict-why")).toHaveTextContent(/so the call was stopped/);
    expect(screen.getByTestId("decision")).toHaveTextContent(/The call was not made\./);
  });
  it("the advice names the Lab fault switch as Live's, not as a fix for a call that is 'fine'", () => {
    show(faulted("action"));
    expect(screen.getByTestId("verdict-next")).toHaveTextContent(/^What would make it pass: Set Lab fault to none and call again\./);
    expect(screen.getByTestId("verdict-next").textContent).not.toMatch(/Nothing in the call itself is wrong/);
    expect(screen.getByTestId("verdict-next").textContent).not.toMatch(/Mock is read-only/);
  });
});

describe("Mock is read-only, so its advice says the fix is to try in Live", () => {
  const mockShow = (d) => { setJsonView("raw"); return render(<Decision decision={{ result: d, http: d.http }} mock />); };
  it("the Lab fault advice in Mock does not send the reader to a control that is not on the page", () => {
    mockShow(faulted("action"));
    expect(screen.getByTestId("verdict-next")).toHaveTextContent(/^What would make it pass: Mock is read-only; to try the fix, switch to Live\. Set Lab fault to none and call again\./);
  });
  it("the token advice (mint, add a scope) says so too", () => {
    mockShow(decide("action"));
    expect(screen.getByTestId("verdict-next")).toHaveTextContent(/Mock is read-only; to try the fix, switch to Live\. Add that scope to the token/);
    cleanup(); mockShow(decide("tamper"));
    expect(screen.getByTestId("verdict-next")).toHaveTextContent(/Mock is read-only; to try the fix, switch to Live\. Mint a new token/);
  });
  it("an allow and a hold read the same as in Live", () => {
    mockShow(decide("allowed")); expect(screen.getByTestId("verdict-next").textContent).not.toMatch(/Mock is read-only/);
    cleanup(); mockShow(decide("hold")); expect(screen.getByTestId("verdict-next").textContent).not.toMatch(/Mock is read-only/);
  });
  it("a result withheld by a fault in Mock gets the same note", () => {
    mockShow(faulted("reply-inspection"));
    expect(screen.getByTestId("verdict-next")).toHaveTextContent(/^What would release the result: Mock is read-only; to try the fix, switch to Live\./);
  });
});

describe("one compact line per layer, the layers after a refusal collapsed", () => {
  it("denied at Action scope: five layers passed or stopped, the other five folded into one line with the right count", () => {
    show(decide("action"));
    const group = screen.getByTestId("trace-unchecked");
    const summary = group.querySelector("summary");
    expect(summary).toHaveTextContent(/^5 more layers not checked because an earlier one refused/);
    expect(group.querySelector("details")).not.toHaveAttribute("open"); // collapsed by default
    // each is still listed inside, and the repeated sentence is gone
    for (const s of ["end-user", "attended-unattended", "request-inspection", "call", "reply-inspection"]) expect(group.querySelector(`[data-testid="trace-${s}"]`), s).toBeTruthy();
    expect(screen.getByTestId("decision").textContent).not.toMatch(/an earlier layer already refused/);
    // the layers that ran are not inside the group
    for (const s of ["request", "token", "surface", "application", "action"]) expect(group.querySelector(`[data-testid="trace-${s}"]`), s).toBeNull();
    expect(screen.getByTestId("trace-summary")).toHaveTextContent("4 passed, 1 denied, 5 not checked");
  });
  it("held: the count and the reason name the hold, not a refusal", () => {
    show(decide("hold"));
    expect(screen.getByTestId("trace-unchecked").querySelector("summary")).toHaveTextContent(/^3 more layers not checked because the call is held for approval/);
    expect(screen.getByTestId("trace-summary")).toHaveTextContent("6 passed, 1 held, 3 not checked");
  });
  it("one layer left over says layer, not layers; refused by request inspection leaves two", () => {
    show(decide("req-finding"));
    expect(screen.getByTestId("trace-unchecked").querySelector("summary")).toHaveTextContent(/^2 more layers not checked because the call was refused before it was made/);
  });
  it("allowed: all ten layers passed, nothing folded", () => {
    show(decide("allowed"));
    expect(screen.queryByTestId("trace-unchecked")).toBeNull();
    expect(rows()).toHaveLength(10);
    for (const li of rows()) expect(li).toHaveAttribute("data-verdict", "pass");
    expect(screen.getByTestId("trace-summary")).toHaveTextContent("10 passed");
  });
  it("every line carries a mark and a word, so the outcome never rests on colour alone", () => {
    show(decide("action"));
    const word = { pass: "Passed", deny: "Denied", "not-reached": "Not checked" };
    for (const li of rows()) {
      const s = li.querySelector("summary");
      expect(s.querySelector("svg[aria-hidden='true']"), li.dataset.testid).toBeTruthy();
      expect(s.textContent).toContain(word[li.dataset.verdict]);
      expect(s.textContent).toMatch(/Detail/);
    }
  });
  it("the stopping layer stands out; its line is mark, name, word and Detail only, and the engine's reason and code are in its Detail", () => {
    show(decide("action"));
    const stops = rows().filter((li) => li.dataset.stop === "true");
    expect(stops.map((li) => li.dataset.testid)).toEqual(["trace-action"]);
    const s = row("action").querySelector("summary");
    expect(s).toHaveTextContent("Action scope");
    expect(s).toHaveTextContent("Denied");
    expect(s.querySelector("code")).toBeNull();
    expect(row("action").querySelector(".check__body")).toHaveTextContent(/the verified token does not carry the scope this tool requires/);
    expect(row("action").querySelector(".check__body code")).toHaveTextContent(/^scope_missing$/);
    for (const li of rows().filter((x) => x !== row("action"))) { expect(li.querySelector("summary code")).toBeNull(); expect(li.querySelector("summary .check__why")).toBeNull(); }
  });
  it("a hold is the stopping layer too; an allowed call has none", () => {
    show(decide("hold"));
    expect(rows().filter((li) => li.dataset.stop === "true").map((li) => li.dataset.testid)).toEqual(["trace-attended-unattended"]);
    expect(row("attended-unattended").querySelector("summary")).toHaveTextContent("Held");
    cleanup(); show(decide("allowed"));
    expect(rows().filter((li) => li.dataset.stop === "true")).toHaveLength(0);
  });
  it("a reply withheld stops at Reply inspection with the call made before it", () => {
    show(decide("rep-finding"));
    expect(rows().filter((li) => li.dataset.stop === "true").map((li) => li.dataset.testid)).toEqual(["trace-reply-inspection"]);
    expect(row("reply-inspection").querySelector("summary")).toHaveTextContent("Withheld");
    expect(screen.queryByTestId("trace-unchecked")).toBeNull();
  });
  it("numbering is gone from the line names (no 1. 2. 3. 4. on only some layers)", () => {
    show(decide("action"));
    for (const li of rows()) expect(li.querySelector("summary .check__name").textContent).not.toMatch(/^\d/);
  });
  it("a fault in the call layer leaves no phantom rows: only the layers the engine reported are listed", () => {
    const d = decide("allowed", { before: () => {} });
    const eng = new Engine(C); const p = presets.find((x) => x.id === "allowed");
    const faulted = eng.evaluate({ token: eng.mintToken({ claims: p.claims }).labToken, ...p.request, labFault: "call" });
    expect(d.outcome).toBe("allow"); show(faulted);
    expect(rows().length).toBe(faulted.trace.length);
    expect(screen.getByTestId("verdict-headline")).toHaveTextContent(/^Denied while making the call \(simulated upstream\)$/);
  });
});

describe("where each layer comes from lives in its Detail", () => {
  it("every layer, including the folded ones, has exactly one source tag, inside its Detail and not in its headline line", () => {
    show(decide("action"));
    expect(rows()).toHaveLength(10);
    for (const li of rows()) {
      const tags = within(li).getAllByTestId("source-tag");
      expect(tags, li.dataset.testid).toHaveLength(1);
      expect(KNOWN).toContain(tags[0].textContent);
      expect(li.querySelector("summary [data-testid='source-tag']"), `${li.dataset.testid}: the tag competes with the outcome`).toBeNull();
      expect(tags[0].closest("details")).toBeTruthy();
    }
    expect(within(row("surface")).getByTestId("source-tag")).toHaveTextContent("deck claim");
    expect(within(row("token")).getByTestId("source-tag")).toHaveTextContent("lab reading");
    expect(within(row("request")).getByTestId("source-tag")).toHaveTextContent("lab-invented");
  });
  it("opening a layer's Detail shows its tag, what it means, and the engine's own words", async () => {
    show(decide("action"));
    const li = row("surface"); const det = li.querySelector(":scope > details");
    expect(det).not.toHaveAttribute("open");
    await userEvent.click(li.querySelector("summary"));
    expect(det).toHaveAttribute("open");
    expect(within(li).getByTestId("source-tag")).toBeVisible();
    expect(li).toHaveTextContent(/Ping release claim, UNVERIFIED on our tenant/); // the lab's honesty wording survives in the Detail
    expect(li).toHaveTextContent(/the surface comes from the route/);
  });
  it("a folded layer opens too: the group first, then the layer inside it", async () => {
    show(decide("action"));
    const group = screen.getByTestId("trace-unchecked");
    await userEvent.click(group.querySelector("summary"));
    expect(group.querySelector(":scope > details")).toHaveAttribute("open");
    const inner = row("end-user"); await userEvent.click(inner.querySelector("summary"));
    expect(inner.querySelector(":scope > details")).toHaveAttribute("open");
    expect(within(inner).getByTestId("source-tag")).toHaveTextContent("deck claim");
  });
  it("the controls are native disclosure summaries (keyboard operable: Enter and Space), none removed from the tab order", () => {
    show(decide("action"));
    const sums = screen.getByTestId("trace").querySelectorAll("summary");
    expect(sums.length).toBe(11); // ten layers and the folded group
    for (const s of sums) { expect(s.parentElement.tagName).toBe("DETAILS"); expect(s.getAttribute("tabindex")).not.toBe("-1"); expect(s.closest("[aria-hidden='true']")).toBeNull(); }
  });
});

// ---- Follow-up wording and layout: the stopping row is one line, the banner carries no second tag, every layer has a gloss, scopes are explained, a hold says
// how many people it needs, a withheld reply reads "Withheld" in its row, and a hard denial does not offer a "what would make it pass".
const flat = (el) => [...el.children].map((c) => c.textContent.trim()).filter(Boolean).join(" ");
const ROW_WORD = { deny: "Denied", hold: "Held", refuse: "Refused", withhold: "Withheld" };
const SCOPE_GLOSS = /A scope is a permission written into the token/;

describe("the stopping row is one line and does not repeat the banner", () => {
  it.each(["action", "hold", "hard", "tamper", "req-finding", "rep-finding", "wrong-type", "end-user", "surface", "application", "dup"])("%s: the stopping row reads mark, name, word, Detail and nothing else", (id) => {
    const d = decide(id); show(d);
    const stop = rows().find((li) => li.dataset.stop === "true"); expect(stop, id).toBeTruthy();
    const s = stop.querySelector("summary");
    const name = s.querySelector(".check__name").textContent;
    expect(flat(s), id).toBe(`${name} ${ROW_WORD[stop.dataset.verdict]} Detail`);
    expect(s.querySelector("code, .check__why"), id).toBeNull();
    // the engine's jargon sentence is not on the row at all; it sits in the Detail
    expect(flat(s)).not.toContain(d.reason);
    expect(stop.querySelector(".check__body")).toHaveTextContent(d.reason);
  });
  it("the row carries no sentence the banner already says", () => {
    show(decide("action"));
    const s = flat(row("action").querySelector("summary"));
    expect(s).toBe("Action scope Denied Detail");
    expect(s).not.toMatch(/scope this tool/);
  });
});

describe("the banner carries no second tag; the code and the source tag live in the stopping layer's Detail", () => {
  it("no code line and no source tag in the banner", () => {
    show(decide("action"));
    const v = verdict();
    expect(within(v).queryByTestId("decision-code")).toBeNull();
    expect(within(v).queryByTestId("source-tag")).toBeNull();
    expect(v.textContent).not.toMatch(/lab's code for this|Source of the three outcomes|scope_missing/);
  });
  it("the stopping layer's Detail holds the code, the engine's reason and exactly one source tag, and shows them when opened", async () => {
    show(decide("action"));
    const li = row("action");
    expect(within(li).getAllByTestId("source-tag")).toHaveLength(1);
    expect(within(li).getByTestId("source-tag")).toHaveTextContent("deck claim");
    await userEvent.click(li.querySelector("summary"));
    const body = li.querySelector(".check__body");
    expect(within(body).getByTestId("decision-code")).toHaveTextContent(/^scope_missing$/);
    expect(within(body).getByTestId("decision-code")).toBeVisible();
    expect(body).toHaveTextContent(/the verified token does not carry the scope this tool requires/);
    expect(within(body).getByTestId("source-tag")).toBeVisible();
  });
  it("an allowed call has no stopping layer: its code shows once, in the line under the banner, never in the banner", () => {
    show(decide("allowed"));
    expect(within(verdict()).queryByTestId("decision-code")).toBeNull();
    expect(screen.getAllByTestId("decision-code")).toHaveLength(1);
    expect(screen.getByTestId("decision-code")).toHaveTextContent(/^allowed$/);
  });
  it("the code appears once, in the stopping layer only, for every outcome that stops", () => {
    for (const id of ["action", "hold", "hard", "rep-finding", "req-finding", "tamper"]) {
      const d = decide(id); const { unmount } = show(d);
      const all = screen.getAllByTestId("decision-code");
      expect(all, id).toHaveLength(1);
      expect(all[0].closest("[data-stop='true']"), id).toBeTruthy();
      expect(all[0]).toHaveTextContent(new RegExp(`^${d.code}$`));
      unmount();
    }
  });
});

describe("every layer says what it is for", () => {
  it("the banner names what the layer that stopped the call does, in one sentence", () => {
    show(decide("action"));
    const g = within(verdict()).getByTestId("verdict-gloss");
    expect(g).toHaveTextContent(/^Action scope checks that .*the token carries the scope this tool requires\.$/);
    expect(g.textContent.length).toBeLessThan(160);
    cleanup(); show(decide("hold"));
    expect(within(verdict()).getByTestId("verdict-gloss")).toHaveTextContent(/^Attended and unattended checks /);
  });
  it("an allowed call has no stopping layer, so no gloss in the banner", () => {
    show(decide("allowed"));
    expect(within(verdict()).queryByTestId("verdict-gloss")).toBeNull();
  });
  it("every layer's Detail carries its own gloss, including the folded ones", () => {
    show(decide("action"));
    expect(rows()).toHaveLength(10);
    for (const li of rows()) {
      const g = within(li).getByTestId("layer-gloss");
      expect(g.textContent.length, li.dataset.testid).toBeGreaterThan(30);
      expect(g.closest("details"), li.dataset.testid).toBeTruthy();
      expect(li.querySelector("summary [data-testid='layer-gloss']")).toBeNull(); // not on the one-line row
    }
    expect(within(row("action")).getByTestId("layer-gloss")).toHaveTextContent(/carries the scope this tool requires/);
    expect(within(row("surface")).getByTestId("layer-gloss")).toHaveTextContent(/model, tool or agent/);
  });
  it("the banner gloss and the Detail gloss are the same sentence (one source)", () => {
    show(decide("action"));
    expect(screen.getByTestId("verdict-gloss").textContent).toBe(within(row("action")).getByTestId("layer-gloss").textContent);
  });
});

describe("a scope is explained, and Live says where to add one", () => {
  it("the banner says what a scope is, beside the scopes it names", () => {
    show(decide("action"));
    const why = screen.getByTestId("verdict-why");
    expect(why).toHaveTextContent(SCOPE_GLOSS);
    expect(why).toHaveTextContent(new RegExp(`needs: ${C.castApp}:write`));
    expect(why).toHaveTextContent(new RegExp(`carries: ${C.castApp}:read`));
  });
  it("Live: the next step names the Claims box of the Token panel, the scope value and Mint token", () => {
    show(decide("action"));
    const next = screen.getByTestId("verdict-next");
    expect(next).toHaveTextContent(/Add that scope to the token, or call a tool the token's scopes cover\./);
    expect(next).toHaveTextContent(/Claims box/);
    expect(next).toHaveTextContent(/"scope"/);
    expect(next).toHaveTextContent(/Mint token/);
    expect(next.textContent).not.toMatch(/Mock is read-only/);
  });
  it("Mock keeps its read-only note first and the same where-to-add text after it", () => {
    setJsonView("raw"); render(<Decision decision={{ result: decide("action"), http: 403 }} mock />);
    expect(screen.getByTestId("verdict-next")).toHaveTextContent(/Mock is read-only; to try the fix, switch to Live\. Add that scope to the token/);
    expect(screen.getByTestId("verdict-next")).toHaveTextContent(/Claims box/);
  });
  it("the scope-claim type error explains scope too", () => {
    const v = verdictFor({ outcome: "deny", stage: "action", code: "claim_type", trace: [{ stage: "action", verdict: "deny", code: "claim_type" }] });
    expect(v.why).toMatch(SCOPE_GLOSS);
  });
});

describe("scope_missing states what the tool needs, not only what is missing", () => {
  const dec = (detail) => ({ outcome: "deny", stage: "action", code: "scope_missing", trace: [{ stage: "action", verdict: "deny", code: "scope_missing", detail }] });
  it("the real engine gives detail.required and detail.lacking, and the text uses required", () => {
    const d = decide("action"); const t = d.trace.find((x) => x.stage === "action");
    expect(t.detail.required).toEqual([`${C.castApp}:write`]); expect(t.detail.lacking).toEqual([`${C.castApp}:write`]);
  });
  it("a tool with two scope rules, the token holding one: both are named as needed, and the missing one is named", () => {
    const v = verdictFor(dec({ required: ["a:read", "a:write"], lacking: ["a:write"], tokenScopes: ["a:read"] }));
    expect(v.why).toMatch(/This tool needs: a:read, a:write\./);
    expect(v.why).toMatch(/The token carries: a:read\./);
    expect(v.why).toMatch(/Missing: a:write\./);
    expect(v.why).not.toMatch(/needs: a:write\./);
  });
  it("when everything needed is missing, 'Missing' is not said twice", () => {
    const v = verdictFor(dec({ required: ["a:write"], lacking: ["a:write"], tokenScopes: ["a:read"] }));
    expect(v.why).toMatch(/needs: a:write\./); expect(v.why).not.toMatch(/Missing:/);
  });
  it("an engine that gives only lacking (older detail) still reads true", () => {
    const v = verdictFor(dec({ lacking: ["a:write"], tokenScopes: ["a:read"] }));
    expect(v.why).toMatch(/This tool needs: a:write\./);
  });
});

describe("a hold that needs more than one approver says so, with the real count", () => {
  it("period approval: the banner and the next step say 2 approvers and that a second person must sign", () => {
    const d = decide("period"); expect(d.outcome).toBe("hold"); expect(d.approval.approvers).toBe(2); show(d);
    expect(screen.getByTestId("verdict-why")).toHaveTextContent(/needs 2 approvers/);
    const next = screen.getByTestId("verdict-next");
    expect(next).toHaveTextContent(new RegExp(`needs 2 approvers: have an approver sign ${d.approval.ref} on the Approvals tab, then a second, different approver must sign it too`));
    expect(next).toHaveTextContent(/Then make the same call again/);
  });
  it("one signature in, one to go: the text says how many are still missing", () => {
    const eng = new Engine(C); const p = presets.find((x) => x.id === "period");
    const call = () => eng.evaluate({ token: eng.mintToken({ claims: p.claims }).labToken, ...p.request });
    const first = call(); eng.decide({ ref: first.approval.ref, approver: C.castApprover, decision: "approve", authLevel: 3 });
    const again = call(); expect(again.approval.signatures).toBe(1); expect(again.approval.reused).toBe(true); show(again);
    expect(screen.getByTestId("verdict-next")).toHaveTextContent(/has 1 of 2 signatures so far: one more, different approver must sign/);
  });
  it("a hold that needs one approver reads exactly as before", () => {
    const d = decide("hold"); expect(d.approval.approvers).toBe(1); show(d);
    expect(screen.getByTestId("verdict-next").textContent).toBe(`What happens next: Have an approver sign ${d.approval.ref} on the Approvals tab, then make the same call again.`);
    expect(screen.getByTestId("verdict-why").textContent).not.toMatch(/approvers|second/);
  });
  it("three approvers: counts the people still needed", () => {
    const v = verdictFor({ outcome: "hold", stage: "attended-unattended", code: "hold_for_approval", approval: { ref: "apr-0007", approvers: 3, signatures: 0 }, trace: [{ stage: "attended-unattended", verdict: "hold", code: "hold_for_approval" }] });
    expect(v.next).toMatch(/needs 3 approvers: have an approver sign apr-0007 on the Approvals tab, then 2 more different approvers must sign it too/);
  });
});

describe("a withheld reply reads Withheld in its row, the banner and the tally", () => {
  it("a reply finding: row, banner and tally agree", () => {
    show(decide("rep-finding"));
    expect(screen.getByTestId("verdict-headline")).toHaveTextContent(/^Result withheld at Reply inspection$/);
    expect(row("reply-inspection").querySelector("summary")).toHaveTextContent("Withheld");
    expect(row("reply-inspection").querySelector("summary").textContent).not.toMatch(/Denied/);
    expect(screen.getByTestId("trace-summary")).toHaveTextContent("9 passed, 1 withheld");
  });
  it("a lab fault at Reply inspection (the engine's layer verdict is deny): the row still says Withheld, and the tally counts it as withheld, not denied", () => {
    const d = faulted("reply-inspection"); expect(d.trace.find((t) => t.stage === "reply-inspection").verdict).toBe("deny"); show(d);
    expect(screen.getByTestId("verdict-headline")).toHaveTextContent(/^Result withheld at Reply inspection$/);
    const li = row("reply-inspection");
    expect(li.querySelector("summary")).toHaveTextContent("Withheld");
    expect(li.querySelector("summary").textContent).not.toMatch(/Denied/);
    expect(li).toHaveAttribute("data-verdict", "withhold");
    expect(screen.getByTestId("trace-summary").textContent).toBe("9 passed, 1 withheld");
  });
  it("a fault in the call layer is a denial, so its row keeps Denied", () => {
    show(faulted("call"));
    expect(row("call").querySelector("summary")).toHaveTextContent("Denied");
    expect(screen.getByTestId("trace-summary")).toHaveTextContent("1 denied");
  });
  it("every row's word matches the tally: counts add up to the rows shown", () => {
    for (const d of [decide("rep-finding"), faulted("reply-inspection"), decide("action"), decide("hold"), decide("allowed")]) {
      const { unmount } = show(d);
      const total = screen.getByTestId("trace-summary").textContent.split(", ").reduce((n, x) => n + Number(x.split(" ")[0]), 0);
      expect(total).toBe(d.trace.length);
      unmount();
    }
  });
});

describe("a hard denial does not offer 'what would make it pass'", () => {
  it("it says whether the caller can fix it, and answers no", () => {
    const d = decide("hard"); show(d);
    const next = screen.getByTestId("verdict-next");
    expect(next).toHaveTextContent(/^Can the caller fix it\? No\. Nothing the caller sends changes this/);
    expect(next.textContent).not.toMatch(/What would make it pass/);
    expect(next).toHaveTextContent(/Policies tab/);
  });
  it("a denial the caller can fix keeps 'What would make it pass'", () => {
    show(decide("action")); expect(screen.getByTestId("verdict-next")).toHaveTextContent(/^What would make it pass:/);
  });
  it("Mock says the rule can only be changed in Live", () => {
    setJsonView("raw"); render(<Decision decision={{ result: decide("hard"), http: 403 }} mock />);
    expect(screen.getByTestId("verdict-next")).toHaveTextContent(/^Can the caller fix it\? No\. Nothing the caller sends changes this.*Mock is read-only/);
  });
});
