// Rule 27: the shared run-observability panel for this lab, with the lab's own states around it.
// Mock: the recorded scenario's record (the events the engine decided when the table was generated).
// Real: what the lab received on the page's own gateway check (the card above), asked for by that check's run id. A check that never reached the gateway
// made no run, so the panel says so and never shows an older record. Nothing is re-read on a timer: this lab reads no logs, so a re-read could find nothing new.
import { useEffect, useState } from "react";
import RunObservability from "../run-observability/RunObservability.jsx";

// Where this lab's run leaves logs and where they can stream (the README says the same).
export const LOG_STREAMS = [
  { product: "AI Policies LAB (this lab's container)", lives: "its stdout. In Live, one line per decision the engine makes (each policy layer the call reached, the credential check, the person the call acts for, an approver's answer) and one per answer received from the Privilege gateway in Real: the agent's name, a step, a result, the lab clock as labtime and a run id, never a token, an argument, an agent key or a gateway address. Mock reads recorded tables and writes none", streams: "nowhere today: the family log collector's source list does not name this container, so it would need an entry first. The SIEM time would then be Docker's wall-clock time for the line; the lab clock stays inside the line as labtime" },
  { product: "Privilege agent gateway (Real)", lives: "its own log (a log volume for a local gateway; the SIEM index for the hosted one)", streams: "the Privilege SIEM export. This lab does not read it, so the Real record holds only what the lab received" },
];

const TITLE = "What each layer logged for this run";
const Note = ({ testId, role, children }) => (
  <div className="obs">
    <section className="ro" data-testid={testId} aria-label={TITLE}>
      <h2>{TITLE}</h2>
      <p className="ro-muted" role={role}>{children}</p>
    </section>
  </div>
);

const NOTE = {
  mock: "Times are the lab clock: it starts at 2026-11-02 09:00 UTC and moves only when a scenario moves it, so the steps of one scenario can share a time (their order is kept, and each message names its step). These are decisions the lab's own engine recorded when the table was made, not read from any product log. A count is rows, not calls: one evaluation is several rows (the credential check, the person, each policy layer it reached, the gateway's answer). Person is a name inside a token the lab minted, or an approver name typed on the page: the lab has no sign-in. Agent is the lab checking a token it minted itself: there is no OBO exchange. Privilege holds the lab's own policy engine (the four scope checks, holds, approvals and inspection; Ping release claims, UNVERIFIED on our tenant), not PingOne Privilege. Agent gateway is the lab's simulated gateway: its answer restates the decision above, so it is information, and a credential it turns away is its own row. There is no tool server, so the simulated call and its reply have no row, and PingOne Authorize is not called.",
  real: "Real is only the hop to the Privilege gateway: each row is a reply the lab received, not a log line. The lab's own engine (evaluations, approvals, the clock, policy edits) is the same engine in Real too: its decisions are on the Evaluate tab's \"What Privilege did\" (simulated) and are written to the lab's stdout, not shown here, and none of those actions changes this record: only \"Run the gateway check\" does. Reset clears the engine and leaves this record alone. No person signs in for this call and there is no OBO token: the caller is an agent access key. The key and the gateway address are never part of a row.",
};

// null = a request is needed; otherwise what to show instead (nothing is fetched and no older record is shown).
function waiting(real, check, scenarioId) {
  if (real) {
    if (check.phase === "done") return check.runId ? null : { id: "ro-no-run", role: "alert", text: "The gateway check ran, but the lab did not keep a record of it (the server log says why)." };
    if (check.phase === "error") return { id: "ro-no-run", role: "alert", text: `The gateway check did not complete, so there is no run to show (and no older one is shown in its place). ${check.reason || ""}`.trim() };
    return { id: "ro-loading", text: "Collecting this run's logs…" };
  }
  return scenarioId ? null : { id: "ro-loading", text: "Collecting this run's logs…" };
}

// What the route may answer with 200: { record: null, message } (no run yet) or { record } holding a run record (rows) or the lab's own { error, message }. Anything else
// (an HTML page, null, an empty body, a list, a bare string, {} or a record that is none of those) is not a record and is shown as an alert.
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const answers = (b) => isObject(b) && "record" in b && (b.record === null || (isObject(b.record) && (Array.isArray(b.record.rows) || typeof b.record.error === "string")));

export default function RunObs({ source, vertical, scenarioId, check }) {
  const real = source === "real";
  const wait = waiting(real, check || { phase: "checking" }, scenarioId);
  const key = real ? `real|${check?.runId}` : `mock|${vertical}|${scenarioId}`;
  const [answer, setAnswer] = useState(null); // { key, record, message }: the answer to the request for `key`
  const url = real ? `/api/run-observability?runId=${encodeURIComponent(check?.runId ?? "")}` : `/api/run-observability?vertical=${encodeURIComponent(vertical)}&scenario=${encodeURIComponent(scenarioId ?? "")}`;
  useEffect(() => {
    if (wait) return undefined;
    let live = true;
    const done = (a) => { if (live) setAnswer({ key, ...a }); };
    fetch(url, { headers: { accept: "application/json" } }).then(
      async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok) return done({ record: { error: body?.error || `http_${r.status}`, message: body?.message || `The lab answered ${r.status}.` } });
        if (answers(body)) return done({ record: body.record, message: body.message });
        return done({ record: { error: "bad_answer", message: "The lab's answer was not a run record." } });
      },
      (e) => done({ record: { error: "unreachable", message: `Could not reach the lab (${String(e?.message || e).slice(0, 120)}).` } }),
    ).catch((e) => done({ record: { error: "bad_answer", message: `The lab's answer could not be read (${String(e?.name || "error").slice(0, 40)}).` } }));
    return () => { live = false; };
  }, [key, url, wait === null]); // eslint-disable-line react-hooks/exhaustive-deps -- a new run, scenario or mode asks again; nothing else does

  if (wait) return <Note testId={wait.id} role={wait.role}>{wait.text}</Note>;
  if (!answer || answer.key !== key) return <Note testId="ro-loading">Collecting this run's logs…</Note>; // never the previous record
  if (answer.record === null) return <Note testId="ro-no-run">{answer.message || "There is no run to show."}</Note>;
  return (
    <div className="obs">
      <RunObservability record={answer.record} source={source} streams={LOG_STREAMS} />
      <p className="ro-muted" data-testid="ro-lab-note">{NOTE[real ? "real" : "mock"]}</p>
    </div>
  );
}
