import { formatIst } from './datetime.js';

/* Signer emails.

   Two drivers, chosen by ESIGN_MAIL:
     console - prints the message and sends NOTHING. Local development.
     smtp    - a real send, over any SMTP server.

   The console driver states plainly, on every message and in the API response,
   that nothing was delivered. A mailer whose success is indistinguishable from
   real delivery is exactly the silent failure this project is meant to avoid:
   it once printed 38 invitations that nobody received while reporting success
   for all of them. */

function invitationBody({ signerName, fileName, message, url }) {
  return [
    `Hello ${signerName},`,
    '',
    `You have been asked to sign "${fileName}".`,
    message ? `\nMessage from the sender:\n${message}\n` : '',
    'Open your signing link:',
    url,
    '',
    'If several people are signing, you can sign whenever suits you - there is no',
    'order to wait for, and you will not hold anyone else up.',
  ].filter((l) => l !== '').join('\n');
}

/* The OTP mail. Deliberately spare: a code, what it is for, how long it
   lasts, and a warning not to pass it on.

   It says the document name so the signer can tell which request a code
   belongs to when two are in flight, but carries NO signing link - a mail
   containing both the link and the code would be a single forwardable
   message, which is the exact thing the code exists to prevent. */
function otpBody({ signerName, fileName, code, minutes }) {
  return [
    `Hello ${signerName},`,
    '',
    `Your verification code is:`,
    '',
    `    ${code}`,
    '',
    `Enter it on the signing page to open "${fileName}".`,
    `The code expires in ${minutes} minutes.`,
    '',
    'This code confirms that you are the person the document was sent to.',
    'Do not share it with anyone - not even a colleague asking to sign on your',
    'behalf. If you did not expect this, you can ignore this email and nothing',
    'will be signed.',
  ].join('\n');
}

function completionBody({ fileName, signers }) {
  return [
    `"${fileName}" has been signed by everyone.`,
    '',
    'Signed by:',
    ...signers.map((s) => `  - ${s.name}${s.role ? ` (${s.role})` : ''} on ${formatIst(s.signedAt)}`),
    '',
    'A copy has been filed against the request record.',
  ].join('\n');
}

// --------------------------------------------------------------- console ----

export function createConsoleMailer({ log = console.log } = {}) {
  const sent = [];

  const print = (kind, msg, subject, body) => {
    sent.push({ kind, ...msg });
    log(
      `\n[email] ---- NOT SENT (console driver; set ESIGN_MAIL=smtp to deliver) ----\n`
      + `[email] to: ${msg.to}\n`
      + `[email] subject: ${subject}\n`
      + (body ? body.split('\n').map((l) => `[email] ${l}`).join('\n') + '\n' : '')
      + `[email] ---- end, nothing was delivered ----\n`,
    );
  };

  return {
    driver: 'console',
    // The handlers surface this, so a caller cannot mistake a printed message
    // for a delivered one.
    delivers: false,

    async sendInvitation(msg) {
      print('invitation', msg, `Please sign "${msg.fileName}"`, invitationBody(msg));
    },
    async sendCompletion(msg) {
      print('completion', msg, `Signed - "${msg.fileName}"`, completionBody(msg));
    },

    /* Printing the code to the console is what makes local development
       possible at all - but it is also why this driver must never be used
       against real signers, since the "second factor" is then sitting in a log
       file. The banner on every message says so. */
    async sendOtp(msg) {
      print('otp', msg, `Your verification code: ${msg.code}`, otpBody(msg));
    },
    _sent: () => sent,
  };
}

// ------------------------------------------------------------------ smtp ----

export function createSmtpMailer({ host, port, user, pass, from, secure }) {
  if (!host || !from) {
    throw new Error('ESIGN_SMTP_HOST and ESIGN_MAIL_FROM are required when ESIGN_MAIL=smtp.');
  }

  /* Refuse blank credentials rather than connecting without authentication.

     nodemailer omits the AUTH step entirely when the user is empty, and a
     hosted provider will happily accept that connection - so verify() reports
     success while every real send is refused. That is the silent failure this
     file exists to prevent: the server looks healthy and no signer ever gets
     a code. A provider needing no credentials is not a case worth supporting
     here. */
  if (!user || !pass) {
    throw new Error(
      'ESIGN_SMTP_USER and ESIGN_SMTP_PASS are required when ESIGN_MAIL=smtp. '
      + 'They are empty, and connecting without them would report success while '
      + 'delivering nothing. For Mailjet these are the API Key and Secret Key.',
    );
  }

  // Imported lazily so the console driver needs no mail dependency at all.
  const transport = (async () => {
    const { createTransport } = await import('nodemailer');
    return createTransport({
      host,
      port: port || 587,
      // Port 465 is implicit TLS; 587 upgrades with STARTTLS.
      secure: secure ?? Number(port) === 465,
      auth: user ? { user, pass } : undefined,
    });
  })();

  const send = async (to, subject, text) => {
    const t = await transport;
    const info = await t.sendMail({ from, to, subject, text });
    // Return the server's id: proof it was accepted, not merely attempted.
    return info.messageId;
  };

  return {
    driver: 'smtp',
    delivers: true,

    async sendInvitation(msg) {
      return send(msg.to, `Please sign "${msg.fileName}"`, invitationBody(msg));
    },
    async sendCompletion(msg) {
      return send(msg.to, `Signed - "${msg.fileName}"`, completionBody(msg));
    },

    /* The subject carries the code as well as the body: on a phone the code is
       then readable from the notification, which is where most people will
       read it, without opening the mail. */
    async sendOtp(msg) {
      return send(msg.to, `Your verification code: ${msg.code}`, otpBody(msg));
    },

    /* Prove the server accepts us before anyone depends on it. Called at
       startup so a bad password is reported then, not at the moment a real
       signer was supposed to be invited. */
    async verify() {
      const t = await transport;
      await t.verify();
      return true;
    },
  };
}

export function createMailer(env = process.env) {
  if ((env.ESIGN_MAIL || 'console') === 'smtp') {
    return createSmtpMailer({
      host: env.ESIGN_SMTP_HOST,
      port: Number(env.ESIGN_SMTP_PORT || 587),
      user: env.ESIGN_SMTP_USER,
      pass: env.ESIGN_SMTP_PASS,
      from: env.ESIGN_MAIL_FROM,
      secure: env.ESIGN_SMTP_SECURE === 'true' ? true : undefined,
    });
  }
  return createConsoleMailer();
}
