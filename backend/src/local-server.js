/* Runs the API and the signing page together on one origin, so the whole flow
   works locally with no AWS account: memory storage, console email.

   node src/local-server.js
*/
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryStore } from './lib/store.js';
import { createConsoleMailer } from './lib/mailer.js';
import { createRouter } from './router.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FRONTEND_ROOT = join(HERE, '..', '..', 'frontend');

const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.ESIGN_SECRET || 'local-dev-secret';
const BASE = process.env.ESIGN_BASE_URL || `http://127.0.0.1:${PORT}`;

const store = createMemoryStore();
const mailer = createConsoleMailer();

const router = createRouter({
  store,
  mailer,
  config: { sharedSecret: SECRET, baseUrl: BASE, requestNumber: 'REQ-000031' },
  // Locally there is no Salesforce to write back to. Say so plainly rather
  // than pretending the step succeeded.
  onComplete: async (envelope) => {
    console.log(`\n[complete] envelope ${envelope.envelopeId} finished.`);
    console.log('[complete] Salesforce write-back is not configured locally, '
              + 'so nothing was written and NOTHING WAS DELETED.');
    console.log(`[complete] the finished PDF is still downloadable via /download/{token}.\n`);
  },
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown; charset=utf-8',
};

const API_PREFIXES = ['/envelopes', '/sign/', '/status/', '/download/'];

function isApi(path) {
  return API_PREFIXES.some((p) => path === p || path.startsWith(p));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    // Reject oversize before buffering it all: a 4 MB document is ~5.5 MB of
    // base64, so allow headroom but not unlimited.
    if (size > 12 * 1024 * 1024) throw new Error('Request body too large.');
    chunks.push(c);
  }
  if (!chunks.length) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = decodeURIComponent(url.pathname);
  const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress?.replace(/^::ffff:/, '') || 'unknown';

  try {
    if (isApi(path)) {
      let body = null;
      if (req.method === 'POST') {
        try {
          body = await readBody(req);
        } catch (e) {
          return send(res, 400, { ok: false, error: e.message });
        }
      }

      const result = await router({
        method: req.method, path, headers: req.headers, body, clientIp,
      });

      if (result.isBinary) {
        res.writeHead(result.status, {
          'Content-Type': result.contentType,
          'Content-Disposition': `attachment; filename="${result.fileName}"`,
          'Content-Length': result.body.length,
        });
        return res.end(result.body);
      }
      return send(res, result.status, result.body);
    }

    /* The signing page. /s/<token> is the signer's URL; serve the app there.

       Only the token path itself maps to the app - never a nested asset
       request. Rewriting those too would return HTML for a .js file, which
       surfaces as a baffling "Unexpected token '<'" rather than a 404. */
    let filePath = path === '/' ? '/index.html' : path;
    if (/^\/s\/[^/]*$/.test(filePath)) filePath = '/index.html';

    const full = join(FRONTEND_ROOT, normalize(filePath).replace(/^(\.\.[/\\])+/, ''));
    if (!full.startsWith(FRONTEND_ROOT)) return send(res, 403, { error: 'Forbidden' });

    const data = await readFile(full);
    res.writeHead(200, {
      'Content-Type': MIME[extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch (e) {
    if (e.code === 'ENOENT') return send(res, 404, { error: 'Not found' });
    // Never swallow it: log the real error, return a safe one.
    console.error('[error]', e);
    send(res, 500, { ok: false, error: 'Internal error.' });
  }
});

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nE-sign API + signing page on ${BASE}`);
  console.log(`  driver:  memory (nothing persists across restarts)`);
  console.log(`  email:   console (printed below, never sent)`);
  console.log(`  secret:  ${SECRET}`);
  console.log(`\nCreate an envelope:`);
  console.log(`  node scripts/seed.js\n`);
});
