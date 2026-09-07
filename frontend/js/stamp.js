/* pdf-lib WRITES into the file: it stamps the signature image into the box and
   appends the certificate page. PDF.js only ever renders for display - do not
   reach for one where the other belongs. */

const { PDFDocument, StandardFonts, rgb } = window.PDFLib;

const MARGIN = 54;
const INK = rgb(0.07, 0.09, 0.15);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.85, 0.87, 0.9);

/* Stamp the signature and append the certificate. Returns the bytes to POST.

   These are the bytes the server hashes and stores. The download later serves
   that stored array back - it is never re-rendered, because pdf-lib writes a
   fresh creation date and new object ids on every save, so a second save is
   never byte-identical. */
export async function stampAndCertify({ documentBytes, box, signatureDataUrl,
                                        signerName, signerRole, signMethod,
                                        signedAt, consentStatement,
                                        serverIp, browser, location, timeline }) {
  const pdf = await PDFDocument.load(documentBytes);

  // --- the signature itself ---
  const png = await pdf.embedPng(signatureDataUrl);
  const pages = pdf.getPages();
  const page = pages[box.page - 1];
  if (!page) throw new Error(`The document has no page ${box.page} to sign on.`);

  // Box coordinates are already in PDF points, origin bottom-left - the same
  // space pdf-lib draws in. No flip here; the flip belongs on screen only.
  const fitted = fitInside(png.width, png.height, box.w, box.h);
  page.drawImage(png, {
    x: box.x + (box.w - fitted.w) / 2,
    y: box.y + (box.h - fitted.h) / 2,
    width: fitted.w,
    height: fitted.h,
  });

  await appendCertificate(pdf, {
    signerName, signerRole, signMethod, signedAt, consentStatement,
    serverIp, browser, location, timeline,
  });

  return pdf.save();
}

function fitInside(w, h, maxW, maxH) {
  const s = Math.min(maxW / w, maxH / h);
  return { w: w * s, h: h * s };
}

async function appendCertificate(pdf, d) {
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let page = pdf.addPage([595.28, 841.89]); // A4
  let y = page.getHeight() - MARGIN;
  const width = page.getWidth() - MARGIN * 2;

  const newPage = () => {
    page = pdf.addPage([595.28, 841.89]);
    y = page.getHeight() - MARGIN;
  };
  const room = (need) => { if (y - need < MARGIN) newPage(); };

  const text = (s, { size = 10, f = font, color = INK, indent = 0 } = {}) => {
    const lines = wrap(String(s ?? ''), f, size, width - indent);
    room(lines.length * (size + 4));
    for (const line of lines) {
      page.drawText(line, { x: MARGIN + indent, y, size, font: f, color });
      y -= size + 4;
    }
  };

  const heading = (s) => {
    room(34);
    y -= 10;
    page.drawText(s.toUpperCase(), {
      x: MARGIN, y, size: 8.5, font: bold, color: MUTED,
    });
    y -= 6;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: MARGIN + width, y },
      thickness: 0.5, color: RULE,
    });
    y -= 14;
  };

  // A label/value row, so the certificate reads as a record rather than prose.
  const row = (label, value) => {
    const size = 10;
    const labelW = 150;
    const lines = wrap(String(value ?? '-'), font, size, width - labelW);
    room(Math.max(1, lines.length) * (size + 4));
    page.drawText(label, { x: MARGIN, y, size, font: bold, color: MUTED });
    lines.forEach((line, i) => {
      page.drawText(line, { x: MARGIN + labelW, y: y - i * (size + 4), size, font, color: INK });
    });
    y -= Math.max(1, lines.length) * (size + 4);
  };

  // --- title ---
  page.drawText('Certificate of electronic signature', {
    x: MARGIN, y, size: 17, font: bold, color: INK,
  });
  y -= 26;

  heading('Who signed');
  row('Name', d.signerName);
  row('Role', d.signerRole);
  row('Signature method', d.signMethod);

  /* IST first: it is the business timezone this service runs in, and the one
     the signer and whoever files the document both work in. UTC stays as the
     canonical record, and the browser's own zone is kept because it is
     evidence about the signing session - it may differ from both, and that
     difference is worth being able to see. */
  heading('When');
  row('IST', formatIst(d.signedAt));
  row('UTC', formatUtc(d.signedAt));
  if (d.browser.timezone && d.browser.timezone !== 'Asia/Kolkata') {
    row('Signer local', formatLocal(d.signedAt, d.browser.timezone));
  }

  /* The server-observed value gets its own section, deliberately separate from
     the browser-reported ones below, because they carry different evidential
     weight: one the server saw for itself, the others the browser asserted. */
  heading('Observed by the server');
  row('IP address', d.serverIp);

  heading('Reported by the browser');
  row('Timezone', d.browser.timezone);
  row('Language', d.browser.language);
  row('Platform', `${d.browser.platform} (${d.browser.os})`);
  row('Browser', d.browser.browser);
  row('Screen', d.browser.screen);
  row('Location', describeLocation(d.location));

  if (d.timeline && d.timeline.length) {
    heading('Signed before this signature');
    for (const t of d.timeline) {
      text(`${t.name}${t.role ? ' - ' + t.role : ''}`, { f: bold, size: 10 });
      row('  Signed at', formatIst(t.signedAt));
      row('  IP address', t.ip);
      // Each earlier signer's own hash, so the chain is checkable from outside
      // the system: every signature answers for the bytes that signer saw.
      row('  Document hash', t.hash);
      y -= 4;
    }
  }

  heading('Consent given');
  text(d.consentStatement, { size: 10 });

  heading('Notes');
  text('The values under "Reported by the browser" were supplied by the signer\'s '
     + 'browser and have not been independently verified. An IP address may belong '
     + 'to a proxy, a VPN or a shared network, and does not by itself identify an '
     + 'individual or a precise location.', { size: 9, color: MUTED });
}

function describeLocation(loc) {
  if (!loc || loc.locationStatus !== 'Granted') {
    return loc?.locationStatus || 'Not requested';
  }
  const acc = loc.accuracy != null ? ` (accurate to ~${loc.accuracy} m)` : '';
  return `Granted - ${loc.latitude}, ${loc.longitude}${acc}`;
}

/* Indian Standard Time, always labelled - never a bare time that invites the
   reader to assume their own zone. */
function formatIst(iso) {
  const dt = new Date(iso);
  if (isNaN(dt)) return '-';
  const s = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    timeZone: 'Asia/Kolkata',
  }).format(dt);
  return `${s.replace('Sept', 'Sep')} IST`;
}

function formatUtc(iso) {
  const dt = new Date(iso);
  return isNaN(dt) ? '-' : dt.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function formatLocal(iso, tz) {
  const dt = new Date(iso);
  if (isNaN(dt)) return '-';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'medium', timeStyle: 'medium', timeZone: tz,
    }).format(dt) + ` (${tz})`;
  } catch {
    return formatUtc(iso);
  }
}

/* Wrap on width, and hard-break anything that has no spaces to break on -
   a 64-character hash would otherwise run off the page. */
function wrap(str, font, size, maxWidth) {
  const out = [];
  for (const para of String(str).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const candidate = line ? line + ' ' + word : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) out.push(line);
      if (font.widthOfTextAtSize(word, size) <= maxWidth) {
        line = word;
      } else {
        let chunk = '';
        for (const ch of word) {
          if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth) {
            out.push(chunk);
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        line = chunk;
      }
    }
    out.push(line);
  }
  return out;
}
