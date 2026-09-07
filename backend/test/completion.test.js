/* Write-back, then deletion - and never the other way round. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { completeEnvelope } from '../src/lib/salesforce.js';
import { createMemoryStore } from '../src/lib/store.js';
import { createConsoleMailer } from '../src/lib/mailer.js';
import { documentKey, SIGNER_STATUS } from '../src/lib/envelope.js';

function fakeClient({ failOn } = {}) {
  const calls = [];
  return {
    calls,
    async create(sobject, fields) {
      calls.push({ op: 'create', sobject, fields });
      if (failOn === sobject) throw new Error(`${sobject} write failed`);
      return `id_${sobject}_${calls.length}`;
    },
    async update(sobject, id, fields) {
      calls.push({ op: 'update', sobject, id, fields });
      if (failOn === sobject) throw new Error(`${sobject} update failed`);
    },
    async linkDocument(cvId, entityId) {
      calls.push({ op: 'link', cvId, entityId });
      if (failOn === 'link') throw new Error('link failed');
      return 'doc_1';
    },
  };
}

async function seeded() {
  const store = createMemoryStore();
  const envelope = {
    envelopeId: 'env_test',
    externalId: 'a03bm00001np9fh',
    fileName: 'Form.pdf',
    signedFileName: 'Signed - REQ-000031 - Form.pdf',
    completedAt: '2026-09-03T10:00:00Z',
    signers: [
      { signerId: 's1', order: 1, name: 'Priya Sharma', email: 'priya@example.com',
        role: 'Admin', status: SIGNER_STATUS.SIGNED, signedAt: '2026-09-03T09:00:00Z',
        documentHash: 'h1', ip: '203.0.113.44', consentStatement: 'I agree.',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120', timezone: 'Asia/Kolkata',
        screen: '1920x1080', locationStatus: 'Granted', latitude: 18.5, longitude: 73.8,
        accuracy: 24 },
      { signerId: 's2', order: 2, name: 'Dillin Nair', email: 'dillin@example.com',
        role: 'Employee', status: SIGNER_STATUS.SIGNED, signedAt: '2026-09-03T10:00:00Z',
        documentHash: 'h2', ip: '198.51.100.9', consentStatement: 'I agree.',
        userAgent: 'Mozilla/5.0 (Macintosh; Mac OS X) Safari/17', timezone: 'Asia/Kolkata',
        screen: '1440x900', locationStatus: 'Denied', latitude: null, longitude: null,
        accuracy: null },
    ],
  };
  // versions 0 (original), 1 and 2 (each signature)
  for (let v = 0; v <= 2; v++) {
    await store.putObject(documentKey('env_test', v), Buffer.from(`%PDF- v${v}`));
  }
  return { store, envelope };
}

test('completion writes audit rows, marks signed, files the PDF, then deletes', async () => {
  const { store, envelope } = await seeded();
  const client = fakeClient();
  const mailer = createConsoleMailer({ log: () => {} });

  const res = await completeEnvelope({
    envelope, store, client, mailer, senderEmail: 'sender@example.com',
    requestNumber: 'REQ-000031',
  });

  const ops = client.calls.map((c) => `${c.op}:${c.sobject || c.cvId ? (c.sobject || 'link') : ''}`);
  assert.deepEqual(ops, [
    'create:E_Sign_Request__c',
    'create:E_Sign_Request__c',
    'update:Signature_Request__c',
    'create:ContentVersion',
    'link:link',
  ], 'the order of writes matters');

  // Only after every write confirmed.
  assert.equal(res.deleted, 3, 'all three versions should be removed');
  assert.equal(store._objectKeys().length, 0);
});

test('audit rows carry the fields Salesforce requires, per signer', async () => {
  const { store, envelope } = await seeded();
  const client = fakeClient();
  await completeEnvelope({
    envelope, store, client, mailer: createConsoleMailer({ log: () => {} }),
    senderEmail: 'sender@example.com', requestNumber: 'REQ-000031',
  });

  const rows = client.calls.filter((c) => c.sobject === 'E_Sign_Request__c').map((c) => c.fields);
  assert.equal(rows.length, 2);

  const priya = rows[0];
  assert.equal(priya.Signature_Request_Id__c, 'a03bm00001np9fh');
  assert.equal(priya.File_Name__c, 'Signed - REQ-000031 - Form.pdf');
  assert.equal(priya.Signer_Name__c, 'Priya Sharma');
  assert.equal(priya.Document_Hash__c, 'h1', 'that signer OWN hash, not the final one');
  assert.equal(priya.Signer_IP_Address__c, '203.0.113.44');
  assert.equal(priya.Status__c, 'Signed');
  assert.equal(priya.Signed_Via__c, 'Public Link');
  assert.equal(priya.Location_Status__c, 'Granted');
  assert.equal(priya.Signer_Browser__c, 'Chrome');
  assert.equal(priya.Signer_OS__c, 'Windows');
  assert.equal(priya.Signer_Device_Type__c, 'Desktop');
  // The name opens with the signing position, so the related list reads in
  // the order the document was actually signed.
  assert.match(priya.Name, /^1\. Priya Sharma - \d+ \w+ \d{4}$/);

  // Each signer keeps their own hash: signer 1 never saw signer 2's signature.
  assert.equal(rows[1].Document_Hash__c, 'h2');
  assert.notEqual(rows[0].Document_Hash__c, rows[1].Document_Hash__c);

  // A denied location is still recorded, with an allowed value.
  assert.equal(rows[1].Location_Status__c, 'Denied');
});

test('audit rows are written in SIGNING order, not box order', async () => {
  const { store, envelope } = await seeded();
  /* The signer placed FIRST on the page signs LAST. Box position and signing
     sequence now disagree, which is the only condition under which the two
     can be told apart - and the case the certificate and the related list
     have to agree on. */
  envelope.signers[0].signedAt = '2026-09-03T11:00:00Z';
  const client = fakeClient();
  await completeEnvelope({
    envelope, store, client, mailer: createConsoleMailer({ log: () => {} }),
    senderEmail: 'sender@example.com', requestNumber: 'REQ-000031',
  });

  const rows = client.calls
    .filter((c) => c.sobject === 'E_Sign_Request__c')
    .map((c) => c.fields);

  assert.deepEqual(
    rows.map((r) => r.Signer_Name__c),
    ['Dillin Nair', 'Priya Sharma'],
    'Dillin signed at 10:00 and Priya at 11:00, so Dillin is row 1',
  );
  assert.match(rows[0].Name, /^1\. Dillin Nair/);
  assert.match(rows[1].Name, /^2\. Priya Sharma/);
});
test('a failed audit write aborts BEFORE anything is deleted', async () => {
  const { store, envelope } = await seeded();
  const client = fakeClient({ failOn: 'E_Sign_Request__c' });

  await assert.rejects(
    () => completeEnvelope({
      envelope, store, client, mailer: createConsoleMailer({ log: () => {} }),
      senderEmail: 'sender@example.com',
    }),
    /E_Sign_Request__c write failed/);

  // A deleted document with a failed write-back is unrecoverable.
  assert.equal(store._objectKeys().length, 3, 'nothing may be deleted');
});

test('a failed ContentVersion upload aborts before deletion', async () => {
  const { store, envelope } = await seeded();
  const client = fakeClient({ failOn: 'ContentVersion' });

  await assert.rejects(() => completeEnvelope({
    envelope, store, client, mailer: createConsoleMailer({ log: () => {} }),
    senderEmail: 'sender@example.com',
  }));
  assert.equal(store._objectKeys().length, 3);
});

test('a missing final document aborts rather than writing an empty record', async () => {
  const { store, envelope } = await seeded();
  await store.deleteObjects([documentKey('env_test', 2)]);
  const client = fakeClient();

  await assert.rejects(
    () => completeEnvelope({
      envelope, store, client, mailer: createConsoleMailer({ log: () => {} }),
      senderEmail: 'sender@example.com',
    }),
    /Final document missing/);
  assert.equal(client.calls.length, 0, 'nothing should be written to Salesforce');
});

test('an email failure is reported but does not block the confirmed deletion', async () => {
  const { store, envelope } = await seeded();
  const client = fakeClient();
  const mailer = {
    async sendCompletion({ to }) { throw new Error(`SES rejected ${to}`); },
  };

  const res = await completeEnvelope({
    envelope, store, client, mailer, senderEmail: 'sender@example.com',
  });

  // Surfaced, not swallowed...
  assert.equal(res.mailErrors.length, 3);
  assert.match(res.mailErrors[0], /SES rejected/);
  // ...but the writes were confirmed, so the working copies still go.
  assert.equal(res.deleted, 3);
});

test('everyone is notified once: both signers and the sender, no duplicates', async () => {
  const { store, envelope } = await seeded();
  const sent = [];
  const mailer = { async sendCompletion({ to }) { sent.push(to); } };

  await completeEnvelope({
    envelope, store, client: fakeClient(), mailer,
    senderEmail: 'priya@example.com',   // also a signer
  });

  assert.equal(sent.length, 2, 'a signer who is also the sender is mailed once');
  assert.deepEqual(new Set(sent), new Set(['priya@example.com', 'dillin@example.com']));
});
