// Credential-shaped text. Anything a visitor types that looks like a token, a key, a password or key material is masked on the way IN
// (reason, comment) so the raw value never enters state, a receipt, an outbox entry, a hop pane, a log line or an error.
// Lab-written detectors; linear patterns only (no nested quantifiers), run on input capped at MAX_FREE characters.
export const MAX_FREE = 400;

const D = (id, re, accept) => (accept ? { id, re, accept } : { id, re });
// Does a bare value (a word after a keyword with no ":" or "=" between them) look like a secret rather than a word of prose? It needs six characters and a digit, a capital
// after the first letter, or a symbol; dates and clock times do not count. "password policy" and "token requirements" stay readable; "password hunter" does not match (a miss the README states).
const secretive = (v) => v.length >= 6 && !/^\d{4}-\d{2}-\d{2}|^\d{1,2}:\d{2}/.test(v) && (/\d/.test(v) || (/[a-z]/.test(v) && /[A-Z]/.test(v.slice(1))) || /[!@#$%^&*_+=~]/.test(v));
const lastWord = (m) => m.split(/[ \t]+/).pop();
// Lab-written, heuristic detectors: they catch the common shapes, plain-language passwords and keys of 20 characters or more. Not every secret has a
// recognisable shape (a short random password with no keyword before it is not found), and the page says so.
export const DETECTORS = [
  D('private-key', /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[^]{0,4000}?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g),
  D('url-userinfo', /\b[a-zA-Z][a-zA-Z0-9+.-]{1,20}:\/\/[^/\s:@]{1,100}:[^@\s]{1,200}@/g),
  // user:password@host.example with no scheme in front (a bare connection string). The password must follow the colon at once, so "note: maya@x.example" is left alone.
  D('url-userinfo', /(?<![\w.%+-])[\w.%+-]{1,64}:[^\s@/:"',;<>]{3,100}@(?=[\w-]+\.[\w.-]+|localhost)/g),
  D('github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{6,}|github_pat_[A-Za-z0-9_]{6,})/g),
  D('gitlab-token', /\bglpat-[A-Za-z0-9_-]{6,}/g),
  D('slack-token', /\bxox[abprs]-[A-Za-z0-9-]{6,}/g),
  D('aws-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g),
  D('google-token', /\b(?:ya29\.[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{20,})/g),
  D('api-key', /\bsk-[A-Za-z0-9_-]{8,}/g),
  D('jwt', /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g),
  D('bearer', /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{10,}/gi),
  // "token abcdef1234567890" (an Authorization header): the word needs a digit, so "token requirements" is left alone
  D('token-word', /\btoken\s+(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{12,}/gi),
  // a passphrase is several words: take the value and up to three more words, but never past a quote, comma, semicolon or brace (so a second assignment in the same
  // text is a match of its own) and never into another credential keyword. Over-masking the words after a one-word passphrase is accepted; a leak is not.
  D('passphrase', /\bpassphrase\s*(?:[:=]|\bis\b)\s*[^\s"',;{}\[\]]+(?:[ \t]+(?!(?:passphrase|password|passwd|pwd|pw|pass|passcode|secret|token|api[_ -]?key|apikey|credentials?|session|sid|authorization)\b)[^\s"',;{}\[\]]+){0,3}/gi),
  // keyword, then ":" "=" or "is", then a value that stops at a quote, a comma, a semicolon or a brace, so adjacent assignments each match
  D('assignment', /\b(?:password|passwd|pwd|pw|pass|passcode|secret(?:[ _-]?key)?|token|api[_-]?key|apikey|client[_-]?secret|private[_-]?key|access[_-]?key|account[_-]?key|session[_-]?id|sessionid|jsessionid|phpsessid|sid|credential|authorization)s?\s*(?:[:=]|\bis\b)\s*[^\s"',;{}\[\]]{3,}/gi),
  // "session=VALUE" (a cookie): the bare word "session" is also prose ("Session: planning"), so its value must look like a secret. sid and the session-id names are always credentials (above).
  D('assignment', /\bsession\s*[:=]\s*[^\s"',;{}\[\]]{3,}/gi, (m) => secretive(m.split(/[:=]\s*/).pop())),
  // keyword, a plain space, then a value that looks like a secret ("password Tr0ub4dorXq03", "db pwd X", "api key X", "credentials X"): the keyword form without ":" "=" or "is"
  D('assignment', /\b(?:password|passwd|pwd|pw|passphrase|passcode|secret|token|api[ _-]?key|apikey|credentials?|db[ _-]?(?:pwd|pass(?:word)?))s?[ \t]+[^\s"',;{}\[\]]{6,}/gi, (m) => secretive(lastWord(m))),
  // "the key is X", "my api key is X"
  D('assignment', /\b(?:the|my|our|your)\s+(?:(?:api|secret|private|access|master|signing)\s+)?key\s+is\s+[^\s"',;{}\[\]]{6,}/gi, (m) => secretive(lastWord(m))),
  // KEY-AWARE: when a key is itself a credential word (also as a suffix: userPassword, db_secret), its VALUE is masked whatever the quoting ("password":"x", 'pin' = x,
  // password : "x y"). Only the value is covered. Plural only for password and secret, so "max_tokens": 4096 is left alone.
  D('keyed-value', /(?<=(?:passwords?|passwd|passcode|passphrases?|secrets?|token|api[_-]?key|apikey|private[_-]?key|access[_-]?key|account[_-]?key|client[_-]?secret|credential|authorization|session[_-]?id|sessionid|\b(?:pwd|pw|pass|pin|auth|sid))["']?\s{0,10}[:=]\s{0,10})(?:"(?:[^"\\\n]|\\.){1,200}"|'[^'\n]{1,200}'|[^\s,;{}\[\]"']{1,200})/gi),
  // the bare key "session" only counts when it is quoted as a JSON or object key and its value looks like a secret (the bare word is prose, see above)
  D('keyed-value', /(?<=["']session["']\s{0,10}[:=]\s{0,10})(?:"(?:[^"\\\n]|\\.){1,200}"|'[^'\n]{1,200}'|[^\s,;{}\[\]"']{1,200})/gi, (m) => secretive(m.replace(/^["']|["']$/g, ''))),
  // A long run of key characters. Two detectors, both checked in code rather than with a look-ahead (to stay linear): a run of 20 or more of
  // letters, digits, _ and - that has both a letter and a digit (or is 32 or more and is not just lowercase words joined by hyphens), and a run of 32 or
  // more that also uses + / = (base64) unless it is a lowercase path such as a URL path.
  { id: 'key-like', generic: true, re: /[A-Za-z0-9_-]{20,}/g, accept: (m) => (/\d/.test(m) && /[A-Za-z]/.test(m)) || (m.length >= 32 && !/^[a-z]+(?:-[a-z]+)+$/.test(m)) },
  { id: 'long-blob', generic: true, re: /[A-Za-z0-9+/_=-]{32,}/g, accept: (m) => !/^[a-z0-9._-]+(?:\/[a-z0-9._-]+)+$/.test(m) && !/^[a-z]+(?:-[a-z]+)+$/.test(m) },
];

export const MAX_SCAN = 200000;
export const PERCENT_ROUNDS = 4;

// ONE normaliser for everything that matches text against the detectors (cleanFree, the response mask, the canonical-form display, request and reply inspection):
// the text is cut to a bounded length, then NFKC (fullwidth look-alikes), deletion of every invisible and format character (\p{Default_Ignorable_Code_Point}, \p{Cf},
// U+FFFD) and of every C0 and C1 control character except TAB, LF and CR (a person reads a control character as nothing, and it breaks a keyword apart), then up to four
// rounds of percent-decoding (an encoded credential; each round is cleaned the same way, so an escape cannot be hidden either). TAB, LF, CR, U+2028 and U+2029 are
// separators and become a space, so a multi-line text stays readable. Backslashes before a quote are dropped (so JSON text that was itself put inside a JSON string,
// \"password\":\"x\", still reads as a key and a value).
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}\uFFFD]/gu;
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const SEPARATORS = /[\t\n\r\u2028\u2029]/g;
const PERCENT_RUN = /(?:%[0-9a-fA-F]{2})+/g;
const strip = (s) => s.replace(INVISIBLE, '').normalize('NFKC').replace(INVISIBLE, '').replace(CONTROLS, '');
export function normalizeForMatching(value) {
  let s = strip(String(value ?? '').slice(0, MAX_SCAN));
  for (let i = 0; i < PERCENT_ROUNDS && s.includes('%'); i++) {
    const next = s.replace(PERCENT_RUN, (run) => { try { return decodeURIComponent(run); } catch { return run; } });
    if (next === s) break;
    s = strip(next);
  }
  return s.replace(SEPARATORS, ' ').replace(/\\+(?=["'])/g, '');
}
// Spans { start, end, id } of every credential-shaped run in the text.
// `generic: false` leaves out the two long-run detectors (the response mask: ids, hashes and trace ids are long and legitimate).
export function findCredentials(text, { generic = true } = {}) {
  const t = String(text).slice(0, MAX_SCAN);
  const spans = [];
  for (const d of DETECTORS) { if (d.generic && !generic) continue; d.re.lastIndex = 0; for (const m of t.matchAll(d.re)) if (!d.accept || d.accept(m[0])) spans.push({ start: m.index, end: m.index + m[0].length, id: d.id }); }
  return spans;
}

// Is this object KEY a credential word (exact for the short ones, a suffix for the long ones)? Used where a value is shown on its own, away from its key.
export const isCredentialKey = (key) => /^(?:pwd|pw|pass|pin|auth|sid|session)$|(?:passwords?|passwd|passcode|passphrases?|secrets?|token|api[_-]?key|apikey|private[_-]?key|access[_-]?key|account[_-]?key|credential|authorization|session[_-]?id|sessionid)$/i.test(normalizeForMatching(key).trim());
// A value shown beside its key: masked whole when the key is a credential word, otherwise cleaned as free text.
export const cleanUnderKey = (key, value, max) => (isCredentialKey(key) && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') ? '[masked:keyed-value]' : typeof value === 'string' ? cleanFree(value, max) : value);

// True when the text, once normalised, holds anything credential-shaped (used to refuse ids, claim values and rule values rather than mask them).
export const looksLikeCredential = (text) => findCredentials(normalizeForMatching(text)).length > 0;

export function maskSpans(text, spans) {
  const sorted = spans.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start || b.end - a.end);
  let out = ''; let at = 0;
  for (const s of sorted) { if (s.start < at) { at = Math.max(at, s.end); continue; } out += `${text.slice(at, s.start)}[masked:${s.id}]`; at = s.end; }
  return out + text.slice(at);
}

export function maskText(input) {
  const text = String(input);
  return text ? maskSpans(text, findCredentials(text)) : text;
}

// Free text from the visitor: normalised (see normalizeForMatching: NFKC, every invisible and control character deleted, percent-decoded, line breaks and tabs turned
// into spaces), credential-shaped runs masked, and only THEN cut to length (a token that straddles the cut is masked, not half shown).
export function cleanFree(value, max = MAX_FREE) {
  return maskText(normalizeForMatching(value)).replace(/\s+/g, ' ').trim().slice(0, max);
}
