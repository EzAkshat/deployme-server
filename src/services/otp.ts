import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function validateSecret(secret: string): void {
  if (secret.length < 32) {
    throw new Error('OTP secret must be at least 32 characters long');
  }
}

export function hashOtpCode(email: string, code: string, secret: string): string {
  validateSecret(secret);

  return createHmac('sha256', secret)
    .update(`${normalizeEmail(email)}:${code}`)
    .digest('hex');
}

export function verifyOtpCode(
  email: string,
  code: string,
  expectedHash: string,
  secret: string,
): boolean {
  if (!/^\d{6}$/.test(code) || !/^[a-f\d]{64}$/i.test(expectedHash)) {
    return false;
  }

  const actualHash = Buffer.from(hashOtpCode(email, code, secret), 'hex');
  const storedHash = Buffer.from(expectedHash, 'hex');

  return timingSafeEqual(actualHash, storedHash);
}
