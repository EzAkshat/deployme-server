# Tests

```
test/
├── support/        shared helpers (not collected as tests)
├── unit/           no database, no HTTP — fast
└── integration/    real Postgres + the real Express routers, mocked email
```

Folders under `unit/` and `integration/` mirror what they cover
(`services`, `config`, `auth`, `teams`, `admin`, `http`, `database`).
A file ending in `.test.ts` is collected; everything in `support/` is not.

## Running

```bash
npm test                  # everything
npm run test:unit         # unit only
npm run test:integration  # integration only
npm run typecheck:tests   # type-check tests + src
```

Run one file:

```bash
node --env-file-if-exists=.env --import tsx --test tests/integration/auth/verify-otp.test.ts
```

Send one real invitation email through Resend (optional):

```bash
REAL_TEST_EMAIL=you@gmail.com node --env-file-if-exists=.env --import tsx \
  --test test/integration/teams/membership.test.ts
```

## Writing a new integration test

```ts
import { describe, it } from 'node:test';
import { createTestApp } from '../../support/apps.js';
import { signIn } from '../../support/auth-flow.js';
import { useTestData } from '../../support/test-data.js';

describe('my feature', () => {
  const data = useTestData(); // cleans up + disconnects Prisma after the suite
  const testApp = createTestApp(); // real routers, captured (not sent) emails

  it('does something as a signed-in user', async () => {
    const { cookie } = await signIn(testApp, data.newEmail('my-feature'));
    // request(testApp.app).get('/...').set('Cookie', cookie)
  });
});
```

Rules of thumb:

- Never hard-code emails or usernames. Use `data.newEmail(...)` / `data.createUser(...)`; they are unique and cleaned up for you.
- Never write `try/finally` cleanup. `useTestData()` does it.
- Use `expectStatus` / `expectError` instead of repeating `assert.equal(status, ..., JSON.stringify(body))`.
- Error copy lives in `support/constants.ts` (`ERROR_MESSAGES`).

| Helper                  | What it gives you                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `support/test-data.ts`  | `useTestData()`: unique tracked emails, `createUser`, team tracking, automatic cleanup |
| `support/apps.ts`       | `createTestApp()`: real routers + captured OTP codes and invitation tokens             |
| `support/auth-flow.ts`  | `signIn`, `requestOtpChallenge`, `postVerifyOtp`, `createSessionCookie`                |
| `support/teams.ts`      | `createTeamWithOwner`, `addMemberToTeam`, `postInvitation`                             |
| `support/cookies.ts`    | Set-Cookie parsing and session cookie helpers                                          |
| `support/http.ts`       | `expectStatus`, `expectError`                                                          |
| `support/real-email.ts` | Optional real Resend delivery (`REAL_TEST_EMAIL`)                                      |
