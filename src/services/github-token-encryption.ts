import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

type GitHubTokenType = 'access' | 'refresh';

function getEncryptionKey(): Buffer {
  const value = env.GITHUB_TOKEN_ENCRYPTION_KEY;

  if (!value) {
    throw new Error('GITHUB_TOKEN_ENCRYPTION_KEY is required.');
  }

  return Buffer.from(value, 'hex');
}

function getTokenContext(userId: number, tokenType: GitHubTokenType): Buffer {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error('Invalid user ID for GitHub token encryption.');
  }

  return Buffer.from(`deployme:github:v1:${userId}:${tokenType}`, 'utf8');
}

export function encryptGitHubToken(
  token: string,
  userId: number,
  tokenType: GitHubTokenType,
): string {
  if (!token) {
    throw new Error('A GitHub token is required.');
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getEncryptionKey(), iv, {
    authTagLength: 16,
  });

  cipher.setAAD(getTokenContext(userId, tokenType));

  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);

  const tag = cipher.getAuthTag();

  return ['v1', iv.toString('hex'), tag.toString('hex'), ciphertext.toString('hex')].join('.');
}

export function decryptGitHubToken(
  encryptedToken: string,
  userId: number,
  tokenType: GitHubTokenType,
): string {
  const parts = encryptedToken.split('.');
  const [version, ivHex, tagHex, ciphertextHex] = parts;

  if (
    parts.length !== 4 ||
    version !== 'v1' ||
    !ivHex ||
    !/^[a-f0-9]{24}$/.test(ivHex) ||
    !tagHex ||
    !/^[a-f0-9]{32}$/.test(tagHex) ||
    !ciphertextHex ||
    !/^(?:[a-f0-9]{2})+$/.test(ciphertextHex)
  ) {
    throw new Error('Invalid encrypted GitHub token format.');
  }

  const decipher = createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(ivHex, 'hex'), {
    authTagLength: 16,
  });

  decipher.setAAD(getTokenContext(userId, tokenType));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, 'hex')),
    decipher.final(),
  ]);

  return plaintext.toString('utf8');
}
