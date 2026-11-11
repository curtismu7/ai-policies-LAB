import { useState } from "react";
import { visible } from "../safeText";
import { ClaimTag, Json, SourceTag } from "./Bits";
import { postJson } from "../api";

const RULES = [
  ["An evaluation error denies", "deck", "Any stage that throws is a denial, never an allow (lab fault injection makes one throw)."],
  ["An argument of the wrong type denies", "deck", "amount must be a number: the string \"50\" is refused, by the tool's schema and by a rule that compares it."],
  ["A bad token denies (401)", "reading", "Tampered, expired, not yet valid, another algorithm, another key id, a __proto__ key: all refused before any layer reads a claim."],
  ["Hostile arguments deny", "invented", "Duplicate keys (also after Unicode normalisation), __proto__, constructor and prototype keys, numbers a double cannot hold, lone surrogates, deep or huge input: refused, never repaired or truncated."],
  ["An unknown route, application or tool denies", "reading", "A guess would be an allow somewhere. Nothing is guessed."],
  ["A rule naming something that does not exist is refused when saved, and safe if it ever reaches evaluation", "reading", "Lab reading of a partly-cut-off deck line: the slide text is cut off at this point in the PDF. These are not the deck's words."],
];

export default function FailClosedTab({ story, mode, lab, ev, presets }) {
  const live = mode === "live";
  const [text, setText] = useState(`{"record":"${story.cast.castRecord}","newValue":"${story.cast.castNewValue}"}`);
  const [out, setOut] = useState(null);
  const calc = async () => { const r = await postJson("/api/canonicalize", { mode, vertical: story.vertical, argumentsText: text }); setOut({ status: r.status, ...r.body }); };
  const go = (id) => ev.run(presets.find((p) => p.id === id));
  const d = ev.decision?.result;
  return (
    <div className="stack">
      <section className="panel">
        <h2 className="panel__title">Fail closed <ClaimTag /></h2>
        <ul className="plain" data-testid="fail-rules">{RULES.map(([t, src, n]) => <li key={t}><strong>{t}.</strong> <SourceTag source={src} /> {n}</li>)}</ul>
        <div className="seg">
          {[["wrong-type", "An argument of the wrong type"], ["fault", "An evaluation error"], ["tamper", "A tampered token"], ["dup", "Duplicate keys"], ["proto", "A __proto__ key"]].map(([id, l], i) => <button key={id} type="button" className={i === 0 ? "primary" : undefined} disabled={!live || lab.busy} onClick={() => go(id)} data-testid={`fc-${id}`}>Run: {l}</button>)}
        </div>
        {!live ? <p className="muted">Switch to Live to run these. In Mock, the "Fail closed" scenario on the Evaluate tab shows the results.</p> : d ? <p data-testid="fc-result">Last result: <strong>{d.outcome}</strong> <code>{d.code}</code> (HTTP {ev.decision.http}){d.failedClosed ? ", failed closed" : ""}. {visible(d.reason)} See the Evaluate tab for the layer-by-layer trace.</p> : null}
      </section>
      <section className="panel" data-testid="canon">
        <h2 className="panel__title">The canonical form of a call <SourceTag source="invented" /></h2>
        <p className="muted">An approval is bound to a hash of the method, target and arguments. The deck gives the idea; this canonical form is the lab's: keys sorted after Unicode NFC, strings NFC, numbers as a double prints them (100, 100.0 and 1e2 agree; "100" does not), array order kept, and every ambiguity refused. {story.limits.canon.text} characters at most, nesting {story.limits.canon.depth}.</p>
        <div className="scroll"><table className="tbl tbl--wide" data-testid="canon-examples"><thead><tr><th>Spelling</th><th>Arguments text</th><th>Hash (first 16)</th></tr></thead>
          <tbody>{story.canonicalExamples.map((x, i) => <tr key={i}><td>{x.label}</td><td><code>{visible(x.text)}</code></td><td>{x.ok ? <code>{x.hash.slice(0, 16)}</code> : <span className="tag" data-state="bad">refused: {x.code}</span>}</td></tr>)}</tbody></table></div>
        <label>Try your own arguments (JSON text, for the {story.cast.castToolHold} call)
          <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} data-testid="canon-input" spellCheck={false} />
        </label>
        <div className="seg"><button type="button" onClick={calc} data-testid="canon-run">Compute the hash</button></div>
        {out ? (out.ok ? <div data-testid="canon-result"><p>Hash <code data-testid="canon-hash">{out.hash}</code></p><Json value={out.canonical} label="canonical" /></div> : <p className="field-error" role="alert" data-testid="canon-refused"><code>{out.code}</code>: {visible(out.reason || "")}</p>) : null}
      </section>
    </div>
  );
}
