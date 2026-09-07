/* The Express application.

   Transport, security headers, CORS and rate limiting live here; the rules
   that matter stay in lib/ and handlers/, which know nothing about Express. */

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { timingSafeEqual, createHash } from 'node:crypto';

import { createEnvelope } from './handlers/envelopes.js';
import {
  getSigningPayload, submitSignature, getStatus, downloadDocument,
} from './handlers/sign.js';
import { requestOtp, verifyOtp } from './handlers/otp.js';
import { envelopeSchema, signSubmissionSchema, tokenSchema, otpVerifySchema, formatIssues }
  from './lib/schemas.js';

// A 4 MB document is ~5.5 MB of base64; allow headroom, not unlimited.
const MAX_BODY = '12mb';

export function createApp({ store, mailer, config, onComplete, signingCertificate = null }) {
  const app = express();

  /* Trust the proxy only when told to. Left on by default, anyone could spoof
     X-Forwarded-For and defeat the rate limiter - and the IP recorded on a
     signature would be whatever the client claimed. */
  app.set('trust proxy', config.trustProxy ?? false);
  app.disable('x-powered-by');

  /* Security headers. No CSP here: this app serves JSON only, and a policy
     written for an API would not describe the frontend that actually renders. */
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(compression());

  /* CORS against an explicit allowlist. A reflected origin would let any site
     call this API with a stolen token. */
  const allowed = new Set(config.allowedOrigins || []);
  app.use(cors({
    origin(origin, cb) {
      // No Origin header: a server-to-server call, curl, or a same-origin
      // request. Those are not what CORS defends against.
      if (!origin) return cb(null, true);
      if (allowed.has(origin)) return cb(null, true);
      cb(new Error(`Origin ${origin} is not allowed.`));
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'X-Esign-Secret', 'X-Esign-Session'],
    maxAge: 600,
  }));

  app.use(express.json({ limit: MAX_BODY }));

  /* GET /sign/:token is the one endpoint an attacker can hammer, so it carries
     the tightest limit. In a serverless deployment this is per-instance, which
     blunts a distributed attempt rather than stopping it - put WAF or API
     Gateway throttling in front for the real ceiling. */
  const signLimiter = rateLimit({
    windowMs: config.rateLimit?.windowMs ?? 60_000,
    limit: config.rateLimit?.max ?? 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: {
      ok: false, reason: 'RATE_LIMITED',
      error: 'Too many requests. Please wait a moment and try again.',
    },
  });

  /* The OTP endpoints get their own, tighter ceiling. A 6-digit code is only
     10^6 values wide, so an unthrottled verify endpoint is brute-forceable in
     minutes even with the per-code attempt cap - that cap is per code, and an
     attacker can request fresh ones. This limit is per IP, and sits underneath
     the per-token caps enforced in the handler. */
  const otpLimiter = rateLimit({
    windowMs: config.otpRateLimit?.windowMs ?? 15 * 60_000,
    limit: config.otpRateLimit?.max ?? 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: {
      ok: false, reason: 'RATE_LIMITED',
      error: 'Too many verification attempts. Please wait a few minutes and try again.',
    },
  });

  // A looser ceiling everywhere else, so one caller cannot exhaust the process.
  const generalLimiter = rateLimit({
    windowMs: 60_000, limit: 120,
    standardHeaders: 'draft-7', legacyHeaders: false,
    message: { ok: false, error: 'Too many requests.' },
  });
  app.use(generalLimiter);

  const clientIpOf = (req) => (req.ip || '').replace(/^::ffff:/, '') || 'unknown';

  /* Salesforce -> AWS calls carry a shared secret, compared in constant time so
     a wrong guess reveals nothing through timing. */
  function requireSecret(req, res, next) {
    const given = req.get('x-esign-secret') || '';
    const secret = config.sharedSecret || '';
    if (!secret) return res.status(500).json({ ok: false, error: 'Server is not configured.' });

    const a = createHash('sha256').update(given).digest();
    const b = createHash('sha256').update(secret).digest();
    if (!timingSafeEqual(a, b)) {
      return res.status(401).json({ ok: false, error: 'Unauthorised.' });
    }
    next();
  }

  /* Reject a malformed token before any lookup, with the same refusal an
     unknown one gets. A prober must not be able to tell them apart. */
  const REFUSAL = 'This signing link is not valid. It may have expired or already been used. '
                + 'Please ask the sender for a new one.';

  function requireToken(req, res, next) {
    const parsed = tokenSchema.safeParse(req.params.token);
    if (!parsed.success) {
      return res.status(200).json({ ok: false, reason: 'REFUSED', error: REFUSAL });
    }
    next();
  }

  const send = (res, result) => res.status(result.status).json(result.body);

  /* The verified-session secret travels in a header, not in the URL. A query
     string lands in access logs, browser history and Referer headers, which is
     exactly where a second factor must not be. */
  const sessionOf = (req) => req.get('x-esign-session') || null;

  // --- routes ---

  app.get('/health', (req, res) => {
    res.json({ ok: true, driver: store.driver, time: new Date().toISOString() });
  });

  app.post('/envelopes', requireSecret, async (req, res, next) => {
    try {
      const parsed = envelopeSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ ok: false, error: formatIssues(parsed.error) });
      }
      send(res, await createEnvelope({
        body: parsed.data, store, mailer, baseUrl: config.signingBaseUrl,
      }));
    } catch (e) { next(e); }
  });

  /* Ask for a code. The address is read from the envelope, never from the
     request - a client-supplied address would let anyone redirect the code. */
  app.post('/otp/:token/request', otpLimiter, requireToken, async (req, res, next) => {
    try {
      send(res, await requestOtp({ token: req.params.token, store, mailer }));
    } catch (e) { next(e); }
  });

  app.post('/otp/:token/verify', otpLimiter, requireToken, async (req, res, next) => {
    try {
      const parsed = otpVerifySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ ok: false, error: formatIssues(parsed.error) });
      }
      send(res, await verifyOtp({
        token: req.params.token, body: parsed.data, store, clientIp: clientIpOf(req),
      }));
    } catch (e) { next(e); }
  });

  app.get('/sign/:token', signLimiter, requireToken, async (req, res, next) => {
    try {
      send(res, await getSigningPayload({
        token: req.params.token, store, clientIp: clientIpOf(req),
        sessionSecret: sessionOf(req),
      }));
    } catch (e) { next(e); }
  });

  app.post('/sign/:token', requireToken, async (req, res, next) => {
    try {
      const parsed = signSubmissionSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ ok: false, error: formatIssues(parsed.error) });
      }
      send(res, await submitSignature({
        token: req.params.token, body: parsed.data, store,
        clientIp: clientIpOf(req), onComplete, requestNumber: config.requestNumber,
        sessionSecret: sessionOf(req), signingCertificate,
      }));
    } catch (e) { next(e); }
  });

  app.get('/status/:token', requireToken, async (req, res, next) => {
    try {
      send(res, await getStatus({ token: req.params.token, store }));
    } catch (e) { next(e); }
  });

  app.get('/download/:token', requireToken, async (req, res, next) => {
    try {
      const result = await downloadDocument({ token: req.params.token, store });
      if (!result.isBinary) return send(res, result);

      res.status(result.status);
      res.setHeader('Content-Type', result.contentType);
      // Quote-escape the filename: it comes from a document name, and an
      // unescaped quote would let it break out of the header.
      const safe = result.fileName.replace(/"/g, '');
      res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
      res.setHeader('Content-Length', result.body.length);
      res.end(result.body);
    } catch (e) { next(e); }
  });

  app.use((req, res) => res.status(404).json({ ok: false, error: 'Not found.' }));

  /* Log the real error, return a safe one. Never let a stack trace or an
     internal path reach a signer - and never swallow it either. */
  app.use((err, req, res, _next) => {
    if (/Origin .* is not allowed/.test(err.message || '')) {
      return res.status(403).json({ ok: false, error: 'Origin not allowed.' });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ ok: false, error: 'The document is too large.' });
    }
    if (err instanceof SyntaxError && 'body' in err) {
      return res.status(400).json({ ok: false, error: 'Request body is not valid JSON.' });
    }
    console.error('[error]', err);
    res.status(500).json({ ok: false, error: 'Internal error.' });
  });

  return app;
}
