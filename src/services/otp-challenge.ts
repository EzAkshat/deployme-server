import { randomInt } from 'node:crypto';
import { env } from '../config/env.js';
import { prisma } from '../config/database.js';
import { generateOtpCode, hashOtpCode, normalizeEmail, verifyOtpCode } from './otp.js';

const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_TRANSACTION_RETRIES = 5;

const adjectives = [
  'calm',
  'bright',
  'swift',
  'clever',
  'quiet',
  'bold',
  'happy',
  'cosmic',
  'silver',
  'rapid',
];

const nouns = ['fox', 'owl', 'wolf', 'panda', 'falcon', 'tiger', 'raven', 'otter', 'lynx', 'hawk'];

function generateUsername(): string {
  const adjective = adjectives[randomInt(adjectives.length)];
  const noun = nouns[randomInt(nouns.length)];
  const suffix = randomInt(1000, 10000);

  return `${adjective}${noun}_${suffix}`;
}

function hasPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

export async function createOtpChallenge(email: string) {
  const normalizedEmail = normalizeEmail(email);
  const code = generateOtpCode();
  const secret = env.OTP_SECRET;

  if (!secret) {
    throw new Error('OTP_SECRET is required to create OTP challenges');
  }

  const now = new Date();

  await prisma.otpChallenge.updateMany({
    where: {
      email: normalizedEmail,
      consumedAt: null,
    },
    data: {
      consumedAt: now,
    },
  });

  const challenge = await prisma.otpChallenge.create({
    data: {
      email: normalizedEmail,
      codeHash: hashOtpCode(normalizedEmail, code, secret),
      expiresAt: new Date(now.getTime() + OTP_TTL_MS),
    },
    select: {
      id: true,
      email: true,
      expiresAt: true,
    },
  });

  return { challenge, code };
}

export async function verifyOtpChallenge(
  challengeId: string,
  email: string,
  code: string,
): Promise<boolean> {
  const secret = env.OTP_SECRET;

  if (!secret || !/^\d{6}$/.test(code)) {
    return false;
  }

  const normalizedEmail = normalizeEmail(email);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          // Serialize verification of this challenge before reading its state.
          // The tagged query parameterizes challengeId and normalizedEmail.
          await tx.$queryRaw`
            SELECT "id"
            FROM "OtpChallenge"
            WHERE "id" = ${challengeId}
              AND "email" = ${normalizedEmail}
            FOR UPDATE
          `;

          const challenge = await tx.otpChallenge.findUnique({
            where: { id: challengeId },
          });

          const now = new Date();

          if (
            !challenge ||
            challenge.email !== normalizedEmail ||
            challenge.consumedAt !== null ||
            challenge.expiresAt <= now ||
            challenge.attemptCount >= MAX_ATTEMPTS
          ) {
            return false;
          }

          const valid = verifyOtpCode(challenge.email, code, challenge.codeHash, secret);

          if (!valid) {
            const attempts = challenge.attemptCount + 1;

            const updated = await tx.otpChallenge.updateMany({
              where: {
                id: challenge.id,
                consumedAt: null,
                attemptCount: challenge.attemptCount,
                expiresAt: { gt: now },
              },
              data: {
                attemptCount: attempts,
                ...(attempts >= MAX_ATTEMPTS ? { consumedAt: now } : {}),
              },
            });

            if (updated.count !== 1) {
              throw new Error('OTP challenge changed during verification');
            }

            return false;
          }

          const consumed = await tx.otpChallenge.updateMany({
            where: {
              id: challenge.id,
              consumedAt: null,
              attemptCount: challenge.attemptCount,
              expiresAt: { gt: now },
            },
            data: { consumedAt: now },
          });

          return consumed.count === 1;
        },
        { isolationLevel: 'ReadCommitted' },
      );
    } catch (error: unknown) {
      if (!hasPrismaCode(error, 'P2034') || attempt === 2) {
        throw error;
      }
    }
  }

  return false;
}

/**
 * Verifies an OTP and creates an account if necessary.
 * Successful verification and account creation share one transaction.
 */
export async function verifyOtpAndGetOrCreateUser(
  challengeId: string,
  email: string,
  code: string,
) {
  const secret = env.OTP_SECRET;

  if (!secret || !/^\d{6}$/.test(code)) {
    return null;
  }

  const normalizedEmail = normalizeEmail(email);

  for (let attempt = 0; attempt < MAX_TRANSACTION_RETRIES; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          // Serialize verification of this challenge before reading its state.
          // The tagged query parameterizes challengeId and normalizedEmail.
          await tx.$queryRaw`
            SELECT "id"
            FROM "OtpChallenge"
            WHERE "id" = ${challengeId}
              AND "email" = ${normalizedEmail}
            FOR UPDATE
          `;

          const challenge = await tx.otpChallenge.findUnique({
            where: { id: challengeId },
          });

          const now = new Date();

          if (
            !challenge ||
            challenge.email !== normalizedEmail ||
            challenge.consumedAt !== null ||
            challenge.expiresAt <= now ||
            challenge.attemptCount >= MAX_ATTEMPTS
          ) {
            return null;
          }

          const valid = verifyOtpCode(challenge.email, code, challenge.codeHash, secret);

          if (!valid) {
            const attempts = challenge.attemptCount + 1;

            const updated = await tx.otpChallenge.updateMany({
              where: {
                id: challenge.id,
                consumedAt: null,
                attemptCount: challenge.attemptCount,
                expiresAt: { gt: now },
              },
              data: {
                attemptCount: attempts,
                ...(attempts >= MAX_ATTEMPTS ? { consumedAt: now } : {}),
              },
            });

            if (updated.count !== 1) {
              throw new Error('OTP challenge changed during verification');
            }

            return null;
          }

          const consumed = await tx.otpChallenge.updateMany({
            where: {
              id: challenge.id,
              consumedAt: null,
              attemptCount: challenge.attemptCount,
              expiresAt: { gt: now },
            },
            data: { consumedAt: now },
          });

          if (consumed.count !== 1) {
            return null;
          }

          const existingUser = await tx.user.findUnique({
            where: { email: normalizedEmail },
          });

          if (existingUser) {
            return existingUser;
          }

          // A failed account creation rolls back OTP consumption too.
          // The outer retry handles rare username uniqueness conflicts.
          return tx.user.create({
            data: {
              email: normalizedEmail,
              username: generateUsername(),
              name: 'New User',
              onboardingCompletedAt: null,
            },
          });
        },
        { isolationLevel: 'ReadCommitted' },
      );
    } catch (error: unknown) {
      const retryable = hasPrismaCode(error, 'P2034') || hasPrismaCode(error, 'P2002');

      if (!retryable || attempt === MAX_TRANSACTION_RETRIES - 1) {
        throw error;
      }
    }
  }

  return null;
}

export async function invalidateOtpChallenge(challengeId: string): Promise<void> {
  await prisma.otpChallenge.updateMany({
    where: {
      id: challengeId,
      consumedAt: null,
    },
    data: {
      consumedAt: new Date(),
    },
  });
}

/**
 * Verifies an OTP and returns an existing user only.
 * Never creates a new account.
 */
export async function verifyOtpAndGetExistingUser(
  challengeId: string,
  email: string,
  code: string,
) {
  const valid = await verifyOtpChallenge(challengeId, email, code);

  if (!valid) {
    return { status: 'INVALID_OTP' as const, user: null };
  }

  const user = await prisma.user.findUnique({
    where: { email: normalizeEmail(email) },
  });

  if (!user || (user.platformRole !== 'SUPER_ADMIN' && user.platformRole !== 'SITE_ADMIN')) {
    return { status: 'UNAUTHORIZED' as const, user: null };
  }

  return { status: 'AUTHORIZED' as const, user };
}
