# Cryptographic PDF signing

Adds a real PDF digital signature to the finished document, so Adobe shows a
**Signature Panel** entry and reports that the document has not been modified
since signing.

**It is OFF by default.** Nothing changes until `ESIGN_PDF_SIGN=true` is set.

---

## Turning it on

```
ESIGN_PDF_SIGN=true
ESIGN_PDF_CERT=./certs/signing.pfx
ESIGN_PDF_CERT_PASSWORD=changeme
ESIGN_PDF_REASON=Electronically signed via the e-signature service
ESIGN_PDF_LOCATION=India
```

Restart the API. The startup banner reports the state:

```
  pdf sign   on (./certs/signing.pfx)
  pdf sign   off (set ESIGN_PDF_SIGN=true to enable)
```

## Turning it off — the revert

**Set `ESIGN_PDF_SIGN=false` (or delete the line) and restart.** That is the
whole revert. Documents are then produced exactly as before.

Nothing else needs undoing: no data migration, no format change. Documents
signed while it was on stay valid and readable; the signature is simply not
added to new ones.

To remove the code as well, see *Removing it entirely* at the end.

---

## What you get, and what you do not

With the **self-signed** certificate currently in `certs/signing.pfx`:

| | |
|---|---|
| Signature Panel entry | ✅ |
| "Document has not been modified since signed" | ✅ |
| Tamper detection | ✅ verified — flipping one byte breaks it |
| Signer identity verified | ❌ **yellow warning triangle** |
| Green "all signatures are valid" banner | ❌ |

Adobe shows **"Signer's identity is unknown"** because it trusts an identity
only when the issuing authority is in its Approved Trust List (AATL). A
certificate we generated ourselves never will be.

**This is not a fault in the code.** The cryptography is identical either way.
Buying a certificate from a listed CA turns the same code green — only the
`.pfx` file changes.

### Getting the green tick

Replace the `.pfx` with one from an AATL certificate authority and update
`ESIGN_PDF_CERT` / `ESIGN_PDF_CERT_PASSWORD`. No code changes.

- **International, no hardware**: Sectigo, Certum, DigiCert, GlobalSign —
  document signing certificates, roughly $60–500/year depending on tier.
- **Indian (CCA-licensed, more legal weight under the IT Act)**: eMudhra, Sify,
  Capricorn. Ask specifically for **organisation document signing, HSM-hosted,
  no USB token** — the default Class 3 product ships on a USB token, which does
  not suit a server that signs automatically.

A **trusted timestamp** (TSA) is a separate addition. Without one Adobe also
notes that the signing time comes from the signing computer's clock.

---

## Files changed

| File | Change | To revert manually |
|---|---|---|
| `src/lib/digital-signature.js` | **New.** All signing logic. | Delete |
| `test/digital-signature.test.js` | **New.** 10 tests. | Delete |
| `src/handlers/sign.js` | Import; `signingCertificate` parameter; signs inside `rebuildMerged`. | Remove the `signPdf` call, return `merged` |
| `src/app.js` | Accepts and forwards `signingCertificate`. | Remove the parameter |
| `src/router.js` | Accepts and forwards `signingCertificate`. | Remove the parameter |
| `src/server.js` | Loads the certificate at startup; banner line. | Remove both blocks |
| `package.json` | `@signpdf/signpdf`, `@signpdf/signer-p12`, `node-forge`. | `npm uninstall` all three |
| `certs/signing.pfx` | **New.** Self-signed certificate. | Delete |
| `.gitignore` | Ignores `certs/`. | — |

Because the certificate is only loaded when the flag is on, and is `null`
otherwise, **every one of these paths is inert while the flag is off** — the
document is returned byte-for-byte unchanged. There is a test for exactly that.

---

## Where it happens

Signing is the **last** step of `rebuildMerged()` in `src/handlers/sign.js`,
after every signature has been merged:

```
original  →  merge each signer's stamp  →  certificate pages  →  SIGN  →  store
```

**Order matters.** A PDF signature covers the exact bytes it was applied to, so
signing before the merge would be invalidated by the next signature landing —
Adobe would then report the document as modified, which is worse than not
signing at all. The merged document is therefore rebuilt and re-signed after
each signature.

---

## Creating (or regenerating) the self-signed certificate

`certs/` is **not** in the repository — it is gitignored, because a private key
committed to git history stays recoverable even after the file is deleted. So a
fresh clone has no certificate, and `ESIGN_PDF_SIGN=true` refuses to start until
you make one. This is how the current one was made.

**Run it from `backend/`, not the repository root.** `ESIGN_PDF_CERT` is
resolved against the API's working directory, and the API starts in `backend/`
(that is why its own start script reads `../.env`). A certificate written to
the root `certs/` is a file the server will never find.

### What openssl is

OpenSSL is the standard command-line tool for cryptography — generating keys,
creating certificates, packaging them. Nothing to install: it ships with **Git
for Windows**, so it is already on PATH in Git Bash (`openssl version` here
reports 3.5.6). Two commands are used below — one to generate the RSA key and
self-signed certificate, one to package both into the `.pfx` the signing code
loads.

```bash
cd backend
mkdir -p certs

MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 \
  -keyout key.pem -out cert.pem -days 3650 -nodes \
  -subj "/CN=Exceller Technologies/O=Exceller Technologies/C=IN"

MSYS_NO_PATHCONV=1 openssl pkcs12 -export -out certs/signing.pfx \
  -inkey key.pem -in cert.pem -passout pass:changeme

rm -f key.pem cert.pem
```

`MSYS_NO_PATHCONV=1` stops Git Bash rewriting the `-subj` argument as a Windows
path.

The final `rm` is not tidying. `-nodes` means `key.pem` is an **unencrypted**
private key; leaving it next to the `.pfx` defeats the passphrase entirely.
`.gitignore` already covers `*.pem`, so it was never at risk of being
committed — but it should not survive on disk either.

### No `-legacy` needed

OpenSSL 3 exports PKCS#12 with AES-256-CBC and a SHA-256 MAC rather than the
old 3DES/SHA-1 defaults, and older `node-forge` could not open that — the
usual symptom being a startup failure that blames
`ESIGN_PDF_CERT_PASSWORD` when the passphrase is in fact correct.

Verified not to be a problem here: **OpenSSL 3.5.6 → `node-forge` 1.4.0 opens
it as exported.** Do not add `-legacy`, `-keypbe PBE-SHA1-3DES` or
`-macalg sha1` unless a startup failure actually tells you to.

### Prove it before trusting it

The test suite generates its own throwaway certificate per run, so a passing
`npm test` says **nothing** about the file you just created. Load it through the
same code the server uses:

```bash
cd backend
node -e "
import('./src/lib/digital-signature.js').then(async (m) => {
  const c = await m.loadSigningCertificate({
    ESIGN_PDF_SIGN: 'true',
    ESIGN_PDF_CERT: './certs/signing.pfx',
    ESIGN_PDF_CERT_PASSWORD: 'changeme',
  });
  console.log('OK', c.p12.length, 'bytes');
}).catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
"
```

Then confirm the server agrees. The banner is unambiguous:

```
  pdf sign   on (./certs/signing.pfx)
```

### The certificate now in place

| | |
|---|---|
| Subject / Issuer | `CN=Exceller Technologies, O=Exceller Technologies, C=IN` (self-signed) |
| Key | RSA 2048 |
| Valid | 2026-09-07 → 2036-09-04 |
| SHA-256 fingerprint | `BE:A8:90:C6:43:12:35:52:0F:BB:C0:CB:E7:98:1A:4A:3F:F4:23:9D:BB:D0:57:60:FC:B9:37:62:92:EE:A3:67` |
| Passphrase | `changeme` — the checked-in default in `.env.example` |

The passphrase is deliberately the documented default so the flag works without
further setup. It protects a **self-signed development key that Adobe will not
trust anyway**; there is nothing here worth a secret. A purchased AATL
certificate is different — give that one a real passphrase and keep it out of
`.env.example`.

A signature made with this certificate was verified end to end: `/Type /Sig`
present, `/SubFilter /adbe.pkcs7.detached`, the CMS blob verifying against the
exact bytes its `/ByteRange` covers, and **failing** once a single byte inside
that range was flipped. Tamper detection is real, not assumed.

## A note on the dependencies

`@signpdf` ships a placeholder helper, `@signpdf/placeholder-plain`, which
pulls in `pdfkit` and through it a `crypto-js` version carrying **four critical
advisories**. It is not installed here: the document is already built with
`pdf-lib`, so the signature placeholder is written with `pdf-lib` too
(`addPlaceholder` in `digital-signature.js`). `npm audit` reports zero
vulnerabilities.

---

## Removing it entirely

If you want the code gone rather than switched off:

```
npm uninstall @signpdf/signpdf @signpdf/signer-p12 node-forge
rm src/lib/digital-signature.js test/digital-signature.test.js
rm -rf certs
```

Then remove the `signingCertificate` parameter from `sign.js`, `app.js`,
`router.js` and `server.js` — the table above lists each site. `npm test`
should report 100 passing afterwards (110 minus this feature's 10).
