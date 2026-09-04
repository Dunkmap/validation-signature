import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSignedFileName, currentSigner, turnRefusal, waitingOn, isComplete,
  timelineBefore, orderedSigners, SIGNER_STATUS,
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

test('an out-of-turn signer is refused by name, not with the generic refusal', () => {
  const env = { signers: [S(1, 'Priya'), S(2, 'Dillin')] };
  const r = turnRefusal(env, env.signers[1]);
  assert.equal(r.reason, 'NOT_YOUR_TURN');
  // The one deliberate disclosure: whoever holds this token already knows they
  // are a signer, so naming who we wait on reveals nothing they did not have.
  assert.equal(r.waitingOn, 'Priya');
});

test('the signer whose turn it is may sign', () => {
  const env = { signers: [S(1, 'Priya'), S(2, 'Dillin')] };
  assert.equal(turnRefusal(env, env.signers[0]), null);
});

test('a signer who already signed is refused generically, revealing nothing', () => {
  const env = { signers: [S(1, 'Priya', SIGNER_STATUS.SIGNED), S(2, 'Dillin')] };
  const r = turnRefusal(env, env.signers[0]);
  assert.equal(r.reason, 'REFUSED');
  assert.equal(r.waitingOn, undefined);
});

test('the timeline shows only signatures taken BEFORE this signer', () => {
  const env = { signers: [
    S(1, 'Priya', SIGNER_STATUS.SIGNED, { signedAt: 'a', documentHash: 'h1', ip: '1.1.1.1' }),
    S(2, 'Dillin', SIGNER_STATUS.SIGNED, { signedAt: 'b', documentHash: 'h2', ip: '2.2.2.2' }),
    S(3, 'Arun'),
  ] };
  // Signer 2 never saw signer 3's signature - and signer 1 saw neither.
  assert.deepEqual(timelineBefore(env, env.signers[1]).map((t) => t.name), ['Priya']);
  assert.deepEqual(timelineBefore(env, env.signers[2]).map((t) => t.name), ['Priya', 'Dillin']);
  assert.deepEqual(timelineBefore(env, env.signers[0]), []);
});

test('each timeline entry carries that signer OWN hash', () => {
  const env = { signers: [
    S(1, 'Priya', SIGNER_STATUS.SIGNED, { signedAt: 'a', documentHash: 'hash-one' }),
    S(2, 'Dillin'),
  ] };
  assert.equal(timelineBefore(env, env.signers[1])[0].hash, 'hash-one');
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
