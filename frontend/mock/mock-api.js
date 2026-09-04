/* A stand-in for the AWS API, so the page can be exercised end to end in a
   browser with no backend. Active only with ?mock=1 in the URL.

   Scenarios, chosen with &scenario= :
     turn      (default) it is your turn, one earlier signature on the document
     first     you are signer 1 of 3, nothing signed yet
     notyour   NOT_YOUR_TURN, waiting on a named person
     refused   the generic refusal
     last      you are the final signer; submitting completes the envelope
     verify    the email OTP gate, as a forwarded link would hit it

   The mock hashes the received bytes itself. The real server does this too -
   never trust a hash the client sends. Here it is only so the Done screen has
   a truthful value to show. */

const params = new URLSearchParams(location.search);
const scenario = params.get('scenario') || 'turn';

/* Placeholders, not people. The mock has to render *something* in the signer
   fields; these are deliberately generic so no real name is baked into the
   product. Real envelopes carry whatever the sender supplied. */
const SIGNERS = [
  { name: 'First Signer',  role: 'Approver', email: 'signer1@example.com' },
  { name: 'Second Signer', role: 'Reviewer', email: 'signer2@example.com' },
  { name: 'Third Signer',  role: 'Approver', email: 'signer3@example.com' },
];

const PRIOR = {
  name: 'First Signer', role: 'Approver',
  signedAt: '2026-09-03T07:11:15Z',
  hash: '2f2422f65899a1c4d0e7b3f8a9016c5d2e4471bb8c3a5f9d0e2b7c41a68d3f05',
  ip: '203.0.113.44',
  timezone: 'Asia/Kolkata',
  locationStatus: 'Granted',
  latitude: 18.5204, longitude: 73.8567,
};

// Box in PDF points, origin bottom-left - exactly as Salesforce sends it.
const BOX = { page: 1, x: 62.2, y: 193.09, w: 160, h: 44 };

let submitted = false;

/* The OTP gate, mocked.

   In the `verify` scenario the document stays shut until a code is entered,
   exactly as the real server behaves. The accepted code is fixed and printed
   to the console: this is a mock with no mailbox behind it, so there is
   nothing to receive a real one. */
const MOCK_CODE = '123456';
let mockVerified = false;

export async function mockRequestCode() {
  await delay(400);
  console.log(`[mock] the verification code is ${MOCK_CODE}`);
  return {
    ok: true,
    sentTo: 's***@example.com',
    expiresInSeconds: 600,
    warning: 'This is the mock API - no email was sent. The code is '
           + `${MOCK_CODE}, also printed to the browser console.`,
  };
}

export async function mockVerifyCode(token, code) {
  await delay(500);

  if (code !== MOCK_CODE) {
    return {
      ok: false, reason: 'CODE_INCORRECT', attemptsRemaining: 4,
      error: 'That code is not correct. 4 attempts remaining before you need a new code.',
    };
  }

  mockVerified = true;
  return { ok: true, sessionSecret: 'f'.repeat(64), expiresInSeconds: 1800 };
}

export async function mockLoad() {
  await delay(400);

  /* A forwarded link gets the masked address and nothing else - no document,
     no signer name, no sender message. */
  if (scenario === 'verify' && !mockVerified) {
    return {
      ok: false, reason: 'VERIFICATION_REQUIRED',
      sentTo: 's***@example.com',
      error: 'Before this document can be opened, we need to confirm you are the '
           + 'person it was sent to. We will email a verification code to the '
           + 'address on file.',
    };
  }

  if (scenario === 'notyour') {
    return {
      ok: false, reason: 'NOT_YOUR_TURN', waitingOn: 'First Signer',
      error: 'It is not your turn to sign yet. This document goes to its signers '
           + 'in order, and First Signer has not signed it yet. Your link stays '
           + 'valid - open it again later.',
    };
  }

  if (scenario === 'refused') {
    return {
      ok: false, reason: 'REFUSED',
      error: 'This signing link is not valid. It may have expired or already '
           + 'been used. Please ask the sender for a new one.',
    };
  }

  const isFirst = scenario === 'first';
  const isLast = scenario === 'last';
  const order = isFirst ? 1 : isLast ? 3 : 2;
  const me = SIGNERS[order - 1];

  return {
    ok: true,
    fileName: 'Sample_Document.pdf',
    signerName: me.name,
    signerRole: me.role,
    signOrder: order,
    signerCount: 3,
    message: 'Please sign before Friday.',
    box: BOX,
    documentBase64: await samplePdfBase64(),
    signerIp: '182.48.210.250',
    timeline: isFirst ? [] : [PRIOR],
  };
}

export async function mockSubmit(token, payload) {
  await delay(700);

  // Hash the bytes actually received - server-side, never the client's claim.
  const bytes = base64ToBytes(payload.signedDocumentBase64);
  const hash = await sha256Hex(bytes);

  // Prove the received document really is a PDF, by magic bytes.
  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  if (magic !== '%PDF') {
    return { ok: false, error: 'The uploaded file is not a valid PDF.' };
  }

  const valid = ['Granted', 'Denied', 'Unavailable', 'Not requested'];
  if (!valid.includes(payload.clientContext.locationStatus)) {
    // Salesforce would reject this on write-back and fail the whole record -
    // after the signature was already taken. Catch it here instead.
    return { ok: false, error: `Invalid locationStatus: ${payload.clientContext.locationStatus}` };
  }

  submitted = true;
  const complete = scenario === 'last';

  console.log('[mock] signature received', {
    bytes: bytes.length, hash,
    context: payload.clientContext,
    consent: payload.consentStatement,
  });

  return {
    ok: true,
    fileName: 'Signed - REQ-000031 - Sample_Document.pdf',
    documentHash: hash,
    complete,
    waitingOn: complete ? [] : ['Third Signer'],
  };
}

export async function mockStatus() {
  await delay(200);
  const complete = scenario === 'last' && submitted;
  return {
    ok: true,
    signedCount: complete ? 3 : 2,
    totalCount: 3,
    waitingOn: complete ? [] : ['Third Signer'],
    complete,
  };
}

/* Build a small two-page PDF with pdf-lib so there is something real to render
   and stamp, with a visible line where the signature box sits. */
async function samplePdfBase64() {
  const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const p1 = pdf.addPage([595.28, 841.89]);
  p1.drawText('Sample document', {
    x: 62, y: 760, size: 18, font: bold, color: rgb(0.07, 0.09, 0.15),
  });
  const body = [
    'A placeholder document, so the signing page has something real to render',
    'and stamp. A live envelope carries whatever PDF the sender uploaded.',
    '',
    'The ruled lines below sit under the signature boxes, which makes a',
    'mirrored coordinate flip immediately obvious.',
  ];
  body.forEach((line, i) => {
    p1.drawText(line, { x: 62, y: 710 - i * 20, size: 11, font, color: rgb(0.15, 0.17, 0.22) });
  });

  // A ruled line beneath the box, so a mirrored coordinate flip is obvious.
  p1.drawLine({
    start: { x: 62.2, y: 188 }, end: { x: 222.2, y: 188 },
    thickness: 0.8, color: rgb(0.6, 0.63, 0.68),
  });
  p1.drawText('First signer', { x: 62.2, y: 174, size: 8, font, color: rgb(0.42, 0.45, 0.5) });

  p1.drawLine({
    start: { x: 300, y: 188 }, end: { x: 460, y: 188 },
    thickness: 0.8, color: rgb(0.6, 0.63, 0.68),
  });
  p1.drawText('Second signer', { x: 300, y: 174, size: 8, font, color: rgb(0.42, 0.45, 0.5) });

  const p2 = pdf.addPage([595.28, 841.89]);
  p2.drawText('Terms', { x: 62, y: 760, size: 15, font: bold });
  p2.drawText('The employee agrees to return all listed assets on or before their', {
    x: 62, y: 720, size: 11, font,
  });
  p2.drawText('final working day.', { x: 62, y: 702, size: 11, font });

  return pdf.saveAsBase64();
}

// --- helpers ---

async function sha256Hex(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function base64ToBytes(b64) {
  const bin = atob(String(b64).replace(/^data:[^,]+,/, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
