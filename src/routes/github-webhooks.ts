import { Router } from 'express';
import { logger } from '../config/logger.js';
import {
  GitHubWebhookError,
  processGitHubWebhookDelivery,
  verifyGitHubWebhookSignature,
} from '../services/github-webhooks.js';
import { DeploymentQuotaError } from '../services/deployment-quota.js';

export const githubWebhooksRouter = Router();

githubWebhooksRouter.post('/', async (req, res) => {
  if (!Buffer.isBuffer(req.body)) {
    res.status(400).json({
      error: { message: 'Expected a raw GitHub webhook request body.' },
    });
    return;
  }

  const signature = req.get('x-hub-signature-256');

  if (!verifyGitHubWebhookSignature(req.body, signature)) {
    res.status(401).json({
      error: { message: 'Invalid GitHub webhook signature.' },
    });
    return;
  }

  const deliveryId = req.get('x-github-delivery');
  const event = req.get('x-github-event');

  if (!deliveryId || !event) {
    res.status(400).json({
      error: { message: 'GitHub delivery and event headers are required.' },
    });
    return;
  }

  let payload: unknown;

  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    res.status(400).json({
      error: { message: 'GitHub webhook body must contain valid JSON.' },
    });
    return;
  }

  try {
    const result = await processGitHubWebhookDelivery({
      deliveryId,
      event,
      payload,
    });

    res.status(result.duplicate ? 200 : 202).json({
      message: result.duplicate
        ? 'GitHub webhook delivery was already handled or is being processed.'
        : result.status === 'IGNORED'
          ? 'GitHub webhook received; no deployment was required.'
          : 'GitHub webhook processed successfully.',
      status: result.status,
      ...('deploymentId' in result ? { deploymentId: result.deploymentId } : {}),
    });
  } catch (error: unknown) {
        if (error instanceof DeploymentQuotaError) {
      res.setHeader('Retry-After', '30');
      res.status(429).json({
        error: {
          code: error.code,
          message: error.message,
          limit: error.limit,
          activeCount: error.activeCount,
        },
      });
      return;
    }
    if (error instanceof GitHubWebhookError) {
      res.status(error.code === 'INVALID_DELIVERY' ? 400 : 422).json({
        error: { message: error.message },
      });
      return;
    }

    logger.error({ err: error, deliveryId, event }, 'GitHub webhook processing failed');

    res.status(500).json({
      error: { message: 'Unable to process the GitHub webhook.' },
    });
  }
});
