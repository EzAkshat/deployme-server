import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import request from 'supertest';
import { prisma } from '../../../src/config/database.js';
import { createTestApp } from '../../support/apps.js';
import { signIn } from '../../support/auth-flow.js';
import { expectStatus } from '../../support/http.js';
import { REAL_TEST_EMAIL } from '../../support/real-email.js';
import { addMemberToTeam, createTeamWithOwner, type TeamFixture } from '../../support/teams.js';
import { useTestData } from '../../support/test-data.js';

describe('team membership', () => {
  const data = useTestData();
  const testApp = createTestApp({ mountTeams: true });
  let team: TeamFixture;

  before(async () => {
    team = await createTeamWithOwner(testApp, data);
  });

  it('accepting an invitation adds the user as a MEMBER', async () => {
    // Uses REAL_TEST_EMAIL when set, so the invitation is also emailed for real.
    const member = await addMemberToTeam(testApp, data, team, REAL_TEST_EMAIL);

    // The route wraps the result in a `membership` object.
    assert.equal(member.acceptResponse.body.membership?.role, 'MEMBER');
    assert.equal(member.acceptResponse.body.membership?.teamId, team.id);
  });

  it('shows an accepted member in the team member list', async () => {
    const member = await addMemberToTeam(testApp, data, team);

    const response = await request(testApp.app)
      .get(`/teams/${team.id}/members`)
      .set('Cookie', team.ownerCookie);

    expectStatus(response, 200, 'Listing team members');

    // The members endpoint returns { role, user: { id, username, name } } and
    // deliberately does not expose emails, so match on the user ID.
    const memberUser = await prisma.user.findUnique({
      where: { email: member.email },
      select: { id: true },
    });

    assert.ok(memberUser, 'The member user should exist in the database.');
    assert.ok(
      response.body.members.some(
        (membership: { role: string; user: { id: number } }) =>
          membership.role === 'MEMBER' && membership.user.id === memberUser.id,
      ),
      'The accepted member should appear in the team membership list.',
    );
  });

  it('does not let a non-member see the team members', async () => {
    const outsider = await signIn(testApp, data.newEmail('team-outsider'));

    const response = await request(testApp.app)
      .get(`/teams/${team.id}/members`)
      .set('Cookie', outsider.cookie);

    expectStatus(response, 404, 'A non-member accessing team members');
  });
});
