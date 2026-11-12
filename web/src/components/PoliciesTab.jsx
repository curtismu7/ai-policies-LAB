import { useEffect, useState } from "react";
import { visible } from "../safeText";
import { ClaimTag, SourceTag } from "./Bits";

const LAYERS = [
  { id: "identities", title: "1. Surface scope: the surfaces an identity may touch", say: "The ceiling for an identity and for every key it owns. The surface itself is derived from the route, never from a rule." },
  { id: "apps", title: "2. Application policy: which applications, and the claims the token must carry", say: "An identity reaches an application only if a rule says so and the verified token carries the required claims." },
  { id: "actions", title: "3. Action scope: the scope the verified token must carry for a tool", say: "Read from the token, never from anything the caller supplies." },
  { id: "users", title: "4. End-user scope: the people who may take an action", say: "The only layer that reaches past the service identity. A person who could never be identified is refused when the rule is saved." },
  { id: "holds", title: "Attended and unattended: allow, hold or hard denial", say: "Every request is asked two questions. Attended deny is a hard denial. Attended allow and unattended deny is a hold, with what the approval needs." },
  { id: "inspection", title: "Inspection rules: refuse the call or withhold the result", say: "Run after the request is examined or after the reply comes back. Neither can pause for a person." },
];

const PAIR = [["allow", "allow", "Allow: nothing to hold"], ["allow", "deny", "Hold for a human: refused now, with a reference and an expiry"], ["deny", "allow", "Hard denial (lab reading): no approval can lift it"], ["deny", "deny", "Hard denial: no approval can lift it"]];

function Layer({ layer, rules, readOnly, busy, lab, errors, setErrors }) {
  const text = JSON.stringify(rules, null, 2);
  const [draft, setDraft] = useState(text);
  useEffect(() => { setDraft(text); }, [text]);
  const save = async () => {
    let parsed;
    try { parsed = JSON.parse(draft); } catch { setErrors((e) => ({ ...e, [layer.id]: [{ path: "", code: "not_json", reason: "the editor does not hold valid JSON" }] })); return; }
    const r = await lab.act("PUT", `/api/policies/${layer.id}`, { rules: parsed });
    setErrors((e) => ({ ...e, [layer.id]: r.ok ? null : (r.body?.errors || [{ path: "", code: r.body?.error || "refused", reason: r.body?.detail || "refused" }]) }));
    if (r.ok) setDraft(JSON.stringify(r.body.state.policy[layer.id], null, 2));
  };
  // A refused save keeps what you typed (and the reasons); a good save or a reset shows the layer as the server now holds it.
  const reset = async () => {
    const r = await lab.act("POST", `/api/policies/${layer.id}/reset`, {});
    if (r.ok) { setErrors((e) => ({ ...e, [layer.id]: null })); setDraft(JSON.stringify(r.body.state.policy[layer.id], null, 2)); }
  };
  const errs = errors[layer.id];
  const off = readOnly || busy;
  return (
    <details className="panel" data-testid={`layer-${layer.id}`} open={layer.id === "users"}>
      <summary>{layer.title} ({rules.length} rule{rules.length === 1 ? "" : "s"})</summary>
      <p className="muted">{layer.say} <SourceTag source="reading" /></p>
      <textarea rows={Math.min(18, Math.max(6, draft.split("\n").length))} value={draft} readOnly={readOnly} onChange={(e) => setDraft(e.target.value)} aria-label={`${layer.id} rules`} data-testid={`edit-${layer.id}`} spellCheck={false} />
      {errs?.length ? (
        <div className="field-error" role="alert" data-testid={`errors-${layer.id}`}>
          <strong>Not saved: nothing was changed.</strong>
          <ul className="plain">{errs.map((e, i) => <li key={i}><code>{e.path || "layer"}</code> <code>{e.code}</code>: {visible(e.reason)}</li>)}</ul>
        </div>
      ) : null}
      <div className="seg">
        <button type="button" disabled={off} onClick={save} data-testid={`save-${layer.id}`}>Save layer</button>
        <button type="button" disabled={off} onClick={() => setDraft(text)} data-testid={`revert-${layer.id}`}>Revert edits</button>
        <button type="button" disabled={off} onClick={reset} data-testid={`reset-${layer.id}`}>Reset layer to default</button>
        {layer.id === "users" ? <button type="button" disabled={off} onClick={() => { try { const r = JSON.parse(draft); r.push({ id: "usr-ghost", app: r[0]?.app, tool: r[0]?.tool, users: ["ghost.user"] }); setDraft(JSON.stringify(r, null, 2)); } catch { /* not JSON */ } }} data-testid="add-ghost">Add a rule naming someone who does not exist</button> : null}
        {layer.id === "inspection" ? <button type="button" disabled={off} onClick={() => { try { const r = JSON.parse(draft); r.push({ id: "insp-hold", stage: "reply", finding: "secret", action: "hold" }); setDraft(JSON.stringify(r, null, 2)); } catch { /* not JSON */ } }} data-testid="add-inspection-hold">Add an inspection rule that tries to hold</button> : null}
      </div>
    </details>
  );
}

export default function PoliciesTab({ story, mode, lab }) {
  const [errors, setErrors] = useState({});
  const policy = lab.state?.policy;
  const readOnly = mode !== "live";
  if (!policy) return <p className="muted">Loading...</p>;
  return (
    <div className="stack">
      <section className="panel">
        <h2 className="panel__title">Policies <ClaimTag /></h2>
        <p className="muted">{readOnly ? "Mock is read-only: this is the default policy the scripted scenarios use. Switch to Live to edit it." : "Each layer is a list of rules. Saving validates every rule and saves nothing if one is wrong (atomic)."} Rule formats are lab-invented; the layers and what each decides are the deck's claims (slide 52).</p>
        <div className="seg">
          <button type="button" className="primary" disabled={lab.busy} onClick={() => lab.reload()} data-testid="reload-policies">Reload the policy</button>
          <span className="muted">Saving validates every rule and saves nothing if one is wrong (atomic).</span>
        </div>
        <table className="tbl" data-testid="pair-table"><caption>The two questions, and what the pair means</caption>
          <thead><tr><th>Attended?</th><th>Unattended?</th><th>Result</th></tr></thead>
          <tbody>{PAIR.map(([a, u, r]) => <tr key={`${a}${u}`}><td>{a}</td><td>{u}</td><td>{r}</td></tr>)}</tbody>
        </table>
      </section>
      {LAYERS.map((l) => <Layer key={l.id} layer={l} rules={policy[l.id]} readOnly={readOnly} busy={lab.busy} lab={lab} errors={errors} setErrors={setErrors} />)}
      <details className="panel"><summary>Editable fields and where each comes from ({story.editableFields.length})</summary>
        <div className="scroll"><table className="tbl tbl--wide"><thead><tr><th>Layer</th><th>Fields</th><th>Source</th><th>Note</th></tr></thead>
          <tbody>{story.editableFields.map((f, i) => <tr key={i}><td>{f.layer}</td><td><code>{f.field}</code></td><td><SourceTag source={f.source} /></td><td>{f.note}</td></tr>)}</tbody></table></div>
      </details>
    </div>
  );
}
