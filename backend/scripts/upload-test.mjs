/* Proves the round-trip an org performs: push a PDF with predefined signature
   boxes, then confirm each signer is served THAT PDF with THEIR box.

     node scripts/upload-test.mjs

   The document is deliberately distinctive and the boxes sit in an unusual
   place, so a wrong document or a mangled coordinate is obvious rather than
   plausible. */

const BASE = process.env.ESIGN_BASE_URL || 'http://127.0.0.1:3000';
const SECRET = process.env.ESIGN_SECRET || 'local-dev-secret';

function pdf(marker) {
  const content = `BT /F1 20 Tf 60 780 Td (${marker}) Tj ET
BT /F1 10 Tf 60 745 Td (Uploaded from the org with signature areas already placed.) Tj ET
0.55 G 90 470 m 250 470 l S
BT /F1 8 Tf 90 456 Td (Head of Department) Tj ET
0.55 G 330 300 m 490 300 l S
BT /F1 8 Tf 330 286 Td (Finance) Tj ET`;

  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] '
      + '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let out = '%PDF-1.4\n';
  const offs = [0];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) out += `${String(offs[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

const MARKER = `Purchase Order 88231 - ${new Date().toISOString().slice(0, 19)}`;
const document = pdf(MARKER);

// The boxes the sender placed in their org. Note these are NOT the defaults
// used elsewhere in this project, and they sit on the ruled lines above.
const BOXES = {
  hod:     { page: 1, x: 90,  y: 475, w: 160, h: 44 },
  finance: { page: 1, x: 330, y: 305, w: 160, h: 44 },
};

const res = await fetch(`${BASE}/envelopes`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-esign-secret': SECRET },
  body: JSON.stringify({
    externalId: 'a03bm00001PO88231',
    fileName: 'Purchase_Order_88231.pdf',
    documentBase64: document.toString('base64'),
    message: 'Approve this purchase order.',
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    signers: [
      { order: 1, name: 'First Approver', email: 'approver@example.com',
        role: 'Head of Department', box: BOXES.hod },
      { order: 2, name: 'Second Approver', email: 'finance@example.com',
        role: 'Finance', box: BOXES.finance },
    ],
  }),
});

const created = await res.json();
if (!created.ok) {
  console.error('envelope rejected:', created.error);
  process.exit(1);
}

console.log(`uploaded "${MARKER}"`);
console.log(`  ${document.length} bytes, envelope ${created.envelopeId}\n`);

const tokens = created.signers.map((s) => s.url.split('/s/')[1]);

// Signer 1 opens. They must receive the exact bytes uploaded, and their box.
const got = await (await fetch(`${BASE}/sign/${tokens[0]}`)).json();

const back = Buffer.from(got.documentBase64, 'base64');
const same = back.equals(document);

console.log('what signer 1 is served:');
console.log(`  file            ${got.fileName}`);
console.log(`  signer          ${got.signerName} (${got.signerRole}), ${got.signOrder} of ${got.signerCount}`);
console.log(`  message         ${got.message}`);
console.log(`  document        ${back.length} bytes, byte-identical to the upload: ${same}`);
console.log(`  contains marker ${back.toString('latin1').includes(MARKER)}`);
console.log(`  their box       ${JSON.stringify(got.box)}`);
console.log(`  box matches     ${JSON.stringify(got.box) === JSON.stringify(BOXES.hod)}`);

// Signer 2 must get THEIR box, not signer 1's - and be told to wait.
const two = await (await fetch(`${BASE}/sign/${tokens[1]}`)).json();
console.log(`\nsigner 2 before their turn: ${two.reason}, waiting on ${two.waitingOn}`);

console.log('\nopen these:');
created.signers.forEach((s, i) => {
  const who = ['First Approver', 'Second Approver'][i];
  console.log(`  ${who.padEnd(12)} ${s.url}`);
});

/* Set exitCode rather than calling process.exit(): forcing exit while fetch's
   sockets are still closing trips a libuv assertion on Windows, which would
   report a crash for a run that actually passed. */
if (!same) {
  console.error('\nFAIL: the served document is not the uploaded document');
  process.exitCode = 1;
} else if (JSON.stringify(got.box) !== JSON.stringify(BOXES.hod)) {
  console.error('\nFAIL: the box was altered in transit');
  process.exitCode = 1;
} else {
  console.log('\nPASS: the document and its boxes survive the round trip.\n');
  process.exitCode = 0;
}
