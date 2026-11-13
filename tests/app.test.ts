import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import request from 'supertest';
import express from 'express';
import app from '../src/app.js';
import { prisma } from '../src/config/database.js';
import { createAuthRouter } from '../src/routes/auth.js';
import { createSession } from '../src/services/session.js';
import { adminRouter } from '../src/routes/admin.js';

const SESSION_COOKIE_NAME = 'deployme_session';
const TRUSTED_ORIGIN = 'http://localhost:3000';

/**
 * Supertest/Node typings may represent Set-Cookie as a string
 * or an array of strings. Normalize it before searching.
 */
function getSetCookieHeaders(value: string | string[] | undefined): string[] {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

after(async () => {
  await prisma.$disconnect();
});

test('CORS allows the configured frontend origin', async () => {
  const response = await request(app).get('/health').set('Origin', TRUSTED_ORIGIN);

  assert.equal(response.status, 200);
  assert.equal(response.headers['access-control-allow-origin'], TRUSTED_ORIGIN);
  assert.equal(response.headers['access-control-allow-credentials'], 'true');
});

test('CORS does not grant access to an untrusted origin', async () => {
  const untrustedOrigin = 'https://untrusted.example.com';

  const response = await request(app).get('/health').set('Origin', untrustedOrigin);

  assert.equal(response.status, 200);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal(response.headers['access-control-allow-credentials'], undefined);
});

test('CORS handles browser preflight requests', async () => {
  const response = await request(app)
    .options('/auth/request-otp')
    .set('Origin', TRUSTED_ORIGIN)
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'content-type');

  assert.equal(response.status, 204);
  assert.equal(response.headers['access-control-allow-origin'], TRUSTED_ORIGIN);
  assert.equal(response.headers['access-control-allow-credentials'], 'true');

  assert.ok(
    response.headers['access-control-allow-methods']
      .split(',')
      .map((method: string) => method.trim())
      .includes('POST'),
  );

  assert.ok(
    response.headers['access-control-allow-headers'].toLowerCase().includes('content-type'),
  );
});

test('GET / returns Hello World', async () => {
  const response = await request(app).get('/');

  assert.equal(response.status, 200);
  assert.equal(response.text, 'Hello World!');
});

test('GET /health returns a healthy status', async () => {
  const response = await request(app).get('/health');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ok' });
});

test('GET /ready reports database readiness', async () => {
  const response = await request(app).get('/ready');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    status: 'ready',
    database: 'connected',
  });
});

test('unknown routes return a consistent 404 response', async () => {
  const response = await request(app).get('/does-not-exist');

  assert.equal(response.status, 404);
  assert.deepEqual(response.body, {
    error: {
      message: 'Route not found',
    },
  });
});

test('POST /auth/request-otp rejects an invalid email', async () => {
  const response = await request(app)
    .post('/auth/request-otp')
    .set('Origin', TRUSTED_ORIGIN)
    .send({ email: 'not-an-email' });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, {
    error: {
      message: 'Please provide a valid email address.',
    },
  });
});

test('POST /auth/request-otp sends an OTP email and never returns the code', async () => {
  let capturedEmail = '';
  let capturedCode = '';

  const testApp = express();
  testApp.use(express.json());
  testApp.use(
    '/auth',
    createAuthRouter(async (email, code) => {
      capturedEmail = email;
      capturedCode = code;
    }),
  );

  try {
    const response = await request(testApp)
      .post('/auth/request-otp')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ email: `test.${randomUUID()}@example.com` });

    assert.equal(response.status, 200);
    assert.match(capturedEmail, /^test\.[0-9a-f-]+@example\.com$/);
    assert.match(capturedCode, /^\d{6}$/);
    assert.equal(JSON.stringify(response.body).includes(capturedCode), false);
    assert.match(response.body.message, /email will be sent shortly/i);
  } finally {
    if (capturedEmail) {
      await prisma.otpChallenge.updateMany({
        where: { email: capturedEmail, consumedAt: null },
        data: { consumedAt: new Date() },
      });

      await prisma.otpChallenge.deleteMany({
        where: { email: capturedEmail },
      });
    }
  }
});

test('POST /auth/request-otp invalidates the challenge when email delivery fails', async () => {
  const email = `delivery-failure.${randomUUID()}@example.com`;
  let capturedEmail = '';

  const testApp = express();
  testApp.use(express.json());
  testApp.use(
    '/auth',
    createAuthRouter(async (recipient) => {
      capturedEmail = recipient;
      throw new Error('Simulated email provider failure');
    }),
  );

  try {
    const response = await request(testApp)
      .post('/auth/request-otp')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ email });

    assert.equal(response.status, 500);
    assert.deepEqual(response.body, {
      error: {
        message: 'Unable to process your request right now. Please try again later.',
      },
    });

    assert.equal(capturedEmail, email.toLowerCase());

    const challenge = await prisma.otpChallenge.findFirst({
      where: { email: capturedEmail },
      orderBy: { createdAt: 'desc' },
    });

    assert.ok(challenge);
    assert.ok(challenge.consumedAt);
  } finally {
    await prisma.otpChallenge.deleteMany({
      where: { email },
    });
  }
});

test('GET /auth/me rejects requests without a session', async () => {
  const response = await request(app).get('/auth/me');

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, {
    error: {
      message: 'Authentication required.',
    },
  });
});

test('OTP verification creates a session, /auth/me authenticates the user, and logout revokes the session', async () => {
  const email = `verify.${randomUUID()}@example.com`;
  let capturedCode = '';
  let challengeId = '';
  let userId: number | undefined;

  const testApp = express();
  testApp.use(express.json());
  testApp.use(
    '/auth',
    createAuthRouter(async (_recipient, code) => {
      capturedCode = code;
    }),
  );

  try {
    // Request an OTP without sending a real email.
    const requestResponse = await request(testApp)
      .post('/auth/request-otp')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ email });

    assert.equal(requestResponse.status, 200);
    assert.equal(typeof requestResponse.body.challengeId, 'string');
    challengeId = requestResponse.body.challengeId;
    assert.match(capturedCode, /^\d{6}$/);

    // Verify the OTP and establish a session.
    const verifyResponse = await request(testApp)
      .post('/auth/verify-otp')
      .set('Origin', TRUSTED_ORIGIN)
      .send({
        challengeId,
        email,
        code: capturedCode,
      });

    assert.equal(verifyResponse.status, 200);
    assert.equal(verifyResponse.body.message, 'Email verification successful.');
    assert.equal(verifyResponse.body.user.email, email);
    assert.equal(verifyResponse.body.user.name, 'New User');
    assert.equal(verifyResponse.body.user.onboardingCompletedAt, null);
    assert.match(verifyResponse.body.user.username, /^[a-z]+_[0-9]{4}$/);
    assert.equal('code' in verifyResponse.body, false);

    // The session token must be in the cookie, not the JSON response.
    const setCookieHeaders = getSetCookieHeaders(verifyResponse.headers['set-cookie']);

    const sessionSetCookie = setCookieHeaders.find((cookie) =>
      cookie.startsWith(`${SESSION_COOKIE_NAME}=`),
    );

    assert.ok(sessionSetCookie, 'Expected the session cookie');
    assert.match(sessionSetCookie, /HttpOnly/i);
    assert.match(sessionSetCookie, /SameSite=Lax/i);
    assert.equal('secure' in verifyResponse.body, false);

    const cookiePair = sessionSetCookie.split(';')[0];
    assert.ok(cookiePair);
    assert.ok(cookiePair.startsWith(`${SESSION_COOKIE_NAME}=`));

    userId = verifyResponse.body.user.id;

    const sessionToken = cookiePair.slice(SESSION_COOKIE_NAME.length + 1);

    assert.ok(sessionToken.length > 0);
    assert.equal(
      JSON.stringify(verifyResponse.body).includes(sessionToken),
      false,
      'The raw session token must not be returned in JSON',
    );

    // A valid session should authenticate the user.
    const meResponse = await request(testApp).get('/auth/me').set('Cookie', cookiePair);

    assert.equal(meResponse.status, 200);
    assert.equal(meResponse.body.user.id, userId);
    assert.equal(meResponse.body.user.email, email);
    assert.equal(meResponse.body.user.username, verifyResponse.body.user.username);

    // Reusing the same OTP must fail.
    const repeatedResponse = await request(testApp)
      .post('/auth/verify-otp')
      .set('Origin', TRUSTED_ORIGIN)
      .send({
        challengeId,
        email,
        code: capturedCode,
      });

    assert.equal(repeatedResponse.status, 400);

    // Logout should revoke the session and clear the cookie.
    const logoutResponse = await request(testApp)
      .post('/auth/logout')
      .set('Origin', TRUSTED_ORIGIN)
      .set('Cookie', cookiePair);

    assert.equal(logoutResponse.status, 200);

    const clearedCookies = getSetCookieHeaders(logoutResponse.headers['set-cookie']);

    const clearedSessionCookie = clearedCookies.find((cookie) =>
      cookie.startsWith(`${SESSION_COOKIE_NAME}=`),
    );

    assert.ok(clearedSessionCookie, 'Expected the session cookie to be cleared');
    assert.match(clearedSessionCookie, /HttpOnly/i);

    // The old cookie must no longer authenticate the user.
    const afterLogoutResponse = await request(testApp).get('/auth/me').set('Cookie', cookiePair);

    assert.equal(afterLogoutResponse.status, 401);
    assert.deepEqual(afterLogoutResponse.body, {
      error: {
        message: 'Authentication required.',
      },
    });
  } finally {
    // Delete dependent sessions before deleting the user.
    if (userId !== undefined) {
      await prisma.session.deleteMany({
        where: { userId },
      });

      await prisma.user.deleteMany({
        where: { id: userId },
      });
    }

    if (challengeId) {
      await prisma.otpChallenge.deleteMany({
        where: { id: challengeId },
      });
    }
  }
});

test('POST /auth/verify-otp rejects an incorrect code', async () => {
  const email = `wrong-code.${randomUUID()}@example.com`;
  let challengeId = '';

  const testApp = express();
  testApp.use(express.json());
  testApp.use(
    '/auth',
    createAuthRouter(async () => {
      // The test intentionally does not send a real email.
    }),
  );

  try {
    const requestResponse = await request(testApp)
      .post('/auth/request-otp')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ email });

    assert.equal(requestResponse.status, 200);
    challengeId = requestResponse.body.challengeId;

    const verifyResponse = await request(testApp)
      .post('/auth/verify-otp')
      .set('Origin', TRUSTED_ORIGIN)
      .send({
        challengeId,
        email,
        code: '000000',
      });

    assert.equal(verifyResponse.status, 400);
    assert.equal(
      verifyResponse.body.error.message,
      'The code is invalid or expired. Please request a new code.',
    );

    const user = await prisma.user.findUnique({ where: { email } });
    assert.equal(user, null);
  } finally {
    if (challengeId) {
      await prisma.otpChallenge.deleteMany({
        where: { id: challengeId },
      });
    }
  }
});

test("PATCH /auth/onboarding saves the user's name and completes onboarding", async () => {
  const email = `onboarding.${randomUUID()}@example.com`;
  let capturedCode = '';
  let challengeId = '';
  let userId: number | undefined;
  let cookiePair = '';

  const testApp = express();
  testApp.use(express.json());
  testApp.use(
    '/auth',
    createAuthRouter(async (_recipient, code) => {
      capturedCode = code;
    }),
  );

  try {
    const requestResponse = await request(testApp)
      .post('/auth/request-otp')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ email });
    assert.equal(requestResponse.status, 200);
    challengeId = requestResponse.body.challengeId;

    const verifyResponse = await request(testApp)
      .post('/auth/verify-otp')
      .set('Origin', TRUSTED_ORIGIN)
      .send({
        challengeId,
        email,
        code: capturedCode,
      });
    assert.equal(verifyResponse.status, 200);
    userId = verifyResponse.body.user.id;

    const cookies = getSetCookieHeaders(verifyResponse.headers['set-cookie']);
    const sessionCookie = cookies.find((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`));

    assert.ok(sessionCookie);
    cookiePair = sessionCookie.split(';')[0] ?? '';
    assert.ok(cookiePair);

    const response = await request(testApp)
      .patch('/auth/onboarding')
      .set('Origin', TRUSTED_ORIGIN)
      .set('Cookie', cookiePair)
      .send({ name: '  Akshat Naik  ' });

    assert.equal(response.status, 200);
    assert.equal(response.body.message, 'Onboarding completed successfully.');
    assert.equal(response.body.user.name, 'Akshat Naik');
    assert.ok(response.body.user.onboardingCompletedAt);
    assert.equal('token' in response.body, false);

    const savedUser = await prisma.user.findUnique({
      where: { id: userId },
    });

    assert.ok(savedUser);
    assert.equal(savedUser.name, 'Akshat Naik');
    assert.ok(savedUser.onboardingCompletedAt);
  } finally {
    if (userId !== undefined) {
      await prisma.session.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }

    if (challengeId) {
      await prisma.otpChallenge.deleteMany({
        where: { id: challengeId },
      });
    }
  }
});

test('GET /admin/me rejects requests without a session', async () => {
  const response = await request(app).get('/admin/me');

  assert.equal(response.status, 401);
  assert.deepEqual(response.body, {
    error: {
      message: 'Authentication required.',
    },
  });
});

test('GET /admin/me rejects an authenticated regular user', async () => {
  const uniqueId = randomUUID();

  const user = await prisma.user.create({
    data: {
      username: `admin_test_${uniqueId.replaceAll('-', '').slice(0, 12)}`,
      name: 'Regular Test User',
      email: `admin-test.${uniqueId}@example.com`,
      platformRole: 'USER',
    },
  });

  try {
    const { token } = await createSession(user.id);

    const response = await request(app)
      .get('/admin/me')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${token}`);

    assert.equal(response.status, 403);
    assert.deepEqual(response.body, {
      error: { message: 'Administrator access required.' },
    });
  } finally {
    await prisma.session.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test('POST /auth/admin/verify-otp does not create an account for an unknown email', async () => {
  const email = `unknown-admin.${randomUUID()}@example.com`;
  let challengeId = '';
  let capturedCode = '';

  const testApp = express();
  testApp.use(express.json());
  testApp.use(
    '/auth',
    createAuthRouter(async (_recipient, code) => {
      capturedCode = code;
    }),
  );

  try {
    const requestResponse = await request(testApp)
      .post('/auth/request-otp')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ email });

    assert.equal(requestResponse.status, 200);
    challengeId = requestResponse.body.challengeId;

    const response = await request(testApp)
      .post('/auth/admin/verify-otp')
      .set('Origin', TRUSTED_ORIGIN)
      .send({
        challengeId,
        email,
        code: capturedCode,
      });

    assert.equal(response.status, 403);
    assert.deepEqual(response.body, {
      error: {
        message: 'This account is not authorized for administrator access.',
      },
    });

    const user = await prisma.user.findUnique({
      where: { email },
    });

    assert.equal(user, null);
  } finally {
    if (challengeId) {
      await prisma.otpChallenge.deleteMany({
        where: { id: challengeId },
      });
    }
  }
});

test('POST /auth/admin/verify-otp rejects an invalid OTP', async () => {
  const uniqueId = randomUUID();
  const email = `invalid-admin-otp.${uniqueId}@example.com`;
  let challengeId = '';
  let userId = '';
  let capturedCode = '';

  const testApp = express();
  testApp.use(express.json());
  testApp.use(
    '/auth',
    createAuthRouter(async (_recipient, code) => {
      capturedCode = code;
    }),
  );

  try {
    const user = await prisma.user.create({
      data: {
        username: `invalid_admin_${uniqueId.replaceAll('-', '').slice(0, 12)}`,
        name: 'Invalid OTP Test Admin',
        email,
        platformRole: 'SITE_ADMIN',
      },
    });
    userId = user.id;

    const requestResponse = await request(testApp)
      .post('/auth/request-otp')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ email });

    assert.equal(requestResponse.status, 200);
    challengeId = requestResponse.body.challengeId;

    const invalidCode = capturedCode === '000000' ? '000001' : '000000';

    const verifyResponse = await request(testApp)
      .post('/auth/admin/verify-otp')
      .set('Origin', TRUSTED_ORIGIN)
      .send({
        challengeId,
        email,
        code: invalidCode,
      });

    assert.equal(verifyResponse.status, 400);
    assert.deepEqual(verifyResponse.body, {
      error: {
        message: 'The code is invalid or expired. Please request a new code.',
      },
    });
  } finally {
    if (challengeId) {
      await prisma.otpChallenge.deleteMany({
        where: { id: challengeId },
      });
    }

    if (userId) {
      await prisma.session.deleteMany({ where: { userId } });
      await prisma.user.delete({ where: { id: userId } });
    }
  }
});

test('POST /auth/admin/verify-otp authenticates an existing site admin', async () => {
  const uniqueId = randomUUID();
  const email = `site-admin.${uniqueId}@example.com`;
  let challengeId = '';
  let capturedCode = '';
  let userId = '';

  const testApp = express();
  testApp.use(express.json());
  testApp.use(
    '/auth',
    createAuthRouter(async (_recipient, code) => {
      capturedCode = code;
    }),
  );
  testApp.use('/admin', adminRouter);

  try {
    const user = await prisma.user.create({
      data: {
        username: `site_admin_${uniqueId.replaceAll('-', '').slice(0, 12)}`,
        name: 'Site Admin Test',
        email,
        platformRole: 'SITE_ADMIN',
      },
    });
    userId = user.id;

    const requestResponse = await request(testApp)
      .post('/auth/request-otp')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ email });

    assert.equal(requestResponse.status, 200);
    challengeId = requestResponse.body.challengeId;

    const verifyResponse = await request(testApp)
      .post('/auth/admin/verify-otp')
      .set('Origin', TRUSTED_ORIGIN)
      .send({
        challengeId,
        email,
        code: capturedCode,
      });

    assert.equal(verifyResponse.status, 200);
    assert.equal(verifyResponse.body.user.id, user.id);
    assert.equal(verifyResponse.body.user.platformRole, 'SITE_ADMIN');

    const cookie = verifyResponse.headers['set-cookie'];
    assert.ok(cookie);

    const adminResponse = await request(testApp).get('/admin/me').set('Cookie', cookie);

    assert.equal(adminResponse.status, 200);
    assert.equal(adminResponse.body.user.id, user.id);
    assert.equal(adminResponse.body.user.platformRole, 'SITE_ADMIN');
  } finally {
    if (challengeId) {
      await prisma.otpChallenge.deleteMany({
        where: { id: challengeId },
      });
    }

    if (userId) {
      await prisma.session.deleteMany({ where: { userId } });
      await prisma.user.delete({ where: { id: userId } });
    }
  }
});
