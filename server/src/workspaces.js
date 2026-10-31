// Rule 13: a workspace id keeps one visitor's state apart from another's. Server state per workspace is one access Engine per vertical
// (approvals, outbox, audit trail, policy and the lab clock). Bounded in count and age: at the cap a NEW id is REFUSED (503), nothing is ever evicted.
// The browser sends its id in X-Workspace (default "default"). Reset clears the current workspace only.
import { Engine } from './engine.js';
import { refuse } from './errors.js';
import { looksLikeCredential } from './credentials.js';

export const WORKSPACE_RE = /^[a-z0-9-]{1,40}$/;
export const DEFAULT_WORKSPACE = 'default';

export function workspaceFrom(req) {
  const raw = req.headers['x-workspace'];
  if (raw === undefined) return DEFAULT_WORKSPACE;
  // An id that looks like a credential (a 40-hex token, a long mixed run) is refused rather than echoed back in the `workspace` field and the hop headers.
  return typeof raw === 'string' && WORKSPACE_RE.test(raw) && !looksLikeCredential(raw) ? raw : null;
}

export function createWorkspaces({ max = 500, ttlMs = 60 * 60 * 1000, now = Date.now } = {}) {
  const map = new Map(); // id -> { engines: Map(vertical -> Engine), at }; insertion order = least recently used first
  // Only IDLE workspaces go: one untouched for longer than ttlMs. A workspace that is in use is never evicted to make room for another.
  const sweep = () => {
    const t = now();
    for (const [id, v] of map) { if (t - v.at > ttlMs) map.delete(id); else break; }
  };
  // The workspace for this id. A known id is refreshed. An unknown id at the cap is refused (WorkspacesFull): flooding with new ids cannot wipe anyone else's state.
  const touch = (id) => {
    sweep();
    let v = map.get(id);
    if (!v) {
      if (map.size >= max) throw refuse('workspaces_full', `the lab is holding its maximum of ${max} workspaces and none has been idle for ${Math.round(ttlMs / 60000)} minutes: try again later, or Reset an old tab's workspace`, 503);
      v = { engines: new Map(), at: 0 };
    }
    v.at = now(); map.delete(id); map.set(id, v);
    return v;
  };
  return {
    // The engine for this workspace and vertical, created on first use with the cast of that moment. Throws a 503 refusal for a new id at the cap.
    engine(id, vertical, cast) {
      const v = touch(id);
      if (!v.engines.has(vertical)) v.engines.set(vertical, new Engine(cast));
      return v.engines.get(vertical);
    },
    // Read-only look: the engine if the workspace has one, else null (nothing is created, nothing is refreshed).
    peek(id, vertical) { sweep(); return map.get(id)?.engines.get(vertical) || null; },
    reset(id) { map.delete(id); },
    size() { sweep(); return map.size; },
  };
}
