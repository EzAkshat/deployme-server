import { Resend } from 'resend';
import { env } from '../config/env.js';

export async function sendOtpEmail(email: string, code: string): Promise<void> {
  const apiKey = env.RESEND_API_KEY;
  const from = env.RESEND_FROM;

  if (!apiKey || !from) {
    throw new Error('Email delivery is not configured');
  }

  const resend = new Resend(apiKey);

  const { error } = await resend.emails.send({
    from,
    to: email,
    subject: 'Your DeployMe sign-in code',
    text: [
      `Your DeployMe sign-in code is: ${code}`,
      '',
      'This code expires in 10 minutes and can only be used once.',
      'If you did not request this code, you can ignore this email.',
    ].join('\n'),
  });

  if (error) {
    throw new Error(`Failed to send OTP email: ${error.message}`);
  }
}

export async function sendTeamInvitationEmail(
  email: string,
  teamName: string,
  inviterName: string,
  token: string,
): Promise<void> {
  const apiKey = env.RESEND_API_KEY;
  const from = env.RESEND_FROM;

  if (!apiKey || !from) {
    throw new Error('Email delivery is not configured');
  }

  const frontendOrigin = env.FRONTEND_ORIGIN ?? 'http://localhost:3000';

  const invitationUrl = new URL('/invitations/accept', frontendOrigin);
  invitationUrl.searchParams.set('token', token);

  const resend = new Resend(apiKey);

  const { error } = await resend.emails.send({
    from,
    to: email,
    subject: `You're invited to join ${teamName} on DeployMe`,
    text: [
      `Hello,`,
      '',
      `${inviterName} has invited you to join the team "${teamName}" on DeployMe.`,
      '',
      'To accept the invitation, open this link:',
      invitationUrl.toString(),
      '',
      'This invitation expires in 7 days and can only be used once.',
      'If you were not expecting this invitation, you can ignore this email.',
    ].join('\n'),
  });

  if (error) {
    throw new Error(`Failed to send team invitation email: ${error.message}`);
  }
}
