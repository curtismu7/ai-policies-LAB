import { useMemo } from "react";
import { visible } from "../safeText";
import { ClaimTag, Json, SourceTag } from "./Bits";
import Decision from "./Decision";
import { buildPresets, tamper } from "../presets";

const FAULTS = ["", "request", "token", "surface", "application", "action", "end-user", "attended-unattended", "request-inspection", "call", "reply-inspection"];

function MockScenarios({ story, lab, scenarioId, setScenarioId, step, setStep }) {
  const sc = lab.scenario;
  const s = sc?.steps[step] || null;
  const asDecision = s && s.op === "evaluate" ? s.result : null;
  return (
    <div className="stack">
      <div className="panel">
        <h2 className="panel__title">Scripted scenarios (Mock) <ClaimTag /></h2>
        <p className="muted">Mock reads tables generated from the lab's own engine and is read-only. Pick a scenario and step through it; switch to Live to build a call yourself.</p>
        <div className="seg" role="group" aria-label="Scenario" data-testid="scenarios">
          {lab.scenarios.map((x) => <button key={x.id} type="button" aria-pressed={sc?.id === x.id} onClick={() => { setScenarioId(x.id); setStep(0); }} data-testid={`scenario-${x.id}`}>{x.title}</button>)}
        </div>
        {sc ? <p className="lesson" data-testid="scenario-say">{sc.say}</p> : null}
        {sc ? (
          <ol className="steps" data-testid="steps">
            {sc.steps.map((x, i) => (
              <li key={i}><button type="button" aria-pressed={i === step} onClick={() => setStep(i)} data-testid={`step-${i}`}><span className="tag" data-state={x.got.startsWith("allow") || x.got.startsWith("ok") ? "ok" : x.got.startsWith("hold") ? "warn" : "bad"}>{x.got}</span> {x.title}</button></li>
            ))}
          </ol>
        ) : null}
      </div>
      {s ? (
        <section className="panel" data-testid="step-detail">
          <h3 className="panel__sub">{s.title}</h3>
          <p>{s.say}</p>
          {s.claims ? <details><summary>The claims in the token for this step{s.tampered ? " (one character changed after signing)" : ""} <SourceTag source="invented" /></summary><Json value={s.claims} label="claims" /></details> : null}
          {s.request ? <details><summary>The {s.op === "evaluate" ? "call" : "request"}</summary><Json value={s.request} label="request" /></details> : null}
          {s.op !== "evaluate" ? <Json value={s.result} label="result" testId="step-result" /> : null}
        </section>
      ) : null}
      {asDecision ? <Decision decision={{ result: asDecision, http: asDecision.http }} caption={`Step ${step + 1}`} /> : null}
    </div>
  );
}

export default function EvaluateTab({ story, mode, lab, ev, scenarioId, setScenarioId, step, setStep }) {
  const presets = useMemo(() => buildPresets(story.cast), [story.cast]);
  if (mode === "mock") return <MockScenarios {...{ story, lab, scenarioId, setScenarioId, step, setStep }} />;
  const f = ev.form;
  const set = (k, v) => ev.setForm((x) => ({ ...x, [k]: v }));
  const groups = [...new Set(presets.map((p) => p.group))];
  const busy = lab.busy;
  return (
    <div className="stack">
      <section className="panel" aria-label="Quick starts">
        <h2 className="panel__title">Quick starts <ClaimTag /></h2>
        <p className="muted">Each fills the token claims and the call, and says what the lab will answer. "Run" mints a real RS256 token and evaluates in one click; "Load" only fills the form.</p>
        {groups.map((g) => (
          <fieldset className="fieldset" key={g}><legend>{g}</legend>
            {presets.filter((p) => p.group === g).map((p) => (
              <div className="preset" key={p.id}>
                <span>{p.label} <span className="muted">({p.expect})</span></span>
                <span className="seg"><button type="button" onClick={() => ev.load(p)} data-testid={`load-${p.id}`}>Load</button><button type="button" disabled={busy} onClick={() => ev.run(p)} data-testid={`run-${p.id}`}>Run</button></span>
              </div>
            ))}
          </fieldset>
        ))}
      </section>
      {!f ? <p className="muted" data-testid="form-empty">Load a quick start to fill the form.</p> : (
        <div className="cols">
          <section className="panel" data-testid="token-editor" aria-label="Token editor">
            <h2 className="panel__title">Token</h2>
            <p className="muted">A real RS256 JWT, signed by a throwaway key the lab generated in memory: <strong>mock-issued, not a credential for anything</strong>. Edit the claims and mint, or edit the token text itself: any change breaks the signature.</p>
            <label>Claims (JSON; iss, aud, iat, nbf and exp are set by the lab's issuer) <SourceTag source="invented" />
              <textarea rows={8} value={f.claimsText} onChange={(e) => set("claimsText", e.target.value)} data-testid="claims" spellCheck={false} />
            </label>
            <div className="filters">
              <label>Lifetime (minutes, lab clock) <SourceTag source="invented" /><input type="number" min="1" max="1440" value={f.ttl} onChange={(e) => set("ttl", e.target.value)} data-testid="ttl" /></label>
            </div>
            <div className="seg">
              <button type="button" className="primary" disabled={busy} onClick={() => ev.mint(f).then((t) => t && set("token", t))} data-testid="mint">Mint token</button>
              <button type="button" disabled={!f.token} onClick={() => set("token", tamper(f.token))} data-testid="tamper">Tamper with the token</button>
            </div>
            <label>Token (labelled mock-issued) <SourceTag source="reading" />
              <textarea rows={4} value={f.token} onChange={(e) => set("token", e.target.value)} data-testid="token" spellCheck={false} placeholder="Mint a token, or paste one" />
            </label>
            {ev.minted ? <p className="muted" data-testid="minted-note">{ev.minted.label}. Expires {ev.minted.expiresAt}.</p> : null}
          </section>
          <section className="panel" data-testid="request-form" aria-label="Request builder">
            <h2 className="panel__title">Call</h2>
            <div className="filters">
              <label>Route (surface comes from the prefix) <SourceTag source="deck" /><input value={f.route} onChange={(e) => set("route", e.target.value)} data-testid="route" spellCheck={false} /></label>
              <label>Tool <SourceTag source="invented" /><input value={f.tool} onChange={(e) => set("tool", e.target.value)} data-testid="tool" spellCheck={false} /></label>
            </div>
            <label>Arguments (JSON text; parsed strictly, duplicate keys are refused) <SourceTag source="invented" />
              <textarea rows={3} value={f.argumentsText} onChange={(e) => set("argumentsText", e.target.value)} data-testid="arguments" spellCheck={false} />
            </label>
            <label>Caller-supplied headers (JSON; ignored by every layer, listed in the trace) <SourceTag source="reading" />
              <textarea rows={2} value={f.headersText} onChange={(e) => set("headersText", e.target.value)} data-testid="headers" spellCheck={false} />
            </label>
            <div className="filters">
              <label>Approval reference (optional) <SourceTag source="invented" /><input value={f.approvalRef} onChange={(e) => set("approvalRef", e.target.value)} placeholder="apr-0001" data-testid="approval-ref-input" spellCheck={false} /></label>
              <label>Simulated upstream reply (optional) <SourceTag source="invented" /><input value={f.simulatedReply} onChange={(e) => set("simulatedReply", e.target.value)} data-testid="reply" spellCheck={false} /></label>
              <label>Lab fault: make a stage throw <SourceTag source="invented" />
                <select value={f.labFault} onChange={(e) => set("labFault", e.target.value)} data-testid="fault">{FAULTS.map((x) => <option key={x} value={x}>{x || "none"}</option>)}</select>
              </label>
            </div>
            <div className="seg"><button type="button" className="primary" disabled={busy} onClick={() => ev.evaluate(f)} data-testid="evaluate">Evaluate</button></div>
            {ev.formError ? <p className="field-error" role="alert" data-testid="form-error">{visible(ev.formError)}</p> : null}
          </section>
        </div>
      )}
      <Decision decision={ev.decision} />
    </div>
  );
}
