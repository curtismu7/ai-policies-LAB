import { useCallback, useState } from "react";
import { tamper, toForm } from "../presets";

const parse = (text, what) => {
  if (!text.trim()) return { value: undefined };
  try { const v = JSON.parse(text); return v !== null && typeof v === "object" && !Array.isArray(v) ? { value: v } : { error: `${what} must be one JSON object` }; } catch { return { error: `${what} is not valid JSON` }; }
};

// The request builder's state and its two actions (mint a token, evaluate), shared by the tabs that can run a call. Lab state stays on the server.
export default function useEvaluator(lab) {
  const [form, setForm] = useState(null);
  const [decision, setDecision] = useState(null); // { http, result, hops, traceId } of the last evaluation
  const [formError, setFormError] = useState("");
  const [minted, setMinted] = useState(null);

  const mint = useCallback(async (f) => {
    setFormError("");
    const c = parse(f.claimsText, "the claims");
    if (c.error || !c.value) { setFormError(c.error || "the claims are empty"); return null; }
    const r = await lab.act("POST", "/api/token", { token: { claims: c.value, ttlMin: Number(f.ttl) } });
    if (!r.ok) { setFormError(`the token was not minted: ${r.body?.error || "refused"}`); return null; }
    setMinted(r.body.result);
    return r.body.result.labToken;
  }, [lab.act]); // eslint-disable-line react-hooks/exhaustive-deps

  const evaluate = useCallback(async (f, tokenOverride) => {
    setFormError("");
    const h = parse(f.headersText || "", "the headers");
    if (h.error) { setFormError(h.error); return null; }
    const request = { route: f.route, tool: f.tool, argumentsText: f.argumentsText };
    const token = tokenOverride ?? f.token;
    if (token) request.token = token;
    if (h.value) request.headers = h.value;
    if (f.approvalRef) request.approvalRef = f.approvalRef;
    if (f.simulatedReply) request.simulatedReply = f.simulatedReply;
    if (f.labFault) request.labFault = f.labFault;
    const r = await lab.act("POST", "/api/evaluate", { request });
    if (r.ok) setDecision({ http: r.status, result: r.body.result, hops: r.body.hops, traceId: r.body.traceId });
    else setFormError(`the call was not evaluated: ${r.body?.error || "refused"}`);
    return r;
  }, [lab.act]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mint, then evaluate, in one click.
  const run = useCallback(async (p) => {
    const f = toForm(p); setForm(f);
    const t = await mint(f);
    if (!t) return;
    const token = p.tamper ? tamper(t) : t;
    const next = { ...f, token }; setForm(next);
    await evaluate(next, token);
  }, [mint, evaluate]);

  const load = useCallback((p) => { setForm(toForm(p)); setDecision(null); setMinted(null); setFormError(""); }, []);
  return { form, setForm, decision, setDecision, formError, minted, mint, evaluate, run, load };
}
