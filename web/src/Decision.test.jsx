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
import { VERDICT_TEXT } from "./verdictText";

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
    // the code is small supporting detail, never the explanation
    expect(within(v).getByTestId("decision-code")).toHaveTextContent(/^scope_missing$/);
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
  it("the stopping layer stands out and keeps its short reason and its code in view; the others show neither", () => {
    show(decide("action"));
    const stops = rows().filter((li) => li.dataset.stop === "true");
    expect(stops.map((li) => li.dataset.testid)).toEqual(["trace-action"]);
    const s = row("action").querySelector("summary");
    expect(s).toHaveTextContent("Action scope");
    expect(s).toHaveTextContent("Denied");
    expect(s).toHaveTextContent(/the verified token does not carry the scope this tool requires/);
    expect(s.querySelector("code")).toHaveTextContent(/^scope_missing$/);
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
