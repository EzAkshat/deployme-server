import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import express from 'express';
import request from 'supertest';

import { prisma } from '../../../src/config/database.js';
import { env } from '../../../src/config/env.js';
import { githubWebhooksRouter } from '../../../src/routes/github-webhooks.js';

describe('GitHub webhook verification and delivery handling', () => {
  const deliveryIds = new Set<string>();

  const app = express();

  // Match production: signature verification requires the original bytes.
  app.use(
    '/webhooks/github',
    express.raw({ type: 'application/json' }),
    githubWebhooksRouter,
  );

  after(async () => {
    try {
      await prisma.gitHubWebhookDelivery.deleteMany({
        where: { deliveryId: { in: [...deliveryIds] } },
      });
    } finally {
      await prisma.$disconnect();
    }
  });

  function newDeliveryId() {
    const id = randomUUID();
    deliveryIds.add(id);
    return id;
  }

  function signature(body: string) {
    const secret = env.GITHUB_WEBHOOK_SECRET;

    assert.ok(
      secret,
      'GITHUB_WEBHOOK_SECRET must be configured for these tests.',
    );

    return (
      'sha256=' +
      createHmac('sha256', secret).update(body, 'utf8').digest('hex')
    );
  }

  function send(
    deliveryId: string,
    event: string,
    body: string,
    signedBody = body,
  ) {
    return request(app)
      .post('/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('x-github-delivery', deliveryId)
      .set('x-github-event', event)
      .set('x-hub-signature-256', signature(signedBody))
      .send(body);
  }

  function read(deliveryId: string) {
    return prisma.gitHubWebhookDelivery.findUnique({
      where: { deliveryId },
    });
  }

  it('rejects missing and malformed signatures without recording deliveries', async () => {
    for (const suppliedSignature of [undefined, 'sha256=invalid']) {
      const id = newDeliveryId();

      const pending = request(app)
        .post('/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('x-github-delivery', id)
        .set('x-github-event', 'ping');

      if (suppliedSignature !== undefined) {
        pending.set('x-hub-signature-256', suppliedSignature);
      }

      const response = await pending.send('{"zen":"test"}');

      assert.equal(response.status, 401);
      assert.equal(await read(id), null);
    }
  });

  it('rejects a body changed after signing', async () => {
    const id = newDeliveryId();

    const response = await send(
      id,
      'ping',
      '{"zen":"modified"}',
      '{"zen":"original"}',
    );

    assert.equal(response.status, 401);
    assert.equal(await read(id), null);
  });

  it('rejects correctly signed malformed JSON', async () => {
    const id = newDeliveryId();
    const response = await send(id, 'ping', '{"broken":');

    assert.equal(response.status, 400);
    assert.equal(
      response.body.error?.message,
      'GitHub webhook body must contain valid JSON.',
    );
    assert.equal(await read(id), null);
  });

  it('requires delivery and event headers after signature verification', async () => {
    const body = '{"zen":"test"}';

    for (const missing of ['delivery', 'event']) {
      const id = newDeliveryId();

      const pending = request(app)
        .post('/webhooks/github')
        .set('Content-Type', 'application/json')
        .set('x-hub-signature-256', signature(body));

      if (missing !== 'delivery') {
        pending.set('x-github-delivery', id);
      }

      if (missing !== 'event') {
        pending.set('x-github-event', 'ping');
      }

      const response = await pending.send(body);

      assert.equal(response.status, 400);
      assert.equal(
        response.body.error?.message,
        'GitHub delivery and event headers are required.',
      );
      assert.equal(await read(id), null);
    }
  });

  it('records a non-push event as ignored and recognizes a later duplicate', async () => {
    const id = newDeliveryId();
    const body = '{"zen":"test"}';

    const first = await send(id, 'ping', body);

    assert.equal(first.status, 202);
    assert.equal(first.body.status, 'IGNORED');
    assert.equal(first.body.deploymentId, undefined);

    const recorded = await read(id);

    assert.ok(recorded);
    assert.equal(recorded.event, 'ping');
    assert.equal(recorded.status, 'IGNORED');
    assert.ok(recorded.processedAt);
    assert.equal(recorded.error, null);

    const second = await send(id, 'ping', body);

    assert.equal(second.status, 200);
    assert.equal(second.body.status, 'IGNORED');
    assert.deepEqual(await read(id), recorded);

    assert.equal(
      await prisma.gitHubWebhookDelivery.count({
        where: { deliveryId: id },
      }),
      1,
    );
  });

  it('handles concurrent copies of an ignored delivery exactly once', async () => {
    const id = newDeliveryId();
    const body = '{"zen":"concurrent test"}';

    const responses = await Promise.all([
      send(id, 'ping', body),
      send(id, 'ping', body),
      send(id, 'ping', body),
    ]);

    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [200, 200, 202],
    );

    for (const response of responses) {
      assert.equal(response.body.status, 'IGNORED');
      assert.equal(response.body.deploymentId, undefined);
    }

    assert.equal(
      await prisma.gitHubWebhookDelivery.count({
        where: { deliveryId: id },
      }),
      1,
    );

    assert.equal((await read(id))?.status, 'IGNORED');
  });

  it('records an invalid push as failed and retries rather than accepting it as a duplicate', async () => {
    const id = newDeliveryId();
    const body = '{"repository":{"id":123}}';

    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await send(id, 'push', body);

      assert.equal(response.status, 422);
      assert.equal(
        response.body.error?.message,
        'GitHub push payload must include a valid repository ID, ref, and commit SHA.',
      );

      const recorded = await read(id);

      assert.ok(recorded);
      assert.equal(recorded.status, 'FAILED');
      assert.equal(recorded.processedAt, null);
      assert.ok(recorded.error);
    }

    assert.equal(
      await prisma.gitHubWebhookDelivery.count({
        where: { deliveryId: id },
      }),
      1,
    );
  });
});