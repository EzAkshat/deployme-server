import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  generateOtpCode,
  hashOtpCode,
  normalizeEmail,
  verifyOtpCode,
} from '../src/services/otp.js';

const secret = 'test-only-otp-secret-at-least-32-chars';
const differentSecret = 'different-test-secret-that-is-at-least-32-chars';

test('normalizes email by trimming whitespace and lowercasing', () => {
  assert.equal(normalizeEmail('  Alice@Example.com '), 'alice@example.com');
});

test('generates a six-digit OTP', () => {
  const code = generateOtpCode();

  assert.match(code, /^\d{6}$/);
});

test('hashes and verifies an OTP', () => {
  const hash = hashOtpCode('Alice@Example.com', '012345', secret);

  assert.equal(verifyOtpCode('alice@example.com', '012345', hash, secret), true);
});

test('rejects an incorrect OTP', () => {
  const hash = hashOtpCode('alice@example.com', '012345', secret);

  assert.equal(verifyOtpCode('alice@example.com', '999999', hash, secret), false);
});

test('rejects a hash created with a different secret', () => {
  const hash = hashOtpCode('alice@example.com', '012345', secret);

  assert.equal(verifyOtpCode('alice@example.com', '012345', hash, differentSecret), false);
});

test('rejects a malformed stored hash', () => {
  assert.equal(verifyOtpCode('alice@example.com', '012345', 'not-a-valid-hash', secret), false);
});
