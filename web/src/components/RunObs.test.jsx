// The lab's own states around the shared panel: loading (never the previous record), empty, an alert for any answer that is not a record, the mode
// the record was made in, and no request when nothing changed. fetch is replaced by a script; the real route is exercised by the server tests and App.test.jsx.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import RunObs from "./RunObs";
import { setJsonView } from "./JsonPane.jsx";
import { mockRecord, realRecord } from "../run-observability/fixtures";

const realFetch = globalThis.fetch;
let calls = [];
let answers = {};
const ok = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
beforeEach(() => {
  setJsonView("raw"); calls = []; answers = {};
  globalThis.fetch = vi.fn(async (url) => {
    calls.push(String(url));
    const a = answers[String(url)] ?? answers["*"];
    if (typeof a === "function") return a();
    if (a instanceof Error) throw a;
    return a ?? ok({ record: null, message: "no answer scripted" });
  });
});
afterEach(() => { cleanup(); globalThis.fetch = realFetch; });

const MOCK_URL = "/api/run-observability?vertical=finance&scenario=four-layers";
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
const mockPanel = (props = {}) => <RunObs source="mock" vertical="finance" scenarioId="four-layers" check={{ phase: "checking" }} {...props} />;
const realPanel = (check) => <RunObs source="real" vertical="finance" scenarioId={undefined} check={check} />;

describe("Mock", () => {
  it("shows the panel for the recorded scenario, says what the lanes hold, and asks once", async () => {
    answers[MOCK_URL] = ok({ record: mockRecord });
    const { rerender } = render(mockPanel());
    expect(screen.getByTestId("ro-loading")).toHaveTextContent("Collecting this run's logs");
    await screen.findByTestId("run-observability");
    expect(screen.getByTestId("ro-basis")).toHaveTextContent(/Simulated/);
    expect(screen.getByTestId("ro-lab-note")).toHaveTextContent(/lab clock.*each message names its step.*A count is rows, not calls.*lab has no sign-in.*no OBO exchange.*lab's own policy engine.*not PingOne Privilege.*restates the decision above.*no tool server/s);
    expect(screen.getByTestId("ro-streams")).toHaveTextContent(/Mock reads recorded tables and writes none/);
    expect(screen.queryByText(/Re-read/)).toBeNull();
    // a re-render with the same run (a state refresh, a gateway check finishing in Real's card) asks nothing new
    rerender(mockPanel({ check: { phase: "done", runId: "gw-1" } }));
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toEqual([MOCK_URL]);
  });

  it("waits for the scenario instead of asking for none, and never shows the previous scenario while the next one loads (a slow answer for the second)", async () => {
    answers[MOCK_URL] = ok({ record: mockRecord });
    const second = gate();
    answers["/api/run-observability?vertical=finance&scenario=hold-and-retry"] = () => second.p.then(() => ok({ record: { ...mockRecord, runId: "table-finance-hold-and-retry" } }));
    const { rerender } = render(mockPanel({ scenarioId: undefined }));
    expect(screen.getByTestId("ro-loading")).toBeInTheDocument(); expect(calls).toEqual([]);
    rerender(mockPanel());
    await screen.findByTestId("run-observability");
    rerender(mockPanel({ scenarioId: "hold-and-retry" }));
    expect(screen.getByTestId("ro-loading")).toBeInTheDocument(); expect(screen.queryByTestId("run-observability")).toBeNull();
    await new Promise((r) => setTimeout(r, 2500)); // the answer is slow: the first scenario's record never comes back in its place
    expect(screen.getByTestId("ro-loading")).toBeInTheDocument(); expect(screen.queryByTestId("run-observability")).toBeNull();
    second.open();
    await screen.findByTestId("run-observability");
    expect(calls).toHaveLength(2);
  }, 15000);

  it("a vertical change asks again and shows loading, not the other vertical's record", async () => {
    answers[MOCK_URL] = ok({ record: mockRecord });
    const next = gate();
    answers["/api/run-observability?vertical=health&scenario=four-layers"] = () => next.p.then(() => ok({ record: { ...mockRecord, runId: "table-health-four-layers" } }));
    const { rerender } = render(mockPanel());
    await screen.findByTestId("run-observability");
    rerender(mockPanel({ vertical: "health" }));
    expect(screen.getByTestId("ro-loading")).toBeInTheDocument(); expect(screen.queryByTestId("run-observability")).toBeNull();
    next.open();
    await screen.findByTestId("run-observability");
  });

  it("an answer that is not a record is an alert, whatever shape it has: an HTTP error, HTML in a 200, null, an empty body, a list, a bare string, {} or a record with no rows; and an unreachable lab", async () => {
    const html = { ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } };
    for (const [a, text] of [
      [ok({ error: "unknown_scenario", message: "there is no such scenario in this pack" }, 404), /there is no such scenario in this pack/],
      [{ ok: false, status: 502, json: async () => { throw new Error("html"); } }, /The lab answered 502/],
      [html, /not a run record/],
      [ok(null), /not a run record/],
      [{ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected end of JSON input"); } }, /not a run record/],
      [ok([]), /not a run record/],
      [ok("a bare string"), /not a run record/],
      [ok({}), /not a run record/],
      [ok({ record: {} }), /not a run record/],
      [ok({ record: "text" }), /not a run record/],
      [ok({ record: [] }), /not a run record/],
      [new TypeError("fetch failed"), /Could not reach the lab \(fetch failed\)/],
    ]) {
      answers[MOCK_URL] = a;
      const { unmount } = render(mockPanel());
      expect(await screen.findByRole("alert")).toHaveTextContent(text);
      expect(screen.queryByTestId("ro-table")).toBeNull(); expect(screen.queryByTestId("ro-loading")).toBeNull(); expect(screen.queryByTestId("ro-empty")).toBeNull();
      unmount();
    }
  });

  it("a record made in the other mode is refused on screen (the server's mode and the page's differ)", async () => {
    answers[MOCK_URL] = ok({ record: realRecord });
    render(mockPanel());
    expect(await screen.findByTestId("ro-mismatch")).toHaveTextContent(/real mode but the page is in mock mode/);
  });
});

describe("Real", () => {
  it("waits for the page's gateway check: nothing is asked and nothing older is shown while it runs", async () => {
    render(realPanel({ phase: "checking" }));
    expect(screen.getByTestId("ro-loading")).toHaveTextContent("Collecting this run's logs");
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toEqual([]);
  });

  it("asks for THAT check's run, shows it as real, and shows loading (not the old record) when the next check has a new run id", async () => {
    answers["/api/run-observability?runId=gw-1"] = ok({ record: { ...realRecord, runId: "gw-1" } });
    const next = gate();
    answers["/api/run-observability?runId=gw-2"] = () => next.p.then(() => ok({ record: { ...realRecord, runId: "gw-2" } }));
    const { rerender } = render(realPanel({ phase: "done", runId: "gw-1" }));
    await screen.findByTestId("run-observability");
    expect(screen.getByTestId("ro-basis")).toHaveTextContent(/Real:/);
    expect(screen.getByTestId("ro-lab-note")).toHaveTextContent(/only the hop to the Privilege gateway.*not a log line.*none of those actions changes this record: only "Run the gateway check" does.*Reset clears the engine and leaves this record alone/s);
    rerender(realPanel({ phase: "checking" }));
    expect(screen.getByTestId("ro-loading")).toBeInTheDocument(); expect(screen.queryByTestId("run-observability")).toBeNull();
    rerender(realPanel({ phase: "done", runId: "gw-2" }));
    expect(screen.getByTestId("ro-loading")).toBeInTheDocument(); expect(screen.queryByTestId("run-observability")).toBeNull();
    await new Promise((r) => setTimeout(r, 2500));
    expect(screen.getByTestId("ro-loading")).toBeInTheDocument(); expect(screen.queryByTestId("run-observability")).toBeNull();
    next.open();
    await screen.findByTestId("run-observability");
    expect(calls).toEqual(["/api/run-observability?runId=gw-1", "/api/run-observability?runId=gw-2"]);
  }, 15000);

  it("a check that never reached the gateway made no run: it says so, asks nothing, and shows no older record", async () => {
    answers["/api/run-observability?runId=gw-1"] = ok({ record: { ...realRecord, runId: "gw-1" } });
    const { rerender } = render(realPanel({ phase: "done", runId: "gw-1" }));
    await screen.findByTestId("run-observability");
    rerender(realPanel({ phase: "error", reason: "Set APL_GW_URL, APL_GW_APPS and at least one APL_GW_KEY_<NAME> in the shared settings file." }));
    expect(screen.getByRole("alert")).toHaveTextContent(/did not complete.*no older one is shown in its place.*APL_GW_URL/s);
    expect(screen.queryByTestId("run-observability")).toBeNull();
    rerender(realPanel({ phase: "done", runId: null }));
    expect(screen.getByRole("alert")).toHaveTextContent(/did not keep a record/);
    expect(calls).toHaveLength(1);
  });

  it("a run the lab no longer keeps is a note, not a record", async () => {
    answers["/api/run-observability?runId=gw-9"] = ok({ record: null, message: "That gateway check is no longer kept (the lab keeps the last few)." });
    render(realPanel({ phase: "done", runId: "gw-9" }));
    expect(await screen.findByTestId("ro-no-run")).toHaveTextContent(/no longer kept/);
    await waitFor(() => expect(calls).toHaveLength(1));
  });
});
