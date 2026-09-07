/* The API server. Runs on its own port, separate from the frontend.

     npm run start:api
*/
import { createApp } from './app.js';
import { createStore } from './lib/store.js';
import { createMailer } from './lib/mailer.js';
import { loadSigningCertificate, isSigningEnabled } from './lib/digital-signature.js';

const PORT = Number(process.env.PORT || 4000);
const FRONTEND = process.env.ESIGN_FRONTEND_URL || 'http://127.0.0.1:3000';

/* The shared secret must be set explicitly in production. Falling back to a
   known default on a public deployment would leave /envelopes open to anyone. */
const SECRET = process.env.ESIGN_SECRET
  || (process.env.NODE_ENV === 'production' ? null : 'local-dev-secret');

if (!SECRET) {
  console.error('ESIGN_SECRET must be set when NODE_ENV=production.');
  process.exit(1);
}

const store = createStore();
const mailer = createMailer();

/* Load the signing certificate at startup, so a missing file or a wrong
   passphrase is a line in this console rather than a signer who has finished
   signing and cannot be given their document. Off unless ESIGN_PDF_SIGN=true. */
let signingCertificate = null;
try {
  signingCertificate = await loadSigningCertificate();
} catch (e) {
  console.error(`
  PDF signing is enabled but could not start: ${e.message}
`);
  process.exit(1);
}

const app = createApp({
  store,
  mailer,
  signingCertificate,
  config: {
    sharedSecret: SECRET,
    // Links in emails point at the frontend, which is where a signer opens
    // the page - not at this API.
    signingBaseUrl: FRONTEND,
    allowedOrigins: (process.env.ESIGN_ALLOWED_ORIGINS || FRONTEND)
      .split(',').map((s) => s.trim()).filter(Boolean),
    requestNumber: process.env.ESIGN_REQUEST_NUMBER || 'REQ-000031',
    trustProxy: process.env.ESIGN_TRUST_PROXY === 'true',
    rateLimit: {
      windowMs: Number(process.env.ESIGN_RATE_WINDOW_MS || 60_000),
      max: Number(process.env.ESIGN_RATE_MAX || 30),
    },
    /* Tighter than the signing limit. A 6-digit code is only 10^6 values
       wide, so an unthrottled verify endpoint is brute-forceable even with
       the per-code attempt cap - that cap is per code, and fresh ones can be
       requested. */
    otpRateLimit: {
      windowMs: Number(process.env.ESIGN_OTP_RATE_WINDOW_MS || 15 * 60_000),
      max: Number(process.env.ESIGN_OTP_RATE_MAX || 20),
    },
  },
  onComplete: async (envelope) => {
    /* No Salesforce org is wired up here. Say so plainly rather than letting a
       silent no-op look like a successful write-back. */
    console.log(`[complete] envelope ${envelope.envelopeId} finished.`);
    console.log('[complete] Salesforce write-back is not configured, so nothing was '
              + 'written and NOTHING WAS DELETED.');
  },
});

/* Prove the mail server accepts us at startup. A bad password found here is a
   line in the console; found later, it is a signer who was never invited. */
if (mailer.verify) {
  try {
    await mailer.verify();
    console.log('\n  mail       SMTP connection verified');
  } catch (e) {
    console.error(`\n  Mail is configured as SMTP but the server refused us: ${e.message}`);
    console.error('  Fix the credentials, or unset ESIGN_MAIL to fall back to console.\n');
    process.exit(1);
  }
}

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`\nAPI          http://127.0.0.1:${PORT}`);
  console.log(`  storage    ${store.driver}${store.root ? ` (${store.root})` : ''}`);
  console.log(`  email      ${mailer.driver}`);
  /* Say plainly whether documents are being cryptographically signed, and with
     what. "self-signed" is not a warning to hide: it is exactly why Adobe will
     show a yellow triangle, and someone reading this console should know that
     before a client asks about it. */
  console.log(`  pdf sign   ${signingCertificate
    ? `on (${signingCertificate.path})`
    : 'off (set ESIGN_PDF_SIGN=true to enable)'}`);
  if (mailer.delivers === false) {
    // Never let this be a surprise discovered from an empty inbox.
    console.log('             ^ prints only - NOTHING IS DELIVERED');
    console.log('               set ESIGN_MAIL=smtp + ESIGN_SMTP_* to send for real');
  }
  if (store.driver === 'memory') {
    console.log('  note       in memory - a restart discards every envelope');
  }
  console.log(`  CORS       ${FRONTEND}`);
  console.log(`  health     http://127.0.0.1:${PORT}/health\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
