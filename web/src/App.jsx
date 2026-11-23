import { useCallback, useEffect, useMemo, useState } from "react";
import TopMenu, { applyFontSize } from "./top-menu/TopMenu";
import ShelfLink from "./components/ShelfLink";
import VerifyMark from "./components/VerifyMark";
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
import GatewayHop from "./components/GatewayHop";
import RunObs from "./components/RunObs";

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
const TAIL = "Every product claim is a Ping release claim, UNVERIFIED on our tenant (release 2026-11-02). No identity provider, chat tool or tenant is called; the only real call is the optional Privilege gateway card, in Real.";
export const BANNER_UNKNOWN = `SIMULATED, MOCK or LIVE mode (Mock is loopback only with no outbound network). ${TAIL}`;
// The tabs that run or show the engine: the run panel (rule 27) and the last action sit under them, not under the diagram or the talk track.
const WORKING_TABS = ["evaluate", "policies", "approvals", "where", "closed"];
const PRESENTER_TALK = { evaluate: ["say-first", "two-controls", "four-layers"], policies: ["four-layers"], approvals: ["hold", "bound", "period"], where: ["where", "hard"], closed: ["closed"], diagram: ["why-ai-policies"] };

const THEME_KEY = "aip.theme";
const FONT_KEY = "aip.font";
function initialTheme() {
  try { const t = localStorage.getItem(THEME_KEY); if (t === "light" || t === "dark") return t; } catch { /* storage blocked */ }
  return "auto";
}
function initialFont() {
  try { const f = localStorage.getItem(FONT_KEY); if (f === "S" || f === "M" || f === "L") return f; } catch { /* storage blocked */ }
  return "M";
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
  // Rule 27: where the page's gateway check (the card, in Real) is, so the run panel asks for THAT check's record and never shows an older one.
  const [check, setCheck] = useState({ phase: "checking" });
  const onCheck = useCallback((next) => setCheck(next.phase === "done" ? { phase: "done", runId: typeof next.runId === "string" ? next.runId : null } : { phase: next.phase, reason: next.reason }), []);
  const [resetSignal, setResetSignal] = useState(0);
  const [resetMsg, setResetMsg] = useState("");
  const [theme, setTheme] = useState(initialTheme);
  const [fontStep, setFontStep] = useState(initialFont);
  const pickTheme = (next) => {
    try { if (next === "auto") localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, next); } catch { /* not remembered */ }
    setTheme(next);
  };
  // The picker only sets data-theme; the shared stylesheet does the rest ("auto" follows the system setting).
  useEffect(() => { if (theme === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => { applyFontSize(fontStep); try { localStorage.setItem(FONT_KEY, fontStep); } catch { /* not remembered */ } }, [fontStep]);
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
  // mode badge and every tab reflect the mode the server answered with.
  const [modeError, setModeError] = useState(null);
  const setMode = async (m) => {
    setModeError(null);
    const r = await postJson("/api/mode", { source: m === "live" ? "real" : "mock" });
    if (!r.ok) { setModeError(r.body?.detail || r.body?.error || `HTTP ${r.status}`); return; }
    if (m === "live" && mode !== "live") setCheck({ phase: "checking" }); // entering Real mounts the gateway card, which runs a new check
    setModeState(r.body?.mode || m);
    await lab.reload();
  };
  const select = (id) => { setTab(id); try { window.history.replaceState(null, "", `#${id}`); } catch { /* ignore */ } };

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

  const banner = story && mode ? story.banner[mode] : BANNER_UNKNOWN;
  const ready = story && mode;
  const props = { story, mode, vertical, lab };
  return (
    <div className={`app${presenter ? " app--presenter" : ""}`}>
      <header className="shell-bar">
        <span className="shell-brand">
          <span className="shell-logo" aria-hidden="true">AIP</span>
          <h1>AI Policies LAB</h1>
          <span className={`shell-badge${mode === "live" ? " shell-badge--real" : ""}`} data-testid="mode"
            title={mode === "live" ? "Live: the local engine, loopback" : mode === "mock" ? "Mock: tables" : undefined}>{mode === "live" ? "Live" : mode === "mock" ? "Mock" : "..."}</span>
        </span>
        <nav className="shell-nav" aria-label="Lab sections">
          {TABS.map((t) => (
            <a key={t.id} href={`#${t.id}`} aria-current={tab === t.id ? "page" : undefined}
              onClick={(e) => { e.preventDefault(); select(t.id); }}>{t.label}</a>
          ))}
        </nav>
        <TopMenu
          mode={{ value: mode === "live" ? "real" : "mock", onChange: (v) => setMode(v === "real" ? "live" : "mock"), realAvailable: true }}
          vertical={{ value: vertical, onChange: setVertical, options: story ? story.verticals : ["finance"] }}
          theme={{ value: theme, onChange: pickTheme }}
          fontSize={{ value: fontStep, onChange: setFontStep }}
          present={{ active: presenter, onToggle: () => setPresenter((v) => !v) }}
          talkTrack={{ active: tab === "talk", onToggle: () => select("talk") }}
          help={{ href: "https://github.com/curtismu7/ai-policies-LAB#readme" }}
          onReset={reset}
        >
          <ShelfLink />
          <VerifyMark id="ai-policies-lab" />
        </TopMenu>
      </header>
      <main className="page">
        <p className="banner" role="status" data-state={mode === "live" ? "live" : "mock"} data-testid="banner">{banner}</p>
        {modeError && <p className="app-error" role="alert" data-testid="mode-error">{modeError}</p>}
        <p className="sr-only" role="status" aria-live="polite">{resetMsg}</p>
        {!presenter && story && <p className="page-intro">{story.intro}</p>}
        {mode === "live" && <GatewayHop onCheck={onCheck} />}
        <div id={`panel-${tab}`} className="page-panel">
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
              {mode === "live" && WORKING_TABS.includes(tab) && <LastAction last={lab.last} />}
              {WORKING_TABS.includes(tab) && <RunObs source={mode === "live" ? "real" : "mock"} vertical={vertical} scenarioId={lab.scenario?.id} check={check} />}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
