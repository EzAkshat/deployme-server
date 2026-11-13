import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { prisma } from '../src/config/database.js';
import { createOtpChallenge, verifyOtpChallenge } from '../src/services/otp-challenge.js';

test('an OTP challenge can only be verified once', async () => {
  const email = `otp-${randomUUID()}@example.com`;
  let challengeId: string | undefined;

  try {
    await prisma.$connect();

    const { challenge, code } = await createOtpChallenge(email);
    challengeId = challenge.id;

    assert.equal(await verifyOtpChallenge(challenge.id, email, code), true);

    assert.equal(await verifyOtpChallenge(challenge.id, email, code), false);
  } finally {
    if (challengeId) {
      await prisma.otpChallenge.deleteMany({
        where: { id: challengeId },
      });
    }

    await prisma.$disconnect();
  }
});

test('an OTP challenge is rejected after five incorrect attempts', async () => {
  const email = `otp-${randomUUID()}@example.com`;
  let challengeId: string | undefined;

  try {
    await prisma.$connect();

    const { challenge, code } = await createOtpChallenge(email);
    challengeId = challenge.id;

    // Choose a six-digit code guaranteed to differ from the real code.
    const wrongCode = code === '000000' ? '000001' : '000000';

    for (let attempt = 0; attempt < 5; attempt++) {
      assert.equal(
        await verifyOtpChallenge(challenge.id, email, wrongCode),
        false,
        `Incorrect attempt ${attempt + 1} should be rejected`,
      );
    }

    // Even the correct code must fail after the attempt limit is reached.
    assert.equal(await verifyOtpChallenge(challenge.id, email, code), false);
  } finally {
    if (challengeId) {
      await prisma.otpChallenge.deleteMany({
        where: { id: challengeId },
      });
    }

    await prisma.$disconnect();
  }
});

test('an expired OTP challenge cannot be verified', async () => {
  const email = `otp-${randomUUID()}@example.com`;
  let challengeId: string | undefined;

  try {
    await prisma.$connect();

    const { challenge, code } = await createOtpChallenge(email);
    challengeId = challenge.id;

    await prisma.otpChallenge.update({
      where: { id: challenge.id },
      data: {
        expiresAt: new Date(Date.now() - 1_000),
      },
    });

    assert.equal(await verifyOtpChallenge(challenge.id, email, code), false);
  } finally {
    if (challengeId) {
      await prisma.otpChallenge.deleteMany({
        where: { id: challengeId },
      });
    }

    await prisma.$disconnect();
  }
});

test('concurrent incorrect attempts exhaust the OTP challenge', async () => {
  const email = `otp-${randomUUID()}@example.com`;
  let challengeId: string | undefined;

  try {
    await prisma.$connect();

    const { challenge, code } = await createOtpChallenge(email);
    challengeId = challenge.id;

    const wrongCode = code === '000000' ? '000001' : '000000';

    const results = await Promise.all(
      Array.from({ length: 5 }, () => verifyOtpChallenge(challenge.id, email, wrongCode)),
    );

    assert.ok(results.every((result) => result === false));

    assert.equal(
      await verifyOtpChallenge(challenge.id, email, code),
      false,
      'The correct code must be rejected after concurrent failed attempts',
    );

    const storedChallenge = await prisma.otpChallenge.findUnique({
      where: { id: challenge.id },
      select: { attemptCount: true },
    });

    assert.equal(storedChallenge?.attemptCount, 5);
  } finally {
    if (challengeId) {
      await prisma.otpChallenge.deleteMany({
        where: { id: challengeId },
      });
    }

    await prisma.$disconnect();
  }
});
