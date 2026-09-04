/* The disk store, and honest reporting of whether mail was actually sent. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDiskStore, createMemoryStore } from '../src/lib/store.js';
import { createConsoleMailer } from '../src/lib/mailer.js';
import { createEnvelope } from '../src/handlers/envelopes.js';
import { tokenLookupKey } from '../src/lib/tokens.js';

const pdf = Buffer.from('%PDF-1.4\nbody\n%%EOF');

async function withTempStore(fn) {
  const root = await mkdtemp(join(tmpdir(), 'esign-test-'));
  try {
    await fn(createDiskStore({ root }), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// --- disk store ---

test('an envelope written to disk survives a fresh store instance', async () => {
  await withTempStore(async (store, root) => {
    await store.putEnvelope({ envelopeId: 'env_1', fileName: 'a.pdf', signers: [] });

    // A new instance is what a restarted process gets.
    const reopened = createDiskStore({ root });
    const got = await reopened.getEnvelope('env_1');
    assert.equal(got.fileName, 'a.pdf');
  });
});

test('documents round-trip byte-for-byte through disk', async () => {
  await withTempStore(async (store) => {
    await store.putObject('envelopes/env_1/v0.pdf', pdf);
    const back = await store.getObject('envelopes/env_1/v0.pdf');
    assert.ok(back.equals(pdf));
  });
});

test('a missing document reads as null, not an error', async () => {
  await withTempStore(async (store) => {
    assert.equal(await store.getObject('envelopes/nope/v9.pdf'), null);
    assert.equal(await store.getEnvelope('nope'), null);
  });
});

test('tokens are stored hashed, so the directory reveals no working links', async () => {
  await withTempStore(async (store, root) => {
    const token = 'a'.repeat(64);
    const hash = tokenLookupKey(token);
    await store.indexToken(hash, { envelopeId: 'env_1', signerId: 'sgn_1' });

    const files = await readdir(join(root, 'tokens'));
    assert.ok(files.includes(`${hash}.json`));
    assert.ok(!files.some((f) => f.includes(token)), 'the raw token must never be on disk');

    assert.deepEqual(await store.resolveToken(hash), { envelopeId: 'env_1', signerId: 'sgn_1' });
  });
});

test('deleting removes the file from disk', async () => {
  await withTempStore(async (store) => {
    await store.putObject('envelopes/env_1/v0.pdf', pdf);
    assert.equal((await store._objectKeys()).length, 1);
    await store.deleteObjects(['envelopes/env_1/v0.pdf']);
    assert.equal((await store._objectKeys()).length, 0);
  });
});

test('a partial write leaves no half-file behind', async () => {
  await withTempStore(async (store) => {
    await store.putObject('envelopes/env_1/v0.pdf', pdf);
    // Writes go via a temp file and a rename, so no .tmp should survive.
    const keys = await store._objectKeys();
    assert.ok(!keys.some((k) => k.endsWith('.tmp')), `stray temp file: ${keys}`);
  });
});

// --- honest mail reporting ---

const envelopeBody = () => ({
  externalId: 'x',
  fileName: 'a.pdf',
  documentBase64: pdf.toString('base64'),
  message: '',
  signers: [
    { order: 1, name: 'One', email: 'one@example.com', role: '', box: { page: 1, x: 1, y: 1, w: 10, h: 10 } },
    { order: 2, name: 'Two', email: 'two@example.com', role: '', box: { page: 1, x: 1, y: 1, w: 10, h: 10 } },
  ],
});

test('the console driver reports invitations as NOT delivered', async () => {
  const res = await createEnvelope({
    body: envelopeBody(),
    store: createMemoryStore(),
    mailer: createConsoleMailer({ log: () => {} }),
    baseUrl: 'https://example.com',
  });

  assert.equal(res.body.ok, true);
  // It "succeeded" by printing - which must not read as delivery.
  for (const i of res.body.invitations) {
    assert.equal(i.ok, true);
    assert.equal(i.delivered, false, 'printing is not delivering');
  }
  assert.match(res.body.warning, /NOT delivered/);
  assert.match(res.body.warning, /console/);
});

test('a driver that really sends reports delivered, with no warning', async () => {
  const realish = {
    driver: 'smtp',
    delivers: true,
    async sendInvitation() { return '<id@example.com>'; },
    async sendCompletion() {},
  };

  const res = await createEnvelope({
    body: envelopeBody(),
    store: createMemoryStore(),
    mailer: realish,
    baseUrl: 'https://example.com',
  });

  for (const i of res.body.invitations) assert.equal(i.delivered, true);
  assert.equal(res.body.warning, undefined);
});

test('one failed invitation is reported without failing the envelope', async () => {
  let n = 0;
  const flaky = {
    driver: 'smtp',
    delivers: true,
    async sendInvitation() {
      if (++n === 2) throw new Error('mailbox full');
      return '<id@example.com>';
    },
    async sendCompletion() {},
  };

  const res = await createEnvelope({
    body: envelopeBody(),
    store: createMemoryStore(),
    mailer: flaky,
    baseUrl: 'https://example.com',
  });

  // The envelope is valid and its links work; only the telling failed.
  assert.equal(res.body.ok, true);
  assert.equal(res.body.signers.length, 2);

  const failed = res.body.invitations.filter((i) => !i.ok);
  assert.equal(failed.length, 1);
  assert.match(failed[0].error, /mailbox full/);
  assert.match(res.body.warning, /1 invitation/);
});

test('the console driver states on every message that nothing was sent', async () => {
  const lines = [];
  const mailer = createConsoleMailer({ log: (l) => lines.push(l) });
  await mailer.sendInvitation({
    to: 'one@example.com', signerName: 'One', fileName: 'a.pdf', message: '', url: 'https://x/s/t',
  });
  const out = lines.join('\n');
  assert.match(out, /NOT SENT/);
  assert.match(out, /nothing was delivered/);
});
