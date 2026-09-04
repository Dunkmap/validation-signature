import { randomUUID } from 'node:crypto';
import { newToken, tokenLookupKey } from '../lib/tokens.js';
import { validateEnvelope, decodeBase64 } from '../lib/validation.js';
import { originalKey, SIGNER_STATUS, orderedSigners } from '../lib/envelope.js';

/* POST /envelopes - called by Salesforce.

   Stores the original document, mints one token per signer, and returns their
   signing links. Every signer is emailed at once; the ORDER is enforced when
   the page is opened, not by withholding the email. */
export async function createEnvelope({ body, store, mailer, now = () => new Date(), baseUrl }) {
  const errors = validateEnvelope(body);
  if (errors.length) {
    return { status: 400, body: { ok: false, error: errors.join('; ') } };
  }

  const envelopeId = `env_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const document = decodeBase64(body.documentBase64);

  const created = now().toISOString();
  const links = [];

  const signers = orderedSigners({ signers: body.signers }).map((s) => {
    const token = newToken();
    const signerId = `sgn_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    links.push({ order: s.order, email: s.email, token, signerId });
    return {
      signerId,
      order: s.order,
      name: s.name,
      email: s.email,
      role: s.role || '',
      box: s.box,
      status: SIGNER_STATUS.PENDING,
      // The token is stored HASHED. A leaked table must not hand over working
      // signing links.
      tokenHash: tokenLookupKey(token),
    };
  });

  const envelope = {
    envelopeId,
    externalId: body.externalId,
    fileName: body.fileName,
    message: body.message || '',
    expiresAt: body.expiresAt || null,
    createdAt: created,
    completedAt: null,
    signers,
  };

  // Store the original as version 0, then the envelope, then the token index.
  // Order matters: nothing should be reachable before the bytes it points at.
  await store.putObject(originalKey(envelopeId), document);
  await store.putEnvelope(envelope);
  for (const l of links) {
    await store.indexToken(tokenLookupKey(l.token), { envelopeId, signerId: l.signerId });
  }

  // Emails go to everyone now. A signer who opens early is told whose turn it
  // is, by name.
  const sent = [];
  for (const l of links) {
    const signer = signers.find((s) => s.signerId === l.signerId);
    const url = `${baseUrl}/s/${l.token}`;
    try {
      await mailer.sendInvitation({
        to: l.email,
        signerName: signer.name,
        fileName: body.fileName,
        message: body.message || '',
        url,
      });
      /* `ok` means the mailer accepted it - and `delivered` says whether that
         amounts to a real send. The console driver "succeeds" by printing, so
         without this a caller cannot tell a delivered invitation from one that
         only ever reached a log file. */
      sent.push({ email: l.email, ok: true, delivered: mailer.delivers !== false });
    } catch (e) {
      // Never swallow a failure silently: report which invitations did not go
      // out, so the sender can act. The envelope itself is already valid.
      sent.push({ email: l.email, ok: false, delivered: false, error: e.message });
    }
  }

  const undelivered = sent.filter((s) => !s.delivered).length;

  return {
    status: 201,
    body: {
      ok: true,
      envelopeId,
      /* Say it at the top level too. A caller checking only `ok` would
         otherwise file this away as done while nobody was ever told. */
      ...(undelivered ? {
        warning: `${undelivered} invitation(s) were NOT delivered - the mail driver `
               + `is "${mailer.driver}", which does not send. Share the links below directly.`,
      } : {}),
      signers: links.map((l) => ({
        order: l.order,
        email: l.email,
        url: `${baseUrl}/s/${l.token}`,
      })),
      invitations: sent,
    },
  };
}
