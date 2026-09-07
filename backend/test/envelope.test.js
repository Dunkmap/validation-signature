import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSignedFileName, currentSigner, turnRefusal, waitingOn, isComplete,
  signedSoFar, orderedSigners, SIGNER_STATUS,
} from '../src/lib/envelope.js';

const S = (order, name, status = SIGNER_STATUS.PENDING, extra = {}) => ({
  signerId: `s${order}`, order, name, role: 'Role', status, ...extra,
});

test('signers are ordered by their order field, not array position', () => {
  const env = { signers: [S(3, 'Arun'), S(1, 'Priya'), S(2, 'Dillin')] };
  assert.deepEqual(orderedSigners(env).map((s) => s.name), ['Priya', 'Dillin', 'Arun']);
});

test('the current signer is the first who has not signed', () => {
  const env = { signers: [
    S(1, 'Priya', SIGNER_STATUS.SIGNED),
    S(2, 'Dillin'),
    S(3, 'Arun'),
  ] };
  assert.equal(currentSigner(env).name, 'Dillin');
  assert.deepEqual(waitingOn(env), ['Dillin', 'Arun']);
  assert.equal(isComplete(env), false);
});

test('ANY signer who has not signed may sign, whatever their position', () => {
  const env = { signers: [S(1, 'Priya'), S(2, 'Dillin'), S(3, 'Arun')] };
  // Nobody waits on anybody: the last in the list may go first.
  assert.equal(turnRefusal(env, env.signers[0]), null);
  assert.equal(turnRefusal(env, env.signers[1]), null);
  assert.equal(turnRefusal(env, env.signers[2]), null);
});

test('signing out of listed order leaves everyone else still able to sign', () => {
  const env = { signers: [
    S(1, 'Priya'),
    S(2, 'Dillin', SIGNER_STATUS.SIGNED),   // signed first, though listed second
    S(3, 'Arun'),
  ] };
  assert.equal(turnRefusal(env, env.signers[0]), null, 'Priya may still sign');
  assert.equal(turnRefusal(env, env.signers[2]), null, 'Arun may still sign');
  assert.equal(turnRefusal(env, env.signers[1]).reason, 'REFUSED', 'Dillin is done');
});

test('a signer who already signed is refused generically, revealing nothing', () => {
  const env = { signers: [S(1, 'Priya', SIGNER_STATUS.SIGNED), S(2, 'Dillin')] };
  const r = turnRefusal(env, env.signers[0]);
  assert.equal(r.reason, 'REFUSED');
  assert.equal(r.waitingOn, undefined);
});

test('the timeline shows everyone who has signed so far, in any position', () => {
  const env = { signers: [
    S(1, 'Priya'),
    S(2, 'Dillin', SIGNER_STATUS.SIGNED, { signedAt: 'b', documentHash: 'h2', ip: '2.2.2.2' }),
    S(3, 'Arun', SIGNER_STATUS.SIGNED, { signedAt: 'c', documentHash: 'h3', ip: '3.3.3.3' }),
  ] };
  /* Priya is listed FIRST and has not signed, yet she sees two signatures.
     Under the old ordered rule she would have seen none - which is exactly the
     behaviour that had to go. */
  assert.deepEqual(signedSoFar(env, env.signers[0]).map((t) => t.name), ['Dillin', 'Arun']);
  // A signer never appears in their own timeline.
  assert.deepEqual(signedSoFar(env, env.signers[1]).map((t) => t.name), ['Arun']);
});

test('each timeline entry carries that signer OWN hash', () => {
  const env = { signers: [
    S(1, 'Priya', SIGNER_STATUS.SIGNED, { signedAt: 'a', documentHash: 'hash-one' }),
    S(2, 'Dillin'),
  ] };
  assert.equal(signedSoFar(env, env.signers[1])[0].hash, 'hash-one');
});

// --- filename ---

test('filename is status, then request number, then document', () => {
  assert.equal(
    buildSignedFileName({ requestNumber: 'REQ-000031', originalName: 'Asset_Handover_Form.pdf' }),
    'Signed - REQ-000031 - Asset_Handover_Form.pdf');
});

test('a missing request number is omitted, never written as "null - "', () => {
  const name = buildSignedFileName({ requestNumber: null, originalName: 'Form.pdf' });
  assert.equal(name, 'Signed - Form.pdf');
  assert.ok(!name.includes('null'));
  assert.ok(!name.includes('undefined'));
});

test('a name this process already produced is not double-prefixed', () => {
  const once = buildSignedFileName({ requestNumber: 'REQ-000031', originalName: 'Form.pdf' });
  const twice = buildSignedFileName({ requestNumber: 'REQ-000031', originalName: once });
  assert.equal(twice, once);
  assert.equal(twice.match(/Signed - /g).length, 1);
});

test('a long name is clipped to 255, sacrificing the document name not the prefix', () => {
  const long = 'A'.repeat(400) + '.pdf';
  const name = buildSignedFileName({ requestNumber: 'REQ-000031', originalName: long });
  assert.equal(name.length, 255);
  // The prefix is the handle that finds the record; it must survive intact.
  assert.ok(name.startsWith('Signed - REQ-000031 - '));
  assert.ok(name.endsWith('.pdf'), 'the extension should survive the clip');
});
