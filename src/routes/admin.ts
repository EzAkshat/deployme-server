import { Router } from 'express';
import { requireAdmin } from '../middleware/require-admin.js';

const adminRouter = Router();

adminRouter.use(requireAdmin);

adminRouter.get('/me', (_req, res) => {
  const user = res.locals.authenticatedUser;

  res.status(200).json({
    user: {
      id: user.id,
      username: user.username,
      name: user.name,
      email: user.email,
      platformRole: user.platformRole,
    },
  });
});

export { adminRouter };
