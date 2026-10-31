import test from 'node:test';
import assert from 'node:assert/strict';
import { WORKSPACE_RE, createWorkspaces, workspaceFrom } from '../src/workspaces.js';
import { VERTICALS } from '../src/cast.js';

const C = VERTICALS.finance;
test('workspaceFrom defaults, accepts a good id and refuses a bad one', () => {
  assert.equal(workspaceFrom({ headers: {} }), 'default');
  assert.equal(workspaceFrom({ headers: { 'x-workspace': 'abc-1' } }), 'abc-1');
  for (const bad of ['', 'A', 'a b', 'a/b', 'x'.repeat(41), ['a'], '__proto__']) assert.equal(workspaceFrom({ headers: { 'x-workspace': bad } }), bad === '__proto__' ? null : null);
  assert.ok(WORKSPACE_RE.test('a'));
});

test('engines are per workspace and per vertical, created on first use, and reset clears the workspace only', () => {
  const w = createWorkspaces();
  const a = w.engine('a', 'finance', C); const a2 = w.engine('a', 'finance', C); const ah = w.engine('a', 'health', VERTICALS.health); const b = w.engine('b', 'finance', C);
  assert.equal(a, a2); assert.notEqual(a, ah); assert.notEqual(a, b);
  assert.equal(w.peek('a', 'finance'), a); assert.equal(w.peek('zzz', 'finance'), null); assert.equal(w.peek('a', 'retail'), null);
  assert.equal(w.size(), 2, 'a peek never creates a workspace');
  w.reset('a');
  assert.equal(w.peek('a', 'finance'), null); assert.equal(w.peek('b', 'finance'), b);
});

test('the store never evicts: at the cap a NEW id is refused (503), existing ids keep working, and only an idle workspace expires', () => {
  let t = 0;
  const w = createWorkspaces({ max: 3, ttlMs: 100, now: () => t });
  const a = w.engine('a', 'finance', C);
  for (const id of ['b', 'c']) w.engine(id, 'finance', C);
  assert.equal(w.size(), 3);
  assert.throws(() => w.engine('d', 'finance', C), (e) => e.status === 503 && e.code === 'workspaces_full');
  assert.throws(() => w.engine('e', 'finance', C), (e) => e.status === 503);
  assert.equal(w.peek('a', 'finance'), a, 'nothing was evicted');
  assert.equal(w.engine('a', 'health', VERTICALS.health) !== a, true, 'an existing workspace can still open another vertical');
  assert.equal(w.size(), 3);
  assert.equal(w.peek('d', 'finance'), null, 'a refused id left nothing behind');
  w.reset('b'); assert.equal(w.size(), 2); w.engine('d', 'finance', C); assert.equal(w.size(), 3, 'a Reset frees a slot');
  t = 90; w.engine('a', 'finance', C);  // a is touched, so it is no longer idle
  t = 150;
  assert.equal(w.peek('a', 'finance'), a, 'a recently used workspace stays');
  assert.equal(w.peek('c', 'finance'), null, 'an idle one expires');
  assert.equal(w.size(), 1);
  w.engine('x', 'finance', C); assert.equal(w.size(), 2, 'idle expiry freed slots');
});
