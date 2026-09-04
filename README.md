# E-Sign

A standalone e-signature service. A sender's system pushes a PDF with signature
boxes and an ordered signer list; each signer opens a link, sees the document
with every earlier signature already on it, and signs in turn.

```
backend/    the API            :4000
frontend/   the signing page   :3000
```

Two servers, two origins — the same shape as production, where CloudFront
serves the page and API Gateway serves the API.

## Run it

```
cp .env.example .env    # then paste your SMTP keys into it
npm install             # installs both workspaces
npm start               # runs the API and the page together
npm test                # 99 tests
```

`.env` is read automatically at startup and is gitignored — credentials never
enter the repository. `.env.example` is the checked-in template listing every
variable. With no `.env` the defaults apply, which means the console mail
driver: codes are printed to the terminal and nothing is delivered.

Then create an envelope from a PDF of your own:

```
npm run seed -- --file ./contract.pdf \
  --signer "A Person <a@example.com>:Approver:1,62,193,160,44" \
  --signer "B Person <b@example.com>:Finance:1,300,193,160,44"
```

No PDF to hand? `npm run make-pdf` writes one with ruled signature lines and
prints the box coordinates for each.

Or separately:

```
npm run start:api   # :4000
npm run start:web   # :3000
```

Open the printed links in order. The second says it is not your turn yet and
names who it is waiting for — that is the ordered flow working.

## Sharing it publicly (ngrok)

```
powershell -File scripts/tunnel.ps1
```

One tunnel, pointed at the frontend — which proxies `/api` to the backend, so
both reach the outside world through a single URL. That is also why the page
makes same-origin requests and needs no CORS configuration.

The script refuses to start while `ESIGN_SECRET` is unset or still the
development default: a public URL with a known secret lets anyone create
envelopes and send mail in your name.

```powershell
$env:ESIGN_SECRET = -join ((1..48) | ForEach-Object { "{0:x}" -f (Get-Random -Max 16) })
```

Then restart the API with `ESIGN_FRONTEND_URL` set to the tunnel URL, so
signing links point somewhere a recipient can actually open.

**ngrok's free tier shows an interstitial** the first time a visitor opens the
link — they click "Visit Site" once. The page's own API calls send
`ngrok-skip-browser-warning`, so `fetch` is unaffected; a paid plan or a custom
domain removes the page entirely.

A tunnel is for demonstrating and testing with real people on real devices. It
is not a deployment: storage is still in memory, so every restart discards
every envelope.

## The flow

1. The sender's system `POST`s an envelope: the PDF, a box per signer, the
   order. It gets back one link per signer.
2. Every signer is emailed at once. Order is enforced when the page opens, not
   by withholding the email.
3. A signer opens their link and sees the document **with every earlier
   signature already on it**, and their own box marked.
4. They sign — draw or type — tick consent, submit. The browser stamps the
   signature with pdf-lib, appends a certificate page, and posts the bytes.
5. The server hashes what it received, stores it, and serves that version to
   the next signer.
6. On completion the finished PDF is available to every signer.

## Sending an envelope

```
POST http://127.0.0.1:4000/envelopes
X-Esign-Secret: local-dev-secret
```

```jsonc
{
  "externalId": "a03bm00001np9fh",     // your record id, echoed back on completion
  "fileName": "Contract.pdf",
  "documentBase64": "JVBERi0xLjQ...",
  "message": "Please sign before Friday.",
  "expiresAt": "2026-09-10T12:00:00Z",
  "signers": [
    { "order": 1, "name": "A Person", "email": "a@example.com",
      "role": "Head of Department",
      "box": { "page": 1, "x": 90, "y": 475, "w": 160, "h": 44 } }
  ]
}
```

**Box coordinates are PDF points with the origin bottom-left** — pass them
through unchanged from wherever they were placed. A box that appears mirrored
down the page is this, every time.

The response returns a signing URL per signer, and the invitations go out.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ESIGN_SECRET` | `local-dev-secret` | Shared secret for `POST /envelopes`. **Required** when `NODE_ENV=production` |
| `ESIGN_FRONTEND_URL` | `http://127.0.0.1:3000` | Where signing links point, and the CORS origin |
| `ESIGN_ALLOWED_ORIGINS` | the frontend URL | Comma-separated CORS allowlist |
| `ESIGN_API_URL` | `http://127.0.0.1:4000` | Told to the page at runtime via `/config.js` |
| `ESIGN_STORE` | `memory` | `disk` to survive a restart |
| `ESIGN_DATA_DIR` | `./data` | Where `disk` keeps envelopes and PDFs |
| `ESIGN_MAIL` | `console` | `smtp` to actually send |
| `ESIGN_SMTP_HOST` / `_PORT` / `_USER` / `_PASS` | — | Required when `ESIGN_MAIL=smtp` |
| `ESIGN_MAIL_FROM` | — | The sender address |
| `ESIGN_TRUST_PROXY` | `false` | Set `true` only behind a proxy you control |
| `ESIGN_OTP_RATE_WINDOW_MS` | `900000` | Window for the per-IP OTP limit |
| `ESIGN_OTP_RATE_MAX` | `20` | OTP requests per IP per window |

### Storage

`memory` is the default and is discarded on restart — fine for tests, wrong the
moment a real person is holding a signing link. Use `ESIGN_STORE=disk` for
anything else.

### Email

**The default `console` driver sends nothing.** It prints each message and says
so, on every message and in the API response:

```jsonc
{ "ok": true,
  "warning": "2 invitation(s) were NOT delivered - the mail driver is \"console\"...",
  "invitations": [ { "email": "a@example.com", "ok": true, "delivered": false } ] }
```

Check `delivered`, not `ok` — `ok` only means the mailer did not throw.

To send for real, point it at any SMTP server:

```
ESIGN_MAIL=smtp
ESIGN_SMTP_HOST=smtp.gmail.com
ESIGN_SMTP_PORT=587
ESIGN_SMTP_USER=you@example.com
ESIGN_SMTP_PASS=<app password>
ESIGN_MAIL_FROM="E-Sign <you@example.com>"
```

Mailjet, as an example of a hosted provider:

```
ESIGN_MAIL=smtp
ESIGN_SMTP_HOST=in-v3.mailjet.com
ESIGN_SMTP_PORT=587
ESIGN_SMTP_USER=<Mailjet API Key>
ESIGN_SMTP_PASS=<Mailjet Secret Key>
ESIGN_MAIL_FROM="E-Sign <you@yourdomain.com>"
```

Two Mailjet specifics worth knowing, because neither fails in an obvious way:

- `USER` and `PASS` are the **API Key and Secret Key** (Account Settings → API
  Key Management), not the Mailjet account's own login and password.
- `ESIGN_MAIL_FROM` must be a sender Mailjet has **verified** (Senders &
  Domains). Mailjet accepts the connection but refuses the message otherwise,
  which reads as "the credentials work but nothing arrives".

The connection is verified at startup, so a bad password stops the server then
rather than silently failing when a real signer was due to be invited.

Startup only proves the server accepts the *credentials*. A rejected sender
address shows up on the first real send, so send yourself one envelope before
handing a link to a client.

## Security

- **Tokens** — 64 hex characters from a CSPRNG, stored hashed, compared in
  constant time. A leaked database yields no working links.
- **Every refusal is identical**, so a stranger probing tokens learns nothing
  about which exist. The one exception is deliberate: "not your turn" names who
  is being waited on, and whoever holds that token already knew they were a
  signer.
- **Email verification (OTP)** — a signing link is a bearer token, so on its
  own a forwarded email would hand over the ability to sign. Before the
  document is served, the signer must enter a 6-digit code sent to the address
  **on the envelope** — never one supplied in the request, which would let a
  caller redirect the code to themselves. Codes are stored salted-and-hashed,
  compared in constant time, single-use, expire in 10 minutes, and are capped
  at 5 attempts and 5 sends per link. A verified session lasts 30 minutes, is
  bound to the token it was issued for, and travels in a header rather than the
  URL — a query string would land in access logs and `Referer` headers.

  Note the real limit: this proves control of the **mailbox**, not the identity
  of the reader. Someone who forwards both the link and the code, or a shared
  `accounts@` inbox, still gets through. It closes casual forwarding, not a
  determined insider.
- **CORS is an allowlist**, never a reflected origin.
- **Uploads are PDFs by magic bytes**, not by extension, capped at 4 MB.
- **Expiry fails closed** — missing or unparseable means expired.
- **Hashes are computed server-side** from the bytes actually stored. One a
  client sends is ignored.
- **The page cannot be framed**, so a signature cannot be clickjacked.
- **Nothing fails silently.** A failed invitation, write-back or completion
  email is surfaced, never swallowed.

## Not wired up

- **Real email.** Set `ESIGN_MAIL=smtp` with the `ESIGN_SMTP_*` variables; until then the console driver prints and delivers nothing.
- **Salesforce write-back.** The code and field mapping are complete and tested
  against a fake, but no org is connected — so completed documents stay in
  storage rather than being filed and deleted. Retention is currently yours to
  decide.
- **The sender-side UI** that uploads a PDF and places the boxes. Whatever
  builds the envelope above can be a Salesforce page, a script, or anything
  else that can POST JSON.
