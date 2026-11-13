import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { prisma } from '../../../src/config/database.js';
import { createOtpChallenge, verifyOtpChallenge, verifyOtpAndGetOrCreateUser } from '../../../src/services/otp-challenge.js';
import { MAX_OTP_ATTEMPTS } from '../../support/constants.js';
import { differentCode } from '../../support/auth-flow.js';
import { useTestData } from '../../support/test-data.js';

describe('OTP challenge service', () => {
  const data = useTestData();

  async function newChallenge() {
    const email = data.newEmail('otp');
    const { challenge, code } = await createOtpChallenge(email);

    return { email, challenge, code };
  }

  it('can only be verified once', async () => {
    const { email, challenge, code } = await newChallenge();

    assert.equal(await verifyOtpChallenge(challenge.id, email, code), true);
    assert.equal(await verifyOtpChallenge(challenge.id, email, code), false);
  });

  it(`is rejected after ${MAX_OTP_ATTEMPTS} incorrect attempts`, async () => {
    const { email, challenge, code } = await newChallenge();
    const wrongCode = differentCode(code);

    for (let attempt = 1; attempt <= MAX_OTP_ATTEMPTS; attempt++) {
      assert.equal(
        await verifyOtpChallenge(challenge.id, email, wrongCode),
        false,
        `Incorrect attempt ${attempt} should be rejected`,
      );
    }

    // Even the correct code must fail after the attempt limit is reached.
    assert.equal(await verifyOtpChallenge(challenge.id, email, code), false);
  });

  it('cannot be verified once expired', async () => {
    const { email, challenge, code } = await newChallenge();

    await prisma.otpChallenge.update({
      where: { id: challenge.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    assert.equal(await verifyOtpChallenge(challenge.id, email, code), false);
  });

  it('is exhausted by concurrent incorrect attempts', async () => {
    const { email, challenge, code } = await newChallenge();
    const wrongCode = differentCode(code);

    const results = await Promise.all(
      Array.from({ length: MAX_OTP_ATTEMPTS }, () =>
        verifyOtpChallenge(challenge.id, email, wrongCode),
      ),
    );

    assert.ok(results.every((result) => result === false));

    assert.equal(
      await verifyOtpChallenge(challenge.id, email, code),
      false,
      'The correct code must be rejected after concurrent failed attempts',
    );

    const stored = await prisma.otpChallenge.findUnique({
      where: { id: challenge.id },
      select: { attemptCount: true },
    });

    assert.equal(stored?.attemptCount, MAX_OTP_ATTEMPTS);
  });
    it('accepts a correct code only once under concurrent verification', async () => {
    const { email, challenge, code } = await newChallenge();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        verifyOtpChallenge(challenge.id, email, code),
      ),
    );

    assert.equal(results.filter((result) => result === true).length, 1);
    assert.equal(results.filter((result) => result === false).length, 4);

    const stored = await prisma.otpChallenge.findUniqueOrThrow({
      where: { id: challenge.id },
    });

    assert.ok(stored.consumedAt);
    assert.equal(stored.attemptCount, 0);
  });

  it('exhausts concurrent incorrect signup attempts without creating a user', async () => {
    const { email, challenge, code } = await newChallenge();
    const wrongCode = differentCode(code);

    const results = await Promise.all(
      Array.from({ length: MAX_OTP_ATTEMPTS }, () =>
        verifyOtpAndGetOrCreateUser(challenge.id, email, wrongCode),
      ),
    );

    assert.ok(results.every((result) => result === null));

    assert.equal(
      await verifyOtpAndGetOrCreateUser(challenge.id, email, code),
      null,
    );

    const stored = await prisma.otpChallenge.findUniqueOrThrow({
      where: { id: challenge.id },
    });

    assert.equal(stored.attemptCount, MAX_OTP_ATTEMPTS);
    assert.ok(stored.consumedAt);
    assert.equal(
      await prisma.user.count({ where: { email } }),
      0,
    );
  });

  it('allows one successful signup for concurrent use of the same challenge', async () => {
    const { email, challenge, code } = await newChallenge();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        verifyOtpAndGetOrCreateUser(challenge.id, email, code),
      ),
    );

    const accepted = results.filter((result) => result !== null);

    assert.equal(accepted.length, 1);
    assert.equal(results.filter((result) => result === null).length, 4);

    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
    });

    assert.equal(accepted[0]?.id, user.id);
    assert.equal(await prisma.user.count({ where: { email } }), 1);

    const stored = await prisma.otpChallenge.findUniqueOrThrow({
      where: { id: challenge.id },
    });

    assert.ok(stored.consumedAt);
    assert.equal(stored.attemptCount, 0);
  });
});
