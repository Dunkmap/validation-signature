/* Envelope rules: who has signed, and what the finished file is called.

   Signing is UNORDERED. Every signer may sign whenever they like, including
   at the same moment as someone else. Nobody waits on anybody.

   Because of that, each signature is stamped onto its OWN copy of the original
   document rather than onto whatever the previous signer produced - two people
   signing at once would otherwise overwrite each other, and one signature
   would silently vanish. The finished document is assembled by merging every
   signature back onto the original. See mergeSignatures in lib/merge.js.

   Pure functions over plain objects - no AWS, no I/O - so the behaviour that
   matters can be tested directly. */

export const SIGNER_STATUS = { PENDING: 'Pending', SIGNED: 'Signed' };

/* Signers sorted by `order`. Order no longer gates anything - it is kept
   because it decides where each signature is DISPLAYED (the certificate, the
   completion email), and a stable, predictable sequence there is worth having. */
export function orderedSigners(envelope) {
  return [...envelope.signers].sort((a, b) => a.order - b.order);
}

/* Signers in the sequence they actually SIGNED, earliest first.

   Distinct from orderedSigners, and the distinction matters: `order` is where
   a signature sits on the page, chosen by the sender before anybody signed.
   This is the record of what happened - who signed first, who second - which
   is what the certificate and the Salesforce audit trail present.

   Signing is unordered, so two people signing in the same second is a real
   case rather than a theoretical one. `order` breaks the tie, so the sequence
   is deterministic: rebuilding the same document twice can never produce two
   different numberings of the same signatures. */
export function compareBySignedAt(a, b) {
  const ta = Date.parse(a?.signedAt ?? '');
  const tb = Date.parse(b?.signedAt ?? '');
  /* A signature with no usable timestamp cannot be placed in the sequence.
     It goes last rather than wherever NaN would put it - an unsortable value
     silently reordering everyone else is the kind of bug that only shows up
     on a finished contract. */
  if (Number.isNaN(ta) && Number.isNaN(tb)) return (a?.order ?? 0) - (b?.order ?? 0);
  if (Number.isNaN(ta)) return 1;
  if (Number.isNaN(tb)) return -1;
  if (ta !== tb) return ta - tb;
  return (a?.order ?? 0) - (b?.order ?? 0);
}

/* Everyone who has signed, in signing sequence. Signers still outstanding are
   absent: they have no position in a record of what has happened. */
export function signersBySigningTime(envelope) {
  return envelope.signers
    .filter((s) => s.status === SIGNER_STATUS.SIGNED)
    .sort(compareBySignedAt);
}
export function findSigner(envelope, signerId) {
  return envelope.signers.find((s) => s.signerId === signerId) || null;
}

/* The first signer who has not yet signed. Nothing depends on this for
   permission any more; it is here for display and for the completion email. */
export function currentSigner(envelope) {
  return orderedSigners(envelope).find((s) => s.status !== SIGNER_STATUS.SIGNED) || null;
}

export function isComplete(envelope) {
  return envelope.signers.every((s) => s.status === SIGNER_STATUS.SIGNED);
}

/* Who has not signed yet. Not a queue - just everyone still outstanding. */
export function waitingOn(envelope) {
  return orderedSigners(envelope)
    .filter((s) => s.status !== SIGNER_STATUS.SIGNED)
    .map((s) => s.name);
}

export function signedCount(envelope) {
  return envelope.signers.filter((s) => s.status === SIGNER_STATUS.SIGNED).length;
}

/* Everyone who has ALREADY signed, whoever they are.

   Previously this was "everyone before you in the order". With unordered
   signing there is no before: what a signer should see is simply who has
   signed so far, which may be nobody even if they are last in the list. The
   signer themselves is excluded - their own signature is not yet taken. */
export function signedSoFar(envelope, signer = null) {
  /* SIGNING ORDER, the same sequence the certificate page and the Salesforce
     audit rows use. This is a record of what has happened, and the three
     places that present it must not disagree about who signed first. */
  return signersBySigningTime(envelope)
    .filter((s) => !signer || s.signerId !== signer.signerId)
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

/* Kept under the old name so nothing that still imports it breaks; it now
   means "who has signed so far", not "who came before you". */
export const timelineBefore = signedSoFar;

/* Why a signer may not sign right now, or null if they may.

   With ordering removed there is exactly one reason left: they have already
   signed. A token is good for ONE signature, whenever its holder chooses to
   use it - never twice.

   The refusal is the same sentence used for an unknown or expired token, so a
   stranger probing tokens still learns nothing about which exist. */
export function turnRefusal(envelope, signer) {
  if (signer.status === SIGNER_STATUS.SIGNED) {
    return { reason: 'REFUSED' };
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

/* The S3 key for a given stored artefact. Every version is kept: the download
   serves stored bytes, never a re-render, because pdf-lib stamps a fresh
   creation date and new object ids on every save. */
export function documentKey(envelopeId, version) {
  return `envelopes/${envelopeId}/v${version}.pdf`;
}

export function originalKey(envelopeId) {
  return documentKey(envelopeId, 0);
}

/* Where one signer's own stamped copy lives. Unordered signing means these
   are produced independently and in any order, so they are keyed by SIGNER,
   never by a running version number two people could claim at once. */
export function signerDocumentKey(envelopeId, signerId) {
  return `envelopes/${envelopeId}/by-signer/${signerId}.pdf`;
}

/* The merged document carrying every signature taken so far. Rewritten after
   each signature, so it is always current. */
export function mergedKey(envelopeId) {
  return `envelopes/${envelopeId}/merged.pdf`;
}

/* Retained for the Salesforce write-back, which still asks for "the current
   version". Every signer signs the ORIGINAL now, so what a signer is served is
   always version 0 - the merge happens afterwards, server-side. */
export function currentVersion(envelope) {
  return signedCount(envelope);
}
