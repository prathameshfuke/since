// Bot protection for the public demo, with no database and no third party.
//
//   1. The browser asks for a challenge (a signed, short-lived token).
//   2. It finds a nonce so that SHA-256(challenge:nonce) starts with N zero bits. That costs a real
//      browser about a second and costs a bot farm CPU for every session it wants.
//   3. The server checks the work (and the invite code, if ACCESS_CODE is set) and sets a signed,
//      HttpOnly session cookie. /api/chat refuses requests without one.
//
// The gate is OFF unless SESSION_SECRET is set, so `npm run dev` and the judges' local runs stay open.
// Honest limit: this is stateless, so a solved challenge can be replayed within its 90-second life and
// per-IP limits live in one server instance. Set ACCESS_CODE to make the demo invite-only.

import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const CHALLENGE_MS = 90_000;
const SESSION_MS = 24 * 3600_000;
const COOKIE = 'since_session';

const secret = () => process.env.SESSION_SECRET || '';
const bitsRequired = () => Number(process.env.POW_BITS) || 17;

export const gateEnabled = () => secret().length >= 16;
export const needsCode = () => Boolean(process.env.ACCESS_CODE);

const sign = (payload) => createHmac('sha256', secret()).update(payload).digest('base64url');
const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
const seal = (obj) => {
  const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${body}.${sign(body)}`;
};
function open(token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac || !same(sign(body), mac)) return null;
  try {
    const obj = JSON.parse(Buffer.from(body, 'base64url').toString());
    return obj.exp > Date.now() ? obj : null;
  } catch {
    return null;
  }
}

const zeroBits = (buf) => {
  let n = 0;
  for (const byte of buf) {
    if (byte === 0) { n += 8; continue; }
    return n + Math.clz32(byte) - 24;
  }
  return n;
};

export const newChallenge = () => ({
  challenge: seal({ t: 'c', exp: Date.now() + CHALLENGE_MS, salt: randomBytes(8).toString('hex') }),
  bits: bitsRequired(),
});

/** @returns {{token, maxAge} | {error, status, needCode?}} */
export function redeem({ challenge, nonce, code }) {
  const c = open(challenge);
  if (!c || c.t !== 'c') return { error: 'The check expired. Try again.', status: 400 };
  if (needsCode() && !same(code ?? '', process.env.ACCESS_CODE)) {
    return { error: 'That access code is not right.', status: 403, needCode: true };
  }
  const hash = createHash('sha256').update(`${challenge}:${nonce}`).digest();
  if (zeroBits(hash) < bitsRequired()) return { error: 'The check failed. Try again.', status: 400 };
  return { token: seal({ t: 's', sid: randomBytes(8).toString('hex'), exp: Date.now() + SESSION_MS }), maxAge: SESSION_MS / 1000 };
}

/** The caller's session, or null. With the gate off everyone shares the "open" session. */
export function sessionOf(req) {
  if (!gateEnabled()) return { sid: 'open' };
  const cookie = String(req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(`${COOKIE}=`));
  const obj = open(cookie?.slice(COOKIE.length + 1));
  return obj?.t === 's' ? { sid: obj.sid } : null;
}

export const cookieFor = (token, maxAge, secure) =>
  `${COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
