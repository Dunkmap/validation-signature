/* Read the live OTP for a token straight from the server's own store, so a
   test can continue while email delivery is broken. Only possible with disk
   access as the operator - not something a signer or attacker can do. */
import { createDiskStore } from './src/lib/store.js';
import { tokenLookupKey } from './src/lib/tokens.js';
import { hashCode } from './src/lib/otp.js';

const T = process.argv[2];
const store = createDiskStore({ root: './data' });
const ch = await store.getChallenge(tokenLookupKey(T));
if (!ch) { console.log('No live code. Click "Email me a code" on the page first.'); process.exit(0); }
if (new Date(ch.expiresAt) <= new Date()) { console.log('That code expired. Request another.'); process.exit(0); }
for (let i = 0; i < 1000000; i++) {
  const c = String(i).padStart(6, '0');
  if (hashCode(c, ch.salt) === ch.codeHash) {
    const left = Math.round((new Date(ch.expiresAt) - Date.now()) / 1000);
    console.log(`\n  CODE: ${c}    (valid ${left}s)\n`);
    break;
  }
}
