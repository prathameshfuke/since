import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { newChallenge, redeem, sessionOf, gateEnabled, needsCode, cookieFor } from '../server/session.js';

beforeEach(() => {
  process.env.SESSION_SECRET = 'test-secret-test-secret-test-secret';
  process.env.POW_BITS = '8'; // fast in tests
  delete process.env.ACCESS_CODE;
});

const zeroBits = (buf) => { let n = 0; for (const b of buf) { if (b === 0) { n += 8; continue; } return n + Math.clz32(b) - 24; } return n; };
const solve = (challenge, bits) => { for (let i = 0; ; i++) if (zeroBits(createHash('sha256').update(`${challenge}:${i}`).digest()) >= bits) return String(i); };
const reqWith = (cookie) => ({ headers: { cookie } });
const cookieOf = (setCookie) => setCookie.split(';')[0];

test('the gate is off without SESSION_SECRET, so local runs stay open', () => {
  delete process.env.SESSION_SECRET;
  assert.equal(gateEnabled(), false);
  assert.deepEqual(sessionOf({ headers: {} }), { sid: 'open' });
});

test('solving the challenge earns a session the server recognises', () => {
  const { challenge, bits } = newChallenge();
  const out = redeem({ challenge, nonce: solve(challenge, bits) });
  assert.ok(out.token);
  assert.ok(sessionOf(reqWith(cookieOf(cookieFor(out.token, out.maxAge, false)))));
});

test('a wrong nonce, a forged challenge and a tampered cookie are all refused', () => {
  const { challenge, bits } = newChallenge();
  let wrong = 0;
  while (zeroBits(createHash('sha256').update(`${challenge}:${wrong}`).digest()) >= bits) wrong++;
  assert.equal(redeem({ challenge, nonce: String(wrong) }).status, 400);
  assert.equal(redeem({ challenge: `${challenge}x`, nonce: '1' }).status, 400);
  const { token } = redeem({ challenge, nonce: solve(challenge, bits) });
  assert.equal(sessionOf(reqWith(`since_session=${token}x`)), null);
  assert.equal(sessionOf(reqWith('')), null);
});

test('a session signed with another secret is refused', () => {
  const { challenge, bits } = newChallenge();
  const { token } = redeem({ challenge, nonce: solve(challenge, bits) });
  process.env.SESSION_SECRET = 'a-different-secret-a-different-secret';
  assert.equal(sessionOf(reqWith(`since_session=${token}`)), null);
});

test('with ACCESS_CODE set, the right code is required', () => {
  process.env.ACCESS_CODE = 'open-sesame';
  assert.equal(needsCode(), true);
  const { challenge, bits } = newChallenge();
  const nonce = solve(challenge, bits);
  assert.equal(redeem({ challenge, nonce }).status, 403);
  assert.equal(redeem({ challenge, nonce, code: 'nope' }).needCode, true);
  assert.ok(redeem({ challenge, nonce, code: 'open-sesame' }).token);
});

test('an expired challenge is refused', (t) => {
  const { challenge, bits } = newChallenge();
  const nonce = solve(challenge, bits);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 5 * 60_000 });
  assert.equal(redeem({ challenge, nonce }).status, 400);
});

test('the cookie is HttpOnly, and Secure on https', () => {
  assert.match(cookieFor('t', 60, true), /HttpOnly; SameSite=Lax; Secure$/);
  assert.doesNotMatch(cookieFor('t', 60, false), /Secure/);
});
