import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ShelfLink from "./components/ShelfLink";
import EvaluateTab from "./components/EvaluateTab";
import PoliciesTab from "./components/PoliciesTab";
import ApprovalsTab from "./components/ApprovalsTab";
import WhereTab from "./components/WhereTab";
import FailClosedTab from "./components/FailClosedTab";
import DiagramTab from "./components/DiagramTab";
import TalkTrack from "./components/TalkTrack";
import LastAction from "./components/LastAction";
import useLab from "./hooks/useLab";
import useEvaluator from "./hooks/useEvaluator";
import { buildPresets } from "./presets";
import { getJson, postJson, resetWorkspace } from "./api";

export const TABS = [
  { id: "evaluate", label: "Evaluate" },
  { id: "policies", label: "Policies" },
  { id: "approvals", label: "Approvals" },
  { id: "where", label: "Where it runs" },
  { id: "closed", label: "Fail closed" },
  { id: "diagram", label: "Diagram" },
  { id: "talk", label: "Talk track" },
];
// The banner is never blank and never claims one mode before it knows: until the story answers it says both, honestly.
const TAIL = "Every product claim is a Ping release claim, UNVERIFIED on our tenant (release 2026-11-02). Nothing here calls a real gateway, identity provider, chat tool or tenant.";
export const BANNER_UNKNOWN = `SIMULATED, MOCK or LIVE mode (loopback only, no outbound network). ${TAIL}`;
const PRESENTER_TALK = { evaluate: ["say-first", "two-controls", "four-layers"], policies: ["four-layers"], approvals: ["hold", "bound", "period"], where: ["where", "hard"], closed: ["closed"], diagram: ["why-ai-policies"] };

const THEME_KEY = "aip.theme";
const THEMES = [["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]];
function initialTheme() {
  try { const t = localStorage.getItem(THEME_KEY); if (t === "light" || t === "dark") return t; } catch { /* storage blocked */ }
  return "auto";
}

const tabFromHash = () => { const h = window.location.hash.replace("#", ""); return TABS.some((t) => t.id === h) ? h : "evaluate"; };

export default function App() {
  const [vertical, setVertical] = useState("finance");
  const [story, setStory] = useState(null);
  const [mode, setModeState] = useState(null);
  const [scenarioId, setScenarioId] = useState(null);
  const [step, setStep] = useState(0);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState(tabFromHash());
  const [presenter, setPresenter] = useState(false);
  const [resetSignal, setResetSignal] = useState(0);
  const [resetMsg, setResetMsg] = useState("");
  const [theme, setTheme] = useState(initialTheme);
  const pickTheme = (next) => {
    try { if (next === "auto") localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, next); } catch { /* not remembered */ }
    setTheme(next);
  };
  // The picker only sets data-theme; the shared stylesheet does the rest ("auto" follows the system setting).
  useEffect(() => { if (theme === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme; }, [theme]);
  const tabsRef = useRef(null);
  const lab = useLab({ mode, vertical, scenario: scenarioId });
  const ev = useEvaluator(lab);
  const presets = useMemo(() => (story ? buildPresets(story.cast) : []), [story]);

  useEffect(() => { getJson("/api/info").then((i) => setModeState((m) => m || i.mode || i.source), () => setModeState((m) => m || "mock")); }, []);
  useEffect(() => {
    let live = true; // a late story for a vertical the visitor has already left is dropped
    getJson(`/api/story?vertical=${encodeURIComponent(vertical)}`).then((j) => { if (live) { setStory(j); setError(null); } }, (e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [vertical]);
  useEffect(() => {
    const on = () => setTab(tabFromHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  useEffect(() => { ev.setForm(null); ev.setDecision(null); }, [mode, vertical]); // eslint-disable-line react-hooks/exhaustive-deps
  // Rule 19: switching is a server call (POST /api/mode with exactly {source}), then the data reloads so the banner,
  // mode chip and every tab reflect the mode the server answered with.
  const [modeError, setModeError] = useState(null);
  const setMode = async (m) => {
    setModeError(null);
    const r = await postJson("/api/mode", { source: m === "live" ? "real" : "mock" });
    if (!r.ok) { setModeError(r.body?.detail || r.body?.error || `HTTP ${r.status}`); return; }
    setModeState(r.body?.mode || m);
    await lab.reload();
  };
  const select = (id) => { setTab(id); try { window.history.replaceState(null, "", `#${id}`); } catch { /* ignore */ } };

  // Keep the active tab fully in view in the scrolling tab strip (375px).
  useEffect(() => {
    const strip = tabsRef.current; const el = document.getElementById(`tab-${tab}`);
    if (!strip || !el) return;
    const left = el.offsetLeft - strip.offsetLeft;
    if (left < strip.scrollLeft || left + el.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = Math.max(0, left - 8);
  }, [tab]);

  useEffect(() => {
    const on = (e) => {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.key === "p" || e.key === "P") setPresenter((v) => !v);
      else if (e.key === "Escape") setPresenter(false);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  // Reset: the server clears this workspace's engines (requests, grants, receipts, the platforms' own state, outbox, audit and the clock); the diagram goes
  // back in place; the view reloads.
  const reset = useCallback(async () => {
    const ok = await resetWorkspace().catch(() => false);
    setResetSignal((n) => n + 1);
    ev.setForm(null); ev.setDecision(null);
    await lab.reload();
    setResetMsg(ok ? "Reset: your workspace's approvals, outbox, audit trail, edited policy and the lab clock are back to the start, and the diagram is back in place." : "Reset failed on the server; the view was reloaded.");
  }, [lab.reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const onKeyTab = (e, i) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    select(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  };

  const banner = story && mode ? story.banner[mode] : BANNER_UNKNOWN;
  const ready = story && mode;
  const props = { story, mode, vertical, lab };
  return (
    <div className={`app${presenter ? " app--presenter" : ""}`}>
      <header className="shell-bar">
        <span className="shell-brand">
          <span className="shell-logo" aria-hidden="true">P</span>
          <h1>AI Policies LAB</h1>
        </span>
        <span className="shell-right">
          {!presenter && story && <span className="shell-intro">{story.intro}</span>}
          <ShelfLink />
          <div className="seg" role="group" aria-label="Mode">
            <button type="button" aria-pressed={mode === "mock"} onClick={() => setMode("mock")} data-testid="mode-mock">Mock</button>
            <button type="button" aria-pressed={mode === "live"} onClick={() => setMode("live")} data-testid="mode-live">Live</button>
          </div>
          <label className="shell-theme">Theme
            <select value={theme} onChange={(e) => pickTheme(e.target.value)}>
              {THEMES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          <span className="chip" data-testid="mode">Mode: {mode || "..."}{mode === "live" ? " (local engine, loopback)" : mode === "mock" ? " (tables)" : ""}</span>
          {!presenter && (
            <label className="inline">Vertical{" "}
              <select value={vertical} onChange={(e) => setVertical(e.target.value)} data-testid="vertical">
                {(story ? story.verticals : ["finance"]).map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
          )}
          <button type="button" onClick={reset} data-testid="reset">Reset</button>
          <button type="button" aria-pressed={presenter} onClick={() => setPresenter((v) => !v)} data-testid="presenter">{presenter ? "Exit presenter (Esc)" : "Presenter (P)"}</button>
        </span>
        <div role="tablist" aria-label="Lab sections" className="tabs shell-nav" ref={tabsRef}>
          {TABS.map((t, i) => (
            <button key={t.id} id={`tab-${t.id}`} role="tab" type="button" aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} tabIndex={tab === t.id ? 0 : -1}
              onClick={() => select(t.id)} onKeyDown={(e) => onKeyTab(e, i)}>{t.label}</button>
          ))}
        </div>
        {modeError && <p className="app-error" role="alert" data-testid="mode-error">{modeError}</p>}
      </header>
      <main>
        <p className="banner" role="status" data-state={mode === "live" ? "live" : "mock"} data-testid="banner">{banner}</p>
        <p className="sr-only" role="status" aria-live="polite">{resetMsg}</p>
        <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
          {error || lab.error ? <p className="app-error" role="alert">Could not load the lab ({error || lab.error}). Is the server running?</p> : !ready ? <p className="muted">Loading...</p> : (
            <>
              {presenter && tab !== "talk" && (
                <aside className="presenter-say" data-testid="presenter-say" aria-label="Talk track">
                  {story.talkTrack.filter((t) => (PRESENTER_TALK[tab] || []).includes(t.id)).map((t) => <p key={t.id}><strong>{t.title}.</strong> {t.say}</p>)}
                </aside>
              )}
              {tab === "evaluate" && <EvaluateTab {...props} ev={ev} scenarioId={scenarioId} setScenarioId={setScenarioId} step={step} setStep={setStep} />}
              {tab === "policies" && <PoliciesTab {...props} />}
              {tab === "approvals" && <ApprovalsTab {...props} ev={ev} />}
              {tab === "where" && <WhereTab {...props} ev={ev} presets={presets} />}
              {tab === "closed" && <FailClosedTab {...props} ev={ev} presets={presets} />}
              {tab === "diagram" && <DiagramTab vertical={vertical} resetSignal={resetSignal} />}
              {tab === "talk" && <TalkTrack talk={story.talkTrack} />}
              {mode === "live" && ["evaluate", "policies", "approvals", "where", "closed"].includes(tab) && <LastAction last={lab.last} />}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
