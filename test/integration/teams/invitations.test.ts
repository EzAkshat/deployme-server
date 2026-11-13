import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import request from 'supertest';
import { createTestApp } from '../../support/apps.js';
import { expectStatus } from '../../support/http.js';
import {
  addMemberToTeam,
  createTeamWithOwner,
  postInvitation,
  type TeamFixture,
} from '../../support/teams.js';
import { useTestData } from '../../support/test-data.js';

describe('team invitations', () => {
  const data = useTestData();
  const testApp = createTestApp({ mountTeams: true });
  let team: TeamFixture;

  before(async () => {
    team = await createTeamWithOwner(testApp, data);
  });

  it('lets an owner invite a member without exposing the token hash', async () => {
    const memberEmail = data.newEmail('team-member');

    const response = await postInvitation(testApp, team.ownerCookie, team.id, memberEmail);

    expectStatus(response, 201, 'Creating invitation');
    assert.equal(response.body.invitation?.status, 'PENDING');
    assert.ok(response.body.invitation?.id);
    assert.equal(
      JSON.stringify(response.body).includes('tokenHash'),
      false,
      'The invitation response must not expose the token hash.',
    );
    assert.ok(
      testApp.invitationTokenFor(memberEmail),
      'The mock sender should capture the invitation token.',
    );
  });

  it('lets an owner list the invitations they created', async () => {
    const created = await postInvitation(
      testApp,
      team.ownerCookie,
      team.id,
      data.newEmail('team-member'),
    );

    expectStatus(created, 201, 'Creating invitation');

    const invitationId = created.body.invitation.id as string;

    const response = await request(testApp.app)
      .get(`/teams/${team.id}/invitations`)
      .set('Cookie', team.ownerCookie);

    expectStatus(response, 200, 'Listing invitations');
    assert.ok(
      response.body.invitations.some(
        (invitation: { id: string }) => invitation.id === invitationId,
      ),
      'The owner should see the invitation they created.',
    );
  });

  it('does not let a regular member invite other users', async () => {
    const member = await addMemberToTeam(testApp, data, team);

    const response = await postInvitation(
      testApp,
      member.cookie,
      team.id,
      data.newEmail('another-user'),
    );

    expectStatus(response, 404, 'A regular member inviting users');
  });
});
