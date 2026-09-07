import { createEnvelope } from './handlers/envelopes.js';
import {
  getSigningPayload, submitSignature, getStatus, downloadDocument,
} from './handlers/sign.js';
import { requestOtp, verifyOtp } from './handlers/otp.js';
import { timingSafeEqual, createHash } from 'node:crypto';

/* Rate limit GET /sign/{token} - it is the one endpoint an attacker can
   hammer. Keyed by IP, fixed window, in memory.

   In Lambda this is per-instance, which blunts a distributed attempt rather
   than stopping it; put API Gateway throttling or WAF in front for the real
   ceiling. Being per-instance is a reason to add that layer, not a reason to
   leave the endpoint unguarded. */
export function createRateLimiter({ limit = 30, windowMs = 60_000 } = {}) {
  const hits = new Map();
  return function allow(key, now = Date.now()) {
    const bucket = hits.get(key);
    if (!bucket || now - bucket.start >= windowMs) {
      hits.set(key, { start: now, count: 1 });
      return true;
    }
    bucket.count += 1;
    if (hits.size > 10_000) {
      // Bound the map: drop windows that have already elapsed.
      for (const [k, v] of hits) if (now - v.start >= windowMs) hits.delete(k);
    }
    return bucket.count <= limit;
  };
}

/* Salesforce -> AWS calls authenticate with a shared secret, compared in
   constant time. */
function authorised(headers, secret) {
  if (!secret) return false;
  const given = headers['x-esign-secret'] || headers['X-Esign-Secret'] || '';
  const a = createHash('sha256').update(String(given)).digest();
  const b = createHash('sha256').update(String(secret)).digest();
  return timingSafeEqual(a, b);
}

export function createRouter({
  store, mailer, config, onComplete, allow = createRateLimiter(), signingCertificate = null,
}) {
  /* The session secret travels in a header, never the URL - a query string
     lands in access logs, history and Referer headers. Header names arrive
     lower-cased from API Gateway but not from every caller, so accept both. */
  const sessionOf = (headers) => headers['x-esign-session'] || headers['X-Esign-Session'] || null;

  return async function route({ method, path, headers = {}, body, clientIp }) {
    // POST /envelopes
    if (method === 'POST' && path === '/envelopes') {
      if (!authorised(headers, config.sharedSecret)) {
        return { status: 401, body: { ok: false, error: 'Unauthorised.' } };
      }
      return createEnvelope({
        body, store, mailer, baseUrl: config.baseUrl,
      });
    }

    /* OTP endpoints. This router is the serverless path, and it must enforce
       exactly what the Express app does - a gate present on one path and
       missing on the other is no gate at all. */
    const otp = path.match(/^\/otp\/([^/]+)\/(request|verify)$/);
    if (otp && method === 'POST') {
      const [, token, action] = otp;
      if (!allow(clientIp || 'unknown')) {
        return {
          status: 429,
          body: { ok: false, reason: 'RATE_LIMITED',
                  error: 'Too many verification attempts. Please wait a few minutes and try again.' },
        };
      }
      return action === 'request'
        ? requestOtp({ token, store, mailer })
        : verifyOtp({ token, body, store, clientIp });
    }

    const sign = path.match(/^\/sign\/([^/]+)$/);
    if (sign) {
      const token = sign[1];

      if (method === 'GET') {
        if (!allow(clientIp || 'unknown')) {
          return {
            status: 429,
            body: { ok: false, reason: 'RATE_LIMITED',
                    error: 'Too many requests. Please wait a moment and try again.' },
          };
        }
        return getSigningPayload({ token, store, clientIp, sessionSecret: sessionOf(headers) });
      }

      if (method === 'POST') {
        return submitSignature({
          token, body, store, clientIp, onComplete,
          requestNumber: config.requestNumber,
          sessionSecret: sessionOf(headers), signingCertificate,
        });
      }
    }

    const status = path.match(/^\/status\/([^/]+)$/);
    if (status && method === 'GET') {
      return getStatus({ token: status[1], store });
    }

    const dl = path.match(/^\/download\/([^/]+)$/);
    if (dl && method === 'GET') {
      return downloadDocument({ token: dl[1], store });
    }

    return { status: 404, body: { ok: false, error: 'Not found.' } };
  };
}
