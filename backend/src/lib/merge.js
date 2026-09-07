/* Merging independent signatures onto one document.

   Signing is unordered, so two people can sign at the same moment. Each of
   them is served the ORIGINAL document and stamps only their own signature
   box onto it. That makes their submissions independent - neither can
   overwrite the other, because neither ever held the other's work.

   This module puts them back together: take the original, copy each signer's
   stamped signature region onto it, and append one certificate page per
   signer. The result is rebuilt from scratch after every signature, so it
   always carries everyone who has signed so far.

   Why not simply chain (serve signer 2 the file signer 1 produced)? Because
   with no ordering, two signers can hold the same starting document at once,
   and the second save silently discards the first signature. A lost signature
   on a signed contract is the worst failure this system could have. */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { formatIst, formatIstWithUtc } from './datetime.js';
import { compareBySignedAt } from './envelope.js';

const MARGIN = 54;
const INK = rgb(0.07, 0.09, 0.15);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.85, 0.87, 0.9);

/* Build the finished document: the original, plus every signature stamped in
   its own box, plus a certificate page for each signer.

   `signed` is the list of signers who have signed, each with the bytes of the
   copy they submitted. Signers who have not signed are simply absent. */
export async function mergeSignatures({ originalBytes, signers }) {
  const out = await PDFDocument.load(originalBytes);
  const outPages = out.getPages();

  for (const entry of signers) {
    const { signer, bytes } = entry;
    if (!bytes) continue;

    const pageIndex = (signer.box?.page ?? 1) - 1;
    const target = outPages[pageIndex];
    if (!target) {
      // The box names a page the document does not have. Refusing here would
      // strand a signature that was legitimately taken, so record the problem
      // and keep every other signature rather than failing the whole merge.
      entry.mergeError = `page ${signer.box?.page} does not exist`;
      continue;
    }

    /* Copy the signed page as an embedded form, then draw ONLY the signature
       box region of it onto the original. Drawing the whole page would also
       carry over that signer's copy of the untouched background, which is
       identical - but clipping to the box makes the intent explicit and keeps
       one signer's rendering from disturbing another's. */
    try {
      const src = await PDFDocument.load(bytes);
      const [embedded] = await out.embedPdf(src, [pageIndex]);
      const b = signer.box;

      target.drawPage(embedded, {
        x: 0,
        y: 0,
        width: target.getWidth(),
        height: target.getHeight(),
        // Clip to the signature box: only this signer's mark is taken.
        clipBox: { left: b.x, bottom: b.y, right: b.x + b.w, top: b.y + b.h },
      });
    } catch (e) {
      entry.mergeError = e.message;
    }
  }

  await appendCertificates(out, signers);
  return Buffer.from(await out.save());
}

/* The certificate: a summary table of who signed and when, then one detail
   block per signer.

   BOTH ARE IN SIGNING SEQUENCE - earliest signature first - not in `order`,
   which is only where a box sits on the page. A certificate is a record of
   what happened, and what happened has a sequence: whoever signed first is
   numbered 1 in the table and carries that same number on their block below,
   so a reader can move between the two without matching names by eye.

   The table exists because the blocks alone do not answer "who signed this,
   and when" without reading every one of them. Twenty signers is a permitted
   envelope, and twenty blocks is not something anyone scans. */
async function appendCertificates(pdf, signers) {
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  /* Sorted on a COPY. The caller's array is the merge list, and reordering it
     underneath them to suit this page would be a side effect nobody reading
     mergeSignatures could see. */
  const sequence = [...signers].sort((a, b) => compareBySignedAt(a.signer, b.signer));

  let page = pdf.addPage([595.28, 841.89]); // A4
  let y = page.getHeight() - MARGIN;
  const width = page.getWidth() - MARGIN * 2;

  const newPage = () => {
    page = pdf.addPage([595.28, 841.89]);
    y = page.getHeight() - MARGIN;
  };
  const room = (need) => { if (y - need < MARGIN) newPage(); };

  const text = (s, { size = 10, f = font, color = INK, indent = 0 } = {}) => {
    for (const line of wrap(String(s ?? ''), f, size, width - indent)) {
      room(size + 4);
      page.drawText(line, { x: MARGIN + indent, y, size, font: f, color });
      y -= size + 4;
    }
  };

  const heading = (s) => {
    room(34);
    y -= 10;
    page.drawText(s.toUpperCase(), { x: MARGIN, y, size: 8.5, font: bold, color: MUTED });
    y -= 6;
    page.drawLine({
      start: { x: MARGIN, y }, end: { x: MARGIN + width, y },
      thickness: 0.75, color: RULE,
    });
    y -= 14;
  };

  const row = (k, v) => {
    room(15);
    page.drawText(k, { x: MARGIN, y, size: 9, font: bold, color: MUTED });
    for (const line of wrap(String(v ?? ''), font, 9.5, width - 150)) {
      page.drawText(line, { x: MARGIN + 150, y, size: 9.5, font, color: INK });
      y -= 13;
    }
    y -= 2;
  };

  /* Table columns, as offsets from the left margin. Fixed positions rather
     than wrapped cells: a long name that wrapped onto a second line would
     leave the timestamp beside it stranded against the wrong row, and the
     full untruncated name is repeated on that signer's own block anyway. */
  const COL = { seq: 0, name: 26, role: 210, time: 322 };
  const CELL = {
    seq: COL.name - COL.seq - 6,
    name: COL.role - COL.name - 6,
    role: COL.time - COL.role - 6,
    time: width - COL.time,
  };

  /* Truncate to the column, with an ellipsis so a shortened value is visibly
     shortened. A silently clipped name reads as the signer's actual name. */
  const fit = (value, f, size, maxWidth) => {
    let s = String(value ?? '');
    if (f.widthOfTextAtSize(s, size) <= maxWidth) return s;
    while (s.length > 1 && f.widthOfTextAtSize(`${s}...`, size) > maxWidth) {
      s = s.slice(0, -1);
    }
    return `${s}...`;
  };

  const tableRow = (cells, { f = font, size = 9, color = INK } = {}) => {
    room(15);
    for (const key of ['seq', 'name', 'role', 'time']) {
      page.drawText(fit(cells[key], f, size, CELL[key]), {
        x: MARGIN + COL[key], y, size, font: f, color,
      });
    }
    y -= 15;
  };

  page.drawText('Certificate of electronic signature', {
    x: MARGIN, y, size: 16, font: bold, color: INK,
  });
  y -= 26;
  text('This page records who signed this document, when, and what was observed '
     + 'about each signing session. Signatures were taken independently - nobody '
     + 'waited for anybody else - and are listed here in the order they were '
     + 'signed, earliest first. Times are Indian Standard Time (IST, UTC+5:30); '
     + 'the UTC value each one was recorded as is shown in brackets.',
    { size: 9.5, color: MUTED });
  y -= 6;

  /* Keep the table whole. A header stranded at the foot of one page with its
     rows on the next is worse than a table that starts further down. */
  room(48 + sequence.length * 15);

  heading(`Signing sequence - ${sequence.length} ${sequence.length === 1 ? 'signature' : 'signatures'}`);
  tableRow(
    { seq: '#', name: 'Signer', role: 'Role', time: 'Signed at (IST)' },
    { f: bold, size: 8.5, color: MUTED },
  );
  y += 4;
  page.drawLine({
    start: { x: MARGIN, y }, end: { x: MARGIN + width, y },
    thickness: 0.5, color: RULE,
  });
  y -= 11;

  sequence.forEach(({ signer }, i) => {
    tableRow({
      seq: String(i + 1),
      name: signer.name,
      role: signer.role || '-',
      time: formatIst(signer.signedAt),
    });
  });

  sequence.forEach(({ signer, mergeError }, i) => {
    heading(`${i + 1}. ${signer.name}${signer.role ? ` - ${signer.role}` : ''}`);
    /* The position restated on the block itself, because a block read on its
       own - quoted, printed, pulled into evidence - must still say where in
       the sequence this signature falls. */
    row('Signing sequence', `${i + 1} of ${sequence.length}`);
    /* IST first - the signer must recognise the time they signed - with the
       stored UTC alongside, which is the canonical value the hash and the
       Salesforce record were written against. */
    row('Signed at', formatIstWithUtc(signer.signedAt));
    row('Email', signer.email);
    if (signer.emailVerifiedAt) {
      // The point of the OTP: this signer proved control of the mailbox the
      // document was sent to before they were shown it.
      row('Email verified', `${signer.emailVerifiedTo} at ${formatIst(signer.emailVerifiedAt)}`);
    }
    row('IP address', signer.ip || 'Not available');
    row('Document hash', signer.documentHash);
    if (signer.timezone) row('Timezone', signer.timezone);
    if (signer.platform || signer.screen) {
      row('Device', [signer.platform, signer.screen].filter(Boolean).join(', '));
    }
    row('Location', locationLine(signer));
    if (signer.consentStatement) {
      y -= 4;
      text(`"${signer.consentStatement}"`, { size: 9, color: MUTED, indent: 0 });
    }
    if (mergeError) {
      // Never hide it: the signature was taken, and someone must be able to
      // see that it did not make it onto the page.
      text(`NOTE: this signature could not be placed on the document (${mergeError}). `
         + 'It is recorded here and the submitted file is retained.',
        { size: 9, color: rgb(0.7, 0.1, 0.1) });
    }
    y -= 8;
  });
}

function locationLine(s) {
  switch (s.locationStatus) {
    case 'Granted':
      return `${s.latitude}, ${s.longitude}`
           + (s.accuracy ? ` (within about ${Math.round(s.accuracy)} m)` : '');
    case 'Denied': return 'Declined by the signer';
    case 'Unavailable': return 'Not available on this device';
    default: return 'Not requested';
  }
}

function wrap(str, font, size, maxWidth) {
  const out = [];
  for (const para of String(str).split('\n')) {
    if (para === '') { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > maxWidth && line) {
        out.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) out.push(line);
  }
  return out;
}
