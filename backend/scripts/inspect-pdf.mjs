/* Read a signed PDF back and report what is actually in it.

     node scripts/inspect-pdf.mjs <file.pdf>

   Uses the vendored PDF.js so it needs no extra dependency. */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/inspect-pdf.mjs <file.pdf>');
  process.exit(1);
}

const HERE = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(import.meta.url);

// PDF.js needs a DOM-ish global for its canvas factory; text extraction does not
// touch it, so a stub is enough.
globalThis.window = globalThis;
// navigator is read-only in Node 24, and PDF.js only reads userAgent from it.
if (!globalThis.navigator) {
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' } });
}

const pdfjs = require(join(HERE, '..', '..', 'frontend', 'vendor', 'pdf.min.js'));
const lib = pdfjs.pdfjsLib || globalThis.pdfjsLib || pdfjs;
lib.GlobalWorkerOptions.workerSrc = join(HERE, '..', '..', 'frontend', 'vendor', 'pdf.worker.min.js');

const bytes = new Uint8Array(await readFile(file));
const doc = await lib.getDocument({ data: bytes, useWorkerFetch: false, isEvalSupported: false }).promise;

console.log(`pages: ${doc.numPages}`);

let all = '';
for (let n = 1; n <= doc.numPages; n++) {
  const page = await doc.getPage(n);
  const content = await page.getTextContent();
  const text = content.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();
  all += '\n' + text;
  const label = text.includes('Certificate of electronic signature') ? 'CERTIFICATE' : 'document';
  console.log(`  page ${n} (${label}): ${text.slice(0, 90)}${text.length > 90 ? '…' : ''}`);
}

const markers = [
  'Certificate of electronic signature', 'WHO SIGNED', 'WHEN',
  'OBSERVED BY THE SERVER', 'REPORTED BY THE BROWSER',
  'CONSENT GIVEN',
  'not been independently verified', 'VPN',
];

console.log('\nmarkers:');
let missing = 0;
for (const m of markers) {
  const ok = all.includes(m);
  if (!ok) missing++;
  console.log(`  ${ok ? 'yes' : ' NO'}  ${m}`);
}

/* The chain, per certificate page: signer N's certificate must print the hash
   of every signature taken BEFORE theirs, and none taken after - signer 1
   never saw signers 2 and 3. */
console.log('\nhash chain, per certificate page:');
for (let n = 2; n <= doc.numPages; n++) {
  const page = await doc.getPage(n);
  const items = await page.getTextContent();
  const text = items.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ');
  /* A 64-character hash does not fit one line, so the page wraps it and the
     extracted text carries a space mid-hash ("…419a8c 81"). Strip spaces
     inside any run of hex before matching, or a correct chain reads as empty. */
  const joined = text.replace(/(?:[0-9a-f]+ )+[0-9a-f]+/g, (run) => run.replace(/ /g, ''));
  const hashes = [...new Set([...joined.matchAll(/\b[0-9a-f]{64}\b/g)].map((m) => m[0]))];
  const who = (text.match(/Name ([A-Za-z ]+?) Role/) || [])[1] || `page ${n}`;

  const section = (text.split('SIGNED BEFORE THIS SIGNATURE')[1] || '').split('CONSENT GIVEN')[0];
  const prior = signerNames.filter((x) => section.includes(x));
  console.log(`  ${who.padEnd(14)} lists prior signers [${prior.join(', ') || 'none'}]`
    + `, prints ${hashes.length} hash(es)`);
}

process.exit(missing ? 1 : 0);
