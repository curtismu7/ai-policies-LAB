// Builds content-pack.json for the Learning Hub from the story data, so the pack cannot drift from the lab.
//   node scripts/build-content-pack.mjs        (writes content-pack.json)
// The pack uses .invalid placeholders and no documentation URLs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CAST } from '../server/src/cast.js';
import { buildStory } from '../server/src/story.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const UNV = 'Ping release claim, UNVERIFIED on our tenant.';

export function buildPack() {
  const story = buildStory(DEFAULT_CAST, 'finance');
  const sid = (n) => `S${String(n).padStart(2, '0')}`;
  const terms = {
    'four-layers': ['surface-scope', 'application-policy', 'action-scope', 'end-user-scope'], 'hold-and-retry': ['third-outcome', 'no-held-connection', 'bound-approval'],
    'hard-denial': ['hard-denial', 'third-outcome'], 'period-approval': ['bound-approval', 'lab-clock'], 'post-inspection': ['where-it-runs', 'hard-denial'], 'fail-closed': ['fail-closed', 'canonical-hash'],
  };
  const why = (id) => story.talkTrack.find((t) => t.id === id).say;
  return {
    schema: 'demo-content-pack/1',
    id: 'ai-policies-lab',
    title: 'AI Policies LAB',
    version,
    demo: { id: 'ai-policies-lab', name: 'AI Policies LAB', catalog: 'D109', baseUrl: 'http://localhost:7500', doctor: '/api/health', tags: ['ai-policies', 'scope', 'hitl', 'approval', 'attended-unattended', 'fail-closed', 'simulated'] },
    glossary: [
      { id: 'surface-scope', term: 'Surface scope', definition: `Which gateway surface a credential may touch at all: a model, a tool server or a peer agent. Derived from the route, so it is refused before any policy is consulted; the owning identity caps the key. The lab's route prefixes (/llm/, /mcp/, /a2a/) are lab-invented. ${UNV}`, aliases: ['identity caps the key'] },
      { id: 'application-policy', term: 'Application policy', definition: `Which applications an identity reaches, and which claims the presented token must carry before an application is reachable. ${UNV}`, aliases: ['required claims'] },
      { id: 'action-scope', term: 'Action scope', definition: `Which actions are permitted inside an application the caller can already reach, read from the verified token and never from anything the caller supplies. A rule can require a specific scope before a tool may be invoked. ${UNV}`, aliases: ['scope from the token'] },
      { id: 'end-user-scope', term: 'End-user scope', definition: `The only layer that reaches past the service identity, to what the person behind the agent may do. It needs an identity that resolves to a real user; a rule naming a person who could never be identified is refused when it is saved. ${UNV}`, aliases: ['person behind the agent'] },
      { id: 'third-outcome', term: 'The third outcome: hold for a person', definition: `Policy is asked whether a call may proceed attended and whether it may proceed unattended. Allow-then-deny means hold for a human; a rule that refuses the attended form is a hard denial. ${UNV}`, aliases: ['hold', 'HITL', 'attended and unattended'] },
      { id: 'hard-denial', term: 'Hard denial', definition: `A refusal of the attended form: no approval path exists, and presenting an approval changes nothing. Inspection rules can refuse a call or withhold a result but can never hold it. ${UNV}`, aliases: ['no approval can lift it'] },
      { id: 'no-held-connection', term: 'No held connection', definition: `An approval takes minutes to hours, so the request is refused at once with a reason, a reference and an owning expiry instead of being held open. The agent retries after an approver signs. ${UNV}`, aliases: ['retry'] },
      { id: 'bound-approval', term: 'Bound, single-use approval', definition: `An approval is single-use and bound to the exact call, or to a fixed period, with a number of approvers, named roles and a minimum authentication strength. It cannot be replayed for a second transaction, and it is an input to the next evaluation, not a bypass. The lab's approval record, states and the 1-3 authentication levels are lab-invented. ${UNV}`, aliases: ['single-use', 'period grant'] },
      { id: 'canonical-hash', term: 'Canonical call hash', definition: `The deck says an approval is bound to a canonical hash of method, target and arguments. The canonical form (key order, Unicode NFC, number formats, refused inputs) is LAB-INVENTED, written so one approval cannot cover a call it was not given for. ${UNV}`, aliases: ['call hash'] },
      { id: 'where-it-runs', term: 'Where it can run', definition: `A hold can only happen before the call is made. Rules that read inspection findings run after the request has been examined or after the reply has come back: refuse the call or withhold the result, never hold. ${UNV}`, aliases: ['pre-call', 'post-inspection'] },
      { id: 'fail-closed', term: 'Fails closed', definition: `An evaluation error denies and an argument of the wrong type denies. The rest of the slide line is cut off in the PDF: the lab refuses a rule naming something that does not exist when it is saved, as a lab reading of a partly-cut-off deck line, not the deck's words. ${UNV}`, aliases: ['deny on error'] },
      { id: 'lab-clock', term: 'The lab clock', definition: 'A clock the visitor advances so approval expiry, periods and token lifetime can be seen. It only moves forward. Lab-invented.', aliases: [] },
    ],
    sources: [
      { id: 'deck-slides', title: 'Ping ID4AI Workforce H2 2026 deck, slide 52 (with 35, 36 and 48)', url: 'https://example.invalid/ping-id4ai-workforce-h2-2026-deck', kind: 'deck', use: 'The AI Policies release claims.', status: 'read', checked: '2026-10-31' },
      { id: 'our-notes', title: 'Our own notes on hold, hard refusal and token-scope gating (measured on our tenant, not the deck)', url: 'https://example.invalid/our-privilege-notes', kind: 'note', use: 'Labelled "measured (our note)" wherever the lab uses them.', status: 'read', checked: '2026-10-31' },
    ],
    cards: [
      ...story.scenarios.map((sc, i) => ({ id: `try-${sc.id}`, label: `Scenario ${i + 1}: ${sc.title}`, description: sc.say, group: 'try-it', action: { type: 'route', href: '/#evaluate' }, terms: terms[sc.id], story: sid(i + 1) })),
      { id: 'try-policies', label: 'Save a rule that names a person who does not exist', description: 'In Live mode, edit the end-user rules and add a name that is not in the roster: the save is refused with the reason.', group: 'try-it', action: { type: 'route', href: '/#policies' }, terms: ['end-user-scope', 'fail-closed'] },
      { id: 'try-approvals', label: 'Approve as the wrong person', description: 'Act as the requester, someone without the role, or sign in too weakly: the lab refuses and says why.', group: 'try-it', action: { type: 'route', href: '/#approvals' }, terms: ['bound-approval', 'third-outcome'] },
      { id: 'concept-why-ai-policies', label: 'Why it matters: AI Policies, scope and HITL (slide 52)', description: why('why-ai-policies'), group: 'concept', action: { type: 'route', href: '/#talk' }, terms: ['third-outcome', 'end-user-scope', 'bound-approval'] },
      { id: 'concept-where', label: 'Where it can run', description: 'Pre-call: allow, deny, hold. Post-inspection: refuse the call or withhold the result.', group: 'concept', action: { type: 'route', href: '/#where' }, terms: ['where-it-runs', 'hard-denial'] },
      { id: 'concept-diagram', label: 'Diagrams', description: 'Two diagrams: one call through the four layers; and where it can run.', group: 'concept', action: { type: 'route', href: '/#diagram' }, terms: ['third-outcome', 'where-it-runs'] },
      { id: 'ref-doctor', label: 'Doctor and health', description: 'Preflight checks and the demo-health/1 endpoint.', group: 'setup', action: { type: 'route', href: '/api/health' } },
    ],
    stories: story.scenarios.map((sc, i) => ({ id: sid(i + 1), title: sc.title, say: sc.say })),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(path.join(ROOT, 'content-pack.json'), `${JSON.stringify(buildPack(), null, 2)}\n`);
  console.log('wrote content-pack.json');
}
