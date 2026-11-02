// Credential-shaped text. Anything a visitor types that looks like a token, a key, a password or key material is masked on the way IN (reason, comment, claims, arguments)
// so the raw value never enters state, a receipt, an outbox entry, a hop pane, a log line or an error. The detection is the shared masker (./mask.js, shared-masker 1.4.0);
// this file keeps the lab's own small helpers around it (the length caps, the display tidy-up, the credential-word key test, the inspector's normaliser).
import { isCredentialId, looksLikeCredential, maskDeep, maskText } from './mask.js';

export const MAX_FREE = 400;
// The inspector (inspect.js) reads at most this many characters of one text; the engine refuses a reply longer than that instead of reading part of it.
export const MAX_SCAN = 200000;
export { isCredentialId, looksLikeCredential, maskText };

const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}�]/gu;
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const SEPARATORS = /[\t\n\r\u2028\u2029]/g;
const PERCENT_RUN = /(?:%[0-9a-fA-F]{2})+/g;
const strip = (s) => s.replace(INVISIBLE, '').normalize('NFKC').replace(INVISIBLE, '').replace(CONTROLS, '');
// For the INSPECTOR only (card numbers, instruction-override phrases): the text is cut to MAX_SCAN, NFKC, every invisible and control character deleted, up to four rounds
// of percent-decoding, tab / line breaks / U+2028 / U+2029 turned into a space. Not used to find credentials: that is the shared masker's job on the text as typed.
export function normalizeForMatching(value) {
  let s = strip(String(value ?? '').slice(0, MAX_SCAN));
  for (let i = 0; i < 4 && s.includes('%'); i++) {
    const next = s.replace(PERCENT_RUN, (run) => { try { return decodeURIComponent(run); } catch { return run; } });
    if (next === s) break;
    s = strip(next);
  }
  return s.replace(SEPARATORS, ' ').replace(/\\+(?=["'])/g, '');
}

// Is this object KEY a credential word (as the shared masker reads keys: its words, look-alikes, encodings, suffixes, numbering)? True when the key text is itself masked, when
// a number under it is masked (the strong names: password, secret, token, api_key ...), or when a secret-looking string under it is masked (the weak names: pin, session, sid,
// auth ...). A plural `...tokens` is a list of tokens or a count (`max_tokens`) to the masker and is not a credential name here.
const PROBE = 'Zq7vL3mN9xK2';
export function isCredentialKey(key) {
  const k = String(key);
  const masked = (probe) => { const [ok, ov] = Object.entries(maskDeep({ [k]: probe }))[0] ?? [k, probe]; return ov !== probe || ok !== k; };
  return masked(12345) || (!/tokens$/i.test(k.trim()) && masked(PROBE));
}
// A value shown beside its key: masked by the key's meaning (a credential-word key masks a string, number or boolean whatever it looks like), otherwise cleaned as free text.
export function cleanUnderKey(key, value, max) {
  if (typeof value === 'string') return cleanFree(Object.values(maskDeep({ [String(key)]: value }))[0], max);
  if (typeof value === 'number' || typeof value === 'boolean') return Object.values(maskDeep({ [String(key)]: value }))[0];
  return value;
}

// Free text from the visitor: masked as typed (the shared masker reads invisible characters, controls, look-alikes, encodings and line breaks itself, and masks the whole
// text BEFORE anything is cut, so a token that straddles the cut is masked, not half shown), then tidied for display (invisible and control characters deleted, white space
// collapsed) and cut to length without splitting a surrogate pair.
export function cleanFree(value, max = MAX_FREE) {
  const masked = maskText(typeof value === 'string' ? value : String(value ?? ''));
  const tidy = masked.replace(INVISIBLE, '').replace(CONTROLS, '').replace(/\s+/g, ' ').trim();
  return tidy.slice(0, max).replace(/[\uD800-\uDBFF]$/, '');
}
