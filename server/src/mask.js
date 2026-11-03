// The lab's masker: one shared-masker 1.4.0 instance (./shared/mask.js, copied from shared-masker commit 9bc664a; do not edit that file, change the canonical module and copy
// again). Every API answer passes through maskDeep (values AND object keys), so a credential-shaped value can never leave in any field even if a code path forgot to clean
// its input. Masking is a heuristic: it catches the shapes the shared README lists, not every secret. The page and the README say so.
import { createMasker } from './shared/mask.js';

const HEX = /^[0-9a-f]+$/;
const isHex = (v, n) => typeof v === 'string' && v.length === n && HEX.test(v);
// Values the lab writes itself that are long and look like a secret but are not one. They are left as they are ONLY when the value has the exact shape the lab writes,
// so a visitor who types a key called `hash` or `labToken` gets no free pass for a credential under it:
//   hash, callHash  a SHA-256 of the canonical call (64 hex characters; written by canon.js)
//   traceId         a W3C trace id (32 hex characters; written by trace.js)
//   traceparent     a W3C traceparent header value (written by trace.js)
//   labToken        the mock-issued token, signed by the lab's own throwaway key and labelled mock-issued; only at result.labToken of the mint answer, as a three-part JWT
const OPAQUE_SHAPE = {
  hash: (v) => isHex(v, 64),
  callhash: (v) => isHex(v, 64),
  traceid: (v) => isHex(v, 32),
  traceparent: (v) => typeof v === 'string' && /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(v),
  labtoken: (v, path) => path === 'result.labToken' && typeof v === 'string' && v.length <= 4096 && /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(v),
};
const opaque = (key, path, value) => OPAQUE_SHAPE[String(key).toLowerCase()]?.(value, path) === true;
// The default bounds (20,000 nodes, 1,000,000 characters per answer) are for unknown input. The lab's own answers are bounded by the lab (a workspace holds at most 500 audit
// entries and 200 approvals; the Mock table is about 460 kB), so the bounds are raised to what those caps can fill, and an answer that still passes them is cut with a mark.
const BOUNDS = { maxNodes: 400000, maxTotalChars: 4000000 };
const masker = createMasker({ opaque, ...BOUNDS });
// The lab's own prose and tables (the story, the diagrams, the Mock tables, /info): written by the lab, never typed by a visitor, and full of ordinary uses of the
// words password, token and secret as words ("authLevels": { "1": "password", "2": "push approval" } is not a credential pair). keyMode 'none' never reads a key name there;
// secret-looking TEXT inside a value (a token, "password=hunter2xyz") and a key that is itself a credential are still masked. Answers that carry anything a visitor typed use maskDeep.
const prose = createMasker({ opaque, keyMode: 'none', ...BOUNDS });

export const { maskText, maskDeep, looksLikeCredential, isCredentialId } = masker;
export const maskProse = prose.maskDeep;
