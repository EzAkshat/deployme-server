import { Router, type Response } from 'express';
import { z } from 'zod';
import { Prisma } from '../generated/prisma/client.js';
import { logger } from '../config/logger.js';
import { requireAuth } from '../middleware/require-auth.js';
import { requireTrustedOrigin } from '../middleware/require-origin.js';
import { sendTeamInvitationEmail } from '../services/email.js';
import {
  acceptTeamInvitation,
  createTeam,
  createTeamInvitation,
  listTeamInvitations,
  listTeamMembers,
  listUserTeams,
  revokeTeamInvitation,
  TeamServiceError,
  removeTeamMember,
  leaveTeam,
    changeTeamMemberRole,
  transferTeamOwnership,
} from '../services/teams.js';

const createTeamSchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      'Slug must contain lowercase letters, numbers, and single hyphens.',
    ),
});

const createInvitationSchema = z.object({
  email: z.string().trim().email().max(254),
  role: z.enum(['MANAGER', 'MEMBER']).default('MEMBER'),
});

const acceptInvitationSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/i),
});

const changeTeamRoleSchema = z.object({
  role: z.enum(['OWNER', 'MANAGER', 'MEMBER']),
}).strict();

const transferTeamOwnershipSchema = z.object({
  userId: z.number().int().positive().safe(),
}).strict();

function getRouteParam(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function handleTeamError(res: Response, error: unknown, operation: string): void {
  if (error instanceof TeamServiceError) {
    const statusByCode: Record<string, number> = {
      TEAM_ACCESS_DENIED: 404,
      ALREADY_MEMBER: 409,
      INVITATION_EXISTS: 409,
      INVITATION_NOT_FOUND: 404,
      INVITATION_NOT_PENDING: 409,
      INVITATION_EXPIRED: 410,
      INVITATION_EMAIL_MISMATCH: 403,
      INVITATION_NOT_FOUND_OR_PENDING: 404,
      EMAIL_DELIVERY_FAILED: 502,
      MEMBER_REMOVE_DENIED: 403,
      TEAM_MEMBER_NOT_FOUND: 404,
      USE_LEAVE_TEAM: 400,
      LAST_TEAM_OWNER: 409,
            TEAM_OWNER_REQUIRED: 403,
      INVALID_TEAM_ROLE: 400,
      OWNERSHIP_TRANSFER_SELF: 400,
    };

    res.status(statusByCode[error.code] ?? 400).json({
      error: {
        message: error.message,
      },
    });
    return;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    res.status(409).json({
      error: {
        message: 'This operation conflicts with an existing record.',
      },
    });
    return;
  }

  logger.error({ err: error }, operation);

  res.status(500).json({
    error: {
      message: 'Unable to complete the request right now.',
    },
  });
}

export function createTeamsRouter(
  sendInvitationEmail: typeof sendTeamInvitationEmail = sendTeamInvitationEmail,
) {
  const teamsRouter = Router();

  // Create a team.
  teamsRouter.post('/', requireTrustedOrigin, requireAuth, async (req, res) => {
    const result = createTeamSchema.safeParse(req.body);

    if (!result.success) {
      res.status(400).json({
        error: {
          message: 'Please provide a valid team name and slug.',
          details: result.error.flatten().fieldErrors,
        },
      });
      return;
    }

    try {
      const team = await createTeam(res.locals.authenticatedUser.id, result.data);

      res.status(201).json({
        message: 'Team created successfully.',
        team,
      });
    } catch (error: unknown) {
      handleTeamError(res, error, 'Team creation failed');
    }
  });

  // List the signed-in user's teams.
  teamsRouter.get('/', requireAuth, async (_req, res) => {
    try {
      const teams = await listUserTeams(res.locals.authenticatedUser.id);

      res.status(200).json({ teams });
    } catch (error: unknown) {
      handleTeamError(res, error, 'Failed to list user teams');
    }
  });

  // Accept an invitation.
  teamsRouter.post('/invitations/accept', requireTrustedOrigin, requireAuth, async (req, res) => {
    const result = acceptInvitationSchema.safeParse(req.body);

    if (!result.success) {
      res.status(400).json({
        error: {
          message: 'Please provide a valid invitation token.',
        },
      });
      return;
    }

    try {
      const user = res.locals.authenticatedUser;

      const membership = await acceptTeamInvitation(user.id, user.email, result.data.token);

      res.status(200).json({
        message: 'You have joined the team successfully.',
        membership,
      });
    } catch (error: unknown) {
      handleTeamError(res, error, 'Failed to accept team invitation');
    }
  });

  // Create an invitation.
  teamsRouter.post('/:teamId/invitations', requireTrustedOrigin, requireAuth, async (req, res) => {
    const teamId = getRouteParam(req.params.teamId);

    if (!teamId) {
      res.status(400).json({
        error: { message: 'Invalid team ID.' },
      });
      return;
    }

    const result = createInvitationSchema.safeParse(req.body);

    if (!result.success) {
      res.status(400).json({
        error: {
          message: 'Please provide a valid email and invitation role.',
          details: result.error.flatten().fieldErrors,
        },
      });
      return;
    }

    try {
      const invitation = await createTeamInvitation(
        teamId,
        res.locals.authenticatedUser.id,
        result.data.email,
        result.data.role,
        sendInvitationEmail,
      );

      res.status(201).json({
        message: 'Invitation sent successfully.',
        invitation,
      });
    } catch (error: unknown) {
      handleTeamError(res, error, 'Failed to create team invitation');
    }
  });

  // List invitations for a team.
  teamsRouter.get('/:teamId/invitations', requireAuth, async (req, res) => {
    const teamId = getRouteParam(req.params.teamId);

    if (!teamId) {
      res.status(400).json({
        error: { message: 'Invalid team ID.' },
      });
      return;
    }

    try {
      const invitations = await listTeamInvitations(teamId, res.locals.authenticatedUser.id);

      res.status(200).json({ invitations });
    } catch (error: unknown) {
      handleTeamError(res, error, 'Failed to list team invitations');
    }
  });

  // Revoke a pending invitation.
  teamsRouter.delete(
    '/:teamId/invitations/:invitationId',
    requireTrustedOrigin,
    requireAuth,
    async (req, res) => {
      const teamId = getRouteParam(req.params.teamId);
      const invitationId = getRouteParam(req.params.invitationId);

      if (!teamId || !invitationId) {
        res.status(400).json({
          error: { message: 'Invalid team or invitation ID.' },
        });
        return;
      }

      try {
        const invitation = await revokeTeamInvitation(
          teamId,
          invitationId,
          res.locals.authenticatedUser.id,
        );

        res.status(200).json({
          message: 'Invitation revoked successfully.',
          invitation,
        });
      } catch (error: unknown) {
        handleTeamError(res, error, 'Failed to revoke team invitation');
      }
    },
  );

  // List members. Only existing team members can see this list.
  teamsRouter.get('/:teamId/members', requireAuth, async (req, res) => {
    const teamId = getRouteParam(req.params.teamId);

    if (!teamId) {
      res.status(400).json({
        error: { message: 'Invalid team ID.' },
      });
      return;
    }

    try {
      const members = await listTeamMembers(teamId, res.locals.authenticatedUser.id);

      res.status(200).json({ members });
    } catch (error: unknown) {
      handleTeamError(res, error, 'Failed to list team members');
    }
  });
  teamsRouter.delete(
  '/:teamId/members/:userId',
  requireTrustedOrigin,
  requireAuth,
  async (req, res) => {
    const teamId = getRouteParam(req.params.teamId);
    const rawUserId = getRouteParam(req.params.userId);
    const targetUserId = Number(rawUserId);

    if (
      !teamId ||
      !rawUserId ||
      !/^[1-9]\d*$/.test(rawUserId) ||
      !Number.isSafeInteger(targetUserId)
    ) {
      res.status(400).json({
        error: { message: 'Valid team and user IDs are required.' },
      });
      return;
    }

    try {
      const result = await removeTeamMember(
        teamId,
        res.locals.authenticatedUser.id,
        targetUserId,
      );

      res.status(200).json({
        message: 'Team member removed.',
        ...result,
      });
    } catch (error: unknown) {
      handleTeamError(res, error, 'Team member removal failed');
    }
  },
);

teamsRouter.post(
  '/:teamId/leave',
  requireTrustedOrigin,
  requireAuth,
  async (req, res) => {
    const teamId = getRouteParam(req.params.teamId);

    if (!teamId) {
      res.status(400).json({
        error: { message: 'A valid team ID is required.' },
      });
      return;
    }

    try {
      const result = await leaveTeam(
        teamId,
        res.locals.authenticatedUser.id,
      );

      res.status(200).json({
        message: 'You have left the team.',
        ...result,
      });
    } catch (error: unknown) {
      handleTeamError(res, error, 'Leaving team failed');
    }
  },
);
  teamsRouter.patch(
    '/:teamId/members/:userId/role',
    requireTrustedOrigin,
    requireAuth,
    async (req, res) => {
      const teamId = getRouteParam(req.params.teamId);
      const rawUserId = getRouteParam(req.params.userId);
      const targetUserId = Number(rawUserId);
      const input = changeTeamRoleSchema.safeParse(req.body);

      if (
        !teamId ||
        !rawUserId ||
        !/^[1-9]\d*$/.test(rawUserId) ||
        !Number.isSafeInteger(targetUserId) ||
        !input.success
      ) {
        res.status(400).json({
          error: {
            message: 'Provide valid team and user IDs and a valid role.',
          },
        });
        return;
      }

      try {
        const result = await changeTeamMemberRole(
          teamId,
          res.locals.authenticatedUser.id,
          targetUserId,
          input.data.role,
        );

        res.status(200).json({
          message: result.changed
            ? 'Team member role updated.'
            : 'Team member already has this role.',
          ...result,
        });
      } catch (error: unknown) {
        handleTeamError(res, error, 'Team member role change failed');
      }
    },
  );

  teamsRouter.post(
    '/:teamId/transfer-ownership',
    requireTrustedOrigin,
    requireAuth,
    async (req, res) => {
      const teamId = getRouteParam(req.params.teamId);
      const input = transferTeamOwnershipSchema.safeParse(req.body);

      if (!teamId || !input.success) {
        res.status(400).json({
          error: {
            message: 'Provide a valid team ID and target user ID.',
          },
        });
        return;
      }

      try {
        const result = await transferTeamOwnership(
          teamId,
          res.locals.authenticatedUser.id,
          input.data.userId,
        );

        res.status(200).json({
          message: 'Team ownership transferred successfully.',
          ...result,
        });
      } catch (error: unknown) {
        handleTeamError(res, error, 'Team ownership transfer failed');
      }
    },
  );
  return teamsRouter;
}

// Production router uses the real email sender.
const teamsRouter = createTeamsRouter();

export { teamsRouter };
