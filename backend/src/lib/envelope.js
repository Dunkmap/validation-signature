/* Envelope rules: whose turn it is, and what the finished file is called.

   Pure functions over plain objects - no AWS, no I/O - so the behaviour that
   matters can be tested directly. */

export const SIGNER_STATUS = { PENDING: 'Pending', SIGNED: 'Signed' };

/* Signers sorted by their signing order. Never trust array position: the
   envelope's `order` field is what decides. */
export function orderedSigners(envelope) {
  return [...envelope.signers].sort((a, b) => a.order - b.order);
}

export function findSigner(envelope, signerId) {
  return envelope.signers.find((s) => s.signerId === signerId) || null;
}

/* The first signer who has not yet signed. */
export function currentSigner(envelope) {
  return orderedSigners(envelope).find((s) => s.status !== SIGNER_STATUS.SIGNED) || null;
}

export function isComplete(envelope) {
  return envelope.signers.every((s) => s.status === SIGNER_STATUS.SIGNED);
}

export function waitingOn(envelope) {
  return orderedSigners(envelope)
    .filter((s) => s.status !== SIGNER_STATUS.SIGNED)
    .map((s) => s.name);
}

export function signedCount(envelope) {
  return envelope.signers.filter((s) => s.status === SIGNER_STATUS.SIGNED).length;
}

/* Everyone who signed before this signer, in order - what the certificate page
   prints as the chain, and what the signing page shows in its timeline. */
export function timelineBefore(envelope, signer) {
  return orderedSigners(envelope)
    .filter((s) => s.status === SIGNER_STATUS.SIGNED && s.order < signer.order)
    .map((s) => ({
      name: s.name,
      role: s.role || '',
      signedAt: s.signedAt,
      hash: s.documentHash,
      ip: s.ip,
      timezone: s.timezone,
      locationStatus: s.locationStatus,
      latitude: s.latitude,
      longitude: s.longitude,
    }));
}

/* Why a signer may not sign right now, or null if they may.

   Every refusal returns the same sentence, so a stranger probing tokens learns
   nothing about which exist - with ONE deliberate exception: NOT_YOUR_TURN
   names the person being waited on. Whoever holds that token was already told
   they are a signer on this document, so it reveals nothing they did not have,
   and refusing them with "not valid" would send them chasing a replacement
   link that behaves identically. */
export function turnRefusal(envelope, signer) {
  if (signer.status === SIGNER_STATUS.SIGNED) {
    return { reason: 'REFUSED' };
  }
  const current = currentSigner(envelope);
  if (current && current.signerId !== signer.signerId) {
    return { reason: 'NOT_YOUR_TURN', waitingOn: current.name };
  }
  return null;
}

/* Filename: status first, then the request number, then the document. In a
   mixed folder every signed file groups together; within that group they sort
   by request number, which is the handle that finds the record in Salesforce.

   Fixed when the FIRST signature completes; later signers inherit it unchanged. */
const MAX_FILENAME = 255;

export function buildSignedFileName({ requestNumber, originalName }) {
  const original = (originalName || 'Document.pdf').trim();

  // Do not double-prefix a name this process already produced.
  const already = /^Signed - (?:.+? - )?/.test(original);
  if (already) return clipToLimit(original);

  // Omit either prefix rather than writing "null - ".
  const parts = ['Signed'];
  if (requestNumber) parts.push(String(requestNumber).trim());

  const prefix = parts.join(' - ') + ' - ';
  return clipToLimit(prefix + original, prefix);
}

/* Cap at 255 characters, clipping the DOCUMENT NAME rather than the prefix -
   the prefix is what makes the file findable. */
function clipToLimit(name, prefix = '') {
  if (name.length <= MAX_FILENAME) return name;

  const body = prefix ? name.slice(prefix.length) : name;
  const dot = body.lastIndexOf('.');
  const ext = dot > 0 ? body.slice(dot) : '';
  const stem = dot > 0 ? body.slice(0, dot) : body;

  const room = MAX_FILENAME - prefix.length - ext.length;
  if (room <= 0) return name.slice(0, MAX_FILENAME);
  return prefix + stem.slice(0, room) + ext;
}

/* The S3 key for a given signature version. Each version is kept: the download
   serves the stored bytes, never a re-render, because pdf-lib stamps a fresh
   creation date and new object ids on every save. */
export function documentKey(envelopeId, version) {
  return `envelopes/${envelopeId}/v${version}.pdf`;
}

export function originalKey(envelopeId) {
  return documentKey(envelopeId, 0);
}

/* The version a given signer should be served: everything signed so far. */
export function currentVersion(envelope) {
  return signedCount(envelope);
}
