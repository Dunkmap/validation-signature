import {
  loadDocument, submitSignature, pollStatus, downloadUrl, token,
  requestCode, verifyCode, clearSession,
} from './api.js';
import { browserFacts, requestLocation, LOCATION_STATUS } from './client-context.js';
import { renderDocument, previewSignature, scrollToBox } from './viewer.js';
import { createSignatureMaker } from './signature-maker.js';
import { stampAndCertify } from './stamp.js';

const CONSENT = 'I agree that my electronic signature is the legal equivalent of my '
              + 'handwritten signature, and that it binds me to the terms of this document.';

const state = {
  doc: null,
  documentBytes: null,
  signature: null,      // { dataUrl, method }
  location: { locationStatus: LOCATION_STATUS.NOT_REQUESTED },
  browser: browserFacts(),
  submitting: false,
  pollTimer: null,
};

const screens = ['loading', 'refused', 'verify', 'signing', 'done'];
function show(name) {
  for (const s of screens) {
    document.getElementById(`screen-${s}`).hidden = s !== name;
  }
}

function el(id) { return document.getElementById(id); }

function fail(message) {
  // Never swallow a failure silently. If a step fails, surface it - a job that
  // reports success while writing nothing is the worst outcome there is.
  el('refusedTitle').textContent = 'Something went wrong';
  el('refusedBody').textContent = message;
  el('refusedWaiting').hidden = true;
  show('refused');
}

async function boot() {
  if (!token()) {
    fail('This link is missing its signing token. Please use the link from your email exactly as it was sent.');
    return;
  }

  let res;
  try {
    res = await loadDocument();
  } catch (e) {
    fail(`The document could not be loaded. ${e.message}`);
    return;
  }

  /* The document is gated behind email verification: a forwarded link reaches
     this screen and nothing else. */
  if (!res.ok && res.reason === 'VERIFICATION_REQUIRED') {
    /* A session that was rejected is worse than none - it would be re-sent on
       every retry and keep failing. Drop it and start clean. */
    clearSession();
    renderVerifyScreen(res);
    return;
  }

  if (!res.ok) {
    renderRefusal(res);
    return;
  }

  state.doc = res;
  document.title = `Sign - ${res.fileName}`;

  try {
    state.documentBytes = base64ToBytes(res.documentBase64);
  } catch {
    fail('The document was received but could not be read. Please ask the sender to resend it.');
    return;
  }

  await renderSigningScreen();
}

/* The verification screen.

   An emailed signing link is a bearer token: whoever holds the URL can sign.
   Forwarding the mail therefore forwards the ability to sign - which is what
   this screen exists to stop. It shows only the masked address, never the
   document, the signer name, or the sender's message.

   The code proves control of the MAILBOX, not the identity of the person
   reading it: someone who forwards both link and code still gets through. It
   closes casual forwarding, not a determined insider. */
function renderVerifyScreen(res) {
  const sendBtn = el('sendCodeBtn');
  const verifyBtn = el('verifyBtn');
  const resendBtn = el('resendBtn');
  const input = el('codeInput');

  const showError = (msg) => {
    el('verifyError').textContent = msg;
    el('verifyError').hidden = !msg;
  };

  const showSentTo = (masked) => {
    if (!masked) return;
    el('verifySentTo').textContent = masked;
    el('verifySentWrap').hidden = false;
  };

  // Before a code is asked for, say which mailbox will receive it.
  if (res.sentTo) {
    el('verifyIntro').textContent =
      'Before opening this document we need to confirm you are the person it was '
      + `sent to. We will email a 6-digit code to ${res.sentTo}.`;
  }

  const ask = async (btn, label) => {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Sending…';
    showError('');

    try {
      const out = await requestCode();

      if (!out.ok) {
        /* Say what actually happened. A rate limit, a not-yet-your-turn and a
           dead link are different problems with different actions, and one
           generic "try again" would hide which. */
        showError(out.error || 'The code could not be sent.');
        if (out.sentTo) showSentTo(out.sentTo);
        // A wait is temporary: let them try again once it has passed.
        btn.disabled = false;
        btn.textContent = original;
        return false;
      }

      showSentTo(out.sentTo);
      el('codeEntry').hidden = false;
      input.focus();

      /* Never let a printed code look like a delivered one. With the console
         mail driver nothing is actually sent, and a signer would otherwise
         wait on an email that does not exist. */
      if (out.warning) showError(out.warning);

      btn.textContent = label;
      btn.disabled = false;
      return true;
    } catch (e) {
      showError(`The code could not be sent. ${e.message}`);
      btn.disabled = false;
      btn.textContent = original;
      return false;
    }
  };

  sendBtn.onclick = async () => {
    /* Only stand the button down once a code has actually gone out. Hiding it
       on a failure - a rate limit, a dead link - would leave no way to retry. */
    if (await ask(sendBtn, 'Code sent')) sendBtn.hidden = true;
  };
  resendBtn.onclick = () => ask(resendBtn, 'Send a new code');

  // Digits only, and enable the button exactly when six are present.
  input.oninput = () => {
    input.value = input.value.replace(/\D/g, '').slice(0, 6);
    verifyBtn.disabled = input.value.length !== 6;
    showError('');
  };

  input.onkeydown = (e) => {
    if (e.key === 'Enter' && input.value.length === 6) verifyBtn.click();
  };

  verifyBtn.onclick = async () => {
    verifyBtn.disabled = true;
    const original = verifyBtn.textContent;
    verifyBtn.textContent = 'Verifying…';
    showError('');

    try {
      const out = await verifyCode(input.value);

      if (!out.ok) {
        showError(out.error || 'That code could not be verified.');
        verifyBtn.textContent = original;
        input.select();

        /* A spent challenge needs a NEW code, not another guess - so stop
           offering the guess. */
        if (out.reason === 'TOO_MANY_ATTEMPTS' || out.reason === 'CODE_EXPIRED') {
          el('codeEntry').hidden = true;
          sendBtn.hidden = false;
          sendBtn.disabled = false;
          sendBtn.textContent = 'Email me a new code';
        } else {
          verifyBtn.disabled = input.value.length !== 6;
        }
        return;
      }

      // Verified. The session is stored by the API layer; re-boot and the
      // document loads on the very next request.
      show('loading');
      await boot();
    } catch (e) {
      showError(`The code could not be verified. ${e.message}`);
      verifyBtn.textContent = original;
      verifyBtn.disabled = false;
    }
  };

  show('verify');
}

function renderRefusal(res) {
  if (res.reason === 'NOT_YOUR_TURN') {
    el('refusedTitle').textContent = 'Not your turn yet';
    el('refusedBody').textContent = res.error;
    el('refusedWaiting').hidden = false;
    el('refusedWaitingName').textContent = res.waitingOn || 'another signer';
  } else {
    el('refusedTitle').textContent = 'This link cannot be opened';
    el('refusedBody').textContent = res.error;
    el('refusedWaiting').hidden = true;
  }
  show('refused');
}

async function renderSigningScreen() {
  const d = state.doc;

  el('docName').textContent = d.fileName;
  el('topbarDoc').textContent = d.fileName;
  el('signerName').textContent = d.signerName;
  el('signerRole').textContent = d.signerRole || '';
  /* Say how many signers there are, not which position this one holds - a
     position implies a queue, and there is none. */
  el('signerPosition').textContent = d.signerCount > 1
    ? `One of ${d.signerCount} signers`
    : 'Sole signer';
  el('senderMessage').textContent = d.message || '';
  el('senderMessageWrap').hidden = !d.message;

  el('consentText').textContent = CONSENT;

  renderTimeline(d.timeline || []);
  renderSessionPanel();

  show('signing');

  try {
    await renderDocument(state.documentBytes, el('pdfContainer'), d.box);
  } catch (e) {
    fail(`The document could not be displayed. ${e.message}`);
    return;
  }

  /* Ask for location only once the page is up, and record the answer either
     way - a refusal is a legitimate outcome that still belongs on the record. */
  state.location = await requestLocation();
  renderSessionPanel();

  wireSigningControls();
}

/* The "This session" panel, shown BEFORE signing rather than after. What is
   about to be recorded about someone is worth seeing while declining is still
   an option. */
function renderSessionPanel() {
  const b = state.browser;
  const rows = [
    ['IP address', state.doc.signerIp || 'Not available', 'server'],
    ['Browser', `${b.browser} on ${b.os}`, 'browser'],
    ['Timezone', b.timezone, 'browser'],
    ['Screen', b.screen, 'browser'],
    ['Location', locationLabel(state.location), 'browser'],
  ];
  el('sessionRows').innerHTML = rows.map(([k, v, src]) => `
    <div class="session-row">
      <dt>${k}</dt>
      <dd>${escapeHtml(v)}<span class="src src-${src}">${src === 'server' ? 'observed' : 'reported'}</span></dd>
    </div>`).join('');
}

function locationLabel(loc) {
  switch (loc.locationStatus) {
    case LOCATION_STATUS.GRANTED:
      return `${loc.latitude}, ${loc.longitude}`;
    case LOCATION_STATUS.DENIED:
      return 'Denied';
    case LOCATION_STATUS.UNAVAILABLE:
      return 'Unavailable';
    default:
      return 'Not requested';
  }
}

function renderTimeline(timeline) {
  el('timelineWrap').hidden = timeline.length === 0;
  el('timelineList').innerHTML = timeline.map((t) => `
    <li>
      <div class="tl-name">${escapeHtml(t.name)}</div>
      <div class="tl-meta">${escapeHtml(t.role || '')} &middot; ${escapeHtml(formatWhen(t.signedAt))}</div>
      <div class="tl-hash" title="The document hash this person signed against">${escapeHtml(t.hash || '')}</div>
    </li>`).join('');
}

function wireSigningControls() {
  const maker = createSignatureMaker({
    signerName: state.doc.signerName,
    onAccept: ({ dataUrl, method }) => {
      state.signature = { dataUrl, method };
      previewSignature(dataUrl);
      el('sigPreview').innerHTML = `<img src="${dataUrl}" alt="Your signature">`;
      el('sigPreview').hidden = false;
      el('openMaker').textContent = 'Change signature';
      updateSubmitState();
      scrollToBox();
    },
  });

  el('openMaker').onclick = () => maker.open();
  el('consentCheck').onchange = updateSubmitState;
  el('submitBtn').onclick = onSubmit;
  updateSubmitState();
}

function updateSubmitState() {
  const ready = !!state.signature && el('consentCheck').checked && !state.submitting;
  el('submitBtn').disabled = !ready;
}

async function onSubmit() {
  if (state.submitting) return;
  state.submitting = true;
  updateSubmitState();

  const btn = el('submitBtn');
  const original = btn.textContent;
  btn.textContent = 'Signing...';
  el('submitError').hidden = true;

  try {
    const signedAt = new Date().toISOString();

    const signedBytes = await stampAndCertify({
      documentBytes: state.documentBytes,
      box: state.doc.box,
      signatureDataUrl: state.signature.dataUrl,
      signerName: state.doc.signerName,
      signerRole: state.doc.signerRole,
      signMethod: state.signature.method,
      signedAt,
      consentStatement: CONSENT,
      serverIp: state.doc.signerIp,
      browser: state.browser,
      location: state.location,
      timeline: state.doc.timeline || [],
    });

    const res = await submitSignature({
      signedDocumentBase64: bytesToBase64(signedBytes),
      consentStatement: CONSENT,
      clientContext: {
        userAgent: state.browser.userAgent,
        language: state.browser.language,
        platform: state.browser.platform,
        screen: state.browser.screen,
        timezone: state.browser.timezone,
        locationStatus: state.location.locationStatus,
        latitude: state.location.latitude,
        longitude: state.location.longitude,
        accuracy: state.location.accuracy,
      },
    });

    /* The session can lapse while someone is part-way through - reading the
       document, or fetching the code from another device. Send them back to
       verify rather than reporting a failure they cannot act on. Their drawn
       signature is kept in state, so nothing is lost. */
    if (!res.ok && res.reason === 'VERIFICATION_REQUIRED') {
      clearSession();
      state.submitting = false;
      btn.textContent = original;
      renderVerifyScreen(res);
      return;
    }

    if (!res.ok) {
      throw new Error(res.error || 'The server would not accept the signature.');
    }

    renderDone(res);
  } catch (e) {
    // Surface it. The signature was not taken; say so plainly.
    el('submitError').textContent = `${e.message} Your signature has not been recorded - you can try again.`;
    el('submitError').hidden = false;
    btn.textContent = original;
    state.submitting = false;
    updateSubmitState();
  }
}

function renderDone(res) {
  show('done');
  el('doneFileName').textContent = res.fileName || state.doc.fileName;
  // The server's hash, computed from the bytes it actually stored. The client
  // never asserts this.
  el('doneHash').textContent = res.documentHash || '';

  if (res.complete) {
    renderComplete();
  } else {
    el('doneTitle').textContent = 'Signed - thank you';
    el('doneBody').textContent = 'Your signature has been recorded. The document now goes to the remaining signers.';
    renderWaitingOn(res.waitingOn || []);
    el('waitingWrap').hidden = false;
    el('downloadWrap').hidden = true;
    startPolling();
  }
}

function renderComplete() {
  el('doneTitle').textContent = 'Signing complete';
  el('doneBody').textContent = 'Everyone has signed. The finished document is ready to download.';
  el('waitingWrap').hidden = true;
  el('downloadWrap').hidden = false;
  el('downloadLink').href = downloadUrl();
  stopPolling();
}

function renderWaitingOn(names) {
  el('waitingList').innerHTML = names.map((n) => `<li>${escapeHtml(n)}</li>`).join('');
}

/* Poll while waiting, so a signer who leaves the tab open sees it finish.
   Backs off rather than hammering, and gives up quietly after a while. */
function startPolling() {
  let delay = 15000;
  const cap = 120000;
  const stopAt = Date.now() + 30 * 60 * 1000;

  const tick = async () => {
    if (Date.now() > stopAt) return stopPolling();
    try {
      const s = await pollStatus();
      if (s.ok) {
        el('progressText').textContent = `${s.signedCount} of ${s.totalCount} signed`;
        renderWaitingOn(s.waitingOn || []);
        if (s.complete) return renderComplete();
      }
    } catch {
      // A failed poll is not worth interrupting the signer over - their
      // signature is already safely recorded. Just back off and retry.
    }
    delay = Math.min(cap, delay * 1.5);
    state.pollTimer = setTimeout(tick, delay);
  };

  state.pollTimer = setTimeout(tick, delay);
}

function stopPolling() {
  if (state.pollTimer) clearTimeout(state.pollTimer);
  state.pollTimer = null;
}

// --- helpers ---

function base64ToBytes(b64) {
  const clean = String(b64).replace(/^data:[^,]+,/, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes) {
  // Chunked: a single spread of a multi-megabyte array blows the call stack.
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/* Always Indian Standard Time, and always labelled.

   Not the browser's own zone: a signer on a laptop still set to another
   country would otherwise read a different time from the one printed on the
   certificate, for the same signature. One zone everywhere, named on screen so
   nobody has to guess which. */
function formatWhen(iso) {
  const dt = new Date(iso);
  if (isNaN(dt)) return '';
  const s = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: 'Asia/Kolkata',
  }).format(dt);
  return `${s.replace('Sept', 'Sep')} IST`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

boot();
