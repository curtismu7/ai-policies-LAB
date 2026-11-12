import { ClaimTag, SourceTag, StatusTag } from "./Bits";

const ROWS = [
  { where: "Before the call is made", what: "Token verification, the four scope checks, and the attended and unattended questions", outcomes: ["allow", "deny", "hold"], source: "deck", note: "The only place a call can be held for a person. A hold is refused at once with a reference and an owning expiry." },
  { where: "After the request has been examined", what: "Rules that read inspection findings on the request", outcomes: ["refuse"], source: "deck", note: "Refuse the call before it is made. Cannot hold." },
  { where: "After the reply has come back", what: "Rules that read inspection findings on the reply", outcomes: ["withhold"], source: "deck", note: "The call already happened; the result is withheld. Cannot hold." },
];

export default function WhereTab({ mode, lab, ev, presets }) {
  const live = mode === "live";
  const go = (id) => ev.run(presets.find((p) => p.id === id));
  const tryHold = () => lab.act("PUT", "/api/policies/inspection", { rules: [{ id: "insp-hold", stage: "reply", finding: "secret", action: "hold" }] });
  const refusal = lab.last && lab.last.route.includes("/policies/inspection") && !lab.last.ok ? lab.last : null;
  return (
    <div className="stack">
      <section className="panel">
        <h2 className="panel__title">Where it can run <ClaimTag /></h2>
        <p className="muted">Only before the call is made can a request be held for a person. Rules that read inspection findings run after the request has been examined or after the reply has come back, where the choice is to refuse the call or withhold the result: neither can pause for a person.</p>
        <div className="scroll"><table className="tbl tbl--wide" data-testid="where-table">
          <thead><tr><th>When</th><th>What runs</th><th>Possible outcomes</th><th>Note</th><th>Source</th></tr></thead>
          <tbody>{ROWS.map((r) => <tr key={r.where}><td>{r.where}</td><td>{r.what}</td><td>{r.outcomes.map((o) => <StatusTag key={o} status={o} />)}</td><td>{r.note}</td><td><SourceTag source={r.source} /></td></tr>)}</tbody>
        </table></div>
        <p className="muted">There is no outcome "hold" below the first row. The lab enforces it twice: a rule that tries is refused when saved, and the engine never produces a hold from an inspection stage. <SourceTag source="reading" /></p>
        <div className="seg">
          <button type="button" className="primary" disabled={!live || lab.busy} onClick={() => go("req-finding")} data-testid="try-request-finding">Run: a finding on the request</button>
          <button type="button" disabled={!live || lab.busy} onClick={() => go("rep-finding")} data-testid="try-reply-finding">Run: a finding on the reply</button>
          <button type="button" disabled={!live || lab.busy} onClick={tryHold} data-testid="try-inspection-hold">Try to save an inspection rule that holds</button>
        </div>
        {!live ? <p className="muted">Switch to Live to run these. In Mock, the "Where it can run: findings cannot hold" scenario on the Evaluate tab shows the same three results.</p> : null}
        {refusal ? <div className="field-error" role="alert" data-testid="inspection-hold-refused"><strong>Refused when saved ({refusal.error}).</strong> {(refusal.errors || []).map((e, i) => <span key={i}><code>{e.code}</code>: {e.reason} </span>)}</div> : null}
      </section>
    </div>
  );
}
