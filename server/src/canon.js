// The canonical form of a call, and the hash an approval is bound to. LAB-INVENTED: the deck says an approval is "bound to the exact call (a canonical hash
// of method + target + arguments)"; it does not say how the canonical form is defined. This file is the lab's definition, and every rule below exists to
// stop one approval from covering a call it was not given for. The test file canon.test.js pins each rule.
//
//   hash = sha256( canonicalJson({ arguments, method, target }) )          (hex, 64 characters)
//   method   derived from the route's surface (tools/call, chat/completions, message/send): never typed by the caller
//   target   "<surface>:<app>/<tool>", derived from the route and the tool name
//   arguments  parsed strictly, then canonicalised as below
//
// Canonical JSON: no whitespace; object keys sorted by UTF-16 code unit AFTER normalising each key to Unicode NFC; array order is kept (a different order
// is a different call); strings are NFC (canonically equivalent spellings agree, compatibility look-alikes such as fullwidth digits do NOT: NFKC is not
// used, because it would let an approval for one string cover another); numbers print as JavaScript prints them (100, 100.0, 1e2 and 100.00 all give 100,
// minus zero gives 0) and only numbers that a double holds exactly are accepted: at most 15 significant digits for numbers with a fraction or an exponent, and at most 2^53 - 1 for whole numbers;
// "100" (a string) and 100 (a number) differ.
// Refused (a refused call is a DENIAL, never a guess): a duplicate key (including two keys that are the same after NFC), the keys __proto__,
// constructor and prototype at any depth, a lone surrogate, a raw control character inside a string, a number that is not exact, text that is not JSON,
// trailing text, nesting deeper than 6, more than 40 keys in an object or 50 items in an array, more than 400 values, a string longer than 1000
// characters, or text longer than 4096 characters.
import { createHash } from 'node:crypto';

export const LIMITS = { text: 4096, depth: 6, keys: 40, items: 50, values: 400, string: 1000, digits: 15 };
export const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

class Bad extends Error { constructor(code, reason) { super(reason); this.code = code; } }
const bad = (code, reason) => { throw new Bad(code, reason); };

const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
function checkNumberLiteral(lit) {
  if (!NUMBER.test(lit)) bad('arguments_not_json', 'a number is not written the way JSON writes numbers');
  const digits = lit.replace(/[eE].*$/, '').replace(/^-/, '').replace('.', '').replace(/^0+/, '').replace(/0+$/, '');
  if (!/^-?\d+$/.test(lit) && digits.length > LIMITS.digits) bad('number_not_exact', `a number has more than ${LIMITS.digits} significant digits, so a double cannot hold it exactly`);
  const n = Number(lit);
  if (!Number.isFinite(n)) bad('number_not_exact', 'a number is too large for a double');
  if (Number.isInteger(n) && Math.abs(n) > Number.MAX_SAFE_INTEGER) bad('number_not_exact', 'a whole number is above 2^53 - 1');
  return n === 0 ? 0 : n; // minus zero is zero
}

const hasLoneSurrogate = (s) => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
function checkString(s) {
  if (s.length > LIMITS.string) bad('arguments_too_large', `a string is longer than ${LIMITS.string} characters`);
  if (hasLoneSurrogate(s)) bad('lone_surrogate', 'a string holds a lone surrogate, which has no UTF-8 form');
  return s.normalize('NFC');
}

// Strict JSON text -> normalised value (objects without a prototype). No eval, no JSON.parse: duplicate keys must be SEEN, not silently resolved.
function parseText(text) {
  let i = 0; let values = 0;
  const ws = () => { while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++; };
  const count = () => { if (++values > LIMITS.values) bad('arguments_too_large', `more than ${LIMITS.values} values`); };
  function str() {
    if (text[i] !== '"') bad('arguments_not_json', 'a key or string does not start with a quote');
    i++; let out = '';
    for (;;) {
      if (i >= text.length) bad('arguments_not_json', 'a string is not closed');
      const c = text[i++];
      if (c === '"') return checkString(out);
      if (c.charCodeAt(0) < 0x20) bad('arguments_not_json', 'a raw control character sits inside a string');
      if (c !== '\\') { out += c; if (out.length > LIMITS.string + 2) bad('arguments_too_large', `a string is longer than ${LIMITS.string} characters`); continue; }
      const e = text[i++];
      const simple = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
      if (Object.hasOwn(simple, e)) out += simple[e];
      else if (e === 'u') {
        const hex = text.slice(i, i + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) bad('arguments_not_json', 'a \\u escape is not four hex digits');
        out += String.fromCharCode(parseInt(hex, 16)); i += 4;
      } else bad('arguments_not_json', 'a string has an unknown escape');
    }
  }
  function val(depth) {
    if (depth > LIMITS.depth) bad('arguments_too_deep', `nesting is deeper than ${LIMITS.depth}`);
    ws(); count();
    const c = text[i];
    if (c === '{') {
      i++; const o = Object.create(null); ws();
      if (text[i] === '}') { i++; return o; }
      for (;;) {
        ws(); const k = str();
        if (FORBIDDEN_KEYS.includes(k)) bad('forbidden_key', 'a key is one the lab never accepts (__proto__, constructor, prototype)');
        if (k in o) bad('duplicate_key', 'two keys are the same (after Unicode NFC normalisation)');
        if (Object.keys(o).length >= LIMITS.keys) bad('arguments_too_large', `more than ${LIMITS.keys} keys in one object`);
        ws(); if (text[i++] !== ':') bad('arguments_not_json', 'a colon is missing');
        o[k] = val(depth + 1); ws();
        const d = text[i++];
        if (d === '}') return o;
        if (d !== ',') bad('arguments_not_json', 'a comma or closing brace is missing');
      }
    }
    if (c === '[') {
      i++; const a = []; ws();
      if (text[i] === ']') { i++; return a; }
      for (;;) {
        if (a.length >= LIMITS.items) bad('arguments_too_large', `more than ${LIMITS.items} items in one array`);
        a.push(val(depth + 1)); ws();
        const d = text[i++];
        if (d === ']') return a;
        if (d !== ',') bad('arguments_not_json', 'a comma or closing bracket is missing');
      }
    }
    if (c === '"') return str();
    if (text.startsWith('true', i)) { i += 4; return true; }
    if (text.startsWith('false', i)) { i += 5; return false; }
    if (text.startsWith('null', i)) { i += 4; return null; }
    const m = /^-?[0-9][0-9.eE+-]*/.exec(text.slice(i, i + 400));
    if (!m) bad('arguments_not_json', 'a value is not JSON');
    i += m[0].length; return checkNumberLiteral(m[0]);
  }
  const v = val(0); ws();
  if (i !== text.length) bad('arguments_not_json', 'text follows the value');
  return v;
}

// An already-parsed value (the browser sent an object) -> the same normalised value, under the same rules. Iterative over an explicit stack: depth is bounded first.
function normalizeValue(value) {
  let values = 0;
  const walk = (v, depth) => {
    if (depth > LIMITS.depth) bad('arguments_too_deep', `nesting is deeper than ${LIMITS.depth}`);
    if (++values > LIMITS.values) bad('arguments_too_large', `more than ${LIMITS.values} values`);
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'string') return checkString(v);
    if (typeof v === 'number') return checkNumberLiteral(String(v));
    if (Array.isArray(v)) { if (v.length > LIMITS.items) bad('arguments_too_large', `more than ${LIMITS.items} items in one array`); return v.map((x) => walk(x, depth + 1)); }
    if (isObj(v)) {
      const keys = Object.keys(v);
      if (keys.length > LIMITS.keys) bad('arguments_too_large', `more than ${LIMITS.keys} keys in one object`);
      const o = Object.create(null);
      for (const raw of keys) {
        const k = checkString(raw);
        if (FORBIDDEN_KEYS.includes(k)) bad('forbidden_key', 'a key is one the lab never accepts (__proto__, constructor, prototype)');
        if (k in o) bad('duplicate_key', 'two keys are the same (after Unicode NFC normalisation)');
        o[k] = walk(v[raw], depth + 1);
      }
      return o;
    }
    return bad('arguments_not_json', 'a value is not JSON (undefined, a function or a symbol)');
  };
  return walk(value, 0);
}

// -> { ok: true, value } or { ok: false, code, reason }. Never throws.
export function normalizeArguments({ text, object } = {}) {
  try {
    if (text !== undefined) {
      if (typeof text !== 'string') return { ok: false, code: 'arguments_not_json', reason: 'the arguments text is not a string' };
      if (text.length > LIMITS.text) return { ok: false, code: 'arguments_too_large', reason: `the arguments text is longer than ${LIMITS.text} characters` };
      const v = parseText(text);
      if (!isObj(v)) return { ok: false, code: 'arguments_not_object', reason: 'the arguments must be one JSON object' };
      return { ok: true, value: v };
    }
    if (!isObj(object)) return { ok: false, code: 'arguments_not_object', reason: 'the arguments must be one JSON object' };
    return { ok: true, value: normalizeValue(object) };
  } catch (e) {
    if (e instanceof Bad) return { ok: false, code: e.code, reason: e.message };
    return { ok: false, code: 'arguments_not_json', reason: 'the arguments could not be read' };
  }
}

export function canonicalJson(v) {
  if (v === null || typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return String(v === 0 ? 0 : v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
}

export const METHODS = { tool: 'tools/call', model: 'chat/completions', agent: 'message/send' };

// callHash({ method, target, arguments }) -> { canonical, hash }. The arguments must already be normalised.
export function callHash({ method, target, arguments: args }) {
  const canonical = canonicalJson({ arguments: args, method, target });
  return { canonical, hash: createHash('sha256').update(canonical, 'utf8').digest('hex') };
}
