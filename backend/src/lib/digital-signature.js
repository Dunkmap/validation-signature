/* Cryptographic signing of the finished PDF.

   OFF BY DEFAULT. Set ESIGN_PDF_SIGN=true to enable; unset it to revert.
   See docs/DIGITAL-SIGNATURE.md for the whole change and how to undo it.

   What this adds, and what it does NOT:

     - Adobe shows a Signature Panel entry and reports "the document has not
       been modified since this signature was applied". Tampering is detected.

     - With a SELF-SIGNED certificate Adobe also says "the signer's identity is
       unknown" and shows a yellow warning triangle. That is not a fault in
       this code: Adobe trusts an identity only when the issuing authority is
       in its Approved Trust List, and a certificate we generated ourselves
       never will be. Buying a certificate from a listed CA turns the same
       code green - only the .pfx file changes.

   This runs LAST, after every signature has been merged. A PDF signature
   covers the exact bytes it was applied to, so signing earlier and then
   merging another signature in would invalidate the earlier one - Adobe would
   report the document as modified, which is worse than not signing at all. */

import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName, PDFNumber, PDFString, PDFHexString, PDFArray } from 'pdf-lib';

// Room reserved in the PDF for the signature container, in bytes. The CMS blob
// is ~3-5 KB for a 2048-bit key; 16 KB leaves room for a timestamp later.
const SIGNATURE_LENGTH = 16384;
const BYTE_RANGE_PLACEHOLDER = '**********';

export function isSigningEnabled(env = process.env) {
  return env.ESIGN_PDF_SIGN === 'true';
}

/* Read the certificate once, at startup, so a missing or unreadable file is
   reported then rather than at the moment a signer finishes. */
export async function loadSigningCertificate(env = process.env) {
  if (!isSigningEnabled(env)) return null;

  const path = env.ESIGN_PDF_CERT;
  if (!path) {
    throw new Error(
      'ESIGN_PDF_SIGN=true but ESIGN_PDF_CERT is not set. Point it at a .pfx/.p12 '
      + 'file, or set ESIGN_PDF_SIGN=false to turn signing off.',
    );
  }

  let p12;
  try {
    p12 = await readFile(path);
  } catch (e) {
    throw new Error(`The signing certificate at ${path} could not be read: ${e.message}`);
  }

  const passphrase = env.ESIGN_PDF_CERT_PASSWORD || '';

  /* Prove the certificate and passphrase actually work NOW.

     Constructing the signer does not open the container - it defers until it
     signs - so a wrong passphrase would otherwise surface at the moment a
     signer finishes, when their signature is already stored and they are
     waiting for a document. Parse it here instead, so the failure is a line in
     this console at startup. */
  const forge = (await import('node-forge')).default;
  try {
    const asn1 = forge.asn1.fromDer(p12.toString('binary'));
    const bag = forge.pkcs12.pkcs12FromAsn1(asn1, passphrase);
    const keys = bag.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
    const certs = bag.getBags({ bagType: forge.pki.oids.certBag });
    if (!keys[forge.pki.oids.pkcs8ShroudedKeyBag]?.length
        && !bag.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag]?.length) {
      throw new Error('it contains no private key');
    }
    if (!certs[forge.pki.oids.certBag]?.length) {
      throw new Error('it contains no certificate');
    }
  } catch (e) {
    throw new Error(
      `The signing certificate at ${path} could not be opened: ${e.message}. `
      + 'Check ESIGN_PDF_CERT_PASSWORD.',
    );
  }

  return {
    p12,
    passphrase,
    path,
    reason: env.ESIGN_PDF_REASON || 'Electronically signed via the e-signature service',
    location: env.ESIGN_PDF_LOCATION || 'India',
    contact: env.ESIGN_MAIL_FROM || '',
  };
}

/* Add the signature dictionary and the empty container the signature is later
   written into.

   @signpdf ships a placeholder helper, but it depends on pdfkit, which pulls a
   crypto-js version with known critical advisories. The document is already
   built with pdf-lib here, so the placeholder is written with pdf-lib too and
   that dependency is avoided entirely. */
async function addPlaceholder(pdfBytes, { reason, location, contact, name, signedAt }) {
  const pdf = await PDFDocument.load(pdfBytes);

  const ByteRange = PDFArray.withContext(pdf.context);
  ByteRange.push(PDFNumber.of(0));
  ByteRange.push(PDFName.of(BYTE_RANGE_PLACEHOLDER));
  ByteRange.push(PDFName.of(BYTE_RANGE_PLACEHOLDER));
  ByteRange.push(PDFName.of(BYTE_RANGE_PLACEHOLDER));

  const signatureDict = pdf.context.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'adbe.pkcs7.detached',
    ByteRange,
    // Reserved space, overwritten with the real signature after hashing.
    Contents: PDFHexString.of('A'.repeat(SIGNATURE_LENGTH)),
    Reason: PDFString.of(reason),
    Location: PDFString.of(location),
    ...(contact ? { ContactInfo: PDFString.of(contact) } : {}),
    ...(name ? { Name: PDFString.of(name) } : {}),
    M: PDFString.fromDate(signedAt instanceof Date ? signedAt : new Date(signedAt)),
  });
  const signatureRef = pdf.context.register(signatureDict);

  /* An invisible signature field: the visible signature images and the
     certificate page already say who signed and when, in language a person can
     read. A second, redundant graphic drawn by Adobe on top of the document
     would only obscure it. */
  const widgetDict = pdf.context.obj({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Sig',
    Rect: [0, 0, 0, 0],
    V: signatureRef,
    T: PDFString.of('Signature1'),
    F: 132,               // Print + Locked
    P: pdf.getPage(0).ref,
  });
  const widgetRef = pdf.context.register(widgetDict);

  const page = pdf.getPage(0);
  page.node.set(PDFName.of('Annots'), pdf.context.obj([widgetRef]));

  /* AcroForm with SigFlags 3: the document contains a signature, and Adobe
     must not save it in a way that would invalidate one. */
  const fields = PDFArray.withContext(pdf.context);
  fields.push(widgetRef);
  pdf.catalog.set(PDFName.of('AcroForm'), pdf.context.obj({
    SigFlags: 3,
    Fields: fields,
  }));

  // useObjectStreams:false keeps the byte offsets predictable for the range.
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

/* Sign the finished PDF. Returns the signed bytes.

   Never throws into the caller's happy path: signing is an enhancement on top
   of a signature that is already stored and hashed, so a failure here must
   leave the document usable rather than losing it. The caller reports the
   error instead. */
export async function signPdf(pdfBytes, certificate, { name, signedAt = new Date() } = {}) {
  if (!certificate) return { bytes: pdfBytes, signed: false };

  const { SignPdf } = await import('@signpdf/signpdf');
  const { P12Signer } = await import('@signpdf/signer-p12');

  const withPlaceholder = await addPlaceholder(pdfBytes, {
    reason: certificate.reason,
    location: certificate.location,
    contact: certificate.contact,
    name,
    signedAt,
  });

  const signer = new P12Signer(certificate.p12, { passphrase: certificate.passphrase });
  const signed = await new SignPdf().sign(withPlaceholder, signer);

  return { bytes: Buffer.from(signed), signed: true };
}
