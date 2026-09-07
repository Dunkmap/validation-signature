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

## Regenerating the self-signed certificate

The one in `certs/` expires in 10 years. To make another (Git Bash):

```
MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 \
  -keyout key.pem -out cert.pem -days 3650 -nodes \
  -subj "/CN=Exceller Technologies/O=Exceller Technologies/C=IN"
MSYS_NO_PATHCONV=1 openssl pkcs12 -export -out certs/signing.pfx \
  -inkey key.pem -in cert.pem -passout pass:changeme
rm -f key.pem cert.pem
```

`MSYS_NO_PATHCONV=1` stops Git Bash rewriting the `-subj` argument as a Windows
path.

**`certs/` is gitignored.** A private key committed to git history stays
recoverable even after the file is deleted.

---

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
