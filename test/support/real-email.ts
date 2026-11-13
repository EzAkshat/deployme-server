import { sendTeamInvitationEmail } from '../../src/services/email.js';
import type { SentInvitation } from './types.js';

/**
 * Optional: set REAL_TEST_EMAIL to ALSO send the invitation as a real email
 * through Resend when the invited address matches. Leave it unset and every
 * test stays fully mocked.
 *
 *   REAL_TEST_EMAIL=you@gmail.com node --env-file-if-exists=.env --import tsx \
 *     --test tests/integration/teams/membership.test.ts
 *
 * With Resend in testing mode this must be the email your Resend account was
 * created with.
 */
export const REAL_TEST_EMAIL = process.env.REAL_TEST_EMAIL?.trim().toLowerCase() || undefined;

export async function deliverRealInvitationIfConfigured(invitation: SentInvitation): Promise<void> {
  if (!REAL_TEST_EMAIL || invitation.email !== REAL_TEST_EMAIL) {
    return;
  }

  try {
    await sendTeamInvitationEmail(
      invitation.email,
      invitation.teamName,
      invitation.inviterName,
      invitation.token,
    );
    console.log(`[tests] Real invitation email sent to ${invitation.email}`);
  } catch (error) {
    // Don't fail the test over delivery; the logic under test is separate.
    console.warn(
      `[tests] Real invitation email to ${invitation.email} failed:`,
      error instanceof Error ? error.message : error,
    );
  }
}
