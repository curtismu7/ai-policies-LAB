// JsonPane.css is vendored from curtismu7/AI-DEMO-Standalone shared/json (the owner's neutral pressed-toggle decision, 2026-11-21).
// The lab's copy must match its own pin file AND the canonical bytes, so an edited copy with a rewritten pin is caught.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS = 'web/src/components/JsonPane.css';
const PIN = 'web/src/components/JsonPane.css.sha256';
// sha256 of the canonical shared/json/JsonPane.css (the neutral re-vendor, #32 on main)
const CANONICAL_SHA256 = '1e794d9470cf3b42d82b99927fcdcc41e5f61024afac92c926cae7afb66a8fbc';
const sha = (p) => createHash('sha256').update(fs.readFileSync(path.join(root, p))).digest('hex');

test('JsonPane.css is the canonical neutral re-vendor, and its pin file names those bytes', () => {
  assert.equal(sha(CSS), CANONICAL_SHA256, 'the vendored bytes are the canonical JsonPane.css');
  const pinned = fs.readFileSync(path.join(root, PIN), 'utf8').trim().split(/\s+/)[0];
  assert.equal(pinned, CANONICAL_SHA256, 'the pin file names the canonical hash');
});
