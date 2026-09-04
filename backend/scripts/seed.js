/* Create an envelope from a real PDF and real signers.

     node scripts/seed.js --file ./contract.pdf \
       --signer "Name <email@example.com>:Role:page,x,y,w,h" \
       --signer "Other <other@example.com>:Role:1,300,193,160,44" \
       --message "Please sign before Friday."

   Or from a JSON file describing the whole envelope:

     node scripts/seed.js --json ./envelope.json

   Signature boxes are PDF points with the origin BOTTOM-LEFT, exactly as the
   sender's system recorded them. They are passed through unchanged. */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const BASE = process.env.ESIGN_BASE_URL || 'http://127.0.0.1:4000';
const SECRET = process.env.ESIGN_SECRET || 'local-dev-secret';

// --- arguments ---

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const all = (name) => args.reduce((acc, a, i) => {
  if (a === `--${name}`) acc.push(args[i + 1]);
  return acc;
}, []);

function usage(problem) {
  if (problem) console.error(`\n${problem}\n`);
  console.error(`Create a signing envelope.

  node scripts/seed.js --file <pdf> --signer <spec> [--signer <spec> ...]
                       [--message <text>] [--id <external id>] [--days <n>]

  node scripts/seed.js --json <file>

A signer spec is:

  "Full Name <email@example.com>:Role:page,x,y,w,h"

  page,x,y,w,h are the signature box in PDF points, origin bottom-left.
  Role may be left empty: "Name <email>::1,62,193,160,44"

Signers are numbered in the order given: the first signs first.

Example:

  node scripts/seed.js --file ./contract.pdf \\
    --signer "A Person <a@example.com>:Approver:1,62,193,160,44" \\
    --signer "B Person <b@example.com>:Finance:1,300,193,160,44"
`);
  process.exit(problem ? 1 : 0);
}

if (args.includes('--help') || args.includes('-h') || args.length === 0) usage();

/* "Name <email>:Role:page,x,y,w,h"

   Parsed strictly: a mistyped box would otherwise place a signature somewhere
   nobody intended, and that only becomes visible after someone has signed. */
function parseSigner(spec, index) {
  const at = `--signer #${index + 1}`;

  const m = spec.match(/^\s*(.+?)\s*<([^>]+)>\s*:([^:]*):\s*(.+?)\s*$/);
  if (!m) usage(`${at} is malformed.\n  got:      ${spec}\n  expected: "Name <email>:Role:page,x,y,w,h"`);

  const [, name, email, role, boxPart] = m;
  const nums = boxPart.split(',').map((n) => Number(n.trim()));
  if (nums.length !== 5 || nums.some((n) => !Number.isFinite(n))) {
    usage(`${at} has a bad box: "${boxPart}"\n  expected five numbers: page,x,y,w,h`);
  }

  const [page, x, y, w, h] = nums;
  if (!Number.isInteger(page) || page < 1) usage(`${at}: page must be a whole number from 1`);
  if (w <= 0 || h <= 0) usage(`${at}: width and height must be positive`);

  return { order: index + 1, name: name.trim(), email: email.trim(), role: role.trim(),
           box: { page, x, y, w, h } };
}

// --- build the envelope ---

let envelope;

const jsonPath = opt('json');
if (jsonPath) {
  envelope = JSON.parse(await readFile(jsonPath, 'utf8'));
  if (!envelope.documentBase64 && envelope.file) {
    envelope.documentBase64 = (await readFile(envelope.file)).toString('base64');
    envelope.fileName ||= basename(envelope.file);
    delete envelope.file;
  }
} else {
  const file = opt('file');
  if (!file) usage('--file is required (the PDF to be signed).');

  const specs = all('signer');
  if (!specs.length) usage('At least one --signer is required.');

  let bytes;
  try {
    bytes = await readFile(file);
  } catch {
    usage(`Could not read ${file}`);
  }

  // Check it here rather than let the server explain it: a clearer message,
  // and it costs one comparison.
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    usage(`${file} is not a PDF (it does not start with %PDF-).`);
  }

  const days = Number(opt('days') || 7);

  envelope = {
    externalId: opt('id') || `local-${Date.now()}`,
    fileName: basename(file),
    documentBase64: bytes.toString('base64'),
    message: opt('message') || '',
    expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(),
    signers: specs.map(parseSigner),
  };
}

// --- send it ---

const res = await fetch(`${BASE}/envelopes`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-esign-secret': SECRET },
  body: JSON.stringify(envelope),
});

const json = await res.json().catch(() => ({}));

if (!res.ok || !json.ok) {
  console.error(`\nEnvelope rejected (${res.status}): ${json.error || 'unknown error'}\n`);
  process.exit(1);
}

console.log(`\nEnvelope ${json.envelopeId} created from ${envelope.fileName}.\n`);
console.log('Signing links, in order:\n');

for (const s of json.signers) {
  const who = envelope.signers.find((x) => x.order === s.order);
  console.log(`  ${s.order}. ${who.name.padEnd(22)} ${s.url}`);
}

const failed = (json.invitations || []).filter((i) => !i.ok);
if (failed.length) {
  // Surfaced, never swallowed: the envelope exists, but someone was not told.
  console.log(`\n${failed.length} invitation(s) failed to send:`);
  for (const f of failed) console.log(`  ${f.email}: ${f.error}`);
}

if (json.signers.length > 1) {
  console.log('\nOpen them in order. Any but the first will say it is not their turn yet.');
}
console.log('');
