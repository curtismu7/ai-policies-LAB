// A REAL RS256 JSON Web Token, minted and verified locally with Node's own crypto. The key pair is generated once per process (RSA 2048, in memory, never
// written, never shown: only the public half is published as a JWKS); a token it signs is labelled "mock-issued by the lab" and is not a credential for
// anything. LAB-INVENTED: the issuer, the audience, the key id and every claim NAME below (surfaces, scope, end_user, department). The deck says policy is
// read "from the VERIFIED TOKEN"; it does not name the claims.
//
// Verification is strict: three base64url parts, header exactly alg RS256 (so alg none and an HS256 key-confusion token are refused) and the lab's kid, the
// signature checked over the signed part, an issuer and an audience, not-before and expiry against the LAB CLOCK (injected: the clock only moves forward).
import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { FORBIDDEN_KEYS } from './canon.js';

export const ISSUER = 'https://issuer.lab.example';
export const AUDIENCE = 'ai-policies-lab-gateway';
export const KID = 'lab-key-1';
export const MAX_TOKEN = 4096;
export const MAX_TTL_MIN = 1440;

let pair = null;
const keys = () => (pair ||= generateKeyPairSync('rsa', { modulusLength: 2048 }));
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export const jwks = () => ({ keys: [{ ...createPublicKey(keys().publicKey).export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' }] });

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasForbidden = (v, depth = 0) => depth < 4 && isObj(v) && (FORBIDDEN_KEYS.some((k) => Object.hasOwn(v, k)) || Object.values(v).some((x) => hasForbidden(x, depth + 1)));

// claims: the visitor's own claim set (validated by the caller); nowSec is the lab clock; ttlMin bounds exp. iss, aud, iat, nbf and exp are set here.
export function mint(claims, { nowSec, ttlMin }) {
  const header = { alg: 'RS256', typ: 'JWT', kid: KID };
  const payload = { ...claims, iss: ISSUER, aud: AUDIENCE, iat: nowSec, nbf: nowSec, exp: nowSec + ttlMin * 60 };
  const signed = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  return { token: `${signed}.${b64u(sign('sha256', Buffer.from(signed), keys().privateKey))}`, header, payload };
}

const fail = (code, reason, extra = {}) => ({ ok: false, code, reason, ...extra });

// -> { ok: true, header, claims } or { ok: false, code, reason, header?, claims? }. Never throws. Claims of a token whose signature failed are NOT returned.
export function verifyToken(token, { nowSec }) {
  try {
    if (typeof token !== 'string' || !token) return fail('token_missing', 'no token was presented');
    if (token.length > MAX_TOKEN) return fail('token_malformed', 'the token exceeds the length the lab accepts');
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every((p) => p && BASE64URL.test(p))) return fail('token_malformed', 'a token has three base64url parts joined by dots');
    let header;
    try { header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { return fail('token_malformed', 'the token header is not JSON'); }
    if (!isObj(header)) return fail('token_malformed', 'the token header is not an object');
    if (header.alg !== 'RS256') return fail('token_alg', 'only RS256 is accepted (alg none and HS256 are refused)');
    if (header.kid !== KID) return fail('token_kid', 'the key id is not the lab\'s key');
    const sig = Buffer.from(parts[2], 'base64url');
    if (sig.length !== 256 || !verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), keys().publicKey, sig)) return fail('token_signature', 'the signature does not verify against the lab\'s public key (the token was changed, or was not minted here)');
    let claims;
    try { claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return fail('token_malformed', 'the token payload is not JSON'); }
    if (!isObj(claims)) return fail('token_malformed', 'the token payload is not an object');
    if (hasForbidden(claims)) return fail('token_claims', 'the payload carries a key the lab never accepts (__proto__, constructor, prototype)');
    for (const k of ['exp', 'nbf', 'iat']) if (typeof claims[k] !== 'number' || !Number.isFinite(claims[k])) return fail('token_claims', `the ${k} claim is missing or is not a number`, { header });
    if (claims.iss !== ISSUER) return fail('token_issuer', 'the issuer is not the lab\'s', { header });
    if (claims.aud !== AUDIENCE) return fail('token_audience', 'the audience is not this gateway', { header });
    if (claims.nbf > nowSec) return fail('token_not_yet_valid', 'the token lies before its not-before time on the lab clock', { header });
    if (claims.exp <= nowSec) return fail('token_expired', 'the token has expired on the lab clock', { header });
    return { ok: true, header, claims };
  } catch { return fail('token_error', 'the token could not be checked'); }
}

// Splits a token WITHOUT verifying it, to show what it says. Used for display only, never for a decision.
export function peek(token) {
  try {
    const [h, p] = String(token).split('.');
    return { header: JSON.parse(Buffer.from(h, 'base64url').toString('utf8')), claims: JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) };
  } catch { return null; }
}
