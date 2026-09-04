import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

/* 64 hex characters from a cryptographic RNG. Never a timestamp, a counter, or
   a hashed sequential id - those are guessable, and the token is the whole
   authorisation. */
export function newToken() {
  return randomBytes(32).toString('hex');
}

const TOKEN_RE = /^[0-9a-f]{64}$/;

export function isWellFormedToken(t) {
  return typeof t === 'string' && TOKEN_RE.test(t);
}

/* Compare in constant time. A plain === leaks, through timing, how much of a
   guess was correct, which turns blind guessing into a character-by-character
   search. */
export function tokensEqual(a, b) {
  if (!isWellFormedToken(a) || !isWellFormedToken(b)) return false;
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/* Tokens are stored hashed, so a leaked database does not hand over working
   signing links. The lookup key is the hash, never the token itself. */
export function tokenLookupKey(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
