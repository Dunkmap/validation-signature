/* Email OTP: the verification that makes a forwarded signing link useless.

   The threat this addresses: an emailed link is a bearer token. A client who
   forwards the mail - deliberately, or by an over-broad reply-all - hands the
   authority to sign to whoever receives it. These tests are mostly about the
   BYPASSES: a gate that can be walked around is not a gate, so each way round
   it is asserted closed. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/lib/store.js';
import { createConsoleMailer } from '../src/lib/mailer.js';
import { createRouter } from '../src/router.js';
import { requestOtp, verifyOtp } from '../src/handlers/otp.js';
import { getSigningPayload } from '../src/handlers/sign.js';
import {
  maskEmail, newCode, codesMatch, createChallenge, sendAllowance, hashCode,
  MAX_ATTEMPTS, MAX_SENDS_PER_WINDOW, OTP_TTL_MS, SESSION_TTL_MS,
} from '../src/lib/otp.js';
import { tokenLookupKey } from '../src/lib/tokens.js';

const SECRET = 'test-secret';
const BASE = 'https://sign.example.com';
const pdfWith = (n) => Buffer.from(`%PDF-1.4\ndocument with ${n} signature(s)\n%%EOF`);

function setup() {
  const store = createMemoryStore();
  const mailer = createConsoleMailer({ log: () => {} });
  const route = createRouter({
    store, mailer,
    config: { sharedSecret: SECRET, baseUrl: BASE, requestNumber: 'REQ-000031' },
    allow: () => true,
  });
  return { store, mailer, route };
}

const envelopeBody = () => ({
  externalId: 'a03bm00001np9fh',
  fileName: 'Asset_Handover_Form.pdf',
  documentBase64: pdfWith(0).toString('base64'),
  expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  signers: [
    { order: 1, name: 'Priya Sharma', email: 'priya@example.com', role: 'Admin',
      box: { page: 1, x: 62.2, y: 193.09, w: 160, h: 44 } },
    { order: 2, name: 'Dillin Nair', email: 'dillin@example.com', role: 'Employee',
      box: { page: 1, x: 300, y: 193.09, w: 160, h: 44 } },
  ],
});

const create = (route, body = envelopeBody()) => route({
  method: 'POST', path: '/envelopes',
  headers: { 'x-esign-secret': SECRET }, body, clientIp: '10.0.0.1',
});

const tokenOf = (res, i) => res.body.signers[i].url.split('/s/')[1];

const askCode = (route, token, ip = '1.1.1.1') => route({
  method: 'POST', path: `/otp/${token}/request`, body: {}, clientIp: ip,
});

const sendCode = (route, token, code, ip = '1.1.1.1') => route({
  method: 'POST', path: `/otp/${token}/verify`, body: { code }, clientIp: ip,
});

const lastCode = (mailer) => mailer._sent().filter((m) => m.kind === 'otp').pop();

const signBody = () => ({
  signedDocumentBase64: pdfWith(1).toString('base64'),
  consentStatement: 'I agree that my electronic signature is binding.',
  clientContext: {
    userAgent: 'Mozilla/5.0', language: 'en-GB', platform: 'Win32',
    screen: '1920x1080', timezone: 'Asia/Kolkata', locationStatus: 'Granted',
    latitude: 18.5204, longitude: 73.8567, accuracy: 24,
  },
});

// --- the gate itself ---

test('a forwarded link yields NO document - only the masked address', async () => {
  const { route } = setup();
  const created = await create(route);
  const t1 = tokenOf(created, 0);

  // Exactly what someone who was forwarded the mail sees.
  const res = await route({ method: 'GET', path: `/sign/${t1}`, clientIp: '9.9.9.9' });

  assert.equal(res.body.ok, false);
  assert.equal(res.body.reason, 'VERIFICATION_REQUIRED');
  assert.equal(res.body.documentBase64, undefined, 'the document must NOT be served');

  /* Nor the metadata. A recipient who should not have this document must not
     learn who is signing it or what the sender said about it. */
  assert.equal(res.body.signerName, undefined);
  assert.equal(res.body.message, undefined);
  assert.equal(res.body.timeline, undefined);

  // Enough to recognise the mailbox, not enough to learn the address.
  assert.equal(res.body.sentTo, 'p***@example.com');
  assert.ok(!JSON.stringify(res.body).includes('priya@example.com'),
    'the full address must never be echoed to an unverified caller');
});

test('the full flow: request a code, verify it, then the document opens', async () => {
  const { route, mailer } = setup();
  const created = await create(route);
  const t1 = tokenOf(created, 0);

  const asked = await askCode(route, t1);
  assert.equal(asked.body.ok, true);
  assert.equal(asked.body.sentTo, 'p***@example.com');

  // The code went to the address on the ENVELOPE.
  const mail = lastCode(mailer);
  assert.equal(mail.to, 'priya@example.com');
  assert.match(mail.code, /^[0-9]{6}$/);
  assert.equal(mail.fileName, 'Asset_Handover_Form.pdf');

  const done = await sendCode(route, t1, mail.code);
  assert.equal(done.body.ok, true);
  assert.match(done.body.sessionSecret, /^[0-9a-f]{64}$/);

  // With the session, the document opens.
  const open = await route({
    method: 'GET', path: `/sign/${t1}`, clientIp: '203.0.113.44',
    headers: { 'x-esign-session': done.body.sessionSecret },
  });
  assert.equal(open.body.ok, true);
  assert.equal(Buffer.from(open.body.documentBase64, 'base64').toString(),
    pdfWith(0).toString());
  assert.equal(open.body.signerName, 'Priya Sharma');
});

test('the OTP mail carries the code but NOT the signing link', async () => {
  const { route, mailer } = setup();
  const created = await create(route);
  const t1 = tokenOf(created, 0);
  await askCode(route, t1);

  /* A mail containing both the link and the code would be a single forwardable
     message - which is precisely what the code exists to prevent. */
  const mail = lastCode(mailer);
  assert.equal(mail.url, undefined, 'the OTP mail must not carry a signing link');
  assert.ok(!JSON.stringify(mail).includes(t1), 'and must not contain the token');
});

// --- the bypasses, each asserted closed ---

test('POST /sign is gated independently of GET - the read gate is not the only one', async () => {
  const { route } = setup();
  const created = await create(route);
  const t1 = tokenOf(created, 0);

  /* Submitting straight to POST without ever calling GET. A gate only on the
     read path would stop nobody, since a forwarded link holder can POST. */
  const res = await route({
    method: 'POST', path: `/sign/${t1}`, clientIp: '9.9.9.9', body: signBody(),
  });

  assert.equal(res.body.ok, false);
  assert.equal(res.body.reason, 'VERIFICATION_REQUIRED');
  assert.equal(res.body.documentHash, undefined, 'nothing should have been signed');
});

test('a session verified on one link does NOT unlock another signer', async () => {
  const { route, mailer } = setup();
  const created = await create(route);
  const [t1, t2] = [0, 1].map((i) => tokenOf(created, i));

  await askCode(route, t1);
  const s1 = await sendCode(route, t1, lastCode(mailer).code);
  assert.equal(s1.body.ok, true);

  /* Signer 1 presenting their own session against signer 2's link. Without
     binding the session to its token, one verified signer could sign for
     everyone on the envelope. */
  const res = await route({
    method: 'GET', path: `/sign/${t2}`, clientIp: '1.1.1.1',
    headers: { 'x-esign-session': s1.body.sessionSecret },
  });
  assert.notEqual(res.body.ok, true);
  assert.equal(res.body.documentBase64, undefined);
});

test('an invented session secret is refused', async () => {
  const { route } = setup();
  const created = await create(route);
  const t1 = tokenOf(created, 0);

  for (const fake of ['f'.repeat(64), 'not-a-session', '', 'a'.repeat(63)]) {
    const res = await route({
      method: 'GET', path: `/sign/${t1}`, clientIp: '1.1.1.1',
      headers: { 'x-esign-session': fake },
    });
    assert.equal(res.body.reason, 'VERIFICATION_REQUIRED', `refused: ${fake.slice(0, 12)}`);
  }
});

test('the code is emailed to the ENVELOPE address, never one from the request', async () => {
  const { route, mailer } = setup();
  const created = await create(route);
  const t1 = tokenOf(created, 0);

  /* An attacker holding a forwarded link tries to redirect the code to a
     mailbox they control. If this were honoured, the whole mechanism would be
     theatre. */
  await route({
    method: 'POST', path: `/otp/${t1}/request`, clientIp: '9.9.9.9',
    body: { email: 'attacker@evil.example', to: 'attacker@evil.example' },
  });

  const mail = lastCode(mailer);
  assert.equal(mail.to, 'priya@example.com', 'the code must go to the address on file');
  assert.ok(!JSON.stringify(mailer._sent()).includes('attacker@evil.example'));
});

test('a used code cannot be replayed', async () => {
  const { route, mailer } = setup();
  const created = await create(route);
  const t1 = tokenOf(created, 0);

  await askCode(route, t1);
  const code = lastCode(mailer).code;

  assert.equal((await sendCode(route, t1, code)).body.ok, true);

  // Single use: a code read over a shoulder must not work twice.
  const again = await sendCode(route, t1, code);
  assert.equal(again.body.ok, false);
  assert.equal(again.body.reason, 'CODE_EXPIRED');
});

test('requesting a new code retires the previous one', async () => {
  /* Called through the handler with an advancing clock, to step past the
     resend cooldown - retirement is the point here, not the cooldown. */
  const { store, mailer, route } = setup();
  const created = await create(route);
  const tk = tokenOf(created, 0);
  const later = new Date(Date.now() + 60_000);

  await requestOtp({ token: tk, store, mailer });
  const first = lastCode(mailer).code;

  await requestOtp({ token: tk, store, mailer, now: later });
  const second = lastCode(mailer).code;

  /* Otherwise every resend would widen the set of values that unlock the
     document. Guard against the 1-in-10^6 case where both draws match. */
  if (first !== second) {
    const stale = await verifyOtp({ token: tk, body: { code: first }, store, now: later });
    assert.equal(stale.body.ok, false, 'a superseded code must stop working');
  }

  const fresh = await verifyOtp({ token: tk, body: { code: second }, store, now: later });
  assert.equal(fresh.body.ok, true, 'the newest code must work');
});

test('wrong codes are capped, and the cap counts malformed guesses too', async () => {
  const { route, mailer } = setup();
  const created = await create(route);
  const t1 = tokenOf(created, 0);
  await askCode(route, t1);
  const real = lastCode(mailer).code;

  // A 6-digit code is only 10^6 wide, so an uncapped endpoint is brute-forceable.
  const wrong = real === '000000' ? '111111' : '000000';
  for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
    const res = await sendCode(route, t1, wrong);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.attemptsRemaining, MAX_ATTEMPTS - i);
  }

  // Even the CORRECT code is now refused: the challenge is spent.
  const after = await sendCode(route, t1, real);
  assert.equal(after.body.ok, false);
  assert.equal(after.body.reason, 'TOO_MANY_ATTEMPTS');
});

test('a malformed code still consumes an attempt', async () => {
  const { route } = setup();
  const created = await create(route);
  const t1 = tokenOf(created, 0);
  await askCode(route, t1);

  /* Otherwise the cap is bypassed by padding each guess with a stray
     character, and the attempt counter never moves. */
  const res = await sendCode(route, t1, '12345x');
  assert.equal(res.body.ok, false);
  assert.equal(res.body.attemptsRemaining, MAX_ATTEMPTS - 1);
});

test('an expired code is refused', async () => {
  const { store, mailer, route } = setup();
  const created = await create(route);
  const tk = tokenOf(created, 0);

  await requestOtp({ token: tk, store, mailer });
  const code = lastCode(mailer).code;

  // One millisecond past the TTL. Fails closed.
  const after = new Date(Date.now() + OTP_TTL_MS + 1);
  const res = await verifyOtp({ token: tk, body: { code }, store, now: after });
  assert.equal(res.body.ok, false);
  assert.equal(res.body.reason, 'CODE_EXPIRED');
});

test('a session expires, and the document closes again', async () => {
  const { store, mailer, route } = setup();
  const created = await create(route);
  const tk = tokenOf(created, 0);

  await requestOtp({ token: tk, store, mailer });
  const code = mailer._sent().filter((m) => m.kind === 'otp').pop().code;
  const done = await verifyOtp({ token: tk, body: { code }, store });
  const secret = done.body.sessionSecret;

  // Inside the window it opens.
  const open = await getSigningPayload({ token: tk, store, sessionSecret: secret });
  assert.equal(open.body.ok, true);

  // Past it, verification is required again - a shared or borrowed device must
  // not stay unlocked indefinitely.
  const later = new Date(Date.now() + SESSION_TTL_MS + 1000);
  const shut = await getSigningPayload({ token: tk, store, sessionSecret: secret, now: later });
  assert.equal(shut.body.ok, false);
  assert.equal(shut.body.reason, 'VERIFICATION_REQUIRED');
});

test('codes-per-link is capped, so the endpoint cannot flood an inbox', async () => {
  const { store, mailer, route } = setup();
  const created = await create(route);
  const tk = tokenOf(created, 0);

  // Step past the cooldown each time; the WINDOW cap is what is under test.
  let now = new Date();
  for (let i = 0; i < MAX_SENDS_PER_WINDOW; i += 1) {
    const res = await requestOtp({ token: tk, store, mailer, now });
    assert.equal(res.body.ok, true, `send ${i + 1} should be allowed`);
    now = new Date(now.getTime() + 60_000);
  }

  const over = await requestOtp({ token: tk, store, mailer, now });
  assert.equal(over.status, 429);
  assert.equal(over.body.reason, 'SEND_LIMIT');
  assert.equal(mailer._sent().filter((m) => m.kind === 'otp').length, MAX_SENDS_PER_WINDOW);
});

test('a rapid second request is held off by the cooldown', async () => {
  const { route } = setup();
  const created = await create(route);
  const tk = tokenOf(created, 0);

  assert.equal((await askCode(route, tk)).body.ok, true);

  // A double-clicked button must not send two mails.
  const again = await askCode(route, tk);
  assert.equal(again.status, 429);
  assert.equal(again.body.reason, 'COOLDOWN');
  assert.ok(again.body.retryAfterSeconds > 0);
});

test('no code is sent to a signer whose turn has not come', async () => {
  const { route, mailer } = setup();
  const created = await create(route);
  const t2 = tokenOf(created, 1);

  const res = await askCode(route, t2);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.reason, 'NOT_YOUR_TURN');
  assert.equal(res.body.waitingOn, 'Priya Sharma');

  // Nothing was mailed: a stale token must not be usable to trigger mail.
  assert.equal(mailer._sent().filter((m) => m.kind === 'otp').length, 0);
});

test('an unknown token gives the same refusal as everywhere else, and mails nothing', async () => {
  const { route, mailer } = setup();

  const res = await askCode(route, 'a'.repeat(64));
  assert.equal(res.body.reason, 'REFUSED');
  assert.match(res.body.error, /not valid/);
  assert.equal(mailer._sent().length, 0);
});

test('the signature records that the mailbox was proven', async () => {
  const { store, mailer, route } = setup();
  const created = await create(route);
  const tk = tokenOf(created, 0);

  await requestOtp({ token: tk, store, mailer });
  const code = mailer._sent().filter((m) => m.kind === 'otp').pop().code;
  const done = await verifyOtp({ token: tk, body: { code }, store });

  await route({
    method: 'POST', path: `/sign/${tk}`, clientIp: '203.0.113.44', body: signBody(),
    headers: { 'x-esign-session': done.body.sessionSecret },
  });

  /* Evidence, not decoration: the certificate can now state that this signer
     proved control of the address the document was sent to. */
  const env = await store.getEnvelope(created.body.envelopeId);
  const signer = env.signers.find((s) => s.order === 1);
  assert.equal(signer.emailVerifiedTo, 'priya@example.com');
  assert.match(signer.emailVerifiedAt, /^\d{4}-\d{2}-\d{2}T/);
});

// --- the primitives ---

test('codes are 6 digits from a real RNG, and not all the same', () => {
  const codes = new Set();
  for (let i = 0; i < 200; i += 1) {
    const c = newCode();
    assert.match(c, /^[0-9]{6}$/, 'six digits, zero-padded');
    codes.add(c);
  }
  // 200 draws from 10^6 colliding into a handful would mean a broken RNG.
  assert.ok(codes.size > 150, `expected variety, got ${codes.size} distinct`);
});

test('a stored challenge contains no usable code', () => {
  const { code, challenge } = createChallenge();

  /* A leaked store must not hand over working codes. Salted, so the 10^6-wide
     space cannot simply be pre-computed once for every record. */
  assert.ok(!JSON.stringify(challenge).includes(code));
  assert.match(challenge.codeHash, /^[0-9a-f]{64}$/);
  assert.match(challenge.salt, /^[0-9a-f]{32}$/);
  assert.equal(challenge.attempts, 0);

  assert.ok(codesMatch(code, challenge.salt, challenge.codeHash));

  // The same code under a different salt hashes differently.
  const other = createChallenge();
  assert.notEqual(hashCode(code, challenge.salt), hashCode(code, other.challenge.salt));
});

test('maskEmail shows enough to recognise, not enough to target', () => {
  assert.equal(maskEmail('priya.sharma@example.com'), 'p***@example.com');
  assert.equal(maskEmail('a@example.com'), '*@example.com');
  // Fails safe on rubbish rather than throwing mid-refusal.
  assert.equal(maskEmail(''), 'your email address');
  assert.equal(maskEmail(null), 'your email address');
  assert.equal(maskEmail('no-at-sign'), 'your email address');
});

test('sendAllowance separates the cooldown from the window cap', () => {
  const now = new Date();
  const ago = (ms) => new Date(now.getTime() - ms).toISOString();

  assert.equal(sendAllowance([], now).allowed, true);

  // Just sent: held off briefly.
  assert.equal(sendAllowance([ago(1000)], now).reason, 'COOLDOWN');

  // Past the cooldown, under the cap: allowed.
  assert.equal(sendAllowance([ago(120_000)], now).allowed, true);

  // At the cap within the window: refused, with a wait.
  const many = Array.from({ length: MAX_SENDS_PER_WINDOW }, (_, i) => ago(60_000 * (i + 1)));
  const capped = sendAllowance(many, now);
  assert.equal(capped.reason, 'SEND_LIMIT');
  assert.ok(capped.retryAfterSeconds > 0);

  // Sends older than the window do not count against it.
  assert.equal(sendAllowance(many.map(() => ago(60 * 60_000)), now).allowed, true);
});

test('the store round-trips challenges and sessions, and deletes them', async () => {
  const { store } = setup();
  const tokenHash = tokenLookupKey('b'.repeat(64));

  await store.putChallenge(tokenHash, { salt: 'x', codeHash: 'y', attempts: 0 });
  const read = await store.getChallenge(tokenHash);
  assert.equal(read.salt, 'x');

  await store.deleteChallenge(tokenHash);
  assert.equal(await store.getChallenge(tokenHash), null);

  await store.putSession('k', { tokenHash, expiresAt: 'later' });
  assert.equal((await store.getSession('k')).tokenHash, tokenHash);
  await store.deleteSession('k');
  assert.equal(await store.getSession('k'), null);
});
