import { visible } from "../safeText";
import { ClaimTag, Json, SourceTag, StatusTag } from "./Bits";
import { SOURCE_NOTE, STAGE_SOURCE } from "../sources";
import { STAGE_NAME, notCheckedBecause, verdictFor } from "../verdictText";

// How each layer's verdict reads on its one line. The mark is drawn (not a glyph) and always sits beside a word, so the outcome never rests on colour.
const WORD = { pass: "Passed", deny: "Denied", hold: "Held", refuse: "Refused", withhold: "Withheld", "not-reached": "Not checked" };
const STATE = { pass: "ok", hold: "warn", "not-reached": "none" }; // anything else that stopped the call is "bad"
const stateOf = (v) => STATE[v] || "bad";
const STOPS = new Set(["deny", "hold", "refuse", "withhold"]);
const KIND_STATE = { allow: "ok", hold: "warn", deny: "bad", withhold: "bad" };
const NEXT_LABEL = { allow: "Next", hold: "What happens next", deny: "What would make it pass", withhold: "What would release the result" };

// A drawn mark per verdict: a tick, a cross, a pause, a bar for the result held back, a dash for not checked.
function Mark({ v, big }) {
  const size = big ? 22 : 16;
  const g = { pass: <path d="M3.5 8.5l3 3 6-7" />, deny: <path d="M4 4l8 8M12 4l-8 8" />, refuse: <path d="M4 4l8 8M12 4l-8 8" />, hold: <path d="M6 3.5v9M10 3.5v9" />, withhold: <path d="M3.5 8h9M3.5 4.5h9M3.5 11.5h5" />, "not-reached": <path d="M4 8h8" /> };
  return (
    <svg className="mark" viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{g[v] || g.deny}</svg>
  );
}
const Chevron = () => <svg className="check__chev" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M6 3.5l4.5 4.5L6 12.5" /></svg>;

// One layer, one compact line: mark, name, outcome word. The line that stopped the call also shows its code and the engine's own short reason (stronger edge,
// heavier weight). Everything else is in the Detail: where the layer comes from (the source tag), what the engine said, and the decoded detail.
function Layer({ t, stop }) {
  const src = STAGE_SOURCE[t.stage] || "invented";
  const name = STAGE_NAME[t.stage] || String(t.title || t.stage).replace(/^\d+\.\s*/, "");
  const state = stateOf(t.verdict);
  return (
    <li className="check" data-state={state} data-stop={stop ? "true" : undefined} data-testid={`trace-${t.stage}`} data-verdict={t.verdict}>
      <details>
        <summary>
          <Mark v={t.verdict} />
          <span className="check__name">{name}</span>
          <span className="check__word">{WORD[t.verdict] || t.verdict}</span>
          <span className="check__more">Detail<Chevron /></span>
          {stop && (t.code || t.reason) ? <span className="check__why">{t.code ? <code className="check__code">{t.code}</code> : null}{t.reason ? visible(t.reason) : null}</span> : null}
        </summary>
        <div className="check__body">
          <p className="check__src">Where this layer comes from: <SourceTag source={src} /> <span className="muted">{SOURCE_NOTE[src]}</span></p>
          {!stop && t.verdict !== "not-reached" && t.reason ? <p className="check__reason">{visible(t.reason)}</p> : null}
          {t.detail ? <Json value={t.detail} label={`${t.stage} detail`} hot={["effective", "required", "lacking", "user", "matchedRules", "approval"]} /> : null}
        </div>
      </details>
    </li>
  );
}

// The checklist: the layers that ran, one line each, then every layer after the stopping one folded into a single line (each still listed inside).
function Checklist({ d }) {
  const ran = d.trace.filter((t) => t.verdict !== "not-reached");
  const skipped = d.trace.filter((t) => t.verdict === "not-reached");
  const stopStage = (ran.find((t) => STOPS.has(t.verdict)) || {}).stage;
  const n = skipped.length;
  const tally = [["pass", "passed"], ["deny", "denied"], ["hold", "held"], ["refuse", "refused"], ["withhold", "withheld"], ["not-reached", "not checked"]]
    .map(([v, w]) => [d.trace.filter((t) => t.verdict === v).length, w]).filter(([c]) => c > 0).map(([c, w]) => `${c} ${w}`).join(", ");
  return (
    <>
      <h3 className="panel__sub">What the lab checked, in order</h3>
      <p className="muted" data-testid="trace-summary">{tally}</p>
      <ol className="checks" data-testid="trace">
        {ran.map((t) => <Layer key={t.stage} t={t} stop={t.stage === stopStage} />)}
        {n ? (
          <li className="check check--group" data-state="none" data-testid="trace-unchecked">
            <details>
              <summary>
                <Mark v="not-reached" />
                <span className="check__name">{n} more layer{n === 1 ? "" : "s"} not checked because {notCheckedBecause(d)}</span>
                <span className="check__more">Show<Chevron /></span>
              </summary>
              <ol className="checks checks--inner">{skipped.map((t) => <Layer key={t.stage} t={t} />)}</ol>
            </details>
          </li>
        ) : null}
      </ol>
    </>
  );
}

// The answer, first: allowed, held or denied, where, why, and what would make it pass or what happens next. The code is small supporting detail.
function Verdict({ d }) {
  const v = verdictFor(d);
  return (
    <div className="verdict" data-testid="verdict" data-outcome={d.outcome} data-state={KIND_STATE[v.outcome] || "bad"}>
      <p className="verdict__head" data-testid="verdict-headline"><Mark v={v.outcome === "allow" ? "pass" : v.outcome} big />{v.headline}</p>
      <p className="verdict__why" data-testid="verdict-why">{v.why}</p>
      <p className="verdict__next" data-testid="verdict-next"><strong>{NEXT_LABEL[v.outcome]}:</strong> {v.next}</p>
      <p className="verdict__code muted">The lab's code for this: <code data-testid="decision-code">{d.code}</code> &middot; Source of the three outcomes: <SourceTag source="deck" /></p>
    </div>
  );
}

// The decision for one evaluation: the answer, what was returned, and one compact line per layer in order.
export default function Decision({ decision, caption }) {
  if (!decision) return <p className="muted" data-testid="no-decision">No call evaluated yet.</p>;
  const d = decision.result || decision;
  const http = decision.http ?? d.http;
  return (
    <section className="panel" data-testid="decision" data-outcome={d.outcome} aria-label="Decision">
      <h2 className="panel__title">{caption || "Decision"} <StatusTag status={d.outcome} /> <span className="chip" data-testid="decision-http">HTTP {http}</span> <ClaimTag /></h2>
      <Verdict d={d} />
      <p className="muted">
        {d.proceeded ? "The call was made. " : "The call was not made. "}
        {d.resultReleased ? "The result was released." : d.proceeded ? "The result was withheld." : ""}
        {d.failedClosed ? " The evaluation failed closed." : ""}
        {d.noApprovalPath ? " No approval can lift this." : ""}
      </p>
      {d.approval ? (
        <div className="panel" data-state="warn" data-testid="approval-box">
          <h3 className="panel__sub">Nothing is held open: the request was refused now, with a reference and an owning expiry</h3>
          <p>Reference <code data-testid="approval-ref">{d.approval.ref}</code>{d.approval.reused ? " (the same request as before: nothing new was opened)" : ""}. Expires <code data-testid="approval-expiry">{d.approval.expiresAt}</code>.</p>
          <p className="muted">Bound to {d.approval.bound.kind === "call" ? <>the exact call (hash <code>{d.approval.bound.callHash.slice(0, 16)}...</code>), single-use</> : <>a fixed period of {d.approval.bound.windowMin} minutes from the last signature</>}. {d.approval.approvers} approver{d.approval.approvers === 1 ? "" : "s"} with {d.approval.roles.join(" or ")}, at least authentication level {d.approval.minAuthLevel}; sent by {d.approval.channel} (simulated outbox). Signatures so far: {d.approval.signatures}. Sign it on the Approvals tab, then call again.</p>
        </div>
      ) : null}
      {d.grantUsed ? <p data-testid="grant-used">Approval <code>{d.grantUsed.ref}</code> applied as an input to this evaluation ({d.grantUsed.binding === "call" ? "single-use, now spent" : `a period, used ${d.grantUsed.uses} time(s)`}).</p> : null}
      {d.callHash ? <p className="muted">Method <code>{d.method}</code>, target <code>{d.target}</code>, call hash <code data-testid="call-hash">{d.callHash}</code> <SourceTag source="invented" /></p> : null}
      {d.canonical ? <details><summary>Canonical form that was hashed</summary><Json value={d.canonical} label="canonical form" hot={["method", "target"]} /><p className="muted exact">Exact text that was hashed: <code>{visible(d.canonical)}</code></p></details> : null}
      {d.ignoredHints?.length ? <p className="muted" data-testid="ignored-hints">Ignored, because scope and identity are read from the verified token only: {d.ignoredHints.map((h) => `${h.where} naming ${h.matched}`).join(", ")}.</p> : null}
      {d.findings?.length ? <p className="muted" data-testid="findings">Findings: {d.findings.map((f) => `${f.kind} on the ${f.stage}`).join(", ")}. <SourceTag source="invented" /></p> : null}
      {d.reply ? <p className="muted">Result released: <code>{visible(d.reply)}</code></p> : null}
      <Checklist d={d} />
      {d.tokenSummary ? <details><summary>Verified token (header and claims; a lab-minted token) <SourceTag source="invented" /></summary><Json value={d.tokenSummary} label="token summary" hot={["surfaces", "end_user"]} /></details> : null}
    </section>
  );
}
