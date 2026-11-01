// Rule 13: each browser tab gets its own workspace id, kept in sessionStorage, and sends it as X-Workspace on every API call
// that touches server state. Storage can be blocked, so a failure falls back to a per-load id.
const KEY = "aip.workspace";
let memo = null;

// Tests only: forget the id held in memory so the next call picks a new one.
export const forgetWorkspace = () => { memo = null; };

const newId = () => {
  const bytes = new Uint8Array(8);
  (window.crypto || { getRandomValues: (a) => a.map(() => Math.floor(Math.random() * 256)) }).getRandomValues(bytes);
  return `w-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
};

// Replace the id (the stored one was refused by the server): a fresh id is stored in its place.
export function renewWorkspace() {
  memo = newId();
  try { window.sessionStorage.setItem(KEY, memo); } catch { /* blocked */ }
  return memo;
}

export function workspaceId() {
  if (memo) return memo;
  try { const saved = window.sessionStorage.getItem(KEY); if (saved && /^[a-z0-9-]{1,40}$/.test(saved)) return (memo = saved); } catch { /* blocked */ }
  return renewWorkspace();
}

const send = (url, opts) => fetch(url, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}), "x-workspace": workspaceId() } });

// A stored id can pass the browser's pattern and still be refused by the server (it looks like a credential, say). Then the tab would be stuck, and Reset with it:
// on a 400 bad_workspace the id is replaced and the request is sent once more.
export async function workspaceFetch(url, opts = {}) {
  const r = await send(url, opts);
  if (r.status !== 400) return r;
  let body = null;
  try { body = await r.clone().json(); } catch { /* not JSON */ }
  if (body?.error !== "bad_workspace") return r;
  renewWorkspace();
  return send(url, opts);
}
