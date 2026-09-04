/* Write a blank PDF with ruled signature lines, for when you want to try the
   flow and have no document to hand.

     node scripts/make-test-pdf.js [out.pdf] [lines]

   Prints the box coordinates for each line, ready to paste into --signer.
   Written by hand so this script needs no dependency. */

import { writeFile } from 'node:fs/promises';

const out = process.argv[2] || 'test-document.pdf';
const count = Math.min(6, Math.max(1, Number(process.argv[3] || 2)));

const PAGE_H = 841.89;
const BOX_W = 160;
const BOX_H = 44;

/* Lines down the page, alternating left and right. `y` is the LINE; the box
   sits just above it, which is what the coordinates below describe. */
const lines = Array.from({ length: count }, (_, i) => ({
  x: i % 2 === 0 ? 62.2 : 330,
  y: 560 - Math.floor(i / 2) * 130,
  label: `Signature ${i + 1}`,
}));

const body = [
  'BT /F1 18 Tf 62 760 Td (Test document) Tj ET',
  'BT /F1 10 Tf 62 730 Td (A blank document with ruled signature lines, for testing the signing flow.) Tj ET',
  ...lines.flatMap((l) => [
    `0.55 G ${l.x} ${l.y} m ${l.x + BOX_W} ${l.y} l S`,
    `BT /F1 8 Tf ${l.x} ${l.y - 14} Td (${l.label}) Tj ET`,
  ]),
].join('\n');

const objs = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 ${PAGE_H}] `
    + '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
  `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
];

let pdf = '%PDF-1.4\n';
const offsets = [0];
objs.forEach((o, i) => {
  offsets.push(pdf.length);
  pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
});
const xref = pdf.length;
pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
for (let i = 1; i <= objs.length; i++) {
  pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
}
pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;

await writeFile(out, Buffer.from(pdf, 'latin1'));

console.log(`\nWrote ${out} with ${count} signature line(s).\n`);
console.log('Box coordinates (PDF points, origin bottom-left):\n');
lines.forEach((l, i) => {
  // The box sits just above its line.
  console.log(`  ${l.label}:  1,${l.x},${l.y + 5},${BOX_W},${BOX_H}`);
});
console.log('\nFor example:\n');
console.log(`  node scripts/seed.js --file ${out} \\`);
lines.forEach((l, i) => {
  const cont = i < lines.length - 1 ? ' \\' : '';
  console.log(`    --signer "Name ${i + 1} <person${i + 1}@example.com>:Role:1,${l.x},${l.y + 5},${BOX_W},${BOX_H}"${cont}`);
});
console.log('');
