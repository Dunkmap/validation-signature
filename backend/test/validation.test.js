import test from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikePdf, isExpired, isValidLocationStatus, LOCATION_STATUSES,
  validateEnvelope, validateSignSubmission, decodeBase64, MAX_DOCUMENT_BYTES,
} from '../src/lib/validation.js';
import { newToken, isWellFormedToken, tokensEqual, tokenLookupKey, sha256Hex }
  from '../src/lib/tokens.js';

// --- PDF magic bytes ---

test('a PDF is recognised by its magic bytes, not its extension', () => {
  assert.equal(looksLikePdf(Buffer.from('%PDF-1.4\n...')), true);
  assert.equal(looksLikePdf(Buffer.from('<html>evil</html>')), false);
  assert.equal(looksLikePdf(Buffer.from('PK\x03\x04')), false, 'a zip is not a PDF');
  assert.equal(looksLikePdf(Buffer.alloc(0)), false);
  assert.equal(looksLikePdf(null), false);
});

// --- expiry fails closed ---

test('expiry fails closed: missing or unparseable means EXPIRED', () => {
  assert.equal(isExpired(null), true, 'missing expiry must not mean valid forever');
  assert.equal(isExpired(undefined), true);
  assert.equal(isExpired(''), true);
  assert.equal(isExpired('not a date'), true);
  assert.equal(isExpired('2020-01-01T00:00:00Z'), true);
});

test('a future expiry is valid', () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  assert.equal(isExpired(future), false);
});

test('an expiry exactly now counts as expired', () => {
  const now = new Date('2026-09-03T12:00:00Z');
  assert.equal(isExpired('2026-09-03T12:00:00Z', now), true);
});

// --- restricted values ---

test('locationStatus accepts exactly the four Salesforce values', () => {
  assert.deepEqual(LOCATION_STATUSES, ['Granted', 'Denied', 'Unavailable', 'Not requested']);
  for (const v of LOCATION_STATUSES) assert.equal(isValidLocationStatus(v), true);
});

test('locationStatus rejects near-misses that would fail the whole Salesforce record', () => {
  for (const bad of ['granted', 'GRANTED', 'Not Requested', 'Unknown', '', null, undefined]) {
    assert.equal(isValidLocationStatus(bad), false, `${bad} must be rejected`);
  }
});

// --- tokens ---

test('tokens are 64 hex characters from a CSPRNG', () => {
  const t = newToken();
  assert.match(t, /^[0-9a-f]{64}$/);
  assert.equal(isWellFormedToken(t), true);
});

test('tokens do not repeat', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(newToken());
  assert.equal(seen.size, 500);
});

test('malformed tokens are rejected before any lookup', () => {
  for (const bad of ['', 'abc', '1'.repeat(63), '1'.repeat(65), 'g'.repeat(64), 12345, null]) {
    assert.equal(isWellFormedToken(bad), false);
  }
});

test('token comparison is constant-time and rejects malformed input', () => {
  const t = newToken();
  assert.equal(tokensEqual(t, t), true);
  assert.equal(tokensEqual(t, newToken()), false);
  assert.equal(tokensEqual(t, 'nope'), false);
});

test('the stored lookup key is a hash, never the token itself', () => {
  const t = newToken();
  const key = tokenLookupKey(t);
  assert.notEqual(key, t, 'a leaked table must not hand over working links');
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(tokenLookupKey(t), key, 'and it must be stable');
});

// --- envelope validation ---

const pdfB64 = Buffer.from('%PDF-1.4\nbody').toString('base64');

const goodEnvelope = () => ({
  externalId: 'a03bm00001np9fh',
  fileName: 'Form.pdf',
  documentBase64: pdfB64,
  signers: [
    { order: 1, name: 'Priya', email: 'priya@example.com', role: 'Admin',
      box: { page: 1, x: 62.2, y: 193.09, w: 160, h: 44 } },
  ],
});

test('a well-formed envelope validates', () => {
  assert.deepEqual(validateEnvelope(goodEnvelope()), []);
});

test('a non-PDF upload is rejected', () => {
  const e = { ...goodEnvelope(), documentBase64: Buffer.from('<html>').toString('base64') };
  assert.match(validateEnvelope(e).join(), /not a PDF/);
});

test('an oversize document is rejected with a clear message', () => {
  const big = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(MAX_DOCUMENT_BYTES)]);
  const e = { ...goodEnvelope(), documentBase64: big.toString('base64') };
  assert.match(validateEnvelope(e).join(), /limit is 4 MB/);
});

test('duplicate signing orders are rejected', () => {
  const e = goodEnvelope();
  e.signers.push({ ...e.signers[0], order: 1, email: 'b@example.com' });
  assert.match(validateEnvelope(e).join(), /duplicated/);
});

test('a missing or malformed box is rejected', () => {
  const e = goodEnvelope();
  delete e.signers[0].box;
  assert.match(validateEnvelope(e).join(), /box is required/);

  const e2 = goodEnvelope();
  e2.signers[0].box.w = 0;
  assert.match(validateEnvelope(e2).join(), /must be positive/);
});

test('an envelope with no signers is rejected', () => {
  assert.match(validateEnvelope({ ...goodEnvelope(), signers: [] }).join(), /non-empty/);
});

// --- submission validation ---

test('a submission with an invented locationStatus is rejected BEFORE storage', () => {
  const errors = validateSignSubmission({
    signedDocumentBase64: pdfB64,
    consentStatement: 'I agree',
    clientContext: { locationStatus: 'Maybe' },
  });
  // Catching it here is the difference between a rejected request and a
  // signature lost to a failed Salesforce write-back.
  assert.match(errors.join(), /locationStatus must be one of/);
});

test('a valid submission passes', () => {
  assert.deepEqual(validateSignSubmission({
    signedDocumentBase64: pdfB64,
    consentStatement: 'I agree',
    clientContext: { locationStatus: 'Denied' },
  }), []);
});

test('base64 that is not really base64 decodes to null rather than garbage', () => {
  assert.equal(decodeBase64(''), null);
  assert.equal(decodeBase64(null), null);
});

// --- hashing ---

test('the hash is SHA-256 of the exact bytes', () => {
  // Known vector: sha256("abc")
  assert.equal(sha256Hex(Buffer.from('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('one different byte gives a different hash', () => {
  assert.notEqual(sha256Hex(Buffer.from('%PDF-a')), sha256Hex(Buffer.from('%PDF-b')));
});
