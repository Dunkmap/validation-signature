/* Write-back to Salesforce, then - and only then - delete the S3 copies.

   Server-to-server with a JWT-signed connected app: the ordinary direction,
   with no guest user involved, so none of the restrictions that forced this
   service off-platform apply here. */

import { createSign } from 'node:crypto';
import { documentKey, currentVersion, orderedSigners } from './envelope.js';
import { formatIstDay } from './datetime.js';

/* JWT bearer flow. No library: it is three base64url segments and one RS256
   signature. */
export async function getAccessToken({ clientId, username, privateKey, loginUrl, fetchImpl = fetch }) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: clientId,
    sub: username,
    aud: loginUrl,
    exp: now + 180,
  }));

  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(privateKey).toString('base64url');
  const assertion = `${header}.${claims}.${signature}`;

  const res = await fetchImpl(`${loginUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`Salesforce auth failed (${res.status}): ${json.error_description || json.error || 'no token returned'}`);
  }
  return { accessToken: json.access_token, instanceUrl: json.instance_url };
}

function b64url(s) {
  return Buffer.from(s).toString('base64url');
}

/* Map a signer to the E_Sign_Request__c fields.

   locationStatus is passed straight through because it was validated on the
   way in. Salesforce rejects any other value and fails the WHOLE record. */
function auditRecord(envelope, signer, requestNumber) {
  return {
    Name: `${signer.name} - ${formatDay(signer.signedAt)}`.slice(0, 80),
    Signature_Request_Id__c: envelope.externalId,
    File_Name__c: envelope.signedFileName,
    Signer_Name__c: signer.name,
    Signer_Email__c: signer.email,
    Signer_Role__c: signer.role,
    Signed_At__c: signer.signedAt,
    Document_Hash__c: signer.documentHash,
    Consent_Statement__c: signer.consentStatement,
    Signer_IP_Address__c: signer.ip,
    Signer_Timezone__c: signer.timezone,
    Signer_Browser__c: browserOf(signer.userAgent),
    Signer_OS__c: osOf(signer.userAgent),
    Signer_Screen__c: signer.screen,
    Signer_User_Agent__c: (signer.userAgent || '').slice(0, 255),
    Signer_Device_Type__c: deviceOf(signer.userAgent),
    Signer_Geolocation__Latitude__s: signer.latitude,
    Signer_Geolocation__Longitude__s: signer.longitude,
    Location_Accuracy_M__c: signer.accuracy,
    Location_Status__c: signer.locationStatus,
    Status__c: 'Signed',
    Signed_Via__c: 'Public Link',
  };
}

/* The record NAME carries the IST day, so a user scanning the related list in
   Salesforce sees the date they would have written down.

   Signed_At__c itself stays the raw UTC ISO string: Salesforce stores datetimes
   in UTC and renders them in each user's own timezone, so converting before
   the write would shift every displayed time by 5.5 hours. */
function formatDay(iso) {
  return formatIstDay(iso);
}

function browserOf(ua = '') {
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Unknown';
}

function osOf(ua = '') {
  if (/Windows/.test(ua)) return 'Windows';
  if (/Android/.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
  if (/Mac OS X/.test(ua)) return 'macOS';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Unknown';
}

function deviceOf(ua = '') {
  return /Mobi|Android|iPhone|iPad/i.test(ua) ? 'Mobile' : 'Desktop';
}

/* The completion sequence.

   1. every E_Sign_Request__c audit row
   2. every Signature_Request__c set to Signed
   3. the final PDF as a ContentVersion, linked to the request
   4. ONLY THEN delete the S3 copies

   Any failure aborts before step 4. A deleted document with a failed
   write-back is unrecoverable, so nothing is removed until Salesforce has
   confirmed every write. */
export async function completeEnvelope({ envelope, store, client, mailer, senderEmail, requestNumber }) {
  const signers = orderedSigners(envelope);

  const version = currentVersion(envelope);
  const key = documentKey(envelope.envelopeId, version);
  const pdf = await store.getObject(key);
  if (!pdf) throw new Error(`Final document missing from storage at ${key}; nothing written back.`);

  // 1. audit rows
  for (const s of signers) {
    await client.create('E_Sign_Request__c', auditRecord(envelope, s, requestNumber));
  }

  // 2. mark the request signed
  await client.update('Signature_Request__c', envelope.externalId, {
    Status__c: 'Signed',
    Signed_At__c: envelope.completedAt,
  });

  // 3. file the PDF against the request
  const contentVersionId = await client.create('ContentVersion', {
    Title: envelope.signedFileName,
    PathOnClient: envelope.signedFileName,
    VersionData: pdf.toString('base64'),
    FirstPublishLocationId: envelope.externalId,
  });
  await client.linkDocument(contentVersionId, envelope.externalId);

  // Notify everyone. An email failure must not cost us the document, so it is
  // reported but does not abort the deletion that follows a confirmed write.
  const mailErrors = [];
  const recipients = [...signers.map((s) => s.email), senderEmail].filter(Boolean);
  for (const to of new Set(recipients)) {
    try {
      await mailer.sendCompletion({ to, fileName: envelope.signedFileName, signers });
    } catch (e) {
      mailErrors.push(`${to}: ${e.message}`);
    }
  }

  // 4. every write confirmed - now the working copies can go
  const keys = [];
  for (let v = 0; v <= version; v++) keys.push(documentKey(envelope.envelopeId, v));
  await store.deleteObjects(keys);

  return { contentVersionId, deleted: keys.length, mailErrors };
}

/* A thin REST client. Kept separate so completeEnvelope can be tested against
   a fake without touching the network. */
export function createSalesforceClient({ instanceUrl, accessToken, apiVersion = 'v61.0', fetchImpl = fetch }) {
  const base = `${instanceUrl}/services/data/${apiVersion}`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  const call = async (method, path, body) => {
    const res = await fetchImpl(`${base}${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      // Surface the real reason. A silently-caught failure here is exactly how
      // the Salesforce build reported success while writing nothing.
      throw new Error(`Salesforce ${method} ${path} failed (${res.status}): ${text.slice(0, 400)}`);
    }
    return text ? JSON.parse(text) : {};
  };

  return {
    async create(sobject, fields) {
      const r = await call('POST', `/sobjects/${sobject}`, fields);
      if (!r.id) throw new Error(`Salesforce did not return an id for the new ${sobject}`);
      return r.id;
    },
    async update(sobject, id, fields) {
      await call('PATCH', `/sobjects/${sobject}/${id}`, fields);
    },
    async linkDocument(contentVersionId, linkedEntityId) {
      const r = await call('GET',
        `/query?q=${encodeURIComponent(
          `SELECT ContentDocumentId FROM ContentVersion WHERE Id = '${contentVersionId}'`)}`);
      const docId = r.records?.[0]?.ContentDocumentId;
      if (!docId) throw new Error('Could not resolve ContentDocumentId for the uploaded file');

      // FirstPublishLocationId may already have created the link; a duplicate
      // is not a failure worth aborting the whole completion for.
      try {
        await call('POST', '/sobjects/ContentDocumentLink', {
          ContentDocumentId: docId,
          LinkedEntityId: linkedEntityId,
          ShareType: 'V',
          Visibility: 'AllUsers',
        });
      } catch (e) {
        if (!/DUPLICATE_VALUE|already/i.test(e.message)) throw e;
      }
      return docId;
    },
  };
}
