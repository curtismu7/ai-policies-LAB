import { useEffect, useState } from "react";
import { visible } from "../safeText";
import { ClaimTag, Json, SourceTag, StatusTag } from "./Bits";

export default function ApprovalsTab({ story, mode, lab, ev }) {
  const s = lab.state;
  const people = (s?.roster || []).filter((r) => r.kind === "human");
  const [actor, setActor] = useState("");
  const [level, setLevel] = useState("2");
  const [msg, setMsg] = useState(null);
  useEffect(() => { if (!actor && people.length) setActor(people[0].id); }, [people, actor]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return <p className="muted">Loading...</p>;
  const live = mode === "live"; const off = !live || lab.busy;
  const decide = async (ref, decision) => {
    const r = await lab.act("POST", `/api/approvals/${ref}/decision`, { decision: { approver: actor, decision, authLevel: Number(level), comment: "" } });
    setMsg(r.ok ? { ok: true, text: `${ref}: ${r.body.result.status}${r.body.result.signatures ? ` (${r.body.result.signatures} of ${r.body.result.required} signatures)` : ""}` } : { ok: false, code: r.body?.error, text: r.body?.detail || "refused" });
  };
  const advance = (minutes) => lab.act("POST", "/api/clock", { clock: { minutes } });
  const useRef = (ref) => { ev.setForm((f) => ({ ...(f || {}), approvalRef: ref })); };
  return (
    <div className="stack">
      <section className="panel">
        <h2 className="panel__title">Approvals <ClaimTag /></h2>
        <p className="muted">An approval is single-use and bound to the exact call, or to a fixed period; it names a number of approvers, roles and a minimum authentication strength. It is an input to the next evaluation, never a bypass. The lab has no sign-in: you choose who acts and the level they signed in with.</p>
        <div className="filters">
          <label>Act as (the roster) <SourceTag source="invented" /><select value={actor} onChange={(e) => setActor(e.target.value)} data-testid="actor">{people.map((p) => <option key={p.id} value={p.id}>{p.id} ({p.roles.join(", ") || "no role"}, up to level {p.maxAuthLevel})</option>)}</select></label>
          <label>Signed in with (authentication level) <SourceTag source="invented" /><select value={level} onChange={(e) => setLevel(e.target.value)} data-testid="auth-level">{Object.entries(story.authLevels).map(([k, v]) => <option key={k} value={k}>{k}: {v}</option>)}</select></label>
        </div>
        <p className="muted" data-testid="clock">Lab clock: <strong>{s.clock.now}</strong> (UTC, {s.clock.minutesSinceStart} minutes since the start; it only moves forward). <SourceTag source="invented" /></p>
        <div className="seg" aria-label="Move the lab clock">
          {[[15, "+15 minutes"], [60, "+1 hour"], [1440, "+1 day"]].map(([m, l], i) => <button key={m} type="button" className={i === 1 ? "primary" : undefined} disabled={off} onClick={() => advance(m)} data-testid={`clock-${m}`}>{l}</button>)}
        </div>
        {msg ? <p className={msg.ok ? "muted" : "field-error"} role={msg.ok ? "status" : "alert"} data-testid="decision-message">{msg.ok ? "" : <code>{msg.code}: </code>}{visible(msg.text)}</p> : <p className="sr-only" data-testid="decision-message" />}
      </section>
      <section className="panel" data-testid="inbox" aria-label="Approval requests">
        <h3 className="panel__sub">Requests ({s.approvals.length})</h3>
        {!s.approvals.length ? <p className="muted">{live ? "Nothing yet. Evaluate a call that is held and it appears here." : "Mock shows the end of the scripted scenario: nothing was held in it, or the table is empty."}</p> : null}
        {s.approvals.map((a) => (
          <article className="panel" key={a.ref} data-testid={`approval-${a.ref}`} data-status={a.status}>
            <h4 className="panel__sub"><code>{a.ref}</code> <StatusTag status={a.status} /> <SourceTag source="invented" /> {a.tool} on {a.app}</h4>
            <p className="muted">For <strong>{a.requester}</strong> (identity {a.identity}). Created {a.createdAt}; the request expires {a.expiresAt}. Bound to {a.bound.kind === "call" ? <>the exact call <code>{a.bound.callHash.slice(0, 16)}...</code> (single-use)</> : <>a fixed period of {a.bound.windowMin} minutes</>}{a.grantUntil ? <>; grant valid until {a.grantUntil}</> : null}. Needs {a.required.approvers} approver(s) with {a.required.roles.join(" or ")} at level {a.required.minAuthLevel} or stronger; sent by {a.required.channel}. <SourceTag source="deck" /></p>
            <p className="muted" data-testid={`sigs-${a.ref}`}>Signatures: {a.approvals.length} of {a.required.approvers}{a.approvals.length ? ` (${a.approvals.map((x) => `${x.approver} at level ${x.authLevel}`).join(", ")})` : ""}.{a.status === "pending" && a.eligible.length ? ` Eligible: ${a.eligible.join(", ")}.` : ""}{a.uses.length ? ` Used ${a.uses.length} time(s).` : ""}</p>
            <div className="seg">
              <button type="button" disabled={off || a.status !== "pending"} onClick={() => decide(a.ref, "approve")} data-testid={`approve-${a.ref}`}>Approve as {actor}</button>
              <button type="button" disabled={off || a.status !== "pending"} onClick={() => decide(a.ref, "deny")} data-testid={`deny-${a.ref}`}>Deny as {actor}</button>
              <button type="button" disabled={!live} onClick={() => useRef(a.ref)} data-testid={`useref-${a.ref}`}>Offer this reference on the Evaluate tab (a replay attempt)</button>
            </div>
          </article>
        ))}
      </section>
      <section className="panel" data-testid="outbox">
        <h3 className="panel__sub">Approver outbox (simulated: never sent) ({s.outbox.length}) <SourceTag source="deck" /></h3>
        {!s.outbox.length ? <p className="muted">Empty.</p> : (
          <div className="scroll"><table className="tbl tbl--wide"><thead><tr><th>Reference</th><th>Channel</th><th>To</th><th>Subject</th><th>Expires</th></tr></thead>
            <tbody>{s.outbox.map((o) => <tr key={o.id}><td><code>{o.ref}</code></td><td>{o.label}</td><td>{o.to.join(", ")}</td><td>{o.subject}</td><td>{o.expiresAt}</td></tr>)}</tbody></table></div>
        )}
      </section>
      <details className="panel"><summary>Audit trail ({s.audit.length})</summary><Json value={s.audit.slice(-30)} label="audit" /></details>
    </div>
  );
}
