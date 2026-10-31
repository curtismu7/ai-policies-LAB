import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULT_CAST, VERTICALS } from '../src/cast.js';
import { buildStory, renderTalkTrackMarkdown } from '../src/story.js';
import { BANNER, CLAIM_LABEL, CLAIMS, FIELD_SOURCES, NOT_DEMONSTRATED, TALK_TRACK, WHY } from '../src/data.js';
import { maskDeep } from '../src/mask.js';
import { DIAGRAM_NAMES, buildDiagram, loadDiagram, rawDiagram } from '../src/diagramData.js';
import { validateDiagram } from '../src/diagramStudioValidate.js';

test('the banner says it is simulated and a Ping claim UNVERIFIED on our tenant, and names its mode', () => {
  for (const [mode, re] of [['mock', /MOCK mode/], ['live', /LIVE mode/]]) { assert.match(BANNER[mode], /SIMULATED/); assert.match(BANNER[mode], re); assert.match(BANNER[mode], /UNVERIFIED on our tenant/); }
  assert.equal(CLAIM_LABEL, 'Ping release claim, UNVERIFIED on our tenant');
});
test('every field is tagged: deck claim, console swagger name (schema only), lab reading, lab-invented or measured (our note)', () => {
  assert.ok(FIELD_SOURCES.length >= 15);
  for (const f of FIELD_SOURCES) { assert.ok(['deck', 'swagger', 'reading', 'invented', 'measured'].includes(f.source), f.field); assert.ok(f.note.length > 20); }
  const story = buildStory(DEFAULT_CAST, 'finance');
  assert.deepEqual([...new Set(story.fieldSources.map((f) => f.sourceLabel))].sort(), ['console swagger name (schema only)', 'deck claim', 'lab reading', 'lab-invented', 'measured (our note)']);
  const sw = FIELD_SOURCES.filter((f) => f.source === 'swagger').map((f) => f.field).join(' ');
  for (const n of ['ApproverNotifications', 'Hitl', 'RetiredAt', 'context.behaviour']) assert.ok(sw.includes(n), n);
});
test('the cut-off deck line is labelled a lab reading, in the claims, the field table and the not-demonstrated list', () => {
  assert.match(CLAIMS.find((c) => c.id === 'closed').claim, /cut off/);
  assert.match(FIELD_SOURCES.find((f) => /does not exist/.test(f.field)).note, /LAB READING OF A PARTLY-CUT-OFF DECK LINE/);
  assert.ok(NOT_DEMONSTRATED.some((n) => /partly-cut-off deck line, not the deck's words/.test(n)));
});
test('deck claims cite slide 52 (and 48 for the related note); our own notes are labelled measured, never deck; nothing says "door"', () => {
  assert.ok(CLAIMS.every((c) => [52, 48].includes(c.slide)));
  const s = JSON.stringify(buildStory(DEFAULT_CAST, 'finance'));
  assert.ok(!/\bdoor\b/i.test(s));
  for (const f of FIELD_SOURCES.filter((x) => /Cedar|Transaction grants/.test(x.field))) assert.equal(f.source, 'measured');
  assert.match(s, /privilege-demo/); assert.match(s, /agent-gateway-inspector/);
});
test('the talk track has the Why it matters entry (challenge, technical, business), marked as Ping claims', () => {
  const t = TALK_TRACK.find((x) => x.id === 'why-ai-policies');
  for (const part of ['Challenge:', 'Technical:', 'Business:']) assert.match(t.say, new RegExp(part));
  assert.match(t.say, /Ping claims, unverified on our tenant/); assert.match(WHY.technical, /[Ff]our layered scope checks/); assert.match(WHY.business, /unattended agents in regulated processes/);
});
test('docs/talk-track.md is exactly what the generator makes (no drift)', () => {
  const text = fs.readFileSync(new URL('../../docs/talk-track.md', import.meta.url), 'utf8');
  assert.equal(text, renderTalkTrackMarkdown(DEFAULT_CAST)); assert.ok(!/\{\{/.test(text));
});
test('the response mask leaves every vertical\'s story untouched (it only changes credential-shaped values)', () => {
  for (const [v, c] of Object.entries(VERTICALS)) { const s = buildStory(c, v); assert.deepEqual(maskDeep(s), s, v); }
});
test('the diagrams are diagram-studio/1 data, valid, loaded by name, with no overlapping node positions', () => {
  assert.deepEqual(DIAGRAM_NAMES, ['layers-and-hold', 'where-it-runs']);
  for (const n of DIAGRAM_NAMES) {
    assert.deepEqual(validateDiagram(loadDiagram(n)), []);
    const d = rawDiagram(n); assert.equal(d.schema, 'diagram-studio/1');
    const boxes = d.nodes.map((x) => ({ x: x.x, y: x.y }));
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(Math.abs(boxes[i].x - boxes[j].x) >= 260 || Math.abs(boxes[i].y - boxes[j].y) >= 130, `${n}: ${d.nodes[i].id} and ${d.nodes[j].id} overlap`);
    assert.equal(d.steps.length, d.edges.length, 'every edge is a step');
    const b = buildDiagram(DEFAULT_CAST, n); assert.ok(!/\{\{/.test(JSON.stringify(b)));
  }
  assert.equal(buildDiagram(DEFAULT_CAST, 'nope').name, 'layers-and-hold');
  assert.ok(validateDiagram({ ...rawDiagram('layers-and-hold'), schema: 'x' }).length > 0);
});
test('the "where it runs" diagram has no edge from an inspection to a hold', () => {
  const d = rawDiagram('where-it-runs');
  const id = (l) => d.nodes.find((n) => n.label.startsWith(l)).id;
  assert.ok(!d.edges.some((e) => [id('Request examined'), id('Reply examined')].includes(e.source) && e.target === id('Hold')));
});
