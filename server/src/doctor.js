// Preflight checks shared by `npm run doctor` and GET /api/health. Never prints a secret, needs no network.
// Each check: { id, level: 'pass' | 'info' | 'fail', detail }.
import fs from 'node:fs';
import { assertBindAllowed, bindHost, portProblem, scanHosts, scanKeys, DEFAULT_PORT, PORT_MIN, PORT_MAX } from './safety.js';
import { netguardSelfTest } from './netguard.js';
import { VERTICALS, unfilled } from './cast.js';
import { buildStory, rawStory } from './story.js';
import { Engine } from './engine.js';
import { EXPECTED, buildMockTable, runScenario, scenarioList } from './scenarios.js';
import { defaultPolicy, policyProblems } from './policies.js';
import { buildCatalog } from './catalog.js';
import { buildRoster } from './cast.js';
import { looksLikeCredential } from './credentials.js';
import { maskProse } from './mask.js';
import { modeFrom } from './config.js';
import { DIAGRAM_NAMES, buildDiagram } from './diagramData.js';
import { MOCK_TABLE } from './mockTable.js';
import { settingsPath } from './settings.js';
import { mint, verifyToken } from './token.js';
import { normalizeArguments } from './canon.js';

export const settingsFile = (env = process.env) => (env.STANDALONE_ENV ? env.STANDALONE_ENV : settingsPath(env));

export async function runChecks({ env = process.env, table = MOCK_TABLE } = {}) {
  const checks = [];
  const add = (id, level, detail) => checks.push({ id, level, detail });

  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 26 ? 'pass' : 'fail', `v${process.versions.node} (need >= 26)`);

  try { add('mode', 'pass', `${modeFrom(env)} is the opening mode (mock is the default); the header toggle switches between mock and live, both loopback-only`); }
  catch (e) { add('mode', 'fail', e.message); }

  try { add('bind', 'pass', `${assertBindAllowed(bindHost(env), env)}${env.AIPLAB_BIND ? ' (AIPLAB_BIND opt-in)' : ' (loopback)'}`); }
  catch (e) { add('bind', 'fail', e.message); }

  const port = env.PORT === undefined || env.PORT === '' ? DEFAULT_PORT : Number(env.PORT);
  const problem = portProblem(port);
  add('port-range', problem ? 'fail' : 'pass', problem || `${port} is inside ${PORT_MIN}-${PORT_MAX} and not reserved`);

  const file = settingsFile(env);
  try { const m = fs.statSync(file).mode & 0o777; add('settings-file', m & 0o077 ? 'info' : 'pass', m & 0o077 ? 'the shared settings file is readable by others: chmod 600 it' : 'the shared settings file exists and is mode 600 (values are never printed)'); }
  catch { add('settings-file', 'info', 'no shared settings file: mock mode needs none'); }

  const ctxOf = (cast) => ({ catalog: buildCatalog(cast), roster: buildRoster(cast) });
  const bad = Object.entries(VERTICALS).flatMap(([v, cast]) => policyProblems(defaultPolicy(cast), ctxOf(cast)).map((p) => `${v}/${p}`));
  add('policies', bad.length ? 'fail' : 'pass', bad.length ? bad.slice(0, 3).join('; ') : `the default policy validates in ${Object.keys(VERTICALS).length} verticals: every application, tool, scope, person and role it names exists`);

  // A real RS256 round trip, and a tampered token refused.
  const t = mint({ sub: 'x' }, { nowSec: 1000, ttlMin: 5 });
  const okTok = verifyToken(t.token, { nowSec: 1001 }).ok && !verifyToken(`${t.token.slice(0, -4)}AAAA`, { nowSec: 1001 }).ok && verifyToken(t.token, { nowSec: 1000 + 301 }).code === 'token_expired';
  add('token', okTok ? 'pass' : 'fail', okTok ? 'a real RS256 token was minted, verified, refused when tampered and refused when expired on the lab clock' : 'the RS256 round trip failed');

  const dup = normalizeArguments({ text: '{"a":1,"a":2}' });
  add('canonical', !dup.ok && dup.code === 'duplicate_key' ? 'pass' : 'fail', 'duplicate keys in the arguments are refused, so one approval cannot cover two readings of a call');

  // Each scripted step gives the result the story says it does, in every vertical, and the Mock table agrees with the engine.
  const wrong = [];
  for (const [vertical, cast] of Object.entries(VERTICALS)) {
    for (const sc of scenarioList(cast)) {
      const { steps } = runScenario(cast, sc);
      if (steps.map((s) => s.got).join() !== EXPECTED[sc.id].join()) wrong.push(`${vertical}/${sc.id}`);
    }
  }
  add('scenarios', wrong.length ? 'fail' : 'pass', wrong.length ? `scripted steps that do not give their expected result: ${wrong.slice(0, 6).join(', ')}` : `${Object.keys(EXPECTED).length} scripted scenarios give their expected results in ${Object.keys(VERTICALS).length} verticals`);

  const fresh = buildMockTable();
  add('mock-table', JSON.stringify(fresh) === JSON.stringify(table) ? 'pass' : 'fail', JSON.stringify(fresh) === JSON.stringify(table) ? 'the mock table matches the engine' : 'the mock table drifts from the engine (run npm run mock-table)');

  const raw = rawStory();
  const text = JSON.stringify(raw);
  const holes = unfilled(text, VERTICALS.finance);
  add('story-tokens', holes.length ? 'fail' : 'pass', holes.length ? `unfilled {{tokens}}: ${[...new Set(holes)].join(', ')}` : 'every {{cast}} token is filled');
  const badVert = Object.entries(VERTICALS).filter(([, v2]) => unfilled(text, v2).length).map(([k]) => k);
  add('verticals', badVert.length ? 'fail' : 'pass', badVert.length ? `verticals missing a token: ${badVert.join(', ')}` : `${Object.keys(VERTICALS).length} vertical packs fill every token`);
  const filled = JSON.stringify(Object.keys(VERTICALS).map((k) => buildStory(VERTICALS[k], k)));
  const hosts = scanHosts(filled);
  add('story-hosts', hosts.length ? 'fail' : 'pass', hosts.length ? `non-reserved hosts: ${hosts.join(', ')}` : 'every host in the story data is .invalid or .example');
  const keys = scanKeys(filled);
  const creds = looksLikeCredential(filled.replace(/"hash":"[0-9a-f]{64}"/g, '')); // a call hash is 64 hex characters on purpose
  add('story-keys', keys.length || creds ? 'fail' : 'pass', keys.length || creds ? 'credential-shaped text in the story data' : 'no credential-shaped value anywhere in the story data');
  const story = buildStory(VERTICALS.finance, 'finance');
  add('masking', JSON.stringify(maskProse(story)) === JSON.stringify(story) ? 'pass' : 'fail', 'the response mask leaves the story untouched (it only changes credential-shaped values)');
  add('mock-masking', JSON.stringify(maskProse(table)) === JSON.stringify(table) ? 'pass' : 'fail', 'the response mask leaves every Mock table untouched: no phrase in a table reads like a credential');
  const dg = DIAGRAM_NAMES.map((n) => buildDiagram(VERTICALS.finance, n));
  add('diagram-masking', JSON.stringify(maskProse(dg)) === JSON.stringify(dg) ? 'pass' : 'fail', 'the response mask leaves every diagram untouched: no phrase in a diagram reads like a credential');
  add('diagrams', DIAGRAM_NAMES.every((n) => buildDiagram(VERTICALS.finance, n).steps.length > 0) ? 'pass' : 'fail', `${DIAGRAM_NAMES.length} diagram-studio/1 diagrams load and validate`);

  const ng = await netguardSelfTest();
  add('netguard', ng.ok ? 'pass' : 'fail', ng.ok ? `blocked fetch, socket, socket-by-IP, dns lookup, dns resolve and udp to a non-loopback host (${ng.blocked}/6)` : ng.detail);

  add('tenant', 'pass', 'simulated only: no tenant, no credentials, no outbound network; every product claim is UNVERIFIED on our tenant');
  return checks;
}

export const allPassed = (checks) => checks.every((c) => c.level !== 'fail');
