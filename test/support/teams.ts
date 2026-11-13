import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { TestApp } from './apps.js';
import { signIn } from './auth-flow.js';
import { TRUSTED_ORIGIN } from './constants.js';
import { expectStatus } from './http.js';
import type { TestData } from './test-data.js';

export interface TeamFixture {
  id: string;
  name: string;
  ownerEmail: string;
  ownerCookie: string;
}

/** Creates a team through the API as `cookie`'s user and registers it for cleanup. */
export async function createTeam(testApp: TestApp, data: TestData, cookie: string) {
  const uniqueId = randomUUID();
  const name = `Test Team ${uniqueId}`;

  const response = await request(testApp.app)
    .post('/teams')
    .set('Cookie', cookie)
    .set('Origin', TRUSTED_ORIGIN)
    .send({ name, slug: `test-team-${uniqueId}` });

  expectStatus(response, 201, 'Team creation');

  const teamId: unknown = response.body.team?.id;

  assert.ok(
    typeof teamId === 'string',
    `Team creation response did not include a team ID: ${JSON.stringify(response.body)}`,
  );

  data.trackTeam(teamId);

  return { id: teamId, name, response };
}

/** Signs in a brand-new user and has them create a team. */
export async function createTeamWithOwner(testApp: TestApp, data: TestData): Promise<TeamFixture> {
  const ownerEmail = data.newEmail('team-owner');
  const { cookie: ownerCookie } = await signIn(testApp, ownerEmail);
  const team = await createTeam(testApp, data, ownerCookie);

  return { id: team.id, name: team.name, ownerEmail, ownerCookie };
}

export function postInvitation(
  testApp: TestApp,
  cookie: string,
  teamId: string,
  email: string,
  role = 'MEMBER',
) {
  return request(testApp.app)
    .post(`/teams/${teamId}/invitations`)
    .set('Cookie', cookie)
    .set('Origin', TRUSTED_ORIGIN)
    .send({ email, role });
}

/**
 * Invites a user to the team, signs them in and accepts the invitation.
 * Pass `email` to use a specific address (e.g. REAL_TEST_EMAIL); otherwise a
 * unique tracked address is generated.
 */
export async function addMemberToTeam(
  testApp: TestApp,
  data: TestData,
  team: Pick<TeamFixture, 'id' | 'ownerCookie'>,
  email: string = data.newEmail('team-member'),
) {
  const inviteResponse = await postInvitation(testApp, team.ownerCookie, team.id, email);

  expectStatus(inviteResponse, 201, 'Creating invitation');

  const token = testApp.invitationTokenFor(email);
  const member = await signIn(testApp, email);

  const acceptResponse = await request(testApp.app)
    .post('/teams/invitations/accept')
    .set('Cookie', member.cookie)
    .set('Origin', TRUSTED_ORIGIN)
    .send({ token });

  expectStatus(acceptResponse, 200, 'Accepting invitation');

  return { email, cookie: member.cookie, acceptResponse };
}
