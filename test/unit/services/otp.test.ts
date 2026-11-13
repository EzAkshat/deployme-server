import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  generateOtpCode,
  hashOtpCode,
  normalizeEmail,
  verifyOtpCode,
} from '../../../src/services/otp.js';

const SECRET = 'test-only-otp-secret-at-least-32-chars';
const DIFFERENT_SECRET = 'different-test-secret-that-is-at-least-32-chars';
const EMAIL = 'alice@example.com';
const CODE = '012345';

describe('otp service', () => {
  describe('normalizeEmail', () => {
    it('trims whitespace and lowercases', () => {
      assert.equal(normalizeEmail('  Alice@Example.com '), 'alice@example.com');
    });
  });

  describe('generateOtpCode', () => {
    it('generates a six-digit code', () => {
      assert.match(generateOtpCode(), /^\d{6}$/);
    });
  });

  describe('hashOtpCode / verifyOtpCode', () => {
    it('verifies a correct code, ignoring email casing', () => {
      const hash = hashOtpCode('Alice@Example.com', CODE, SECRET);

      assert.equal(verifyOtpCode(EMAIL, CODE, hash, SECRET), true);
    });

    it('rejects an incorrect code', () => {
      const hash = hashOtpCode(EMAIL, CODE, SECRET);

      assert.equal(verifyOtpCode(EMAIL, '999999', hash, SECRET), false);
    });

    it('rejects a hash created with a different secret', () => {
      const hash = hashOtpCode(EMAIL, CODE, SECRET);

      assert.equal(verifyOtpCode(EMAIL, CODE, hash, DIFFERENT_SECRET), false);
    });

    it('rejects a malformed stored hash', () => {
      assert.equal(verifyOtpCode(EMAIL, CODE, 'not-a-valid-hash', SECRET), false);
    });
  });
});
