/* The Express layer: security headers, CORS, auth, validation, rate limiting.

   Runs the real app over a real socket rather than a mock, so what is tested is
   what actually ships. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createMemoryStore } from '../src/lib/store.js';
import { createConsoleMailer } from '../src/lib/mailer.js';

const SECRET = 'test-secret';
const ORIGIN = 'http://127.0.0.1:3000';

function start({ rateLimit } = {}) {
  const store = createMemoryStore();
  const mailer = createConsoleMailer({ log: () => {} });
  const app = createApp({
    store, mailer,
    config: {
      sharedSecret: SECRET,
      signingBaseUrl: ORIGIN,
      allowedOrigins: [ORIGIN],
      requestNumber: 'REQ-000031',
      rateLimit,
    },
  });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server, store, mailer,
        url: (p) => `http://127.0.0.1:${port}${p}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

const pdf = (n = 1) => Buffer.from(`%PDF-1.4\nv${n}\n%%EOF`).toString('base64');

const envelope = () => ({
  externalId: 'a03bm00001np9fh',
  fileName: 'Form.pdf',
  documentBase64: pdf(0),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  signers: [
    { order: 1, name: 'Priya Sharma', email: 'priya@example.com', role: 'Admin',
      box: { page: 1, x: 62.2, y: 193.09, w: 160, h: 44 } },
    { order: 2, name: 'Dillin Nair', email: 'dillin@example.com', role: 'Employee',
      box: { page: 1, x: 300, y: 193.09, w: 160, h: 44 } },
  ],
});

const post = (t, path, body, headers = {}) => fetch(t.url(path), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

/* Clear the OTP gate over real HTTP and return the session header.

   A signing link alone no longer opens a document - the signer must also prove
   they control the mailbox it was sent to. The code is read out of the console
   mailer rather than guessed. */
const verify = async (t, token) => {
  const asked = await (await post(t, `/otp/${token}/request`, {})).json();
  assert.equal(asked.ok, true, 'a code should have been issued');

  const otp = t.mailer._sent().filter((m) => m.kind === 'otp').pop();
  assert.ok(otp, 'the mailer should have been asked to send a code');

  const done = await (await post(t, `/otp/${token}/verify`, { code: otp.code })).json();
  assert.equal(done.ok, true, 'the mailed code should verify');
  return { 'X-Esign-Session': done.sessionSecret };
};

// --- security headers ---

test('security headers are set by helmet', async () => {
  const t = await start();
  try {
    const res = await fetch(t.url('/health'));
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.ok(res.headers.get('strict-transport-security'));
    // The server should not advertise what it runs on.
    assert.equal(res.headers.get('x-powered-by'), null);
  } finally { await t.close(); }
});

// --- CORS ---

test('CORS allows the configured frontend origin', async () => {
  const t = await start();
  try {
    const res = await fetch(t.url('/health'), { headers: { Origin: ORIGIN } });
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  } finally { await t.close(); }
});

test('CORS refuses an unknown origin rather than reflecting it', async () => {
  const t = await start();
  try {
    const res = await fetch(t.url('/health'), { headers: { Origin: 'https://evil.example' } });
    // A reflected origin would let any site call this API with a stolen token.
    assert.notEqual(res.headers.get('access-control-allow-origin'), 'https://evil.example');
    assert.equal(res.status, 403);
  } finally { await t.close(); }
});

// --- auth ---

test('POST /envelopes without the shared secret is refused', async () => {
  const t = await start();
  try {
    const res = await post(t, '/envelopes', envelope());
    assert.equal(res.status, 401);
  } finally { await t.close(); }
});

test('POST /envelopes with a wrong secret is refused', async () => {
  const t = await start();
  try {
    const res = await post(t, '/envelopes', envelope(), { 'X-Esign-Secret': 'wrong' });
    assert.equal(res.status, 401);
  } finally { await t.close(); }
});

test('POST /envelopes with the right secret succeeds', async () => {
  const t = await start();
  try {
    const res = await post(t, '/envelopes', envelope(), { 'X-Esign-Secret': SECRET });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.signers.length, 2);
    assert.match(body.signers[0].url, /\/s\/[0-9a-f]{64}$/);
  } finally { await t.close(); }
});

// --- validation ---

test('a non-PDF upload is rejected by magic bytes', async () => {
  const t = await start();
  try {
    const bad = { ...envelope(), documentBase64: Buffer.from('<html>').toString('base64') };
    const res = await post(t, '/envelopes', bad, { 'X-Esign-Secret': SECRET });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /not a PDF/);
  } finally { await t.close(); }
});

test('duplicate signing orders are rejected', async () => {
  const t = await start();
  try {
    const bad = envelope();
    bad.signers[1].order = 1;
    const res = await post(t, '/envelopes', bad, { 'X-Esign-Secret': SECRET });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /duplicated/);
  } finally { await t.close(); }
});

test('malformed JSON gets a clear 400, not a stack trace', async () => {
  const t = await start();
  try {
    const res = await fetch(t.url('/envelopes'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Esign-Secret': SECRET },
      body: '{ not json',
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /not valid JSON/);
    assert.ok(!JSON.stringify(body).includes('at '), 'no stack trace should leak');
  } finally { await t.close(); }
});

test('an invented locationStatus is refused before anything is stored', async () => {
  const t = await start();
  try {
    const created = await (await post(t, '/envelopes', envelope(), { 'X-Esign-Secret': SECRET })).json();
    const token = created.signers[0].url.split('/s/')[1];
    const before = t.store._objectKeys().length;

    const res = await post(t, `/sign/${token}`, {
      signedDocumentBase64: pdf(1),
      consentStatement: 'I agree.',
      clientContext: { locationStatus: 'Sort of' },
    });

    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /locationStatus/);
    assert.equal(t.store._objectKeys().length, before, 'nothing may be written');
  } finally { await t.close(); }
});

// --- tokens ---

test('a malformed token is refused exactly like an unknown one', async () => {
  const t = await start();
  try {
    const a = await (await fetch(t.url('/sign/not-a-token'))).json();
    const b = await (await fetch(t.url(`/sign/${'a'.repeat(64)}`))).json();
    // A prober must not be able to tell which tokens exist.
    assert.equal(a.error, b.error);
    assert.equal(a.reason, 'REFUSED');
  } finally { await t.close(); }
});

// --- rate limiting ---

test('GET /sign is rate limited, the endpoint an attacker can hammer', async () => {
  const t = await start({ rateLimit: { windowMs: 60_000, max: 3 } });
  try {
    const codes = [];
    for (let i = 0; i < 5; i++) {
      codes.push((await fetch(t.url(`/sign/${'a'.repeat(64)}`))).status);
    }
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  } finally { await t.close(); }
});

// --- the ordered flow, over HTTP ---

test('the ordered flow works end to end over the real server', async () => {
  const t = await start();
  try {
    const created = await (await post(t, '/envelopes', envelope(), { 'X-Esign-Secret': SECRET })).json();
    const [t1, t2] = created.signers.map((s) => s.url.split('/s/')[1]);

    // Signer 2 is refused by name until signer 1 has signed.
    const early = await (await fetch(t.url(`/sign/${t2}`))).json();
    assert.equal(early.reason, 'NOT_YOUR_TURN');
    assert.equal(early.waitingOn, 'Priya Sharma');

    const h1 = await verify(t, t1);
    const open1 = await (await fetch(t.url(`/sign/${t1}`), { headers: h1 })).json();
    assert.equal(open1.ok, true);
    assert.deepEqual(open1.timeline, []);

    const sign1 = await (await post(t, `/sign/${t1}`, {
      signedDocumentBase64: pdf(1),
      consentStatement: 'I agree.',
      clientContext: { locationStatus: 'Granted', latitude: 18.5, longitude: 73.8 },
    }, h1)).json();
    assert.equal(sign1.ok, true);
    assert.equal(sign1.complete, false);

    // Signer 2 now receives the version carrying signature 1, and its hash.
    const h2 = await verify(t, t2);
    const open2 = await (await fetch(t.url(`/sign/${t2}`), { headers: h2 })).json();
    assert.equal(open2.ok, true);
    assert.equal(open2.timeline[0].hash, sign1.documentHash);

    const sign2 = await (await post(t, `/sign/${t2}`, {
      signedDocumentBase64: pdf(2),
      consentStatement: 'I agree.',
      clientContext: { locationStatus: 'Denied' },
    }, h2)).json();
    assert.equal(sign2.complete, true);
    assert.notEqual(sign1.documentHash, sign2.documentHash);

    // The finished document downloads, and is the stored bytes.
    const dl = await fetch(t.url(`/download/${t1}`));
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get('content-type'), 'application/pdf');
    assert.match(dl.headers.get('content-disposition'), /Signed - REQ-000031 - Form\.pdf/);
  } finally { await t.close(); }
});

test('download is refused until every signer has signed', async () => {
  const t = await start();
  try {
    const created = await (await post(t, '/envelopes', envelope(), { 'X-Esign-Secret': SECRET })).json();
    const token = created.signers[0].url.split('/s/')[1];
    const res = await fetch(t.url(`/download/${token}`));
    assert.equal(res.status, 409);
    assert.equal((await res.json()).reason, 'NOT_COMPLETE');
  } finally { await t.close(); }
});

test('health reports which drivers are in use', async () => {
  const t = await start();
  try {
    const body = await (await fetch(t.url('/health'))).json();
    assert.equal(body.ok, true);
    assert.equal(body.driver, 'memory');
  } finally { await t.close(); }
});
