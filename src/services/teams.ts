import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '../config/database.js';
import { logger } from '../config/logger.js';
import { sendTeamInvitationEmail } from './email.js';
import type { Prisma } from '../generated/prisma/client.js';
import { lockTeamForMutation } from './team-lock.js';

export interface CreateTeamInput {
  name: string;
  slug: string;
}

export type InvitationRole = 'MANAGER' | 'MEMBER';

export class TeamServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TeamServiceError';
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function requireTeamManager(
  teamId: string,
  userId: number,
  db: Prisma.TransactionClient = prisma,
) {
  const membership = await db.teamMembership.findFirst({
    where: {
      teamId,
      userId,
      role: { in: ['OWNER', 'MANAGER'] },
    },
    include: {
      team: true,
      user: true,
    },
  });

  if (!membership) {
    throw new TeamServiceError(
      'TEAM_ACCESS_DENIED',
      'The team was not found or you cannot manage it.',
    );
  }

  return membership;
}

async function requireTeamMember(teamId: string, userId: number) {
  const membership = await prisma.teamMembership.findUnique({
    where: {
      teamId_userId: { teamId, userId },
    },
  });

  if (!membership) {
    throw new TeamServiceError(
      'TEAM_ACCESS_DENIED',
      'The team was not found or you are not a member.',
    );
  }
}

export async function createTeam(userId: number, input: CreateTeamInput) {
  return prisma.$transaction(async (tx) => {
    const team = await tx.team.create({
      data: {
        name: input.name,
        slug: input.slug,
      },
    });

    await tx.teamMembership.create({
      data: {
        teamId: team.id,
        userId,
        role: 'OWNER',
      },
    });

    return {
      ...team,
      role: 'OWNER' as const,
    };
  });
}

export async function listUserTeams(userId: number) {
  const memberships = await prisma.teamMembership.findMany({
    where: { userId },
    include: { team: true },
    orderBy: { joinedAt: 'asc' },
  });

  return memberships.map(({ team, role, joinedAt }) => ({
    id: team.id,
    name: team.name,
    slug: team.slug,
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
    role,
    joinedAt,
  }));
}

export async function createTeamInvitation(
  teamId: string,
  inviterUserId: number,
  emailInput: string,
  role: InvitationRole,
  sendInvitationEmail: typeof sendTeamInvitationEmail = sendTeamInvitationEmail,
) {
  const email = normalizeEmail(emailInput);
  const token = randomBytes(32).toString('hex');
  const tokenHash = hashInvitationToken(token);

  const prepared = await prisma.$transaction(async (tx) => {
    await lockTeamForMutation(tx, teamId);

    const manager = await requireTeamManager(teamId, inviterUserId, tx);
    const now = new Date();

    const existingUser = await tx.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (existingUser) {
      const existingMembership = await tx.teamMembership.findUnique({
        where: {
          teamId_userId: {
            teamId,
            userId: existingUser.id,
          },
        },
        select: { id: true },
      });

      if (existingMembership) {
        throw new TeamServiceError('ALREADY_MEMBER', 'This user is already a member of the team.');
      }
    }

    const pending = await tx.teamInvitation.findFirst({
      where: {
        teamId,
        email,
        status: 'PENDING',
        expiresAt: { gt: now },
      },
      select: { id: true },
    });

    if (pending) {
      throw new TeamServiceError(
        'INVITATION_EXISTS',
        'A pending invitation already exists for this email.',
      );
    }

    const invitation = await tx.teamInvitation.create({
      data: {
        teamId,
        email,
        role,
        tokenHash,
        invitedByUserId: inviterUserId,
        expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000),
      },
      select: {
        id: true,
        teamId: true,
        email: true,
        role: true,
        status: true,
        createdAt: true,
        expiresAt: true,
      },
    });

    return {
      invitation,
      teamName: manager.team.name,
      inviterName: manager.user.name,
    };
  });

  try {
    await sendInvitationEmail(email, prepared.teamName, prepared.inviterName, token);
  } catch (error) {
    logger.error(
      { err: error, teamId, invitationId: prepared.invitation.id },
      'Invitation email failed',
    );

    await prisma.teamInvitation.updateMany({
      where: {
        id: prepared.invitation.id,
        status: 'PENDING',
      },
      data: {
        status: 'REVOKED',
        revokedAt: new Date(),
      },
    });

    throw new TeamServiceError(
      'EMAIL_DELIVERY_FAILED',
      'The invitation email could not be sent. Please try again.',
    );
  }

  return prepared.invitation;
}

export async function listTeamInvitations(teamId: string, userId: number) {
  await requireTeamManager(teamId, userId);

  return prisma.teamInvitation.findMany({
    where: { teamId },
    select: {
      id: true,
      email: true,
      role: true,
      status: true,
      createdAt: true,
      expiresAt: true,
      acceptedAt: true,
      revokedAt: true,
      invitedBy: {
        select: {
          id: true,
          name: true,
          username: true,
        },
      },
      acceptedBy: {
        select: {
          id: true,
          name: true,
          username: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function acceptTeamInvitation(userId: number, emailInput: string, token: string) {
  const tokenHash = hashInvitationToken(token);
  const email = normalizeEmail(emailInput);

  // Locate the team before taking its lock.
  const initial = await prisma.teamInvitation.findUnique({
    where: { tokenHash },
    select: { teamId: true },
  });

  if (!initial) {
    throw new TeamServiceError(
      'INVITATION_NOT_FOUND',
      'The invitation is invalid or no longer available.',
    );
  }

  return prisma.$transaction(async (tx) => {
    await lockTeamForMutation(tx, initial.teamId);

    const now = new Date();
    const invitation = await tx.teamInvitation.findUnique({
      where: { tokenHash },
      include: { team: true },
    });

    if (!invitation || invitation.teamId !== initial.teamId) {
      throw new TeamServiceError(
        'INVITATION_NOT_FOUND',
        'The invitation is invalid or no longer available.',
      );
    }

    if (invitation.status !== 'PENDING') {
      throw new TeamServiceError('INVITATION_NOT_PENDING', 'This invitation is no longer pending.');
    }

    if (invitation.expiresAt <= now) {
      throw new TeamServiceError('INVITATION_EXPIRED', 'This invitation has expired.');
    }

    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    if (
      !user ||
      normalizeEmail(user.email) !== email ||
      normalizeEmail(invitation.email) !== email
    ) {
      throw new TeamServiceError(
        'INVITATION_EMAIL_MISMATCH',
        'Sign in using the email address that received this invitation.',
      );
    }

    const existingMembership = await tx.teamMembership.findUnique({
      where: {
        teamId_userId: {
          teamId: invitation.teamId,
          userId,
        },
      },
      select: { id: true },
    });

    if (existingMembership) {
      throw new TeamServiceError('ALREADY_MEMBER', 'You are already a member of this team.');
    }

    const claimed = await tx.teamInvitation.updateMany({
      where: {
        id: invitation.id,
        status: 'PENDING',
        expiresAt: { gt: now },
      },
      data: {
        status: 'ACCEPTED',
        acceptedAt: now,
        acceptedByUserId: userId,
      },
    });

    if (claimed.count !== 1) {
      throw new TeamServiceError(
        'INVITATION_NOT_PENDING',
        'This invitation was already used or has expired.',
      );
    }

    // Rejoining never restores grants from an earlier membership.
    await tx.projectShare.deleteMany({
      where: {
        userId,
        project: { teamId: invitation.teamId },
      },
    });

    const membership = await tx.teamMembership.create({
      data: {
        teamId: invitation.teamId,
        userId,
        role: invitation.role,
      },
      select: { joinedAt: true },
    });

    return {
      teamId: invitation.team.id,
      teamName: invitation.team.name,
      role: invitation.role,
      joinedAt: membership.joinedAt,
    };
  });
}

export async function revokeTeamInvitation(teamId: string, invitationId: string, userId: number) {
  return prisma.$transaction(async (tx) => {
    await lockTeamForMutation(tx, teamId);
    await requireTeamManager(teamId, userId, tx);

    const now = new Date();

    const result = await tx.teamInvitation.updateMany({
      where: {
        id: invitationId,
        teamId,
        status: 'PENDING',
        expiresAt: { gt: now },
      },
      data: {
        status: 'REVOKED',
        revokedAt: now,
      },
    });

    if (result.count !== 1) {
      throw new TeamServiceError(
        'INVITATION_NOT_FOUND_OR_PENDING',
        'The invitation was not found or is no longer pending.',
      );
    }

    return { id: invitationId, status: 'REVOKED' as const };
  });
}

export async function listTeamMembers(teamId: string, userId: number) {
  await requireTeamMember(teamId, userId);

  return prisma.teamMembership.findMany({
    where: { teamId },
    select: {
      id: true,
      role: true,
      joinedAt: true,
      user: {
        select: {
          id: true,
          username: true,
          name: true,
        },
      },
    },
    orderBy: { joinedAt: 'asc' },
  });
}
async function removeMembership(
  teamId: string,
  actorUserId: number,
  targetUserId: number,
  leaving: boolean,
) {
  return prisma.$transaction(async (tx) => {
    await lockTeamForMutation(tx, teamId);

    const actor = await tx.teamMembership.findUnique({
      where: {
        teamId_userId: { teamId, userId: actorUserId },
      },
    });

    if (!actor) {
      throw new TeamServiceError(
        'TEAM_ACCESS_DENIED',
        'The team was not found or you are not a member.',
      );
    }

    if (
      !leaving &&
      actor.role !== 'OWNER' &&
      actor.role !== 'MANAGER'
    ) {
      throw new TeamServiceError(
        'MEMBER_REMOVE_DENIED',
        'You do not have permission to remove team members.',
      );
    }

    const target = await tx.teamMembership.findUnique({
      where: {
        teamId_userId: { teamId, userId: targetUserId },
      },
      include: {
        user: { select: { email: true } },
      },
    });

    if (!target) {
      throw new TeamServiceError(
        'TEAM_MEMBER_NOT_FOUND',
        'The team member was not found.',
      );
    }

    if (!leaving && actorUserId === targetUserId) {
      throw new TeamServiceError(
        'USE_LEAVE_TEAM',
        'Use the leave-team action to remove your own membership.',
      );
    }

    if (
      !leaving &&
      actor.role === 'MANAGER' &&
      target.role !== 'MEMBER'
    ) {
      throw new TeamServiceError(
        'MEMBER_REMOVE_DENIED',
        'Managers can only remove ordinary team members.',
      );
    }

    if (target.role === 'OWNER') {
      const owners = await tx.teamMembership.count({
        where: { teamId, role: 'OWNER' },
      });

      if (owners <= 1) {
        throw new TeamServiceError(
          'LAST_TEAM_OWNER',
          'The last owner cannot leave or be removed.',
        );
      }
    }

    const removedShares = await tx.projectShare.deleteMany({
      where: {
        userId: targetUserId,
        project: { teamId },
      },
    });

    // Prevent an older pending invitation from restoring access.
    await tx.teamInvitation.updateMany({
      where: {
        teamId,
        status: 'PENDING',
        OR: [
          {
            email: {
              equals: normalizeEmail(target.user.email),
              mode: 'insensitive',
            },
          },
          { invitedByUserId: targetUserId },
        ],
      },
      data: {
        status: 'REVOKED',
        revokedAt: new Date(),
      },
    });

    await tx.teamMembership.delete({
      where: { id: target.id },
    });

    return {
      teamId,
      userId: targetUserId,
      removedProjectShares: removedShares.count,
    };
  });
}

export async function removeTeamMember(
  teamId: string,
  actorUserId: number,
  targetUserId: number,
) {
  return removeMembership(teamId, actorUserId, targetUserId, false);
}

export async function leaveTeam(teamId: string, userId: number) {
  return removeMembership(teamId, userId, userId, true);
}

export type TeamMemberRole = 'OWNER' | 'MANAGER' | 'MEMBER';

async function requireTeamOwner(
  tx: Prisma.TransactionClient,
  teamId: string,
  userId: number,
) {
  const membership = await tx.teamMembership.findUnique({
    where: {
      teamId_userId: { teamId, userId },
    },
  });

  if (!membership) {
    throw new TeamServiceError(
      'TEAM_ACCESS_DENIED',
      'The team was not found or you are not a member.',
    );
  }

  if (membership.role !== 'OWNER') {
    throw new TeamServiceError(
      'TEAM_OWNER_REQUIRED',
      'Only a team owner can change roles or transfer ownership.',
    );
  }

  return membership;
}

export async function changeTeamMemberRole(
  teamId: string,
  actorUserId: number,
  targetUserId: number,
  role: TeamMemberRole,
) {
  if (!['OWNER', 'MANAGER', 'MEMBER'].includes(role)) {
    throw new TeamServiceError(
      'INVALID_TEAM_ROLE',
      'Provide a valid team role.',
    );
  }

  return prisma.$transaction(async (tx) => {
    await lockTeamForMutation(tx, teamId);
    await requireTeamOwner(tx, teamId, actorUserId);

    const target = await tx.teamMembership.findUnique({
      where: {
        teamId_userId: { teamId, userId: targetUserId },
      },
    });

    if (!target) {
      throw new TeamServiceError(
        'TEAM_MEMBER_NOT_FOUND',
        'The team member was not found.',
      );
    }

    if (target.role === role) {
      return {
        teamId,
        userId: targetUserId,
        previousRole: target.role,
        role: target.role,
        changed: false,
        revokedInvitations: 0,
      };
    }

    if (target.role === 'OWNER' && role !== 'OWNER') {
      const ownerCount = await tx.teamMembership.count({
        where: { teamId, role: 'OWNER' },
      });

      if (ownerCount <= 1) {
        throw new TeamServiceError(
          'LAST_TEAM_OWNER',
          'The last owner cannot be demoted. Transfer ownership first.',
        );
      }
    }

    await tx.teamMembership.update({
      where: { id: target.id },
      data: { role },
    });

    let revokedInvitations = 0;

    if (role === 'MEMBER') {
      const revoked = await tx.teamInvitation.updateMany({
        where: {
          teamId,
          invitedByUserId: targetUserId,
          status: 'PENDING',
        },
        data: {
          status: 'REVOKED',
          revokedAt: new Date(),
        },
      });

      revokedInvitations = revoked.count;
    }

    return {
      teamId,
      userId: targetUserId,
      previousRole: target.role,
      role,
      changed: true,
      revokedInvitations,
    };
  });
}

export async function transferTeamOwnership(
  teamId: string,
  actorUserId: number,
  targetUserId: number,
) {
  return prisma.$transaction(async (tx) => {
    await lockTeamForMutation(tx, teamId);

    const actor = await requireTeamOwner(tx, teamId, actorUserId);

    if (actorUserId === targetUserId) {
      throw new TeamServiceError(
        'OWNERSHIP_TRANSFER_SELF',
        'Choose another team member to receive ownership.',
      );
    }

    const target = await tx.teamMembership.findUnique({
      where: {
        teamId_userId: { teamId, userId: targetUserId },
      },
    });

    if (!target) {
      throw new TeamServiceError(
        'TEAM_MEMBER_NOT_FOUND',
        'The new owner must already be a member of this team.',
      );
    }

    // Both updates commit together or both roll back.
    await tx.teamMembership.update({
      where: { id: target.id },
      data: { role: 'OWNER' },
    });

    await tx.teamMembership.update({
      where: { id: actor.id },
      data: { role: 'MANAGER' },
    });

    return {
      teamId,
      previousOwner: {
        userId: actorUserId,
        role: 'MANAGER' as const,
      },
      newOwner: {
        userId: targetUserId,
        role: 'OWNER' as const,
      },
    };
  });
}