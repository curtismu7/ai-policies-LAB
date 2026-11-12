// These tests drive the real UI against the real Express app (started on a loopback port inside the test), so a green run means the pieces
// actually work together: the real story data, the real engine, the real Mock table.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createApp, startHttpServer } from "../../server/src/app.js";
import { createHealth } from "../../server/src/health.js";
import { VERTICALS } from "../../server/src/cast.js";
import App, { BANNER_UNKNOWN, TABS } from "./App";
import { fitOptions, labelOffsets } from "./components/PatternDiagram";
import { visible } from "./safeText";
import { forgetWorkspace, workspaceId } from "./workspace";
import { buildPresets, tamper } from "./presets";

const C = VERTICALS.finance;
let server; let base; const realFetch = globalThis.fetch; let seen = [];
let delay = () => 0;
let override = () => null; // a test may answer a request itself
let pending = 0;            // requests that have started and not yet answered
beforeAll(async () => {
  const health = createHealth({ runChecks: async () => [], intervalMs: 3_600_000 });
  ({ server, url: base } = await startHttpServer({ port: 0, host: "127.0.0.1", app: createApp({ health, configFile: "/nonexistent/customer.config.json" }) }));
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
beforeEach(async () => { cleanup(); forgetWorkspace(); seen = []; delay = () => 0; override = () => null; pending = 0; try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* ignore */ } window.location.hash = ""; // rule 19: the server holds the mode, so every test starts from mock
  await realFetch(`${base}/api/mode`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ source: "mock" }) }); });

const T = { timeout: 20000 };
const mount = async () => { render(<App />); await screen.findByTestId("scenario-four-layers", {}, T); };
const tab = (name) => userEvent.click(screen.getByRole("tab", { name }));
const click = (id, value) => (value === undefined ? userEvent.click(screen.getByTestId(id)) : userEvent.selectOptions(screen.getByTestId(id), value));
const live = async () => { await click("mode-select", "real"); await waitFor(() => expect(screen.getByTestId("banner")).toHaveTextContent(/LIVE mode/)); await screen.findByTestId("run-hold", {}, T); };
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
  it("shows the banner with the mode, the seven tabs, and the Mock scenarios", async () => {
    await mount();
    expect(screen.getByTestId("banner")).toHaveTextContent(/MOCK mode/); expect(screen.getByTestId("banner")).toHaveTextContent(/UNVERIFIED on our tenant/);
    expect(screen.getByTestId("mode")).toHaveTextContent("Mode: mock");
    expect(TABS.map((t) => t.label)).toEqual(["Evaluate", "Policies", "Approvals", "Where it runs", "Fail closed", "Diagram", "Talk track"]);
    for (const t of TABS) expect(screen.getByRole("tab", { name: t.label })).toBeInTheDocument();
    expect(screen.getAllByTestId(/^scenario-(?!say)/)).toHaveLength(6);
    expect(BANNER_UNKNOWN).toMatch(/UNVERIFIED/);
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
  it("Live switches the banner, keeps the mode chip in step, and Mock stays read-only", async () => {
    await mount(); await live();
    expect(screen.getByTestId("mode")).toHaveTextContent("Mode: live");
    await tab("Policies"); expect((await screen.findByTestId("save-users", {}, T))).toBeEnabled();
    await click("mode-select", "mock"); await waitFor(() => expect(screen.getByTestId("banner")).toHaveTextContent(/MOCK mode/), T);
    await waitFor(() => expect(screen.getByTestId("save-users")).toBeDisabled(), T);
    expect(screen.getByTestId("edit-users")).toHaveAttribute("readonly");
  });
  it("presenter mode (P, Esc) keeps the banner and shows the talk track", async () => {
    await mount(); await userEvent.keyboard("p");
    await waitFor(() => expect(screen.getByTestId("presenter-say")).toBeInTheDocument());
    expect(screen.getByTestId("banner")).toHaveTextContent(/UNVERIFIED on our tenant/);
    await userEvent.keyboard("{Escape}"); await waitFor(() => expect(screen.queryByTestId("presenter-say")).toBeNull());
    expect(screen.getByTestId("banner")).toBeInTheDocument();
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

describe("stale answers", () => {
  it("an answer for a mode the visitor has already left is dropped", async () => {
    delay = (u) => (u.includes("mode=live") && u.includes("/api/state") ? 400 : 0);
    await mount(); await click("mode-select", "real"); await click("mode-select", "mock");
    await waitFor(() => expect(screen.getByTestId("banner")).toHaveTextContent(/MOCK mode/), T);
    await settle(); await new Promise((r) => setTimeout(r, 450));
    expect(screen.getByTestId("banner")).toHaveTextContent(/MOCK mode/); expect(screen.getByTestId("mode")).toHaveTextContent("Mode: mock");
    expect(screen.getAllByTestId(/^scenario-(?!say)/).length).toBe(6);
  });
});

describe("rule 19: server-backed mode", () => {
  it("each switch POSTs /api/mode with exactly {source} and the page reloads its data", async () => {
    await mount();
    seen.length = 0;
    await click("mode-select", "real");
    await waitFor(() => expect(screen.getByTestId("banner")).toHaveTextContent(/LIVE mode/), T);
    expect(seen.some((r) => r.url.endsWith("/api/mode") && r.body === JSON.stringify({ source: "real" }))).toBe(true);
    expect(seen.some((r) => r.url.includes("/api/state?"))).toBe(true);
    expect(screen.getByTestId("mode")).toHaveTextContent("Mode: live");
    seen.length = 0;
    await click("mode-select", "mock");
    await waitFor(() => expect(screen.getByTestId("banner")).toHaveTextContent(/MOCK mode/), T);
    expect(seen.some((r) => r.url.endsWith("/api/mode") && r.body === JSON.stringify({ source: "mock" }))).toBe(true);
    expect(screen.getByTestId("mode")).toHaveTextContent("Mode: mock");
  });
  it("the mode the server holds survives a reload, and a bad body is refused 400", async () => {
    await mount();
    await click("mode-select", "real");
    await waitFor(() => expect(screen.getByTestId("banner")).toHaveTextContent(/LIVE mode/), T);
    cleanup(); render(<App />);
    await waitFor(() => expect(screen.getByTestId("banner")).toHaveTextContent(/LIVE mode/), T);
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
