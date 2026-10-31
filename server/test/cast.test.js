import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CAST, VERTICALS, buildRoster, fill, fillDeep, loadCast, unfilled, verticalFrom } from '../src/cast.js';
import { rawStory } from '../src/story.js';
import { rawDiagram, DIAGRAM_NAMES } from '../src/diagramData.js';
import { buildCatalog } from '../src/catalog.js';
import { defaultPolicy } from '../src/policies.js';
import { scenarioList } from '../src/scenarios.js';
import { scanHosts } from '../src/safety.js';

test('three vertical packs; every pack defines every token of every story text, diagram, catalog name, policy and scenario (a test fails on an undefined token)', () => {
  assert.deepEqual(Object.keys(VERTICALS), ['finance', 'health', 'retail']);
  const text = JSON.stringify([rawStory(), DIAGRAM_NAMES.map((n) => rawDiagram(n))]);
  for (const [v, cast] of Object.entries(VERTICALS)) {
    assert.deepEqual(unfilled(text, cast), [], v);
    assert.deepEqual(unfilled(JSON.stringify([buildCatalog(cast), defaultPolicy(cast), scenarioList(cast)]), cast), [], `${v}: nothing left unfilled in catalog, policy and scenarios`);
  }
  const keys = Object.keys(DEFAULT_CAST).sort();
  for (const [v, cast] of Object.entries(VERTICALS)) assert.deepEqual(Object.keys(cast).sort(), keys, `${v} has the same tokens as the default pack`);
});
test('an undefined token is reported and left visible, never replaced with something', () => {
  assert.deepEqual(unfilled('hello {{castBrand}} {{nope}} {{__proto__}} {{constructor}}', DEFAULT_CAST), ['nope', '__proto__', 'constructor']);
  assert.equal(fill('{{nope}} {{constructor}}', DEFAULT_CAST), '{{nope}} {{constructor}}');
  assert.equal(fill('{{castBrand}}', DEFAULT_CAST), 'Fabrikam Bank');
});
test('fillDeep fills nested text and survives a deep structure', () => {
  assert.deepEqual(fillDeep({ a: ['{{castHost}}', { b: '{{castBrand}}' }], n: 3 }, DEFAULT_CAST), { a: ['fabrikam', { b: 'Fabrikam Bank' }], n: 3 });
  let deep = { v: '{{castBrand}}' }; for (let i = 0; i < 50000; i++) deep = { d: deep };
  assert.doesNotThrow(() => fillDeep(deep, DEFAULT_CAST));
});
test('the roster: unique ids, humans with roles and an authentication ceiling, agents with a human custodian, two approvers, a security person', () => {
  for (const [v, cast] of Object.entries(VERTICALS)) {
    const roster = buildRoster(cast); const ids = new Set(roster.map((p) => p.id));
    assert.equal(ids.size, roster.length, `${v}: unique ids`);
    for (const p of roster.filter((x) => x.kind === 'agent')) assert.equal(roster.find((x) => x.id === p.custodian)?.kind, 'human', `${v}: ${p.id}`);
    assert.equal(roster.filter((p) => p.roles.includes(cast.castRoleApprover)).length, 2);
    assert.equal(roster.filter((p) => p.roles.includes(cast.castRoleSecurity)).length, 1);
    assert.equal(roster.filter((p) => p.kind === 'agent').length, 3);
    assert.ok(roster.filter((p) => p.kind === 'human').every((p) => p.maxAuthLevel >= 1 && p.maxAuthLevel <= 3));
  }
});
test('the packs are synthetic: only .example hosts, no email, no real company', () => {
  const t = JSON.stringify(VERTICALS);
  assert.deepEqual(scanHosts(t), []); assert.ok(!/@|https?:/.test(t));
});
test('verticalFrom only accepts a known pack, including against object-key tricks', () => {
  assert.equal(verticalFrom('health'), 'health');
  for (const bad of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', undefined, null, 5, ['health'], {}, '']) assert.equal(verticalFrom(bad), 'finance');
});
test('customer.config.json: brand, host and the first user only; bad values are ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aip-cast-')); const f = path.join(dir, 'customer.config.json');
  const w = (cast) => fs.writeFileSync(f, JSON.stringify({ cast, token: 'x' }));
  try {
    w({ brand: 'Acme Corp', host: 'acme', user: 'sam.lee' });
    const c = loadCast(f, 'health');
    assert.deepEqual([c.castBrand, c.castHost, c.castUser], ['Acme Corp', 'acme', 'sam.lee']);
    assert.equal(c.castApprover, VERTICALS.health.castApprover);
    w({ brand: 'x@y.com', host: 'a.b', user: 'Bad Name!' }); assert.deepEqual([loadCast(f).castBrand, loadCast(f).castHost, loadCast(f).castUser], [DEFAULT_CAST.castBrand, DEFAULT_CAST.castHost, DEFAULT_CAST.castUser]);
    w({ brand: 'https://evil.invalid', user: DEFAULT_CAST.castApprover }); assert.equal(loadCast(f).castUser, DEFAULT_CAST.castUser, 'cannot collide with another person');
    w({ brand: 'Acme‮evil' }); assert.ok(!/‮/.test(loadCast(f).castBrand));
    fs.writeFileSync(f, 'not json'); assert.equal(loadCast(f).castBrand, DEFAULT_CAST.castBrand);
    assert.equal(loadCast('/nonexistent').castBrand, DEFAULT_CAST.castBrand);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
