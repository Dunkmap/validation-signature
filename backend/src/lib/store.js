/* Storage behind one small interface, so the handlers never mention a vendor.

   Two drivers, chosen by ESIGN_STORE:
     memory  - fast, and discarded on restart. Tests and throwaway runs.
     disk    - JSON and PDFs under a data directory. Survives a restart, which
               matters the moment a real person is holding a signing link.

   Swapping in a hosted database later means adding a driver here and nothing
   else: no handler knows where a document lives. */

import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ---------------------------------------------------------------- memory ----

export function createMemoryStore() {
  const envelopes = new Map();   // envelopeId -> envelope
  const tokenIndex = new Map();  // tokenHash  -> { envelopeId, signerId }
  const objects = new Map();     // key        -> Buffer
  const challenges = new Map();  // tokenHash  -> otp challenge
  const sessions = new Map();    // sessionKey -> verified session

  return {
    driver: 'memory',

    async putEnvelope(env) {
      envelopes.set(env.envelopeId, structuredClone(env));
    },

    async getEnvelope(id) {
      const e = envelopes.get(id);
      return e ? structuredClone(e) : null;
    },

    async indexToken(tokenHash, ref) {
      tokenIndex.set(tokenHash, { ...ref });
    },

    async resolveToken(tokenHash) {
      const ref = tokenIndex.get(tokenHash);
      return ref ? { ...ref } : null;
    },

    async putObject(key, bytes) {
      objects.set(key, Buffer.from(bytes));
    },

    async getObject(key) {
      const b = objects.get(key);
      return b ? Buffer.from(b) : null;
    },

    async deleteObjects(keys) {
      for (const k of keys) objects.delete(k);
    },

    /* OTP challenges are keyed by the TOKEN hash, not by signer: one live
       challenge per link, so requesting a new code retires the previous one. */
    async putChallenge(tokenHash, challenge) {
      challenges.set(tokenHash, structuredClone(challenge));
    },

    async getChallenge(tokenHash) {
      const c = challenges.get(tokenHash);
      return c ? structuredClone(c) : null;
    },

    async deleteChallenge(tokenHash) {
      challenges.delete(tokenHash);
    },

    async putSession(sessionKey, session) {
      sessions.set(sessionKey, structuredClone(session));
    },

    async getSession(sessionKey) {
      const v = sessions.get(sessionKey);
      return v ? structuredClone(v) : null;
    },

    async deleteSession(sessionKey) {
      sessions.delete(sessionKey);
    },

    // test/debug only
    _objectKeys: () => [...objects.keys()],
  };
}

// ------------------------------------------------------------------ disk ----

/* Files on disk, laid out so a human can see what is there:

     <root>/envelopes/<envelopeId>.json    the envelope record
     <root>/tokens/<tokenHash>.json        hashed token -> signer
     <root>/documents/<key>                the PDFs, one file per version
     <root>/otp/<tokenHash>.json           the live OTP challenge for a link
     <root>/sessions/<sessionKey>.json     a verified OTP session

   Tokens are stored hashed, so the directory listing gives away no working
   signing links even to someone reading the disk. */
export function createDiskStore({ root }) {
  const ENV_DIR = join(root, 'envelopes');
  const TOK_DIR = join(root, 'tokens');
  const DOC_DIR = join(root, 'documents');
  const OTP_DIR = join(root, 'otp');
  const SES_DIR = join(root, 'sessions');

  const ready = (async () => {
    for (const d of [ENV_DIR, TOK_DIR, DOC_DIR, OTP_DIR, SES_DIR]) {
      await mkdir(d, { recursive: true });
    }
  })();

  /* A key from a hash is already 64 hex characters, but never build a path
     from an unsanitised value: a stray ../ would write outside the root. */
  const safeName = (v) => String(v).replace(/[^0-9a-f]/gi, '').slice(0, 128);

  // A key is "envelopes/<id>/v1.pdf"; keep that shape as real directories.
  const docPath = (key) => join(DOC_DIR, key.replace(/[^A-Za-z0-9/_.-]/g, '_'));

  const readJson = async (path) => {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      // A corrupt record must not read as "no such envelope" - that would look
      // like an expired link and send someone chasing a replacement.
      throw new Error(`Stored record at ${path} could not be read: ${e.message}`);
    }
  };

  /* Write to a temporary file and rename over the target. A crash mid-write
     then leaves the previous good record rather than a truncated one. */
  const writeJson = async (path, value) => {
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    const { rename } = await import('node:fs/promises');
    await rename(tmp, path);
  };

  return {
    driver: 'disk',
    root,

    async putEnvelope(env) {
      await ready;
      await writeJson(join(ENV_DIR, `${env.envelopeId}.json`), env);
    },

    async getEnvelope(id) {
      await ready;
      return readJson(join(ENV_DIR, `${id}.json`));
    },

    async indexToken(tokenHash, ref) {
      await ready;
      await writeJson(join(TOK_DIR, `${tokenHash}.json`), ref);
    },

    async resolveToken(tokenHash) {
      await ready;
      return readJson(join(TOK_DIR, `${tokenHash}.json`));
    },

    async putObject(key, bytes) {
      await ready;
      const p = docPath(key);
      await mkdir(dirname(p), { recursive: true });
      const tmp = `${p}.${process.pid}.tmp`;
      await writeFile(tmp, bytes);
      const { rename } = await import('node:fs/promises');
      await rename(tmp, p);
    },

    async getObject(key) {
      await ready;
      try {
        return await readFile(docPath(key));
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
    },

    async deleteObjects(keys) {
      await ready;
      for (const k of keys) {
        await rm(docPath(k), { force: true });
      }
    },

    async putChallenge(tokenHash, challenge) {
      await ready;
      await writeJson(join(OTP_DIR, `${safeName(tokenHash)}.json`), challenge);
    },

    async getChallenge(tokenHash) {
      await ready;
      return readJson(join(OTP_DIR, `${safeName(tokenHash)}.json`));
    },

    async deleteChallenge(tokenHash) {
      await ready;
      await rm(join(OTP_DIR, `${safeName(tokenHash)}.json`), { force: true });
    },

    async putSession(sessionKey, session) {
      await ready;
      await writeJson(join(SES_DIR, `${safeName(sessionKey)}.json`), session);
    },

    async getSession(sessionKey) {
      await ready;
      return readJson(join(SES_DIR, `${safeName(sessionKey)}.json`));
    },

    async deleteSession(sessionKey) {
      await ready;
      await rm(join(SES_DIR, `${safeName(sessionKey)}.json`), { force: true });
    },

    async _objectKeys() {
      await ready;
      const out = [];
      const walk = async (dir, prefix = '') => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
          else if (!rel.endsWith('.tmp')) out.push(rel);
        }
      };
      if (existsSync(DOC_DIR)) await walk(DOC_DIR);
      return out;
    },
  };
}

export function createStore(env = process.env) {
  const driver = env.ESIGN_STORE || 'memory';
  if (driver === 'disk') {
    return createDiskStore({ root: env.ESIGN_DATA_DIR || './data' });
  }
  return createMemoryStore();
}
