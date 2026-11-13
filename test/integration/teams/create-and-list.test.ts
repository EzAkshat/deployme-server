import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import request from 'supertest';
import { createTestApp } from '../../support/apps.js';
import { signIn } from '../../support/auth-flow.js';
import { expectStatus } from '../../support/http.js';
import { createTeam } from '../../support/teams.js';
import { useTestData } from '../../support/test-data.js';

describe('creating and listing teams', () => {
  const data = useTestData();
  const testApp = createTestApp({ mountTeams: true });
  let ownerCookie = '';

  before(async () => {
    ownerCookie = (await signIn(testApp, data.newEmail('team-owner'))).cookie;
  });

  it('creates a team and makes the creator its OWNER', async () => {
    const team = await createTeam(testApp, data, ownerCookie);

    assert.equal(team.response.body.team.role, 'OWNER');
  });

  it('lists the team for its owner', async () => {
    const team = await createTeam(testApp, data, ownerCookie);

    const response = await request(testApp.app).get('/teams').set('Cookie', ownerCookie);

    expectStatus(response, 200, 'Listing teams');
    assert.ok(
      response.body.teams.some((item: { id: string }) => item.id === team.id),
      'The owner should see the team they created.',
    );
  });
});
