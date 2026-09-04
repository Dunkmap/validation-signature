/* The OTP endpoints: request a code, then verify it.

   POST /otp/{token}/request  - mail a code to the address ON THE ENVELOPE
   POST /otp/{token}/verify   - exchange a correct code for a session secret

   The address is never taken from the request body. It is read from the
   envelope record that the token resolves to, so a caller cannot redirect the
   code to a mailbox they control - which would make the whole mechanism
   theatre. This is the single most important rule in the file. */

import { tokenLookupKey, isWellFormedToken } from '../lib/tokens.js';
import { isExpired } from '../lib/validation.js';
import { findSigner, turnRefusal } from '../lib/envelope.js';
import {
  createChallenge, codesMatch, isOtpExpired, isSessionExpired, isWellFormedCode,
  maskEmail, sendAllowance, newSessionSecret, sessionLookupKey,
  MAX_ATTEMPTS, OTP_TTL_MS, SESSION_TTL_MS,
} from '../lib/otp.js';

/* The same refusal the signing endpoints use, word for word. A prober must not
   be able to tell an unknown token from an expired one. */
const REFUSAL = 'This signing link is not valid. It may have expired or already been used. '
              + 'Please ask the sender for a new one.';

function refused() {
  return { status: 200, body: { ok: false, reason: 'REFUSED', error: REFUSAL } };
}

/* Resolve a token to its envelope and signer. Identical to the signing path:
   indistinguishable for malformed, unknown and expired. */
async function resolve(token, store, now) {
  if (!isWellFormedToken(token)) return null;
  const ref = await store.resolveToken(tokenLookupKey(token));
  if (!ref) return null;

  const envelope = await store.getEnvelope(ref.envelopeId);
  if (!envelope) return null;

  const signer = findSigner(envelope, ref.signerId);
  if (!signer) return null;

  if (isExpired(envelope.expiresAt, now)) return null;

  return { envelope, signer };
}

/* POST /otp/{token}/request - send a code to the signer's registered address. */
export async function requestOtp({ token, store, mailer, now = new Date() }) {
  const found = await resolve(token, store, now);
  if (!found) return refused();

  const { envelope, signer } = found;

  /* Do not send a code to someone who cannot sign anyway. Mailing a code for a
     document that will then refuse them is a confusing dead end, and it would
     let a stranger holding a stale token trigger mail to a real person. */
  const refusal = turnRefusal(envelope, signer);
  if (refusal) {
    if (refusal.reason !== 'NOT_YOUR_TURN') return refused();
    return {
      status: 200,
      body: {
        ok: false,
        reason: 'NOT_YOUR_TURN',
        waitingOn: refusal.waitingOn,
        error: 'It is not your turn to sign yet. This document goes to its signers in '
             + `order, and ${refusal.waitingOn} has not signed it yet. Your link stays `
             + 'valid - open it again later.',
      },
    };
  }

  const tokenHash = tokenLookupKey(token);
  const existing = await store.getChallenge(tokenHash);

  /* Two ceilings: a cooldown so a double-click does not send two mails, and a
     window cap so this endpoint cannot be used to flood a signer's inbox. */
  const allowance = sendAllowance(existing?.sendLog || [], now);
  if (!allowance.allowed) {
    return {
      status: 429,
      body: {
        ok: false,
        reason: allowance.reason,
        retryAfterSeconds: allowance.retryAfterSeconds,
        sentTo: maskEmail(signer.email),
        error: allowance.reason === 'COOLDOWN'
          ? `A code was just sent. Please wait ${allowance.retryAfterSeconds} seconds before `
            + 'asking for another, and check your inbox in the meantime.'
          : 'Too many codes have been requested for this link. Please wait a few minutes, '
            + 'or ask the sender to reissue your invitation.',
      },
    };
  }

  /* A new code retires the previous one: the old hash is overwritten, so a
     code read from an earlier mail stops working. Otherwise every resend would
     widen the set of values that unlock the document. */
  const { code, challenge } = createChallenge({ now });
  challenge.sendLog = [...(allowance.recent || []), now.toISOString()];

  try {
    await mailer.sendOtp({
      to: signer.email,          // from the ENVELOPE, never from the request
      signerName: signer.name,
      fileName: envelope.fileName,
      code,
      minutes: Math.round(OTP_TTL_MS / 60000),
    });
  } catch (e) {
    /* A code nobody received must not look like a code that was sent - that
       leaves a signer staring at an empty inbox with no idea why. Report it,
       and do not store the challenge: there is no point holding a code that
       was never delivered. */
    return {
      status: 502,
      body: {
        ok: false,
        reason: 'MAIL_FAILED',
        error: 'The verification code could not be emailed. Please try again, or contact '
             + 'the sender if this continues.',
        detail: e.message,
      },
    };
  }

  await store.putChallenge(tokenHash, challenge);

  const delivered = mailer.delivers !== false;

  return {
    status: 200,
    body: {
      ok: true,
      sentTo: maskEmail(signer.email),   // masked: enough to recognise, not to target
      expiresInSeconds: Math.round(OTP_TTL_MS / 1000),
      /* Say plainly when the mail driver does not actually deliver. Without
         this, a console-driver deployment looks identical to a working one
         while every signer is locked out. */
      ...(delivered ? {} : {
        warning: `The code was NOT emailed - the mail driver is "${mailer.driver}", which `
               + 'does not send. Read it from the server console.',
      }),
    },
  };
}

/* POST /otp/{token}/verify - exchange a correct code for a session secret. */
export async function verifyOtp({ token, body, store, clientIp, now = new Date() }) {
  const found = await resolve(token, store, now);
  if (!found) return refused();

  const { envelope, signer } = found;

  if (turnRefusal(envelope, signer)) return refused();

  const tokenHash = tokenLookupKey(token);
  const challenge = await store.getChallenge(tokenHash);

  /* No challenge, or an expired one, reads the same way: ask for a new code.
     Fails closed - a missing expiry counts as expired. */
  if (!challenge || isOtpExpired(challenge, now)) {
    if (challenge) await store.deleteChallenge(tokenHash);
    return {
      status: 200,
      body: { ok: false, reason: 'CODE_EXPIRED',
              error: 'That code has expired. Please request a new one.' },
    };
  }

  if (challenge.attempts >= MAX_ATTEMPTS) {
    return {
      status: 429,
      body: { ok: false, reason: 'TOO_MANY_ATTEMPTS',
              error: 'Too many incorrect codes were entered. Please request a new code.' },
    };
  }

  const code = typeof body?.code === 'string' ? body.code.trim() : '';

  /* Count a malformed code as an attempt too. Otherwise the attempt cap is
     trivially bypassed by padding guesses with a stray character. */
  if (!isWellFormedCode(code) || !codesMatch(code, challenge.salt, challenge.codeHash)) {
    const attempts = challenge.attempts + 1;
    await store.putChallenge(tokenHash, { ...challenge, attempts });
    const remaining = Math.max(0, MAX_ATTEMPTS - attempts);
    return {
      status: 200,
      body: {
        ok: false,
        reason: remaining ? 'CODE_INCORRECT' : 'TOO_MANY_ATTEMPTS',
        attemptsRemaining: remaining,
        error: remaining
          ? `That code is not correct. ${remaining} attempt${remaining === 1 ? '' : 's'} `
            + 'remaining before you need a new code.'
          : 'Too many incorrect codes were entered. Please request a new code.',
      },
    };
  }

  /* Correct. Burn the challenge - a code is single-use, so a value read over
     someone's shoulder cannot be replayed. */
  await store.deleteChallenge(tokenHash);

  const secret = newSessionSecret();
  await store.putSession(sessionLookupKey(secret), {
    envelopeId: envelope.envelopeId,
    signerId: signer.signerId,
    tokenHash,
    verifiedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    ip: clientIp || null,
    email: signer.email,
  });

  return {
    status: 200,
    body: {
      ok: true,
      sessionSecret: secret,
      expiresInSeconds: Math.round(SESSION_TTL_MS / 1000),
      verifiedAt: now.toISOString(),
    },
  };
}

/* Is this request carrying a live session for this token?

   Returns the session or null. Bound to the TOKEN it was issued for: a session
   verified on one signing link must not unlock another, or one verified signer
   on a multi-signer envelope could sign for everyone. */
export async function resolveSession({ token, sessionSecret, store, now = new Date() }) {
  if (!sessionSecret || typeof sessionSecret !== 'string') return null;
  if (!isWellFormedToken(token)) return null;

  const key = sessionLookupKey(sessionSecret);
  const session = await store.getSession(key);
  if (!session) return null;

  if (isSessionExpired(session, now)) {
    await store.deleteSession(key);
    return null;
  }

  if (session.tokenHash !== tokenLookupKey(token)) return null;

  return session;
}
