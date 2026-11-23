import { visible } from "../safeText";
import { Hops } from "./Bits";

// The raw hops of the last write, with the traceparent of every hop and the platform calls the engine simulated. Refusals show their code.
export default function LastAction({ last }) {
  if (!last) return null;
  return (
    <section className="panel last" data-testid="last-action" aria-label="Last action">
      <h2 className="panel__sub">Last action: <code>{last.route}</code> {last.ok ? "done" : `refused (${last.error})`}</h2>
      {!last.ok && last.detail && <p className="field-error" role="alert">{visible(last.detail)}</p>}
      <Hops hops={last.hops} traceId={last.traceId} truncated={last.truncated} />
      {/* The one primary action on the Live page: the next step is on the Evaluate tab. */}
      <button type="button" className="primary" onClick={() => { window.location.hash = "#evaluate"; }}>Run next step</button>
    </section>
  );
}
