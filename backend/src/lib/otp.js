/* Email OTP: proof that the person holding a signing link also controls the
   mailbox it was sent to.

   The problem this solves: an emailed signing link is a bearer token. Whoever
   holds the URL is the signer, as far as the server is concerned - so a link
   forwarded to a colleague, or left in a reply-all thread, hands over the
   authority to sign. Requiring a code sent to the signer's registered address
   means the link alone is no longer enough, and the second factor does not
   travel with a forward.

   The honest limit: this binds to the MAILBOX, not the person. Someone who
   forwards both the link and the code, or a shared accounts@ inbox, still gets
   through. It closes casual forwarding, not a determined insider.

   Rules that carry the weight:
     - The address is NEVER taken from the request. It comes from the envelope
       record, keyed by the token. A client-supplied address would let anyone
       redirect the code to themselves and defeat the whole mechanism.
     - Codes are stored HASHED, alongside a per-code salt, so a leaked store
       yields no working codes.
     - Compared in constant time, attempt-capped, and expiring - a 6-digit code
       is only 10^6 wide, so an uncapped endpoint is brute-forceable in minutes.
*/

import { randomInt, randomBytes, createHash, timingSafeEqual } from 'node:crypto';

/* A code is valid 2 minutes. Short on purpose: it narrows the window in which
   a code sitting in an open inbox, or read off a notification, is still worth
   anything. The resend cooldown is 30s, so someone whose code lapses can ask
   for another immediately rather than being stranded. */
export const OTP_TTL_MS = 2 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 60 * 1000;    // a verified session lasts 30
export const MAX_ATTEMPTS = 5;                   // wrong guesses per code
export const MAX_SENDS_PER_WINDOW = 5;           // codes per token per window
export const SEND_WINDOW_MS = 15 * 60 * 1000;
export const RESEND_COOLDOWN_MS = 30 * 1000;     // between requests for a code

const CODE_RE = /^[0-9]{6}$/;

/* A 6-digit code from a cryptographic RNG. randomInt, not Math.random: the
   code is an authentication factor, and Math.random is predictable from a few
   prior outputs. Padded, so 000123 keeps its full six digits. */
export function newCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function isWellFormedCode(c) {
  return typeof c === 'string' && CODE_RE.test(c);
}

/* Hash with a per-code salt. The space is only 10^6 wide, so an unsalted
   digest is reversible by brute force in well under a second - the salt makes
   a leaked record useless without also doing that work per record. */
export function hashCode(code, salt) {
  return createHash('sha256').update(`${salt}:${code}`, 'utf8').digest('hex');
}

export function newSalt() {
  return randomBytes(16).toString('hex');
}

/* Constant-time compare. A plain === leaks, through timing, how many leading
   digits were right, which turns 10^6 guesses into far fewer. */
export function codesMatch(code, salt, expectedHash) {
  if (!isWellFormedCode(code) || typeof expectedHash !== 'string') return false;
  const a = Buffer.from(hashCode(code, salt), 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/* The session secret handed back on success. 32 bytes, so it cannot be guessed
   the way a 6-digit code could - this is what the page presents afterwards
   instead of re-entering a code. */
export function newSessionSecret() {
  return randomBytes(32).toString('hex');
}

const SESSION_RE = /^[0-9a-f]{64}$/;

export function isWellFormedSession(s) {
  return typeof s === 'string' && SESSION_RE.test(s);
}

export function sessionLookupKey(secret) {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function sessionsEqual(a, b) {
  if (!isWellFormedSession(a) || !isWellFormedSession(b)) return false;
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/* Mask an address for display. The signer needs to recognise which mailbox to
   check; anyone who forwarded themselves the link must not learn the address
   they would need to compromise. Keeps the first character and the domain.

     priya.sharma@example.com  ->  p***@example.com
     a@example.com             ->  *@example.com
*/
export function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) return 'your email address';
  const [local, ...rest] = email.split('@');
  const domain = rest.join('@');
  if (local.length <= 1) return `*@${domain}`;
  return `${local[0]}***@${domain}`;
}

export function isOtpExpired(challenge, now = new Date()) {
  if (!challenge || !challenge.expiresAt) return true;
  const t = new Date(challenge.expiresAt);
  if (Number.isNaN(t.getTime())) return true;
  return t.getTime() <= now.getTime();
}

export function isSessionExpired(session, now = new Date()) {
  if (!session || !session.expiresAt) return true;
  const t = new Date(session.expiresAt);
  if (Number.isNaN(t.getTime())) return true;
  return t.getTime() <= now.getTime();
}

/* Build a fresh challenge record. The plain code is returned separately and is
   never part of what gets stored. */
export function createChallenge({ now = new Date() } = {}) {
  const code = newCode();
  const salt = newSalt();
  return {
    code,
    challenge: {
      salt,
      codeHash: hashCode(code, salt),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + OTP_TTL_MS).toISOString(),
      attempts: 0,
    },
  };
}

/* Whether another code may be sent, and if not, why. Two separate ceilings: a
   short cooldown that stops a double-click sending two mails, and a window cap
   that stops the endpoint being used to flood someone's inbox. */
export function sendAllowance(sendLog = [], now = new Date()) {
  const t = now.getTime();
  const recent = sendLog
    .map((s) => new Date(s).getTime())
    .filter((ms) => Number.isFinite(ms) && t - ms < SEND_WINDOW_MS);

  const last = recent.length ? Math.max(...recent) : null;
  if (last !== null && t - last < RESEND_COOLDOWN_MS) {
    return {
      allowed: false,
      reason: 'COOLDOWN',
      retryAfterSeconds: Math.ceil((RESEND_COOLDOWN_MS - (t - last)) / 1000),
    };
  }
  if (recent.length >= MAX_SENDS_PER_WINDOW) {
    return {
      allowed: false,
      reason: 'SEND_LIMIT',
      retryAfterSeconds: Math.ceil((SEND_WINDOW_MS - (t - Math.min(...recent))) / 1000),
    };
  }
  return { allowed: true, recent: recent.map((ms) => new Date(ms).toISOString()) };
}
