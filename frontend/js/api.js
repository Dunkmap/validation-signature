/* Transport layer. The only file that knows how we talk to the server.
   Swap MOCK to false (or drop ?mock=1 from the URL) to hit the real API. */

const USE_MOCK = new URLSearchParams(location.search).has('mock');

// Real API base. CloudFront/API Gateway origin.
const API_BASE = window.ESIGN_API_BASE || '';

function token() {
  // /s/<token> in production; ?token= as a fallback for local testing.
  const m = location.pathname.match(/\/s\/([0-9a-f]{64})/);
  if (m) return m[1];
  const q = new URLSearchParams(location.search).get('token');
  if (q) return q;
  // The mock stands in for the whole server, token included, so it does not
  // need a real one. The real transport always does.
  return USE_MOCK ? 'mock-token' : '';
}

/* The verified-session secret, held per signing link.

   sessionStorage, not localStorage: it dies with the tab, so a signer who
   verified on a shared or borrowed machine does not leave the document
   unlocked for whoever sits down next. Keyed by token, so two links open in
   one browser do not overwrite each other.

   This is a convenience only - the server re-checks the session on every
   request and expires it independently. Anything forged here simply gets
   refused. */
const SESSION_PREFIX = 'esign.session.';

function sessionKey() {
  return `${SESSION_PREFIX}${token()}`;
}

export function getSession() {
  try {
    return sessionStorage.getItem(sessionKey()) || null;
  } catch {
    // Private-mode browsers can throw on access. Verification still works;
    // it just has to be repeated on reload.
    return null;
  }
}

export function setSession(secret) {
  try {
    sessionStorage.setItem(sessionKey(), secret);
  } catch { /* not fatal - see above */ }
}

export function clearSession() {
  try {
    sessionStorage.removeItem(sessionKey());
  } catch { /* not fatal */ }
}

async function json(url, opts) {
  const session = getSession();
  const res = await fetch(url, {
    ...opts,
    headers: {
      ...(opts?.headers || {}),
      /* The session travels in a header, never the URL: a query string lands
         in access logs, browser history and Referer headers, which is exactly
         where a second factor must not be. */
      ...(session ? { 'X-Esign-Session': session } : {}),
      /* Skip the tunnel's free-tier interstitial. Without this a request
         through ngrok gets that HTML warning page instead of JSON, and the
         failure reads as a parse error that explains nothing. Harmless
         everywhere else - it is just an unrecognised header. */
      'ngrok-skip-browser-warning': 'true',
    },
  });

  // A non-2xx still carries a JSON refusal body in this API; read it either way.
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    /* Say what actually arrived. An HTML body here almost always means
       something sits in front of the API - a tunnel warning, a login wall, or
       a proxy error page - and naming that saves a long hunt. */
    const looksLikeHtml = /^\s*<(!doctype|html)/i.test(text);
    throw new Error(looksLikeHtml
      ? `The server returned a web page instead of data (HTTP ${res.status}). `
        + 'Something is intercepting the connection.'
      : `The server returned an unreadable response (HTTP ${res.status}).`);
  }
}

export async function loadDocument() {
  if (USE_MOCK) return (await import('../mock/mock-api.js')).mockLoad(token());
  return json(`${API_BASE}/sign/${token()}`);
}

export async function submitSignature(payload) {
  if (USE_MOCK) return (await import('../mock/mock-api.js')).mockSubmit(token(), payload);
  return json(`${API_BASE}/sign/${token()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/* Ask the server to email a code. No address is sent: the server reads it from
   the envelope, so a forwarded link cannot redirect the code elsewhere. */
export async function requestCode() {
  if (USE_MOCK) return (await import('../mock/mock-api.js')).mockRequestCode(token());
  return json(`${API_BASE}/otp/${token()}/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
}

/* Exchange a code for a session. On success the secret is stored, so the rest
   of the page can carry on without asking again. */
export async function verifyCode(code) {
  const res = USE_MOCK
    ? await (await import('../mock/mock-api.js')).mockVerifyCode(token(), code)
    : await json(`${API_BASE}/otp/${token()}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });

  if (res.ok && res.sessionSecret) setSession(res.sessionSecret);
  return res;
}

export async function pollStatus() {
  if (USE_MOCK) return (await import('../mock/mock-api.js')).mockStatus(token());
  return json(`${API_BASE}/status/${token()}`);
}

export function downloadUrl() {
  return `${API_BASE}/download/${token()}`;
}

export { token };
