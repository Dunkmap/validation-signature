/* Input validation. Everything here fails closed: an unparseable value is
   treated as invalid, never waved through. */

export const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024; // ~4 MB, per the spec

/* Salesforce rejects anything outside this set on write-back and fails the
   WHOLE record - after the signature has already been taken. Catching it here
   is the difference between a rejected request and a lost signature. */
export const LOCATION_STATUSES = ['Granted', 'Denied', 'Unavailable', 'Not requested'];

export function isValidLocationStatus(v) {
  return LOCATION_STATUSES.includes(v);
}

/* Validate that an upload is genuinely a PDF by its magic bytes, not by
   extension or content-type - both of which the client chooses. */
export function looksLikePdf(bytes) {
  if (!bytes || bytes.length < 5) return false;
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44
      && bytes[3] === 0x46 && bytes[4] === 0x2d; // %PDF-
}

/* Fail closed: a missing or unparseable expiry means EXPIRED, not valid
   forever. */
export function isExpired(expiresAt, now = new Date()) {
  if (!expiresAt) return true;
  const t = new Date(expiresAt);
  if (Number.isNaN(t.getTime())) return true;
  return t.getTime() <= now.getTime();
}

export function decodeBase64(b64) {
  if (typeof b64 !== 'string' || b64.length === 0) return null;
  const clean = b64.replace(/^data:[^,]+,/, '');
  // Buffer.from is permissive and silently drops invalid characters, so
  // round-trip to confirm we decoded what was actually sent.
  const buf = Buffer.from(clean, 'base64');
  if (buf.length === 0) return null;
  return buf;
}

export function validateBox(box) {
  if (!box || typeof box !== 'object') return 'box is required';
  const { page, x, y, w, h } = box;
  if (!Number.isInteger(page) || page < 1) return 'box.page must be a positive integer';
  for (const [k, v] of Object.entries({ x, y, w, h })) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return `box.${k} must be a finite number`;
  }
  if (w <= 0 || h <= 0) return 'box.w and box.h must be positive';
  return null;
}

export function validateEnvelope(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return ['body must be a JSON object'];

  if (!body.externalId || typeof body.externalId !== 'string') {
    errors.push('externalId is required');
  }
  if (!body.fileName || typeof body.fileName !== 'string') {
    errors.push('fileName is required');
  }

  const doc = decodeBase64(body.documentBase64);
  if (!doc) {
    errors.push('documentBase64 is required and must be valid base64');
  } else {
    if (!looksLikePdf(doc)) errors.push('documentBase64 is not a PDF (bad magic bytes)');
    if (doc.length > MAX_DOCUMENT_BYTES) {
      errors.push(`document is ${(doc.length / 1048576).toFixed(1)} MB; the limit is 4 MB`);
    }
  }

  if (!Array.isArray(body.signers) || body.signers.length === 0) {
    errors.push('signers must be a non-empty array');
    return errors;
  }

  const orders = new Set();
  body.signers.forEach((s, i) => {
    const at = `signers[${i}]`;
    if (!s || typeof s !== 'object') { errors.push(`${at} must be an object`); return; }
    if (!Number.isInteger(s.order) || s.order < 1) errors.push(`${at}.order must be a positive integer`);
    else if (orders.has(s.order)) errors.push(`${at}.order ${s.order} is duplicated`);
    else orders.add(s.order);
    if (!s.name || typeof s.name !== 'string') errors.push(`${at}.name is required`);
    if (!s.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.email)) errors.push(`${at}.email is invalid`);
    const boxErr = validateBox(s.box);
    if (boxErr) errors.push(`${at}.${boxErr}`);
  });

  return errors;
}

export function validateSignSubmission(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return ['body must be a JSON object'];

  const doc = decodeBase64(body.signedDocumentBase64);
  if (!doc) {
    errors.push('signedDocumentBase64 is required and must be valid base64');
  } else {
    if (!looksLikePdf(doc)) errors.push('signedDocumentBase64 is not a PDF (bad magic bytes)');
    if (doc.length > MAX_DOCUMENT_BYTES) errors.push('signed document exceeds the 4 MB limit');
  }

  if (!body.consentStatement || typeof body.consentStatement !== 'string') {
    errors.push('consentStatement is required');
  }

  const ctx = body.clientContext;
  if (!ctx || typeof ctx !== 'object') {
    errors.push('clientContext is required');
  } else if (!isValidLocationStatus(ctx.locationStatus)) {
    errors.push(`clientContext.locationStatus must be one of: ${LOCATION_STATUSES.join(', ')}`);
  }

  return errors;
}
