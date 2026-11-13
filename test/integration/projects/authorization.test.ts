import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it, type TestContext } from 'node:test';

import { prisma } from '../../../src/config/database.js';
import {
  canViewProject,
  canDeployToProject,
  canManageProject,
  requireProjectPermission,
  ProjectAuthorizationError,
} from '../../../src/services/project-authorization.js';
import {
  removeTeamMember,
  leaveTeam,
} from '../../../src/services/teams.js';
import { useTestData } from '../../support/test-data.js';

describe('project authorization and membership cleanup', () => {
  const data = useTestData();

  async function permissions(userId: number, projectId: string) {
    const [view, deploy, manage] = await Promise.all([
      canViewProject(userId, projectId),
      canDeployToProject(userId, projectId),
      canManageProject(userId, projectId),
    ]);

    return { view, deploy, manage };
  }

  const denied = { view: false, deploy: false, manage: false };
  const fullAccess = { view: true, deploy: true, manage: true };

  async function fixture(t: TestContext) {
    const owner = await data.createUser({ prefix: 'permission_owner' });
    const member = await data.createUser({ prefix: 'permission_member' });
    const manager = await data.createUser({ prefix: 'permission_manager' });

    const team = await prisma.team.create({
      data: {
        name: 'Authorization test team',
        slug: `auth-team-${randomUUID()}`,
      },
    });

    data.trackTeam(team.id);

    await prisma.teamMembership.createMany({
      data: [
        { teamId: team.id, userId: owner.id, role: 'OWNER' },
        { teamId: team.id, userId: member.id, role: 'MEMBER' },
        { teamId: team.id, userId: manager.id, role: 'MANAGER' },
      ],
    });

    const projectIds: string[] = [];

    // Per-test cleanup runs before useTestData removes teams and users.
    t.after(async () => {
      if (projectIds.length === 0) return;

      await prisma.projectShare.deleteMany({
        where: { projectId: { in: projectIds } },
      });

      await prisma.project.deleteMany({
        where: { id: { in: projectIds } },
      });
    });

    async function createProject(personal = false) {
      const project = await prisma.project.create({
        data: {
          name: 'Authorization test project',
          slug: `auth-project-${randomUUID()}`,
          teamId: personal ? null : team.id,
          ownerUserId: personal ? owner.id : null,
          rootDirectory: '.',
          installCommand: '',
          buildCommand: '',
          outputDirectory: '.',
          spaFallback: false,
        },
      });

      projectIds.push(project.id);
      return project;
    }

    const project = await createProject();

    async function grant(
      userId: number,
      flags = { canView: true, canDeploy: true, canManage: true },
    ) {
      return prisma.projectShare.upsert({
        where: {
          projectId_userId: { projectId: project.id, userId },
        },
        create: {
          projectId: project.id,
          userId,
          grantedByUserId: owner.id,
          ...flags,
        },
        update: flags,
      });
    }

    return { owner, member, manager, team, project, grant, createProject };
  }

  it('requires explicit deployment grants for owners and managers', async (t) => {
    const f = await fixture(t);

    for (const user of [f.owner, f.manager]) {
      assert.deepEqual(await permissions(user.id, f.project.id), {
        view: true,
        deploy: false,
        manage: true,
      });

      await f.grant(user.id);

      assert.deepEqual(
        await permissions(user.id, f.project.id),
        fullAccess,
      );
    }
  });

  it('honors member grants and revokes access when the share is deleted', async (t) => {
    const f = await fixture(t);

    assert.deepEqual(await permissions(f.member.id, f.project.id), denied);

    await f.grant(f.member.id, {
      canView: true,
      canDeploy: false,
      canManage: false,
    });

    assert.deepEqual(await permissions(f.member.id, f.project.id), {
      view: true,
      deploy: false,
      manage: false,
    });

    await f.grant(f.member.id);

    assert.deepEqual(
      await permissions(f.member.id, f.project.id),
      fullAccess,
    );

    await prisma.projectShare.deleteMany({
      where: { projectId: f.project.id, userId: f.member.id },
    });

    assert.deepEqual(await permissions(f.member.id, f.project.id), denied);

    await assert.rejects(
      () => requireProjectPermission(f.member.id, f.project.id, 'VIEW'),
      (error: unknown) =>
        error instanceof ProjectAuthorizationError &&
        error.code === 'PROJECT_ACCESS_DENIED',
    );
  });

  it('rejects a stale share when team membership no longer exists', async (t) => {
    const f = await fixture(t);

    await f.grant(f.member.id);

    // Deliberately bypass normal cleanup to simulate a leftover share.
    await prisma.teamMembership.deleteMany({
      where: { teamId: f.team.id, userId: f.member.id },
    });

    assert.equal(
      await prisma.projectShare.count({
        where: { projectId: f.project.id, userId: f.member.id },
      }),
      1,
    );

    assert.deepEqual(await permissions(f.member.id, f.project.id), denied);
  });

  it('removes shares with membership and does not restore them on rejoining', async (t) => {
    const f = await fixture(t);

    await f.grant(f.member.id);

    const result = await removeTeamMember(
      f.team.id,
      f.owner.id,
      f.member.id,
    );

    assert.equal(result.removedProjectShares, 1);

    assert.equal(
      await prisma.teamMembership.count({
        where: { teamId: f.team.id, userId: f.member.id },
      }),
      0,
    );

    assert.equal(
      await prisma.projectShare.count({
        where: { projectId: f.project.id, userId: f.member.id },
      }),
      0,
    );

    assert.deepEqual(await permissions(f.member.id, f.project.id), denied);

    // Recreate membership to isolate the permission behavior from invitations.
    await prisma.teamMembership.create({
      data: {
        teamId: f.team.id,
        userId: f.member.id,
        role: 'MEMBER',
      },
    });

    assert.deepEqual(await permissions(f.member.id, f.project.id), denied);

    await f.grant(f.member.id);

    assert.deepEqual(
      await permissions(f.member.id, f.project.id),
      fullAccess,
    );
  });

  it('cleans project shares when a member leaves voluntarily', async (t) => {
    const f = await fixture(t);

    await f.grant(f.member.id);
    await leaveTeam(f.team.id, f.member.id);

    assert.equal(
      await prisma.teamMembership.count({
        where: { teamId: f.team.id, userId: f.member.id },
      }),
      0,
    );

    assert.equal(
      await prisma.projectShare.count({
        where: { projectId: f.project.id, userId: f.member.id },
      }),
      0,
    );

    assert.deepEqual(await permissions(f.member.id, f.project.id), denied);
  });

  it('denies all permissions on archived projects', async (t) => {
    const f = await fixture(t);

    await f.grant(f.member.id);
    await f.grant(f.owner.id);

    await prisma.project.update({
      where: { id: f.project.id },
      data: { archivedAt: new Date() },
    });

    for (const user of [f.owner, f.manager, f.member]) {
      assert.deepEqual(await permissions(user.id, f.project.id), denied);
    }
  });

  it('restricts personal projects to their owner and denies missing projects', async (t) => {
    const f = await fixture(t);
    const personal = await f.createProject(true);

    assert.deepEqual(
      await permissions(f.owner.id, personal.id),
      fullAccess,
    );

    for (const user of [f.manager, f.member]) {
      assert.deepEqual(await permissions(user.id, personal.id), denied);
    }

    assert.deepEqual(
      await permissions(f.owner.id, `missing-${randomUUID()}`),
      denied,
    );

    await prisma.project.update({
      where: { id: personal.id },
      data: { archivedAt: new Date() },
    });

    assert.deepEqual(await permissions(f.owner.id, personal.id), denied);
  });
});