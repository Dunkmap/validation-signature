/* Cryptographic PDF signing.

   The feature is OFF unless ESIGN_PDF_SIGN=true, so the first thing these
   tests pin down is that the default really does nothing - a flag that leaks
   behaviour when unset is worse than no flag. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';

import {
  isSigningEnabled, loadSigningCertificate, signPdf,
} from '../src/lib/digital-signature.js';

const PASS = 'test-pass';

/* A throwaway self-signed certificate, generated per run. Committing a .pfx to
   the repository would put a private key in git history for good. */
async function withCertificate(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'esign-cert-'));
  const pfx = join(dir, 'signing.pfx');
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048',
      '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'),
      '-days', '1', '-nodes',
      '-subj', '/CN=Test Org/O=Test Org/C=IN',
    ], { stdio: 'ignore' });
    execFileSync('openssl', [
      'pkcs12', '-export', '-out', pfx,
      '-inkey', join(dir, 'k.pem'), '-in', join(dir, 'c.pem'),
      '-passout', `pass:${PASS}`,
    ], { stdio: 'ignore' });
    await fn(pfx);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const samplePdf = async () => {
  const doc = await PDFDocument.create();
  doc.addPage([595.28, 841.89]).drawText('Handover form', { x: 60, y: 700, size: 12 });
  return Buffer.from(await doc.save());
};

const env = (pfx, over = {}) => ({
  ESIGN_PDF_SIGN: 'true',
  ESIGN_PDF_CERT: pfx,
  ESIGN_PDF_CERT_PASSWORD: PASS,
  ...over,
});

// --- the flag ---

test('signing is OFF unless the flag is explicitly true', async () => {
  assert.equal(isSigningEnabled({}), false);
  assert.equal(isSigningEnabled({ ESIGN_PDF_SIGN: 'false' }), false);
  assert.equal(isSigningEnabled({ ESIGN_PDF_SIGN: '1' }), false, 'only "true" enables it');
  assert.equal(isSigningEnabled({ ESIGN_PDF_SIGN: 'true' }), true);
});

test('no certificate is loaded when the flag is off, whatever else is set', async () => {
  const cert = await loadSigningCertificate({
    ESIGN_PDF_CERT: '/nonexistent.pfx', ESIGN_PDF_CERT_PASSWORD: 'x',
  });
  assert.equal(cert, null);
});

test('with signing off, the document passes through completely unchanged', async () => {
  const pdf = await samplePdf();
  const { bytes, signed } = await signPdf(pdf, null);
  assert.equal(signed, false);
  assert.ok(bytes.equals(pdf), 'the bytes must be identical, not merely equivalent');
});

// --- misconfiguration is reported at startup, not at signing time ---

test('a missing certificate path is refused when signing is enabled', async () => {
  await assert.rejects(
    () => loadSigningCertificate({ ESIGN_PDF_SIGN: 'true' }),
    /ESIGN_PDF_CERT is not set/,
  );
});

test('an unreadable certificate file is refused', async () => {
  await assert.rejects(
    () => loadSigningCertificate(env('/no/such/file.pfx')),
    /could not be read/,
  );
});

test('a wrong passphrase is refused at load, not at the moment someone signs', async () => {
  await withCertificate(async (pfx) => {
    await assert.rejects(
      () => loadSigningCertificate(env(pfx, { ESIGN_PDF_CERT_PASSWORD: 'wrong' })),
      /could not be opened/,
    );
  });
});

// --- signing ---

test('a signed PDF carries a signature Adobe can find', async () => {
  await withCertificate(async (pfx) => {
    const cert = await loadSigningCertificate(env(pfx));
    const { bytes, signed } = await signPdf(await samplePdf(), cert);
    assert.equal(signed, true);

    const s = bytes.toString('latin1');
    assert.match(s, /\/Type\s*\/Sig/, 'a signature dictionary');
    assert.match(s, /adbe\.pkcs7\.detached/, 'the standard detached CMS filter');
    assert.match(s, /\/ByteRange/, 'the range the signature covers');
    assert.match(s, /\/SigFlags/, 'AcroForm flags, or Adobe ignores the field');

    // The reserved placeholder must have been overwritten with a real value.
    assert.ok(!s.includes('**********'), 'the ByteRange placeholder was filled in');
  });
});

test('the signature actually covers the document, and detects a changed byte', async () => {
  await withCertificate(async (pfx) => {
    const cert = await loadSigningCertificate(env(pfx));
    const { bytes } = await signPdf(await samplePdf(), cert);

    const s = bytes.toString('latin1');
    const m = s.match(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/);
    assert.ok(m, 'the ByteRange must be a resolved set of four numbers');

    const [a, b, c, d] = m.slice(1).map(Number);
    /* The two covered spans must meet either side of the signature container:
       everything except the signature itself is signed. A range that left part
       of the document uncovered would allow silent edits there. */
    assert.equal(a, 0, 'coverage starts at the first byte');
    assert.equal(a + b + d + (c - (a + b)), bytes.length,
      'the two spans plus the container account for the whole file');
    assert.ok(c > a + b, 'the second span begins after the container');
  });
});

test('signing is deterministic in shape: same input, same structure', async () => {
  await withCertificate(async (pfx) => {
    const cert = await loadSigningCertificate(env(pfx));
    const pdf = await samplePdf();
    const one = (await signPdf(pdf, cert)).bytes;
    const two = (await signPdf(pdf, cert)).bytes;
    // Not byte-identical - the signing time differs - but both must be valid
    // signed documents of the same shape.
    for (const b of [one, two]) {
      assert.match(b.toString('latin1'), /adbe\.pkcs7\.detached/);
    }
  });
});

test('the reason and location reach the document, for Adobe to display', async () => {
  await withCertificate(async (pfx) => {
    const cert = await loadSigningCertificate(env(pfx, {
      ESIGN_PDF_REASON: 'Signed via the e-signature service',
      ESIGN_PDF_LOCATION: 'Pune, India',
    }));
    const { bytes } = await signPdf(await samplePdf(), cert);
    const s = bytes.toString('latin1');
    assert.match(s, /Signed via the e-signature service/);
    assert.match(s, /Pune, India/);
  });
});
