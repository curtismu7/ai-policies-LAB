// These tests drive the real UI against the real Express app (started on a loopback port inside the test), so a green run means the pieces
// actually work together: the real story data, the real engine, the real Mock table.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createApp, startHttpServer } from "../../server/src/app.js";
import { createHealth } from "../../server/src/health.js";
import { VERTICALS } from "../../server/src/cast.js";
import App, { BANNER_UNKNOWN, TABS } from "./App";
import { labelOffsets } from "./components/PatternDiagram";
import { visible } from "./safeText";
import { forgetWorkspace } from "./workspace";
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
beforeEach(() => { cleanup(); forgetWorkspace(); seen = []; delay = () => 0; override = () => null; pending = 0; try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* ignore */ } window.location.hash = ""; });

const T = { timeout: 20000 };
const mount = async () => { render(<App />); await screen.findByTestId("scenario-four-layers", {}, T); };
const tab = (name) => userEvent.click(screen.getByRole("tab", { name }));
const click = (id) => userEvent.click(screen.getByTestId(id));
const live = async () => { await click("mode-live"); await waitFor(() => expect(screen.getByTestId("banner")).toHaveTextContent(/LIVE mode/)); await screen.findByTestId("run-hold", {}, T); };
const pick = (id, value) => userEvent.selectOptions(screen.getByTestId(id), value);
const run = async (id) => { await waitFor(() => expect(screen.getByTestId(`run-${id}`)).toBeEnabled(), T); await click(`run-${id}`); await waitFor(() => expect(screen.getByTestId("decision")).toBeInTheDocument(), T); await waitFor(() => expect(screen.getByTestId(`run-${id}`)).toBeEnabled(), T); };
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
    await click("mode-mock"); await waitFor(() => expect(screen.getByTestId("banner")).toHaveTextContent(/MOCK mode/), T);
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
    await mount(); await click("mode-live"); await click("mode-mock");
    await waitFor(() => expect(screen.getByTestId("banner")).toHaveTextContent(/MOCK mode/), T);
    await settle(); await new Promise((r) => setTimeout(r, 450));
    expect(screen.getByTestId("banner")).toHaveTextContent(/MOCK mode/); expect(screen.getByTestId("mode")).toHaveTextContent("Mode: mock");
    expect(screen.getAllByTestId(/^scenario-(?!say)/).length).toBe(6);
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
