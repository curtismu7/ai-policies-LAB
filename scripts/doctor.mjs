// Preflight: the same checks GET /api/health reports from, plus whether the port is free, plus one real run of the engine through the HTTP API
// (mint a token, a hold, an approval, the retry) on a throwaway port. Prints only pass/fail lines, never a setting's value. Exit 1 on failure.
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => import(pathToFileURL(path.join(root, p)));
const { installNetguard } = await load('server/src/netguard.js');
installNetguard();
const { applySharedSettings } = await load('server/src/settings.js');
applySharedSettings();

const { runChecks } = await load('server/src/doctor.js');
let failed = 0;
const report = (level, name, detail) => { if (level === 'fail') failed++; console.log(`${level.toUpperCase().padEnd(4)}  ${name}: ${detail}`); };
for (const c of await runChecks()) report(c.level, c.id, c.detail);

// A real cycle through the HTTP layer, in this process, on an ephemeral loopback port.
try {
  const { createApp, startHttpServer } = await load('server/src/app.js');
  const { createHealth } = await load('server/src/health.js');
  const health = createHealth({ runChecks: async () => [], intervalMs: 3_600_000 });
  const { server, url } = await startHttpServer({ port: 0, host: '127.0.0.1', app: createApp({ health }) });
  try {
    const base = url.replace(/\/$/, ''); const h = { 'content-type': 'application/json', origin: base, 'x-workspace': 'doctor' };
    const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', headers: h, body: JSON.stringify({ mode: 'live', vertical: 'finance', ...b }) }); return { status: r.status, body: await r.json() }; };
    const cast = (await (await fetch(`${base}/api/story?vertical=finance`)).json()).cast;
    const minted = await post('/api/token', { token: { claims: { sub: cast.castAgent, surfaces: ['tool'], scope: `${cast.castApp}:write`, department: cast.castDept, end_user: cast.castUser } } });
    const request = { route: `/mcp/${cast.castApp}`, tool: cast.castToolHold, arguments: { record: cast.castRecord, newValue: cast.castNewValue }, token: minted.body.result?.labToken };
    const first = await post('/api/evaluate', { request });
    const signed = await post(`/api/approvals/${first.body.result?.approval?.ref}/decision`, { decision: { approver: cast.castApprover, decision: 'approve', authLevel: 2 } });
    const retry = await post('/api/evaluate', { request });
    const replay = await post('/api/evaluate', { request: { ...request, approvalRef: first.body.result?.approval?.ref } });
    const ok = first.status === 403 && first.body.result.outcome === 'hold' && signed.status === 200 && retry.status === 200 && retry.body.result.outcome === 'allow' && replay.body.result?.code === 'approval_consumed';
    report(ok ? 'pass' : 'fail', 'engine-cycle', ok ? 'a real RS256 token was minted, the call was held (403 with a reference), an approver signed, the retry proceeded, and replaying the spent approval was refused' : 'the mint, hold, approve, retry cycle did not complete');
  } finally { health.stop(); await new Promise((res) => server.close(res)); }
} catch { report('fail', 'engine-cycle', 'the HTTP cycle could not run'); }

const port = Number(process.env.PORT) || 7500;
await new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', (e) => { report('fail', 'port-free', `${port} is not free (${e.code}). Set PORT to a free port in 7500-7549`); resolve(); });
  s.listen(port, '127.0.0.1', () => s.close(() => { report('pass', 'port-free', `${port} is free`); resolve(); }));
});
process.exit(failed ? 1 : 0);
