import { visible } from "../safeText";
import { ClaimTag, Json, SourceTag, StatusTag } from "./Bits";
import { STAGE_SOURCE } from "../sources";

const word = (s) => (s === "not-reached" ? "not reached" : s);

// One layer of the trace: the stage, its verdict, the code and the reason, and the detail the engine shows (decoded, never a typed value).
function Step({ t }) {
  const bad = ["deny", "hold", "refuse", "withhold"].includes(t.verdict);
  return (
    <li className="trace__step" data-state={t.verdict === "pass" ? "ok" : t.verdict === "not-reached" ? "none" : "bad"} data-testid={`trace-${t.stage}`} data-verdict={t.verdict}>
      <div className="trace__head"><strong>{t.title}</strong> <SourceTag source={STAGE_SOURCE[t.stage] || "invented"} /> <span className="tag" data-state={t.verdict === "pass" ? "ok" : t.verdict === "not-reached" ? "none" : "bad"}>{word(t.verdict)}</span>{bad && t.code ? <code> {t.code}</code> : null}</div>
      {t.reason ? <p className="trace__reason">{visible(t.reason)}</p> : null}
      {t.detail ? <details><summary>Detail</summary><Json value={t.detail} label={`${t.stage} detail`} /></details> : null}
    </li>
  );
}

// The decision for one evaluation: what stopped it, why, what was returned, and every layer's verdict in order.
export default function Decision({ decision, caption }) {
  if (!decision) return <p className="muted" data-testid="no-decision">No call evaluated yet.</p>;
  const d = decision.result || decision;
  const http = decision.http ?? d.http;
  return (
    <section className="panel" data-testid="decision" data-outcome={d.outcome} aria-label="Decision">
      <h2 className="panel__title">{caption || "Decision"} <StatusTag status={d.outcome} /> <SourceTag source="deck" /> <span className="chip" data-testid="decision-http">HTTP {http}</span> <ClaimTag /></h2>
      <p data-testid="decision-reason"><strong data-testid="decision-code">{d.code}</strong>: {visible(d.reason || "")}</p>
      <p className="muted">
        {d.stage ? <>Stopped at: <strong>{d.stage}</strong>. </> : null}
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
      {d.canonical ? <details><summary>Canonical form that was hashed</summary><Json value={d.canonical} label="canonical form" /></details> : null}
      {d.ignoredHints?.length ? <p className="muted" data-testid="ignored-hints">Ignored, because scope and identity are read from the verified token only: {d.ignoredHints.map((h) => `${h.where} naming ${h.matched}`).join(", ")}.</p> : null}
      {d.findings?.length ? <p className="muted" data-testid="findings">Findings: {d.findings.map((f) => `${f.kind} on the ${f.stage}`).join(", ")}. <SourceTag source="invented" /></p> : null}
      {d.reply ? <p className="muted">Result released: <code>{visible(d.reply)}</code></p> : null}
      <h3 className="panel__sub">Layer by layer, in order</h3>
      <ol className="trace" data-testid="trace">{d.trace.map((t) => <Step key={t.stage} t={t} />)}</ol>
      {d.tokenSummary ? <details><summary>Verified token (header and claims; a lab-minted token) <SourceTag source="invented" /></summary><Json value={d.tokenSummary} label="token summary" /></details> : null}
    </section>
  );
}
