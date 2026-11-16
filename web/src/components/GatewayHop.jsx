import { useState } from "react";
import PrivilegeCheck from "../privilege-check/PrivilegeCheck.jsx";
import GatewayTrace from "../gateway-trace/GatewayTrace";

// Real only (the page renders it only in Real, so Mock makes no gateway call). The shared card makes the one gateway check; its own
// answer is handed back through onResult and "What Privilege did" (Rule 25) is drawn from that answer: asking for the trace calls nothing.
// Real traces carry only observed or inferred decisions: the gateway reports no per-check detail.
export default function GatewayHop() {
  const [result, setResult] = useState(null);
  const [open, setOpen] = useState(false);
  const trace = result?.phase === "done" ? result.trace : null;
  const exchanges = trace
    ? [["tools/list", trace.listing], ["Refusal probe: tools/call", trace.refusal]].filter(([, t]) => t)
      .map(([title, t], i) => ({ step: i + 1, title, status: t.response?.status ?? null, trace: t }))
    : [];
  return (
    <div className="gwhop" data-testid="gateway-hop">
      <PrivilegeCheck onResult={(r) => { setResult(r); setOpen(false); }} />
      {exchanges.length > 0 && (
        <div className="gwhop__trace">
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} data-testid="gateway-trace-run">
            {open ? "Hide what Privilege did" : "Show what Privilege did"}
          </button>
          {open && <div className="gwhop__panel"><GatewayTrace source="real" title="What Privilege did: the gateway check" exchanges={exchanges} /></div>}
        </div>
      )}
    </div>
  );
}
