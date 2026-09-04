# E-Sign API

The API behind the signing service: envelopes, ordering, hashing and storage.

Runs with no external services at all. Storage is a directory; email is any
SMTP server, or the console.

## Run it

```
npm install
npm start              # API alone, on http://127.0.0.1:4000
npm run make-pdf       # optional: a test PDF with ruled signature lines
npm run seed -- --file <pdf> --signer "Name <email>:Role:page,x,y,w,h"

```

The signing page runs separately, on :3000 — see [../frontend](../frontend).
From the repository root, `npm start` runs both.

Open the links in order. The second will tell you it is not your turn yet —
that is the ordered flow working.

```
npm test               # 66 tests
```

## How it is served

The API and the page are **separate origins**: the API on :4000, the page on
:3000. That mirrors production (API Gateway and CloudFront) and means the API
must state plainly which origin may call it, rather than trusting whatever
turns up.

| Layer | Package | What it does |
|---|---|---|
| Headers | `helmet` | `nosniff`, `X-Frame-Options`, HSTS; hides `X-Powered-By` |
| Cross-origin | `cors` | An **allowlist**, never a reflected origin |
| Flooding | `express-rate-limit` | 30/min on `GET /sign/:token`, 120/min elsewhere |
| Input | `zod` | Schemas at the edge; a bad request never reaches storage |

`src/app.js` holds all of it. The domain rules stay in `lib/` and `handlers/`,
which know nothing about Express — which is why swapping the transport did not
change a single one of the original 51 tests.

## Endpoints

| Endpoint | Who calls it | Auth |
|---|---|---|
| `POST /envelopes` | Salesforce | `x-esign-secret` header |
| `GET /sign/{token}` | The signer's page | the token |
| `POST /sign/{token}` | The signer's page | the token |
| `GET /status/{token}` | The signer's page, polling | the token |
| `GET /download/{token}` | Any signer, once complete | the token |

## Files

| File | Role |
|---|---|
| [src/router.js](src/router.js) | Routes, shared-secret auth, rate limiting |
| [src/handlers/envelopes.js](src/handlers/envelopes.js) | `POST /envelopes` — mint tokens, store, invite |
| [src/handlers/sign.js](src/handlers/sign.js) | The signer endpoints, and the turn check |
| [src/lib/envelope.js](src/lib/envelope.js) | Ordering, timeline, filename — pure functions |
| [src/lib/validation.js](src/lib/validation.js) | Magic bytes, size cap, restricted values, expiry |
| [src/lib/tokens.js](src/lib/tokens.js) | Token generation, hashing, constant-time compare |
| [src/lib/store.js](src/lib/store.js) | Envelopes and PDFs: on disk, or in memory |
| [src/lib/mailer.js](src/lib/mailer.js) | SMTP, or console (prints, sends nothing) |
| [src/lib/salesforce.js](src/lib/salesforce.js) | JWT auth, write-back, then deletion |
| [src/local-server.js](src/local-server.js) | Serves the API and the signing page together |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ESIGN_STORE` | `memory` | `disk` to survive a restart |
| `ESIGN_DATA_DIR` | `./data` | Where `disk` keeps its files |
| `ESIGN_MAIL` | `console` | `smtp` to actually send |
| `ESIGN_SECRET` | `local-dev-secret` | Shared secret Salesforce sends |
| `ESIGN_BASE_URL` | `http://127.0.0.1:3000` | Origin used to build signing links |
| `ESIGN_SMTP_HOST` / `_PORT` / `_USER` / `_PASS` | — | Required when `ESIGN_MAIL=smtp` |
| `ESIGN_MAIL_FROM` | — | The sender address |

Salesforce write-back needs `clientId`, `username`, and an RSA private key for
the JWT connected app — see `getAccessToken` in
[src/lib/salesforce.js](src/lib/salesforce.js). It is not wired to an org here;
`onComplete` in [src/local-server.js](src/local-server.js) logs instead, and
says plainly that nothing was written and nothing deleted.

## Rules the tests hold in place

Each of these is in the spec because it already went wrong once.

- **Ordering.** A signer out of turn is refused *by name*; everyone else gets a
  single identical refusal, so a stranger probing tokens learns nothing about
  which exist. The named exception is deliberate: that person already knows
  they are a signer.
- **Each signature has its own hash**, computed **server-side** from the bytes
  actually stored. A hash sent by the client is ignored. Signer 1 never saw
  signers 2 and 3, and their certificate says so.
- **The download is the stored bytes, never a re-render** — pdf-lib writes a
  fresh creation date on every save, so a rebuild would not match the hash the
  certificate attests to. Verified byte-identical across fetches.
- **Write-back, then deletion, never the reverse.** Any Salesforce failure
  aborts before a single stored document is removed. A deleted document with a failed
  write-back is unrecoverable.
- **`locationStatus` is a closed set** — `Granted`, `Denied`, `Unavailable`,
  `Not requested`. Rejected here rather than by Salesforce, which would fail
  the whole record *after* the signature was taken.
- **Expiry fails closed.** Missing or unparseable means expired, not valid
  forever.
- **Uploads are PDFs by magic bytes**, not by extension or content-type, and
  capped at 4 MB.
- **Tokens** are 64 hex characters from a CSPRNG, stored hashed, compared in
  constant time.
- **Nothing fails silently.** A failed invitation, a failed write-back, a
  failed completion email — each is reported, never swallowed.

## Verifying it end to end

```
powershell -File scripts/verify-flow.ps1
```

Seeds an envelope, signs it three times in a real headless browser, downloads
the finished PDF, and reads the certificate pages back out — checking each
signer's certificate lists exactly the signatures taken before theirs.

`node scripts/inspect-pdf.mjs <file.pdf>` does the inspection alone.

Note: a 64-character hash wraps across lines on the page, so extracted text
carries a space mid-hash. `inspect-pdf.mjs` rejoins hex runs before matching —
without that a perfectly good chain reads as empty.

## Deploying

The handlers are plain functions over `{ method, path, headers, body, clientIp }`
and the transport is a thin Express layer, so this runs anywhere Node runs.

- **Storage** — `ESIGN_STORE=disk` with `ESIGN_DATA_DIR` on a volume that
  persists. Swapping in a hosted database means adding one driver to
  [src/lib/store.js](src/lib/store.js); no handler knows where a document lives.
- **Email** — `ESIGN_MAIL=smtp` and the `ESIGN_SMTP_*` variables.
- **Secret** — `ESIGN_SECRET` is required when `NODE_ENV=production`; the server
  refuses to start without it rather than falling back to the dev default.
- **In front** — terminate TLS and add real throttling. The in-process rate
  limiter is per-instance, which blunts a distributed attempt rather than
  stopping it.
- Serve the page so `/s/<token>` returns `index.html`, but **only that exact
  path** — never nested asset requests, or a `.js` request returns HTML and
  surfaces as a baffling `Unexpected token '<'`.
