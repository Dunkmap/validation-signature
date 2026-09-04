/* Serves the signing page, and proxies the API beneath it.

     npm start

   One origin for both. That keeps a single public URL working through a tunnel
   (ngrok) or a CDN, and means the browser makes same-origin requests - no CORS
   to configure, and no chance of a mismatched allowlist locking signers out.
   It is also how this is deployed: CloudFront in front of both. */

import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

// Where the API actually runs. Never sent to the browser: the page talks to
// this server, which forwards.
const API_UPSTREAM = process.env.ESIGN_API_URL || 'http://127.0.0.1:4000';

// The API's public path on THIS origin.
const API_PREFIX = '/api';

const app = express();
app.disable('x-powered-by');

/* Trust the proxy when running behind a tunnel, so the client IP recorded on a
   signature is the signer's rather than the tunnel's. Only enable it when
   something trustworthy really is in front - otherwise anyone can spoof
   X-Forwarded-For. */
if (process.env.ESIGN_TRUST_PROXY === 'true') app.set('trust proxy', 1);

/* A content policy that matches what this page does.

   Everything is self-hosted - PDF.js and pdf-lib are vendored, not pulled from
   a CDN - so 'self' covers it, with two exceptions the libraries need:
     - blob: for the PDF.js worker
     - data: for canvas-rendered signature images */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "blob:"],
      workerSrc: ["'self'", "blob:"],
      styleSrc: ["'self'", "'unsafe-inline'"],   // the signature box is positioned inline
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],                    // same origin: the proxy below
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],                // never framed: clickjacking a signature
      baseUri: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,
  // A tunnel terminates TLS itself; let it set its own HSTS policy.
  hsts: process.env.ESIGN_BEHIND_TUNNEL === 'true' ? false : undefined,
}));

/* Forward the API. Mounted before the static handler and before any body
   parser - the proxy must stream the original request, and a consumed body
   would hang a POST. */
app.use(API_PREFIX, createProxyMiddleware({
  target: API_UPSTREAM,
  changeOrigin: true,
  xfwd: true,                                  // preserve the caller's IP
  pathFilter: () => true,
  pathRewrite: { [`^${API_PREFIX}`]: '' },
  proxyTimeout: 60_000,
  timeout: 60_000,
  on: {
    error(err, req, res) {
      // Never swallow it: say the API is unreachable rather than hanging.
      console.error('[proxy]', err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({
        ok: false,
        error: 'The signing service is unavailable. Please try again shortly.',
      }));
    },
  },
}));

app.use(compression());

/* Tell the page where the API lives - a path on this origin, not a host.
   Injected at runtime so the same files serve local, tunnel and production. */
app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.setHeader('Cache-Control', 'no-store');
  res.send(`window.ESIGN_API_BASE = ${JSON.stringify(API_PREFIX)};\n`);
});

/* A signing page must never be cached: the document changes as each signer
   adds their signature, and a stale copy would show the wrong version. */
app.use(express.static(HERE, {
  index: false,
  setHeaders(res, path) {
    if (path.includes('vendor')) {
      res.setHeader('Cache-Control', 'public, max-age=86400'); // version-pinned
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }
  },
}));

/* /s/<token> is the signer's URL. Serve the app there - but ONLY at that exact
   path. Rewriting nested requests too would return HTML for a .js file, which
   surfaces as a baffling "Unexpected token '<'" instead of a 404. */
app.get(/^\/s\/[^/]*$/, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(join(HERE, 'index.html'));
});

/* There is no home page: every signer arrives on their own link. Say that,
   rather than serving the app with no token and letting it report an error
   that reads like a fault. */
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(join(HERE, 'landing.html'));
});

app.use((req, res) => res.status(404).type('text/plain').send('Not found'));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\nSigning page  http://127.0.0.1:${PORT}`);
  console.log(`  API proxy   ${API_PREFIX}  ->  ${API_UPSTREAM}`);
  console.log(`  open a signing link: /s/<token>\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
