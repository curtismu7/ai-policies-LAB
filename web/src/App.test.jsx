// These tests drive the real UI against the real Express app (started on a loopback port inside the test), so a green run means the pieces
// actually work together: the real story data, the real engine, the real Mock table.
import http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createApp, startHttpServer } from "../../server/src/app.js";
import { createHealth } from "../../server/src/health.js";
import { createRunLog } from "../../server/src/runObs.js";
import { VERTICALS } from "../../server/src/cast.js";
import App, { TABS } from "./App";
import { fitOptions, labelOffsets } from "./components/PatternDiagram";
import { visible } from "./safeText";
import { setJsonView } from "./components/JsonPane";
import { forgetWorkspace, workspaceId } from "./workspace";
import { buildPresets, tamper } from "./presets";

const C = VERTICALS.finance;
let server; let base; const realFetch = globalThis.fetch; let seen = [];
let delay = () => 0;
let override = () => null; // a test may answer a request itself
let pending = 0;            // requests that have started and not yet answered
beforeAll(async () => {
  // The Real gateway hop reads the shared settings file; no test may reach for the author's own one.
  process.env.STANDALONE_ENV = "/nonexistent/standalone.env";
  for (const k of Object.keys(process.env)) if (k.startsWith("APL_GW_")) delete process.env[k];
  const health = createHealth({ runChecks: async () => [], intervalMs: 3_600_000 });
  ({ server, url: base } = await startHttpServer({ port: 0, host: "127.0.0.1", app: createApp({ health, configFile: "/nonexistent/customer.config.json", runLog: createRunLog({ write: () => {} }) }) }));
  base = base.replace(/\/$/, "");
  globalThis.fetch = async (u, init = {}) => {
    const url = typeof u === "string" && u.startsWith("/") ? `${base}${u}` : u;
    seen.push({ url: String(url), body: typeof init.body === "string" ? init.body : "" });
    pending += 1;
    try {
      const own = override(String(url), init); if (own) return own;
      const ms = delay(String(url), init); if (ms) await new Promise((r) => setTimeout(r, ms));
      const r = await realFetch(url, { ...init, headers: { origin: base, ...(init.headers || {}) } });
      await r.clone().text(); // the body has arrived too
      return r;
    } finally { pending -= 1; }
  };
});
afterAll(async () => { globalThis.fetch = realFetch; await new Promise((r) => server.close(r)); });
beforeEach(async () => { sessionStorage.clear(); /* the modal shows once per mode per session */ cleanup(); await waitFor(() => expect(pending).toBe(0), { timeout: 20000 }).catch(() => {}); /* a request the last test left in flight is awaited, not forgotten: it would count the next test's requests down to -1 */ forgetWorkspace(); seen = []; delay = () => 0; override = () => null; pending = 0; try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* ignore */ } window.location.hash = ""; // rule 19: the server holds the mode, so every test starts from mock
  await realFetch(`${base}/api/mode`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ source: "mock" }) }); });

const T = { timeout: 20000 };
const mount = async () => { render(<App />); await screen.findByTestId("scenario-four-layers", {}, T); };
const tab = (name) => userEvent.click(within(screen.getByRole("navigation", { name: "Lab sections" })).getByRole("link", { name }));
const click = (id, value) => (value === undefined ? userEvent.click(screen.getByTestId(id)) : userEvent.selectOptions(screen.getByTestId(id), value));
const live = async () => { await click("mode-select", "real"); await waitFor(() => expect(screen.getByTestId("mode")).toHaveTextContent(/^Live$/)); await screen.findByTestId("run-hold", {}, T); };
const pick = (id, value) => userEvent.selectOptions(screen.getByTestId(id), value);
// Click a quick start and wait for ITS answer: the evaluate request must have been sent and answered (a decision from an earlier click may still be on the page, and the
// button only turns disabled after React has rendered, so neither is proof that this run has finished).
const evaluations = () => seen.filter((x) => x.url.endsWith("/api/evaluate")).length;
const run = async (id) => {
  await waitFor(() => expect(screen.getByTestId(`run-${id}`)).toBeEnabled(), T);
  const before = evaluations();
  await click(`run-${id}`);
  await waitFor(() => expect(evaluations()).toBeGreaterThan(before), T);
  await waitFor(() => expect(pending).toBe(0), T);
  await waitFor(() => expect(screen.getByTestId("decision")).toBeInTheDocument(), T);
  await waitFor(() => expect(screen.getByTestId(`run-${id}`)).toBeEnabled(), T);
  await new Promise((r) => setTimeout(r, 0));
};
const code = () => screen.getByTestId("decision-code").textContent;
const settle = async () => { await waitFor(() => expect(pending).toBe(0), T); await new Promise((r) => setTimeout(r, 0)); };

describe("shell", () => {
  it("shows the shell bar, the mode badge, the seven section links, and the Mock scenarios", async () => {
    await mount();
    expect(screen.getByTestId("mode")).toHaveTextContent(/^Mock$/);
    expect(screen.getByTestId("mode")).toHaveTextContent(/^Mock$/);
    expect(TABS.map((t) => t.label)).toEqual(["Evaluate", "Policies", "Approvals", "Where it runs", "Fail closed", "Diagram", "Talk track"]);
    const nav = within(screen.getByRole("navigation", { name: "Lab sections" }));
    for (const t of TABS) expect(nav.getByRole("link", { name: t.label })).toBeInTheDocument();
    expect(nav.getByRole("link", { name: "Evaluate" })).toHaveAttribute("aria-current", "page");
    // Page order: the shell bar first (title, mode badge, section links, TopMenu), then main (the Real-or-mock modal sits outside it).
    const bar = document.querySelector(".app").firstElementChild;
    expect(bar).toBe(document.querySelector("header.shell-bar"));
    expect(bar.querySelector("h1")).toHaveTextContent("AI Policies LAB");
    expect(bar.contains(screen.getByTestId("mode"))).toBe(true);
    expect(bar.contains(screen.getByTestId("top-menu"))).toBe(true);
    expect(screen.queryByTestId("banner")).toBeNull();
    expect(screen.getAllByTestId(/^scenario-(?!say)/)).toHaveLength(6);
    await tab("Policies");
    expect(nav.getByRole("link", { name: "Policies" })).toHaveAttribute("aria-current", "page");
    expect(nav.getByRole("link", { name: "Evaluate" })).not.toHaveAttribute("aria-current");
    expect(window.location.hash).toBe("#policies");
  });
  it("Mock steps through a scenario and shows the engine's decision and layer-by-layer trace", async () => {
    await mount();
    await click("scenario-hold-and-retry");
    await waitFor(() => expect(screen.getByTestId("scenario-say")).toHaveTextContent(/refused at once/), T);
    await click("step-0");
    expect(screen.getByTestId("decision-code")).toHaveTextContent("hold_for_approval");
    expect(screen.getByTestId("approval-ref")).toHaveTextContent("apr-0001");
    expect(screen.getByTestId("trace-attended-unattended")).toHaveAttribute("data-verdict", "hold");
    await click("step-2"); expect(screen.getByTestId("step-result")).toHaveTextContent(/self_approval/);
    await click("step-8"); expect(screen.getByTestId("decision-code")).toHaveTextContent("approval_consumed");
  });
  it("Rule 25: Mock shows What Privilege did for an evaluation step (request, response, every layer checked, a hold is info) and none for a non-gateway step", async () => {
    setJsonView("raw"); await mount();
    await click("scenario-hold-and-retry"); await waitFor(() => expect(screen.getByTestId("scenario-say")).toHaveTextContent(/refused at once/), T);
    await click("step-0");
    const panel = screen.getByTestId("gateway-trace");
    expect(within(panel).getByTestId("gateway-trace-basis")).toHaveTextContent(/Simulated, in Mock and in Live/);
    expect(within(panel).getByTestId("trace-1")).toBeInTheDocument();
    expect(within(panel).getByTestId("trace-1-request-head")).toHaveTextContent(/POST https:\/\/gateway\.[a-z]+\.invalid\/mcp\//);
    expect(within(panel).getByTestId("trace-1-response-body")).toHaveTextContent(/hold_for_approval/);
    const layers = within(screen.getByTestId("trace-1-decisions")).getAllByRole("listitem");
    expect(layers).toHaveLength(10);
    expect(layers.filter((li) => li.getAttribute("data-outcome") === "info")).toHaveLength(1);
    expect(panel).toHaveTextContent(/refused at|for information/);
    await click("step-2"); // a person's decision on the approval: a lab action, not a call to the gateway
    expect(screen.queryByTestId("gateway-trace")).toBeNull();
  });
  it("Live switches the banner, keeps the mode chip in step, and Mock stays read-only", async () => {
    await mount(); await live();
    expect(screen.getByTestId("mode")).toHaveTextContent(/^Live$/);
    await tab("Policies"); expect((await screen.findByTestId("save-users", {}, T))).toBeEnabled();
    await click("mode-select", "mock"); await waitFor(() => expect(screen.getByTestId("mode")).toHaveTextContent(/^Mock$/), T);
    await waitFor(() => expect(screen.getByTestId("save-users")).toBeDisabled(), T);
    expect(screen.getByTestId("edit-users")).toHaveAttribute("readonly");
  });
  it("presenter mode (P, Esc) shows the talk track, and the old banner is not there to keep", async () => {
    await mount(); await userEvent.keyboard("p");
    await waitFor(() => expect(screen.getByTestId("presenter-say")).toBeInTheDocument());
    expect(screen.queryByTestId("banner")).toBeNull();
    await userEvent.keyboard("{Escape}"); await waitFor(() => expect(screen.queryByTestId("presenter-say")).toBeNull());
    expect(screen.queryByTestId("banner")).toBeNull();
  });
});

describe("Live flows", () => {
  it("layer by layer: each quick start stops at its own layer", async () => {
    await mount(); await live();
    for (const [id, c] of [["surface", "surface_not_allowed"], ["application", "no_application_policy"], ["claims", "required_claims_missing"], ["action", "scope_missing"], ["end-user", "end_user_unresolved"], ["allowed", "allowed"]]) {
      await run(id); expect(code()).toBe(c);
    }
    await run("action"); expect(screen.getByTestId("ignored-hints")).toHaveTextContent(/header naming scope/);
  });
  it("Rule 25: Live shows What Privilege did after a run, with no token in it", async () => {
    setJsonView("raw"); await mount(); await live();
    await run("allowed");
    const panel = await screen.findByTestId("gateway-trace", {}, T);
    await waitFor(() => expect(within(panel).getByTestId("trace-1")).toBeInTheDocument(), T);
    expect(within(panel).getByTestId("trace-1-decisions")).toHaveTextContent(/PASS/);
    expect(within(panel).getByTestId("trace-1-request-head")).toHaveTextContent(/authorization: Bearer <.*not repeated here>/);
    expect(panel.textContent).not.toMatch(/eyJ[\w-]{10,}\.[\w-]{10,}/);
    await run("surface");
    await waitFor(() => expect(within(screen.getByTestId("gateway-trace")).getByTestId("trace-1")).toHaveTextContent(/refused at: 1\. Surface scope/), T);
  });
  it("hold, a wrong approver, a weak sign-in, a right one, retry proceeds, replay refused, changed arguments need a new approval", async () => {
    await mount(); await live();
    await run("hold");
    expect(code()).toBe("hold_for_approval"); expect(screen.getByTestId("decision-http")).toHaveTextContent("HTTP 403");
    expect(screen.getByTestId("approval-ref")).toHaveTextContent("apr-0001"); expect(screen.getByTestId("approval-box")).toHaveTextContent(/Nothing is held open/);
    await tab("Approvals"); await screen.findByTestId("approval-apr-0001", {}, T);
    const sign = async (who, level) => { await pick("actor", who); await pick("auth-level", String(level)); await waitFor(() => expect(screen.getByTestId("approve-apr-0001")).toBeEnabled(), T); const before = screen.getByTestId("decision-message").textContent; await click("approve-apr-0001"); await waitFor(() => expect(screen.getByTestId("decision-message").textContent).not.toBe(before), T); await settle(); return screen.getByTestId("decision-message").textContent; };
    expect(await sign(C.castUser, 2)).toMatch(/self_approval/);
    expect(await sign(C.castSecurity, 3)).toMatch(/role_missing/);
    expect(await sign(C.castApprover, 1)).toMatch(/auth_too_weak/);
    expect(await sign(C.castApprover, 2)).toMatch(/apr-0001: approved/);
    expect(screen.getByTestId("approval-apr-0001")).toHaveAttribute("data-status", "approved");
    await tab("Evaluate"); await run("hold");
    expect(code()).toBe("allowed"); expect(screen.getByTestId("grant-used")).toHaveTextContent(/apr-0001.*spent/);
    await tab("Approvals"); await click("useref-apr-0001"); await tab("Evaluate");
    await waitFor(() => expect(screen.getByTestId("approval-ref-input")).toHaveValue("apr-0001"), T);
    await waitFor(() => expect(screen.getByTestId("evaluate")).toBeEnabled(), T); await click("evaluate");
    await waitFor(() => expect(code()).toBe("approval_consumed"), T);
    await run("hold-changed"); expect(code()).toBe("hold_for_approval"); expect(screen.getByTestId("approval-ref")).toHaveTextContent("apr-0002");
  });
  it("a hard denial no approval can lift", async () => {
    await mount(); await live(); await run("hard");
    expect(code()).toBe("attended_refused"); expect(screen.getByTestId("decision")).toHaveTextContent(/No approval can lift this/);
    expect(screen.getByTestId("trace-attended-unattended")).toHaveAttribute("data-verdict", "deny");
  });
  it("a finding on the request refuses, a finding on the reply withholds, and a rule that tries to hold on a finding is refused on save", async () => {
    await mount(); await live(); await tab("Where it runs");
    await waitFor(() => expect(screen.getByTestId("try-request-finding")).toBeEnabled(), T);
    await click("try-request-finding"); await settle(); await tab("Evaluate"); await screen.findByTestId("decision-code", {}, T); expect(code()).toBe("inspection_refused");
    await tab("Where it runs"); await click("try-reply-finding"); await settle(); await tab("Evaluate");
    await waitFor(() => expect(screen.getByTestId("decision")).toHaveAttribute("data-outcome", "withhold"), T);
    await tab("Where it runs"); await click("try-inspection-hold");
    expect((await screen.findByTestId("inspection-hold-refused", {}, T))).toHaveTextContent(/inspection_cannot_hold/);
  });
  it("a rule naming someone who does not exist is refused on save, nothing changes, and a good edit saves", async () => {
    await mount(); await live(); await tab("Policies"); await screen.findByTestId("add-ghost", {}, T);
    await click("add-ghost"); await click("save-users");
    const err = await screen.findByTestId("errors-users", {}, T);
    expect(err).toHaveTextContent(/unknown_user/); expect(err).toHaveTextContent(/could never be identified/); expect(err).toHaveTextContent(/nothing was changed/i);
    await click("reset-users"); await waitFor(() => expect(screen.queryByTestId("errors-users")).toBeNull(), T);
    await waitFor(() => expect(screen.getByTestId("edit-users").value).not.toMatch(/ghost/), T);
  });
  it("fail closed: wrong type, a fault, a tampered token, duplicate keys and a __proto__ key all deny", async () => {
    await mount(); await live(); await tab("Fail closed");
    for (const [id, c] of [["wrong-type", "argument_type"], ["fault", "evaluation_error"], ["tamper", "token_signature"], ["dup", "duplicate_key"], ["proto", "forbidden_key"]]) {
      await waitFor(() => expect(screen.getByTestId(`fc-${id}`)).toBeEnabled(), T); await click(`fc-${id}`);
      await waitFor(() => expect(screen.getByTestId("fc-result")).toHaveTextContent(c), T);
    }
    fireEvent.change(screen.getByTestId("canon-input"), { target: { value: '{"a":1,"a":2}' } }); await click("canon-run");
    expect(await screen.findByTestId("canon-refused", {}, T)).toHaveTextContent(/duplicate_key/);
    fireEvent.change(screen.getByTestId("canon-input"), { target: { value: '{"b":2,"a":1}' } }); await click("canon-run");
    expect((await screen.findByTestId("canon-hash", {}, T)).textContent).toMatch(/^[0-9a-f]{64}$/);
  });
  it("the token editor: mint shows a token labelled mock-issued; tampering changes it; editing claims changes the answer", async () => {
    await mount(); await live(); await click("load-allowed");
    await click("mint"); await waitFor(() => expect(screen.getByTestId("token").value).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/), T);
    expect(screen.getByTestId("minted-note")).toHaveTextContent(/mock-issued/);
    const t = screen.getByTestId("token").value; await click("tamper"); expect(screen.getByTestId("token").value).toBe(tamper(t));
    await click("evaluate"); await waitFor(() => expect(code()).toBe("token_signature"), T);
    expect(screen.getByTestId("decision-http")).toHaveTextContent("HTTP 401");
    fireEvent.change(screen.getByTestId("claims"), { target: { value: "not json" } }); await click("mint");
    expect(await screen.findByTestId("form-error", {}, T)).toHaveTextContent(/not valid JSON/);
  });
  it("Reset clears the approvals and the form", async () => {
    await mount(); await live(); await run("hold"); await click("reset");
    await waitFor(() => expect(screen.getByTestId("form-empty")).toBeInTheDocument(), T);
    await tab("Approvals"); await waitFor(() => expect(screen.getByTestId("inbox")).toHaveTextContent("Requests (0)"), T);
  });
  it("the page never makes a non-local request and never sends a credential field", async () => {
    await mount(); await live(); await run("hold");
    expect(seen.every((s) => s.url.startsWith(base))).toBe(true);
  });
});

describe("Real-or-mock modal", () => {
  it("opens on a MOCK modal that says simulated and UNVERIFIED on our tenant, with no old banner; Got it closes it for the session", async () => {
    await mount();
    const modal = await screen.findByTestId("mode-modal");
    expect(modal).toHaveAttribute("data-mode", "mock");
    expect(modal).toHaveTextContent("MOCK");
    expect(modal).toHaveTextContent(/simulated/);
    expect(modal).toHaveTextContent(/Ping release claim, UNVERIFIED on our tenant/);
    expect(modal).toHaveTextContent(/no real gateway, identity provider, chat tool, ticket system or tenant/);
    expect(screen.getByTestId("mode-modal-ok")).toHaveFocus();
    expect(screen.queryByTestId("banner")).toBeNull();
    expect(document.querySelector(".banner")).toBeNull();
    expect(document.body.textContent).not.toMatch(/SIMULATED, MOCK mode/);
    fireEvent.click(screen.getByTestId("mode-modal-ok"));
    expect(screen.queryByTestId("mode-modal")).toBeNull();
    cleanup(); await mount(); // the same browser session: not shown again
    expect(screen.queryByTestId("mode-modal")).toBeNull();
  });
  it("is MOCK until the server says which mode it holds, then REAL (Live), even after the first modal was dismissed; the REAL line says what stays simulated", async () => {
    await realFetch(`${base}/api/mode`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ source: "real" }) });
    delay = (u) => (u.endsWith("/api/info") ? 600 : 0);
    render(<App />);
    expect((await screen.findByTestId("mode-modal")).getAttribute("data-mode")).toBe("mock");
    fireEvent.click(screen.getByTestId("mode-modal-ok"));
    await waitFor(() => expect(screen.getByTestId("mode-modal")).toHaveAttribute("data-mode", "real"), T);
    expect(screen.getByTestId("mode-modal")).toHaveTextContent(/REAL/);
    expect(screen.getByTestId("mode-modal")).toHaveTextContent(/still a simulation/);
    expect(screen.getByTestId("mode-modal")).toHaveTextContent(/UNVERIFIED on our tenant/);
    fireEvent.click(screen.getByTestId("mode-modal-ok"));
    await screen.findByTestId("run-hold", {}, T); await settle();
  });
  it("switching Mock to Live shows REAL once, and back to Mock does not show the dismissed MOCK again", async () => {
    await mount();
    fireEvent.click(await screen.findByTestId("mode-modal-ok"));
    await click("mode-select", "real");
    await waitFor(() => expect(screen.getByTestId("mode-modal")).toHaveAttribute("data-mode", "real"), T);
    fireEvent.click(screen.getByTestId("mode-modal-ok"));
    await screen.findByTestId("run-hold", {}, T);
    await click("mode-select", "mock");
    await waitFor(() => expect(screen.getByTestId("mode")).toHaveTextContent(/^Mock$/), T);
    expect(screen.queryByTestId("mode-modal")).toBeNull();
    await settle();
  });
});

describe("stale answers", () => {
  it("an answer for a mode the visitor has already left is dropped", async () => {
    delay = (u) => (u.includes("mode=live") && u.includes("/api/state") ? 400 : 0);
    await mount(); await click("mode-select", "real"); await click("mode-select", "mock");
    await waitFor(() => expect(screen.getByTestId("mode")).toHaveTextContent(/^Mock$/), T);
    await settle(); await new Promise((r) => setTimeout(r, 450));
    expect(screen.getByTestId("mode")).toHaveTextContent(/^Mock$/);
    expect(screen.getAllByTestId(/^scenario-(?!say)/).length).toBe(6);
  });
});

describe("rule 19: server-backed mode", () => {
  it("each switch POSTs /api/mode with exactly {source} and the page reloads its data", async () => {
    await mount();
    seen.length = 0;
    await click("mode-select", "real");
    await waitFor(() => expect(screen.getByTestId("mode")).toHaveTextContent(/^Live$/), T);
    expect(seen.some((r) => r.url.endsWith("/api/mode") && r.body === JSON.stringify({ source: "real" }))).toBe(true);
    expect(seen.some((r) => r.url.includes("/api/state?"))).toBe(true);
    expect(screen.getByTestId("mode")).toHaveTextContent(/^Live$/);
    seen.length = 0;
    await click("mode-select", "mock");
    await waitFor(() => expect(screen.getByTestId("mode")).toHaveTextContent(/^Mock$/), T);
    expect(seen.some((r) => r.url.endsWith("/api/mode") && r.body === JSON.stringify({ source: "mock" }))).toBe(true);
    expect(screen.getByTestId("mode")).toHaveTextContent(/^Mock$/);
  });
  it("the mode the server holds survives a reload, and a bad body is refused 400", async () => {
    await mount();
    await click("mode-select", "real");
    await waitFor(() => expect(screen.getByTestId("mode")).toHaveTextContent(/^Live$/), T);
    cleanup(); render(<App />);
    await waitFor(() => expect(screen.getByTestId("mode")).toHaveTextContent(/^Live$/), T);
    const r = await fetch(`${base}/api/mode`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ source: "live" }) });
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error).toBe("bad_mode");
  });
});

describe("diagram", () => {
  it("loads diagram-studio data by name, with Simulate, speed and Reset", async () => {
    await mount(); await tab("Diagram");
    await screen.findByTestId("pattern-canvas", {}, T);
    expect(screen.getByTestId("simulate")).toBeInTheDocument(); expect(screen.getByTestId("speed")).toBeInTheDocument(); expect(screen.getByTestId("pattern-reset")).toBeInTheDocument();
    await click("dg-where-it-runs"); await waitFor(() => expect(screen.getByRole("region", { name: /Where it can run/ })).toBeInTheDocument(), T);
    expect(labelOffsets([{ from: "a", to: "b" }, { from: "b", to: "a" }])).toEqual([-16, 16]);
  });
  it("the quick starts are built from the cast and every one names its expected answer", () => {
    for (const v of Object.values(VERTICALS)) { const ps = buildPresets(v); expect(ps.length).toBe(18); for (const p of ps) { expect(p.expect).toBeTruthy(); expect(() => JSON.parse(p.request.argumentsText ?? "{}")).not.toThrow(); } }
    expect(visible("a\u202eb")).toContain("\\u202e");
  });
});

describe("source tags on every tab (S7)", () => {
  const tags = () => screen.getAllByTestId("source-tag").map((t) => t.textContent);
  const KNOWN = ["deck claim", "lab reading", "lab-invented"];
  it("Evaluate, Approvals, Where it runs, Fail closed and Diagram tag their own fields, not one panel tag", async () => {
    await mount(); await live(); await click("load-hold");
    const form = tags(); expect(form.length).toBeGreaterThanOrEqual(10); // the token, claims, route, tool, arguments, headers, reply, fault ...
    await run("hold");
    const evaluate = tags(); expect(evaluate.length).toBeGreaterThanOrEqual(form.length + 10); // the decision adds one per layer
    expect(within(screen.getByTestId("trace-surface")).getByTestId("source-tag")).toHaveTextContent("deck claim");
    expect(within(screen.getByTestId("trace-token")).getByTestId("source-tag")).toHaveTextContent("lab reading");
    expect(within(screen.getByTestId("trace-request")).getByTestId("source-tag")).toHaveTextContent("lab-invented");
    for (const t of evaluate) expect(KNOWN).toContain(t);
    await tab("Approvals"); await screen.findByTestId("inbox", {}, T);
    expect(tags().length).toBeGreaterThanOrEqual(6); // act as, level, clock, status, requirements, outbox
    expect(within(screen.getByTestId("approval-apr-0001")).getAllByTestId("source-tag").length).toBe(2);
    await tab("Where it runs"); expect(tags().length).toBeGreaterThanOrEqual(4);
    expect(within(screen.getByTestId("where-table")).getAllByTestId("source-tag").length).toBe(3);
    await tab("Fail closed"); expect(tags().length).toBeGreaterThanOrEqual(7); // six rules and the canonical form
    expect(within(screen.getByTestId("fail-rules")).getAllByTestId("source-tag").length).toBe(6);
    await tab("Diagram"); await screen.findByTestId("pattern-canvas", {}, T);
    expect(within(screen.getByTestId("pattern-sources")).getAllByTestId("source-tag").length).toBe(3);
    for (const t of tags()) expect(KNOWN).toContain(t);
  });
  it("the same tags are there in Mock", async () => {
    await mount(); await click("scenario-hold-and-retry"); await click("step-0");
    expect(tags().length).toBeGreaterThanOrEqual(12);
  });
});

describe("the Evaluate tab answers first, in Mock and in Live", () => {
  it("Mock: a scripted step denied at Action scope opens with the verdict and folds the layers after it", async () => {
    await mount(); await click("step-3"); // four-layers: the token lacks the scope
    expect(screen.getByTestId("verdict-headline")).toHaveTextContent(/^Denied at Action scope$/);
    expect(screen.getByTestId("verdict-next")).toHaveTextContent(/Add that scope to the token/);
    expect(screen.getByTestId("trace-unchecked")).toHaveTextContent(/^5 more layers not checked because an earlier one refused/);
    expect(screen.getByTestId("decision-code")).toHaveTextContent(/^scope_missing$/);
  });
  it("Mock: the Fail closed scenario's error step does not tell the reader to use a control Mock does not have", async () => {
    await mount(); await click("scenario-fail-closed"); await click("step-1");
    expect(screen.getByTestId("decision-code")).toHaveTextContent(/^evaluation_error$/);
    expect(screen.getByTestId("verdict-next")).toHaveTextContent(/Mock is read-only; to try the fix, switch to Live\. Set Lab fault to none/);
    expect(screen.queryByTestId("fault")).toBeNull(); // the control the advice names is not on the Mock page
  });
  it("Live: the same call, run for real, gives the same verdict, and a hold and an allow read the same way", async () => {
    await mount(); await live();
    await run("action");
    expect(screen.getByTestId("verdict-headline")).toHaveTextContent(/^Denied at Action scope$/);
    expect(within(screen.getByTestId("trace-action")).getByTestId("source-tag")).toHaveTextContent("deck claim");
    expect(screen.getByTestId("trace-action").querySelector(".check__body")).toHaveTextContent(/scope_missing/); // the code lives in the stopping layer's Detail, not on its row
    await run("hold");
    expect(screen.getByTestId("verdict-headline")).toHaveTextContent(/^Held at Attended and unattended$/);
    await run("allowed");
    expect(screen.getByTestId("verdict-headline")).toHaveTextContent(/^Allowed$/);
  });
});

describe("a stored workspace id the server refuses (N1)", () => {
  it("is replaced and the request retried once: the tab loads, the id changes, and Reset works", async () => {
    window.sessionStorage.setItem("aip.workspace", "a1b2c3d4e5f6a7b8c9d0e1f2"); // passes the browser's pattern, looks like a credential to the server
    await mount();
    expect(screen.queryByText(/Could not load the lab/)).toBeNull();
    expect(window.sessionStorage.getItem("aip.workspace")).toMatch(/^w-[0-9a-f]{16}$/);
    expect(workspaceId()).toBe(window.sessionStorage.getItem("aip.workspace"));
    const stateCalls = seen.filter((s) => s.url.includes("/api/state"));
    expect(stateCalls.length).toBeGreaterThanOrEqual(2); // the refused one and the retry
    await live(); await run("hold"); await click("reset");
    await waitFor(() => expect(screen.getByTestId("form-empty")).toBeInTheDocument(), T);
    expect(screen.queryByText(/Could not load the lab/)).toBeNull();
  });
  it("a refusal that is not bad_workspace is not retried", async () => {
    override = (u) => (u.includes("/api/info") ? new Response(JSON.stringify({ error: "bad_request" }), { status: 400, headers: { "content-type": "application/json" } }) : null);
    window.sessionStorage.setItem("aip.workspace", "w-aaaaaaaaaaaaaaaa"); const before = "w-aaaaaaaaaaaaaaaa";
    render(<App />); await waitFor(() => expect(seen.some((s) => s.url.includes("/api/info"))).toBe(true), T);
    expect(seen.filter((s) => s.url.includes("/api/info")).length).toBe(1);
    expect(window.sessionStorage.getItem("aip.workspace")).toBe(before);
  });
});

describe("diagram view at phone width (N2)", () => {
  it("fits every box: the narrow view has no node subset and can zoom out; the wide view is unchanged", () => {
    const narrow = fitOptions(true);
    expect(narrow.nodes).toBeUndefined(); expect(narrow.maxZoom).toBeUndefined(); expect(narrow.minZoom).toBeLessThanOrEqual(0.15);
    expect(fitOptions(false)).toEqual({ padding: 0.12 });
  });
});

describe("Real: the Privilege gateway card and What Privilege did", () => {
  const KEY = ["fake", "agent", "key"].join("-") + "Q".repeat(24);
  const gateway = () => http.createServer((req, res) => {
    let raw = ""; req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      if (req.method !== "POST") { res.writeHead(200).end(); return; }
      const m = JSON.parse(raw || "{}");
      const send = (status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
      if (m.method === "initialize") return send(200, { jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "stub-door" } } }, { "mcp-session-id": "sess-1234567890abcdef" });
      if (m.method === "notifications/initialized") { res.writeHead(202).end(); return; }
      if (m.method === "tools/list") return send(200, { jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "lookup", description: `echoes ${KEY}` }] } });
      return send(403, { error: "refused by policy" });
    });
  });
  const checks = () => seen.filter((x) => x.url.endsWith("/api/gateway-check")).length;
  const hopCalls = (gw) => seen.filter((x) => x.url.startsWith(`http://127.0.0.1:${gw.address().port}`)).length;

  it("Mock shows no gateway card and makes no gateway call; a direct check is refused 409", async () => {
    await mount();
    expect(screen.queryByTestId("privilege-check")).toBeNull();
    expect(screen.queryByTestId("gateway-hop")).toBeNull();
    expect(checks()).toBe(0);
    const r = await fetch(`${base}/api/gateway-check`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("mock_mode");
  });

  it("Real without gateway settings: the card says what is missing and offers no trace", async () => {
    await mount(); await live();
    const card = await screen.findByTestId("privilege-check", {}, T);
    await waitFor(() => expect(card).toHaveTextContent(/APL_GW_URL/), T);
    expect(screen.queryByTestId("gateway-trace-run")).toBeNull();
  });

  it("Real: the card runs one check, the button draws the real trace from that same answer (no second call), decisions observed or inferred, no key", async () => {
    const gw = gateway();
    await new Promise((r) => gw.listen(0, "127.0.0.1", r));
    const keep = ["APL_GW_URL", "APL_GW_APPS", "APL_GW_KEY_LAB"].map((k) => [k, process.env[k]]);
    Object.assign(process.env, { APL_GW_URL: `http://127.0.0.1:${gw.address().port}`, APL_GW_APPS: "door-a", APL_GW_KEY_LAB: KEY });
    // The server hop runs in this jsdom process, whose AbortSignal is not the one node's fetch accepts: the hop's timeout signal is dropped here only.
    const patched = globalThis.fetch;
    globalThis.fetch = (u, init) => patched(u, init?.signal ? { ...init, signal: undefined } : init);
    try {
      await mount();
      expect(screen.queryByTestId("privilege-check")).toBeNull();
      await live();
      const card = await screen.findByTestId("privilege-check", {}, T);
      await waitFor(() => expect(card).toHaveTextContent(/Refusal probe/), T);
      expect(checks()).toBe(1);
      const calls = hopCalls(gw);
      expect(calls).toBeGreaterThan(0);
      expect(within(screen.getByTestId("gateway-hop")).queryByTestId("gateway-trace")).toBeNull();
      await click("gateway-trace-run");
      const panel = await within(screen.getByTestId("gateway-hop")).findByTestId("gateway-trace", {}, T);
      expect(panel).toHaveTextContent(/tools\/list/);
      expect(panel).toHaveTextContent(/Refusal probe/);
      expect(panel).toHaveTextContent(/inferred from the outcome/);
      expect(panel).not.toHaveTextContent(/checked/i);
      expect(checks()).toBe(1);
      expect(hopCalls(gw)).toBe(calls);
      expect(document.body.textContent).not.toContain(KEY);
      await click("mode-select", "mock");
      await waitFor(() => expect(screen.queryByTestId("gateway-hop")).toBeNull(), T);
    } finally {
      globalThis.fetch = patched;
      for (const [k, v] of keep) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      await new Promise((r) => gw.close(r));
    }
  });
});

describe("Run observability (rule 27)", () => {
  const asked = () => seen.map((s) => s.url).filter((u) => /\/api\/run-observability/.test(u));
  const simulated = () => screen.getByTestId("ro-table").querySelectorAll('tr.ro-row[data-origin="simulated"]').length;
  const KEY = ["fake", "agent", "key"].join("-") + "Q".repeat(24);
  const gateway = () => http.createServer((req, res) => {
    let raw = ""; req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      if (req.method !== "POST") { res.writeHead(200).end(); return; }
      const m = JSON.parse(raw || "{}");
      const send = (status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
      if (m.method === "initialize") return send(200, { jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "stub-door" } } }, { "mcp-session-id": "sess-1234567890abcdef" });
      if (m.method === "notifications/initialized") { res.writeHead(202).end(); return; }
      if (m.method === "tools/list") return send(200, { jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "lookup", description: "a tool" }, { name: "search", description: "a tool" }] } });
      return send(403, { error: "refused by policy" });
    });
  });

  it("Mock: the panel under the five working tabs shows the recorded scenario's rows as simulated, follows the scenario, and is absent on the diagram and the talk track; it only ever reads", async () => {
    await mount();
    expect(await screen.findByTestId("run-observability", {}, T)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("ro-table")).toBeInTheDocument(), T);
    expect(screen.getByTestId("ro-basis")).toHaveTextContent(/Simulated/);
    expect(screen.getByTestId("ro-coverage-gateway")).toHaveTextContent("Simulated"); expect(screen.getByTestId("ro-coverage-authorize")).toHaveTextContent("Not logged"); expect(screen.getByTestId("ro-coverage-resource")).toHaveTextContent("Not logged");
    expect(simulated()).toBe(33);
    expect(asked()[0]).toMatch(/vertical=finance&scenario=four-layers/);
    await click("scenario-fail-closed");
    await waitFor(() => expect(asked().at(-1)).toMatch(/scenario=fail-closed/), T);
    await waitFor(() => expect(simulated()).toBe(19), T);
    for (const t of ["Policies", "Approvals", "Where it runs", "Fail closed"]) { await tab(t); expect(await screen.findByTestId("run-observability", {}, T)).toBeInTheDocument(); }
    await tab("Diagram"); expect(screen.queryByTestId("run-observability")).toBeNull();
    await tab("Talk track"); expect(screen.queryByTestId("run-observability")).toBeNull();
    expect(seen.filter((s) => /run-observability/.test(s.url) && s.body).length).toBe(0);
    await settle();
  });

  it("Real with no gateway configured: the card says what is missing, the panel says no run was made and shows no record, asks the server for nothing, and Mock brings the record back", async () => {
    await mount(); await live();
    const card = await screen.findByTestId("privilege-check", {}, T);
    await waitFor(() => expect(card).toHaveTextContent(/APL_GW_URL/), T);
    const alert = await screen.findByText(/did not complete, so there is no run to show/, {}, T);
    expect(alert).toHaveAttribute("role", "alert");
    expect(screen.queryByTestId("ro-table")).toBeNull();
    const before = asked().length;
    await settle();
    expect(asked().length).toBe(before);
    expect(before).toBe(1); // the Mock record asked for on page load; none in Real
    // choosing Real again (a stray change event) starts no new check, so it must not leave the panel waiting for one
    await pick("mode-select", "real"); await settle();
    expect(screen.getByText(/did not complete, so there is no run to show/)).toHaveAttribute("role", "alert"); expect(screen.queryByTestId("ro-loading")).toBeNull();
    await pick("mode-select", "mock");
    await waitFor(() => expect(screen.getByTestId("mode")).toHaveTextContent(/^Mock$/), T);
    await waitFor(() => expect(screen.getByTestId("ro-table")).toBeInTheDocument(), T);
    await settle(); // no request of this test is still in flight when the next one resets the counter
  });

  it("Real: the panel shows what the gateway check received as `response` rows, waits for the next check's run (never the old record), keeps it across a Live evaluation and Reset, and Mock is a Mock record", async () => {
    const gw = gateway();
    await new Promise((r) => gw.listen(0, "127.0.0.1", r));
    const keep = ["APL_GW_URL", "APL_GW_APPS", "APL_GW_KEY_LAB"].map((k) => [k, process.env[k]]);
    Object.assign(process.env, { APL_GW_URL: `http://127.0.0.1:${gw.address().port}`, APL_GW_APPS: "door-a", APL_GW_KEY_LAB: KEY });
    const patched = globalThis.fetch; // the hop's timeout signal is dropped in this jsdom process only (see the card test above)
    globalThis.fetch = (u, init) => patched(u, init?.signal ? { ...init, signal: undefined } : init);
    try {
      await mount(); await live();
      await waitFor(() => expect(screen.getByTestId("ro-table")).toBeInTheDocument(), T);
      const first = asked().at(-1);
      expect(first).toMatch(/runId=gw-[0-9a-f]{6}-\d+/);
      expect(screen.getByTestId("ro-basis")).toHaveTextContent(/Real:/);
      const origins = () => [...screen.getByTestId("ro-table").querySelectorAll("tr.ro-row")].map((r) => r.getAttribute("data-origin"));
      expect(origins().filter((o) => o === "response")).toHaveLength(2);
      expect(origins()).not.toContain("simulated"); expect(origins()).not.toContain("logged");
      expect(screen.getByTestId("ro-coverage-gateway")).toHaveTextContent(/Response/); expect(screen.getByTestId("ro-coverage-privilege")).toHaveTextContent("Not logged");
      expect(screen.getByTestId("ro-lab-note")).toHaveTextContent(/only the hop to the Privilege gateway/);
      // the panel holds neither the key nor the gateway's address (the card above it does show its own address: that is the card's, not the panel's)
      expect(document.body.textContent).not.toContain(KEY); expect(screen.getByTestId("run-observability").textContent).not.toContain("127.0.0.1");
      // a Live evaluation (the engine's own decisions) adds nothing to a Real record and asks nothing new
      await run("hold");
      const evalsAsked = asked().length;
      await settle();
      expect(asked().length).toBe(evalsAsked);
      expect(origins().filter((o) => o === "response")).toHaveLength(2);
      // pressing the card's button starts a new check: the panel shows loading at once, never the old record, then the new run
      expect(screen.getByTestId("gateway-trace-run")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: /Run the gateway check/ }));
      expect(screen.getByTestId("ro-loading")).toBeInTheDocument(); expect(screen.queryByTestId("ro-table")).toBeNull();
      expect(screen.queryByTestId("gateway-trace-run")).toBeNull(); // the last check's trace button is gone while the new check runs
      await waitFor(() => expect(screen.getByTestId("ro-table")).toBeInTheDocument(), T);
      const second = asked().at(-1);
      expect(second).not.toBe(first);
      // Reset clears the engine and leaves the gateway check record alone
      await click("reset");
      await settle();
      expect(screen.getByTestId("ro-table")).toBeInTheDocument(); expect(asked().at(-1)).toBe(second);
      // back to Mock: a Mock record, then Real again starts its own check
      await pick("mode-select", "mock");
      await waitFor(() => expect(screen.getByTestId("mode")).toHaveTextContent(/^Mock$/), T);
      await waitFor(() => expect(screen.getByTestId("ro-basis")).toHaveTextContent(/Simulated/), T);
      await live();
      await waitFor(() => expect(screen.getByTestId("ro-basis")).toHaveTextContent(/Real:/), T);
      await settle();
    } finally {
      globalThis.fetch = patched;
      for (const [k, v] of keep) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      await new Promise((r) => gw.close(r));
    }
  });
});
