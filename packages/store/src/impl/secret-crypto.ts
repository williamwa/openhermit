import crypto from 'node:crypto';

/**
 * Shared AES-256-GCM helpers used by DbSecretStore and DbAgentChannelStore.
 * The 32-byte key comes from OPENHERMIT_SECRETS_KEY (base64). Wire format
 * is `base64(iv):base64(authTag):base64(ciphertext)`.
 */
const ALGORITHM = 'aes-256-gcm';
const IV_LEN = 12;
export const KEY_LEN = 32;

export const decodeSecretsKey = (raw: string): Buffer => {
  const cleaned = raw.trim().replace(/\s+/gu, '');
  const buf = Buffer.from(cleaned, 'base64');
  if (buf.length !== KEY_LEN) {
    throw new Error(
      `OPENHERMIT_SECRETS_KEY must decode to ${KEY_LEN} bytes (got ${buf.length}). ` +
      `Generate with: node -e "console.log(require('crypto').randomBytes(${KEY_LEN}).toString('base64'))"`,
    );
  }
  return buf;
};

export const secretsKeyFromEnv = (env: NodeJS.ProcessEnv = process.env): Buffer => {
  const raw = env.OPENHERMIT_SECRETS_KEY;
  if (!raw) {
    throw new Error(
      'OPENHERMIT_SECRETS_KEY is not set. Run `hermit setup` to generate one, ' +
      'or set it manually with: ' +
      `node -e "console.log(require('crypto').randomBytes(${KEY_LEN}).toString('base64'))"`,
    );
  }
  return decodeSecretsKey(raw);
};

export const encryptString = (key: Buffer, plaintext: string): string => {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
};

export const decryptString = (key: Buffer, payload: string): string => {
  const parts = payload.split(':');
  if (parts.length !== 3) throw new Error('malformed ciphertext');
  const [iv, authTag, ciphertext] = parts.map((p) => Buffer.from(p, 'base64')) as [Buffer, Buffer, Buffer];
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const out = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return out.toString('utf8');
};

export const generateSecretsKey = (): string =>
  crypto.randomBytes(KEY_LEN).toString('base64');
