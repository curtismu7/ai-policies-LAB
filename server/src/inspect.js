// A tiny inspector so the "rules that read inspection findings" have something to read. LAB-INVENTED and deliberately small: the deck says Privilege inspects
// requests and replies and that rules can read the findings; it does not say what the findings are. Three kinds, found by lab-written heuristics:
//   card-number  13 to 19 digits (spaces or dashes allowed between them) that pass the Luhn check
//   injection    a short list of instruction-override phrases
//   secret       a credential-shaped value (the same detectors that mask what the visitor types)
// The text is normalised first (NFKC, invisible and control characters deleted, percent-decoded, spaces collapsed) so interleaving cannot hide a finding. A finding
// names its KIND and WHERE, never the value. The WHOLE text is read (up to the scan limit in credentials.js; the engine refuses a reply longer than that instead of
// reading part of it), the argument KEYS are read as well as the values, and numbers are read as the digits they print as.
import { looksLikeCredential, normalizeForMatching } from './credentials.js';

const PHRASES = ['ignore previous instructions', 'ignore all previous', 'ignore the above', 'disregard the above', 'disregard all previous', 'reveal your system prompt', 'forget your instructions'];

const luhn = (digits) => {
  let sum = 0; let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) { let d = digits.charCodeAt(i) - 48; if (dbl) { d *= 2; if (d > 9) d -= 9; } sum += d; dbl = !dbl; }
  return sum % 10 === 0;
};
// Same normaliser as the masking (percent-decoded, NFKC, every invisible character deleted), so encoding or interleaving cannot hide a finding.
export const normalizeText = (s) => normalizeForMatching(String(s)).replace(/\s+/g, ' ');

export function findingKinds(text) {
  const t = normalizeText(text); const kinds = new Set();
  for (const m of t.matchAll(/\d(?:[ -]?\d){12,18}/g)) { const d = m[0].replace(/\D/g, ''); if (d.length >= 13 && d.length <= 19 && luhn(d)) kinds.add('card-number'); }
  const low = t.toLowerCase();
  if (PHRASES.some((p) => low.includes(p))) kinds.add('injection');
  if (looksLikeCredential(String(text))) kinds.add('secret');
  return [...kinds];
}

// Findings in a value: [{ kind, path }] over every string, every number (as the digits it prints as) and every object KEY in it (iterative, bounded). Paths are the
// argument names, which the engine only ever shows when it can mask them; the page shows kind and a count.
export function findingsIn(value, root = '') {
  const out = []; const work = [[value, root, 0]]; let seen = 0;
  const add = (text, path) => { for (const kind of findingKinds(text)) out.push({ kind, path: path || '/' }); };
  while (work.length && seen++ < 500) {
    const [v, path, depth] = work.pop();
    if (typeof v === 'string') add(v, path);
    else if (typeof v === 'number') add(String(v), path);
    else if (depth < 8 && Array.isArray(v)) v.forEach((x, i) => work.push([x, `${path}/${i}`, depth + 1]));
    else if (depth < 8 && v && typeof v === 'object') for (const k of Object.keys(v)) { add(k, `${path}/${k}`); work.push([v[k], `${path}/${k}`, depth + 1]); }
  }
  return out;
}
