import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import express from 'express';
import request from 'supertest';

import { prisma } from '../src/config/database.js';
import { createAuthRouter } from '../src/routes/auth.js';
import { createTeamsRouter } from '../src/routes/teams.js';
import { sendTeamInvitationEmail } from '../src/services/email.js';

const TRUSTED_ORIGIN = 'http://localhost:3000';
const SESSION_COOKIE_NAME = 'deployme_session';

// Optional: set REAL_TEST_EMAIL to ALSO send the member's invitation as a real
// email through Resend. Leave it unset and the whole test stays fully mocked.
//
//   REAL_TEST_EMAIL=you@gmail.com node --import tsx --test tests/teams.test.ts
//
// With Resend in testing mode this must be the email your Resend account was
// created with.
const REAL_TEST_EMAIL = process.env.REAL_TEST_EMAIL?.trim().toLowerCase();

const otpCodes = new Map<string, string>();
const invitationTokens = new Map<string, string>();
const testEmails = new Set<string>();
const createdTeamIds = new Set<string>();

const testApp = express();

testApp.use(express.json());

// Auth OTP is always mocked.
testApp.use(
  '/auth',
  createAuthRouter(async (email, code) => {
    otpCodes.set(email, code);
  }),
);

// Invitation sender: always captures the token so the test can accept the
// invite. Only the REAL_TEST_EMAIL address also gets a real email.
testApp.use(
  '/teams',
  createTeamsRouter(async (email, teamName, inviterName, token) => {
    invitationTokens.set(email, token);

    if (REAL_TEST_EMAIL && email === REAL_TEST_EMAIL) {
      try {
        await sendTeamInvitationEmail(email, teamName, inviterName, token);
        console.log(`[teams.test] Real invitation email sent to ${email}`);
      } catch (error) {
        // Don't fail the test over delivery; the logic under test is separate.
        console.warn(
          `[teams.test] Real invitation email to ${email} failed:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }),
);

async function signIn(emailInput: string): Promise<string> {
  const email = emailInput.trim().toLowerCase();

  // Never schedule a real address for deletion in the cleanup hook below.
  if (email !== REAL_TEST_EMAIL) {
    testEmails.add(email);
  }

  const otpResponse = await request(testApp)
    .post('/auth/request-otp')
    .set('Origin', TRUSTED_ORIGIN)
    .send({ email });

  assert.equal(
    otpResponse.status,
    200,
    `OTP request failed for ${email}: ${JSON.stringify(otpResponse.body)}`,
  );

  const challengeId: unknown = otpResponse.body.challengeId;

  assert.ok(
    typeof challengeId === 'string' && challengeId.length > 0,
    `OTP request should return a challenge ID. Response: ${JSON.stringify(otpResponse.body)}`,
  );

  const code = otpCodes.get(email);

  assert.ok(code, `The test OTP sender should capture the code for ${email}.`);

  const verifyResponse = await request(testApp)
    .post('/auth/verify-otp')
    .set('Origin', TRUSTED_ORIGIN)
    .send({ challengeId, email, code });

  assert.equal(
    verifyResponse.status,
    200,
    `OTP verification failed for ${email}: ${JSON.stringify(verifyResponse.body)}`,
  );

  const setCookieHeader = verifyResponse.headers['set-cookie'];

  const cookieHeaders = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : setCookieHeader
      ? [setCookieHeader]
      : [];

  const sessionCookie = cookieHeaders.find((cookie) =>
    cookie.startsWith(`${SESSION_COOKIE_NAME}=`),
  );

  assert.ok(sessionCookie, `Successful verification for ${email} should set a session cookie.`);

  return sessionCookie.split(';')[0];
}

after(async () => {
  try {
    const teamIds = [...createdTeamIds];
    const emails = [...testEmails];

    if (teamIds.length > 0) {
      await prisma.team.deleteMany({
        where: { id: { in: teamIds } },
      });
    }

    if (emails.length > 0) {
      await prisma.otpChallenge.deleteMany({
        where: { email: { in: emails } },
      });

      await prisma.user.deleteMany({
        where: { email: { in: emails } },
      });
    }
  } finally {
    await prisma.$disconnect();
  }
});

test('team creation, invitations, membership, and access control work', async () => {
  const uniqueId = randomUUID();

  const ownerEmail = `team-owner-${uniqueId}@example.com`;
  // The invited member is your real address when REAL_TEST_EMAIL is set.
  const memberEmail = REAL_TEST_EMAIL ?? `team-member-${uniqueId}@example.com`;
  const outsiderEmail = `team-outsider-${uniqueId}@example.com`;

  // 1. The owner signs in and creates a team.
  const ownerCookie = await signIn(ownerEmail);

  const createTeamResponse = await request(testApp)
    .post('/teams')
    .set('Cookie', ownerCookie)
    .set('Origin', TRUSTED_ORIGIN)
    .send({
      name: `Test Team ${uniqueId}`,
      slug: `test-team-${uniqueId}`,
    });

  assert.equal(
    createTeamResponse.status,
    201,
    `Team creation failed: ${JSON.stringify(createTeamResponse.body)}`,
  );

  assert.ok(
    createTeamResponse.body.team?.id,
    `Team creation response did not include a team ID: ${JSON.stringify(createTeamResponse.body)}`,
  );

  const teamId = createTeamResponse.body.team.id as string;
  createdTeamIds.add(teamId);

  assert.equal(createTeamResponse.body.team.role, 'OWNER');

  // 2. Confirm the owner can see their team.
  const listTeamsResponse = await request(testApp).get('/teams').set('Cookie', ownerCookie);

  assert.equal(
    listTeamsResponse.status,
    200,
    `Listing teams failed: ${JSON.stringify(listTeamsResponse.body)}`,
  );

  assert.ok(
    listTeamsResponse.body.teams.some((team: { id: string }) => team.id === teamId),
    'The owner should see the team they created.',
  );

  // 3. Invite a member. Mocked unless REAL_TEST_EMAIL is set.
  const inviteResponse = await request(testApp)
    .post(`/teams/${teamId}/invitations`)
    .set('Cookie', ownerCookie)
    .set('Origin', TRUSTED_ORIGIN)
    .send({
      email: memberEmail,
      role: 'MEMBER',
    });

  assert.equal(
    inviteResponse.status,
    201,
    `Creating invitation failed: ${JSON.stringify(inviteResponse.body)}`,
  );

  assert.equal(inviteResponse.body.invitation?.status, 'PENDING');
  assert.ok(inviteResponse.body.invitation?.id);

  assert.equal(
    JSON.stringify(inviteResponse.body).includes('tokenHash'),
    false,
    'The invitation response must not expose the token hash.',
  );

  const invitationId = inviteResponse.body.invitation.id as string;
  const invitationToken = invitationTokens.get(memberEmail);

  assert.ok(invitationToken, 'The mock sender should capture the invitation token.');

  // 4. Confirm the owner can list invitations.
  const listInvitationsResponse = await request(testApp)
    .get(`/teams/${teamId}/invitations`)
    .set('Cookie', ownerCookie);

  assert.equal(
    listInvitationsResponse.status,
    200,
    `Listing invitations failed: ${JSON.stringify(listInvitationsResponse.body)}`,
  );

  assert.ok(
    listInvitationsResponse.body.invitations.some(
      (invitation: { id: string }) => invitation.id === invitationId,
    ),
    'The owner should see the invitation they created.',
  );

  // 5. The invited user signs in and accepts the invitation.
  const memberCookie = await signIn(memberEmail);

  const acceptResponse = await request(testApp)
    .post('/teams/invitations/accept')
    .set('Cookie', memberCookie)
    .set('Origin', TRUSTED_ORIGIN)
    .send({ token: invitationToken });

  assert.equal(
    acceptResponse.status,
    200,
    `Accepting invitation failed: ${JSON.stringify(acceptResponse.body)}`,
  );

  // The route wraps the result in a `membership` object.
  assert.equal(acceptResponse.body.membership?.role, 'MEMBER');
  assert.equal(acceptResponse.body.membership?.teamId, teamId);

  // 6. Confirm the new member appears in the team.
  const listMembersResponse = await request(testApp)
    .get(`/teams/${teamId}/members`)
    .set('Cookie', ownerCookie);

  assert.equal(
    listMembersResponse.status,
    200,
    `Listing team members failed: ${JSON.stringify(listMembersResponse.body)}`,
  );

  // The members endpoint returns { role, user: { id, username, name } }
  // and deliberately does not expose emails, so match on the user ID.
  const memberUser = await prisma.user.findUnique({
    where: { email: memberEmail },
    select: { id: true },
  });

  assert.ok(memberUser, 'The member user should exist in the database.');

  assert.ok(
    listMembersResponse.body.members.some(
      (membership: { role: string; user: { id: number } }) =>
        membership.role === 'MEMBER' && membership.user.id === memberUser.id,
    ),
    'The accepted member should appear in the team membership list.',
  );

  // 7. A regular member cannot invite another user.
  const unauthorizedInviteResponse = await request(testApp)
    .post(`/teams/${teamId}/invitations`)
    .set('Cookie', memberCookie)
    .set('Origin', TRUSTED_ORIGIN)
    .send({
      email: `another-user-${uniqueId}@example.com`,
      role: 'MEMBER',
    });

  assert.equal(
    unauthorizedInviteResponse.status,
    404,
    `A regular member should not be able to invite users: ${JSON.stringify(unauthorizedInviteResponse.body)}`,
  );

  // 8. A user outside the team cannot access its members.
  const outsiderCookie = await signIn(outsiderEmail);

  const outsiderMembersResponse = await request(testApp)
    .get(`/teams/${teamId}/members`)
    .set('Cookie', outsiderCookie);

  assert.equal(
    outsiderMembersResponse.status,
    404,
    `A non-member should not access team members: ${JSON.stringify(outsiderMembersResponse.body)}`,
  );
});
