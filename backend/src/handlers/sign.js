import { tokenLookupKey, sha256Hex, isWellFormedToken } from '../lib/tokens.js';
import { validateSignSubmission, decodeBase64, isExpired } from '../lib/validation.js';
import {
  findSigner, turnRefusal, signedSoFar, originalKey,
  signerDocumentKey, mergedKey, orderedSigners,
  isComplete, waitingOn, signedCount, buildSignedFileName, SIGNER_STATUS,
} from '../lib/envelope.js';
import { mergeSignatures } from '../lib/merge.js';
import { signPdf } from '../lib/digital-signature.js';
import { resolveSession } from './otp.js';
import { maskEmail } from '../lib/otp.js';

/* Every refusal returns this exact sentence, so a stranger probing tokens
   learns nothing about which exist - unknown, expired and already-signed are
   indistinguishable. */
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

  /* Already signed? A token is good for one signature, taken whenever its
     holder chooses. Checked before verification so a spent link does not send
     someone through an OTP that leads nowhere. */
  if (turnRefusal(envelope, signer)) return refused();

  /* Gate the DOCUMENT, not merely the signature. A forwarded link must not
     expose the contents either - by the time someone has read the document,
     blocking their signature is a partial defence at best. */
  const session = await resolveSession({ token, sessionSecret, store, now });
  if (!session) return needsVerification(signer);

  /* Serve the ORIGINAL, always - not whatever the last signer produced.

     Signing is unordered, so two people may hold this document at the same
     moment. If each were served the other's work-in-progress, whichever saved
     second would overwrite the first signature and it would be lost without a
     trace. Instead everyone stamps a clean copy and the server merges them. */
  const bytes = await store.getObject(originalKey(envelope.envelopeId));
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
      /* No ordering: anyone may sign at any time. The page uses this to say
         so plainly rather than implying a queue. */
      ordered: false,
      message: envelope.message,
      box: signer.box,
      documentBase64: bytes.toString('base64'),
      signerIp: clientIp,          // server-observed; the page prints it
      timeline: signedSoFar(envelope, signer),
    },
  };
}

/* POST /sign/{token} - accept a signed document, store it, hash it. */
export async function submitSignature({
  token, body, store, clientIp, onComplete, sessionSecret = null,
  now = new Date(), requestNumber = null, signingCertificate = null,
}) {
  const found = await resolve(token, store, now);
  if (!found) return refused();

  const { envelope, signer } = found;

  if (turnRefusal(envelope, signer)) return refused();

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

  /* Store this signer's own stamped copy under a key nobody else can claim.
     Keyed by signer, never by a running version number - two simultaneous
     signers would otherwise compute the same next number and one would
     overwrite the other. */
  await store.putObject(signerDocumentKey(envelope.envelopeId, signer.signerId), bytes);

  const ctx = body.clientContext;
  const signedAt = now.toISOString();

  // Fixed when the FIRST signature completes; later signers inherit it.
  const fileName = envelope.signedFileName
    || buildSignedFileName({ requestNumber, originalName: envelope.fileName });

  /* Write ONLY this signer's fields, re-reading the envelope inside the store
     so a signature taken at the same moment is not erased.

     Signing is unordered, so two requests can be in flight together. Each read
     the envelope when it started; writing back a whole envelope built from
     that stale copy would silently drop the other person's signature. */
  const patch = {
    status: SIGNER_STATUS.SIGNED,
    signedAt,
    documentHash,
    ip: clientIp,
    consentStatement: body.consentStatement,
    /* The version this signer actually signed: always the original, since
       everyone starts from the same clean document now. */
    version: 0,
    userAgent: ctx.userAgent || '',
    language: ctx.language || '',
    platform: ctx.platform || '',
    screen: ctx.screen || '',
    timezone: ctx.timezone || '',
    /* Part of the evidence: this signature was taken after the signer proved
       control of the mailbox it was addressed to. */
    emailVerifiedAt: session.verifiedAt,
    emailVerifiedTo: signer.email,
    locationStatus: ctx.locationStatus,
    latitude: ctx.latitude ?? null,
    longitude: ctx.longitude ?? null,
    accuracy: ctx.accuracy ?? null,
  };

  /* Decide the envelope-level fields INSIDE the same atomic update, from the
     record as it stands once this signature is applied. Doing it afterwards
     would mean writing a whole envelope built from a copy read before another
     signer's concurrent signature landed - erasing it. */
  const updated = await store.updateSigner(
    envelope.envelopeId, signer.signerId, patch,
    (env) => {
      const next = { ...env };
      // Fixed by whoever signs FIRST; everyone after inherits it unchanged.
      if (!next.signedFileName) next.signedFileName = fileName;
      if (isComplete(next) && !next.completedAt) next.completedAt = signedAt;
      return next;
    },
  );
  if (!updated) return refused();

  const complete = isComplete(updated);

  /* Rebuild the merged document from the original plus every signature taken
     so far. Done after each signature, not only at the end, so the current
     state is always downloadable and a stalled envelope still shows the
     signatures it does have.

     A merge failure must not fail the request: the signature is already
     stored and the envelope already records it. Losing the response here
     would tell a signer their signature failed when it did not. */
  let mergeError = null;
  try {
    await rebuildMerged(updated, store, signingCertificate);
  } catch (e) {
    mergeError = e.message;
    /* Log it as well as returning it. A merge that fails silently leaves a
       finished envelope with no downloadable document and no explanation. */
    console.error('[merge] rebuild failed:', e.message);
  }

  const response = {
    ok: true,
    fileName: updated.signedFileName || fileName,
    documentHash,
    complete,
    /* Everyone still outstanding. Not a queue - any of them may sign next, or
       at the same time. */
    waitingOn: waitingOn(updated),
    ...(mergeError ? { mergeError } : {}),
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

/* Rebuild the finished document: the original, plus each signer's own stamped
   copy merged back onto it, plus a certificate page per signer. */
async function rebuildMerged(envelope, store, signingCertificate = null) {
  const originalBytes = await store.getObject(originalKey(envelope.envelopeId));
  if (!originalBytes) throw new Error('the original document is missing');

  const signed = [];
  for (const s of orderedSigners(envelope)) {
    if (s.status !== SIGNER_STATUS.SIGNED) continue;
    const bytes = await store.getObject(signerDocumentKey(envelope.envelopeId, s.signerId));
    signed.push({ signer: s, bytes });
  }

  const merged = await mergeSignatures({ originalBytes, signers: signed });

  /* Apply the cryptographic signature LAST, over the finished bytes.

     A PDF signature covers exactly the bytes it was applied to, so it has to
     come after the merge - signing first and then merging another signature
     in would invalidate it, and Adobe would report the document as modified.
     That is why this rebuild re-signs from scratch each time rather than
     adding to what is already there. */
  const { bytes } = await signPdf(merged, signingCertificate, {
    name: 'Exceller Technologies',
    signedAt: new Date(),
  });

  await store.putObject(mergedKey(envelope.envelopeId), bytes);
  return bytes;
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

  /* Serve the STORED merged bytes. Never rebuild on the way out: pdf-lib
     stamps a fresh creation date and new object ids on every save, so a
     re-render would differ byte for byte from what was hashed and downloaded
     before. The merge is written once, when the signature is taken. */
  const bytes = await store.getObject(mergedKey(envelope.envelopeId));
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
