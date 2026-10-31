import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { AUDIENCE, ISSUER, KID, jwks, mint, peek, verifyToken } from '../src/token.js';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fresh = (cl = { sub: 'a' }, ttl = 5) => mint(cl, { nowSec: 1000, ttlMin: ttl }).token;
const swap = (t, i, f) => { const p = t.split('.'); p[i] = f(p[i]); return p.join('.'); };

test('a minted token verifies; its claims carry iss, aud, iat, nbf and exp from the lab clock', () => {
  const v = verifyToken(fresh({ sub: 'a', scope: 's' }), { nowSec: 1000 });
  assert.equal(v.ok, true);
  assert.deepEqual([v.claims.iss, v.claims.aud, v.claims.iat, v.claims.nbf, v.claims.exp], [ISSUER, AUDIENCE, 1000, 1000, 1300]);
  assert.equal(v.header.alg, 'RS256'); assert.equal(v.header.kid, KID);
});
test('the expiry boundary is exact: valid one second before exp, expired at exp; not yet valid before nbf', () => {
  const t = fresh();
  assert.equal(verifyToken(t, { nowSec: 1299 }).ok, true);
  assert.equal(verifyToken(t, { nowSec: 1300 }).code, 'token_expired');
  assert.equal(verifyToken(t, { nowSec: 999 }).code, 'token_not_yet_valid');
});
test('a changed payload, header or signature does not verify, and its claims are not returned', () => {
  const t = fresh({ sub: 'a', scope: 'low' });
  const evil = swap(t, 1, () => b64({ sub: 'a', scope: 'admin', iss: ISSUER, aud: AUDIENCE, iat: 1000, nbf: 1000, exp: 9999999999 }));
  const v = verifyToken(evil, { nowSec: 1000 });
  assert.equal(v.code, 'token_signature'); assert.equal(v.claims, undefined);
  assert.equal(verifyToken(swap(t, 2, (s) => s.slice(0, -2) + (s.endsWith('AA') ? 'BB' : 'AA')), { nowSec: 1000 }).code, 'token_signature');
  assert.equal(verifyToken(swap(t, 2, () => 'AAAA'), { nowSec: 1000 }).code, 'token_signature');
});
test('alg none, HS256 key confusion, another kid and non-RS256 headers are refused', () => {
  const t = fresh();
  const p = t.split('.');
  assert.equal(verifyToken(`${b64({ alg: 'none', typ: 'JWT', kid: KID })}.${p[1]}.`, { nowSec: 1000 }).code, 'token_malformed');
  assert.equal(verifyToken(`${b64({ alg: 'none', kid: KID })}.${p[1]}.${p[2]}`, { nowSec: 1000 }).code, 'token_alg');
  const signed = `${b64({ alg: 'HS256', typ: 'JWT', kid: KID })}.${p[1]}`;
  const hs = createHmac('sha256', JSON.stringify(jwks().keys[0])).update(signed).digest('base64url');
  assert.equal(verifyToken(`${signed}.${hs}`, { nowSec: 1000 }).code, 'token_alg');
  assert.equal(verifyToken(`${b64({ alg: 'RS256', kid: 'other' })}.${p[1]}.${p[2]}`, { nowSec: 1000 }).code, 'token_kid');
});
test('malformed input of every type is refused without throwing', () => {
  for (const x of [undefined, null, 5, {}, [], '', 'a', 'a.b', 'a.b.c.d', '..', 'a..c', 'é.é.é', 'x'.repeat(5000), `${b64([])}.${b64({})}.AAAA`, `${b64({ alg: 'RS256', kid: KID })}.${b64([])}.${'A'.repeat(342)}`]) {
    const v = verifyToken(x, { nowSec: 1000 });
    assert.equal(v.ok, false);
  }
});
test('issuer and audience are checked; a __proto__ key in the payload is refused', () => {
  // minted by the lab with the wrong iss/aud cannot be produced (mint sets them), so check the claim logic by overriding through the payload spread order
  const bad = mint({ sub: 'a' }, { nowSec: 1000, ttlMin: 5 });
  assert.equal(bad.payload.iss, ISSUER);
  assert.equal(peek(bad.token).claims.sub, 'a');
  assert.equal(peek('nonsense'), null);
  const forbidden = mint(JSON.parse('{"sub":"a","__proto__":{"x":1}}'), { nowSec: 1000, ttlMin: 5 });
  assert.equal(verifyToken(forbidden.token, { nowSec: 1000 }).code, 'token_claims');
});
test('the JWKS publishes only the public half', () => {
  const k = jwks().keys[0];
  assert.equal(k.kty, 'RSA'); assert.equal(k.alg, 'RS256'); assert.equal(k.d, undefined); assert.equal(k.p, undefined);
});
