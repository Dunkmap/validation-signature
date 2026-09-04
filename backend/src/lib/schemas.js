/* Request schemas.

   Zod does the shape checking; the rules that carry real consequence - PDF
   magic bytes, the 4 MB cap, the four Salesforce location values - are enforced
   here too rather than left to the handler, so a malformed request is refused
   at the edge and never reaches storage. */

import { z } from 'zod';
import { looksLikePdf, MAX_DOCUMENT_BYTES, LOCATION_STATUSES } from './validation.js';

/* A base64 field that must decode to a real PDF within the size cap.

   Validated by magic bytes, never by extension or content-type - both of which
   the client chooses. */
const pdfBase64 = z.string().min(1, 'is required').superRefine((val, ctx) => {
  const buf = Buffer.from(val.replace(/^data:[^,]+,/, ''), 'base64');

  if (buf.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'is not valid base64' });
    return;
  }
  if (!looksLikePdf(buf)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'is not a PDF (bad magic bytes)' });
  }
  if (buf.length > MAX_DOCUMENT_BYTES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `is ${(buf.length / 1048576).toFixed(1)} MB; the limit is 4 MB`,
    });
  }
});

/* Signature box, in PDF points with the origin bottom-left. Passed through
   unchanged from the sender's org - see the coordinate trap in the frontend. */
const box = z.object({
  page: z.number().int().min(1, 'must be a positive integer'),
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite().positive(),
  h: z.number().finite().positive(),
});

const signer = z.object({
  order: z.number().int().min(1),
  name: z.string().min(1).max(255),
  email: z.string().email(),
  role: z.string().max(255).optional().default(''),
  box,
});

export const envelopeSchema = z.object({
  externalId: z.string().min(1).max(255),
  fileName: z.string().min(1).max(255),
  documentBase64: pdfBase64,
  message: z.string().max(5000).optional().default(''),
  expiresAt: z.string().datetime().nullable().optional(),
  signers: z.array(signer).min(1, 'must be a non-empty array').max(20),
}).superRefine((val, ctx) => {
  // Two signers cannot share a position in the order.
  const seen = new Set();
  for (const s of val.signers) {
    if (seen.has(s.order)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['signers'],
        message: `order ${s.order} is duplicated`,
      });
    }
    seen.add(s.order);
  }
});

/* locationStatus is a closed set. Salesforce rejects anything else on
   write-back and fails the WHOLE record - after the signature has already been
   taken - so it is refused here instead. */
export const signSubmissionSchema = z.object({
  signedDocumentBase64: pdfBase64,
  consentStatement: z.string().min(1).max(5000),
  clientContext: z.object({
    userAgent: z.string().max(1000).optional().default(''),
    language: z.string().max(50).optional().default(''),
    platform: z.string().max(100).optional().default(''),
    screen: z.string().max(50).optional().default(''),
    timezone: z.string().max(100).optional().default(''),
    locationStatus: z.enum(LOCATION_STATUSES, {
      errorMap: () => ({ message: `must be one of: ${LOCATION_STATUSES.join(', ')}` }),
    }),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    accuracy: z.number().nonnegative().nullable().optional(),
  }),
});

/* The submitted OTP. Six digits, and nothing else - trimmed first, because
   people paste codes with a trailing space from a mail client. */
export const otpVerifySchema = z.object({
  code: z.string().trim().regex(/^[0-9]{6}$/, 'must be the 6-digit code from your email'),
});

/* A token is 64 hex characters. Rejecting the shape before any lookup keeps a
   malformed guess indistinguishable from a wrong one. */
export const tokenSchema = z.string().regex(/^[0-9a-f]{64}$/);

/* Flatten Zod's report into the one-line message this API returns.

   Deliberately says what was wrong with the request but never echoes the value
   back - a token or a document should not turn up in an error string or a log. */
export function formatIssues(error) {
  return error.issues
    .map((i) => {
      const path = i.path.join('.');
      return path ? `${path} ${i.message}` : i.message;
    })
    .join('; ');
}
