# Signing page

The signer-facing page. Static HTML/JS: no build step, no framework, no backend required to run it.

It talks to the API through one file ([js/api.js](js/api.js)) and ships with a
mock of that API so the whole flow can be exercised before the backend exists.

## Run it

```
python serve.py
```

Then open one of the printed URLs. A server is needed rather than opening the
file directly: `crypto.subtle` and geolocation only work on a secure origin, and
`127.0.0.1` counts as one.

### Scenarios

| URL | What it shows |
|---|---|
| `index.html?mock=1&scenario=turn` | Your turn, one earlier signature already on the document |
| `index.html?mock=1&scenario=first` | Signer 1 of 3, nothing signed yet |
| `index.html?mock=1&scenario=last` | Final signer — submitting completes the envelope |
| `index.html?mock=1&scenario=notyour` | Not your turn; names who is being waited on |
| `index.html?mock=1&scenario=refused` | Expired or already used |

## Checks

| Page | Covers |
|---|---|
| `test.html` | The coordinate flip, restricted `locationStatus` values, font-stack resolution, stamping, hash wrapping |
| `cert-check.html` | Extracts the certificate page's text and asserts every required section, including the hash chain |

Both run in the browser; open them and read the summary at the top.

## Files

| File | Role |
|---|---|
| [js/api.js](js/api.js) | The only file that knows the transport. Swap the mock for the real API here |
| [js/app.js](js/app.js) | Screen flow, submit, polling |
| [js/viewer.js](js/viewer.js) | PDF.js rendering and the **coordinate flip** |
| [js/stamp.js](js/stamp.js) | pdf-lib stamping and the certificate page |
| [js/signature-maker.js](js/signature-maker.js) | The type/draw modal |
| [js/client-context.js](js/client-context.js) | Browser facts and geolocation |
| [mock/mock-api.js](mock/mock-api.js) | Stand-in server, active only with `?mock=1` |

PDF.js and pdf-lib are vendored in `vendor/` rather than loaded from a CDN, so
the signing page has no third-party dependency at the moment someone signs.

## Wiring it to the real API

1. Serve the page so `/s/<token>` reaches `index.html` (see `do_GET` in
   [serve.py](serve.py) for the rewrite CloudFront needs to do).
2. Set the API origin before the module loads:
   ```html
   <script>window.ESIGN_API_BASE = 'https://api.yourdomain.com';</script>
   ```
3. Drop `?mock=1`. Nothing else changes — the mock and the real API return the
   same shapes.

The page expects the contract exactly as the spec defines it: `GET /sign/{token}`,
`POST /sign/{token}`, `GET /status/{token}`, `GET /download/{token}`.

## Things worth not breaking

These are the spec's rules, and where they live in the code.

- **The coordinate trap.** A PDF measures y upward from the bottom, a browser
  downward from the top. The flip is `boxToCssPercent` in
  [js/viewer.js](js/viewer.js), and it is the first thing to check if a box looks
  misplaced. Note that no flip happens in [js/stamp.js](js/stamp.js) — pdf-lib
  already draws in PDF space.
- **Hashes are computed server-side.** The page never asserts a hash; it displays
  the one the server returns from the bytes it stored. Each signer's hash differs,
  because each signs a document carrying one fewer signature.
- **`locationStatus` is a closed set** — `Granted`, `Denied`, `Unavailable`,
  `Not requested`. Salesforce rejects anything else on write-back and fails the
  whole record, after the signature has already been taken.
- **The four typed faces must resolve to four real fonts.** They are set as a DOM
  property, not an inline `style` attribute — the family names contain double
  quotes, which close the attribute early and silently collapse all four to one
  font. `test.html` measures rendered width to catch a regression, because
  comparing the declared strings cannot see this.
- **Minimum ink travel** (~24px) before a drawing is accepted, or a stray click
  registers as a signature.
- **"This session" is shown before signing**, not after. What is about to be
  recorded about someone is worth seeing while declining is still an option.
- **Failures are surfaced, never swallowed.** A stalled PDF.js worker times out
  with a message rather than hanging on "Loading…" forever, and a failed submit
  says plainly that the signature was not recorded.

## Not included

The Salesforce write-back —
steps 1 and 3–6 of the spec's build order. The mock implements just enough of
the API's behaviour to exercise this page.
