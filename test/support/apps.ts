import assert from 'node:assert/strict';
import express, { type Express } from 'express';
import { adminRouter } from '../../src/routes/admin.js';
import { createAuthRouter } from '../../src/routes/auth.js';
import { createTeamsRouter } from '../../src/routes/teams.js';
import { deliverRealInvitationIfConfigured } from './real-email.js';
import type { SentInvitation, SentOtp } from './types.js';

export interface TestAppOptions {
  /** Mount the teams router at /teams. */
  mountTeams?: boolean;
  /** Mount the admin router at /admin. */
  mountAdmin?: boolean;
  /** Runs after an OTP is captured. Throw to simulate an email provider failure. */
  onSendOtp?: (otp: SentOtp) => Promise<void> | void;
}

export interface TestApp {
  app: Express;
  sentOtps: SentOtp[];
  sentInvitations: SentInvitation[];
  /** The most recent OTP "emailed" to this address. */
  codeFor(email: string): string;
  /** The most recent invitation token "emailed" to this address. */
  invitationTokenFor(email: string): string;
}

function lastSentTo<T extends { email: string }>(items: T[], email: string): T | undefined {
  const normalized = email.trim().toLowerCase();

  return [...items].reverse().find((item) => item.email === normalized);
}

/**
 * Builds an Express app with the real routers but a mocked email sender.
 * OTP codes and invitation tokens are captured instead of being emailed, so
 * tests can complete the sign-in and invitation flows.
 */
export function createTestApp(options: TestAppOptions = {}): TestApp {
  const sentOtps: SentOtp[] = [];
  const sentInvitations: SentInvitation[] = [];

  const app = express();
  app.use(express.json());

  app.use(
    '/auth',
    createAuthRouter(async (email, code) => {
      const otp = { email, code };

      sentOtps.push(otp);
      await options.onSendOtp?.(otp);
    }),
  );

  if (options.mountAdmin) {
    app.use('/admin', adminRouter);
  }

  if (options.mountTeams) {
    app.use(
      '/teams',
      createTeamsRouter(async (email, teamName, inviterName, token) => {
        const invitation = { email, teamName, inviterName, token };

        sentInvitations.push(invitation);
        await deliverRealInvitationIfConfigured(invitation);
      }),
    );
  }

  return {
    app,
    sentOtps,
    sentInvitations,
    codeFor(email) {
      const otp = lastSentTo(sentOtps, email);

      assert.ok(otp, `The test OTP sender should capture the code for ${email}.`);

      return otp.code;
    },
    invitationTokenFor(email) {
      const invitation = lastSentTo(sentInvitations, email);

      assert.ok(invitation, `The test invitation sender should capture the token for ${email}.`);

      return invitation.token;
    },
  };
}
