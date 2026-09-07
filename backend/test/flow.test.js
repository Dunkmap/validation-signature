/* The three-signer flow, end to end through the router.

   Signing is UNORDERED: anyone may sign whenever they like, including at the
   same moment as someone else. These tests cover both - signing out of the
   listed order, and two people submitting concurrently without either
   signature being lost. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/lib/store.js';
import { createConsoleMailer } from '../src/lib/mailer.js';
import { createRouter, createRateLimiter } from '../src/router.js';
import { sha256Hex } from '../src/lib/tokens.js';
import { PDFDocument } from 'pdf-lib';

const SECRET = 'test-secret';
const BASE = 'https://sign.example.com';

/* Real PDFs, not stubs.

   Signatures are now merged server-side with pdf-lib, so the bytes have to be
   a document it can actually parse. A fake "%PDF-..." string passed the old
   chained flow, which only ever stored bytes; it cannot pass a merge. */
const realPdf = async (label) => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  page.drawText(String(label), { x: 60, y: 700, size: 12 });
  return Buffer.from(await doc.save());
};

// Each signer stamps their own copy of the original, so "n" is just a label.
let pdfCache = {};
const pdfWith = (n) => pdfCache[n];

function setup({ onComplete } = {}) {
  const store = createMemoryStore();
  const mailer = createConsoleMailer({ log: () => {} });
  const route = createRouter({
    store, mailer, onComplete,
    config: { sharedSecret: SECRET, baseUrl: BASE, requestNumber: 'REQ-000031' },
    allow: () => true,
  });
  return { store, mailer, route };
}

// Built once, before the tests run: pdf-lib is async, the helpers are not.
pdfCache = {
  0: await realPdf('original'),
  1: await realPdf('signed by 1'),
  2: await realPdf('signed by 2'),
  3: await realPdf('signed by 3'),
};

const envelopeBody = (expiresAt) => ({
  externalId: 'a03bm00001np9fh',
  fileName: 'Asset_Handover_Form.pdf',
  documentBase64: pdfWith(0).toString('base64'),
  message: 'Please sign before Friday.',
  expiresAt: expiresAt || new Date(Date.now() + 7 * 86_400_000).toISOString(),
  signers: [
    { order: 1, name: 'Priya Sharma', email: 'priya@example.com', role: 'Admin',
      box: { page: 1, x: 62.2, y: 193.09, w: 160, h: 44 } },
    { order: 2, name: 'Dillin Nair', email: 'dillin@example.com', role: 'Employee',
      box: { page: 1, x: 300, y: 193.09, w: 160, h: 44 } },
    { order: 3, name: 'Arun Mehta', email: 'arun@example.com', role: 'Manager',
      box: { page: 1, x: 62.2, y: 120, w: 160, h: 44 } },
  ],
});

const create = (route, body) => route({
  method: 'POST', path: '/envelopes',
  headers: { 'x-esign-secret': SECRET }, body, clientIp: '10.0.0.1',
});

const tokenOf = (res, i) => res.body.signers[i].url.split('/s/')[1];

/* Clear the OTP gate for a token and return the session header.

   Every signing call needs this now: a signing link on its own no longer opens
   a document, which is the whole point of the email verification. The code is
   read from the console mailer rather than guessed. */
const verify = async (route, mailer, token) => {
  const asked = await route({
    method: 'POST', path: `/otp/${token}/request`, body: {}, clientIp: '1.1.1.1',
  });
  assert.equal(asked.body.ok, true, 'a code should have been issued');

  const otp = mailer._sent().filter((m) => m.kind === 'otp').pop();
  assert.ok(otp, 'the mailer should have been asked to send a code');

  const done = await route({
    method: 'POST', path: `/otp/${token}/verify`,
    body: { code: otp.code }, clientIp: '1.1.1.1',
  });
  assert.equal(done.body.ok, true, 'the mailed code should verify');
  return { 'x-esign-session': done.body.sessionSecret };
};

const submit = (route, token, n, ctx = {}, headers = {}) => route({
  method: 'POST', path: `/sign/${token}`, clientIp: '203.0.113.44', headers,
  body: {
    signedDocumentBase64: pdfWith(n).toString('base64'),
    consentStatement: 'I agree that my electronic signature is binding.',
    clientContext: {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120',
      language: 'en-GB', platform: 'Win32', screen: '1920x1080',
      timezone: 'Asia/Kolkata', locationStatus: 'Granted',
      latitude: 18.5204, longitude: 73.8567, accuracy: 24,
      ...ctx,
    },
  },
});

/* Verify, then sign, in one step - what most of these tests want. */
const signAs = async (route, mailer, token, n, ctx = {}) =>
  submit(route, token, n, ctx, await verify(route, mailer, token));

test('POST /envelopes requires the shared secret', async () => {
  const { route } = setup();
  const res = await route({ method: 'POST', path: '/envelopes', headers: {}, body: envelopeBody() });
  assert.equal(res.status, 401);
});

test('POST /envelopes returns one link per signer', async () => {
  const { route, mailer } = setup();
  const res = await create(route, envelopeBody());
  assert.equal(res.status, 201);
  assert.equal(res.body.signers.length, 3);
  for (const s of res.body.signers) assert.match(s.url, /^https:\/\/sign\.example\.com\/s\/[0-9a-f]{64}$/);

  // Every signer is emailed at once, and any of them may sign immediately.
  assert.equal(mailer._sent().length, 3);
});

test('ANY signer may sign at any time, in any order', async () => {
  const { route, mailer } = setup();
  const created = await create(route, envelopeBody());
  const [t1, t2, t3] = [0, 1, 2].map((i) => tokenOf(created, i));

  /* Signer 3 - LAST in the list - goes first. Under the old ordered rule this
     was refused with NOT_YOUR_TURN; it is now simply allowed. */
  const h3 = await verify(route, mailer, t3);
  const open3 = await route({
    method: 'GET', path: `/sign/${t3}`, clientIp: '192.0.2.7', headers: h3,
  });
  assert.equal(open3.body.ok, true, 'the last-listed signer may open first');
  assert.deepEqual(open3.body.timeline, [], 'nobody has signed yet');
  assert.equal(open3.body.ordered, false, 'the page is told there is no queue');

  const sign3 = await submit(route, t3, 3, {}, h3);
  assert.equal(sign3.body.ok, true);
  assert.equal(sign3.body.complete, false);

  // Signer 2 next, then signer 1 last. Every order is legitimate.
  const h2 = await verify(route, mailer, t2);
  const open2 = await route({
    method: 'GET', path: `/sign/${t2}`, clientIp: '198.51.100.9', headers: h2,
  });
  assert.equal(open2.body.ok, true);

  /* Everyone is served the ORIGINAL, never another signer's work - that is
     what makes simultaneous signing safe. */
  assert.deepEqual(Buffer.from(open2.body.documentBase64, 'base64'), pdfWith(0),
    'each signer receives the clean original');

  // But they still SEE who has signed, even though that person is listed after.
  assert.deepEqual(open2.body.timeline.map((t) => t.name), ['Arun Mehta']);
  assert.equal(open2.body.timeline[0].hash, sign3.body.documentHash);

  const sign2 = await submit(route, t2, 2, {}, h2);
  assert.equal(sign2.body.complete, false);

  const h1 = await verify(route, mailer, t1);
  const sign1 = await submit(route, t1, 1, {}, h1);
  assert.equal(sign1.body.complete, true, 'the final signature completes it');
  assert.deepEqual(sign1.body.waitingOn, []);

  // Each signature carries its own honest hash of what that person submitted.
  const hashes = [sign1.body.documentHash, sign2.body.documentHash, sign3.body.documentHash];
  assert.equal(new Set(hashes).size, 3, 'each signature must have its own hash');
  assert.equal(sign1.body.documentHash, sha256Hex(pdfWith(1)));
  assert.equal(sign3.body.documentHash, sha256Hex(pdfWith(3)));
});

test('two signers signing AT THE SAME TIME both survive', async () => {
  const { route, mailer } = setup();
  const created = await create(route, envelopeBody());
  const [t1, t2, t3] = [0, 1, 2].map((i) => tokenOf(created, i));

  // Both verify and open before either submits - they hold the document at
  // the same moment, which is exactly the case that used to lose a signature.
  const h1 = await verify(route, mailer, t1);
  const h2 = await verify(route, mailer, t2);
  await route({ method: 'GET', path: `/sign/${t1}`, headers: h1, clientIp: '1.1.1.1' });
  await route({ method: 'GET', path: `/sign/${t2}`, headers: h2, clientIp: '2.2.2.2' });

  // Now both submit concurrently.
  const [a, b] = await Promise.all([
    submit(route, t1, 1, {}, h1),
    submit(route, t2, 2, {}, h2),
  ]);
  assert.equal(a.body.ok, true);
  assert.equal(b.body.ok, true);

  /* Neither signature was lost: the envelope records BOTH. Chaining would have
     kept only whichever saved last. */
  const st = await route({ method: 'GET', path: `/status/${t3}`, clientIp: '1.1.1.1' });
  assert.equal(st.body.signedCount, 2, 'both signatures must be recorded');
  assert.deepEqual(st.body.waitingOn, ['Arun Mehta']);
});

test('the hash is computed server-side; a client-supplied hash is ignored', async () => {
  const { route, mailer } = setup();
  const created = await create(route, envelopeBody());
  const t1 = tokenOf(created, 0);
  const h1 = await verify(route, mailer, t1);

  const res = await route({
    method: 'POST', path: `/sign/${t1}`, clientIp: '1.1.1.1', headers: h1,
    body: {
      signedDocumentBase64: pdfWith(1).toString('base64'),
      consentStatement: 'I agree.',
      documentHash: 'deadbeef'.repeat(8),   // a lie
      clientContext: { locationStatus: 'Denied' },
    },
  });
  assert.equal(res.body.documentHash, sha256Hex(pdfWith(1)));
  assert.notEqual(res.body.documentHash, 'deadbeef'.repeat(8));
});

test('signing twice with the same token is refused', async () => {
  const { route, mailer } = setup();
  const created = await create(route, envelopeBody());
  const t1 = tokenOf(created, 0);

  const h1 = await verify(route, mailer, t1);
  assert.equal((await submit(route, t1, 1, {}, h1)).body.ok, true);
  // Even holding a still-live verified session, a second signature is refused.
  const again = await submit(route, t1, 1, {}, h1);
  assert.equal(again.body.ok, false);
  assert.equal(again.body.reason, 'REFUSED');
});

test('an invented locationStatus is rejected and nothing is stored', async () => {
  const { route, store, mailer } = setup();
  const created = await create(route, envelopeBody());
  const t1 = tokenOf(created, 0);
  const h1 = await verify(route, mailer, t1);

  const before = store._objectKeys().length;
  const res = await submit(route, t1, 1, { locationStatus: 'Sort of' }, h1);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /locationStatus/);
  assert.equal(store._objectKeys().length, before, 'no version should be written');

  // The signer can still sign properly afterwards.
  assert.equal((await submit(route, t1, 1, {}, h1)).body.ok, true);
});

test('every unknown, malformed or expired token gives the SAME refusal', async () => {
  const { route } = setup();
  const created = await create(route, envelopeBody(new Date(Date.now() - 1000).toISOString()));
  const expired = tokenOf(created, 0);

  const responses = await Promise.all([
    route({ method: 'GET', path: `/sign/${'a'.repeat(64)}`, clientIp: '1.1.1.1' }),
    route({ method: 'GET', path: '/sign/not-a-token', clientIp: '1.1.1.1' }),
    route({ method: 'GET', path: `/sign/${expired}`, clientIp: '1.1.1.1' }),
  ]);

  const messages = new Set(responses.map((r) => r.body.error));
  assert.equal(messages.size, 1, 'a prober must not learn which tokens exist');
  for (const r of responses) assert.equal(r.body.reason, 'REFUSED');
});

test('status reports progress and download is refused until complete', async () => {
  const { route, mailer } = setup();
  const created = await create(route, envelopeBody());
  const [t1, t2, t3] = [0, 1, 2].map((i) => tokenOf(created, i));

  let s = await route({ method: 'GET', path: `/status/${t1}`, clientIp: '1.1.1.1' });
  assert.deepEqual(
    { signed: s.body.signedCount, total: s.body.totalCount, complete: s.body.complete },
    { signed: 0, total: 3, complete: false });

  const early = await route({ method: 'GET', path: `/download/${t1}`, clientIp: '1.1.1.1' });
  assert.equal(early.status, 409);
  assert.equal(early.body.reason, 'NOT_COMPLETE');

  await signAs(route, mailer, t1, 1);
  await signAs(route, mailer, t2, 2);
  s = await route({ method: 'GET', path: `/status/${t3}`, clientIp: '1.1.1.1' });
  assert.equal(s.body.signedCount, 2);
  assert.deepEqual(s.body.waitingOn, ['Arun Mehta']);

  await signAs(route, mailer, t3, 3);

  // Available to EVERY signer once complete, not just the last.
  for (const t of [t1, t2, t3]) {
    const dl = await route({ method: 'GET', path: `/download/${t}`, clientIp: '1.1.1.1' });
    assert.equal(dl.status, 200);
    assert.equal(dl.isBinary, true);
    assert.equal(dl.contentType, 'application/pdf');
    assert.equal(dl.fileName, 'Signed - REQ-000031 - Asset_Handover_Form.pdf');
  }
});

test('the download serves the STORED bytes, identical every time', async () => {
  const { route, mailer } = setup();
  const created = await create(route, envelopeBody());
  const [t1, t2, t3] = [0, 1, 2].map((i) => tokenOf(created, i));
  await signAs(route, mailer, t1, 1); await signAs(route, mailer, t2, 2);
  const last = await signAs(route, mailer, t3, 3);

  const a = await route({ method: 'GET', path: `/download/${t1}`, clientIp: '1.1.1.1' });
  const b = await route({ method: 'GET', path: `/download/${t2}`, clientIp: '1.1.1.1' });

  /* Never re-rendered on the way out: pdf-lib stamps a new creation date on
     every save, so serving a fresh render would give a different file to each
     caller. The merge is written once, when the signature is taken. */
  assert.ok(Buffer.from(a.body).equals(Buffer.from(b.body)),
    'two downloads must be byte-identical');

  /* The merged document is NOT any one signer's bytes: it is the original with
     every signature merged onto it, so its hash necessarily differs from each
     individual signature hash. Each of those still attests to what that person
     personally signed. */
  assert.notEqual(sha256Hex(Buffer.from(a.body)), last.body.documentHash);
  assert.match(last.body.documentHash, /^[0-9a-f]{64}$/);
});

test('completion runs the write-back, and its failure does not lose the signature', async () => {
  const failures = [];
  const { route, store, mailer } = setup({
    onComplete: async () => { throw new Error('Salesforce refused the record'); },
  });
  const created = await create(route, envelopeBody());
  const [t1, t2, t3] = [0, 1, 2].map((i) => tokenOf(created, i));
  await signAs(route, mailer, t1, 1); await signAs(route, mailer, t2, 2);
  const res = await signAs(route, mailer, t3, 3);

  // The signature IS recorded - the signer is not told their signing failed.
  assert.equal(res.body.ok, true);
  assert.equal(res.body.complete, true);
  // But the failure is surfaced, never swallowed.
  assert.match(res.body.completionError, /Salesforce refused/);

  // And crucially: nothing was deleted. A deleted document with a failed
  // write-back is unrecoverable.
  const dl = await route({ method: 'GET', path: `/download/${t1}`, clientIp: '1.1.1.1' });
  assert.equal(dl.status, 200, 'the document must still be retrievable');
  assert.ok(store._objectKeys().length > 0);
});

test('rate limiting guards GET /sign, the endpoint an attacker can hammer', async () => {
  const store = createMemoryStore();
  const route = createRouter({
    store, mailer: createConsoleMailer({ log: () => {} }),
    config: { sharedSecret: SECRET, baseUrl: BASE },
    allow: createRateLimiter({ limit: 3, windowMs: 60_000 }),
  });

  const path = `/sign/${'a'.repeat(64)}`;
  const codes = [];
  for (let i = 0; i < 5; i++) {
    codes.push((await route({ method: 'GET', path, clientIp: '9.9.9.9' })).status);
  }
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);

  // A different caller is unaffected.
  const other = await route({ method: 'GET', path, clientIp: '8.8.8.8' });
  assert.equal(other.status, 200);
});
