// Client side of the bot check (server/session.js explains the scheme). The browser finds a nonce whose
// SHA-256 with the server's challenge starts with N zero bits, about a second of work, once per day.
// When the server has no SESSION_SECRET (local runs) the first GET says "not required" and nothing happens.

const enc = new TextEncoder();
let verified = false;

const zeroBits = (bytes) => {
  let n = 0;
  for (const b of bytes) {
    if (b === 0) { n += 8; continue; }
    return n + Math.clz32(b) - 24;
  }
  return n;
};

/** Hashes in parallel batches so the page stays responsive while it works. */
async function solve(challenge, bits) {
  for (let base = 0; ; base += 512) {
    const hashes = await Promise.all(Array.from({ length: 512 }, (_, i) => crypto.subtle.digest('SHA-256', enc.encode(`${challenge}:${base + i}`))));
    for (let i = 0; i < hashes.length; i++) if (zeroBits(new Uint8Array(hashes[i])) >= bits) return String(base + i);
  }
}

export const forget = () => { verified = false; };

/**
 * Makes sure this browser has a session. `askCode(message)` resolves to the access code, or null if the
 * person cancels. Resolves true when ready, false when cancelled, and throws with a readable message otherwise.
 */
export async function ensureSession({ askCode, status }) {
  if (verified) return true;
  for (let attempt = 0; attempt < 3; attempt++) {
    const info = await (await fetch('/api/session')).json();
    if (!info.required || info.signedIn) { verified = true; return true; }
    if (!crypto?.subtle) throw new Error('This browser cannot run the check. Open the site over https.');
    let code = '';
    if (info.needCode) {
      code = await askCode(attempt ? 'That code did not work. Try again.' : '');
      if (code === null) return false;
    }
    status('Checking that you are human');
    const nonce = await solve(info.challenge, info.bits);
    const res = await fetch('/api/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challenge: info.challenge, nonce, code }),
    });
    if (res.ok) { verified = true; return true; }
    if (res.status === 429) throw new Error((await res.json().catch(() => ({}))).error || 'Too many checks. Try again later.');
  }
  return false;
}
