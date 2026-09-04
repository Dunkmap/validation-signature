import { tokenLookupKey, sha256Hex, isWellFormedToken } from '../lib/tokens.js';
import { validateSignSubmission, decodeBase64, isExpired } from '../lib/validation.js';
import {
  findSigner, turnRefusal, timelineBefore, documentKey, currentVersion,
  isComplete, waitingOn, signedCount, buildSignedFileName, SIGNER_STATUS,
} from '../lib/envelope.js';
import { resolveSession } from './otp.js';
import { maskEmail } from '../lib/otp.js';

/* Every refusal returns this exact sentence, so a stranger probing tokens
   learns nothing about which exist. The single deliberate exception is
   NOT_YOUR_TURN, which names the person being waited on. */
const REFUSAL = 'This signing link is not valid. It may have expired or already been used. '
              + 'Please ask the sender for a new one.';

function refused() {
  return { status: 200, body: { ok: false, reason: 'REFUSED', error: REFUSAL } };
}

/* An emailed signing link is a bearer token: whoever holds the URL is the
   signer, as far as this server can tell. So a link forwarded to a colleague -
   deliberately, or by an over-broad reply-all - hands over the authority to
   sign. Requiring a code sent to the signer's registered address means the
   link alone is no longer enough.

   This refusal is what a forwarded link gets: no document, no signer name, no
   sender message. Only the masked address of the mailbox that can unlock it. */
function needsVerification(signer) {
  return {
    status: 200,
    body: {
      ok: false,
      reason: 'VERIFICATION_REQUIRED',
      sentTo: maskEmail(signer.email),
      error: 'Before this document can be opened, we need to confirm you are the person '
           + 'it was sent to. We will email a verification code to the address on file.',
    },
  };
}

function notYourTurn(name) {
  return {
    status: 200,
    body: {
      ok: false,
      reason: 'NOT_YOUR_TURN',
      waitingOn: name,
      error: `It is not your turn to sign yet. This document goes to its signers in order, `
           + `and ${name} has not signed it yet. Your link stays valid - open it again later.`,
    },
  };
}

/* Resolve a token to its envelope and signer, or null.

   Indistinguishable for every failure mode: malformed, unknown, expired. The
   caller cannot tell which, and neither can an attacker. */
async function resolve(token, store, now) {
  if (!isWellFormedToken(token)) return null;
  const ref = await store.resolveToken(tokenLookupKey(token));
  if (!ref) return null;

  const envelope = await store.getEnvelope(ref.envelopeId);
  if (!envelope) return null;

  const signer = findSigner(envelope, ref.signerId);
  if (!signer) return null;

  // Fail closed: a missing or unparseable expiry means expired.
  if (isExpired(envelope.expiresAt, now)) return null;

  return { envelope, signer };
}

/* GET /sign/{token} - the document as it stands, or a refusal. */
export async function getSigningPayload({
  token, store, clientIp, sessionSecret = null, now = new Date(),
}) {
  const found = await resolve(token, store, now);
  if (!found) return refused();

  const { envelope, signer } = found;

  /* Whose turn it is comes FIRST. A signer waiting their turn should be told
     so plainly rather than sent through a verification they do not yet need. */
  const refusal = turnRefusal(envelope, signer);
  if (refusal) {
    return refusal.reason === 'NOT_YOUR_TURN' ? notYourTurn(refusal.waitingOn) : refused();
  }

  /* Gate the DOCUMENT, not merely the signature. A forwarded link must not
     expose the contents either - by the time someone has read the document,
     blocking their signature is a partial defence at best. */
  const session = await resolveSession({ token, sessionSecret, store, now });
  if (!session) return needsVerification(signer);

  // Serve the version carrying every signature taken so far - this is the part
  // that was impossible on Salesforce, where a guest user cannot store a file.
  const version = currentVersion(envelope);
  const bytes = await store.getObject(documentKey(envelope.envelopeId, version));
  if (!bytes) {
    // The record says it exists but the bytes do not. Surface it rather than
    // pretending the link is merely invalid.
    return {
      status: 500,
      body: { ok: false, reason: 'ERROR',
              error: 'The document could not be retrieved. Please contact the sender.' },
    };
  }

  return {
    status: 200,
    body: {
      ok: true,
      fileName: envelope.fileName,
      signerName: signer.name,
      signerRole: signer.role,
      signOrder: signer.order,
      signerCount: envelope.signers.length,
      message: envelope.message,
      box: signer.box,
      documentBase64: bytes.toString('base64'),
      signerIp: clientIp,          // server-observed; the page prints it
      timeline: timelineBefore(envelope, signer),
    },
  };
}

/* POST /sign/{token} - accept a signed document, store it, hash it. */
export async function submitSignature({
  token, body, store, clientIp, onComplete, sessionSecret = null,
  now = new Date(), requestNumber = null,
}) {
  const found = await resolve(token, store, now);
  if (!found) return refused();

  const { envelope, signer } = found;

  const refusal = turnRefusal(envelope, signer);
  if (refusal) {
    return refusal.reason === 'NOT_YOUR_TURN' ? notYourTurn(refusal.waitingOn) : refused();
  }

  /* Re-check the session here, independently. Never rely on the GET having
     checked it: a POST is a separate request and can be made directly, so a
     gate only on the read path would stop nobody. */
  const session = await resolveSession({ token, sessionSecret, store, now });
  if (!session) return needsVerification(signer);

  const errors = validateSignSubmission(body);
  if (errors.length) {
    return { status: 400, body: { ok: false, error: errors.join('; ') } };
  }

  const bytes = decodeBase64(body.signedDocumentBase64);

  /* Hash the bytes we actually stored, server-side. Never trust a hash the
     client sends. Each signature has its own hash and they differ - each
     signer hashes a document carrying one fewer signature than the next. */
  const documentHash = sha256Hex(bytes);

  const version = currentVersion(envelope) + 1;
  await store.putObject(documentKey(envelope.envelopeId, version), bytes);

  const ctx = body.clientContext;
  const signedAt = now.toISOString();

  // Fixed when the FIRST signature completes; later signers inherit it.
  const fileName = envelope.signedFileName
    || buildSignedFileName({ requestNumber, originalName: envelope.fileName });

  const updated = {
    ...envelope,
    signedFileName: fileName,
    signers: envelope.signers.map((s) => (s.signerId === signer.signerId ? {
      ...s,
      status: SIGNER_STATUS.SIGNED,
      signedAt,
      documentHash,
      version,
      ip: clientIp,
      consentStatement: body.consentStatement,
      userAgent: ctx.userAgent || '',
      language: ctx.language || '',
      platform: ctx.platform || '',
      screen: ctx.screen || '',
      timezone: ctx.timezone || '',
      /* Part of the evidence: this signature was taken after the signer
         proved control of the mailbox it was addressed to. */
      emailVerifiedAt: session.verifiedAt,
      emailVerifiedTo: signer.email,
      locationStatus: ctx.locationStatus,
      latitude: ctx.latitude ?? null,
      longitude: ctx.longitude ?? null,
      accuracy: ctx.accuracy ?? null,
    } : s)),
  };

  const complete = isComplete(updated);
  if (complete) updated.completedAt = signedAt;

  await store.putEnvelope(updated);

  const response = {
    ok: true,
    fileName,
    documentHash,
    complete,
    waitingOn: waitingOn(updated),
  };

  if (complete && onComplete) {
    /* Write back to Salesforce, then delete the S3 copies - and ONLY in that
       order. A deleted document with a failed write-back is unrecoverable.

       A failure here must not be swallowed: the signature is safely stored, so
       the signer is told it succeeded, but the completion problem is reported
       so it can be retried rather than silently lost. */
    try {
      await onComplete(updated);
    } catch (e) {
      response.completionError = e.message;
    }
  }

  return { status: 200, body: response };
}

/* GET /status/{token} - polled while waiting. */
export async function getStatus({ token, store, now = new Date() }) {
  const found = await resolve(token, store, now);
  if (!found) return refused();

  const { envelope } = found;
  return {
    status: 200,
    body: {
      ok: true,
      signedCount: signedCount(envelope),
      totalCount: envelope.signers.length,
      waitingOn: waitingOn(envelope),
      complete: isComplete(envelope),
    },
  };
}

/* GET /download/{token} - only once complete. Available to every signer. */
export async function downloadDocument({ token, store, now = new Date() }) {
  const found = await resolve(token, store, now);
  if (!found) return refused();

  const { envelope } = found;
  if (!isComplete(envelope)) {
    return {
      status: 409,
      body: { ok: false, reason: 'NOT_COMPLETE',
              error: 'This document is not finished yet. It becomes available to download '
                   + 'once every signer has signed.' },
    };
  }

  /* Serve the STORED bytes. Never rebuild: pdf-lib stamps a fresh creation
     date and new object ids on every save, so a re-render would not match the
     hash the certificate attests to. */
  const version = currentVersion(envelope);
  const bytes = await store.getObject(documentKey(envelope.envelopeId, version));
  if (!bytes) {
    return {
      status: 410,
      body: { ok: false, reason: 'GONE',
              error: 'The signed document is no longer stored here. It has been filed in '
                   + 'Salesforce; please retrieve it from the request record.' },
    };
  }

  return {
    status: 200,
    isBinary: true,
    contentType: 'application/pdf',
    fileName: envelope.signedFileName || envelope.fileName,
    body: bytes,
  };
}
